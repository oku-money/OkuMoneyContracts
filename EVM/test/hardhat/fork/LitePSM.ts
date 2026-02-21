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
import { getTokenAddress, getWhaleAddress } from "../../../config/config"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

describe("LitePSM Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer
    let Dave: Signer

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
    const BUFFER_WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BUFFER_WITHDRAWER_ROLE"))
    const QUEUE_PROCESSOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PROCESSOR_ROLE"))
    const DEPOSIT_AMOUNT = parseUnits("10000", 6) // USDC amount (6 decimals)
    const DECIMAL_MULTIPLIER = 10n ** 12n // Convert USDC (6 decimals) to OkuUSD (18 decimals)

    // Helper to fund a user with USDC from whale
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

    // Helper to fund PSM directly
    async function fundPSM(amount: bigint) {
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale).transfer(await psm.getAddress(), amount)
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })
    }

    // Helper to drain PSM buffer
    async function drainPSM() {
        const balance = await usdc.balanceOf(await psm.getAddress())
        if (balance > 0n) {
            await psm.connect(Frank).withdrawUSDC(await Frank.getAddress(), balance)
        }
    }

    // Helper to clear any pending queue entries
    async function clearQueue() {
        const queueLen = await queue.queueLength()
        if (queueLen > 0n) {
            await fundPSM(parseUnits("1000000", 6))
            await psm.connect(Frank).processQueue(100)
        }
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
        Dave = signers[4]

        usdc = IERC20__factory.connect(USDC_MAINNET, Bob)

        // Fund whale with ETH for gas (once)
        await Frank.sendTransaction({
            to: USDC_WHALE,
            value: parseEther("10")
        })
    })

    before("Deploy", async () => {
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

        // Grant RBAC roles to Frank for testing
        await okuUSD.connect(Frank).grantRole(ALLOWANCE_MANAGER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(REBASER_ROLE, frankAddr)
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER_ROLE, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR_ROLE, frankAddr)

        await okuUSD.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(PSM_ROLE, await psm.getAddress())
        await okuUSD.connect(Frank).grantRole(MINTER_ROLE, await queue.getAddress())
    })

    describe("Instant Redemption", () => {
        it("Users receive USDC instantly when buffer is sufficient", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const psmAddr = await psm.getAddress()

            // Setup: Fund users and have them deposit
            await fundWithUSDC(Alice, DEPOSIT_AMOUNT)
            await fundWithUSDC(Bob, DEPOSIT_AMOUNT)

            await usdc.connect(Alice).approve(psmAddr, DEPOSIT_AMOUNT)
            await usdc.connect(Bob).approve(psmAddr, DEPOSIT_AMOUNT)
            await psm.connect(Alice).mint(DEPOSIT_AMOUNT)
            await psm.connect(Bob).mint(DEPOSIT_AMOUNT)

            // Verify PSM has buffer
            expect(await usdc.balanceOf(psmAddr)).to.equal(DEPOSIT_AMOUNT * 2n)

            // Alice redeems half - should be instant
            const aliceOkuUSD = await okuUSD.balanceOf(aliceAddr)
            const aliceRedeemAmount = aliceOkuUSD / 2n
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)

            await okuUSD.connect(Alice).approve(psmAddr, aliceRedeemAmount)
            await psm.connect(Alice).redeem(aliceRedeemAmount)

            const expectedAliceUsdc = aliceRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore).to.be.closeTo(expectedAliceUsdc, parseUnits("1", 6))
            expect(await queue.queueLength()).to.equal(0)

            // Bob redeems half - should also be instant
            const bobOkuUSD = await okuUSD.balanceOf(bobAddr)
            const bobRedeemAmount = bobOkuUSD / 2n
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)

            await okuUSD.connect(Bob).approve(psmAddr, bobRedeemAmount)
            await psm.connect(Bob).redeem(bobRedeemAmount)

            const expectedBobUsdc = bobRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(bobAddr)) - bobUsdcBefore).to.be.closeTo(expectedBobUsdc, parseUnits("1", 6))
            expect(await queue.queueLength()).to.equal(0)
        })
    })

    describe("Partial Queue Processing", () => {
        it("Processes only what buffer can cover", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const daveAddr = await Dave.getAddress()
            const psmAddr = await psm.getAddress()
            const queueAddr = await queue.getAddress()

            // Ensure clean state
            await clearQueue()
            await drainPSM()

            // Fund all users with fresh USDC
            const freshAmount = parseUnits("10000", 6)
            await fundWithUSDC(Alice, freshAmount)
            await fundWithUSDC(Bob, freshAmount)
            await fundWithUSDC(Charlie, freshAmount)
            await fundWithUSDC(Dave, freshAmount)

            // All deposit
            await usdc.connect(Alice).approve(psmAddr, freshAmount)
            await usdc.connect(Bob).approve(psmAddr, freshAmount)
            await usdc.connect(Charlie).approve(psmAddr, freshAmount)
            await usdc.connect(Dave).approve(psmAddr, freshAmount)

            await psm.connect(Alice).mint(freshAmount)
            await psm.connect(Bob).mint(freshAmount)
            await psm.connect(Charlie).mint(freshAmount)
            await psm.connect(Dave).mint(freshAmount)

            // Drain buffer completely
            await drainPSM()
            expect(await usdc.balanceOf(psmAddr)).to.equal(0)

            // Each user queues 5,000 OkuUSD (half their balance) - use 18 decimals for OkuUSD
            const redeemAmount = parseEther("5000")

            await okuUSD.connect(Alice).approve(psmAddr, redeemAmount)
            await okuUSD.connect(Alice).approve(queueAddr, redeemAmount)
            await psm.connect(Alice).redeem(redeemAmount)

            await okuUSD.connect(Bob).approve(psmAddr, redeemAmount)
            await okuUSD.connect(Bob).approve(queueAddr, redeemAmount)
            await psm.connect(Bob).redeem(redeemAmount)

            await okuUSD.connect(Charlie).approve(psmAddr, redeemAmount)
            await okuUSD.connect(Charlie).approve(queueAddr, redeemAmount)
            await psm.connect(Charlie).redeem(redeemAmount)

            await okuUSD.connect(Dave).approve(psmAddr, redeemAmount)
            await okuUSD.connect(Dave).approve(queueAddr, redeemAmount)
            await psm.connect(Dave).redeem(redeemAmount)

            // All 4 should be queued (5000 each = 20000 total)
            expect(await queue.queueLength()).to.equal(4)

            // Record USDC balances before processing
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)
            const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
            const daveUsdcBefore = await usdc.balanceOf(daveAddr)

            // Replenish with only 10,000 USDC (enough for Alice + Bob only)
            await fundPSM(parseUnits("10000", 6))

            // Process queue
            await psm.connect(Frank).processQueue(10)

            // Should have processed Alice + Bob, leaving Charlie + Dave
            expect(await queue.queueLength()).to.equal(2)

            // Alice and Bob received ~5,000 USDC each
            const expectedUsdc = parseUnits("5000", 6)
            expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore).to.be.closeTo(expectedUsdc, parseUnits("1", 6))
            expect((await usdc.balanceOf(bobAddr)) - bobUsdcBefore).to.be.closeTo(expectedUsdc, parseUnits("1", 6))

            // Charlie and Dave did NOT receive USDC yet
            expect(await usdc.balanceOf(charlieAddr)).to.equal(charlieUsdcBefore)
            expect(await usdc.balanceOf(daveAddr)).to.equal(daveUsdcBefore)

            // Cleanup: process remaining
            await fundPSM(parseUnits("20000", 6))
            await psm.connect(Frank).processQueue(10)
            expect(await queue.queueLength()).to.equal(0)
        })
    })

    describe("Mixed Instant and Queued Redemptions", () => {
        it("First users redeem instantly, later users get queued as buffer depletes", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const daveAddr = await Dave.getAddress()
            const psmAddr = await psm.getAddress()
            const queueAddr = await queue.getAddress()

            // Ensure clean state
            await clearQueue()
            await drainPSM()

            // Fund all users
            const depositAmount = parseUnits("5000", 6)
            await fundWithUSDC(Alice, depositAmount)
            await fundWithUSDC(Bob, depositAmount)
            await fundWithUSDC(Charlie, depositAmount)
            await fundWithUSDC(Dave, depositAmount)

            // All deposit
            await usdc.connect(Alice).approve(psmAddr, depositAmount)
            await usdc.connect(Bob).approve(psmAddr, depositAmount)
            await usdc.connect(Charlie).approve(psmAddr, depositAmount)
            await usdc.connect(Dave).approve(psmAddr, depositAmount)

            await psm.connect(Alice).mint(depositAmount)
            await psm.connect(Bob).mint(depositAmount)
            await psm.connect(Charlie).mint(depositAmount)
            await psm.connect(Dave).mint(depositAmount)

            // PSM has 20,000 USDC - withdraw to leave only 10,000
            const psmBuffer = await usdc.balanceOf(psmAddr)
            await psm.connect(Frank).withdrawUSDC(
                await Frank.getAddress(),
                psmBuffer - parseUnits("10000", 6)
            )

            expect(await usdc.balanceOf(psmAddr)).to.equal(parseUnits("10000", 6))

            // Record initial balances
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)
            const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
            const daveUsdcBefore = await usdc.balanceOf(daveAddr)

            // Calculate OkuUSD amount to redeem (deposited 5000 USDC, got 5000 OkuUSD in 18 decimals)
            const redeemOkuUSD = parseEther("5000")

            // Alice redeems 5,000 OkuUSD - INSTANT (buffer: 10,000 -> 5,000)
            await okuUSD.connect(Alice).approve(psmAddr, redeemOkuUSD)
            await psm.connect(Alice).redeem(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(0)
            expect(await usdc.balanceOf(aliceAddr)).to.be.gt(aliceUsdcBefore)

            // Bob redeems 5,000 OkuUSD - INSTANT (buffer: 5,000 -> 0)
            await okuUSD.connect(Bob).approve(psmAddr, redeemOkuUSD)
            await psm.connect(Bob).redeem(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(0)
            expect(await usdc.balanceOf(bobAddr)).to.be.gt(bobUsdcBefore)

            // Charlie redeems 5,000 OkuUSD - QUEUED (buffer: 0)
            await okuUSD.connect(Charlie).approve(psmAddr, redeemOkuUSD)
            await okuUSD.connect(Charlie).approve(queueAddr, redeemOkuUSD)
            await psm.connect(Charlie).redeem(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(1)
            expect(await usdc.balanceOf(charlieAddr)).to.equal(charlieUsdcBefore)

            // Dave redeems 5,000 OkuUSD - QUEUED
            await okuUSD.connect(Dave).approve(psmAddr, redeemOkuUSD)
            await okuUSD.connect(Dave).approve(queueAddr, redeemOkuUSD)
            await psm.connect(Dave).redeem(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(2)
            expect(await usdc.balanceOf(daveAddr)).to.equal(daveUsdcBefore)

            // Cleanup
            await fundPSM(parseUnits("20000", 6))
            await psm.connect(Frank).processQueue(10)
            expect(await queue.queueLength()).to.equal(0)
        })
    })

    describe("Yield Accrual While in Queue", () => {
        it("Users earn rebase yield while waiting in queue", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const psmAddr = await psm.getAddress()
            const queueAddr = await queue.getAddress()

            // Ensure clean state
            await clearQueue()
            await drainPSM()

            // Fund users
            const depositAmount = parseUnits("10000", 6)
            await fundWithUSDC(Alice, depositAmount)
            await fundWithUSDC(Bob, depositAmount)

            // Deposit
            await usdc.connect(Alice).approve(psmAddr, depositAmount)
            await usdc.connect(Bob).approve(psmAddr, depositAmount)
            await psm.connect(Alice).mint(depositAmount)
            await psm.connect(Bob).mint(depositAmount)

            // Drain buffer
            await drainPSM()

            // Record OkuUSD balances (what they're queuing)
            const aliceOkuUSD = await okuUSD.balanceOf(aliceAddr)
            const bobOkuUSD = await okuUSD.balanceOf(bobAddr)

            // Queue full balances
            await okuUSD.connect(Alice).approve(psmAddr, aliceOkuUSD)
            await okuUSD.connect(Alice).approve(queueAddr, aliceOkuUSD)
            await psm.connect(Alice).redeem(aliceOkuUSD)

            await okuUSD.connect(Bob).approve(psmAddr, bobOkuUSD)
            await okuUSD.connect(Bob).approve(queueAddr, bobOkuUSD)
            await psm.connect(Bob).redeem(bobOkuUSD)

            expect(await queue.queueLength()).to.equal(2)

            // REBASE: 10% increase while users are in queue
            const multiplierBefore = await okuUSD.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuUSD.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Record USDC balances before processing
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)

            // Replenish and process
            await fundPSM(parseUnits("50000", 6))
            await psm.connect(Frank).processQueue(10)

            expect(await queue.queueLength()).to.equal(0)

            // Calculate received amounts (in USDC, 6 decimals)
            const aliceReceived = (await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore
            const bobReceived = (await usdc.balanceOf(bobAddr)) - bobUsdcBefore

            // Convert queued OkuUSD amounts to USDC amounts for comparison
            const aliceQueuedUSDC = aliceOkuUSD / DECIMAL_MULTIPLIER
            const bobQueuedUSDC = bobOkuUSD / DECIMAL_MULTIPLIER

            // Users should receive MORE than they originally queued (10% yield)
            expect(aliceReceived).to.be.gt(aliceQueuedUSDC)
            expect(bobReceived).to.be.gt(bobQueuedUSDC)

            // Verify approximately 10% more (allow 1 USDC tolerance for rounding)
            const expectedAlice = aliceQueuedUSDC * 110n / 100n
            const expectedBob = bobQueuedUSDC * 110n / 100n

            expect(aliceReceived).to.be.closeTo(expectedAlice, parseUnits("1", 6))
            expect(bobReceived).to.be.closeTo(expectedBob, parseUnits("1", 6))
        })
    })
})
