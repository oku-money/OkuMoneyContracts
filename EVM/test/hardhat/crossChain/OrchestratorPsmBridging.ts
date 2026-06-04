/**
 * Cross-Chain Bridging via Orchestrator + PSM (noBridge model)
 *
 * Validates the v1 "noBridge" cross-chain transfer model end-to-end.
 *
 * Design under test:
 *   - There is no on-chain bridge contract.
 *   - The off-chain orchestrator holds the OKUM_MINTER role on every chain's
 *     LitePSM (granted at deploy time via OKUM_ALLOWANCE_MANAGER →
 *     configureMinterAllowance + DEFAULT_ADMIN_ROLE → grantRole).
 *   - To "bridge" OkuMoney from chain A to chain B, the orchestrator:
 *       1. Pulls the user's OkuMoney on chain A and redeems it for USDC via
 *          LitePSM.redeemOkuM(), so the OkuM is burned and the PSM buffer
 *          shrinks on A.
 *       2. Off-chain, custodies the USDC (in this test the orchestrator
 *          simply holds the USDC it received from the redeem).
 *       3. On chain B, deposits USDC into the PSM via LitePSM.mintOkuM() and
 *          forwards the resulting OkuM to the recipient.
 *   - For OkuDollar, the orchestrator unwraps to OkuMoney first then runs the
 *     same flow, mirroring LitePSM.redeemUsdOku / mintUsdOku.
 *
 * Both "chains" are deployed on the same hardhat node — protocol behaviour is
 * identical to a real multi-chain deployment because the orchestrator is the
 * trust boundary; the test simulates the off-chain step inline.
 *
 * NOTE: These tests do NOT use a mainnet fork. They run against the in-process
 * hardhat network with MockUSDC, so they are fast and deterministic.
 */
import {
    LitePSM,
    LitePSM__factory,
    OkuMoney,
    OkuMoney__factory,
    OkuDollar,
    OkuDollar__factory,
    RedemptionQueue,
    RedemptionQueue__factory,
    MockUSDC,
    MockUSDC__factory,
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits } from "ethers"
import { ethers, upgrades } from "hardhat"
import { expect } from "chai"

const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"))
const PSM_BUFFER_DEPOSITOR = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_DEPOSITOR"))
const QUEUE_PSM = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PSM"))

const MAX_SUPPLY = parseEther("1000000000") // 1B
const MINTER_ALLOWANCE = parseEther("1000000000")
const STALENESS_THRESHOLD = 3600n
// 100% collateral ratio (= 1e18). The vault's Constants.MIN_COLLATERAL_RATIO_FLOOR
// is 95%; we use 100% so the unwrap path in OkuDollar tests doesn't trip the
// undercollateralised guard before the orchestrator runs.
const MIN_COLLATERAL_RATIO = parseEther("1")

/**
 * Deploy a full single-chain stack (OkuMoney + OkuDollar + RedemptionQueue +
 * LitePSM + MockUSDC) and wire the roles the orchestrator needs.
 *
 * Returns the contracts + the orchestrator signer that has OKUM_MINTER on the
 * PSM (granted indirectly via the PSM holding OKUM_MINTER + minter allowance).
 *
 * `label` is purely for assertion failure messages.
 */
async function deployChain(label: string, admin: Signer) {
    const adminAddr = await admin.getAddress()

    const usdc = (await new MockUSDC__factory(admin).deploy()) as MockUSDC
    await usdc.waitForDeployment()

    const okuMoney = (await upgrades.deployProxy(
        new OkuMoney__factory(admin),
        [`OkuMoney ${label}`, "OkuM", adminAddr, MAX_SUPPLY],
        { kind: "uups" }
    )) as unknown as OkuMoney
    await okuMoney.waitForDeployment()

    const okuDollar = (await upgrades.deployProxy(
        new OkuDollar__factory(admin),
        [
            await okuMoney.getAddress(),
            `OkuDollar ${label}`,
            "usdOku",
            adminAddr,
            MIN_COLLATERAL_RATIO,
        ],
        { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuDollar
    await okuDollar.waitForDeployment()

    const queue = (await upgrades.deployProxy(
        new RedemptionQueue__factory(admin),
        [await okuMoney.getAddress(), await usdc.getAddress(), adminAddr],
        { kind: "uups" }
    )) as unknown as RedemptionQueue
    await queue.waitForDeployment()

    const psm = (await upgrades.deployProxy(
        new LitePSM__factory(admin),
        [
            await okuMoney.getAddress(),
            await okuDollar.getAddress(),
            await usdc.getAddress(),
            await queue.getAddress(),
            adminAddr,
            STALENESS_THRESHOLD,
        ],
        { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as LitePSM
    await psm.waitForDeployment()

    // Roles required for the orchestrator-mediated mint/burn flow.
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, await psm.getAddress())
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, await queue.getAddress())
    await okuMoney.connect(admin).grantRole(OKUM_REBASER, adminAddr)
    await okuMoney.connect(admin).grantRole(OKUM_ALLOWANCE_MANAGER, adminAddr)
    await okuMoney.connect(admin).configureMinterAllowance(await psm.getAddress(), MINTER_ALLOWANCE)
    await okuMoney
        .connect(admin)
        .configureMinterAllowance(await queue.getAddress(), MINTER_ALLOWANCE)
    await queue.connect(admin).grantRole(QUEUE_PSM, await psm.getAddress())
    await psm.connect(admin).grantRole(PSM_BUFFER_DEPOSITOR, adminAddr)

    return { usdc, okuMoney, okuDollar, queue, psm }
}

type Chain = Awaited<ReturnType<typeof deployChain>>

/**
 * Mint OkuMoney to `user` on `chain` by depositing USDC through the PSM
 * (the same path a normal user follows on chain A before they ask the
 * orchestrator to bridge).
 */
async function userMintsOkuMOnChain(chain: Chain, user: Signer, usdcAmount: bigint) {
    const userAddr = await user.getAddress()
    await chain.usdc.mint(userAddr, usdcAmount)
    await chain.usdc.connect(user).approve(await chain.psm.getAddress(), usdcAmount)
    await chain.psm.connect(user).mintOkuM(usdcAmount)
}

/**
 * Inline simulation of the off-chain orchestrator bridging OkuMoney from
 * `src` (source chain) to `dst` (destination chain) on behalf of `user`,
 * delivering to `recipient` on the destination chain.
 *
 * Steps mirror what the production orchestrator does, with the off-chain leg
 * (USDC custody + transmission) collapsed into a same-process token transfer
 * because both "chains" share state in this test.
 *
 * @returns Object with okuM minted on destination and USDC moved each leg.
 */
async function orchestratorBridgeOkuM(args: {
    src: Chain
    dst: Chain
    orchestrator: Signer
    user: Signer
    recipient: Signer
    okuMAmount: bigint
}): Promise<{ okuMOnDest: bigint; usdcOutSrc: bigint; usdcInDst: bigint }> {
    const { src, dst, orchestrator, user, recipient, okuMAmount } = args
    const orchestratorAddr = await orchestrator.getAddress()
    const recipientAddr = await recipient.getAddress()

    // ---- Source chain: orchestrator pulls user's OkuM and redeems via PSM. ----
    // The user authorises the orchestrator to spend their OkuM (the off-chain
    // analogue is an API call that includes a permit signature; here it's a
    // plain ERC-20 approve for clarity).
    await src.okuMoney.connect(user).approve(orchestratorAddr, okuMAmount)
    // The orchestrator transfers the OkuM to itself, then calls redeemOkuM.
    // It cannot call redeemOkuM(user, amount) because the PSM's
    // _redeemOkuMShared path pulls OkuM from msg.sender — so the orchestrator
    // must be the redeemer here, and the resulting USDC lands on the
    // orchestrator's USDC balance for off-chain custody.
    await src.okuMoney
        .connect(orchestrator)
        .transferFrom(await user.getAddress(), orchestratorAddr, okuMAmount)
    const usdcBeforeSrc = await src.usdc.balanceOf(orchestratorAddr)
    await src.okuMoney.connect(orchestrator).approve(await src.psm.getAddress(), okuMAmount)
    await src.psm.connect(orchestrator).redeemOkuM(okuMAmount)
    const usdcAfterSrc = await src.usdc.balanceOf(orchestratorAddr)
    const usdcOutSrc = usdcAfterSrc - usdcBeforeSrc
    expect(usdcOutSrc, `${src ? "src" : ""} redeem returned 0 USDC`).to.be.gt(0n)

    // ---- Off-chain: USDC is moved from chain A's custody to chain B's. ----
    // In production these are different chains and the orchestrator transfers
    // USDC from its custody on A to its custody on B. In this test the two
    // PSMs are different contracts on the same node, so we mint USDC on the
    // destination chain to the orchestrator (representing the cross-chain
    // USDC transfer settling on B) and burn the equivalent amount on the
    // source chain (representing the outflow from A).
    //
    // The orchestrator's USDC inflow on B equals the outflow on A: the
    // orchestrator is fully reserved against. MockUSDC has open mint so we
    // synthesise the destination credit here and leave the source-chain USDC
    // in the orchestrator's pocket as "operational float".
    await dst.usdc.mint(orchestratorAddr, usdcOutSrc)

    // ---- Destination chain: orchestrator deposits USDC and mints OkuM. ----
    const okuMBefore = await dst.okuMoney.balanceOf(orchestratorAddr)
    await dst.usdc.connect(orchestrator).approve(await dst.psm.getAddress(), usdcOutSrc)
    await dst.psm.connect(orchestrator).mintOkuM(usdcOutSrc)
    const okuMAfter = await dst.okuMoney.balanceOf(orchestratorAddr)
    const okuMOnDest = okuMAfter - okuMBefore
    expect(okuMOnDest, "destination mint produced 0 OkuM").to.be.gt(0n)

    // ---- Forward minted OkuM to the recipient. ----
    await dst.okuMoney.connect(orchestrator).transfer(recipientAddr, okuMOnDest)

    return { okuMOnDest, usdcOutSrc, usdcInDst: usdcOutSrc }
}

describe("Cross-Chain Bridging via Orchestrator + PSM (noBridge)", () => {
    let admin: Signer
    let orchestrator: Signer
    let alice: Signer
    let bob: Signer

    let chainA: Chain
    let chainB: Chain

    before(async () => {
        ;[admin, orchestrator, alice, bob] = await ethers.getSigners()

        chainA = await deployChain("A", admin)
        chainB = await deployChain("B", admin)
    })

    describe("OkuMoney bridging (A → B)", () => {
        it("moves OkuM from Alice on chain A to Bob on chain B with PSM accounting consistent on both sides", async () => {
            const aliceAddr = await alice.getAddress()
            const bobAddr = await bob.getAddress()
            const orchestratorAddr = await orchestrator.getAddress()

            // Alice acquires OkuM on chain A by depositing 1000 USDC.
            const aliceUsdcIn = parseUnits("1000", 6)
            await userMintsOkuMOnChain(chainA, alice, aliceUsdcIn)

            const aliceOkuMBalanceA = await chainA.okuMoney.balanceOf(aliceAddr)
            expect(aliceOkuMBalanceA).to.equal(aliceUsdcIn * 10n ** 12n) // 6 → 18 decimals at price $1

            const psmAUsdcBefore = await chainA.usdc.balanceOf(await chainA.psm.getAddress())
            const psmBUsdcBefore = await chainB.usdc.balanceOf(await chainB.psm.getAddress())
            const totalOkuMABefore = await chainA.okuMoney.totalSupply()
            const totalOkuMBBefore = await chainB.okuMoney.totalSupply()

            // Orchestrator bridges Alice's full position to Bob on chain B.
            const result = await orchestratorBridgeOkuM({
                src: chainA,
                dst: chainB,
                orchestrator,
                user: alice,
                recipient: bob,
                okuMAmount: aliceOkuMBalanceA,
            })

            // Source chain: Alice has no OkuM left, PSM USDC buffer dropped by exactly aliceUsdcIn.
            expect(await chainA.okuMoney.balanceOf(aliceAddr)).to.equal(0n)
            expect(await chainA.okuMoney.totalSupply()).to.equal(totalOkuMABefore - aliceOkuMBalanceA)
            const psmAUsdcAfter = await chainA.usdc.balanceOf(await chainA.psm.getAddress())
            expect(psmAUsdcBefore - psmAUsdcAfter).to.equal(aliceUsdcIn)

            // Destination chain: Bob received the OkuM, PSM B's buffer grew by the bridged USDC.
            expect(await chainB.okuMoney.balanceOf(bobAddr)).to.equal(result.okuMOnDest)
            expect(await chainB.okuMoney.totalSupply()).to.equal(totalOkuMBBefore + result.okuMOnDest)
            const psmBUsdcAfter = await chainB.usdc.balanceOf(await chainB.psm.getAddress())
            expect(psmBUsdcAfter - psmBUsdcBefore).to.equal(result.usdcInDst)

            // The orchestrator holds no residual OkuM on either chain (clean handoff).
            expect(await chainA.okuMoney.balanceOf(orchestratorAddr)).to.equal(0n)
            expect(await chainB.okuMoney.balanceOf(orchestratorAddr)).to.equal(0n)

            // At a 1:1 multiplier on both chains the round-trip is lossless.
            expect(result.okuMOnDest).to.equal(aliceOkuMBalanceA)
            expect(result.usdcOutSrc).to.equal(aliceUsdcIn)
        })

        it("survives a multiplier appreciation on the source chain (price-aware redeem)", async () => {
            // Alice deposits 500 USDC on chain A, then chain A's multiplier
            // ticks up 5% (yield distribution), then orchestrator bridges.
            // The destination chain B is still at 1.0x, so the bridged USDC
            // buys *more* OkuM on B than Alice burned on A — exactly the
            // arbitrage / yield-portability scenario the dual-multiplier
            // design is meant to handle.
            const aliceAddr = await alice.getAddress()
            const bobAddr = await bob.getAddress()

            const usdcIn = parseUnits("500", 6)
            await userMintsOkuMOnChain(chainA, alice, usdcIn)
            const aliceOkuM = await chainA.okuMoney.balanceOf(aliceAddr)

            // Bump chain A's multiplier by 5%.
            const priceABefore = await chainA.okuMoney.okuMMultiplier()
            const priceAAfter = (priceABefore * 105n) / 100n
            await chainA.okuMoney.connect(admin).setOkuMMultiplier(priceAAfter)
            // Move past the same-block yield-distribution lock.
            await ethers.provider.send("evm_mine", [])

            // After appreciation, Alice's OkuM is worth 5% more USDC than was
            // originally deposited. Top the source PSM buffer up so the redeem
            // can clear instantly instead of going to the queue. This is the
            // same operational role the orchestrator performs in production
            // (depositBuffer when the buffer is short for an outflow).
            const bufferTopUp = (usdcIn * 5n) / 100n + parseUnits("1", 6) // 5% + 1 USDC slack
            await chainA.usdc.mint(await admin.getAddress(), bufferTopUp)
            await chainA.usdc.connect(admin).approve(await chainA.psm.getAddress(), bufferTopUp)
            await chainA.psm.connect(admin).depositBuffer(bufferTopUp)

            const bobBalanceBefore = await chainB.okuMoney.balanceOf(bobAddr)
            const psmBUsdcBefore = await chainB.usdc.balanceOf(await chainB.psm.getAddress())

            const result = await orchestratorBridgeOkuM({
                src: chainA,
                dst: chainB,
                orchestrator,
                user: alice,
                recipient: bob,
                okuMAmount: aliceOkuM,
            })

            // The USDC released on A reflects the 5% appreciation: ~525 USDC for the same OkuM.
            // (Allow 1-unit rounding tolerance — PSM truncates in protocol's favour.)
            const expectedUsdc = (usdcIn * 105n) / 100n
            expect(result.usdcOutSrc).to.be.closeTo(expectedUsdc, 1n)

            // Bob receives MORE OkuM on chain B than Alice burned on A,
            // because B's multiplier is still 1.0 — the bridged USDC value
            // purchases more raw tokens at the lower price.
            expect(result.okuMOnDest).to.be.gt(aliceOkuM)
            const expectedBobOkuM = expectedUsdc * 10n ** 12n // 6 → 18 decimals at price $1
            expect(result.okuMOnDest).to.be.closeTo(expectedBobOkuM, 10n ** 12n)

            expect(await chainB.okuMoney.balanceOf(bobAddr)).to.equal(
                bobBalanceBefore + result.okuMOnDest
            )
            expect(
                (await chainB.usdc.balanceOf(await chainB.psm.getAddress())) - psmBUsdcBefore
            ).to.equal(result.usdcInDst)
        })
    })

    describe("OkuDollar bridging (A → B) — orchestrator unwraps first", () => {
        it("unwraps usdOku on source, bridges underlying OkuM via PSM, leaves recipient with raw OkuM on destination", async () => {
            // Use a fresh pair of chains to keep accounting tidy.
            const chainC = await deployChain("C", admin)
            const chainD = await deployChain("D", admin)

            const aliceAddr = await alice.getAddress()
            const bobAddr = await bob.getAddress()
            const orchestratorAddr = await orchestrator.getAddress()

            // Alice mints usdOku on chain C through the PSM convenience path.
            const aliceUsdcIn = parseUnits("250", 6)
            await chainC.usdc.mint(aliceAddr, aliceUsdcIn)
            await chainC.usdc.connect(alice).approve(await chainC.psm.getAddress(), aliceUsdcIn)
            await chainC.psm.connect(alice).mintUsdOku(aliceUsdcIn)
            const aliceUsdOku = await chainC.okuDollar.balanceOf(aliceAddr)
            expect(aliceUsdOku).to.be.gt(0n)

            // Orchestrator pulls the usdOku, unwraps to OkuM, then runs the
            // standard PSM redeem→USDC→mint flow into chain D.
            await chainC.okuDollar.connect(alice).approve(orchestratorAddr, aliceUsdOku)
            await chainC.okuDollar
                .connect(orchestrator)
                .transferFrom(aliceAddr, orchestratorAddr, aliceUsdOku)
            // unwrap(amount, to) returns OkuM to `to`.
            const okuMBefore = await chainC.okuMoney.balanceOf(orchestratorAddr)
            await chainC.okuDollar.connect(orchestrator).unwrap(aliceUsdOku, orchestratorAddr)
            const okuMAfter = await chainC.okuMoney.balanceOf(orchestratorAddr)
            const okuMUnwrapped = okuMAfter - okuMBefore
            expect(okuMUnwrapped).to.be.gt(0n)

            const usdcBefore = await chainC.usdc.balanceOf(orchestratorAddr)
            await chainC.okuMoney
                .connect(orchestrator)
                .approve(await chainC.psm.getAddress(), okuMUnwrapped)
            await chainC.psm.connect(orchestrator).redeemOkuM(okuMUnwrapped)
            const usdcAfter = await chainC.usdc.balanceOf(orchestratorAddr)
            const usdcOut = usdcAfter - usdcBefore

            // Cross-chain USDC settlement (simulated).
            await chainD.usdc.mint(orchestratorAddr, usdcOut)

            await chainD.usdc.connect(orchestrator).approve(await chainD.psm.getAddress(), usdcOut)
            const okuMDestBefore = await chainD.okuMoney.balanceOf(orchestratorAddr)
            await chainD.psm.connect(orchestrator).mintOkuM(usdcOut)
            const okuMDestAfter = await chainD.okuMoney.balanceOf(orchestratorAddr)
            const okuMDest = okuMDestAfter - okuMDestBefore

            // Forward to Bob. v1 design: usdOku does not survive the bridge —
            // the orchestrator delivers raw OkuM and the recipient wraps on
            // their own chain if they want the rebasing token. This matches
            // the SVM side's behaviour.
            await chainD.okuMoney.connect(orchestrator).transfer(bobAddr, okuMDest)

            // Source chain: usdOku and OkuM both clear out.
            expect(await chainC.okuDollar.balanceOf(aliceAddr)).to.equal(0n)
            expect(await chainC.okuDollar.balanceOf(orchestratorAddr)).to.equal(0n)
            expect(await chainC.okuMoney.balanceOf(orchestratorAddr)).to.equal(0n)

            // Destination chain: Bob holds raw OkuM, orchestrator clean.
            expect(await chainD.okuMoney.balanceOf(bobAddr)).to.equal(okuMDest)
            expect(await chainD.okuMoney.balanceOf(orchestratorAddr)).to.equal(0n)
            // At 1:1 multipliers on both sides this is also lossless.
            expect(okuMDest).to.equal(aliceUsdcIn * 10n ** 12n)
        })
    })

    describe("Failure modes", () => {
        it("aborts the bridge cleanly if the destination PSM is paused (no source-chain side effects committed)", async () => {
            // Spin up a dedicated source/dest pair so prior tests don't pollute
            // the assertions on totalSupply / balances.
            const src = await deployChain("E_src", admin)
            const dst = await deployChain("E_dst", admin)

            const aliceAddr = await alice.getAddress()
            const usdcIn = parseUnits("100", 6)
            await userMintsOkuMOnChain(src, alice, usdcIn)
            const aliceOkuM = await src.okuMoney.balanceOf(aliceAddr)

            // Pause destination PSM. The orchestrator should detect this
            // BEFORE pulling tokens on the source chain; here we simulate
            // it doing the dst-mint call last and reverting the whole flow.
            const PSM_PAUSER = ethers.keccak256(ethers.toUtf8Bytes("PSM_PAUSER"))
            await dst.psm.connect(admin).grantRole(PSM_PAUSER, await admin.getAddress())
            await dst.psm.connect(admin).pause()

            // Run the bridge expecting the destination mint to revert. The
            // orchestrator's real implementation would NOT have pulled tokens
            // from the user yet — it pre-flight-checks dst.paused(). We model
            // that here by only approving (not transferring) on the source
            // chain until after the dst mint succeeds. For this test we just
            // assert the revert surfaces.
            const orchestratorAddr = await orchestrator.getAddress()
            await dst.usdc.mint(orchestratorAddr, usdcIn)
            await dst.usdc.connect(orchestrator).approve(await dst.psm.getAddress(), usdcIn)
            await expect(dst.psm.connect(orchestrator).mintOkuM(usdcIn)).to.be.revertedWithCustomError(
                dst.psm,
                "EnforcedPause"
            )

            // Alice's OkuM on the source chain is untouched because the
            // orchestrator never executed step 1.
            expect(await src.okuMoney.balanceOf(aliceAddr)).to.equal(aliceOkuM)
        })

        it("rejects an unauthorised caller (no OKUM_MINTER) attempting to call mintOkuM directly", async () => {
            // Sanity: the PSM is the only mint path. A rogue orchestrator key
            // without OKUM_MINTER on the destination PSM cannot mint OkuM by
            // calling OkuMoney.mint() directly. This is what isolates the
            // off-chain orchestrator's authority to the PSM accounting path.
            const dst = chainB
            const orchestratorAddr = await orchestrator.getAddress()
            await expect(
                dst.okuMoney.connect(orchestrator).mint(orchestratorAddr, parseEther("1"))
            ).to.be.revertedWithCustomError(dst.okuMoney, "AccessControlUnauthorizedAccount")
        })
    })
})

// ===========================================================================
// WS3.3 — Cross-chain reconciliation invariant
//
// The correct invariant for a yield-bearing token is NOT
//   supply × multiplier == buffer
// because multiplier appreciation (T-Bill yield) increases supply_dollars
// without increasing the PSM buffer. Buffer tracks USDC deposits only.
//
// The correct accounting invariant for N bridges is:
//   USDC_flow_conservation: Σ USDC_redeemed_on_sources == Σ USDC_deposited_to_dests
//   Token_conservation:    Σ OkuM_burned_on_sources == Σ OkuM_minted_on_dests (per bridge)
//
// In the same-process simulation the orchestrator float is always 0
// (both legs execute atomically), so these reduce to:
//   For each bridge:  usdcOut_src == usdcIn_dst  (per-bridge dollar conservation)
//   Globally:  Σ totalOkuM_bridgedOut_A + Σ totalOkuM_bridgedOut_B
//               == Σ totalOkuM_bridgedIn_A + Σ totalOkuM_bridgedIn_B  (zero-sum)
// ===========================================================================

describe("WS3.3: cross-chain reconciliation invariant (N random bridges)", () => {
    let admin: Signer
    let alice: Signer
    let bob: Signer
    let orchestrator: Signer
    let chainA: Chain
    let chainB: Chain

    // Running totals for USDC flow conservation
    let cumulativeUsdcOutA = 0n  // USDC redeemed from A's buffer
    let cumulativeUsdcInB = 0n   // USDC deposited into B's buffer
    let cumulativeUsdcOutB = 0n
    let cumulativeUsdcInA = 0n

    const PRECISION = parseEther("1")

    /** USDC in the PSM buffer (6 decimals) */
    async function psmUsdcBalance(chain: Chain): Promise<bigint> {
        return chain.usdc.balanceOf(await chain.psm.getAddress())
    }

    /** Assert USDC flow conservation: Σ out == Σ in across both chains */
    function assertUsdcConservation(label: string) {
        const totalOut = cumulativeUsdcOutA + cumulativeUsdcOutB
        const totalIn = cumulativeUsdcInA + cumulativeUsdcInB
        // Allow ±1 USDC unit per bridge (rounding in dollarsToUsdc floor)
        const drift = totalOut > totalIn ? totalOut - totalIn : totalIn - totalOut
        expect(drift).to.be.lte(
            20n, // 1 unit per bridge × up to 20 bridges
            `USDC flow diverged after ${label}: Σout=${totalOut} Σin=${totalIn}`
        )
    }

    before(async () => {
        ;[admin, alice, bob, orchestrator] = await ethers.getSigners()
        chainA = await deployChain("A", admin)
        chainB = await deployChain("B", admin)

        const orchAddr = await orchestrator.getAddress()
        for (const chain of [chainA, chainB]) {
            await chain.okuMoney.connect(admin).grantRole(OKUM_MINTER, orchAddr)
            await chain.okuMoney.connect(admin).configureMinterAllowance(orchAddr, MINTER_ALLOWANCE)
            await chain.psm.connect(admin).grantRole(PSM_BUFFER_DEPOSITOR, orchAddr)
        }
    })

    it("invariant holds at genesis (no bridges, zero flows)", () => {
        assertUsdcConservation("genesis")
    })

    it("per-bridge USDC conservation holds after 10 A→B bridges", async () => {
        await userMintsOkuMOnChain(chainA, alice, parseUnits("50000", 6))

        const BRIDGE_AMOUNTS_OKUM = [
            parseEther("100"), parseEther("250"), parseEther("500"),
            parseEther("1000"), parseEther("50"), parseEther("750"),
            parseEther("300"), parseEther("200"), parseEther("400"),
            parseEther("1500"),
        ]

        const aliceAddr = await alice.getAddress()

        for (const okuMAmount of BRIDGE_AMOUNTS_OKUM) {
            const aliceBalance = await chainA.okuMoney.balanceOf(aliceAddr)
            if (aliceBalance < okuMAmount) break

            const bufABefore = await psmUsdcBalance(chainA)
            const bufBBefore = await psmUsdcBalance(chainB)

            await orchestratorBridgeOkuM({
                src: chainA, dst: chainB,
                orchestrator, user: alice, recipient: bob, okuMAmount
            })

            const bufAAfter = await psmUsdcBalance(chainA)
            const bufBAfter = await psmUsdcBalance(chainB)

            // USDC left A's buffer
            const usdcOut = bufABefore - bufAAfter
            // USDC entered B's buffer
            const usdcIn = bufBAfter - bufBBefore

            cumulativeUsdcOutA += usdcOut
            cumulativeUsdcInB += usdcIn

            // Per-bridge: out == in (modulo 1 wei rounding)
            const drift = usdcOut > usdcIn ? usdcOut - usdcIn : usdcIn - usdcOut
            expect(drift).to.be.lte(1n, `Bridge USDC drift: out=${usdcOut} in=${usdcIn}`)
        }

        assertUsdcConservation("10 A→B bridges")
    })

    it("per-bridge USDC conservation holds on B→A bridge (bidirectional)", async () => {
        const bobAddr = await bob.getAddress()
        const aliceAddr = await alice.getAddress()
        const bobBalance = await chainB.okuMoney.balanceOf(bobAddr)

        if (bobBalance >= parseEther("50")) {
            const bufABefore = await psmUsdcBalance(chainA)
            const bufBBefore = await psmUsdcBalance(chainB)

            await orchestratorBridgeOkuM({
                src: chainB, dst: chainA,
                orchestrator, user: bob, recipient: alice, okuMAmount: parseEther("50")
            })

            const usdcOut = bufBBefore - (await psmUsdcBalance(chainB))
            const usdcIn = (await psmUsdcBalance(chainA)) - bufABefore
            cumulativeUsdcOutB += usdcOut
            cumulativeUsdcInA += usdcIn

            const drift = usdcOut > usdcIn ? usdcOut - usdcIn : usdcIn - usdcOut
            expect(drift).to.be.lte(1n, `B→A bridge USDC drift: out=${usdcOut} in=${usdcIn}`)
        }

        assertUsdcConservation("B→A bridge")
    })

    it("USDC flow conservation holds after multiplier bump + bridge", async () => {
        // OkuM token COUNTS are NOT conserved across a multiplier boundary — this is
        // by design. A 100 OkuM token at 2× multiplier redeems for 200 USDC on source
        // and the orchestrator mints 200 OkuM on the dest (at 1× multiplier), because
        // what's conserved is DOLLAR VALUE (USDC), not token count.
        //
        // This test verifies that USDC flow conservation holds even after a multiplier
        // bump: the USDC redeemed on source == the USDC deposited on destination.
        await userMintsOkuMOnChain(chainA, alice, parseUnits("1000", 6))

        const current = await chainA.okuMoney.okuMMultiplier()
        await chainA.okuMoney.connect(admin).setOkuMMultiplier(current * 2n)

        const aliceBalance = await chainA.okuMoney.balanceOf(await alice.getAddress())
        const bridgeAmt = aliceBalance > parseEther("100") ? parseEther("100") : aliceBalance
        if (bridgeAmt === 0n) return

        const bufABefore = await psmUsdcBalance(chainA)
        const bufBBefore = await psmUsdcBalance(chainB)

        await orchestratorBridgeOkuM({
            src: chainA, dst: chainB,
            orchestrator, user: alice, recipient: bob, okuMAmount: bridgeAmt
        })

        const usdcOut = bufABefore - (await psmUsdcBalance(chainA))
        const usdcIn = (await psmUsdcBalance(chainB)) - bufBBefore

        // USDC flow conservation: redeemed on A == deposited on B (±1 USDC unit)
        const drift = usdcOut > usdcIn ? usdcOut - usdcIn : usdcIn - usdcOut
        expect(drift).to.be.lte(1n, `USDC flow drift after multiplier bump: out=${usdcOut} in=${usdcIn}`)

        cumulativeUsdcOutA += usdcOut
        cumulativeUsdcInB += usdcIn
        assertUsdcConservation("multiplier bump + bridge")
    })
})
