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
    WOkuUSD__factory
} from "../../../typechain-types"
import { Signer, parseEther } from "ethers"
import { ethers, upgrades } from "hardhat"

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

describe("Happy Path Testing", () => {
    //actors
    let Frank: Signer //admin
    let Bob: Signer // user
    let Alice: Signer

    //contracts
    let okuBridgeRouter: OkuBridgeRouter
    let psm: LitePSM
    let queue: RedemptionQueue
    let okuUSD: OkuUSD
    let wokuUSD: WOkuUSD

    before(async () => {
        // Forking is configured in hardhat.config.ts
        // Set MAINNET_RPC_URL env var to enable fork tests

        const signers = await ethers.getSigners()
        Frank = signers[0]
        Bob = signers[1]
        Alice = signers[2]
    })

    it("Deploy", async () => {
        const frankAddr = await Frank.getAddress()
        const MAX_SUPPLY = parseEther("1000000000") // 1 billion

        // Deploy OkuUSD first (needed by wOkuUSD)
        // initialize(name, symbol, admin, initialMaxSupply)
        okuUSD = await upgrades.deployProxy(
            new OkuUSD__factory(Frank),
            ["OkuUSD", "OKUSD", frankAddr, MAX_SUPPLY],
            { kind: "uups" }
        ) as unknown as OkuUSD
        await okuUSD.waitForDeployment()
        console.log("OkuUSD deployed at:", await okuUSD.getAddress())

        // Deploy wOkuUSD (needs OkuUSD address)
        // initialize(asset_, name, symbol, admin)
        wokuUSD = await upgrades.deployProxy(
            new WOkuUSD__factory(Frank),
            [await okuUSD.getAddress(), "Wrapped OkuUSD", "wOKUSD", frankAddr],
            { kind: "uups" }
        ) as unknown as WOkuUSD
        await wokuUSD.waitForDeployment()
        console.log("wOkuUSD deployed at:", await wokuUSD.getAddress())

        // Deploy RedemptionQueue
        // initialize(_okuUSD, admin)
        queue = await upgrades.deployProxy(
            new RedemptionQueue__factory(Frank),
            [await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as RedemptionQueue
        await queue.waitForDeployment()
        console.log("RedemptionQueue deployed at:", await queue.getAddress())

        // Deploy LitePSM (needs OkuUSD, Queue, and a USDC address)
        // initialize(_okuUSD, _usdc, _redemptionQueue, admin)
        psm = await upgrades.deployProxy(
            new LitePSM__factory(Frank),
            [await okuUSD.getAddress(), USDC_MAINNET, await queue.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as LitePSM
        await psm.waitForDeployment()
        console.log("LitePSM deployed at:", await psm.getAddress())

        // Deploy OkuBridgeRouter
        // initialize(_wOkuUSD, _okuUSD, admin)
        okuBridgeRouter = await upgrades.deployProxy(
            new OkuBridgeRouter__factory(Frank),
            [await wokuUSD.getAddress(), await okuUSD.getAddress(), frankAddr],
            { kind: "uups" }
        ) as unknown as OkuBridgeRouter
        await okuBridgeRouter.waitForDeployment()
        console.log("OkuBridgeRouter deployed at:", await okuBridgeRouter.getAddress())
    })
})
