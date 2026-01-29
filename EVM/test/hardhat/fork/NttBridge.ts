import {
    LitePSM,
    LitePSM__factory,
    OkuUSD,
    OkuUSD__factory,
    RedemptionQueue,
    RedemptionQueue__factory,
    WOkuUSD,
    WOkuUSD__factory,
    NttAdapter,
    NttAdapter__factory,
    IERC20__factory
} from "../../../typechain-types"
import { Signer, parseEther, parseUnits, ContractFactory } from "ethers"
import { ethers, network, upgrades } from "hardhat"
import { expect } from "chai"

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const USDC_WHALE = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341"

// Wormhole chain ID mappings
const ETHEREUM_CHAIN_ID = 1
const WORMHOLE_ETHEREUM = 2
const ARBITRUM_CHAIN_ID = 42161
const WORMHOLE_ARBITRUM = 23
const OPTIMISM_CHAIN_ID = 10
const WORMHOLE_OPTIMISM = 24
const BASE_CHAIN_ID = 8453
const WORMHOLE_BASE = 30

describe("NTT Bridge Scenarios", () => {
    let Frank: Signer
    let Bob: Signer
    let Alice: Signer
    let Charlie: Signer

    let psm: LitePSM
    let queue: RedemptionQueue
    let okuUSD: OkuUSD
    let wokuUSD: WOkuUSD
    let nttAdapter: NttAdapter
    let mockNttManager: any  // MockNttManagerHH (dynamic import)

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
        await psm.connect(user).swap(usdcAmount)
    }

    async function bridgeViaNtt(
        user: Signer,
        amount: bigint,
        destChain: number,
        recipient: string,
        fee: bigint = 0n
    ) {
        await okuUSD.connect(user).approve(await nttAdapter.getAddress(), amount)
        await nttAdapter.connect(user).bridge(
            await okuUSD.getAddress(),
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

    it("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000")

        // Deploy OkuUSD
        okuUSD = await upgrades.deployProxy(
            new OkuUSD__factory(Frank),
            ["OkuUSD", "OKUSD", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUSD.waitForDeployment()

        // Deploy wOkuUSD
        wokuUSD = await upgrades.deployProxy(
            new WOkuUSD__factory(Frank),
            [await okuUSD.getAddress(), "Wrapped OkuUSD", "wOKUSD", frankAddr],
            { kind: "uups" }
        ) as unknown as WOkuUSD
        await wokuUSD.waitForDeployment()

        // Deploy RedemptionQueue
        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()

        // Deploy LitePSM
        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuUSD.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as LitePSM
        await psm.waitForDeployment()

        // Deploy MockNttManagerHH
        const MockNttManagerHH = await ethers.getContractFactory("MockNttManagerHH", Frank)
        mockNttManager = await MockNttManagerHH.deploy(
            await okuUSD.getAddress(),
            await okuUSD.getAddress()
        )
        await mockNttManager.waitForDeployment()

        // Deploy NttAdapter
        nttAdapter = await new NttAdapter__factory(Frank).deploy(
            await mockNttManager.getAddress(),
            await okuUSD.getAddress(),
            frankAddr
        )
        await nttAdapter.waitForDeployment()

        // Configure roles
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

        // Grant MINTER_ROLE to MockNttManager for completeBridge()
        await okuUSD.connect(Frank).grantRole(MINTER_ROLE, await mockNttManager.getAddress())
        await okuUSD.connect(Frank).configureMinterAllowance(
            await mockNttManager.getAddress(),
            parseEther("1000000000")
        )
    })

    describe("NttAdapter Direct Tests", () => {
        it("Bridge records pending transfer in NttManager", async () => {
            const aliceAddr = await Alice.getAddress()
            const bobAddr = await Bob.getAddress()
            const bridgeAmount = parseUnits("10000", 6)

            // Note: In production, the router burns tokens before calling adapter.
            // For standalone testing, we just verify the adapter correctly calls NttManager.
            // The adapter doesn't handle tokens - it just forwards the bridge message.

            const pendingCountBefore = await mockNttManager.pendingTransfersCount()

            // Call bridge (adapter doesn't transfer tokens, just records message)
            await nttAdapter.connect(Alice).bridge(
                await okuUSD.getAddress(),
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
            await nttAdapter.connect(Alice).bridge(
                await okuUSD.getAddress(),
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
                nttAdapter.connect(Alice).bridge(
                    await okuUSD.getAddress(),
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
                nttAdapter.connect(Alice).bridge(
                    await okuUSD.getAddress(),
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

            await nttAdapter.connect(Alice).bridge(
                await okuUSD.getAddress(),
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

            await nttAdapter.connect(Alice).bridge(
                await okuUSD.getAddress(),
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
            const bobBalanceBefore = await okuUSD.balanceOf(bobAddr)

            // Bridge to Bob (adapter records message, doesn't handle tokens)
            await nttAdapter.connect(Alice).bridge(
                await okuUSD.getAddress(),
                bridgeAmount,
                ARBITRUM_CHAIN_ID,
                bobAddr
            )

            // Complete the bridge (mock mints tokens)
            const pendingCount = await mockNttManager.pendingTransfersCount()
            await mockNttManager.completeBridge(pendingCount - 1n)

            // Bob should have received OkuUSD
            const bobBalanceAfter = await okuUSD.balanceOf(bobAddr)
            expect(bobBalanceAfter - bobBalanceBefore).to.equal(bridgeAmount)
        })

        it("Bridge amount preserved regardless of rebase", async () => {
            const charlieAddr = await Charlie.getAddress()
            const bridgeAmount = parseUnits("10000", 6)

            // Bridge to Charlie
            await nttAdapter.connect(Alice).bridge(
                await okuUSD.getAddress(),
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

            // Rebase +10% AFTER bridge message recorded
            const multiplierBefore = await okuUSD.rewardMultiplier()
            const newMultiplier = multiplierBefore * 110n / 100n
            await okuUSD.connect(Frank).updateRewardMultiplier(newMultiplier)

            // Complete the bridge
            const charlieBalanceBefore = await okuUSD.balanceOf(charlieAddr)
            await mockNttManager.completeBridge(transferIndex)
            const charlieBalanceAfter = await okuUSD.balanceOf(charlieAddr)

            // Charlie receives the recorded amount (raw token units)
            // The mock mints exactly what was recorded
            // Note: 1 wei rounding possible due to OkuUSD share conversion
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
            const tx = await nttAdapter.connect(Frank).withdrawETH(frankAddr)
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

            // Get OkuUSD and accidentally send to adapter
            await getOkuUSD(Frank, depositAmount)
            const okuUSDBalance = await okuUSD.balanceOf(frankAddr)

            // Transfer directly to adapter (accident)
            await okuUSD.connect(Frank).transfer(await nttAdapter.getAddress(), okuUSDBalance)

            // Verify tokens stuck
            expect(await okuUSD.balanceOf(await nttAdapter.getAddress())).to.be.gt(0)

            // Owner recovers
            const frankBalanceBefore = await okuUSD.balanceOf(frankAddr)
            await nttAdapter.connect(Frank).withdrawTokens(
                await okuUSD.getAddress(),
                frankAddr,
                await okuUSD.balanceOf(await nttAdapter.getAddress())
            )

            // Verify tokens recovered
            const frankBalanceAfter = await okuUSD.balanceOf(frankAddr)
            expect(frankBalanceAfter).to.be.gt(frankBalanceBefore)

            // Adapter should be empty (allow 1 wei rounding from OkuUSD share math)
            expect(await okuUSD.balanceOf(await nttAdapter.getAddress())).to.be.lte(1)
        })

        it("Non-owner cannot withdraw", async () => {
            // Send ETH to adapter
            await Frank.sendTransaction({
                to: await nttAdapter.getAddress(),
                value: parseEther("0.1")
            })

            // Alice tries to withdraw
            await expect(
                nttAdapter.connect(Alice).withdrawETH(await Alice.getAddress())
            ).to.be.revertedWithCustomError(nttAdapter, "OwnableUnauthorizedAccount")
        })
    })
})
