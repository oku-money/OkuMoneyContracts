import {
    LitePSM,
    LitePSM__factory,
    OkuBridgeRouter,
    OkuBridgeRouter__factory,
    OkuUSD,
    OkuUSD__factory,
    RedemptionQueue,
    RedemptionQueue__factory,
    WOkuUSD,
    WOkuUSD__factory,
    IERC20__factory
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { expect } from "chai"

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const USDC_WHALE = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341"

describe("OkuUSD Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let okuBridgeRouter: OkuBridgeRouter
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuUSD: OkuUSD
    let wokuUSD: WOkuUSD

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"))
    const PSM_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PSM_ROLE"))
    const ALLOWANCE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER_ROLE"))
    const REBASER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REBASER_ROLE"))
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"))
    const UNPAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNPAUSER_ROLE"))
    const BLACKLISTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BLACKLISTER_ROLE"))
    const UNBLACKLISTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UNBLACKLISTER_ROLE"))
    const CAP_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CAP_MANAGER_ROLE"))
    const BUFFER_WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BUFFER_WITHDRAWER_ROLE"))
    const QUEUE_PROCESSOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PROCESSOR_ROLE"))

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

    async function getOkuUSD(user: Signer, usdcAmount: bigint) {
        await fundWithUSDC(user, usdcAmount)
        await usdc.connect(user).approve(await psm.getAddress(), usdcAmount)
        await psm.connect(user).swap(usdcAmount)
    }

    before(async () => {
        // Reset network to initial fork state for test isolation
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: process.env.MAINNET_RPC_URL,
                    blockNumber: 24172540
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

    it("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000")

        okuUSD = await upgrades.deployProxy(
            new OkuUSD__factory(Frank),
            ["OkuUSD", "OKUSD", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUSD.waitForDeployment()

        wokuUSD = await upgrades.deployProxy(
            new WOkuUSD__factory(Frank),
            [await okuUSD.getAddress(), "Wrapped OkuUSD", "wOKUSD", frankAddr],
            { kind: "uups" }
        ) as unknown as WOkuUSD
        await wokuUSD.waitForDeployment()

        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuUSD.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        okuBridgeRouter = await upgrades.deployProxy(
            new OkuBridgeRouter__factory(Frank),
            [await wokuUSD.getAddress(), await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as OkuBridgeRouter
        await okuBridgeRouter.waitForDeployment()

        await okuUSD.connect(Frank).grantRole(MINTER_ROLE, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuUSD.connect(Frank).grantRole(ALLOWANCE_MANAGER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(REBASER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(PAUSER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(UNPAUSER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(BLACKLISTER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(UNBLACKLISTER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(CAP_MANAGER_ROLE, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER_ROLE, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR_ROLE, frankAddr)

        await okuUSD.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(PSM_ROLE, await psm.getAddress())
        await okuUSD.connect(Frank).grantRole(MINTER_ROLE, await queue.getAddress())
    })

    describe("User-to-User Transfers", () => {
        it("Transfers work correctly and both balances grow with rebase", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuUSD via PSM
            await getOkuUSD(Alice, depositAmount)
            const aliceInitialBalance = await okuUSD.balanceOf(aliceAddr)

            // Alice transfers 5,000 to Bob (PSM mints in USDC decimals)
            const transferAmount = parseUnits("5000", 6)
            await okuUSD.connect(Alice).transfer(bobAddr, transferAmount)

            const aliceAfterTransfer = await okuUSD.balanceOf(aliceAddr)
            const bobAfterTransfer = await okuUSD.balanceOf(bobAddr)

            // Verify balances (allowing for small rounding)
            expect(aliceAfterTransfer).to.be.closeTo(aliceInitialBalance - transferAmount, parseUnits("1", 6))
            expect(bobAfterTransfer).to.be.closeTo(transferAmount, parseUnits("1", 6))

            // Record balances before rebase
            const aliceBeforeRebase = await okuUSD.balanceOf(aliceAddr)
            const bobBeforeRebase = await okuUSD.balanceOf(bobAddr)

            // Admin performs 10% rebase
            const multiplierBefore = await okuUSD.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuUSD.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Both balances should grow by 10%
            const aliceAfterRebase = await okuUSD.balanceOf(aliceAddr)
            const bobAfterRebase = await okuUSD.balanceOf(bobAddr)

            expect(aliceAfterRebase).to.be.closeTo(aliceBeforeRebase * 110n / 100n, parseUnits("1", 6))
            expect(bobAfterRebase).to.be.closeTo(bobBeforeRebase * 110n / 100n, parseUnits("1", 6))

            // Bob transfers back to Alice
            await okuUSD.connect(Bob).transfer(aliceAddr, bobAfterRebase)

            const aliceFinal = await okuUSD.balanceOf(aliceAddr)
            const bobFinal = await okuUSD.balanceOf(bobAddr)

            // Alice should have approximately her rebased amount
            expect(aliceFinal).to.be.closeTo(aliceInitialBalance * 110n / 100n, parseUnits("1", 6))
            expect(bobFinal).to.be.closeTo(0n, parseUnits("1", 6))
        })
    })

    describe("Minter Allowance Exhaustion", () => {
        it("PSM cannot mint beyond allowance, admin can reset", async () => {
            const aliceAddr = await Alice.getAddress()
            const psmAddr = await psm.getAddress()

            // Set PSM minter allowance to limited amount (50,000 OkuUSD in 6 decimals)
            const limitedAllowance = parseUnits("50000", 6)
            await okuUSD.connect(Frank).configureMinterAllowance(psmAddr, limitedAllowance)

            // Verify allowance was set
            expect(await okuUSD.minterAllowance(psmAddr)).to.equal(limitedAllowance)

            // Alice swaps 40,000 USDC (should succeed)
            const firstSwap = parseUnits("40000", 6)
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(psmAddr, firstSwap)
            await psm.connect(Alice).swap(firstSwap)

            // Verify allowance decreased (PSM mints raw USDC amounts)
            const remainingAllowance = await okuUSD.minterAllowance(psmAddr)
            expect(remainingAllowance).to.be.closeTo(limitedAllowance - firstSwap, parseUnits("1", 6))

            // Alice tries to swap 20,000 more (should fail - exceeds remaining ~10k)
            const secondSwap = parseUnits("20000", 6)
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(psmAddr, secondSwap)
            await expect(psm.connect(Alice).swap(secondSwap)).to.be.revertedWith("Exceeds minter allowance")

            // Admin resets allowance
            const newAllowance = parseUnits("100000", 6)
            await okuUSD.connect(Frank).configureMinterAllowance(psmAddr, newAllowance)

            // Now swap should succeed
            await psm.connect(Alice).swap(secondSwap)

            // Verify Alice received OkuUSD from second swap
            const aliceBalance = await okuUSD.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.gt(parseUnits("60000", 6))
        })
    })

    describe("Max Supply Cap", () => {
        it("Minting fails at cap, admin can increase", async () => {
            const frankAddr = await Frank.getAddress()
            const aliceAddr = await Alice.getAddress()

            // Deploy fresh contracts with LOW maxSupply (100,000 OkuUSD in 6 decimals)
            const lowMaxSupply = parseUnits("100000", 6)

            const freshOkuUSD = await upgrades.deployProxy(
                new OkuUSD__factory(Frank),
                ["OkuUSD-Low", "OKUSD-L", frankAddr, lowMaxSupply],
                { kind: "uups" }
            ) as unknown as OkuUSD
            await freshOkuUSD.waitForDeployment()

            const freshQueue = await upgrades.deployProxy(
                new RedemptionQueue__factory(Frank),
                [await freshOkuUSD.getAddress(), frankAddr],
                { kind: "uups" }
            ) as unknown as RedemptionQueue
            await freshQueue.waitForDeployment()

            const freshPSM = await upgrades.deployProxy(
                new LitePSM__factory(Frank),
                [await freshOkuUSD.getAddress(), USDC_MAINNET, await freshQueue.getAddress(), frankAddr],
                { kind: "uups" }
            ) as unknown as LitePSM
            await freshPSM.waitForDeployment()

            // Grant PSM minter role with HIGH allowance (1B in 6 decimals)
            await freshOkuUSD.connect(Frank).grantRole(MINTER_ROLE, await freshPSM.getAddress())

            // Grant RBAC roles to Frank for fresh contracts
            await freshOkuUSD.connect(Frank).grantRole(ALLOWANCE_MANAGER_ROLE, frankAddr)
            await freshOkuUSD.connect(Frank).grantRole(CAP_MANAGER_ROLE, frankAddr)

            await freshOkuUSD.connect(Frank).configureMinterAllowance(
                await freshPSM.getAddress(),
                parseUnits("1000000000", 6)
            )
            await freshQueue.connect(Frank).grantRole(PSM_ROLE, await freshPSM.getAddress())

            // Alice swaps 80,000 USDC (should succeed - under 100k cap)
            const firstSwap = parseUnits("80000", 6)
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), firstSwap)
            await freshPSM.connect(Alice).swap(firstSwap)

            expect(await freshOkuUSD.balanceOf(aliceAddr)).to.be.closeTo(parseUnits("80000", 6), parseUnits("1", 6))

            // Alice tries to swap 30,000 more (should fail - would exceed 100k cap)
            const secondSwap = parseUnits("30000", 6)
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), secondSwap)
            await expect(freshPSM.connect(Alice).swap(secondSwap)).to.be.revertedWith("Exceeds supply cap")

            // Admin increases maxSupply
            const newMaxSupply = parseUnits("200000", 6)
            await freshOkuUSD.connect(Frank).setMaxSupply(newMaxSupply)

            // Now swap should succeed
            await freshPSM.connect(Alice).swap(secondSwap)

            // Alice should have ~110,000 OkuUSD
            const aliceBalance = await freshOkuUSD.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.closeTo(parseUnits("110000", 6), parseUnits("1", 6))
        })
    })

    describe("Access Control / Safety", () => {
        it("Pause/unpause blocks and allows transfers", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuUSD via PSM
            await getOkuUSD(Alice, depositAmount)
            const aliceBalance = await okuUSD.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.gt(0)

            // Transfer works before pause
            const transferAmount = parseUnits("1000", 6)
            await okuUSD.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuUSD.balanceOf(bobAddr)).to.be.closeTo(transferAmount, parseUnits("1", 6))

            // Frank (admin) pauses the contract
            await okuUSD.connect(Frank).pause()

            // Transfer should fail when paused
            await expect(
                okuUSD.connect(Alice).transfer(bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuUSD, "EnforcedPause")

            // TransferFrom should also fail when paused
            await okuUSD.connect(Alice).approve(bobAddr, transferAmount)
            await expect(
                okuUSD.connect(Bob).transferFrom(aliceAddr, bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuUSD, "EnforcedPause")

            // Minting via PSM should fail when paused
            await fundWithUSDC(Alice, depositAmount)
            await usdc.connect(Alice).approve(await psm.getAddress(), depositAmount)
            await expect(
                psm.connect(Alice).swap(depositAmount)
            ).to.be.revertedWithCustomError(okuUSD, "EnforcedPause")

            // Frank unpause
            await okuUSD.connect(Frank).unpause()

            // Transfer works again after unpause
            await okuUSD.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuUSD.balanceOf(bobAddr)).to.be.closeTo(transferAmount * 2n, parseUnits("1", 6))
        })

        it("Blacklisted addresses cannot send or receive", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // All users get OkuUSD
            await getOkuUSD(Alice, depositAmount)
            await getOkuUSD(Bob, depositAmount)
            await getOkuUSD(Charlie, depositAmount)

            const transferAmount = parseUnits("1000", 6)

            // Normal transfer works
            await okuUSD.connect(Alice).transfer(bobAddr, transferAmount)

            // Frank blacklists Bob
            await okuUSD.connect(Frank).blacklist(bobAddr)
            expect(await okuUSD.isBlacklisted(bobAddr)).to.equal(true)

            // Bob cannot SEND (blacklisted sender)
            await expect(
                okuUSD.connect(Bob).transfer(charlieAddr, transferAmount)
            ).to.be.revertedWith("Sender blacklisted")

            // Bob cannot RECEIVE (blacklisted recipient)
            await expect(
                okuUSD.connect(Alice).transfer(bobAddr, transferAmount)
            ).to.be.revertedWith("Recipient blacklisted")

            // Bob cannot receive via transferFrom either
            await okuUSD.connect(Charlie).approve(aliceAddr, transferAmount)
            await expect(
                okuUSD.connect(Alice).transferFrom(charlieAddr, bobAddr, transferAmount)
            ).to.be.revertedWith("Recipient blacklisted")

            // Frank unblacklists Bob
            await okuUSD.connect(Frank).unblacklist(bobAddr)
            expect(await okuUSD.isBlacklisted(bobAddr)).to.equal(false)

            // Bob can send again
            await okuUSD.connect(Bob).transfer(charlieAddr, transferAmount)

            // Bob can receive again
            await okuUSD.connect(Alice).transfer(bobAddr, transferAmount)
        })

        it("Blacklist works while paused (pause-to-blacklist protocol)", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Setup: Alice gets OkuUSD
            await getOkuUSD(Alice, depositAmount)
            const aliceBalance = await okuUSD.balanceOf(aliceAddr)

            // STEP 1: Pause the contract (freeze all transfers)
            await okuUSD.connect(Frank).pause()

            // Verify transfers are blocked
            await expect(
                okuUSD.connect(Alice).transfer(bobAddr, parseUnits("100", 6))
            ).to.be.revertedWithCustomError(okuUSD, "EnforcedPause")

            // STEP 2: Blacklist Alice while paused (CRITICAL - must work)
            await okuUSD.connect(Frank).blacklist(aliceAddr)
            expect(await okuUSD.isBlacklisted(aliceAddr)).to.equal(true)

            // STEP 3: Unpause the contract
            await okuUSD.connect(Frank).unpause()

            // Alice still cannot send (blacklisted)
            await expect(
                okuUSD.connect(Alice).transfer(bobAddr, parseUnits("100", 6))
            ).to.be.revertedWith("Sender blacklisted")

            // Alice still cannot receive
            await getOkuUSD(Bob, depositAmount)
            await expect(
                okuUSD.connect(Bob).transfer(aliceAddr, parseUnits("100", 6))
            ).to.be.revertedWith("Recipient blacklisted")

            // Verify Alice's balance is frozen (still has funds, just can't move them)
            expect(await okuUSD.balanceOf(aliceAddr)).to.be.closeTo(aliceBalance, parseUnits("1", 6))

            // Cleanup: unblacklist Alice for other tests
            await okuUSD.connect(Frank).unblacklist(aliceAddr)
        })
    })
})
