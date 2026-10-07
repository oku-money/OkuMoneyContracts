import {
    LitePSM,
    LitePSM__factory,
    OkuMoney,
    OkuMoney__factory,
    OkuDollar,
    OkuDollar__factory,
    IERC20__factory
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { resetMainnetFork } from "../helpers/fork"
import { expect } from "chai"
import { getTokenAddress, getWhaleAddress } from "../../../scripts/config/chains"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

const WAD_1E18 = 10n ** 18n
/** USDC is 6-decimal; OkuM is 18. */
const DECIMAL_MULT_6_TO_18 = 10n ** 12n

describe("OkuMoney Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let psm: LitePSM
    let okuMoney: OkuMoney
    let okuUsd: OkuDollar

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
    const OKUM_BURNER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BURNER"))
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"))
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const OKUM_PAUSER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_PAUSER"))
    const OKUM_UNPAUSER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_UNPAUSER"))
    const OKUM_BLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BLACKLISTER"))
    const OKUM_UNBLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_UNBLACKLISTER"))
    const OKUM_CAP_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_CAP_MANAGER"))
    const PSM_BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_WITHDRAWER"))

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

    /** Mint OkuM for `user` by depositing exactly `usdcAmount` (LitePSM has no slippage parameter). */
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

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            // initialize(_okuMoney, _okuDollar, _usdc, admin)
            [
                await okuMoney.getAddress(),
                await okuUsd.getAddress(),
                USDC_MAINNET,
                frankAddr
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

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

        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
    })

    describe("User-to-User Transfers", () => {
        it("Transfers work correctly and balances are unaffected by notePrice update", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuMoney via PSM
            await getOkuMoney(Alice, depositAmount)
            const aliceInitialBalance = await okuMoney.balanceOf(aliceAddr)

            // Alice transfers 5,000 OkuMoney to Bob (OkuMoney is 18 decimals).
            // The standard `Transfer` event carries the raw amount (there is no
            // dollar-value event); dollar value is checked via `balanceOfUI()`,
            // the ERC-8056 surface.
            const transferAmount = parseEther("5000")
            const priceAtTransfer = await okuMoney.okuMMultiplier()
            const PRECISION = parseEther("1")
            const expectedDollarValue = (transferAmount * priceAtTransfer) / PRECISION

            await expect(okuMoney.connect(Alice).transfer(bobAddr, transferAmount))
                .to.emit(okuMoney, "Transfer")
                .withArgs(aliceAddr, bobAddr, transferAmount)

            const aliceAfterTransfer = await okuMoney.balanceOf(aliceAddr)
            const bobAfterTransfer = await okuMoney.balanceOf(bobAddr)

            // Dollar value of what Bob received matches the raw amount valued
            // at the multiplier in force at transfer time.
            expect(await okuMoney.balanceOfUI(bobAddr)).to.be.closeTo(expectedDollarValue, parseEther("1"))

            // Verify balances (allowing for small rounding)
            expect(aliceAfterTransfer).to.be.closeTo(aliceInitialBalance - transferAmount, parseEther("1"))
            expect(bobAfterTransfer).to.be.closeTo(transferAmount, parseEther("1"))

            // Record balances before notePrice update
            const aliceBeforeUpdate = await okuMoney.balanceOf(aliceAddr)
            const bobBeforeUpdate = await okuMoney.balanceOf(bobAddr)

            // Admin performs 10% notePrice increase (non-rebasing: balances do NOT change)
            const priceBefore = await okuMoney.okuMMultiplier()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).setOkuMMultiplier(newPrice)

            // Verify notePrice increased
            expect(await okuMoney.okuMMultiplier()).to.equal(newPrice)

            // Balances should be UNCHANGED (non-rebasing)
            const aliceAfterUpdate = await okuMoney.balanceOf(aliceAddr)
            const bobAfterUpdate = await okuMoney.balanceOf(bobAddr)

            expect(aliceAfterUpdate).to.equal(aliceBeforeUpdate)
            expect(bobAfterUpdate).to.equal(bobBeforeUpdate)

            // Bob transfers back to Alice
            await okuMoney.connect(Bob).transfer(aliceAddr, bobAfterUpdate)

            const aliceFinal = await okuMoney.balanceOf(aliceAddr)
            const bobFinal = await okuMoney.balanceOf(bobAddr)

            // Alice should have her original balance back (no rebase growth)
            expect(aliceFinal).to.be.closeTo(aliceInitialBalance, parseEther("1"))
            expect(bobFinal).to.be.closeTo(0n, parseEther("1"))
        })
    })

    describe("Minter Allowance Exhaustion", () => {
        it("PSM cannot mint beyond allowance, admin can reset", async () => {
            const aliceAddr = await Alice.getAddress()
            const psmAddr = await psm.getAddress()

            // Set PSM minter allowance to limited amount (50,000 OkuMoney in 18 decimals)
            const limitedAllowance = parseEther("50000")
            await okuMoney.connect(Frank).configureMinterAllowance(psmAddr, limitedAllowance)

            // Verify allowance was set
            expect(await okuMoney.minterAllowance(psmAddr)).to.equal(limitedAllowance)

            // Alice swaps 40,000 USDC. No rounding games: `LitePSM` has no
            // slippage check to dodge, and rounding the input to a multiple of
            // the multiplier only served to make the expectation below look
            // exact while re-deriving the contract's own formula.
            //
            // The allowance decrement is measured directly rather than predicted,
            // and then checked against the MINT that actually landed -- so the
            // assertion is "the allowance fell by exactly what was minted", a
            // conservation property, not a restatement of `dollarsToOkuM`.
            const firstSwap = parseUnits("40000", 6)
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(psmAddr, firstSwap)
            const aliceBeforeFirst = await okuMoney.balanceOf(aliceAddr)
            await psm.connect(Alice).mintOkuM(firstSwap)
            const expectedFirstMint = (await okuMoney.balanceOf(aliceAddr)) - aliceBeforeFirst

            const remainingAllowance = await okuMoney.minterAllowance(psmAddr)
            expect(remainingAllowance, "allowance falls by exactly the amount minted")
                .to.equal(limitedAllowance - expectedFirstMint)

            // Alice tries to swap 20,000 more USDC (should fail - exceeds remaining allowance)
            const secondSwap = parseUnits("20000", 6)
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(psmAddr, secondSwap)
            await expect(psm.connect(Alice).mintOkuM(secondSwap)).to.be.revertedWithCustomError(okuMoney, "ExceedsAllowance")

            // Admin resets allowance
            const newAllowance = parseEther("100000")
            await okuMoney.connect(Frank).configureMinterAllowance(psmAddr, newAllowance)

            // Now swap should succeed
            const aliceAfterFirst = await okuMoney.balanceOf(aliceAddr)
            await psm.connect(Alice).mintOkuM(secondSwap)

            // Alice received OkuMoney from both swaps. Measured as a DELTA from
            // before the second mint, so the assertion is exact rather than a
            // `gte` hedged against balance carried in from earlier tests.
            const expectedSecondMint = (await okuMoney.balanceOf(aliceAddr)) - aliceAfterFirst
            expect(expectedSecondMint, "second mint is 20k/40k the size of the first")
                .to.be.closeTo(expectedFirstMint / 2n, 1n)
            expect(await okuMoney.minterAllowance(psmAddr), "allowance falls by the second mint")
                .to.equal(newAllowance - expectedSecondMint)
        })
    })

    describe("Max Supply Cap", () => {
        it("Minting fails at cap, admin can increase", async () => {
            const frankAddr = await Frank.getAddress()
            const aliceAddr = await Alice.getAddress()

            // Deploy fresh contracts with LOW maxSupply (100,000 OkuMoney in 18 decimals)
            const lowMaxSupply = parseEther("100000")

            const freshOkuMoney = await upgrades.deployProxy(
                new OkuMoney__factory(Frank),
                ["OkuMoney-Low", "OKUM-L", frankAddr, lowMaxSupply],
                { kind: "uups" }
            ) as unknown as OkuMoney
            await freshOkuMoney.waitForDeployment()

            const freshOkuUsd = await upgrades.deployProxy(
                new OkuDollar__factory(Frank),
                [await freshOkuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr],
                { kind: "uups", unsafeAllow: ["constructor"] }
            ) as unknown as OkuDollar
            await freshOkuUsd.waitForDeployment()

            const freshPSM = await upgrades.deployProxy(
                new LitePSM__factory(Frank),
                [
                    await freshOkuMoney.getAddress(),
                    await freshOkuUsd.getAddress(),
                    USDC_MAINNET,
                    frankAddr
                ],
                { kind: "uups", unsafeAllow: ["constructor"] }
            ) as unknown as LitePSM
            await freshPSM.waitForDeployment()

            // Grant PSM minter role with HIGH allowance (1B in 18 decimals)
            await freshOkuMoney.connect(Frank).grantRole(OKUM_MINTER, await freshPSM.getAddress())
            await freshOkuMoney.connect(Frank).grantRole(OKUM_BURNER, await freshPSM.getAddress())

            // Grant RBAC roles to Frank for fresh contracts
            await freshOkuMoney.connect(Frank).grantRole(OKUM_ALLOWANCE_MANAGER, frankAddr)
            await freshOkuMoney.connect(Frank).grantRole(OKUM_CAP_MANAGER, frankAddr)

            await freshOkuMoney.connect(Frank).configureMinterAllowance(
                await freshPSM.getAddress(),
                parseEther("1000000000")
            )

            // Alice swaps 80,000 USDC (should succeed - under 100k cap, receives 80,000 OkuMoney)
            const firstSwap = parseUnits("80000", 6) // USDC amount
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), firstSwap)
            await freshPSM.connect(Alice).mintOkuM(firstSwap)

            expect(await freshOkuMoney.balanceOf(aliceAddr)).to.be.closeTo(parseEther("80000"), parseEther("1"))

            // Alice tries to swap 30,000 more USDC (should fail - would exceed 100k OkuMoney cap)
            const secondSwap = parseUnits("30000", 6) // USDC amount
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), secondSwap)
            await expect(freshPSM.connect(Alice).mintOkuM(secondSwap)).to.be.revertedWithCustomError(freshOkuMoney, "ExceedsSupplyCap")

            // Admin increases maxSupply
            const newMaxSupply = parseEther("200000")
            await freshOkuMoney.connect(Frank).setMaxSupply(newMaxSupply)

            // Now swap should succeed
            await freshPSM.connect(Alice).mintOkuM(secondSwap)

            // Alice should have ~110,000 OkuMoney (in 18 decimals)
            const aliceBalance = await freshOkuMoney.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.closeTo(parseEther("110000"), parseEther("1"))
        })
    })

    describe("Access Control / Safety", () => {
        before(async () => {
            // Reset minter allowance for PSM (may have been consumed by earlier tests)
            await okuMoney.connect(Frank).configureMinterAllowance(
                await psm.getAddress(),
                parseEther("1000000000")
            )
        })

        it("Pause/unpause blocks and allows transfers", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuMoney via PSM
            const aliceBeforeMint = await okuMoney.balanceOf(aliceAddr)
            await getOkuMoney(Alice, depositAmount)
            const aliceBalance = await okuMoney.balanceOf(aliceAddr)
            // 10,000 USDC at the current multiplier, measured as a delta so the
            // state carried in from earlier `it()` blocks cannot hide a bad mint.
            const mult = await okuMoney.okuMMultiplier()
            expect(aliceBalance - aliceBeforeMint, "mint credits the exact converted amount")
                .to.equal((depositAmount * DECIMAL_MULT_6_TO_18 * WAD_1E18) / mult)

            // Transfer works before pause.
            //
            // Asserted as a DELTA against Bob's balance captured immediately
            // before this transfer, not as an absolute. Contracts in this
            // file are deployed once in a top-level `before` hook and state
            // persists across every `it()`, so Bob already holds 5,000 OkuM
            // from the "User-to-User Transfers" test above. The previous
            // absolute assertion (`closeTo(transferAmount)`) only passed when
            // this test ran in isolation and broke as soon as the file ran as
            // a whole — an ordering dependency, not a real behavioural check.
            const transferAmount = parseEther("1000")
            const bobBeforeTransfer = await okuMoney.balanceOf(bobAddr)
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuMoney.balanceOf(bobAddr)).to.be.closeTo(
                bobBeforeTransfer + transferAmount,
                parseEther("1")
            )

            // Frank (admin) pauses the contract
            await okuMoney.connect(Frank).pause()

            // Transfer should fail when paused
            await expect(
                okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuMoney, "EnforcedPause")

            // TransferFrom should also fail when paused
            await okuMoney.connect(Alice).approve(bobAddr, transferAmount)
            await expect(
                okuMoney.connect(Bob).transferFrom(aliceAddr, bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuMoney, "EnforcedPause")

            // Minting via PSM must fail when paused. No input alignment needed --
            // there is no slippage check to get past, only the pause gate.
            await fundWithUSDC(Alice, depositAmount)
            await usdc.connect(Alice).approve(await psm.getAddress(), depositAmount)
            await expect(
                psm.connect(Alice).mintOkuM(depositAmount)
            ).to.be.revertedWithCustomError(okuMoney, "EnforcedPause")

            // Frank unpause
            await okuMoney.connect(Frank).unpause()

            // Transfer works again after unpause (asserted as a balance delta).
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuMoney.balanceOf(bobAddr), "second transfer lands in full")
                .to.equal(bobBeforeTransfer + transferAmount * 2n)
        })

        it("Blacklisted addresses cannot send or receive", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // All users get OkuMoney
            await getOkuMoney(Alice, depositAmount)
            await getOkuMoney(Bob, depositAmount)
            await getOkuMoney(Charlie, depositAmount)

            const transferAmount = parseEther("1000")

            // Normal transfer works
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)

            // Frank blacklists Bob
            await okuMoney.connect(Frank).blacklist(bobAddr)
            expect(await okuMoney.isBlacklisted(bobAddr)).to.equal(true)

            // Bob cannot SEND (blacklisted sender)
            await expect(
                okuMoney.connect(Bob).transfer(charlieAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuMoney, "SenderBlacklisted")

            // Bob cannot RECEIVE (blacklisted recipient)
            await expect(
                okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuMoney, "RecipientBlacklisted")

            // Bob cannot receive via transferFrom either
            await okuMoney.connect(Charlie).approve(aliceAddr, transferAmount)
            await expect(
                okuMoney.connect(Alice).transferFrom(charlieAddr, bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuMoney, "RecipientBlacklisted")

            // Frank unblacklists Bob
            await okuMoney.connect(Frank).unblacklist(bobAddr)
            expect(await okuMoney.isBlacklisted(bobAddr)).to.equal(false)

            // Bob can send again. The previous version made both calls with NO
            // assertions, so it only proved "does not throw" -- it would have
            // passed even if the transfers moved nothing.
            const bobBeforeResume = await okuMoney.balanceOf(bobAddr)
            const charlieBeforeResume = await okuMoney.balanceOf(charlieAddr)
            await okuMoney.connect(Bob).transfer(charlieAddr, transferAmount)
            expect(await okuMoney.balanceOf(bobAddr), "un-blacklisted Bob can send")
                .to.equal(bobBeforeResume - transferAmount)
            expect(await okuMoney.balanceOf(charlieAddr), "Charlie receives it")
                .to.equal(charlieBeforeResume + transferAmount)

            // Bob can receive again
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuMoney.balanceOf(bobAddr), "un-blacklisted Bob can receive")
                .to.equal(bobBeforeResume)
        })

        it("Blacklist works while paused (pause-to-blacklist protocol)", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Setup: Alice gets OkuMoney
            await getOkuMoney(Alice, depositAmount)
            const aliceBalance = await okuMoney.balanceOf(aliceAddr)

            // STEP 1: Pause the contract (freeze all transfers)
            await okuMoney.connect(Frank).pause()

            // Verify transfers are blocked
            await expect(
                okuMoney.connect(Alice).transfer(bobAddr, parseEther("100"))
            ).to.be.revertedWithCustomError(okuMoney, "EnforcedPause")

            // STEP 2: Blacklist Alice while paused (CRITICAL - must work)
            await okuMoney.connect(Frank).blacklist(aliceAddr)
            expect(await okuMoney.isBlacklisted(aliceAddr)).to.equal(true)

            // STEP 3: Unpause the contract
            await okuMoney.connect(Frank).unpause()

            // Alice still cannot send (blacklisted)
            await expect(
                okuMoney.connect(Alice).transfer(bobAddr, parseEther("100"))
            ).to.be.revertedWithCustomError(okuMoney, "SenderBlacklisted")

            // Alice still cannot receive
            await getOkuMoney(Bob, depositAmount)
            await expect(
                okuMoney.connect(Bob).transfer(aliceAddr, parseEther("100"))
            ).to.be.revertedWithCustomError(okuMoney, "RecipientBlacklisted")

            // Verify Alice's balance is frozen (still has funds, just can't move them)
            expect(await okuMoney.balanceOf(aliceAddr)).to.be.closeTo(aliceBalance, parseEther("1"))

            // Cleanup: unblacklist Alice for other tests
            await okuMoney.connect(Frank).unblacklist(aliceAddr)
        })
    })
})
