import {
    LitePSM,
    LitePSM__factory,
    OkuBridgeRouter,
    OkuBridgeRouter__factory,
    OkuNote,
    OkuNote__factory,
    OkuUSD,
    OkuUSD__factory,
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

describe("OkuUSD Vault Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let okuBridgeRouter: OkuBridgeRouter
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuNote: OkuNote
    let okuUsd: OkuUSD

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const MINTER = ethers.keccak256(ethers.toUtf8Bytes("MINTER"))
    const PSM = ethers.keccak256(ethers.toUtf8Bytes("PSM"))
    const ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER"))
    const NOTE_REBASER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_REBASER"))
    const NOTE_PAUSER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_PAUSER"))
    const NOTE_UNPAUSER = ethers.keccak256(ethers.toUtf8Bytes("NOTE_UNPAUSER"))
    const BLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("BLACKLISTER"))
    const UNBLACKLISTER = ethers.keccak256(ethers.toUtf8Bytes("UNBLACKLISTER"))
    const CAP_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("CAP_MANAGER"))
    const BUFFER_WITHDRAWER = ethers.keccak256(ethers.toUtf8Bytes("BUFFER_WITHDRAWER"))
    const QUEUE_PROCESSOR = ethers.keccak256(ethers.toUtf8Bytes("QUEUE_PROCESSOR"))

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

    async function getOkuNote(user: Signer, usdcAmount: bigint) {
        await fundWithUSDC(user, usdcAmount)
        await usdc.connect(user).approve(await psm.getAddress(), usdcAmount)
        await psm.connect(user).mint_OkuNote(usdcAmount)
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

    before("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000")

        okuNote = await upgrades.deployProxy(
            new OkuNote__factory(Frank),
            ["OkuNote", "OKUNOTE", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuNote
        await okuNote.waitForDeployment()

        okuUsd = await upgrades.deployProxy(
            new OkuUSD__factory(Frank),
            [await okuNote.getAddress(), "OkuUSD", "OKUSD", frankAddr, parseEther("0.95")],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUsd.waitForDeployment()

        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuNote.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuNote.getAddress(), await okuUsd.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        okuBridgeRouter = await upgrades.deployProxy(
            new OkuBridgeRouter__factory(Frank),
            [await okuUsd.getAddress(), await okuNote.getAddress(), frankAddr, frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as OkuBridgeRouter
        await okuBridgeRouter.waitForDeployment()

        await okuNote.connect(Frank).grantRole(MINTER, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuNote.connect(Frank).grantRole(ALLOWANCE_MANAGER, frankAddr)
        await okuNote.connect(Frank).grantRole(NOTE_REBASER, frankAddr)
        await okuNote.connect(Frank).grantRole(NOTE_PAUSER, frankAddr)
        await okuNote.connect(Frank).grantRole(NOTE_UNPAUSER, frankAddr)
        await okuNote.connect(Frank).grantRole(BLACKLISTER, frankAddr)
        await okuNote.connect(Frank).grantRole(UNBLACKLISTER, frankAddr)
        await okuNote.connect(Frank).grantRole(CAP_MANAGER, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR, frankAddr)

        await okuNote.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(PSM, await psm.getAddress())
        await okuNote.connect(Frank).grantRole(MINTER, await queue.getAddress())
    })

    describe("Wrap/Unwrap Round-Trip", () => {
        it("Wrap OkuNote and unwrap with minimal loss", async () => {
            const aliceAddr = await Alice.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuNote via PSM
            await getOkuNote(Alice, depositAmount)

            const noteBalance = await okuNote.balanceOf(aliceAddr)
            expect(noteBalance).to.be.gt(0)

            // Wrap OkuNote into OkuUSD vault
            await okuNote.connect(Alice).approve(okuUsdAddr, noteBalance)
            const okuUsdBefore = await okuUsd.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).wrap(noteBalance, aliceAddr)

            const okuUsdReceived = await okuUsd.balanceOf(aliceAddr)
            expect(okuUsdReceived).to.be.gt(okuUsdBefore)

            // Verify vault holds the notes
            const vaultNotes = await okuNote.balanceOf(okuUsdAddr)
            const totalReserves = await okuUsd.totalNoteReserves()
            expect(vaultNotes).to.equal(totalReserves)

            // Unwrap all OkuUSD immediately
            const notesBefore = await okuNote.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(okuUsdReceived, aliceAddr)

            const notesAfter = await okuNote.balanceOf(aliceAddr)
            const notesReturned = notesAfter - notesBefore

            // Should get back original note amount (± 1 wei rounding)
            expect(notesReturned).to.be.closeTo(noteBalance, 1n)

            // Vault should be empty
            expect(await okuUsd.totalNoteReserves()).to.equal(0)
        })
    })

    describe("Exchange Rate After Rebase", () => {
        it("OkuNote rebase increases vault reserves (surplus), unwrap returns dollar-for-dollar", async () => {
            const aliceAddr = await Alice.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()
            const depositAmount = parseUnits("10000", 6)

            // Get OkuNote via PSM
            await getOkuNote(Alice, depositAmount)
            const noteBalance = await okuNote.balanceOf(aliceAddr)

            // Wrap into vault
            await okuNote.connect(Alice).approve(okuUsdAddr, noteBalance)
            await okuUsd.connect(Alice).wrap(noteBalance, aliceAddr)

            const okuUsdBalance = await okuUsd.balanceOf(aliceAddr)

            // Record initial note reserves
            const initialReserves = await okuUsd.totalNoteReserves()

            // Admin performs 10% rebase on OkuNote
            const multiplierBefore = await okuNote.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuNote.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Note reserves should have increased (OkuNote rebased)
            const newReserves = await okuUsd.totalNoteReserves()
            expect(newReserves).to.be.gt(initialReserves)
            // Reserves grew ~10%
            expect(newReserves).to.be.closeTo(initialReserves * 110n / 100n, parseEther("1"))

            // Vault is now overcollateralized — surplus exists
            const surplus = await okuUsd.surplus()
            expect(surplus).to.be.gt(0)

            // Unwrap is dollar-for-dollar: OkuUSD amount = notes returned
            // Since OkuUSD multiplier hasn't changed, user gets back same note amount they wrapped
            const notesBefore = await okuNote.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(okuUsdBalance, aliceAddr)
            const notesAfter = await okuNote.balanceOf(aliceAddr)
            const notesReturned = notesAfter - notesBefore

            // Dollar-for-dollar: unwrap(okuUsdBalance) returns okuUsdBalance notes
            expect(notesReturned).to.be.closeTo(okuUsdBalance, 1n)
        })
    })

    describe("Multiple Depositors Share Accounting", () => {
        it("Multiple users share vault proportionally, unwrap returns dollar-for-dollar", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const charlieAddr = await Charlie.getAddress()
            const okuUsdAddr = await okuUsd.getAddress()

            // Different deposit amounts (1:2:3 ratio)
            const aliceDeposit = parseUnits("10000", 6)
            const bobDeposit = parseUnits("20000", 6)
            const charlieDeposit = parseUnits("30000", 6)

            // All users get OkuNote
            await getOkuNote(Alice, aliceDeposit)
            await getOkuNote(Bob, bobDeposit)
            await getOkuNote(Charlie, charlieDeposit)

            // Calculate OkuNote amounts (USDC deposits converted to OkuNote in 18 decimals)
            const aliceNotes = parseEther("10000")
            const bobNotes = parseEther("20000")
            const charlieNotes = parseEther("30000")

            // Record initial OkuUSD balances (may have from previous tests)
            const aliceUsdBefore = await okuUsd.balanceOf(aliceAddr)
            const bobUsdBefore = await okuUsd.balanceOf(bobAddr)
            const charlieUsdBefore = await okuUsd.balanceOf(charlieAddr)

            await okuNote.connect(Alice).approve(okuUsdAddr, aliceNotes)
            await okuNote.connect(Bob).approve(okuUsdAddr, bobNotes)
            await okuNote.connect(Charlie).approve(okuUsdAddr, charlieNotes)

            await okuUsd.connect(Alice).wrap(aliceNotes, aliceAddr)
            await okuUsd.connect(Bob).wrap(bobNotes, bobAddr)
            await okuUsd.connect(Charlie).wrap(charlieNotes, charlieAddr)

            // Calculate OkuUSD gained in this test only
            const aliceUsdGained = (await okuUsd.balanceOf(aliceAddr)) - aliceUsdBefore
            const bobUsdGained = (await okuUsd.balanceOf(bobAddr)) - bobUsdBefore
            const charlieUsdGained = (await okuUsd.balanceOf(charlieAddr)) - charlieUsdBefore

            // Verify proportional OkuUSD received (1:2:3 ratio approximately)
            expect(bobUsdGained).to.be.closeTo(aliceUsdGained * 2n, aliceUsdGained / 10n)
            expect(charlieUsdGained).to.be.closeTo(aliceUsdGained * 3n, aliceUsdGained / 10n)

            // Admin performs 10% rebase on OkuNote — vault accumulates surplus
            const multiplierBefore = await okuNote.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuNote.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Vault is now overcollateralized
            expect(await okuUsd.surplus()).to.be.gt(0)

            // Users unwrap their gained OkuUSD in reverse order
            // Unwrap is dollar-for-dollar: they get back the same note amount they wrapped
            const charlieNotesBefore = await okuNote.balanceOf(charlieAddr)
            await okuUsd.connect(Charlie).unwrap(charlieUsdGained, charlieAddr)
            const charlieReceived = (await okuNote.balanceOf(charlieAddr)) - charlieNotesBefore

            const bobNotesBefore = await okuNote.balanceOf(bobAddr)
            await okuUsd.connect(Bob).unwrap(bobUsdGained, bobAddr)
            const bobReceived = (await okuNote.balanceOf(bobAddr)) - bobNotesBefore

            const aliceNotesBefore = await okuNote.balanceOf(aliceAddr)
            await okuUsd.connect(Alice).unwrap(aliceUsdGained, aliceAddr)
            const aliceReceived = (await okuNote.balanceOf(aliceAddr)) - aliceNotesBefore

            // Dollar-for-dollar: each user receives back what they wrapped (± 1 wei)
            expect(aliceReceived).to.be.closeTo(aliceNotes, 1n)
            expect(bobReceived).to.be.closeTo(bobNotes, 1n)
            expect(charlieReceived).to.be.closeTo(charlieNotes, 1n)
        })
    })
})
