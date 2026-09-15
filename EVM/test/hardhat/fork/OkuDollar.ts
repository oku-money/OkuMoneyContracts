import {
    LitePSM,
    LitePSM__factory,
    OkuMoney,
    OkuMoney__factory,
    OkuDollar,
    OkuDollar__factory,
    RedemptionQueue,
    RedemptionQueue__factory,
    IERC20__factory
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { expect } from "chai"
import { getTokenAddress, getWhaleAddress } from "../../../scripts/config/chains"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

describe("OkuDollar Vault Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let psm: LitePSM
    let queue: RedemptionQueue
    let okuMoney: OkuMoney
    let okuUsd: OkuDollar

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
    const OKUM_BURNER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BURNER"))
    const QUEUE_PSM = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PSM"))
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"))
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const OKUM_PAUSER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_PAUSER"))
    const OKUM_UNPAUSER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_UNPAUSER"))
    const OKUM_BLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BLACKLISTER"))
    const OKUM_UNBLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_UNBLACKLISTER"))
    const OKUM_CAP_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_CAP_MANAGER"))
    const PSM_BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_WITHDRAWER"))
    const PSM_QUEUE_PROCESSOR = ethers.keccak256(ethers.toUtf8Bytes("PSM_QUEUE_PROCESSOR"))

    async function fundWithUSDC(user: Signer, amount: bigint) {
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale).transfer(await user.getAddress(), amount)
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })
    }

    async function getOkuMoney(user: Signer, usdcAmount: bigint) {
        // The PSM slippage check can fail due to integer division rounding.
        // At elevated prices, we need to round up the USDC input to the nearest
        // amount that divides evenly by the price to avoid 1 wei rounding loss.
        const currentPrice = await okuMoney.okuMMultiplier()
        const DECIMAL_MULT = 10n ** 12n // 6 to 18 decimal conversion
        
        // Calculate the minimum unit that divides evenly
        // At price 1.1e18, minimum unit is 1.1 USDC = 1100000 (6 decimals)
        // Round up usdcAmount to next multiple of this unit
        const unitSize = currentPrice / DECIMAL_MULT // In 6 decimal units
        const roundedAmount = ((usdcAmount + unitSize - 1n) / unitSize) * unitSize
        
        await fundWithUSDC(user, roundedAmount)
        await usdc.connect(user).approve(await psm.getAddress(), roundedAmount)
        await psm.connect(user).mintOkuM(roundedAmount)
    }

    before(async () => {
        // Reset network to initial fork state for test isolation
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com"
                }
            }]
        })

        const signers = await ethers.getSigners()
        Frank = signers[0]
        Bob = signers[1]
        Alice = signers[2]
        Charlie = signers[3]

        usdc = IERC20__factory.connect(USDC_MAINNET, Bob)

        await Frank.sendTransaction({
            to: USDC_WHALE,
            value: parseEther("10")
        })
    })

    before("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000")

        okuMoney = await upgrades.deployProxy(
            new OkuMoney__factory(Frank),
            ["OkuMoney", "OkuM", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuMoney
        await okuMoney.waitForDeployment()

        okuUsd = await upgrades.deployProxy(
            new OkuDollar__factory(Frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuDollar
        await okuUsd.waitForDeployment()

        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuMoney.getAddress(), USDC_MAINNET, frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [
                await okuMoney.getAddress(),
                await okuUsd.getAddress(),
                USDC_MAINNET,
                await queue.getAddress(),
                frankAddr
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        // OkuBridgeRouter was removed in the noBridge refactor; previously deployed here
        // but never exercised in this scenario suite.

        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuMoney.connect(Frank).grantRole(OKUM_ALLOWANCE_MANAGER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_REBASER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_PAUSER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_UNPAUSER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_BLACKLISTER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_UNBLACKLISTER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_CAP_MANAGER, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(PSM_BUFFER_WITHDRAWER, frankAddr)
        await psm.connect(Frank).grantRole(PSM_QUEUE_PROCESSOR, frankAddr)

        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(QUEUE_PSM, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await queue.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await queue.getAddress())
    })

    describe("Wrap/Unwrap Round-Trip", () => {
        it("Wrap OkuMoney and unwrap with minimal loss", async () => {
            const aliceAddr = await Alice.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuMoney via PSM
            await getOkuMoney(Alice, depositAmount)

            const noteBalance = await okuMoney.balanceOf(aliceAddr)
            expect(noteBalance).to.be.gt(0)

            // Wrap OkuMoney into OkuDollar vault
            await okuMoney.connect(Alice).approve(okuUsdAddr, noteBalance)
            const okuUsdBefore = await okuUsd.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).wrap(noteBalance, aliceAddr, 0)

            const okuUsdReceived = await okuUsd.balanceOf(aliceAddr)
            expect(okuUsdReceived).to.be.gt(okuUsdBefore)

            // Verify vault holds the notes
            const vaultNotes = await okuMoney.balanceOf(okuUsdAddr)
            const totalReserves = await okuUsd.totalOkuMReserves()
            expect(vaultNotes).to.equal(totalReserves)

            // Unwrap all OkuDollar immediately
            const notesBefore = await okuMoney.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(okuUsdReceived, aliceAddr)

            const notesAfter = await okuMoney.balanceOf(aliceAddr)
            const notesReturned = notesAfter - notesBefore

            // Should get back original note amount (± 1 wei rounding)
            expect(notesReturned).to.be.closeTo(noteBalance, 1n)

            // Vault should be empty
            expect(await okuUsd.totalOkuMReserves()).to.equal(0)
        })
    })

    describe("Exchange Rate After NotePrice Update", () => {
        it("NotePrice increase: unwrap returns fewer notes (price-aware), vault stays fully drained on full exit", async () => {
            const aliceAddr = await Alice.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuMoney via PSM
            await getOkuMoney(Alice, depositAmount)
            const noteBalance = await okuMoney.balanceOf(aliceAddr)

            // Wrap into vault
            await okuMoney.connect(Alice).approve(okuUsdAddr, noteBalance)
            await okuUsd.connect(Alice).wrap(noteBalance, aliceAddr, 0)

            const okuUsdBalance = await okuUsd.balanceOf(aliceAddr)

            // Record initial note reserves (raw token count)
            const initialReserves = await okuUsd.totalOkuMReserves()

            // Admin increases notePrice by 10% (non-rebasing: token counts don't change)
            const priceBefore = await okuMoney.okuMMultiplier()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).setOkuMMultiplier(newPrice)

            // Note reserves (raw token count) should be UNCHANGED
            const newReserves = await okuUsd.totalOkuMReserves()
            expect(newReserves).to.equal(initialReserves)

            // REMOVED: surplus() — single-multiplier refactor. OkuM and UsdOku share
            // one multiplier, so collateralization is exactly 1.0 by construction and
            // no surplus can accrue. The dollar value of reserves and of obligations
            // now move together.

            // Unwrap is multiplier-aware: okuMReturned = usdAmount × PRECISION / multiplier
            // After the multiplier increase, each raw note is worth more → fewer notes returned
            const notesBefore = await okuMoney.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(okuUsdBalance, aliceAddr)
            const notesAfter = await okuMoney.balanceOf(aliceAddr)
            const notesReturned = notesAfter - notesBefore

            // Expected: okuUsdBalance / 1.1 (the multiplier), which is what
            // OkuDollar._unwrap computes as
            // `mulDiv(usdAmount, PRECISION, mult, Floor)` — dollar-conserving.
            //
            // This previously read `(okuUsdBalance * usdMult) / newPrice`, a
            // leftover from the DUAL-multiplier era when `usdMultiplier` and
            // the note price were independent values. Under the
            // single-multiplier design `usdMultiplier()` just returns
            // `okuMoney.okuMMultiplier()` (OkuDollar.sol:191-193), so both
            // terms are now the SAME number and the formula degenerated to
            // `okuUsdBalance` — i.e. it asserted that unwrapping returns
            // dollar-for-dollar in RAW notes, which would inflate value by
            // the multiplier. The contract is correct here; the expectation
            // was stale.
            const PRECISION = parseEther("1")
            const expectedNotes = (okuUsdBalance * PRECISION) / newPrice
            expect(notesReturned).to.be.closeTo(expectedNotes, 1n)

            // The unwrap above used `okuUsdBalance`, which was captured BEFORE
            // the multiplier bump. A share balance is denominated in raw OkuM,
            // so a UsdOku *balance* grows with the multiplier: after the 10%
            // bump Alice's balance is `okuUsdBalance × 1.1`, and unwrapping
            // only the pre-bump figure is therefore a PARTIAL exit that leaves
            // ~9% of her shares in the vault. The previous assertion checked
            // for a drained vault at this point and only ever passed because
            // the stale formula above made the two errors cancel.
            //
            // Exit the remaining balance to make this a genuine full exit,
            // which is what the test name describes.
            const remainingUsdOku = await okuUsd.balanceOf(aliceAddr)
            expect(remainingUsdOku).to.be.gt(0n)
            await okuUsd.connect(Alice).unwrap(remainingUsdOku, aliceAddr)

            // Now the vault is genuinely empty. Tolerance is a few wei, not
            // exact zero: `_unwrap` deliberately floors the OkuM returned and
            // ceils the shares burned (both favour the vault), so a full exit
            // can leave sub-wei-scale dust behind by design.
            expect(await okuUsd.totalOkuMReserves()).to.be.closeTo(0n, 10n)
            expect(await okuUsd.balanceOf(aliceAddr)).to.be.closeTo(0n, 10n)
        })
    })

    describe("Multiple Depositors Share Accounting", () => {
        it("Multiple users share vault proportionally, unwrap returns dollar-for-dollar", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()

            // Different deposit amounts (1:2:3 ratio)
            const aliceDeposit = parseUnits("10000", 6)
            const bobDeposit = parseUnits("20000", 6)
            const charlieDeposit = parseUnits("30000", 6)

            // Record note balances before PSM minting (may have from previous tests)
            const aliceNotesPreMint = await okuMoney.balanceOf(aliceAddr)
            const bobNotesPreMint = await okuMoney.balanceOf(bobAddr)
            const charlieNotesPreMint = await okuMoney.balanceOf(charlieAddr)

            // All users get OkuMoney (price-aware: amount depends on current notePrice)
            await getOkuMoney(Alice, aliceDeposit)
            await getOkuMoney(Bob, bobDeposit)
            await getOkuMoney(Charlie, charlieDeposit)

            // Use actual minted amounts (price-aware, not hardcoded)
            const aliceNotes = (await okuMoney.balanceOf(aliceAddr)) - aliceNotesPreMint
            const bobNotes = (await okuMoney.balanceOf(bobAddr)) - bobNotesPreMint
            const charlieNotes = (await okuMoney.balanceOf(charlieAddr)) - charlieNotesPreMint

            // Record initial OkuDollar balances (may have from previous tests)
            const aliceUsdBefore = await okuUsd.balanceOf(aliceAddr)
            const bobUsdBefore = await okuUsd.balanceOf(bobAddr)
            const charlieUsdBefore = await okuUsd.balanceOf(charlieAddr)

            await okuMoney.connect(Alice).approve(okuUsdAddr, aliceNotes)
            await okuMoney.connect(Bob).approve(okuUsdAddr, bobNotes)
            await okuMoney.connect(Charlie).approve(okuUsdAddr, charlieNotes)

            await okuUsd.connect(Alice).wrap(aliceNotes, aliceAddr, 0)
            await okuUsd.connect(Bob).wrap(bobNotes, bobAddr, 0)
            await okuUsd.connect(Charlie).wrap(charlieNotes, charlieAddr, 0)

            // Calculate OkuDollar gained in this test only
            const aliceUsdGained = (await okuUsd.balanceOf(aliceAddr)) - aliceUsdBefore
            const bobUsdGained = (await okuUsd.balanceOf(bobAddr)) - bobUsdBefore
            const charlieUsdGained = (await okuUsd.balanceOf(charlieAddr)) - charlieUsdBefore

            // Verify proportional OkuDollar received (1:2:3 ratio approximately)
            expect(bobUsdGained).to.be.closeTo(aliceUsdGained * 2n, aliceUsdGained / 10n)
            expect(charlieUsdGained).to.be.closeTo(aliceUsdGained * 3n, aliceUsdGained / 10n)

            // Admin increases notePrice by 10%. Collateralization stays exactly 1.0
            // under the single-multiplier design (no surplus() to check).
            const priceBefore = await okuMoney.okuMMultiplier()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).setOkuMMultiplier(newPrice)

            // Users unwrap their gained OkuDollar in reverse order.
            // Unwrap is multiplier-aware: okuMReturned = usdAmount × PRECISION / multiplier
            // After the multiplier increase, each user gets FEWER raw notes
            // back (each note is worth more).
            const currentPrice = await okuMoney.okuMMultiplier()

            const charlieNotesBefore = await okuMoney.balanceOf(charlieAddr)
            await okuUsd.connect(Charlie).unwrap(charlieUsdGained, charlieAddr)
            const charlieReceived = (await okuMoney.balanceOf(charlieAddr)) - charlieNotesBefore

            const bobNotesBefore = await okuMoney.balanceOf(bobAddr)
            await okuUsd.connect(Bob).unwrap(bobUsdGained, bobAddr)
            const bobReceived = (await okuMoney.balanceOf(bobAddr)) - bobNotesBefore

            const aliceNotesBefore = await okuMoney.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(aliceUsdGained, aliceAddr)
            const aliceReceived = (await okuMoney.balanceOf(aliceAddr)) - aliceNotesBefore

            // Each user receives notes = usdGained × PRECISION / multiplier —
            // dollar-conserving, matching OkuDollar._unwrap's
            // `mulDiv(usdAmount, PRECISION, mult, Floor)`. See the detailed
            // note in the "NotePrice increase" test above for why the old
            // `× usdMultiplier / notePrice` form was a stale dual-multiplier
            // leftover that degenerated to an identity.
            const PRECISION = parseEther("1")
            const expectedAlice = (aliceUsdGained * PRECISION) / currentPrice
            const expectedBob = (bobUsdGained * PRECISION) / currentPrice
            const expectedCharlie = (charlieUsdGained * PRECISION) / currentPrice
            expect(aliceReceived).to.be.closeTo(expectedAlice, 1n)
            expect(bobReceived).to.be.closeTo(expectedBob, 1n)
            expect(charlieReceived).to.be.closeTo(expectedCharlie, 1n)
        })
    })
})
