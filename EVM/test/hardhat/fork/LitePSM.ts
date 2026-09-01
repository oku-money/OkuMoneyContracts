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

describe("LitePSM Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer

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
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr, parseEther("0.95")],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuDollar
        await okuUsd.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            // initialize(_okuMoney, _okuDollar, _usdc, admin)
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

            await fundWithUSDC(Alice, DEPOSIT_AMOUNT)
            await fundWithUSDC(Bob, DEPOSIT_AMOUNT)

            await usdc.connect(Alice).approve(psmAddr, DEPOSIT_AMOUNT)
            await usdc.connect(Bob).approve(psmAddr, DEPOSIT_AMOUNT)
            await psm.connect(Alice).mintOkuM(DEPOSIT_AMOUNT)
            await psm.connect(Bob).mintOkuM(DEPOSIT_AMOUNT)

            expect(await usdc.balanceOf(psmAddr)).to.equal(DEPOSIT_AMOUNT * 2n)

            const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
            const aliceRedeemAmount = aliceOkuM / 2n
            const aliceUsdcBefore = await usdc.balanceOf(aliceAddr)

            await okuMoney.connect(Alice).approve(psmAddr, aliceRedeemAmount)
            await psm.connect(Alice).redeemOkuM(aliceRedeemAmount)

            const expectedAliceUsdc = aliceRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(aliceAddr)) - aliceUsdcBefore).to.be.closeTo(expectedAliceUsdc, parseUnits("1", 6))

            const bobOkuM = await okuMoney.balanceOf(bobAddr)
            const bobRedeemAmount = bobOkuM / 2n
            const bobUsdcBefore = await usdc.balanceOf(bobAddr)

            await okuMoney.connect(Bob).approve(psmAddr, bobRedeemAmount)
            await psm.connect(Bob).redeemOkuM(bobRedeemAmount)

            const expectedBobUsdc = bobRedeemAmount / BigInt(1e12)
            expect((await usdc.balanceOf(bobAddr)) - bobUsdcBefore).to.be.closeTo(expectedBobUsdc, parseUnits("1", 6))
        })
    })

    // Redemption is buffer-only: there is no queue. A redemption the buffer
    // cannot cover reverts with `InsufficientBuffer` and takes nothing from the
    // user. Operators keep the buffer funded via `depositBuffer`.
    describe("Buffer Exhaustion", () => {
        it("Reverts rather than escrowing when the buffer cannot cover a redemption", async () => {
            const aliceAddr = await Alice.getAddress()
            const psmAddr = await psm.getAddress()

            await drainPSM()

            const freshAmount = parseUnits("10000", 6)
            await fundWithUSDC(Alice, freshAmount)
            await usdc.connect(Alice).approve(psmAddr, freshAmount)
            await psm.connect(Alice).mintOkuM(freshAmount)

            // Drain the buffer that Alice's own mint just created.
            await drainPSM()
            expect(await usdc.balanceOf(psmAddr)).to.equal(0)

            const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
            const okuMBefore = aliceOkuM
            await okuMoney.connect(Alice).approve(psmAddr, aliceOkuM)

            await expect(
                psm.connect(Alice).redeemOkuM(aliceOkuM)
            ).to.be.revertedWithCustomError(psm, "InsufficientBuffer")

            // Nothing moved: no escrow, no partial fill.
            expect(await okuMoney.balanceOf(aliceAddr)).to.equal(okuMBefore)

            // Refill and the same redemption succeeds.
            await fundPSM(parseUnits("20000", 6))
            const usdcBefore = await usdc.balanceOf(aliceAddr)
            await psm.connect(Alice).redeemOkuM(aliceOkuM)
            expect((await usdc.balanceOf(aliceAddr)) - usdcBefore).to.be.gt(0n)
            expect(await okuMoney.balanceOf(aliceAddr)).to.equal(0n)
        })

        it("Partially-covered redemptions revert; smaller ones within the buffer succeed", async () => {
            const aliceAddr = await Alice.getAddress()
            const psmAddr = await psm.getAddress()

            await drainPSM()

            const freshAmount = parseUnits("10000", 6)
            await fundWithUSDC(Alice, freshAmount)
            await usdc.connect(Alice).approve(psmAddr, freshAmount)
            await psm.connect(Alice).mintOkuM(freshAmount)

            // Leave only 1,000 USDC in the buffer.
            await drainPSM()
            await fundPSM(parseUnits("1000", 6))

            const aliceOkuM = await okuMoney.balanceOf(aliceAddr)
            await okuMoney.connect(Alice).approve(psmAddr, aliceOkuM)

            // Full balance (~10,000) exceeds the buffer: reverts.
            await expect(
                psm.connect(Alice).redeemOkuM(aliceOkuM)
            ).to.be.revertedWithCustomError(psm, "InsufficientBuffer")

            // 500 OkuM is comfortably inside the buffer: succeeds.
            const small = parseEther("500")
            const usdcBefore = await usdc.balanceOf(aliceAddr)
            await psm.connect(Alice).redeemOkuM(small)
            expect((await usdc.balanceOf(aliceAddr)) - usdcBefore).to.be.closeTo(
                parseUnits("500", 6),
                parseUnits("1", 6)
            )
        })
    })

    describe("Yield Accrual Before Redemption", () => {
        it("Holders redeem at the appreciated multiplier after an epoch", async () => {
            const aliceAddr = await Alice.getAddress()
            const psmAddr = await psm.getAddress()

            await drainPSM()

            const depositAmount = parseUnits("10000", 6)
            await fundWithUSDC(Alice, depositAmount)
            await usdc.connect(Alice).approve(psmAddr, depositAmount)
            await psm.connect(Alice).mintOkuM(depositAmount)

            const aliceOkuM = await okuMoney.balanceOf(aliceAddr)

            // Run a yield epoch so the multiplier appreciates ~10%. This streams
            // over time rather than stepping — see EVM/README.md.
            const priceBefore = await okuMoney.okuMMultiplier()
            await setMultiplierTo(okuMoney, Frank, Frank, priceBefore * 110n / 100n)
            expect(await okuMoney.okuMMultiplier()).to.be.gt(priceBefore)

            // Fund the buffer to cover the now-larger obligation, then redeem.
            await fundPSM(parseUnits("50000", 6))
            const usdcBefore = await usdc.balanceOf(aliceAddr)
            await okuMoney.connect(Alice).approve(psmAddr, aliceOkuM)
            await psm.connect(Alice).redeemOkuM(aliceOkuM)

            const received = (await usdc.balanceOf(aliceAddr)) - usdcBefore
            const originalUSDC = aliceOkuM / DECIMAL_MULTIPLIER

            // The same raw OkuM is now worth ~10% more USDC.
            expect(received).to.be.gt(originalUSDC)
            expect(received).to.be.closeTo(originalUSDC * 110n / 100n, parseUnits("1", 6))
        })
    })
})
