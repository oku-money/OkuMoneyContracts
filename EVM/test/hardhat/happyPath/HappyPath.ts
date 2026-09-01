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
import { expect } from "chai"
import { getTokenAddress, getWhaleAddress } from "../../../scripts/config/chains"
import { setMultiplierTo } from "../helpers/yieldEpoch"

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
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const PSM_BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_WITHDRAWER"))
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
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr, parseEther("0.95")],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuDollar
        await okuUsd.waitForDeployment()

        // Deploy RedemptionQueue (now requires _usdc for decimal multiplier resolution)

        // Deploy LitePSM (needs OkuMoney, OkuDollar, USDC, Queue, admin)
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

        // Configure minter allowance for PSM (1 billion tokens)
        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )

        // Grant PSM to PSM on RedemptionQueue

        // Grant MINTER to queue so it can burn OkuMoney when processing
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
        await setMultiplierTo(okuMoney, Frank, Frank, newPrice)

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

    it("Redemption beyond the buffer reverts (buffer-only, no queue)", async () => {
        const aliceAddr = await Alice.getAddress()
        const psmAddr = await psm.getAddress()

        // Drain the PSM reserves (admin withdraws all USDC)
        const psmBalance = await usdc.balanceOf(psmAddr)
        await psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), psmBalance)
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)

        const aliceBalance = await okuMoney.balanceOf(aliceAddr)
        const aliceRedeemAmount = aliceBalance / 2n
        await okuMoney.connect(Alice).approve(psmAddr, aliceRedeemAmount)

        // Buffer-only: reverts instead of escrowing into a queue.
        await expect(
            psm.connect(Alice).redeemOkuM(aliceRedeemAmount)
        ).to.be.revertedWithCustomError(psm, "InsufficientBuffer")

        // The user keeps their OkuM — nothing was taken.
        expect(await okuMoney.balanceOf(aliceAddr)).to.equal(aliceBalance)
    })

    it("Redemptions succeed once the operator refills the buffer", async () => {
        const aliceAddr = await Alice.getAddress()
        const charlieAddr = await Charlie.getAddress()
        const bobAddr = await Bob.getAddress()
        const daveAddr = await Dave.getAddress()
        const psmAddr = await psm.getAddress()

        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const charlieUsdcBefore = await usdc.balanceOf(charlieAddr)
        const bobUsdcBefore = await usdc.balanceOf(bobAddr)
        const daveUsdcBefore = await usdc.balanceOf(daveAddr)

        // Operator refills the buffer (impersonate whale).
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale).transfer(psmAddr, parseUnits("50000", 6))
        await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [USDC_WHALE]
        })

        // Now each user redeems half their balance successfully.
        for (const [signer, addr] of [
            [Alice, aliceAddr],
            [Charlie, charlieAddr],
            [Bob, bobAddr],
            [Dave, daveAddr],
        ] as const) {
            const bal = await okuMoney.balanceOf(addr)
            const amt = bal / 2n
            await okuMoney.connect(signer).approve(psmAddr, amt)
            await psm.connect(signer).redeemOkuM(amt)
        }

        // Each user received ~5,250 USDC (10,000 * 1.05 / 2).
        const expectedPayout = parseUnits("5250", 6)
        expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore).to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect((await usdc.balanceOf(charlieAddr)) - charlieUsdcBefore).to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect((await usdc.balanceOf(bobAddr)) - bobUsdcBefore).to.be.closeTo(expectedPayout, parseUnits("1", 6))
        expect((await usdc.balanceOf(daveAddr)) - daveUsdcBefore).to.be.closeTo(expectedPayout, parseUnits("1", 6))
    })

    it("Partial buffer: redemptions within the buffer succeed, larger ones revert", async () => {
        const aliceAddr = await Alice.getAddress()
        const bobAddr = await Bob.getAddress()
        const psmAddr = await psm.getAddress()

        // Drain, then re-fund with only enough for roughly one user.
        const psmBalance = await usdc.balanceOf(psmAddr)
        await psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), psmBalance)
        expect(await usdc.balanceOf(psmAddr)).to.equal(0)

        const partialBuffer = parseUnits("2000", 6)
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

        // Alice redeems an amount inside the buffer: succeeds.
        const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)
        const smallAmount = parseEther("1000")
        await okuMoney.connect(Alice).approve(psmAddr, smallAmount)
        await psm.connect(Alice).redeemOkuM(smallAmount)
        expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore).to.be.gt(0n)

        // Bob attempts his whole balance, which now exceeds the remaining buffer.
        const bobBalance = await okuMoney.balanceOf(bobAddr)
        await okuMoney.connect(Bob).approve(psmAddr, bobBalance)
        await expect(
            psm.connect(Bob).redeemOkuM(bobBalance)
        ).to.be.revertedWithCustomError(psm, "InsufficientBuffer")
        expect(await okuMoney.balanceOf(bobAddr)).to.equal(bobBalance)
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

        // Each user receives their remaining OkuM valued at the current multiplier.
        // Derive the expectation rather than hardcoding it: earlier steps in this
        // suite leave different residual balances per user, and the multiplier has
        // appreciated, so a fixed figure would silently encode one particular path
        // through the preceding tests.
        const mult = await okuMoney.okuMMultiplier()
        const expected = (okuM: bigint) => (okuM * mult) / (10n ** 18n) / DECIMAL_MULTIPLIER

        expect(aliceUsdcAfter - aliceUsdcBefore).to.be.closeTo(expected(aliceOkuM), parseUnits("1", 6))
        expect(charlieUsdcAfter - charlieUsdcBefore).to.be.closeTo(expected(charlieOkuM), parseUnits("1", 6))
        expect(bobUsdcAfter - bobUsdcBefore).to.be.closeTo(expected(bobOkuM), parseUnits("1", 6))
        expect(daveUsdcAfter - daveUsdcBefore).to.be.closeTo(expected(daveOkuM), parseUnits("1", 6))
    })
})
