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

describe("Happy Path Testing", () => {
    //actors
    let Frank: Signer //admin
    let Bob: Signer // user
    let Alice: Signer
    let Charlie: Signer
    let Dave: Signer

    //contracts
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuMoney: OkuMoney
    let okuUsd: OkuDollar

    // USDC contract
    let usdc: ReturnType<typeof IERC20__factory.connect>

    // Constants (role names must match contract constants)
    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
    const OKUM_BURNER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BURNER"))
    const QUEUE_PSM = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PSM"))
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"))
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const PSM_BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_WITHDRAWER"))
    const PSM_QUEUE_PROCESSOR = ethers.keccak256(ethers.toUtf8Bytes("PSM_QUEUE_PROCESSOR"))
    const DEPOSIT_AMOUNT = parseUnits("10000", 6) // 10,000 USDC (6 decimals)
    const DECIMAL_MULTIPLIER = 10n ** 12n // Convert USDC (6 decimals) to OkuMoney (18 decimals)

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
        Dave = signers[4]

        // Connect to mainnet USDC
        usdc = IERC20__factory.connect(USDC_MAINNET, Bob)
    })

    before("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000") // 1 billion

        // Deploy OkuMoney first (base rebasing token)
        okuMoney = await upgrades.deployProxy(
            new OkuMoney__factory(Frank),
            ["OkuMoney", "OkuM", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuMoney
        await okuMoney.waitForDeployment()

        // Deploy OkuDollar vault (needs OkuMoney address)
        okuUsd = await upgrades.deployProxy(
            new OkuDollar__factory(Frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuDollar
        await okuUsd.waitForDeployment()

        // Deploy RedemptionQueue (now requires _usdc for decimal multiplier resolution)
        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuMoney.getAddress(), USDC_MAINNET, frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        // Deploy LitePSM (needs OkuMoney, OkuDollar, USDC, Queue, admin)
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

        // Grant MINTER to PSM so it can mint OkuMoney
        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuMoney.connect(Frank).grantRole(OKUM_ALLOWANCE_MANAGER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_REBASER, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(PSM_BUFFER_WITHDRAWER, frankAddr)
        await psm.connect(Frank).grantRole(PSM_QUEUE_PROCESSOR, frankAddr)

        // Configure minter allowance for PSM (1 billion tokens)
        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )

        // Grant PSM to PSM on RedemptionQueue
        await queue.connect(Frank).grantRole(QUEUE_PSM, await psm.getAddress())

        // Grant MINTER to queue so it can burn OkuMoney when processing
        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await queue.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await queue.getAddress())
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

        // All users deposit USDC via PSM.mintOkuM() and receive OkuMoney
        await psm.connect(Alice).mintOkuM(DEPOSIT_AMOUNT)
        await psm.connect(Charlie).mintOkuM(DEPOSIT_AMOUNT)
        await psm.connect(Bob).mintOkuM(DEPOSIT_AMOUNT)
        await psm.connect(Dave).mintOkuM(DEPOSIT_AMOUNT)

        // Verify all users received OkuMoney (converted from 6 to 18 decimals)
        const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
        const charlieOkuM = await okuMoney.balanceOf(charlieAddr)
        const bobOkuM = await okuMoney.balanceOf(bobAddr)
        const daveOkuM = await okuMoney.balanceOf(daveAddr)

        const expectedOkuM = DEPOSIT_AMOUNT * DECIMAL_MULTIPLIER
        expect(aliceOkuM).to.equal(expectedOkuM)
        expect(charlieOkuM).to.equal(expectedOkuM)
        expect(bobOkuM).to.equal(expectedOkuM)
        expect(daveOkuM).to.equal(expectedOkuM)

        // Verify PSM received all the USDC
        const psmUsdc = await usdc.balanceOf(psmAddr)
        expect(psmUsdc).to.equal(DEPOSIT_AMOUNT * 4n)
    })

    it("NotePrice Update", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()

        const aliceBefore = await okuMoney.balanceOf(aliceAddr)
        const charlieBefore = await okuMoney.balanceOf(charlieAddr)
        const bobBefore = await okuMoney.balanceOf(bobAddr)
        const daveBefore = await okuMoney.balanceOf(daveAddr)

        // Get current notePrice
        const priceBefore = await okuMoney.okuMMultiplier()

        // Admin increases notePrice by 5% (simulating yield accrual)
        const newPrice = priceBefore * 105n / 100n
        await okuMoney.connect(Frank).setOkuMMultiplier(newPrice)

        // Verify notePrice increased
        expect(await okuMoney.okuMMultiplier()).to.equal(newPrice)

        // Balances should be UNCHANGED (non-rebasing)
        const aliceAfter = await okuMoney.balanceOf(aliceAddr)
        const charlieAfter = await okuMoney.balanceOf(charlieAddr)
        const bobAfter = await okuMoney.balanceOf(bobAddr)
        const daveAfter = await okuMoney.balanceOf(daveAddr)

        expect(aliceAfter).to.equal(aliceBefore)
        expect(charlieAfter).to.equal(charlieBefore)
        expect(bobAfter).to.equal(bobBefore)
        expect(daveAfter).to.equal(daveBefore)
    })

    it("Withdraw with insufficient reserves", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // First, drain the PSM reserves (admin withdraws all USDC)
        const psmBalance = await usdc.balanceOf(psmAddr)
        await psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), psmBalance)

        // Verify PSM is empty
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)

        // Get all users' balances - they will each redeem half
        const aliceBalance = await okuMoney.balanceOf(aliceAddr)
        const charlieBalance = await okuMoney.balanceOf(charlieAddr)
        const bobBalance = await okuMoney.balanceOf(bobAddr)
        const daveBalance = await okuMoney.balanceOf(daveAddr)

        const aliceRedeemAmount = aliceBalance / 2n
        const charlieRedeemAmount = charlieBalance / 2n
        const bobRedeemAmount = bobBalance / 2n
        const daveRedeemAmount = daveBalance / 2n

        // All users approve PSM to handle their OkuMoney
        // PSM handles the transfer to queue internally — no queue approval needed
        await okuMoney.connect(Alice).approve(psmAddr, aliceRedeemAmount)
        await okuMoney.connect(Charlie).approve(psmAddr, charlieRedeemAmount)
        await okuMoney.connect(Bob).approve(psmAddr, bobRedeemAmount)
        await okuMoney.connect(Dave).approve(psmAddr, daveRedeemAmount)

        // Users redeem in order: Alice, Charlie, Bob, Dave (FIFO queue order)
        await psm.connect(Alice).redeemOkuM(aliceRedeemAmount)
        await psm.connect(Charlie).redeemOkuM(charlieRedeemAmount)
        await psm.connect(Bob).redeemOkuM(bobRedeemAmount)
        await psm.connect(Dave).redeemOkuM(daveRedeemAmount)

        // Verify all 4 users are in the queue
        expect(await queue.queueLength()).to.equal(4)

        // Each user still has half their OkuDollar (the other half is locked in queue)
        expect(await okuMoney.balanceOf(aliceAddr)).to.equal(aliceBalance - aliceRedeemAmount)
        expect(await okuMoney.balanceOf(charlieAddr)).to.equal(charlieBalance - charlieRedeemAmount)
        expect(await okuMoney.balanceOf(bobAddr)).to.equal(bobBalance - bobRedeemAmount)
        expect(await okuMoney.balanceOf(daveAddr)).to.equal(daveBalance - daveRedeemAmount)
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
        const headBefore = await queue.queueHead()
        const tailBefore = await queue.queueTail()
        await psm.connect(Frank).processQueue(headBefore, tailBefore, parseUnits("50000", 6))
        // processQueue no longer auto-advances the cursor; drive it forward.
        await queue.advanceHead(tailBefore - headBefore)

        // Verify queue is now empty
        expect(await queue.queueLength()).to.equal(0)

        // Verify all users received USDC
        const aliceUsdcAfter = await usdc.balanceOf(aliceAddr)
        const charlieUsdcAfter = await usdc.balanceOf(charlieAddr)
        const bobUsdcAfter = await usdc.balanceOf(bobAddr)
        const daveUsdcAfter = await usdc.balanceOf(daveAddr)

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

    it("Partial buffer redemption (mixed instant + queued)", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // Each user has ~5,250 OkuDollar remaining after the previous steps.
        // Drain the PSM, then re-fund with only enough USDC for ~2 users
        // so the first two redemptions are instant and the last two get queued.
        const psmBalance = await usdc.balanceOf(psmAddr)
        await psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), psmBalance)
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)

        // Replenish with only enough for 2 users (~5,250 USDC)
        const partialBuffer = parseUnits("5250", 6)
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale).transfer(psmAddr, partialBuffer)
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        // Each user will try to redeem ~2,625 OkuDollar (half their remaining balance)
        const aliceBalance = await okuMoney.balanceOf(aliceAddr)
        const charlieBalance = await okuMoney.balanceOf(charlieAddr)
        const bobBalance = await okuMoney.balanceOf(bobAddr)
        const daveBalance = await okuMoney.balanceOf(daveAddr)

        const aliceRedeem = aliceBalance / 2n
        const charlieRedeem = charlieBalance / 2n
        const bobRedeem = bobBalance / 2n
        const daveRedeem = daveBalance / 2n

        // Approve PSM for all users — PSM handles the transfer to queue internally
        await okuMoney.connect(Alice).approve(psmAddr, aliceRedeem)
        await okuMoney.connect(Charlie).approve(psmAddr, charlieRedeem)
        await okuMoney.connect(Bob).approve(psmAddr, bobRedeem)
        await okuMoney.connect(Dave).approve(psmAddr, daveRedeem)

        // Snapshot USDC balances before redemptions
        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
        const bobUsdcBefore = await usdc.balanceOf(bobAddr)
        const daveUsdcBefore = await usdc.balanceOf(daveAddr)

        // Alice and Charlie redeem first. The buffer was re-funded with exactly
        // 5,250 USDC above -- NOT ~10,500, which a stale comment here claimed
        // and which is 2x the actual figure. Each user redeems half of a ~5,250
        // position, so 2,625 each is exactly the buffer, and the pair of them
        // drains it to zero. That is the boundary this test is named for.
        const expectedPayout = parseUnits("2625", 6)
        await psm.connect(Alice).redeemOkuM(aliceRedeem)
        await psm.connect(Charlie).redeemOkuM(charlieRedeem)

        // Both paid instantly, in full, and the buffer is exactly exhausted.
        const aliceUsdcAfterInstant = await usdc.balanceOf(aliceAddr)
        const charlieUsdcAfterInstant = await usdc.balanceOf(charlieAddr)
        expect(aliceUsdcAfterInstant - aliceUsdcBefore, "Alice paid instantly")
            .to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect(charlieUsdcAfterInstant - charlieUsdcBefore, "Charlie paid instantly")
            .to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect(await usdc.balanceOf(psmAddr), "the two instant redeems drain the buffer")
            .to.be.lt(parseUnits("1", 6))
        expect(await queue.queueLength()).to.equal(0)

        // Bob and Dave redeem — buffer is now depleted, these should be queued
        await psm.connect(Bob).redeemOkuM(bobRedeem)
        await psm.connect(Dave).redeemOkuM(daveRedeem)

        // Verify Bob and Dave are queued
        expect(await queue.queueLength()).to.equal(2)

        // Bob and Dave should NOT have received any USDC
        expect(await usdc.balanceOf(bobAddr)).to.equal(bobUsdcBefore)
        expect(await usdc.balanceOf(daveAddr)).to.equal(daveUsdcBefore)

        // Admin replenishes PSM and processes the queue
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale2 = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale2).transfer(psmAddr, parseUnits("10000", 6))
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        const headBefore2 = await queue.queueHead()
        const tailBefore2 = await queue.queueTail()
        await psm.connect(Frank).processQueue(headBefore2, tailBefore2, parseUnits("10000", 6))
        await queue.advanceHead(tailBefore2 - headBefore2)

        // Queue should now be empty
        expect(await queue.queueLength()).to.equal(0)

        // Bob and Dave are paid out of the queue -- for the same amount as the
        // instant pair, anchored to the absolute expectation rather than only to
        // each other. Comparing the four measured outputs among themselves (the
        // previous version) would pass even if the PSM paid everyone 1 USDC.
        const bobUsdcAfter = await usdc.balanceOf(bobAddr)
        const daveUsdcAfter = await usdc.balanceOf(daveAddr)
        const aliceReceived = aliceUsdcAfterInstant - aliceUsdcBefore
        const charlieReceived = charlieUsdcAfterInstant - charlieUsdcBefore
        const bobReceived = bobUsdcAfter - bobUsdcBefore
        const daveReceived = daveUsdcAfter - daveUsdcBefore

        expect(bobReceived, "Bob paid from the queue").to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect(daveReceived, "Dave paid from the queue").to.be.closeTo(expectedPayout, parseUnits("1", 6))

        // THE PROPERTY THAT MATTERS: the queued path pays the same as the
        // instant path. Equal treatment regardless of which side of the buffer
        // boundary a redemption landed on.
        expect(aliceReceived, "instant and queued pay equally").to.be.closeTo(bobReceived, parseUnits("1", 6))
        expect(charlieReceived, "instant and queued pay equally").to.be.closeTo(daveReceived, parseUnits("1", 6))
    })

    it("Withdraw", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // Ensure PSM has enough USDC for all remaining redemptions
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale).transfer(psmAddr, parseUnits("20000", 6))
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        // Get all users' remaining OkuMoney
        const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
        const charlieOkuM = await okuMoney.balanceOf(charlieAddr)
        const bobOkuM = await okuMoney.balanceOf(bobAddr)
        const daveOkuM = await okuMoney.balanceOf(daveAddr)

        // Get all users' USDC before
        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
        const bobUsdcBefore = await usdc.balanceOf(bobAddr)
        const daveUsdcBefore = await usdc.balanceOf(daveAddr)

        // All users approve PSM to spend their remaining OkuMoney
        await okuMoney.connect(Alice).approve(psmAddr, aliceOkuM)
        await okuMoney.connect(Charlie).approve(psmAddr, charlieOkuM)
        await okuMoney.connect(Bob).approve(psmAddr, bobOkuM)
        await okuMoney.connect(Dave).approve(psmAddr, daveOkuM)

        // All users redeem remaining OkuMoney for USDC
        await psm.connect(Alice).redeemOkuM(aliceOkuM)
        await psm.connect(Charlie).redeemOkuM(charlieOkuM)
        await psm.connect(Bob).redeemOkuM(bobOkuM)
        await psm.connect(Dave).redeemOkuM(daveOkuM)

        // Verify all users' OkuMoney is now 0
        expect(await okuMoney.balanceOf(aliceAddr)).to.equal(0)
        expect(await okuMoney.balanceOf(charlieAddr)).to.equal(0)
        expect(await okuMoney.balanceOf(bobAddr)).to.equal(0)
        expect(await okuMoney.balanceOf(daveAddr)).to.equal(0)

        // Verify all users received USDC
        const aliceUsdcAfter = await usdc.balanceOf(aliceAddr)
        const charlieUsdcAfter = await usdc.balanceOf(charlieAddr)
        const bobUsdcAfter = await usdc.balanceOf(bobAddr)
        const daveUsdcAfter = await usdc.balanceOf(daveAddr)

        // Each user should have received ~2,625 USDC (quarter of post-rebase balance)
        const expectedSecondPayout = parseUnits("2625", 6)
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
