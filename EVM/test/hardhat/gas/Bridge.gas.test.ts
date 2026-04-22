import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import {
    OkuBridge,
    OkuMoney,
    OkuBridgeRouter,
    OkuDollar,
    OkuBridge__factory,
    OkuMoney__factory,
    OkuBridgeRouter__factory,
    OkuDollar__factory,
    MockBridgeAdapter,
    MockBridgeAdapter__factory,
} from "../../../typechain-types"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"

/**
 * Gas-regression suite for the bridge stack. The exhaustive functional coverage
 * lives in the Foundry tests under EVM/test/bridge — this Hardhat suite exists
 * only to assert that real-deployment gas costs (under the upgrades plugin and
 * full proxy machinery) stay within the targets we publish.
 *
 * Anything that is NOT a gas assertion belongs in Foundry.
 */
describe("Bridge — gas regression", function () {
    let okuBridge: OkuBridge
    let okuMoney: OkuMoney
    let okuUsd: OkuDollar
    let bridgeRouter: OkuBridgeRouter
    let mockAdapter: MockBridgeAdapter

    let admin: SignerWithAddress
    let orchestratorSigner: SignerWithAddress
    let feeRecipient: SignerWithAddress
    let user1: SignerWithAddress
    let user2: SignerWithAddress

    const OPTIMISM_CHAIN_ID = 10
    const ARBITRUM_CHAIN_ID = 42161
    const MAX_SUPPLY = ethers.parseEther("1000000000")

    const types = {
        BridgeRequest: [
            { name: "sourceChainId", type: "uint256" },
            { name: "destChainId", type: "uint256" },
            { name: "sender", type: "address" },
            { name: "recipient", type: "bytes32" },
            { name: "amount", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ],
    }

    function addressToBytes32(addr: string): string {
        return ethers.zeroPadValue(addr, 32)
    }

    async function futureDeadline(seconds: number = 3600): Promise<number> {
        const block = await ethers.provider.getBlock("latest")
        return block!.timestamp + seconds
    }

    let domain: any

    beforeEach(async function () {
        ;[admin, orchestratorSigner, feeRecipient, user1, user2] = await ethers.getSigners()

        // OkuMoney
        okuMoney = (await upgrades.deployProxy(
            new OkuMoney__factory(admin),
            ["OkuMoney", "OkuM", admin.address, MAX_SUPPLY],
            { kind: "uups" }
        )) as unknown as OkuMoney
        await okuMoney.waitForDeployment()

        // OkuDollar
        okuUsd = (await upgrades.deployProxy(
            new OkuDollar__factory(admin),
            [
                await okuMoney.getAddress(),
                "OkuDollar",
                "usdOku",
                admin.address,
                ethers.parseEther("0.95"),
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        )) as unknown as OkuDollar
        await okuUsd.waitForDeployment()

        // OkuBridge
        okuBridge = (await upgrades.deployProxy(
            new OkuBridge__factory(admin),
            [
                await okuMoney.getAddress(),
                orchestratorSigner.address,
                feeRecipient.address,
                admin.address,
                [OPTIMISM_CHAIN_ID, ARBITRUM_CHAIN_ID],
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        )) as unknown as OkuBridge
        await okuBridge.waitForDeployment()

        // OkuBridgeRouter
        bridgeRouter = (await upgrades.deployProxy(
            new OkuBridgeRouter__factory(admin),
            [
                await okuUsd.getAddress(),
                await okuMoney.getAddress(),
                await okuBridge.getAddress(),
                admin.address,
            ],
            { kind: "uups", unsafeAllow: ["constructor"] }
        )) as unknown as OkuBridgeRouter
        await bridgeRouter.waitForDeployment()

        // Mock adapter
        mockAdapter = await new MockBridgeAdapter__factory(admin).deploy(
            await okuMoney.getAddress()
        )
        await mockAdapter.waitForDeployment()

        // Roles + allowances. With the unified role policy, admin already holds
        // every role on every contract — we only need to grant cross-contract
        // roles (e.g. OkuBridge / Router as MINTER on OkuMoney).
        await okuMoney.connect(admin).grantRole(
            ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER")),
            await okuBridge.getAddress()
        )
        await okuMoney.connect(admin).grantRole(
            ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER")),
            await bridgeRouter.getAddress()
        )
        await okuMoney.connect(admin).grantRole(
            ethers.keccak256(ethers.toUtf8Bytes("OKUM_MINTER")),
            await mockAdapter.getAddress()
        )
        await okuMoney
            .connect(admin)
            .configureMinterAllowance(admin.address, MAX_SUPPLY)
        await okuMoney
            .connect(admin)
            .configureMinterAllowance(await okuBridge.getAddress(), MAX_SUPPLY)
        await okuMoney
            .connect(admin)
            .configureMinterAllowance(await bridgeRouter.getAddress(), MAX_SUPPLY)
        await okuMoney
            .connect(admin)
            .configureMinterAllowance(await mockAdapter.getAddress(), MAX_SUPPLY)
        await bridgeRouter
            .connect(admin)
            .configureAdapter(await mockAdapter.getAddress(), true)

        // EIP-712 domain for OkuBridge
        const chainId = (await ethers.provider.getNetwork()).chainId
        domain = {
            name: "OkuBridge",
            version: "1",
            chainId,
            verifyingContract: await okuBridge.getAddress(),
        }
    })

    it("bridgeBurn stays under 200k gas", async function () {
        const amount = ethers.parseEther("100")
        await okuMoney.connect(admin).mint(user1.address, amount)
        await okuMoney.connect(user1).approve(await okuBridge.getAddress(), amount)

        const tx = await okuBridge
            .connect(user1)
            .bridgeBurn(ARBITRUM_CHAIN_ID, addressToBytes32(user2.address), amount)
        const receipt = await tx.wait()
        expect(receipt!.gasUsed).to.be.lessThan(200000n)
    })

    it("bridgeMint stays under 160k gas", async function () {
        const amount = ethers.parseEther("100")
        const chainId = (await ethers.provider.getNetwork()).chainId
        const request = {
            sourceChainId: OPTIMISM_CHAIN_ID,
            destChainId: chainId,
            sender: user1.address,
            recipient: addressToBytes32(user2.address),
            amount: amount,
            nonce: 0,
            deadline: await futureDeadline(),
        }
        const signature = await orchestratorSigner.signTypedData(domain, types, request)

        const tx = await okuBridge.bridgeMint(request, signature)
        const receipt = await tx.wait()
        expect(receipt!.gasUsed).to.be.lessThan(160000n)
    })

    it("bridgeRouter native path increments OkuBridge nonce; adapter path does not", async function () {
        // Path-distinction sanity check that doesn't duplicate Foundry coverage —
        // verifies the two router paths are wired to different downstream targets.
        const amount = ethers.parseEther("100")
        await okuMoney.connect(admin).mint(user1.address, amount * 2n)
        await okuMoney.connect(user1).approve(await bridgeRouter.getAddress(), amount * 2n)

        await bridgeRouter
            .connect(user1)
            .bridgeOkuM(amount, ARBITRUM_CHAIN_ID, addressToBytes32(user2.address))
        expect(await okuBridge.outboundNonce(ARBITRUM_CHAIN_ID)).to.equal(1n)
        expect(await mockAdapter.pendingBridgesCount()).to.equal(0n)

        await bridgeRouter
            .connect(user1)
            .bridgeVia(amount, await mockAdapter.getAddress(), OPTIMISM_CHAIN_ID, user2.address)
        expect(await okuBridge.outboundNonce(OPTIMISM_CHAIN_ID)).to.equal(0n)
        expect(await mockAdapter.pendingBridgesCount()).to.equal(1n)
    })
})
