import {
    LitePSM,
    LitePSM__factory,
    OkuBridgeRouter,
    OkuBridgeRouter__factory,
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
import { getTokenAddress, getWhaleAddress } from "../../../config/config"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

describe("OkuNote Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let okuBridgeRouter: OkuBridgeRouter
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuMoney: OkuNote
    let okuUsd: OkuUSD

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
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

    async function getOkuNote(user: Signer, usdcAmount: bigint) {
        // The PSM slippage check can fail due to integer division rounding.
        // At elevated prices, we need to round up the USDC input to the nearest
        // amount that divides evenly by the price to avoid 1 wei rounding loss.
        // 
        // For price P (18 decimals), we need: (U * 1e18) % P == 0
        // This means: U must be a multiple of P / gcd(1e18, P)
        // 
        // Simpler approach: add enough buffer that even with 1 wei loss, check passes.
        // Since check is output >= input, and loss is at most (price-1) wei at 18 decimals,
        // we need input to be a multiple of price/1e18 (rounded up).
        const currentPrice = await okuMoney.okuMPrice()
        const PRECISION = parseEther("1")
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
        // No blockNumber pin: non-archival public nodes prune old state
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: process.env.MAINNET_RPC_URL
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
        ) as unknown as OkuNote
        await okuMoney.waitForDeployment()

        okuUsd = await upgrades.deployProxy(
            new OkuDollar__factory(Frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr, parseEther("0.95")],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuUSD
        await okuUsd.waitForDeployment()

        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuMoney.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuMoney.getAddress(), await okuUsd.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        okuBridgeRouter = await upgrades.deployProxy(
            new OkuBridgeRouter__factory(Frank),
            [await okuUsd.getAddress(), await okuMoney.getAddress(), frankAddr, frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuBridgeRouter
        await okuBridgeRouter.waitForDeployment()

        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await psm.getAddress())

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
    })

    describe("User-to-User Transfers", () => {
        it("Transfers work correctly and balances are unaffected by notePrice update", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuMoney via PSM
            await getOkuNote(Alice, depositAmount)
            const aliceInitialBalance = await okuMoney.balanceOf(aliceAddr)

            // Alice transfers 5,000 OkuMoney to Bob (OkuNote is 18 decimals)
            const transferAmount = parseEther("5000")
            const priceAtTransfer = await okuMoney.okuMPrice()
            const PRECISION = parseEther("1")
            const expectedDollarValue = (transferAmount * priceAtTransfer) / PRECISION
            await expect(okuMoney.connect(Alice).transfer(bobAddr, transferAmount))
                .to.emit(okuMoney, "TransferValue")
                .withArgs(aliceAddr, bobAddr, transferAmount, expectedDollarValue)

            const aliceAfterTransfer = await okuMoney.balanceOf(aliceAddr)
            const bobAfterTransfer = await okuMoney.balanceOf(bobAddr)

            // Verify balances (allowing for small rounding)
            expect(aliceAfterTransfer).to.be.closeTo(aliceInitialBalance - transferAmount, parseEther("1"))
            expect(bobAfterTransfer).to.be.closeTo(transferAmount, parseEther("1"))

            // Record balances before notePrice update
            const aliceBeforeUpdate = await okuMoney.balanceOf(aliceAddr)
            const bobBeforeUpdate = await okuMoney.balanceOf(bobAddr)

            // Admin performs 10% notePrice increase (non-rebasing: balances do NOT change)
            const priceBefore = await okuMoney.okuMPrice()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).setOkuMPrice(newPrice)

            // Verify notePrice increased
            expect(await okuMoney.okuMPrice()).to.equal(newPrice)

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
            const PRECISION = parseEther("1")

            // Get current notePrice (may be elevated from earlier tests)
            const currentPrice = await okuMoney.okuMPrice()

            // Set PSM minter allowance to limited amount (50,000 OkuMoney in 18 decimals)
            const limitedAllowance = parseEther("50000")
            await okuMoney.connect(Frank).configureMinterAllowance(psmAddr, limitedAllowance)

            // Verify allowance was set
            expect(await okuMoney.minterAllowance(psmAddr)).to.equal(limitedAllowance)

            // Alice swaps 40,000 USDC — price-aware: noteAmount = usdcValue18 × PRECISION / notePrice
            // Round up to nearest multiple of price to avoid slippage check failure
            const DECIMAL_MULT = 10n ** 12n
            const unitSize = currentPrice / DECIMAL_MULT
            const firstSwapBase = parseUnits("40000", 6) // USDC amount
            const firstSwap = ((firstSwapBase + unitSize - 1n) / unitSize) * unitSize
            const firstSwap18 = firstSwap * DECIMAL_MULT
            const expectedFirstMint = (firstSwap18 * PRECISION) / currentPrice
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(psmAddr, firstSwap)
            await psm.connect(Alice).mintOkuM(firstSwap)

            // Verify allowance decreased by price-adjusted OkuMoney amount minted
            const remainingAllowance = await okuMoney.minterAllowance(psmAddr)
            const expectedRemaining = limitedAllowance - expectedFirstMint
            expect(remainingAllowance).to.be.closeTo(expectedRemaining, parseEther("1"))

            // Alice tries to swap 20,000 more USDC (should fail - exceeds remaining allowance)
            // Round up to nearest multiple of price to avoid slippage check failure
            const secondSwapBase = parseUnits("20000", 6) // USDC amount
            const secondSwap = ((secondSwapBase + unitSize - 1n) / unitSize) * unitSize
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(psmAddr, secondSwap)
            await expect(psm.connect(Alice).mintOkuM(secondSwap)).to.be.revertedWithCustomError(okuMoney, "ExceedsAllowance")

            // Admin resets allowance
            const newAllowance = parseEther("100000")
            await okuMoney.connect(Frank).configureMinterAllowance(psmAddr, newAllowance)

            // Now swap should succeed
            await psm.connect(Alice).mintOkuM(secondSwap)

            // Verify Alice received OkuMoney from both swaps
            const aliceBalance = await okuMoney.balanceOf(aliceAddr)
            const secondSwap18 = secondSwap * 10n ** 12n
            const expectedSecondMint = (secondSwap18 * PRECISION) / currentPrice
            // Alice may have balance from earlier tests, just verify she got at least both mints
            expect(aliceBalance).to.be.gte(expectedFirstMint + expectedSecondMint)
        })
    })

    describe("Max Supply Cap", () => {
        it("Minting fails at cap, admin can increase", async () => {
            const frankAddr = await Frank.getAddress()
            const aliceAddr = await Alice.getAddress()

            // Deploy fresh contracts with LOW maxSupply (100,000 OkuMoney in 18 decimals)
            const lowMaxSupply = parseEther("100000")

            const freshOkuNote = await upgrades.deployProxy(
                new OkuMoney__factory(Frank),
                ["OkuNote-Low", "OKUNOTE-L", frankAddr, lowMaxSupply],
                { kind: "uups" }
            ) as unknown as OkuNote
            await freshOkuNote.waitForDeployment()

            const freshOkuUsd = await upgrades.deployProxy(
                new OkuDollar__factory(Frank),
                [await freshOkuNote.getAddress(), "OkuDollar", "usdOku", frankAddr, parseEther("0.95")],
                { kind: "uups", unsafeAllow: ["constructor"] }
            ) as unknown as OkuUSD
            await freshOkuUsd.waitForDeployment()

            const freshQueue = await upgrades.deployProxy(
                new RedemptionQueue__factory(Frank),
                [await freshOkuNote.getAddress(), frankAddr],
                { kind: "uups" }
            ) as unknown as RedemptionQueue
            await freshQueue.waitForDeployment()

            const freshPSM = await upgrades.deployProxy(
                new LitePSM__factory(Frank),
                [await freshOkuNote.getAddress(), await freshOkuUsd.getAddress(), USDC_MAINNET, await freshQueue.getAddress(), frankAddr],
                { kind: "uups", unsafeAllow: ["constructor"] }
            ) as unknown as LitePSM
            await freshPSM.waitForDeployment()

            // Grant PSM minter role with HIGH allowance (1B in 18 decimals)
            await freshOkuNote.connect(Frank).grantRole(OKUM_MINTER, await freshPSM.getAddress())

            // Grant RBAC roles to Frank for fresh contracts
            await freshOkuNote.connect(Frank).grantRole(OKUM_ALLOWANCE_MANAGER, frankAddr)
            await freshOkuNote.connect(Frank).grantRole(OKUM_CAP_MANAGER, frankAddr)

            await freshOkuNote.connect(Frank).configureMinterAllowance(
                await freshPSM.getAddress(),
                parseEther("1000000000")
            )
            await freshQueue.connect(Frank).grantRole(QUEUE_PSM, await freshPSM.getAddress())

            // Alice swaps 80,000 USDC (should succeed - under 100k cap, receives 80,000 OkuNote)
            const firstSwap = parseUnits("80000", 6) // USDC amount
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), firstSwap)
            await freshPSM.connect(Alice).mintOkuM(firstSwap)

            expect(await freshOkuNote.balanceOf(aliceAddr)).to.be.closeTo(parseEther("80000"), parseEther("1"))

            // Alice tries to swap 30,000 more USDC (should fail - would exceed 100k OkuMoney cap)
            const secondSwap = parseUnits("30000", 6) // USDC amount
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), secondSwap)
            await expect(freshPSM.connect(Alice).mintOkuM(secondSwap)).to.be.revertedWithCustomError(freshOkuNote, "ExceedsSupplyCap")

            // Admin increases maxSupply
            const newMaxSupply = parseEther("200000")
            await freshOkuNote.connect(Frank).setMaxSupply(newMaxSupply)

            // Now swap should succeed
            await freshPSM.connect(Alice).mintOkuM(secondSwap)

            // Alice should have ~110,000 OkuMoney (in 18 decimals)
            const aliceBalance = await freshOkuNote.balanceOf(aliceAddr)
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
            await getOkuNote(Alice, depositAmount)
            const aliceBalance = await okuMoney.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.gt(0)

            // Transfer works before pause
            const transferAmount = parseEther("1000")
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuMoney.balanceOf(bobAddr)).to.be.closeTo(transferAmount, parseEther("1"))

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

            // Minting via PSM should fail when paused
            // Use price-aligned amount to pass slippage check, so we hit the pause check
            const currentPrice = await okuMoney.okuMPrice()
            const DECIMAL_MULT = 10n ** 12n
            const unitSize = currentPrice / DECIMAL_MULT
            const alignedDeposit = ((depositAmount + unitSize - 1n) / unitSize) * unitSize
            await fundWithUSDC(Alice, alignedDeposit)
            await usdc.connect(Alice).approve(await psm.getAddress(), alignedDeposit)
            await expect(
                psm.connect(Alice).mintOkuM(alignedDeposit)
            ).to.be.revertedWithCustomError(okuMoney, "EnforcedPause")

            // Frank unpause
            await okuMoney.connect(Frank).unpause()

            // Transfer works again after unpause
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuMoney.balanceOf(bobAddr)).to.be.closeTo(transferAmount * 2n, parseEther("1"))
        })

        it("Blacklisted addresses cannot send or receive", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // All users get OkuNote
            await getOkuNote(Alice, depositAmount)
            await getOkuNote(Bob, depositAmount)
            await getOkuNote(Charlie, depositAmount)

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

            // Bob can send again
            await okuMoney.connect(Bob).transfer(charlieAddr, transferAmount)

            // Bob can receive again
            await okuMoney.connect(Alice).transfer(bobAddr, transferAmount)
        })

        it("Blacklist works while paused (pause-to-blacklist protocol)", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Setup: Alice gets OkuNote
            await getOkuNote(Alice, depositAmount)
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
            await getOkuNote(Bob, depositAmount)
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
