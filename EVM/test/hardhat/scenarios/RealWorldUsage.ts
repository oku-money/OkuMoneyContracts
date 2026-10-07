/**
 * RealWorldUsage — deterministic multi-chain edge-case suites.
 *
 * Exercises the okuMoney PSM-mediated lifecycle on a dual-chain (A+B) harness, one
 * scenario per suite, each with a hand-derived expected outcome.
 *
 *   E1. Multi-month round-trip A→B→A with yield accruing on B
 *   E2. Source redeem against an empty buffer reverts until it is reseeded
 *   E3. Multiplier divergence between chains (A rebases, B does not)
 *   E4. Blacklisted recipient mid-bridge
 *   E5. Pause on one side during a multi-week run
 *   E7. Yield-lock vs same-block bridge attempt
 *   E8. Cap manager / minterAllowance exhaustion
 *
 * Scenarios are deterministic so each expected value is derived by hand rather
 * than observed.
 */

import {
    LitePSM,
    LitePSM__factory,
    OkuMoney,
    OkuMoney__factory,
    OkuDollar,
    OkuDollar__factory,
    MockUSDC,
    MockUSDC__factory,
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits } from "ethers"
import { ethers, upgrades, network } from "hardhat"
import { expect } from "chai"
import { ROLES } from "../../../scripts/config/roles"

const DAY = 86400

// ---------------------------------------------------------------------------
// Role constants
// ---------------------------------------------------------------------------

const {
    OKUM_MINTER, OKUM_BURNER, OKUM_REBASER, OKUM_ALLOWANCE_MANAGER,
    OKUM_BLACKLISTER, OKUM_UNBLACKLISTER,
    PSM_BUFFER_DEPOSITOR, PSM_BUFFER_WITHDRAWER,
    PSM_PAUSER, PSM_UNPAUSER,
} = ROLES

const MAX_SUPPLY = parseEther("1000000000")
const MINTER_ALLOWANCE = parseEther("1000000000")

// ---------------------------------------------------------------------------
// Chain deployment helper
// ---------------------------------------------------------------------------

type Chain = {
    usdc: MockUSDC
    okuMoney: OkuMoney
    okuDollar: OkuDollar
    psm: LitePSM
    label: string
    admin: Signer
}

async function deployChain(label: string, admin: Signer): Promise<Chain> {
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
        ],
        { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as OkuDollar
    await okuDollar.waitForDeployment()

    const psm = (await upgrades.deployProxy(
        new LitePSM__factory(admin),
        [
            await okuMoney.getAddress(),
            await okuDollar.getAddress(),
            await usdc.getAddress(),
            adminAddr,
        ],
        { kind: "uups", unsafeAllow: ["constructor"] }
    )) as unknown as LitePSM
    await psm.waitForDeployment()

    // Roles
    await okuMoney.connect(admin).grantRole(OKUM_MINTER, await psm.getAddress())
    await okuMoney.connect(admin).grantRole(OKUM_BURNER, await psm.getAddress())
    await okuMoney.connect(admin).grantRole(OKUM_REBASER, adminAddr)
    await okuMoney.connect(admin).grantRole(OKUM_ALLOWANCE_MANAGER, adminAddr)
    await okuMoney.connect(admin).grantRole(OKUM_BLACKLISTER, adminAddr)
    await okuMoney.connect(admin).grantRole(OKUM_UNBLACKLISTER, adminAddr)
    await okuMoney.connect(admin).configureMinterAllowance(await psm.getAddress(), MINTER_ALLOWANCE)
    await psm.connect(admin).grantRole(PSM_BUFFER_DEPOSITOR, adminAddr)
    await psm.connect(admin).grantRole(PSM_BUFFER_WITHDRAWER, adminAddr)
    await psm.connect(admin).grantRole(PSM_PAUSER, adminAddr)
    await psm.connect(admin).grantRole(PSM_UNPAUSER, adminAddr)

    // OkuDollar blacklist roles
    await okuDollar.connect(admin).grantRole(OKUM_BLACKLISTER, adminAddr)
    await okuDollar.connect(admin).grantRole(OKUM_UNBLACKLISTER, adminAddr)

    return { usdc, okuMoney, okuDollar, psm, label, admin }
}

async function warpDays(days: number) {
    await network.provider.send("evm_increaseTime", [days * DAY])
    await network.provider.send("evm_mine", [])
}

async function warpBlock() {
    await network.provider.send("evm_mine", [])
}

/** Seed a chain's USDC buffer so instant redeems can succeed. */
async function seedBuffer(chain: Chain, admin: Signer, usdcAmount: bigint) {
    const adminAddr = await admin.getAddress()
    await chain.usdc.mint(adminAddr, usdcAmount)
    await chain.usdc.connect(admin).approve(await chain.psm.getAddress(), usdcAmount)
    await chain.psm.connect(admin).depositBuffer(usdcAmount)
}

const WAD = 10n ** 18n

/** USDC has 6 decimals, so one collateral unit is 1e12 dollar-wei. */
const DECIMAL_MULTIPLIER = 10n ** 12n

/**
 * Orchestrator bridges okuMAmount from src chain to dst chain for user → recipient.
 *
 * Returns DOLLAR VALUE on each side, not USDC.
 *
 * The USDC figures cannot measure anything: `LitePSM.mintOkuM(usdcOut)` transfers
 * exactly `usdcOut`, so the orchestrator's USDC delta across
 * the mint is identically the amount handed to it. A drift computed that way is
 * structurally zero and the assertion built on it can never fail — which is what
 * the deleted simulation did, under a comment claiming it had been fixed.
 *
 * Dollar value is the quantity that can actually move. It passes through two
 * independent floors:
 *
 *   src:  dollars18 = floor(okuM · multSrc / 1e18)        — okuMToDollars
 *         usdcOut   = floor(dollars18 / DECIMAL_MULTIPLIER) — dollarsToUsdc
 *   dst:  okuMOnDst = floor(usdcOut · DECIMAL_MULTIPLIER · 1e18 / multDst)
 *
 * so the recipient's value is bounded above by the sender's, and below it by the
 * accumulated truncation. Both bounds are asserted by callers.
 */
async function orchestratorBridge(
    src: Chain,
    dst: Chain,
    orchestrator: Signer,
    user: Signer,
    recipient: Signer,
    okuMAmount: bigint
): Promise<{ usdcOut: bigint; dollarsOut: bigint; dollarsIn: bigint; driftBound: bigint }> {
    const orchAddr = await orchestrator.getAddress()
    const recipientAddr = await recipient.getAddress()

    // Source leg: pull OkuM from user, redeem via PSM
    const multSrc = await src.okuMoney.okuMMultiplier()
    const dollarsOut = (okuMAmount * multSrc) / WAD

    await src.okuMoney.connect(user).approve(orchAddr, okuMAmount)
    await src.okuMoney.connect(orchestrator).transferFrom(await user.getAddress(), orchAddr, okuMAmount)
    await src.okuMoney.connect(orchestrator).approve(await src.psm.getAddress(), okuMAmount)
    const usdcBeforeSrc = await src.usdc.balanceOf(orchAddr)
    await src.psm.connect(orchestrator).redeemOkuM(okuMAmount)
    const usdcOut = (await src.usdc.balanceOf(orchAddr)) - usdcBeforeSrc

    // Off-chain leg: credit USDC to orchestrator on dst
    await dst.usdc.mint(orchAddr, usdcOut)

    // Destination leg: deposit USDC, mint OkuM, forward to recipient.
    await dst.usdc.connect(orchestrator).approve(await dst.psm.getAddress(), usdcOut)
    const okuMBeforeDst = await dst.okuMoney.balanceOf(orchAddr)
    await dst.psm.connect(orchestrator).mintOkuM(usdcOut)
    const okuMOnDst = (await dst.okuMoney.balanceOf(orchAddr)) - okuMBeforeDst
    await dst.okuMoney.connect(orchestrator).transfer(recipientAddr, okuMOnDst)

    const multDst = await dst.okuMoney.okuMMultiplier()
    const dollarsIn = (okuMOnDst * multDst) / WAD

    // Worst-case loss, derived not observed: up to one collateral unit from
    // `dollarsToUsdc`'s floor on the source, plus up to one OkuM wei (worth
    // ceil(multDst/1e18) dollar-wei) from `dollarsToOkuM`'s floor on the
    // destination, plus one wei for `okuMToDollars`' own floor.
    const driftBound = DECIMAL_MULTIPLIER + (multDst + WAD - 1n) / WAD + 1n

    return { usdcOut, dollarsOut, dollarsIn, driftBound }
}

describe("RealWorldUsage edge cases", () => {
    let admin: Signer
    let orchestrator: Signer
    let alice: Signer
    let bob: Signer
    let carol: Signer

    before(async () => {
        ;[admin, orchestrator, alice, bob, carol] = await ethers.getSigners()
    })

    async function freshChains(): Promise<{ chainA: Chain; chainB: Chain }> {
        const chainA = await deployChain("E-A", admin)
        const chainB = await deployChain("E-B", admin)
        await seedBuffer(chainA, admin, parseUnits("100000", 6))
        await seedBuffer(chainB, admin, parseUnits("100000", 6))
        return { chainA, chainB }
    }

    // -------------------------------------------------------------------------
    // E1. Multi-month round-trip A→B→A with yield accruing
    // -------------------------------------------------------------------------
    describe("E1: round-trip A→B→A with 90-day yield accrual", () => {
        it("dollar value is conserved across an A→B→A round-trip with yield accruing on B", async () => {
            const { chainA, chainB } = await freshChains()
            const aliceAddr = await alice.getAddress()
            const orchAddr = await orchestrator.getAddress()

            // Alice mints 1000 USDC worth of OkuM on A
            const aliceUsdc = parseUnits("1000", 6)
            await chainA.usdc.mint(aliceAddr, aliceUsdc)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), aliceUsdc)
            await chainA.psm.connect(alice).mintOkuM(aliceUsdc)
            const aliceOkuM = await chainA.okuMoney.balanceOf(aliceAddr)

            // Bridge A→B
            const ab = await orchestratorBridge(chainA, chainB, orchestrator, alice, bob, aliceOkuM)
            expect(await chainA.okuMoney.balanceOf(orchAddr)).to.equal(0n, "orch float after A→B")

            // A bridge must never CREATE value, and must lose no more than the
            // two floors can account for. Both bounds derived, not observed.
            expect(ab.dollarsIn, "A→B must not create value").to.be.lte(ab.dollarsOut)
            expect(ab.dollarsOut - ab.dollarsIn, "A→B loss exceeds derived truncation bound")
                .to.be.lt(ab.driftBound)

            // 90 days pass on B, orchestrator bumps OkuM multiplier 3× by +1%.
            // Integer division truncates each step, so the compounded factor is
            // asserted against the multiplier actually reached rather than a
            // float literal — but the SHAPE (three +1% steps) is the test's own
            // input, not something read back from the contract.
            const multBBefore = await chainB.okuMoney.okuMMultiplier()
            for (let i = 0; i < 3; i++) {
                await warpDays(30)
                const current = await chainB.okuMoney.okuMMultiplier()
                await chainB.okuMoney.connect(admin).setOkuMMultiplier(current + current / 100n) // +1%
            }
            let expectedMultB = multBBefore
            for (let i = 0; i < 3; i++) expectedMultB = expectedMultB + expectedMultB / 100n
            expect(await chainB.okuMoney.okuMMultiplier(), "three +1% bumps must compound")
                .to.equal(expectedMultB)

            // Bob bridges back B→A
            const bobOkuM = await chainB.okuMoney.balanceOf(await bob.getAddress())
            const ba = await orchestratorBridge(chainB, chainA, orchestrator, bob, carol, bobOkuM)
            expect(await chainB.okuMoney.balanceOf(orchAddr)).to.equal(0n, "orch float after B→A")

            expect(ba.dollarsIn, "B→A must not create value").to.be.lte(ba.dollarsOut)
            expect(ba.dollarsOut - ba.dollarsIn, "B→A loss exceeds derived truncation bound")
                .to.be.lt(ba.driftBound)

            // The point of the scenario: Bob's holding appreciated by exactly the
            // three bumps while it sat on B, so the return leg carries ~1.01^3 of
            // the outbound dollar value. Asserted against the test's own
            // expectedMultB, so a silently no-op `setOkuMMultiplier` fails here.
            const expectedBack = (ab.dollarsIn * expectedMultB) / multBBefore
            expect(ba.dollarsOut, "B→A dollar value must reflect the yield accrued on B")
                .to.be.closeTo(expectedBack, ba.driftBound)
        })
    })

    // -------------------------------------------------------------------------
    // E2. Empty source buffer blocks the orchestrator until reseeded
    // -------------------------------------------------------------------------
    describe("E2: empty source buffer blocks orchestrator", () => {
        it("src redeem reverts InsufficientBuffer while buffer empty; succeeds after reseed", async () => {
            const { chainA, chainB } = await freshChains()
            const adminAddr = await admin.getAddress()
            const aliceAddr = await alice.getAddress()
            const orchAddr = await orchestrator.getAddress()

            // Alice mints 100 OkuM on A
            const aliceUsdc = parseUnits("100", 6)
            await chainA.usdc.mint(aliceAddr, aliceUsdc)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), aliceUsdc)
            await chainA.psm.connect(alice).mintOkuM(aliceUsdc)
            const aliceOkuM = await chainA.okuMoney.balanceOf(aliceAddr)

            // Drain the source buffer to zero. `freshChains` seeds 100,000 USDC and
            // Alice's 100 went in on mint, so the buffer holds exactly both.
            const bufferBal = await chainA.usdc.balanceOf(await chainA.psm.getAddress())
            expect(bufferBal, "fixture: buffer must be non-empty before draining")
                .to.equal(parseUnits("100000", 6) + aliceUsdc)
            await chainA.psm.connect(admin).withdrawUsdc(adminAddr, bufferBal)
            expect(await chainA.usdc.balanceOf(await chainA.psm.getAddress())).to.equal(0n)

            // Orchestrator pulls Alice's OkuM and tries to redeem: reverts, keeps the OkuM.
            await chainA.okuMoney.connect(alice).approve(orchAddr, aliceOkuM)
            await chainA.okuMoney.connect(orchestrator).transferFrom(aliceAddr, orchAddr, aliceOkuM)
            await chainA.okuMoney.connect(orchestrator).approve(await chainA.psm.getAddress(), aliceOkuM)
            await expect(chainA.psm.connect(orchestrator).redeemOkuM(aliceOkuM))
                .to.be.revertedWithCustomError(chainA.psm, "InsufficientBuffer")
                .withArgs(0n, aliceUsdc)
            expect(await chainA.okuMoney.balanceOf(orchAddr), "orchestrator keeps its OkuM")
                .to.equal(aliceOkuM)
            expect(await chainA.usdc.balanceOf(orchAddr), "no USDC released").to.equal(0n)

            // Without source USDC the destination mint cannot proceed. Approve
            // generously so the revert can only be about balance, not allowance.
            await chainB.usdc
                .connect(orchestrator)
                .approve(await chainB.psm.getAddress(), parseUnits("100", 6))
            await expect(
                chainB.psm.connect(orchestrator).mintOkuM(parseUnits("100", 6)),
                "dst mint must fail before the source redeem succeeds"
            ).to.be.revertedWithCustomError(chainB.usdc, "ERC20InsufficientBalance")

            // Reseed the buffer; the same redeem now succeeds. At multiplier 1.0 the
            // orchestrator receives exactly the 100 USDC Alice put in.
            await seedBuffer(chainA, admin, parseUnits("200", 6))
            await chainA.psm.connect(orchestrator).redeemOkuM(aliceOkuM)
            expect(await chainA.okuMoney.balanceOf(orchAddr)).to.equal(0n)
            const orchUsdc = await chainA.usdc.balanceOf(orchAddr)
            expect(orchUsdc, "redeem pays the full dollar value").to.equal(aliceUsdc)

            // Now orchestrator mints on B. Multiplier is 1.0 on B, so 100 USDC
            // buys exactly 100e18 OkuM (6→18 decimal scaling).
            await chainB.usdc.mint(orchAddr, orchUsdc)
            await chainB.usdc.connect(orchestrator).approve(await chainB.psm.getAddress(), orchUsdc)
            await chainB.psm.connect(orchestrator).mintOkuM(orchUsdc)
            const orchOkuMB = await chainB.okuMoney.balanceOf(orchAddr)
            expect(await chainB.okuMoney.okuMMultiplier(), "B must be unrebased for the literal below")
                .to.equal(WAD)
            expect(orchOkuMB, "OkuM minted on B").to.equal(orchUsdc * DECIMAL_MULTIPLIER)

            // Forward to recipient
            await chainB.okuMoney.connect(orchestrator).transfer(aliceAddr, orchOkuMB)
            expect(await chainB.okuMoney.balanceOf(orchAddr), "orch float zero after bridge").to.equal(0n)
            expect(await chainB.okuMoney.balanceOf(aliceAddr), "recipient receives the full bridged amount")
                .to.equal(orchOkuMB)
        })
    })

    // -------------------------------------------------------------------------
    // E3. Multiplier divergence between chains
    // -------------------------------------------------------------------------
    describe("E3: multiplier divergence — A rebases, B does not", () => {
        it("bridges preserve dollar value despite different multipliers on each chain", async () => {
            const { chainA, chainB } = await freshChains()
            const aliceAddr = await alice.getAddress()

            // Alice mints on A
            const aliceUsdc = parseUnits("1000", 6)
            await chainA.usdc.mint(aliceAddr, aliceUsdc)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), aliceUsdc)
            await chainA.psm.connect(alice).mintOkuM(aliceUsdc)

            // Bump A's multiplier 5× by +2% each, B not touched. Expected value
            // compounded by the test, then asserted — so a no-op setter fails here.
            const multABefore = await chainA.okuMoney.okuMMultiplier()
            for (let i = 0; i < 5; i++) {
                const cur = await chainA.okuMoney.okuMMultiplier()
                await chainA.okuMoney.connect(admin).setOkuMMultiplier(cur + cur / 50n) // +2%
            }
            let expectedMultA = multABefore
            for (let i = 0; i < 5; i++) expectedMultA = expectedMultA + expectedMultA / 50n

            const multA = await chainA.okuMoney.okuMMultiplier()
            const multB = await chainB.okuMoney.okuMMultiplier()
            expect(multA, "five +2% bumps must compound on A").to.equal(expectedMultA)
            expect(multB, "B must remain unrebased").to.equal(WAD)

            // The property this scenario is named for: a bridge carries DOLLAR
            // VALUE across chains whose multipliers differ, so the recipient's
            // raw OkuM count on B is larger than the sender's on A while the
            // value is preserved to within the two floors.
            //
            // Measured in dollars, not USDC. `mintOkuM(x)` transfers exactly `x`,
            // so a USDC-denominated drift is identically zero and cannot fail.
            let cumulativeDrift = 0n
            let bridges = 0
            for (let i = 0; i < 10; i++) {
                // Alice mints fresh OkuM on A each iteration
                const bridgeUsdc = parseUnits("10", 6)
                await chainA.usdc.mint(aliceAddr, bridgeUsdc)
                await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), bridgeUsdc)
                await chainA.psm.connect(alice).mintOkuM(bridgeUsdc)
                const aliceOkuM = await chainA.okuMoney.balanceOf(aliceAddr)
                expect(aliceOkuM, `iteration ${i}: Alice must hold OkuM to bridge`).to.be.gt(0n)

                const bobBefore = await chainB.okuMoney.balanceOf(await bob.getAddress())
                const r = await orchestratorBridge(chainA, chainB, orchestrator, alice, bob, aliceOkuM)
                const bobGained = (await chainB.okuMoney.balanceOf(await bob.getAddress())) - bobBefore

                // Value is never created...
                expect(r.dollarsIn, `bridge ${i} must not create value`).to.be.lte(r.dollarsOut)
                // ...and never lost beyond the derived truncation bound.
                const drift = r.dollarsOut - r.dollarsIn
                expect(drift, `bridge ${i} loss exceeds derived bound`).to.be.lt(r.driftBound)
                cumulativeDrift += drift
                bridges++

                // Raw token counts diverge in the direction the multipliers imply:
                // B is cheaper per OkuM, so the same dollar value buys more of them.
                expect(bobGained, `bridge ${i}: lower multiplier must yield MORE raw OkuM`)
                    .to.be.gt(aliceOkuM)
            }

            expect(bridges, "all 10 bridges must have executed").to.equal(10)
            expect(cumulativeDrift, "cumulative loss across 10 bridges")
                .to.be.lt(10n * (DECIMAL_MULTIPLIER + 4n))
        })
    })

    // -------------------------------------------------------------------------
    // E4. Blacklisted recipient mid-bridge (EVM: OkuDollar.blacklist)
    // -------------------------------------------------------------------------
    describe("E4: blacklisted recipient cannot receive OkuM transfer", () => {
        it("transfer to blacklisted address on dst reverts; orchestrator holds OkuM float", async () => {
            const { chainA, chainB } = await freshChains()
            const aliceAddr = await alice.getAddress()
            const carolAddr = await carol.getAddress()
            const orchAddr = await orchestrator.getAddress()

            // Alice mints 100 OkuM on A
            const aliceUsdc = parseUnits("100", 6)
            await chainA.usdc.mint(aliceAddr, aliceUsdc)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), aliceUsdc)
            await chainA.psm.connect(alice).mintOkuM(aliceUsdc)
            const aliceOkuM = await chainA.okuMoney.balanceOf(aliceAddr)

            // Blacklist carol on chain B's OkuMoney (via OkuDollar's blacklist — same token)
            await chainB.okuMoney.connect(admin).blacklist(carolAddr)

            // Bridge A→B manually; mint succeeds but forward to carol fails
            const orchAddr2 = orchAddr
            await chainA.okuMoney.connect(alice).approve(orchAddr2, aliceOkuM)
            await chainA.okuMoney.connect(orchestrator).transferFrom(aliceAddr, orchAddr2, aliceOkuM)
            await chainA.okuMoney.connect(orchestrator).approve(await chainA.psm.getAddress(), aliceOkuM)
            await chainA.psm.connect(orchestrator).redeemOkuM(aliceOkuM)
            const usdcGained = await chainA.usdc.balanceOf(orchAddr2)

            // Destination: mint OkuM to orchestrator
            await chainB.usdc.mint(orchAddr2, usdcGained)
            await chainB.usdc.connect(orchestrator).approve(await chainB.psm.getAddress(), usdcGained)
            await chainB.psm.connect(orchestrator).mintOkuM(usdcGained)
            const okuMOnB = await chainB.okuMoney.balanceOf(orchAddr2)
            expect(await chainB.okuMoney.okuMMultiplier(), "B unrebased for the literal below")
                .to.equal(WAD)
            expect(okuMOnB, "OkuM minted on B").to.equal(usdcGained * DECIMAL_MULTIPLIER)

            // Attempt to transfer to carol — must revert for the BLACKLIST reason
            // specifically. A bare `.to.be.reverted` here would also accept an
            // insufficient-balance or paused revert, i.e. it would pass even if
            // the blacklist did nothing.
            await expect(
                chainB.okuMoney.connect(orchestrator).transfer(carolAddr, okuMOnB)
            ).to.be.revertedWithCustomError(chainB.okuMoney, "RecipientBlacklisted")

            // THE NAMED PROPERTY: the orchestrator is left holding the float. The
            // previous version asserted this nowhere and immediately redirected.
            expect(await chainB.okuMoney.balanceOf(orchAddr2), "orchestrator retains the float")
                .to.equal(okuMOnB)

            // Recovery: redirect to a non-blacklisted recipient.
            const aliceBefore = await chainB.okuMoney.balanceOf(aliceAddr)
            await chainB.okuMoney.connect(orchestrator).transfer(aliceAddr, okuMOnB)
            expect(await chainB.okuMoney.balanceOf(orchAddr2)).to.equal(0n, "orch float cleared after redirect")
            expect(await chainB.okuMoney.balanceOf(aliceAddr), "redirect delivers the full float")
                .to.equal(aliceBefore + okuMOnB)

            // Unblacklist carol for subsequent tests
            await chainB.okuMoney.connect(admin).unblacklist(carolAddr)
        })
    })

    // -------------------------------------------------------------------------
    // E5. Pause on one side during long run
    // -------------------------------------------------------------------------
    describe("E5: pause on one side during a multi-week run", () => {
        it("mints on paused chain revert; system resumes cleanly after unpause", async () => {
            const { chainA, chainB } = await freshChains()
            const aliceAddr = await alice.getAddress()

            // Alice mints on A
            const aliceUsdc = parseUnits("500", 6)
            await chainA.usdc.mint(aliceAddr, aliceUsdc)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), aliceUsdc)
            await chainA.psm.connect(alice).mintOkuM(aliceUsdc)

            // Pause chain A
            await chainA.psm.connect(admin).pause()
            expect(await chainA.psm.paused()).to.be.true

            // Advance 7 days; the pause must hold across the whole window.
            await warpDays(7)

            const aliceOkuMOnA = await chainA.okuMoney.balanceOf(aliceAddr)
            const hundred = parseUnits("100", 6)

            // EVERY user-facing PSM path on A must revert with `EnforcedPause`.
            await chainA.usdc.mint(aliceAddr, hundred)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), hundred)
            await chainA.okuMoney.connect(alice).approve(await chainA.psm.getAddress(), aliceOkuMOnA)

            await expect(chainA.psm.connect(alice).mintOkuM(hundred), "mintOkuM while paused")
                .to.be.revertedWithCustomError(chainA.psm, "EnforcedPause")
            await expect(chainA.psm.connect(alice).redeemOkuM(aliceOkuMOnA), "redeemOkuM while paused")
                .to.be.revertedWithCustomError(chainA.psm, "EnforcedPause")
            await expect(chainA.psm.connect(alice).mintUsdOku(hundred), "mintUsdOku while paused")
                .to.be.revertedWithCustomError(chainA.psm, "EnforcedPause")
            await expect(chainA.psm.connect(alice).redeemUsdOku(parseEther("1")), "redeemUsdOku while paused")
                .to.be.revertedWithCustomError(chainA.psm, "EnforcedPause")

            // Nothing moved: the pause is a true freeze, not a partial one.
            expect(await chainA.okuMoney.balanceOf(aliceAddr), "paused chain must not move balances")
                .to.equal(aliceOkuMOnA)

            // Chain B remains live during this window. Multiplier is 1.0 there,
            // so 100 USDC buys exactly 100e18 OkuM.
            await chainB.usdc.mint(aliceAddr, hundred)
            await chainB.usdc.connect(alice).approve(await chainB.psm.getAddress(), hundred)
            await chainB.psm.connect(alice).mintOkuM(hundred)
            expect(await chainB.okuMoney.okuMMultiplier()).to.equal(WAD)
            expect(await chainB.okuMoney.balanceOf(aliceAddr), "B remains live while A paused")
                .to.equal(hundred * DECIMAL_MULTIPLIER)

            // Unpause A — resume succeeds, for the exact expected amount.
            await chainA.psm.connect(admin).unpause()
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), hundred)
            await chainA.psm.connect(alice).mintOkuM(hundred)
            const multA = await chainA.okuMoney.okuMMultiplier()
            const expectedGain = (hundred * DECIMAL_MULTIPLIER * WAD) / multA
            expect(await chainA.okuMoney.balanceOf(aliceAddr), "A resumes after unpause")
                .to.equal(aliceOkuMOnA + expectedGain)
        })
    })

    // -------------------------------------------------------------------------
    // E7. Yield-lock vs bridge: same-block setOkuMMultiplier + mintOkuM
    // -------------------------------------------------------------------------
    describe("E7: yield-lock prevents bridge in same block as multiplier bump", () => {
        it("mintOkuM reverts in same block as setOkuMMultiplier; next block succeeds", async () => {
            const { chainA } = await freshChains()
            const aliceAddr = await alice.getAddress()
            const mintAmt = parseUnits("10", 6)

            // Pre-fund and approve BEFORE automining is disabled, so the only
            // transactions contending for the shared block are the two under
            // test and ordering is deterministic.
            await chainA.usdc.mint(aliceAddr, mintAmt * 2n)
            await chainA.usdc.connect(alice).approve(await chainA.psm.getAddress(), mintAmt * 2n)

            await network.provider.send("evm_setAutomine", [false])
            let mintReceipt
            try {
                const curMult = await chainA.okuMoney.okuMMultiplier()
                // Both txs must sit in the mempool before the block is mined, and
                // both need an explicit gasLimit: ethers otherwise runs
                // eth_estimateGas against pending state, which reverts the mint
                // at send time so it never reaches the block under test.
                // Gas price pins the ordering (bump first) — senders differ, so
                // Hardhat's price-ordered mempool is what decides it.
                const bump = await chainA.okuMoney
                    .connect(admin)
                    .setOkuMMultiplier(curMult + 1000n, {
                        gasLimit: 500_000n,
                        maxPriorityFeePerGas: 50_000_000_000n,
                        maxFeePerGas: 200_000_000_000n,
                    })
                const mint = await chainA.psm.connect(alice).mintOkuM(mintAmt, {
                    gasLimit: 500_000n,
                    maxPriorityFeePerGas: 1_000_000_000n,
                    maxFeePerGas: 200_000_000_000n,
                })
                await network.provider.send("evm_mine", [])

                const bumpReceipt = await ethers.provider.getTransactionReceipt(bump.hash)
                mintReceipt = await ethers.provider.getTransactionReceipt(mint.hash)
                expect(bumpReceipt!.status).to.equal(1, "multiplier bump should succeed")
                expect(mintReceipt!.blockNumber).to.equal(
                    bumpReceipt!.blockNumber,
                    "both txs must share a block for this to test anything"
                )
            } finally {
                await network.provider.send("evm_setAutomine", [true])
            }

            // The property this suite is named for.
            expect(mintReceipt!.status).to.equal(0, "same-block mint must revert")
            expect(await chainA.okuMoney.balanceOf(aliceAddr)).to.equal(
                0n,
                "same-block mint must not have credited OkuM"
            )

            // Next block: the same mint succeeds.
            await warpBlock()
            await chainA.psm.connect(alice).mintOkuM(mintAmt)
            expect(await chainA.okuMoney.balanceOf(aliceAddr)).to.be.gt(0n, "mint succeeds on next block")
        })
    })

    // -------------------------------------------------------------------------
    // E8. Cap manager / minterAllowance exhaustion
    // -------------------------------------------------------------------------
    describe("E8: minterAllowance exhaustion and rotation", () => {
        it("mint fails when minterAllowance exhausted; resumes after configureMinterAllowance rotation", async () => {
            const { chainA } = await freshChains()
            const aliceAddr = await alice.getAddress()

            const psmAddr = await chainA.psm.getAddress()

            // Set a tiny minter allowance on the PSM (1 OkuM)
            const tinyAllowance = parseEther("1")
            await chainA.okuMoney.connect(admin).configureMinterAllowance(psmAddr, tinyAllowance)

            // Multiplier is 1.0 on a fresh chain, so OkuM minted == USDC × 1e12.
            expect(await chainA.okuMoney.okuMMultiplier(), "fresh chain is unrebased")
                .to.equal(WAD)

            // First mint ≤ allowance succeeds, and CONSUMES exactly its own amount.
            const smallUsdc = parseUnits("0.5", 6) // 0.5 USDC → 0.5 OkuM at 1:1
            const smallOkuM = smallUsdc * DECIMAL_MULTIPLIER
            await chainA.usdc.mint(aliceAddr, smallUsdc)
            await chainA.usdc.connect(alice).approve(psmAddr, smallUsdc)
            await chainA.psm.connect(alice).mintOkuM(smallUsdc)
            expect(await chainA.okuMoney.balanceOf(aliceAddr), "first mint lands in full")
                .to.equal(smallOkuM)
            expect(await chainA.okuMoney.minterAllowance(psmAddr), "allowance decremented by the mint")
                .to.equal(tinyAllowance - smallOkuM)

            // Second mint exceeds the remaining allowance → must revert with
            // ExceedsAllowance specifically. A bare `.to.be.reverted` here would
            // also pass on ExceedsSupplyCap, EnforcedPause or an ERC20 allowance
            // failure — several of which are plausible in this fixture, which is
            // exactly why the error has to be named.
            const bigUsdc = parseUnits("10", 6)
            await chainA.usdc.mint(aliceAddr, bigUsdc)
            await chainA.usdc.connect(alice).approve(psmAddr, bigUsdc)
            await expect(
                chainA.psm.connect(alice).mintOkuM(bigUsdc)
            ).to.be.revertedWithCustomError(chainA.okuMoney, "ExceedsAllowance")

            // The failed mint must be fully atomic — no partial credit, no
            // allowance consumed.
            expect(await chainA.okuMoney.balanceOf(aliceAddr), "failed mint credits nothing")
                .to.equal(smallOkuM)
            expect(await chainA.okuMoney.minterAllowance(psmAddr), "failed mint consumes no allowance")
                .to.equal(tinyAllowance - smallOkuM)

            // Rotate via OKUM_ALLOWANCE_MANAGER: restore allowance to 1000 OkuM
            const newAllowance = parseEther("1000")
            await chainA.okuMoney.connect(admin).configureMinterAllowance(psmAddr, newAllowance)

            // Mint resumes, for exactly the expected amount.
            await chainA.psm.connect(alice).mintOkuM(bigUsdc)
            expect(await chainA.okuMoney.balanceOf(aliceAddr), "mint resumes after allowance rotation")
                .to.equal(smallOkuM + bigUsdc * DECIMAL_MULTIPLIER)
        })
    })
})
