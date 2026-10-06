import {
    LitePSM,
    LitePSM__factory,
    OkuMoney,
    OkuMoney__factory,
    OkuDollar__factory,
    RedemptionQueue,
    RedemptionQueue__factory,
    IERC20__factory
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits, Contract } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { resetMainnetFork } from "../helpers/fork"
import { expect } from "chai"
import { getTokenAddress, getWhaleAddress } from "../../../scripts/config/chains"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!
interface CircleUsdc {
    blacklister(): Promise<string>
    blacklist(account: string): Promise<unknown>
    connect(signer: Signer): CircleUsdc
}

const usd = (n: number) => parseUnits(String(n), 6)
const okum = (n: number) => parseEther(String(n))

/**
 * The queue against REAL Circle USDC (mainnet fork): Circle reverts on blacklisted
 * accounts and blacklists the caller too, which the MockUSDC suites cannot show.
 * Topology matches production: the queue holds OKUM_BURNER only.
 */
describe("RedemptionQueue on Circle USDC", () => {
    let frank: Signer, bob: Signer, alice: Signer, charlie: Signer
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuMoney: OkuMoney
    let usdc: ReturnType<typeof IERC20__factory.connect>
    let circle: CircleUsdc
    let snapshot: string

    const role = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n))

    async function impersonate(addr: string) {
        await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"])
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] })
        return ethers.getSigner(addr)
    }

    async function fund(to: Signer, amount: bigint) {
        const whale = await impersonate(USDC_WHALE)
        await usdc.connect(whale).transfer(await to.getAddress(), amount)
    }

    async function userMints(user: Signer, usdcAmount: bigint) {
        await fund(user, usdcAmount)
        await usdc.connect(user).approve(await psm.getAddress(), usdcAmount)
        await psm.connect(user).mintOkuM(usdcAmount)
    }

    async function drainBuffer() {
        const bal = await usdc.balanceOf(await psm.getAddress())
        await psm.connect(frank).withdrawUsdc(await frank.getAddress(), bal)
    }

    async function redeem(user: Signer, amount: bigint) {
        await okuMoney.connect(user).approve(await psm.getAddress(), amount)
        return psm.connect(user).redeemOkuM(amount)
    }

    async function deposit(amount: bigint, process = false, start = 0, end = 0, approve = 0n) {
        await fund(frank, amount)
        await usdc.connect(frank).approve(await psm.getAddress(), amount)
        return psm.connect(frank).depositBuffer(amount, process, start, end, approve)
    }

    async function circleBlacklist(account: string) {
        const blacklister = await impersonate(await circle.blacklister())
        await circle.connect(blacklister).blacklist(account)
    }

    before(async () => {
        await resetMainnetFork()
        ;[frank, bob, alice, charlie] = await ethers.getSigners()
        const frankAddr = await frank.getAddress()
        usdc = IERC20__factory.connect(USDC_MAINNET, bob)
        circle = new Contract(
            USDC_MAINNET,
            [
                "function blacklister() view returns (address)",
                "function blacklist(address)",
                "function isBlacklisted(address) view returns (bool)"
            ],
            frank
        ) as unknown as CircleUsdc

        okuMoney = (await upgrades.deployProxy(
            new OkuMoney__factory(frank),
            ["OkuMoney", "OkuM", frankAddr, parseEther("1000000000")],
            { kind: "uups" }
        )) as unknown as OkuMoney
        const okuDollar = await upgrades.deployProxy(
            new OkuDollar__factory(frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        )
        queue = (await upgrades.deployProxy(
            new RedemptionQueue__factory(frank),
            [await okuMoney.getAddress(), USDC_MAINNET, frankAddr],
            { kind: "uups" }
        )) as unknown as RedemptionQueue
        psm = (await upgrades.deployProxy(
            new LitePSM__factory(frank),
            [
                await okuMoney.getAddress(),
                await okuDollar.getAddress(),
                USDC_MAINNET,
                await queue.getAddress(),
                frankAddr
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        )) as unknown as LitePSM

        const psmAddr = await psm.getAddress()
        await okuMoney.grantRole(role("OKUM_MINTER"), psmAddr)
        await okuMoney.grantRole(role("OKUM_BURNER"), psmAddr)
        await okuMoney.grantRole(role("OKUM_BURNER"), await queue.getAddress())
        await okuMoney.configureMinterAllowance(psmAddr, parseEther("1000000000"))
        await queue.grantRole(role("QUEUE_PSM"), psmAddr)
    })

    beforeEach(async () => {
        snapshot = await network.provider.send("evm_snapshot")
    })
    afterEach(async () => {
        await network.provider.send("evm_revert", [snapshot])
    })

    it("a Circle-blacklisted recipient is skipped, the rest are paid, and rescue returns the OkuM", async () => {
        await userMints(bob, usd(1000))
        await userMints(alice, usd(1000))
        await userMints(charlie, usd(1000))
        await drainBuffer()
        for (const u of [bob, alice, charlie]) await redeem(u, okum(1000))
        expect(await queue.queueLength()).to.equal(3n)

        await circleBlacklist(await alice.getAddress())
        const bobBefore = await usdc.balanceOf(await bob.getAddress())
        const charlieBefore = await usdc.balanceOf(await charlie.getAddress())
        const aliceBefore = await usdc.balanceOf(await alice.getAddress())
        const supplyBefore = await okuMoney.totalSupply()

        await deposit(usd(3000))
        await expect(psm.processQueue(0, 3, usd(3000)))
            .to.emit(queue, "RedemptionSkipped")
            .withArgs(1, 2) // TransferFailed

        expect(await usdc.balanceOf(await bob.getAddress())).to.equal(bobBefore + usd(1000))
        expect(await usdc.balanceOf(await charlie.getAddress())).to.equal(charlieBefore + usd(1000))
        expect(await usdc.balanceOf(await alice.getAddress())).to.equal(aliceBefore)
        expect(await okuMoney.totalSupply()).to.equal(supplyBefore - okum(2000))
        expect(await queue.totalQueuedOkuM()).to.equal(okum(1000))
        expect((await queue.getQueueEntry(1)).user).to.equal(await alice.getAddress())

        // Circle does not stop OkuM moving, so rescue to the same user works.
        await queue.rescueQueueEntry(1, await alice.getAddress())
        expect(await okuMoney.balanceOf(await alice.getAddress())).to.equal(okum(1000))
        expect(await queue.totalQueuedOkuM()).to.equal(0n)
    })

    it("a newcomer cannot be paid ahead of a queued user out of a partial refill", async () => {
        await userMints(bob, usd(6000))
        await userMints(alice, usd(2000))
        await drainBuffer()
        await redeem(bob, okum(6000)) // queued
        await deposit(usd(5000)) // buffer 5000, owed 6000

        const aliceBefore = await usdc.balanceOf(await alice.getAddress())
        await redeem(alice, okum(2000))
        expect(await usdc.balanceOf(await alice.getAddress())).to.equal(aliceBefore)
        expect(await queue.queueLength()).to.equal(2n)
    })

    it("depositBuffer can pay the queue in the same transaction", async () => {
        await userMints(bob, usd(3000))
        await drainBuffer()
        await redeem(bob, okum(3000))
        const bobBefore = await usdc.balanceOf(await bob.getAddress())

        await deposit(usd(3000), true, 0, 1, usd(3000))

        expect(await usdc.balanceOf(await bob.getAddress())).to.equal(bobBefore + usd(3000))
        expect(await queue.totalQueuedOkuM()).to.equal(0n)
    })

    it("a PSM pause stops queue payouts and withdrawals", async () => {
        await userMints(bob, usd(1000))
        await drainBuffer()
        await redeem(bob, okum(1000))
        await deposit(usd(1000))

        await psm.pause()
        await expect(psm.processQueue(0, 1, usd(1000))).to.be.revertedWithCustomError(psm, "EnforcedPause")
        await expect(psm.withdrawUsdc(await frank.getAddress(), 1n)).to.be.revertedWithCustomError(
            psm,
            "EnforcedPause"
        )
        await expect(deposit(usd(1), true, 0, 1, usd(1))).to.be.revertedWithCustomError(psm, "EnforcedPause")
    })

    it("a user can cancel their own entry and gets their OkuM back", async () => {
        await userMints(bob, usd(1000))
        await drainBuffer()
        await redeem(bob, okum(1000))

        await queue.connect(bob).cancelQueueEntry(0)
        expect(await okuMoney.balanceOf(await bob.getAddress())).to.equal(okum(1000))
        await expect(queue.connect(alice).cancelQueueEntry(0)).to.be.revertedWithCustomError(
            queue,
            "EntryAlreadyCleared"
        )
    })
})
