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
import { resetMainnetFork } from "../helpers/fork"
import { expect } from "chai"
import { getTokenAddress, getWhaleAddress } from "../../../scripts/config/chains"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

const WAD = 10n ** 18n
/** USDC is 6-decimal; OkuM is 18. */
const DECIMAL_MULTIPLIER = 10n ** 12n


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

    /**
     * Mint OkuM for `user` by depositing exactly `usdcAmount`.
     *
     * The previous version rounded the input up to a multiple of the multiplier
     * to dodge "the PSM slippage check". No such check exists -- `LitePSM` has
     * no slippage parameter by design, and the two checks that once looked like
     * one were removed as unreachable. The rounding only served to make the
     * resulting OkuM amount divide evenly, which is what let several assertions
     * downstream look exact while actually re-deriving the contract's formula.
     */
    async function getOkuMoney(user: Signer, usdcAmount: bigint) {
        await fundWithUSDC(user, usdcAmount)
        await usdc.connect(user).approve(await psm.getAddress(), usdcAmount)
        await psm.connect(user).mintOkuM(usdcAmount)
    }

    before(async () => {
        // Reset network to initial fork state for test isolation
        await resetMainnetFork()

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
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await queue.getAddress())
    })

    describe("Wrap/Unwrap Round-Trip", () => {
        it("Wrap OkuMoney and unwrap with minimal loss", async () => {
            const aliceAddr = await Alice.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuMoney via PSM
            await getOkuMoney(Alice, depositAmount)

            // Multiplier is 1.0 on a fresh deployment, so 10,000 USDC buys
            // exactly 10,000e18 OkuM (6 -> 18 decimal scaling, no rebasing yet).
            const mult = await okuMoney.okuMMultiplier()
            expect(mult, "fixture: deployment must be unrebased").to.equal(WAD)
            const noteBalance = await okuMoney.balanceOf(aliceAddr)
            expect(noteBalance, "10,000 USDC mints 10,000 OkuM at m = 1.0")
                .to.equal(depositAmount * DECIMAL_MULTIPLIER)

            // Wrap OkuMoney into OkuDollar vault
            await okuMoney.connect(Alice).approve(okuUsdAddr, noteBalance)
            const okuUsdBefore = await okuUsd.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).wrap(noteBalance, aliceAddr, 0)

            // At m == PRECISION a wrapped OkuM is worth exactly one dollar.
            const okuUsdReceived = (await okuUsd.balanceOf(aliceAddr)) - okuUsdBefore
            expect(okuUsdReceived, "wrap mints dollar-for-dollar at m = 1.0").to.equal(noteBalance)

            // The vault must actually have ESCROWED what Alice sent. Comparing
            // `totalOkuMReserves()` against `okuMoney.balanceOf(vault)` would be
            // comparing a value to itself -- the getter is literally that call
            // (`OkuDollar.sol:741`) -- so it is checked against the deposit instead.
            expect(await okuMoney.balanceOf(okuUsdAddr), "vault escrowed Alice's notes")
                .to.equal(noteBalance)
            expect(await okuUsd.totalOkuMReserves(), "reserves view agrees with the escrow")
                .to.equal(noteBalance)

            // Unwrap all OkuDollar immediately
            const notesBefore = await okuMoney.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(okuUsdReceived, aliceAddr)

            const notesReturned = (await okuMoney.balanceOf(aliceAddr)) - notesBefore

            // Full exit at an unchanged multiplier returns the original notes
            // exactly -- `unwrap` ceils the share burn, but with m == PRECISION
            // there is no fractional part to round.
            expect(notesReturned, "round-trip at m = 1.0 is lossless").to.equal(noteBalance)

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

            // Expected value derived from the SCENARIO, not from `_unwrap`.
            //
            // Alice wrapped `noteBalance` raw notes at m = 1.0, so she holds
            // exactly that many shares. The multiplier then rose 10%. Unwrapping
            // the PRE-bump dollar figure `okuUsdBalance` (== noteBalance) buys
            // back only 1/1.1 of those notes, because each note is now worth 1.1
            // dollars. So: noteBalance × 100 / 110.
            //
            // The previous version asserted `(okuUsdBalance * PRECISION) / newPrice`,
            // which is a transcription of `_unwrap`'s own
            // `mulDiv(usdAmount, PRECISION, mult, Floor)` -- it would have passed
            // for any self-consistent unwrap formula, including a wrong one.
            const expectedNotes = (noteBalance * 100n) / 110n
            expect(notesReturned, "partial exit returns notes/1.1 after a 10% bump")
                .to.be.closeTo(expectedNotes, 1n)

            // The unwrap above used `okuUsdBalance`, captured BEFORE the bump. A
            // UsdOku balance is denominated in raw OkuM, so it grows with the
            // multiplier: Alice's balance is now `okuUsdBalance × 1.1`, and
            // unwrapping only the pre-bump figure is a PARTIAL exit leaving ~9%
            // of her shares behind. An earlier version asserted a drained vault
            // here and passed only because two errors cancelled.
            const remainingUsdOku = await okuUsd.balanceOf(aliceAddr)
            // Derived: she entered with `noteBalance` shares and has burned
            // `expectedNotes` of them; the remainder is priced at the new multiplier.
            const expectedRemaining = ((noteBalance - expectedNotes) * newPrice) / WAD
            expect(remainingUsdOku, "partial exit leaves the un-burned shares")
                .to.be.closeTo(expectedRemaining, 2n)
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

            // The deposits are exact 1:2:3 multiples, so the shares are too --
            // up to the floor in `dollarsToOkuM`. Each mint floors independently,
            // and `floor(k·x/m)` can exceed `k·floor(x/m)` by at most `k-1` wei,
            // so the tolerances below are k-1, not a round number.
            //
            // The previous version allowed ±10% OF ALICE'S POSITION, which would
            // have accepted a vault mispricing Bob by 9%. These bounds are ~21
            // orders of magnitude tighter and are derived, not observed.
            expect(bobUsdGained, "Bob deposited 2x Alice").to.be.closeTo(aliceUsdGained * 2n, 1n)
            expect(charlieUsdGained, "Charlie deposited 3x Alice")
                .to.be.closeTo(aliceUsdGained * 3n, 2n)

            // Admin increases notePrice by 10%. Collateralization stays exactly 1.0
            // under the single-multiplier design (no surplus() to check).
            const priceBefore = await okuMoney.okuMMultiplier()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).setOkuMMultiplier(newPrice)

            // Users unwrap their gained OkuDollar in reverse order. After a 10%
            // multiplier increase each user gets FEWER raw notes back, because
            // each note is now worth more.
            //
            // `newPrice` is the test's OWN number, not a value read back from the
            // contract. The previous version re-read `okuMMultiplier()` here, so
            // a silently no-op `setOkuMMultiplier` would still have satisfied all
            // three assertions below -- in a test whose whole purpose is to verify
            // multiplier-aware unwrap.
            expect(await okuMoney.okuMMultiplier(), "the bump must have landed")
                .to.equal(newPrice)

            const charlieNotesBefore = await okuMoney.balanceOf(charlieAddr)
            await okuUsd.connect(Charlie).unwrap(charlieUsdGained, charlieAddr)
            const charlieReceived = (await okuMoney.balanceOf(charlieAddr)) - charlieNotesBefore

            const bobNotesBefore = await okuMoney.balanceOf(bobAddr)
            await okuUsd.connect(Bob).unwrap(bobUsdGained, bobAddr)
            const bobReceived = (await okuMoney.balanceOf(bobAddr)) - bobNotesBefore

            const aliceNotesBefore = await okuMoney.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(aliceUsdGained, aliceAddr)
            const aliceReceived = (await okuMoney.balanceOf(aliceAddr)) - aliceNotesBefore

            // Each user wrapped at m = 1.0 and exits a PRE-bump dollar figure
            // after a +10% bump, so each buys back 1/1.1 of the notes they put
            // in: notes × 100 / 110. Derived from the scenario's own 10% step,
            // not transcribed from `_unwrap`.
            const expectedAlice = (aliceNotes * 100n) / 110n
            const expectedBob = (bobNotes * 100n) / 110n
            const expectedCharlie = (charlieNotes * 100n) / 110n
            expect(aliceReceived).to.be.closeTo(expectedAlice, 1n)
            expect(bobReceived).to.be.closeTo(expectedBob, 1n)
            expect(charlieReceived).to.be.closeTo(expectedCharlie, 1n)
        })
    })
})
