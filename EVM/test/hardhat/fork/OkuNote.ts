import {
    LitePSM,
    LitePSM__factory,
    OkuBridgeRouter,
    OkuBridgeRouter__factory,
    OkuNote,
    OkuNote__factory,
    OkuUSD,
    OkuUSD__factory,
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
    let okuNote: OkuNote
    let okuUsd: OkuUSD

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const MINTER = ethers.keccak256(ethers.toUtf8Bytes("MINTER"))
    const PSM = ethers.keccak256(ethers.toUtf8Bytes("PSM"))
    const ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER"))
    const NOTE_REBASER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_REBASER"))
    const NOTE_PAUSER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_PAUSER"))
    const NOTE_UNPAUSER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_UNPAUSER"))
    const BLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("BLACKLISTER"))
    const UNBLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("UNBLACKLISTER"))
    const CAP_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("CAP_MANAGER"))
    const BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("BUFFER_WITHDRAWER"))
    const QUEUE_PROCESSOR = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PROCESSOR"))

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
        await fundWithUSDC(user, usdcAmount)
        await usdc.connect(user).approve(await psm.getAddress(), usdcAmount)
        await psm.connect(user).mint_OkuNote(usdcAmount)
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

    before("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000")

        okuNote = await upgrades.deployProxy(
            new OkuNote__factory(Frank),
            ["OkuNote", "OKUNOTE", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuNote
        await okuNote.waitForDeployment()

        okuUsd = await upgrades.deployProxy(
            new OkuUSD__factory(Frank),
            [await okuNote.getAddress(), "OkuUSD", "OKUSD", frankAddr, parseEther("0.95")],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUsd.waitForDeployment()

        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuNote.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuNote.getAddress(), await okuUsd.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        okuBridgeRouter = await upgrades.deployProxy(
            new OkuBridgeRouter__factory(Frank),
            [await okuUsd.getAddress(), await okuNote.getAddress(), frankAddr, frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuBridgeRouter
        await okuBridgeRouter.waitForDeployment()

        await okuNote.connect(Frank).grantRole(MINTER, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuNote.connect(Frank).grantRole(ALLOWANCE_MANAGER, frankAddr)
        await okuNote.connect(Frank).grantRole(NOTE_REBASER, frankAddr)
        await okuNote.connect(Frank).grantRole(NOTE_PAUSER, frankAddr)
        await okuNote.connect(Frank).grantRole(NOTE_UNPAUSER, frankAddr)
        await okuNote.connect(Frank).grantRole(BLACKLISTER, frankAddr)
        await okuNote.connect(Frank).grantRole(UNBLACKLISTER, frankAddr)
        await okuNote.connect(Frank).grantRole(CAP_MANAGER, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR, frankAddr)

        await okuNote.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(PSM, await psm.getAddress())
        await okuNote.connect(Frank).grantRole(MINTER, await queue.getAddress())
    })

    describe("User-to-User Transfers", () => {
        it("Transfers work correctly and both balances grow with rebase", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuNote via PSM
            await getOkuNote(Alice, depositAmount)
            const aliceInitialBalance = await okuNote.balanceOf(aliceAddr)

            // Alice transfers 5,000 OkuNote to Bob (OkuNote is 18 decimals)
            const transferAmount = parseEther("5000")
            await okuNote.connect(Alice).transfer(bobAddr, transferAmount)

            const aliceAfterTransfer = await okuNote.balanceOf(aliceAddr)
            const bobAfterTransfer = await okuNote.balanceOf(bobAddr)

            // Verify balances (allowing for small rounding)
            expect(aliceAfterTransfer).to.be.closeTo(aliceInitialBalance - transferAmount, parseEther("1"))
            expect(bobAfterTransfer).to.be.closeTo(transferAmount, parseEther("1"))

            // Record balances before rebase
            const aliceBeforeRebase = await okuNote.balanceOf(aliceAddr)
            const bobBeforeRebase = await okuNote.balanceOf(bobAddr)

            // Admin performs 10% rebase
            const multiplierBefore = await okuNote.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuNote.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Both balances should grow by 10%
            const aliceAfterRebase = await okuNote.balanceOf(aliceAddr)
            const bobAfterRebase = await okuNote.balanceOf(bobAddr)

            expect(aliceAfterRebase).to.be.closeTo(aliceBeforeRebase * 110n / 100n, parseEther("1"))
            expect(bobAfterRebase).to.be.closeTo(bobBeforeRebase * 110n / 100n, parseEther("1"))

            // Bob transfers back to Alice
            await okuNote.connect(Bob).transfer(aliceAddr, bobAfterRebase)

            const aliceFinal = await okuNote.balanceOf(aliceAddr)
            const bobFinal = await okuNote.balanceOf(bobAddr)

            // Alice should have approximately her rebased amount
            expect(aliceFinal).to.be.closeTo(aliceInitialBalance * 110n / 100n, parseEther("1"))
            expect(bobFinal).to.be.closeTo(0n, parseEther("1"))
        })
    })

    describe("Minter Allowance Exhaustion", () => {
        it("PSM cannot mint beyond allowance, admin can reset", async () => {
            const aliceAddr = await Alice.getAddress()
            const psmAddr = await psm.getAddress()

            // Set PSM minter allowance to limited amount (50,000 OkuNote in 18 decimals)
            const limitedAllowance = parseEther("50000")
            await okuNote.connect(Frank).configureMinterAllowance(psmAddr, limitedAllowance)

            // Verify allowance was set
            expect(await okuNote.minterAllowance(psmAddr)).to.equal(limitedAllowance)

            // Alice swaps 40,000 USDC (should succeed, receives 40,000 OkuNote in 18 decimals)
            const firstSwap = parseUnits("40000", 6) // USDC amount
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(psmAddr, firstSwap)
            await psm.connect(Alice).mint_OkuNote(firstSwap)

            // Verify allowance decreased by OkuNote amount minted (40,000 in 18 decimals)
            const remainingAllowance = await okuNote.minterAllowance(psmAddr)
            const expectedRemaining = limitedAllowance - parseEther("40000")
            expect(remainingAllowance).to.be.closeTo(expectedRemaining, parseEther("1"))

            // Alice tries to swap 20,000 more USDC (should fail - exceeds remaining ~10k OkuNote)
            const secondSwap = parseUnits("20000", 6) // USDC amount
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(psmAddr, secondSwap)
            await expect(psm.connect(Alice).mint_OkuNote(secondSwap)).to.be.revertedWith("Exceeds minter allowance")

            // Admin resets allowance
            const newAllowance = parseEther("100000")
            await okuNote.connect(Frank).configureMinterAllowance(psmAddr, newAllowance)

            // Now swap should succeed
            await psm.connect(Alice).mint_OkuNote(secondSwap)

            // Verify Alice received OkuNote from second swap (60,000 OkuNote total in 18 decimals)
            const aliceBalance = await okuNote.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.gt(parseEther("60000"))
        })
    })

    describe("Max Supply Cap", () => {
        it("Minting fails at cap, admin can increase", async () => {
            const frankAddr = await Frank.getAddress()
            const aliceAddr = await Alice.getAddress()

            // Deploy fresh contracts with LOW maxSupply (100,000 OkuNote in 18 decimals)
            const lowMaxSupply = parseEther("100000")

            const freshOkuNote = await upgrades.deployProxy(
                new OkuNote__factory(Frank),
                ["OkuNote-Low", "OKUNOTE-L", frankAddr, lowMaxSupply],
                { kind: "uups" }
            ) as unknown as OkuNote
            await freshOkuNote.waitForDeployment()

            const freshOkuUsd = await upgrades.deployProxy(
                new OkuUSD__factory(Frank),
                [await freshOkuNote.getAddress(), "OkuUSD", "OKUSD", frankAddr, parseEther("0.95")],
                { kind: "uups" }
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
            await freshOkuNote.connect(Frank).grantRole(MINTER, await freshPSM.getAddress())

            // Grant RBAC roles to Frank for fresh contracts
            await freshOkuNote.connect(Frank).grantRole(ALLOWANCE_MANAGER, frankAddr)
            await freshOkuNote.connect(Frank).grantRole(CAP_MANAGER, frankAddr)

            await freshOkuNote.connect(Frank).configureMinterAllowance(
                await freshPSM.getAddress(),
                parseEther("1000000000")
            )
            await freshQueue.connect(Frank).grantRole(PSM, await freshPSM.getAddress())

            // Alice swaps 80,000 USDC (should succeed - under 100k cap, receives 80,000 OkuNote)
            const firstSwap = parseUnits("80000", 6) // USDC amount
            await fundWithUSDC(Alice, firstSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), firstSwap)
            await freshPSM.connect(Alice).mint_OkuNote(firstSwap)

            expect(await freshOkuNote.balanceOf(aliceAddr)).to.be.closeTo(parseEther("80000"), parseEther("1"))

            // Alice tries to swap 30,000 more USDC (should fail - would exceed 100k OkuNote cap)
            const secondSwap = parseUnits("30000", 6) // USDC amount
            await fundWithUSDC(Alice, secondSwap)
            await usdc.connect(Alice).approve(await freshPSM.getAddress(), secondSwap)
            await expect(freshPSM.connect(Alice).mint_OkuNote(secondSwap)).to.be.revertedWith("Exceeds supply cap")

            // Admin increases maxSupply
            const newMaxSupply = parseEther("200000")
            await freshOkuNote.connect(Frank).setMaxSupply(newMaxSupply)

            // Now swap should succeed
            await freshPSM.connect(Alice).mint_OkuNote(secondSwap)

            // Alice should have ~110,000 OkuNote (in 18 decimals)
            const aliceBalance = await freshOkuNote.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.closeTo(parseEther("110000"), parseEther("1"))
        })
    })

    describe("Access Control / Safety", () => {
        it("Pause/unpause blocks and allows transfers", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Alice gets OkuNote via PSM
            await getOkuNote(Alice, depositAmount)
            const aliceBalance = await okuNote.balanceOf(aliceAddr)
            expect(aliceBalance).to.be.gt(0)

            // Transfer works before pause
            const transferAmount = parseEther("1000")
            await okuNote.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuNote.balanceOf(bobAddr)).to.be.closeTo(transferAmount, parseEther("1"))

            // Frank (admin) pauses the contract
            await okuNote.connect(Frank).pause()

            // Transfer should fail when paused
            await expect(
                okuNote.connect(Alice).transfer(bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuNote, "EnforcedPause")

            // TransferFrom should also fail when paused
            await okuNote.connect(Alice).approve(bobAddr, transferAmount)
            await expect(
                okuNote.connect(Bob).transferFrom(aliceAddr, bobAddr, transferAmount)
            ).to.be.revertedWithCustomError(okuNote, "EnforcedPause")

            // Minting via PSM should fail when paused
            await fundWithUSDC(Alice, depositAmount)
            await usdc.connect(Alice).approve(await psm.getAddress(), depositAmount)
            await expect(
                psm.connect(Alice).mint_OkuNote(depositAmount)
            ).to.be.revertedWithCustomError(okuNote, "EnforcedPause")

            // Frank unpause
            await okuNote.connect(Frank).unpause()

            // Transfer works again after unpause
            await okuNote.connect(Alice).transfer(bobAddr, transferAmount)
            expect(await okuNote.balanceOf(bobAddr)).to.be.closeTo(transferAmount * 2n, parseEther("1"))
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
            await okuNote.connect(Alice).transfer(bobAddr, transferAmount)

            // Frank blacklists Bob
            await okuNote.connect(Frank).blacklist(bobAddr)
            expect(await okuNote.isBlacklisted(bobAddr)).to.equal(true)

            // Bob cannot SEND (blacklisted sender)
            await expect(
                okuNote.connect(Bob).transfer(charlieAddr, transferAmount)
            ).to.be.revertedWith("Sender blacklisted")

            // Bob cannot RECEIVE (blacklisted recipient)
            await expect(
                okuNote.connect(Alice).transfer(bobAddr, transferAmount)
            ).to.be.revertedWith("Recipient blacklisted")

            // Bob cannot receive via transferFrom either
            await okuNote.connect(Charlie).approve(aliceAddr, transferAmount)
            await expect(
                okuNote.connect(Alice).transferFrom(charlieAddr, bobAddr, transferAmount)
            ).to.be.revertedWith("Recipient blacklisted")

            // Frank unblacklists Bob
            await okuNote.connect(Frank).unblacklist(bobAddr)
            expect(await okuNote.isBlacklisted(bobAddr)).to.equal(false)

            // Bob can send again
            await okuNote.connect(Bob).transfer(charlieAddr, transferAmount)

            // Bob can receive again
            await okuNote.connect(Alice).transfer(bobAddr, transferAmount)
        })

        it("Blacklist works while paused (pause-to-blacklist protocol)", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Setup: Alice gets OkuNote
            await getOkuNote(Alice, depositAmount)
            const aliceBalance = await okuNote.balanceOf(aliceAddr)

            // STEP 1: Pause the contract (freeze all transfers)
            await okuNote.connect(Frank).pause()

            // Verify transfers are blocked
            await expect(
                okuNote.connect(Alice).transfer(bobAddr, parseEther("100"))
            ).to.be.revertedWithCustomError(okuNote, "EnforcedPause")

            // STEP 2: Blacklist Alice while paused (CRITICAL - must work)
            await okuNote.connect(Frank).blacklist(aliceAddr)
            expect(await okuNote.isBlacklisted(aliceAddr)).to.equal(true)

            // STEP 3: Unpause the contract
            await okuNote.connect(Frank).unpause()

            // Alice still cannot send (blacklisted)
            await expect(
                okuNote.connect(Alice).transfer(bobAddr, parseEther("100"))
            ).to.be.revertedWith("Sender blacklisted")

            // Alice still cannot receive
            await getOkuNote(Bob, depositAmount)
            await expect(
                okuNote.connect(Bob).transfer(aliceAddr, parseEther("100"))
            ).to.be.revertedWith("Recipient blacklisted")

            // Verify Alice's balance is frozen (still has funds, just can't move them)
            expect(await okuNote.balanceOf(aliceAddr)).to.be.closeTo(aliceBalance, parseEther("1"))

            // Cleanup: unblacklist Alice for other tests
            await okuNote.connect(Frank).unblacklist(aliceAddr)
        })
    })
})
