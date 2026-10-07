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
import { computeMultiplier, PRECISION } from "@okumoney/yield-tooling"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

describe("LitePSM Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer
    let Dave: Signer

    let psm: LitePSM
    let okuMoney: OkuMoney
    let okuUsd: OkuDollar

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const OKUM_MINTER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER"))
    const OKUM_BURNER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_BURNER"))
    const OKUM_ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_ALLOWANCE_MANAGER"))
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const PSM_BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("PSM_BUFFER_WITHDRAWER"))
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

    // Helper to fund the PSM buffer the way the operator does (depositBuffer)
    async function fundPSM(amount: bigint) {
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [USDC_WHALE]
        })
        const whale = await ethers.getSigner(USDC_WHALE)
        await usdc.connect(whale).transfer(await Frank.getAddress(), amount)
        await usdc.connect(Frank).approve(await psm.getAddress(), amount)
        await psm.connect(Frank).depositBuffer(amount)
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

    before(async () => {
        // Reset network to initial fork state for test isolation
        await resetMainnetFork()

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
        ) as unknown as OkuMoney
        await okuMoney.waitForDeployment()

        okuUsd = await upgrades.deployProxy(
            new OkuDollar__factory(Frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuDollar
        await okuUsd.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            // initialize(_okuMoney, _okuDollar, _usdc, admin)
            [await okuMoney.getAddress(), await okuUsd.getAddress(), USDC_MAINNET, frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        await okuMoney.connect(Frank).grantRole(OKUM_MINTER, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(OKUM_BURNER, await psm.getAddress())

        // Grant RBAC roles to Frank for testing
        await okuMoney.connect(Frank).grantRole(OKUM_ALLOWANCE_MANAGER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_REBASER, frankAddr)
        await psm.connect(Frank).grantRole(PSM_BUFFER_WITHDRAWER, frankAddr)

        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
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
            await psm.connect(Alice).mintOkuM(DEPOSIT_AMOUNT)
            await psm.connect(Bob).mintOkuM(DEPOSIT_AMOUNT)

            // Verify PSM has buffer
            expect(await usdc.balanceOf(psmAddr)).to.equal(DEPOSIT_AMOUNT * 2n)

            // Alice redeems half - should be instant
            const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
            const aliceRedeemAmount = aliceOkuM / 2n
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)

            await okuMoney.connect(Alice).approve(psmAddr, aliceRedeemAmount)
            await psm.connect(Alice).redeemOkuM(aliceRedeemAmount)

            // The /1e12 below is only the 18->6 decimal scaling, which is valid
            // ONLY while the multiplier is 1.0. Pin that, or a silently-rebased
            // deployment would make this look exact while measuring nothing.
            expect(await okuMoney.okuMMultiplier(), "fixture: unrebased").to.equal(10n ** 18n)
            const expectedAliceUsdc = aliceRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore, "instant redeem pays exactly")
                .to.equal(expectedAliceUsdc)

            // Bob redeems half - should also be instant
            const bobOkuM = await okuMoney.balanceOf(bobAddr)
            const bobRedeemAmount = bobOkuM / 2n
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)

            await okuMoney.connect(Bob).approve(psmAddr, bobRedeemAmount)
            await psm.connect(Bob).redeemOkuM(bobRedeemAmount)

            const expectedBobUsdc = bobRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(bobAddr)) - bobUsdcBefore, "instant redeem pays exactly")
                .to.equal(expectedBobUsdc)
        })
    })

    describe("Buffer Depletion", () => {
        it("First users redeem instantly, later users revert once the buffer is exhausted", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const daveAddr = await Dave.getAddress()
            const psmAddr = await psm.getAddress()

            // Ensure clean state
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

            await psm.connect(Alice).mintOkuM(depositAmount)
            await psm.connect(Bob).mintOkuM(depositAmount)
            await psm.connect(Charlie).mintOkuM(depositAmount)
            await psm.connect(Dave).mintOkuM(depositAmount)

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

            // Calculate OkuMoney amount to redeem (deposited 5000 USDC, got 5000 OkuMoney in 18 decimals)
            const redeemOkuM = parseEther("5000")
            const redeemUsdc = parseUnits("5000", 6)

            // Alice redeems 5,000 OkuMoney - INSTANT (buffer: 10,000 -> 5,000)
            await okuMoney.connect(Alice).approve(psmAddr, redeemOkuM)
            await psm.connect(Alice).redeemOkuM(redeemOkuM)

            // 5,000 OkuM at m = 1.0 is exactly 5,000 USDC. `gt(before)` would
            // have passed on a single wei.
            expect(await okuMoney.okuMMultiplier(), "fixture: unrebased").to.equal(10n ** 18n)
            expect(await usdc.balanceOf(aliceAddr), "Alice paid instantly, in full")
                .to.equal(aliceUsdcBefore + redeemUsdc)

            // Bob redeems 5,000 OkuMoney - INSTANT (buffer: 5,000 -> 0)
            await okuMoney.connect(Bob).approve(psmAddr, redeemOkuM)
            await psm.connect(Bob).redeemOkuM(redeemOkuM)

            expect(await usdc.balanceOf(bobAddr), "Bob paid instantly, in full")
                .to.equal(bobUsdcBefore + redeemUsdc)
            expect(await usdc.balanceOf(psmAddr)).to.equal(0)

            // Charlie and Dave revert against the empty buffer and keep their OkuM
            for (const [user, addr, usdcBefore] of [
                [Charlie, charlieAddr, charlieUsdcBefore],
                [Dave, daveAddr, daveUsdcBefore]
            ] as const) {
                await okuMoney.connect(user).approve(psmAddr, redeemOkuM)
                await expect(psm.connect(user).redeemOkuM(redeemOkuM))
                    .to.be.revertedWithCustomError(psm, "InsufficientBuffer")
                    .withArgs(0, redeemUsdc)
                expect(await usdc.balanceOf(addr)).to.equal(usdcBefore)
                expect(await okuMoney.balanceOf(addr)).to.equal(redeemOkuM)
            }

            // Once the buffer is topped up, the same redemptions succeed
            await fundPSM(parseUnits("10000", 6))
            await psm.connect(Charlie).redeemOkuM(redeemOkuM)
            await psm.connect(Dave).redeemOkuM(redeemOkuM)
            expect(await usdc.balanceOf(charlieAddr)).to.equal(charlieUsdcBefore + redeemUsdc)
            expect(await usdc.balanceOf(daveAddr)).to.equal(daveUsdcBefore + redeemUsdc)
            expect(await usdc.balanceOf(psmAddr)).to.equal(0)
        })
    })

    describe("Pause", () => {
        it("withdrawUsdc reverts while the PSM is paused", async () => {
            await fundPSM(parseUnits("1000", 6))
            await psm.connect(Frank).pause()
            await expect(psm.connect(Frank).withdrawUsdc(await Frank.getAddress(), 1n))
                .to.be.revertedWithCustomError(psm, "EnforcedPause")
            await psm.connect(Frank).unpause()
        })

        it("depositBuffer reverts while the PSM is paused", async () => {
            await psm.connect(Frank).pause()
            await expect(psm.connect(Frank).depositBuffer(1n))
                .to.be.revertedWithCustomError(psm, "EnforcedPause")
            await psm.connect(Frank).unpause()
        })
    })

    describe("Yield Accrual", () => {
        it("Pays the redemption-time value under streaming accrual (60 days)", async () => {
            const psmAddr = await psm.getAddress()
            const aliceAddr = await Alice.getAddress()
            await drainPSM()

            const amount = parseUnits("10000", 6)
            await fundWithUSDC(Alice, amount)
            await usdc.connect(Alice).approve(psmAddr, amount)
            await psm.connect(Alice).mintOkuM(amount)
            const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
            // Headroom for the accrued yield
            await fundPSM(parseUnits("10000", 6))

            // ~5% APY, armed as the epoch model does: one bounded window, no discrete override.
            const rate = 1_000_000_001_547_125_958n
            const base = await okuMoney.okuMMultiplier()
            const rateEnd = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 90n * 86400n
            const setTx = await okuMoney.connect(Frank).setOkuMYieldRate(rate, rateEnd)
            const t0 = BigInt((await ethers.provider.getBlock((await setTx.wait())!.blockNumber))!.timestamp)

            await okuMoney.connect(Alice).approve(psmAddr, aliceOkuM)
            const usdcBefore = await usdc.balanceOf(aliceAddr)

            // Redeem in a block pinned 60 days after the window opened, so the expected
            // multiplier is exact, computed by the TypeScript mirror (differential-tested
            // against the Solidity), not by the contract under test.
            const t1 = t0 + 60n * 86400n
            await network.provider.send("evm_setNextBlockTimestamp", [Number(t1)])
            await psm.connect(Alice).redeemOkuM(aliceOkuM)

            const mult = computeMultiplier(
                {
                    baseMultiplier: base,
                    ratePerSecond: rate,
                    lastAccrualTime: t0,
                    rateEnd,
                    pendingRatePerSecond: PRECISION,
                    pendingRateEnd: 0n
                },
                t1
            )
            const expectedUsdc = (aliceOkuM * mult) / PRECISION / DECIMAL_MULTIPLIER
            expect(expectedUsdc).to.be.gt(aliceOkuM / DECIMAL_MULTIPLIER) // yield did accrue
            expect((await usdc.balanceOf(aliceAddr)) - usdcBefore).to.equal(expectedUsdc)

            // Halt accrual so later suites see a static multiplier.
            await okuMoney.connect(Frank).setOkuMYieldRate(PRECISION, 0)
        })
    })
})
