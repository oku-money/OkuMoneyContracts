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

describe("wOkuUSD Scenarios", () => {
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
        await psm.connect(user).mint(usdcAmount)
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

    describe("Wrap/Unwrap Round-Trip", () => {
        it("Deposit OkuUSD and redeem with minimal loss", async () => {
            const aliceAddr = await Alice.getAddress()
            const wokuUSDAddr = await wokuUSD.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuUSD via PSM
            await getOkuUSD(Alice, depositAmount)

            const okuUSDBalance = await okuUSD.balanceOf(aliceAddr)
            expect(okuUSDBalance).to.be.gt(0)

            // Deposit OkuUSD into wOkuUSD vault
            await okuUSD.connect(Alice).approve(wokuUSDAddr, okuUSDBalance)
            const sharesBefore = await wokuUSD.balanceOf(aliceAddr)
            await wokuUSD.connect(Alice).deposit(okuUSDBalance, aliceAddr)

            const sharesReceived = await wokuUSD.balanceOf(aliceAddr)
            expect(sharesReceived).to.be.gt(sharesBefore)

            // Verify vault invariant
            const vaultOkuUSD = await okuUSD.balanceOf(wokuUSDAddr)
            const totalAssets = await wokuUSD.totalAssets()
            expect(vaultOkuUSD).to.equal(totalAssets)

            // Redeem all shares immediately
            const okuUSDBefore = await okuUSD.balanceOf(aliceAddr)
            await wokuUSD.connect(Alice).redeem(sharesReceived, aliceAddr, aliceAddr)

            const okuUSDAfter = await okuUSD.balanceOf(aliceAddr)
            const okuUSDReturned = okuUSDAfter - okuUSDBefore

            // Should get back original amount (± 1 wei rounding)
            expect(okuUSDReturned).to.be.closeTo(okuUSDBalance, 1n)

            // Vault should be empty
            expect(await wokuUSD.totalAssets()).to.equal(0)
        })
    })

    describe("Exchange Rate After Rebase", () => {
        it("wOkuUSD value increases when underlying OkuUSD rebases", async () => {
            const aliceAddr = await Alice.getAddress()
            const wokuUSDAddr = await wokuUSD.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuUSD via PSM
            await getOkuUSD(Alice, depositAmount)
            const okuUSDBalance = await okuUSD.balanceOf(aliceAddr)

            // Deposit into vault
            await okuUSD.connect(Alice).approve(wokuUSDAddr, okuUSDBalance)
            await wokuUSD.connect(Alice).deposit(okuUSDBalance, aliceAddr)

            const shares = await wokuUSD.balanceOf(aliceAddr)

            // Record initial exchange rate (assets per share)
            const initialAssetsPerShare = await wokuUSD.convertToAssets(parseEther("1"))

            // Admin performs 10% rebase
            const multiplierBefore = await okuUSD.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuUSD.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Exchange rate should have increased
            const newAssetsPerShare = await wokuUSD.convertToAssets(parseEther("1"))
            expect(newAssetsPerShare).to.be.gt(initialAssetsPerShare)

            // Redeem shares
            const okuUSDBefore = await okuUSD.balanceOf(aliceAddr)
            await wokuUSD.connect(Alice).redeem(shares, aliceAddr, aliceAddr)
            const okuUSDAfter = await okuUSD.balanceOf(aliceAddr)

            const okuUSDReturned = okuUSDAfter - okuUSDBefore

            // Should receive more than deposited (~10% more)
            expect(okuUSDReturned).to.be.gt(okuUSDBalance)

            // Verify approximately 10% yield
            const expectedReturn = okuUSDBalance * 110n / 100n
            expect(okuUSDReturned).to.be.closeTo(expectedReturn, parseEther("1"))
        })
    })

    describe("Multiple Depositors Share Accounting", () => {
        it("Multiple users share vault proportionally and benefit from rebase", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const wokuUSDAddr = await wokuUSD.getAddress()

            // Different deposit amounts (1:2:3 ratio)
            const aliceDeposit = parseUnits("10000", 6)
            const bobDeposit = parseUnits("20000", 6)
            const charlieDeposit = parseUnits("30000", 6)

            // Record initial wOkuUSD balances (may have shares from previous tests)
            const aliceSharesBefore = await wokuUSD.balanceOf(aliceAddr)
            const bobSharesBefore = await wokuUSD.balanceOf(bobAddr)
            const charlieSharesBefore = await wokuUSD.balanceOf(charlieAddr)

            // All users get OkuUSD
            await getOkuUSD(Alice, aliceDeposit)
            await getOkuUSD(Bob, bobDeposit)
            await getOkuUSD(Charlie, charlieDeposit)

            // Calculate OkuUSD amounts received (USDC deposits converted to OkuUSD in 18 decimals)
            const aliceOkuUSD = parseEther("10000")
            const bobOkuUSD = parseEther("20000")
            const charlieOkuUSD = parseEther("30000")

            await okuUSD.connect(Alice).approve(wokuUSDAddr, aliceOkuUSD)
            await okuUSD.connect(Bob).approve(wokuUSDAddr, bobOkuUSD)
            await okuUSD.connect(Charlie).approve(wokuUSDAddr, charlieOkuUSD)

            await wokuUSD.connect(Alice).deposit(aliceOkuUSD, aliceAddr)
            await wokuUSD.connect(Bob).deposit(bobOkuUSD, bobAddr)
            await wokuUSD.connect(Charlie).deposit(charlieOkuUSD, charlieAddr)

            // Calculate shares gained in this test only
            const aliceSharesGained = (await wokuUSD.balanceOf(aliceAddr)) - aliceSharesBefore
            const bobSharesGained = (await wokuUSD.balanceOf(bobAddr)) - bobSharesBefore
            const charlieSharesGained = (await wokuUSD.balanceOf(charlieAddr)) - charlieSharesBefore

            // Verify proportional shares (1:2:3 ratio approximately)
            expect(bobSharesGained).to.be.closeTo(aliceSharesGained * 2n, aliceSharesGained / 10n)
            expect(charlieSharesGained).to.be.closeTo(aliceSharesGained * 3n, aliceSharesGained / 10n)

            // Admin performs 10% rebase
            const multiplierBefore = await okuUSD.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuUSD.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Users withdraw their gained shares in reverse order
            const charlieOkuUSDBefore = await okuUSD.balanceOf(charlieAddr)
            await wokuUSD.connect(Charlie).redeem(charlieSharesGained, charlieAddr, charlieAddr)
            const charlieReceived = (await okuUSD.balanceOf(charlieAddr)) - charlieOkuUSDBefore

            const bobOkuUSDBefore = await okuUSD.balanceOf(bobAddr)
            await wokuUSD.connect(Bob).redeem(bobSharesGained, bobAddr, bobAddr)
            const bobReceived = (await okuUSD.balanceOf(bobAddr)) - bobOkuUSDBefore

            const aliceOkuUSDBefore = await okuUSD.balanceOf(aliceAddr)
            await wokuUSD.connect(Alice).redeem(aliceSharesGained, aliceAddr, aliceAddr)
            const aliceReceived = (await okuUSD.balanceOf(aliceAddr)) - aliceOkuUSDBefore

            // All users should receive ~10% more than deposited
            expect(aliceReceived).to.be.closeTo(aliceOkuUSD * 110n / 100n, parseEther("1"))
            expect(bobReceived).to.be.closeTo(bobOkuUSD * 110n / 100n, parseEther("1"))
            expect(charlieReceived).to.be.closeTo(charlieOkuUSD * 110n / 100n, parseEther("1"))
        })
    })
})
