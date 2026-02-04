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
// Circle's USDC treasury - a known whale address
const USDC_WHALE = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341"

describe("Happy Path Testing", () => {
    //actors
    let Frank: Signer //admin
    let Bob: Signer // user
    let Alice: Signer
    let Charlie: Signer
    let Dave: Signer

    //contracts
    let okuBridgeRouter: OkuBridgeRouter
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuUSD: OkuUSD
    let wokuUSD: WOkuUSD

    // USDC contract
    let usdc: ReturnType<typeof IERC20__factory.connect>

    // Constants
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"))
    const PSM_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PSM_ROLE"))
    const ALLOWANCE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER_ROLE"))
    const REBASER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REBASER_ROLE"))
    const BUFFER_WITHDRAWER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BUFFER_WITHDRAWER_ROLE"))
    const QUEUE_PROCESSOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PROCESSOR_ROLE"))
    const DEPOSIT_AMOUNT = parseUnits("10000", 6) // 10,000 USDC (6 decimals)
    const DECIMAL_MULTIPLIER = 10n ** 12n // Convert USDC (6 decimals) to OkuUSD (18 decimals)

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

        // Connect to mainnet USDC
        usdc = IERC20__factory.connect(USDC_MAINNET, Bob)
    })

    it("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000") // 1 billion

        // Deploy OkuUSD first (needed by wOkuUSD)
        // initialize(name, symbol, admin, initialMaxSupply)
        okuUSD = await upgrades.deployProxy(
            new OkuUSD__factory(Frank),
            ["OkuUSD", "OKUSD", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUSD.waitForDeployment()

        // Deploy wOkuUSD (needs OkuUSD address)
        // initialize(asset_, name, symbol, admin)
        wokuUSD = await upgrades.deployProxy(
            new WOkuUSD__factory(Frank),
            [await okuUSD.getAddress(), "Wrapped OkuUSD", "wOKUSD", frankAddr],
            { kind: "uups" }
        ) as unknown as WOkuUSD
        await wokuUSD.waitForDeployment()

        // Deploy RedemptionQueue
        // initialize(_okuUSD, admin)
        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        // Deploy LitePSM (needs OkuUSD, Queue, and a USDC address)
        // initialize(_okuUSD, _usdc, _redemptionQueue, admin)
        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuUSD.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        // Deploy OkuBridgeRouter
        // initialize(_wOkuUSD, _okuUSD, admin)
        okuBridgeRouter = await upgrades.deployProxy(
            new OkuBridgeRouter__factory(Frank),
            [await wokuUSD.getAddress(), await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as OkuBridgeRouter
        await okuBridgeRouter.waitForDeployment()

        // Grant MINTER_ROLE to PSM so it can mint OkuUSD
        await okuUSD.connect(Frank).grantRole(MINTER_ROLE, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuUSD.connect(Frank).grantRole(ALLOWANCE_MANAGER_ROLE, frankAddr)
        await okuUSD.connect(Frank).grantRole(REBASER_ROLE, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER_ROLE, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR_ROLE, frankAddr)

        // Configure minter allowance for PSM (1 billion tokens)
        await okuUSD.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )

        // Grant PSM_ROLE to PSM on RedemptionQueue
        await queue.connect(Frank).grantRole(PSM_ROLE, await psm.getAddress())

        // Grant MINTER_ROLE to queue so it can burn OkuUSD when processing
        await okuUSD.connect(Frank).grantRole(MINTER_ROLE, await queue.getAddress())
    })

    it("Deposit", async () => {
        const bobAddr = await Bob.getAddress()
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // Impersonate USDC whale to get USDC for all users
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)

        // Fund whale with ETH for gas
        await Frank.sendTransaction({
            to: USDC_WHALE,
            value: parseEther("1")
        })

        // Transfer USDC from whale to all users
        await usdc.connect(whale).transfer(aliceAddr, DEPOSIT_AMOUNT)
        await usdc.connect(whale).transfer(charlieAddr, DEPOSIT_AMOUNT)
        await usdc.connect(whale).transfer(bobAddr, DEPOSIT_AMOUNT)
        await usdc.connect(whale).transfer(daveAddr, DEPOSIT_AMOUNT)

        // Stop impersonating
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        // All users approve PSM to spend USDC
        await usdc.connect(Alice).approve(psmAddr, DEPOSIT_AMOUNT)
        await usdc.connect(Charlie).approve(psmAddr, DEPOSIT_AMOUNT)
        await usdc.connect(Bob).approve(psmAddr, DEPOSIT_AMOUNT)
        await usdc.connect(Dave).approve(psmAddr, DEPOSIT_AMOUNT)

        // All users deposit USDC via PSM.mint() and receive OkuUSD
        await psm.connect(Alice).mint(DEPOSIT_AMOUNT)
        await psm.connect(Charlie).mint(DEPOSIT_AMOUNT)
        await psm.connect(Bob).mint(DEPOSIT_AMOUNT)
        await psm.connect(Dave).mint(DEPOSIT_AMOUNT)

        // Verify all users received OkuUSD (converted from 6 to 18 decimals)
        const aliceOkuUSD = await okuUSD.balanceOf(aliceAddr)
        const charlieOkuUSD = await okuUSD.balanceOf(charlieAddr)
        const bobOkuUSD = await okuUSD.balanceOf(bobAddr)
        const daveOkuUSD = await okuUSD.balanceOf(daveAddr)

        const expectedOkuUSD = DEPOSIT_AMOUNT * DECIMAL_MULTIPLIER
        expect(aliceOkuUSD).to.equal(expectedOkuUSD)
        expect(charlieOkuUSD).to.equal(expectedOkuUSD)
        expect(bobOkuUSD).to.equal(expectedOkuUSD)
        expect(daveOkuUSD).to.equal(expectedOkuUSD)

        // Verify PSM received all the USDC
        const psmUsdc = await usdc.balanceOf(psmAddr)
        expect(psmUsdc).to.equal(DEPOSIT_AMOUNT * 4n)
    })

    it("Rebase", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()

        const aliceBefore = await okuUSD.balanceOf(aliceAddr)
        const charlieBefore = await okuUSD.balanceOf(charlieAddr)
        const bobBefore = await okuUSD.balanceOf(bobAddr)
        const daveBefore = await okuUSD.balanceOf(daveAddr)

        // Get current multiplier
        const multiplierBefore = await okuUSD.rewardMultiplier()

        // Admin increases multiplier by 5% (simulating yield accrual)
        const newMultiplier = multiplierBefore * 105n / 100n
        await okuUSD.connect(Frank).updateRewardMultiplier(newMultiplier)

        // Verify all users' balances increased by 5%
        const aliceAfter = await okuUSD.balanceOf(aliceAddr)
        const charlieAfter = await okuUSD.balanceOf(charlieAddr)
        const bobAfter = await okuUSD.balanceOf(bobAddr)
        const daveAfter = await okuUSD.balanceOf(daveAddr)

        expect(aliceAfter).to.equal(aliceBefore * 105n / 100n)
        expect(charlieAfter).to.equal(charlieBefore * 105n / 100n)
        expect(bobAfter).to.equal(bobBefore * 105n / 100n)
        expect(daveAfter).to.equal(daveBefore * 105n / 100n)
    })

    it("Withdraw with insufficient reserves", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()
        const queueAddr = await queue.getAddress()

        // First, drain the PSM reserves (admin withdraws all USDC)
        const psmBalance = await usdc.balanceOf(psmAddr)
        await psm.connect(Frank).withdrawUSDC(await Frank.getAddress(), psmBalance)

        // Verify PSM is empty
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)

        // Get all users' balances - they will each redeem half
        const aliceBalance = await okuUSD.balanceOf(aliceAddr)
        const charlieBalance = await okuUSD.balanceOf(charlieAddr)
        const bobBalance = await okuUSD.balanceOf(bobAddr)
        const daveBalance = await okuUSD.balanceOf(daveAddr)

        const aliceRedeemAmount = aliceBalance / 2n
        const charlieRedeemAmount = charlieBalance / 2n
        const bobRedeemAmount = bobBalance / 2n
        const daveRedeemAmount = daveBalance / 2n

        // All users approve PSM and Queue to handle their OkuUSD
        await okuUSD.connect(Alice).approve(psmAddr, aliceRedeemAmount)
        await okuUSD.connect(Alice).approve(queueAddr, aliceRedeemAmount)
        await okuUSD.connect(Charlie).approve(psmAddr, charlieRedeemAmount)
        await okuUSD.connect(Charlie).approve(queueAddr, charlieRedeemAmount)
        await okuUSD.connect(Bob).approve(psmAddr, bobRedeemAmount)
        await okuUSD.connect(Bob).approve(queueAddr, bobRedeemAmount)
        await okuUSD.connect(Dave).approve(psmAddr, daveRedeemAmount)
        await okuUSD.connect(Dave).approve(queueAddr, daveRedeemAmount)

        // Users redeem in order: Alice, Charlie, Bob, Dave (FIFO queue order)
        await psm.connect(Alice).redeem(aliceRedeemAmount)
        await psm.connect(Charlie).redeem(charlieRedeemAmount)
        await psm.connect(Bob).redeem(bobRedeemAmount)
        await psm.connect(Dave).redeem(daveRedeemAmount)

        // Verify all 4 users are in the queue
        expect(await queue.queueLength()).to.equal(4)

        // Each user still has half their OkuUSD (the other half is locked in queue)
        expect(await okuUSD.balanceOf(aliceAddr)).to.equal(aliceBalance - aliceRedeemAmount)
        expect(await okuUSD.balanceOf(charlieAddr)).to.equal(charlieBalance - charlieRedeemAmount)
        expect(await okuUSD.balanceOf(bobAddr)).to.equal(bobBalance - bobRedeemAmount)
        expect(await okuUSD.balanceOf(daveAddr)).to.equal(daveBalance - daveRedeemAmount)
    })

    it("Rebalance reserves", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // Get all users' USDC balances before
        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
        const bobUsdcBefore = await usdc.balanceOf(bobAddr)
        const daveUsdcBefore = await usdc.balanceOf(daveAddr)

        // Admin replenishes PSM with USDC (impersonate whale)
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)

        // Transfer USDC to PSM - need enough for all 4 users' queued redemptions
        // Each user queued half their balance (~5,250 USDC after 5% rebase), so ~21,000 total
        const replenishAmount = parseUnits("50000", 6)
        await usdc.connect(whale).transfer(psmAddr, replenishAmount)

        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        // Admin processes the queue
        await psm.connect(Frank).processQueue(10)

        // Verify queue is now empty
        expect(await queue.queueLength()).to.equal(0)

        // Verify all users received USDC
        const aliceUsdcAfter = await usdc.balanceOf(aliceAddr)
        const charlieUsdcAfter = await usdc.balanceOf(charlieAddr)
        const bobUsdcAfter = await usdc.balanceOf(bobAddr)
        const daveUsdcAfter = await usdc.balanceOf(daveAddr)

        expect(aliceUsdcAfter).to.be.gt(aliceUsdcBefore)
        expect(charlieUsdcAfter).to.be.gt(charlieUsdcBefore)
        expect(bobUsdcAfter).to.be.gt(bobUsdcBefore)
        expect(daveUsdcAfter).to.be.gt(daveUsdcBefore)

        // Each user should have received ~5,250 USDC (10,000 * 1.05 / 2)
        // Check the delta (USDC received), not total balance
        const expectedPayout = parseUnits("5250", 6)
        const aliceReceived = aliceUsdcAfter - aliceUsdcBefore
        const charlieReceived = charlieUsdcAfter - charlieUsdcBefore
        const bobReceived = bobUsdcAfter - bobUsdcBefore
        const daveReceived = daveUsdcAfter - daveUsdcBefore

        expect(aliceReceived).to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect(charlieReceived).to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect(bobReceived).to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect(daveReceived).to.be.closeTo(expectedPayout, parseUnits("1", 6))
    })

    it("Withdraw", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // Get all users' remaining OkuUSD
        const aliceOkuUSD = await okuUSD.balanceOf(aliceAddr)
        const charlieOkuUSD = await okuUSD.balanceOf(charlieAddr)
        const bobOkuUSD = await okuUSD.balanceOf(bobAddr)
        const daveOkuUSD = await okuUSD.balanceOf(daveAddr)

        // Get all users' USDC before
        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
        const bobUsdcBefore = await usdc.balanceOf(bobAddr)
        const daveUsdcBefore = await usdc.balanceOf(daveAddr)

        // All users approve PSM to spend their remaining OkuUSD
        await okuUSD.connect(Alice).approve(psmAddr, aliceOkuUSD)
        await okuUSD.connect(Charlie).approve(psmAddr, charlieOkuUSD)
        await okuUSD.connect(Bob).approve(psmAddr, bobOkuUSD)
        await okuUSD.connect(Dave).approve(psmAddr, daveOkuUSD)

        // All users redeem remaining OkuUSD for USDC
        await psm.connect(Alice).redeem(aliceOkuUSD)
        await psm.connect(Charlie).redeem(charlieOkuUSD)
        await psm.connect(Bob).redeem(bobOkuUSD)
        await psm.connect(Dave).redeem(daveOkuUSD)

        // Verify all users' OkuUSD is now 0
        expect(await okuUSD.balanceOf(aliceAddr)).to.equal(0)
        expect(await okuUSD.balanceOf(charlieAddr)).to.equal(0)
        expect(await okuUSD.balanceOf(bobAddr)).to.equal(0)
        expect(await okuUSD.balanceOf(daveAddr)).to.equal(0)

        // Verify all users received USDC
        const aliceUsdcAfter = await usdc.balanceOf(aliceAddr)
        const charlieUsdcAfter = await usdc.balanceOf(charlieAddr)
        const bobUsdcAfter = await usdc.balanceOf(bobAddr)
        const daveUsdcAfter = await usdc.balanceOf(daveAddr)

        expect(aliceUsdcAfter).to.be.gt(aliceUsdcBefore)
        expect(charlieUsdcAfter).to.be.gt(charlieUsdcBefore)
        expect(bobUsdcAfter).to.be.gt(bobUsdcBefore)
        expect(daveUsdcAfter).to.be.gt(daveUsdcBefore)

        // Each user should have received ~5,250 USDC (their remaining half after rebase)
        // Total USDC received across both redemptions should be ~10,500 (original + 5% yield)
        const expectedSecondPayout = parseUnits("5250", 6)
        const aliceReceived = aliceUsdcAfter - aliceUsdcBefore
        const charlieReceived = charlieUsdcAfter - charlieUsdcBefore
        const bobReceived = bobUsdcAfter - bobUsdcBefore
        const daveReceived = daveUsdcAfter - daveUsdcBefore

        expect(aliceReceived).to.be.closeTo(expectedSecondPayout, parseUnits("1", 6))
        expect(charlieReceived).to.be.closeTo(expectedSecondPayout, parseUnits("1", 6))
        expect(bobReceived).to.be.closeTo(expectedSecondPayout, parseUnits("1", 6))
        expect(daveReceived).to.be.closeTo(expectedSecondPayout, parseUnits("1", 6))
    })
})
