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

describe("LitePSM Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer
    let Dave: Signer

    let okuBridgeRouter: OkuBridgeRouter
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuMoney: OkuNote
    let okuUsd: OkuUSD

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const MINTER = ethers.keccak256(ethers.toUtf8Bytes("MINTER"))
    const PSM = ethers.keccak256(ethers.toUtf8Bytes("PSM"))
    const ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER"))
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("BUFFER_WITHDRAWER"))
    const QUEUE_PROCESSOR = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PROCESSOR"))
    const DEPOSIT_AMOUNT = parseUnits("10000", 6) // USDC amount (6 decimals)
    const DECIMAL_MULTIPLIER = 10n ** 12n // Convert USDC (6 decimals) to OkuMoney (18 decimals)

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
            await psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), balance)
        }
    }

    // Helper to clear any pending queue entries
    async function clearQueue() {
        const queueLen = await queue.queueLength()
        if (queueLen > 0n) {
            await fundPSM(parseUnits("1000000", 6))
            // approveAmount: generous amount to cover all queued entries
            await psm.connect(Frank).processQueue(await queue.queueHead(), await queue.queueTail(), parseUnits("1000000", 6))
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

        okuMoney = await upgrades.deployProxy(
            new OkuMoney__factory(Frank),
            ["OkuMoney", "OkuM", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuNote
        await okuMoney.waitForDeployment()

        okuUsd = await upgrades.deployProxy(
            new OkuDollar__factory(Frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr, parseEther("0.95")],
            { kind: "uups" }
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

        await okuMoney.connect(Frank).grantRole(MINTER, await psm.getAddress())

        // Grant RBAC roles to Frank for testing
        await okuMoney.connect(Frank).grantRole(ALLOWANCE_MANAGER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_REBASER, frankAddr)
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR, frankAddr)

        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(PSM, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(MINTER, await queue.getAddress())
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
            await psm.connect(Alice).mint_OkuM(DEPOSIT_AMOUNT)
            await psm.connect(Bob).mint_OkuM(DEPOSIT_AMOUNT)

            // Verify PSM has buffer
            expect(await usdc.balanceOf(psmAddr)).to.equal(DEPOSIT_AMOUNT * 2n)

            // Alice redeems half - should be instant
            const aliceOkuUSD = await okuMoney.balanceOf(aliceAddr)
            const aliceRedeemAmount = aliceOkuUSD / 2n
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)

            await okuMoney.connect(Alice).approve(psmAddr, aliceRedeemAmount)
            await psm.connect(Alice).redeem_OkuM(aliceRedeemAmount)

            const expectedAliceUsdc = aliceRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore).to.be.closeTo(expectedAliceUsdc, parseUnits("1", 6))
            expect(await queue.queueLength()).to.equal(0)

            // Bob redeems half - should also be instant
            const bobOkuUSD = await okuMoney.balanceOf(bobAddr)
            const bobRedeemAmount = bobOkuUSD / 2n
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)

            await okuMoney.connect(Bob).approve(psmAddr, bobRedeemAmount)
            await psm.connect(Bob).redeem_OkuM(bobRedeemAmount)

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

            await psm.connect(Alice).mint_OkuM(freshAmount)
            await psm.connect(Bob).mint_OkuM(freshAmount)
            await psm.connect(Charlie).mint_OkuM(freshAmount)
            await psm.connect(Dave).mint_OkuM(freshAmount)

            // Drain buffer completely
            await drainPSM()
            expect(await usdc.balanceOf(psmAddr)).to.equal(0)

            // Each user queues 5,000 OkuDollar (half their balance) - use 18 decimals for OkuUSD
            const redeemAmount = parseEther("5000")

            await okuMoney.connect(Alice).approve(psmAddr, redeemAmount)
            await okuMoney.connect(Alice).approve(queueAddr, redeemAmount)
            await psm.connect(Alice).redeem_OkuM(redeemAmount)

            await okuMoney.connect(Bob).approve(psmAddr, redeemAmount)
            await okuMoney.connect(Bob).approve(queueAddr, redeemAmount)
            await psm.connect(Bob).redeem_OkuM(redeemAmount)

            await okuMoney.connect(Charlie).approve(psmAddr, redeemAmount)
            await okuMoney.connect(Charlie).approve(queueAddr, redeemAmount)
            await psm.connect(Charlie).redeem_OkuM(redeemAmount)

            await okuMoney.connect(Dave).approve(psmAddr, redeemAmount)
            await okuMoney.connect(Dave).approve(queueAddr, redeemAmount)
            await psm.connect(Dave).redeem_OkuM(redeemAmount)

            // All 4 should be queued (5000 each = 20000 total)
            expect(await queue.queueLength()).to.equal(4)

            // Record USDC balances before processing
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)
            const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
            const daveUsdcBefore = await usdc.balanceOf(daveAddr)

            // Replenish with only 10,000 USDC (enough for Alice + Bob only)
            await fundPSM(parseUnits("10000", 6))

            // Process queue (approve enough for all entries — queue will stop when buffer runs out)
            await psm.connect(Frank).processQueue(await queue.queueHead(), await queue.queueTail(), parseUnits("20000", 6))

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
            await psm.connect(Frank).processQueue(await queue.queueHead(), await queue.queueTail(), parseUnits("20000", 6))
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

            await psm.connect(Alice).mint_OkuM(depositAmount)
            await psm.connect(Bob).mint_OkuM(depositAmount)
            await psm.connect(Charlie).mint_OkuM(depositAmount)
            await psm.connect(Dave).mint_OkuM(depositAmount)

            // PSM has 20,000 USDC - withdraw to leave only 10,000
            const psmBuffer = await usdc.balanceOf(psmAddr)
            await psm.connect(Frank).withdrawUsdc(
                await Frank.getAddress(),
                psmBuffer - parseUnits("10000", 6)
            )

            expect(await usdc.balanceOf(psmAddr)).to.equal(parseUnits("10000", 6))

            // Record initial balances
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)
            const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
            const daveUsdcBefore = await usdc.balanceOf(daveAddr)

            // Calculate OkuDollar amount to redeem (deposited 5000 USDC, got 5000 OkuDollar in 18 decimals)
            const redeemOkuUSD = parseEther("5000")

            // Alice redeems 5,000 OkuDollar - INSTANT (buffer: 10,000 -> 5,000)
            await okuMoney.connect(Alice).approve(psmAddr, redeemOkuUSD)
            await psm.connect(Alice).redeem_OkuM(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(0)
            expect(await usdc.balanceOf(aliceAddr)).to.be.gt(aliceUsdcBefore)

            // Bob redeems 5,000 OkuDollar - INSTANT (buffer: 5,000 -> 0)
            await okuMoney.connect(Bob).approve(psmAddr, redeemOkuUSD)
            await psm.connect(Bob).redeem_OkuM(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(0)
            expect(await usdc.balanceOf(bobAddr)).to.be.gt(bobUsdcBefore)

            // Charlie redeems 5,000 OkuDollar - QUEUED (buffer: 0)
            await okuMoney.connect(Charlie).approve(psmAddr, redeemOkuUSD)
            await okuMoney.connect(Charlie).approve(queueAddr, redeemOkuUSD)
            await psm.connect(Charlie).redeem_OkuM(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(1)
            expect(await usdc.balanceOf(charlieAddr)).to.equal(charlieUsdcBefore)

            // Dave redeems 5,000 OkuDollar - QUEUED
            await okuMoney.connect(Dave).approve(psmAddr, redeemOkuUSD)
            await okuMoney.connect(Dave).approve(queueAddr, redeemOkuUSD)
            await psm.connect(Dave).redeem_OkuM(redeemOkuUSD)

            expect(await queue.queueLength()).to.equal(2)
            expect(await usdc.balanceOf(daveAddr)).to.equal(daveUsdcBefore)

            // Cleanup
            await fundPSM(parseUnits("20000", 6))
            await psm.connect(Frank).processQueue(await queue.queueHead(), await queue.queueTail(), parseUnits("20000", 6))
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
            await psm.connect(Alice).mint_OkuM(depositAmount)
            await psm.connect(Bob).mint_OkuM(depositAmount)

            // Drain buffer
            await drainPSM()

            // Record OkuDollar balances (what they're queuing)
            const aliceOkuUSD = await okuMoney.balanceOf(aliceAddr)
            const bobOkuUSD = await okuMoney.balanceOf(bobAddr)

            // Queue full balances
            await okuMoney.connect(Alice).approve(psmAddr, aliceOkuUSD)
            await okuMoney.connect(Alice).approve(queueAddr, aliceOkuUSD)
            await psm.connect(Alice).redeem_OkuM(aliceOkuUSD)

            await okuMoney.connect(Bob).approve(psmAddr, bobOkuUSD)
            await okuMoney.connect(Bob).approve(queueAddr, bobOkuUSD)
            await psm.connect(Bob).redeem_OkuM(bobOkuUSD)

            expect(await queue.queueLength()).to.equal(2)

            // NotePrice increase: 10% while users are in queue
            const priceBefore = await okuMoney.okuMPrice()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).updateOkuMPrice(newPrice)

            // Record USDC balances before processing
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)

            // Replenish and process
            await fundPSM(parseUnits("50000", 6))
            await psm.connect(Frank).processQueue(await queue.queueHead(), await queue.queueTail(), parseUnits("50000", 6))

            expect(await queue.queueLength()).to.equal(0)

            // Calculate received amounts (in USDC, 6 decimals)
            const aliceReceived = (await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore
            const bobReceived = (await usdc.balanceOf(bobAddr)) - bobUsdcBefore

            // Convert queued OkuDollar amounts to USDC amounts for comparison
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
