import {
    LitePSM,
    LitePSM__factory,
    OkuMoney,
    OkuMoney__factory,
    OkuDollar,
    OkuDollar__factory,
    RedemptionQueue,
    RedemptionQueue__factory,
    NttAdapter,
    NttAdapter__factory,
    IERC20__factory
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits, ContractFactory } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { expect } from "chai"
import { getTokenAddress, getWhaleAddress, getChainMetadata, getWormholeChainId } from "../../../config/config"

const USDC_MAINNET = getTokenAddress("mainnet", "usdc")
const USDC_WHALE = getWhaleAddress("mainnet", "usdc")!

// Chain ID constants
const ETHEREUM_CHAIN_ID = getChainMetadata("mainnet").chainId
const WORMHOLE_ETHEREUM = getWormholeChainId(ETHEREUM_CHAIN_ID)
const ARBITRUM_CHAIN_ID = getChainMetadata("arbitrum").chainId
const WORMHOLE_ARBITRUM = getWormholeChainId(ARBITRUM_CHAIN_ID)
const OPTIMISM_CHAIN_ID = getChainMetadata("optimism").chainId
const WORMHOLE_OPTIMISM = getWormholeChainId(OPTIMISM_CHAIN_ID)
const BASE_CHAIN_ID = getChainMetadata("base").chainId
const WORMHOLE_BASE = getWormholeChainId(BASE_CHAIN_ID)

describe("NTT Bridge Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let psm: LitePSM
    let queue: RedemptionQueue
    let okuMoney: OkuNote
    let okuUsd: OkuUSD
    let nttAdapter: NttAdapter
    let mockNttManager: any  // MockNttManagerHH (dynamic import)

    let usdc: ReturnType<typeof IERC20__factory.connect>

    const MINTER = ethers.keccak256(ethers.toUtf8Bytes("MINTER"))
    const PSM = ethers.keccak256(ethers.toUtf8Bytes("PSM"))
    const ALLOWANCE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes("ALLOWANCE_MANAGER"))
    const OKUM_REBASER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_REBASER"))
    const OKUM_PAUSER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_PAUSER"))
    const OKUM_UNPAUSER = ethers.keccak256(ethers.toUtf8Bytes("OKUM_UNPAUSER"))
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
        await psm.connect(user).mint_OkuM(usdcAmount)
    }

    // Bridge via NttAdapter — only ROUTER (Frank) can call bridge()
    // In production, OkuBridgeRouter calls adapter.bridge() after burning tokens
    async function bridgeViaNtt(
        amount: bigint,
        destChain: number,
        recipient: string,
        fee: bigint = 0n
    ) {
        await nttAdapter.connect(Frank).bridge(
            await okuMoney.getAddress(),
            amount,
            destChain,
            recipient,
            { value: fee }
        )
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

        // Deploy OkuNote
        okuMoney = await upgrades.deployProxy(
            new OkuMoney__factory(Frank),
            ["OkuMoney", "OkuM", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuNote
        await okuMoney.waitForDeployment()

        // Deploy OkuDollar vault
        okuUsd = await upgrades.deployProxy(
            new OkuDollar__factory(Frank),
            [await okuMoney.getAddress(), "OkuDollar", "usdOku", frankAddr, parseEther("0.95")],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUsd.waitForDeployment()

        // Deploy RedemptionQueue
        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuMoney.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        // Deploy LitePSM
        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuMoney.getAddress(), await okuUsd.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups", unsafeAllow: ["constructor"] }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        // Deploy MockNttManagerHH
        const MockNttManagerHH = await ethers.getContractFactory("MockNttManagerHH", Frank)
        mockNttManager = await MockNttManagerHH.deploy(
            await okuMoney.getAddress(),
            await okuMoney.getAddress()
        )
        await mockNttManager.waitForDeployment()

        // Deploy NttAdapter (frankAddr is both ROUTER and owner for testing)
        // In production, ROUTER would be the OkuBridgeRouter address
        nttAdapter = await new NttAdapter__factory(Frank).deploy(
            await mockNttManager.getAddress(),
            await okuMoney.getAddress(),
            frankAddr,  // ROUTER — only this address can call bridge()
            frankAddr   // owner
        )
        await nttAdapter.waitForDeployment()

        // Configure roles
        await okuMoney.connect(Frank).grantRole(MINTER, await psm.getAddress())

        // Grant RBAC roles to Frank (admin) for testing
        await okuMoney.connect(Frank).grantRole(ALLOWANCE_MANAGER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_REBASER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_PAUSER, frankAddr)
        await okuMoney.connect(Frank).grantRole(OKUM_UNPAUSER, frankAddr)
        await okuMoney.connect(Frank).grantRole(BLACKLISTER, frankAddr)
        await okuMoney.connect(Frank).grantRole(UNBLACKLISTER, frankAddr)
        await okuMoney.connect(Frank).grantRole(CAP_MANAGER, frankAddr)

        // Grant PSM-specific roles to Frank
        await psm.connect(Frank).grantRole(BUFFER_WITHDRAWER, frankAddr)
        await psm.connect(Frank).grantRole(QUEUE_PROCESSOR, frankAddr)

        await okuMoney.connect(Frank).configureMinterAllowance(
            await psm.getAddress(),
            parseEther("1000000000")
        )
        await queue.connect(Frank).grantRole(PSM, await psm.getAddress())
        await okuMoney.connect(Frank).grantRole(MINTER, await queue.getAddress())

        // Grant MINTER to MockNttManager for completeBridge()
        await okuMoney.connect(Frank).grantRole(MINTER, await mockNttManager.getAddress())
        await okuMoney.connect(Frank).configureMinterAllowance(
            await mockNttManager.getAddress(),
            parseEther("1000000000")
        )
    })

    describe("NttAdapter Direct Tests", () => {
        it("Bridge records pending transfer in NttManager", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("10000", 6)

            const pendingCountBefore = await mockNttManager.pendingTransfersCount()

            // Call bridge (adapter doesn't transfer tokens, just records message)
            await nttAdapter.connect(Frank).bridge(
                await okuMoney.getAddress(),
                bridgeAmount,
                ARBITRUM_CHAIN_ID,
                bobAddr
            )

            // Verify pending transfer recorded
            const pendingCountAfter = await mockNttManager.pendingTransfersCount()
            expect(pendingCountAfter).to.equal(pendingCountBefore + 1n)

            const transfer = await mockNttManager.getLastTransfer()
            expect(transfer.amount).to.equal(bridgeAmount)
            expect(transfer.recipientChain).to.equal(WORMHOLE_ARBITRUM)
            expect(transfer.completed).to.equal(false)
            expect(transfer.sender).to.equal(await nttAdapter.getAddress())
        })

        it("Address conversion round-trip", async () => {
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("5000", 6)

            // Bridge to Bob
            await nttAdapter.connect(Frank).bridge(
                await okuMoney.getAddress(),
                bridgeAmount,
                ARBITRUM_CHAIN_ID,
                bobAddr
            )

            // Get the last transfer
            const lastTransfer = await mockNttManager.getLastTransfer()

            // Verify bytes32 conversion
            const expectedBytes32 = await mockNttManager.addressToRecipient(bobAddr)
            expect(lastTransfer.recipient).to.equal(expectedBytes32)

            // Verify round-trip conversion
            const recoveredAddr = await mockNttManager.recipientToAddress(lastTransfer.recipient)
            expect(recoveredAddr.toLowerCase()).to.equal(bobAddr.toLowerCase())
        })

        it("Unsupported chain reverts", async () => {
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("1000", 6)

            // Try to bridge to unsupported chain
            await expect(
                nttAdapter.connect(Frank).bridge(
                    await okuMoney.getAddress(),
                    bridgeAmount,
                    999,  // Unsupported chain
                    bobAddr
                )
            ).to.be.revertedWithCustomError(nttAdapter, "UnsupportedChain")
        })

        it("Fee handling - insufficient fee reverts", async () => {
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("1000", 6)

            // Set message fee on mock
            const requiredFee = parseEther("0.01")
            await mockNttManager.setMessageFee(requiredFee)

            // Try to bridge without fee
            await expect(
                nttAdapter.connect(Frank).bridge(
                    await okuMoney.getAddress(),
                    bridgeAmount,
                    ARBITRUM_CHAIN_ID,
                    bobAddr,
                    { value: 0 }
                )
            ).to.be.revertedWithCustomError(mockNttManager, "InsufficientFee")

            // Reset fee for other tests
            await mockNttManager.setMessageFee(0)
        })

        it("Fee handling - exact fee succeeds", async () => {
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("1000", 6)

            // Set message fee
            const requiredFee = parseEther("0.01")
            await mockNttManager.setMessageFee(requiredFee)

            const mockBalanceBefore = await ethers.provider.getBalance(await mockNttManager.getAddress())

            await nttAdapter.connect(Frank).bridge(
                await okuMoney.getAddress(),
                bridgeAmount,
                ARBITRUM_CHAIN_ID,
                bobAddr,
                { value: requiredFee }
            )

            // Verify fee was forwarded to mock
            const mockBalanceAfter = await ethers.provider.getBalance(await mockNttManager.getAddress())
            expect(mockBalanceAfter - mockBalanceBefore).to.equal(requiredFee)

            // Reset fee
            await mockNttManager.setMessageFee(0)
        })

        it("Chain ID configuration", async () => {
            // Verify default mappings
            expect(await nttAdapter.wormholeChainId(ETHEREUM_CHAIN_ID)).to.equal(WORMHOLE_ETHEREUM)
            expect(await nttAdapter.wormholeChainId(ARBITRUM_CHAIN_ID)).to.equal(WORMHOLE_ARBITRUM)
            expect(await nttAdapter.wormholeChainId(OPTIMISM_CHAIN_ID)).to.equal(WORMHOLE_OPTIMISM)
            expect(await nttAdapter.wormholeChainId(BASE_CHAIN_ID)).to.equal(WORMHOLE_BASE)

            // Configure new chain (BSC)
            const BSC_CHAIN_ID = 56
            const WORMHOLE_BSC = 4
            await nttAdapter.connect(Frank).configureChainId(BSC_CHAIN_ID, WORMHOLE_BSC)
            expect(await nttAdapter.wormholeChainId(BSC_CHAIN_ID)).to.equal(WORMHOLE_BSC)

            // Bridge to BSC should now work
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("1000", 6)

            await nttAdapter.connect(Frank).bridge(
                await okuMoney.getAddress(),
                bridgeAmount,
                BSC_CHAIN_ID,
                bobAddr
            )

            const lastTransfer = await mockNttManager.getLastTransfer()
            expect(lastTransfer.recipientChain).to.equal(WORMHOLE_BSC)
        })
    })

    describe("Round-Trip Tests", () => {
        it("Complete bridge mints to recipient", async () => {
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("10000", 6)

            // Record Bob's balance before
            const bobBalanceBefore = await okuMoney.balanceOf(bobAddr)

            // Bridge to Bob (adapter records message, doesn't handle tokens)
            await nttAdapter.connect(Frank).bridge(
                await okuMoney.getAddress(),
                bridgeAmount,
                ARBITRUM_CHAIN_ID,
                bobAddr
            )

            // Complete the bridge (mock mints tokens)
            const pendingCount = await mockNttManager.pendingTransfersCount()
            await mockNttManager.completeBridge(pendingCount - 1n)

            // Bob should have received OkuNote
            const bobBalanceAfter = await okuMoney.balanceOf(bobAddr)
            expect(bobBalanceAfter - bobBalanceBefore).to.equal(bridgeAmount)
        })

        it("Bridge amount preserved regardless of rebase", async () => {
            const charlieAddr = await Charlie.getAddress()
            const bridgeAmount = parseUnits("10000", 6)

            // Bridge to Charlie
            await nttAdapter.connect(Frank).bridge(
                await okuMoney.getAddress(),
                bridgeAmount,
                OPTIMISM_CHAIN_ID,
                charlieAddr
            )

            // Get pending transfer index
            const pendingCount = await mockNttManager.pendingTransfersCount()
            const transferIndex = pendingCount - 1n

            // Get the recorded amount
            const transfer = await mockNttManager.getPendingTransfer(transferIndex)
            const recordedAmount = transfer.amount

            // NotePrice +10% AFTER bridge message recorded
            const priceBefore = await okuMoney.okuMPrice()
            const newPrice = priceBefore * 110n / 100n
            await okuMoney.connect(Frank).updateOkuMPrice(newPrice)

            // Complete the bridge
            const charlieBalanceBefore = await okuMoney.balanceOf(charlieAddr)
            await mockNttManager.completeBridge(transferIndex)
            const charlieBalanceAfter = await okuMoney.balanceOf(charlieAddr)

            // Charlie receives the recorded amount (raw token units)
            // The mock mints exactly what was recorded
            // Note: 1 wei rounding possible due to OkuMoney share conversion
            const received = charlieBalanceAfter - charlieBalanceBefore
            expect(received).to.be.closeTo(recordedAmount, 1n)
        })
    })

    describe("Recovery Functions", () => {
        it("Owner can withdraw stuck ETH", async () => {
            const frankAddr = await Frank.getAddress()

            // Send ETH to adapter
            const stuckAmount = parseEther("0.5")
            await Frank.sendTransaction({
                to: await nttAdapter.getAddress(),
                value: stuckAmount
            })

            // Verify ETH is stuck
            const adapterBalance = await ethers.provider.getBalance(await nttAdapter.getAddress())
            expect(adapterBalance).to.equal(stuckAmount)

            // Owner withdraws
            const frankBalanceBefore = await ethers.provider.getBalance(frankAddr)
            const tx = await nttAdapter.connect(Frank).withdrawEth(frankAddr)
            const receipt = await tx.wait()
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice

            // Verify ETH recovered
            const frankBalanceAfter = await ethers.provider.getBalance(frankAddr)
            expect(frankBalanceAfter).to.be.closeTo(
                frankBalanceBefore + stuckAmount - gasUsed,
                parseEther("0.001")
            )

            // Adapter should be empty
            expect(await ethers.provider.getBalance(await nttAdapter.getAddress())).to.equal(0)
        })

        it("Owner can withdraw stuck tokens", async () => {
            const frankAddr = await Frank.getAddress()
            const depositAmount = parseUnits("1000", 6)

            // Get OkuMoney and accidentally send to adapter
            await getOkuNote(Frank, depositAmount)
            const okuMoneyBalance = await okuMoney.balanceOf(frankAddr)

            // Transfer directly to adapter (accident)
            await okuMoney.connect(Frank).transfer(await nttAdapter.getAddress(), okuMoneyBalance)

            // Verify tokens stuck
            expect(await okuMoney.balanceOf(await nttAdapter.getAddress())).to.be.gt(0)

            // Owner recovers
            const frankBalanceBefore = await okuMoney.balanceOf(frankAddr)
            await nttAdapter.connect(Frank).withdrawTokens(
                await okuMoney.getAddress(),
                frankAddr,
                await okuMoney.balanceOf(await nttAdapter.getAddress())
            )

            // Verify tokens recovered
            const frankBalanceAfter = await okuMoney.balanceOf(frankAddr)
            expect(frankBalanceAfter).to.be.gt(frankBalanceBefore)

            // Adapter should be empty (allow 1 wei rounding from OkuMoney share math)
            expect(await okuMoney.balanceOf(await nttAdapter.getAddress())).to.be.lte(1)
        })

        it("Non-owner cannot withdraw", async () => {
            // Send ETH to adapter
            await Frank.sendTransaction({
                to: await nttAdapter.getAddress(),
                value: parseEther("0.1")
            })

            // Alice tries to withdraw
            await expect(
                nttAdapter.connect(Alice).withdrawEth(await Alice.getAddress())
            ).to.be.revertedWithCustomError(nttAdapter, "OwnableUnauthorizedAccount")
        })
    })
})
