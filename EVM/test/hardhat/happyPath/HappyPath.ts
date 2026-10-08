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

describe("Happy Path Testing", () => {
    //actors
    let Frank: Signer //admin
    let Bob: Signer // user
    let Alice: Signer
    let Charlie: Signer
    let Dave: Signer

    //contracts
    let psm: LitePSM
    let okuMoney: OkuMoney
    let okuUsd: OkuDollar

    // USDC contract
    let usdc: ReturnType<typeof IERC20__factory.connect>

    // Constants (role names must match contract constants)
    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
    const OKUM_BURNER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BURNER"))
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"))
    const OKUM_RATE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_RATE_MANAGER"))
    const PSM_BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_WITHDRAWER"))
    const DEPOSIT_AMOUNT = parseUnits("10000", 6) // 10,000 USDC (6 decimals)
    const DECIMAL_MULTIPLIER = 10n ** 12n // Convert USDC (6 decimals) to OkuMoney (18 decimals)

    // Fund the PSM buffer through the operator entry point (depositBuffer), not a raw transfer.
    async function fundBuffer(whale: Signer, amount: bigint) {
        await usdc.connect(whale).transfer(await Frank.getAddress(), amount)
        await usdc.connect(Frank).approve(await psm.getAddress(), amount)
        await psm.connect(Frank).depositBuffer(amount)
    }

    before(async () => {
        // Reset network to initial fork state for test isolation
        await resetMainnetFork()

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

        // Deploy LitePSM (needs OkuMoney, OkuDollar, USDC, admin)
        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [
                await okuMoney.getAddress(),
                await okuUsd.getAddress(),
                USDC_MAINNET,
                frankAddr
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        // Grant MINTER to PSM so it can mint OkuMoney
        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuMoney.connect(Frank).grantRole(OKUM_ALLOWANCE_MANAGER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_RATE_MANAGER, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(PSM_BUFFER_WITHDRAWER, frankAddr)

        // Configure minter allowance for PSM (1 billion tokens)
        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
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

    it("Redeem with insufficient reserves reverts", async () => {
        const psmAddr = await psm.getAddress()

        // Drain the PSM reserves (admin withdraws all USDC)
        const psmBalance = await usdc.balanceOf(psmAddr)
        await psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), psmBalance)
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)

        // Each user tries to redeem half (5,000 OkuM = 5,250 USDC at m = 1.05). With an
        // empty buffer every redeem reverts and the user keeps their OkuM.
        const expectedUsdc = parseUnits("5250", 6)
        for (const user of [Alice, Charlie, Bob, Dave]) {
            const addr = await user.getAddress()
            const balance = await okuMoney.balanceOf(addr)
            const usdcBefore = await usdc.balanceOf(addr)
            await okuMoney.connect(user).approve(psmAddr, balance / 2n)
            await expect(psm.connect(user).redeemOkuM(balance / 2n))
                .to.be.revertedWithCustomError(psm, "InsufficientBuffer")
                .withArgs(0, expectedUsdc)
            expect(await okuMoney.balanceOf(addr)).to.equal(balance)
            expect(await usdc.balanceOf(addr)).to.equal(usdcBefore)
        }
    })

    it("Rebalance reserves", async () => {
        const psmAddr = await psm.getAddress()

        // Admin replenishes the buffer with exactly the 4 x 5,250 USDC the users need
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await fundBuffer(whale, parseUnits("21000", 6))
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        // The same redemptions now succeed: half of 10,000 OkuM at m = 1.05 is 5,250 USDC
        const expectedPayout = parseUnits("5250", 6)
        for (const user of [Alice, Charlie, Bob, Dave]) {
            const addr = await user.getAddress()
            const balance = await okuMoney.balanceOf(addr)
            const usdcBefore = await usdc.balanceOf(addr)
            await psm.connect(user).redeemOkuM(balance / 2n)
            expect(await usdc.balanceOf(addr) - usdcBefore).to.equal(expectedPayout)
            expect(await okuMoney.balanceOf(addr)).to.equal(balance - balance / 2n)
        }
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)
    })

    it("Partial buffer redemption", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        // Buffer is empty after the previous step. Fund only enough for two users.
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await fundBuffer(whale, parseUnits("5250", 6))

        // Each user redeems half of their remaining 5,000 OkuM: 2,500 OkuM = 2,625 USDC
        const aliceRedeem = (await okuMoney.balanceOf(aliceAddr)) / 2n
        const charlieRedeem = (await okuMoney.balanceOf(charlieAddr)) / 2n
        const bobRedeem = (await okuMoney.balanceOf(bobAddr)) / 2n
        const daveRedeem = (await okuMoney.balanceOf(daveAddr)) / 2n

        await okuMoney.connect(Alice).approve(psmAddr, aliceRedeem)
        await okuMoney.connect(Charlie).approve(psmAddr, charlieRedeem)
        await okuMoney.connect(Bob).approve(psmAddr, bobRedeem)
        await okuMoney.connect(Dave).approve(psmAddr, daveRedeem)

        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
        const bobUsdcBefore = await usdc.balanceOf(bobAddr)
        const daveUsdcBefore = await usdc.balanceOf(daveAddr)

        // Alice and Charlie are paid in full and exactly exhaust the buffer
        const expectedPayout = parseUnits("2625", 6)
        await psm.connect(Alice).redeemOkuM(aliceRedeem)
        await psm.connect(Charlie).redeemOkuM(charlieRedeem)
        expect(await usdc.balanceOf(aliceAddr) - aliceUsdcBefore, "Alice paid").to.equal(expectedPayout)
        expect(await usdc.balanceOf(charlieAddr) - charlieUsdcBefore, "Charlie paid").to.equal(expectedPayout)
        expect(await usdc.balanceOf(psmAddr), "buffer exhausted").to.equal(0)

        // Bob and Dave revert against the empty buffer
        await expect(psm.connect(Bob).redeemOkuM(bobRedeem))
            .to.be.revertedWithCustomError(psm, "InsufficientBuffer")
            .withArgs(0, expectedPayout)
        await expect(psm.connect(Dave).redeemOkuM(daveRedeem))
            .to.be.revertedWithCustomError(psm, "InsufficientBuffer")
            .withArgs(0, expectedPayout)
        expect(await usdc.balanceOf(bobAddr)).to.equal(bobUsdcBefore)
        expect(await usdc.balanceOf(daveAddr)).to.equal(daveUsdcBefore)

        // After a top-up they redeem for the same amount the first pair received
        await fundBuffer(whale, parseUnits("5250", 6))
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })
        await psm.connect(Bob).redeemOkuM(bobRedeem)
        await psm.connect(Dave).redeemOkuM(daveRedeem)
        expect(await usdc.balanceOf(bobAddr) - bobUsdcBefore, "Bob paid").to.equal(expectedPayout)
        expect(await usdc.balanceOf(daveAddr) - daveUsdcBefore, "Dave paid").to.equal(expectedPayout)
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
        await fundBuffer(whale, parseUnits("20000", 6))
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

        expect(aliceReceived).to.equal(expectedSecondPayout)
        expect(charlieReceived).to.equal(expectedSecondPayout)
        expect(bobReceived).to.equal(expectedSecondPayout)
        expect(daveReceived).to.equal(expectedSecondPayout)
    })
})
