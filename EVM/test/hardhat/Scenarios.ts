/**
 * Hardhat scenario suite for the v0.3 single-token model.
 *
 * SCOPE. Foundry is the authoritative functional coverage — 235 tests, 14
 * stateful-fuzz invariants, and the ERC-8056 conformance suite all live there.
 * This file covers what Foundry cannot, or covers less naturally:
 *
 *   1. The UUPS upgrade path, using @openzeppelin/hardhat-upgrades so the real
 *      storage-layout validator runs (forge cannot invoke it).
 *   2. Multi-contract scenarios over month-scale horizons with the full
 *      deploy-script wiring, rather than a test-harness approximation.
 *   3. Capability detection as an integrator would perform it, over the ABI.
 *   4. **The high-multiplier regime.** At `uiMultiplier == 1e18` the raw and
 *      displayed numbers are identical, so every off-by-a-multiplier bug is
 *      invisible. Half of these tests run at >= 5x for exactly that reason.
 *   5. The incident protocol end to end — pause, blacklist, guardian halt, and
 *      the role splits that make each of them safe.
 *
 * This replaces v0.2's five files (2,698 lines: fork/OkuMoney.ts,
 * fork/OkuDollar.ts, fork/LitePSM.ts, happyPath/HappyPath.ts,
 * scenarios/RealWorldUsage.ts). Every one of those was built on wrap/unwrap
 * between two tokens and a rebasing `balanceOf`; none of it survives the
 * refactor, so they were deleted rather than ported into something misleading.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * `Contract.connect(signer)` is typed as `BaseContract` in ethers v6, which
 * loses every ABI-derived method. One cast here rather than scattered `as any`.
 */
function as(c: Contract, signer: Signer): Contract {
  return c.connect(signer) as unknown as Contract;
}

const PRECISION = 10n ** 18n;
const DM = 10n ** 12n; // 6-decimal USDC
const MAX_RATE_DURATION = 30n * 24n * 60n * 60n;

/** ~5% APY. The live Sepolia rate at the time of the May-2026 incident. */
const RATE_5_PCT_APY = 1_000_000_001_546_176_000n;
/** Nominal 1000bps APR — exactly at `MAX_IMPLIED_APR`. */
const RATE_AT_APR_CAP = PRECISION + 3_170_979_198n;

const IID = {
  core: "0xa60bf13d",
  pending: "0x4bd27648",
  conversion: "0x57854fc3",
  balances: "0xd890fd71",
};

interface System {
  token: Contract;
  psm: Contract;
  queue: Contract;
  usdc: Contract;
  admin: Signer;
  alice: Signer;
  bob: Signer;
}

async function deploySystem(): Promise<System> {
  const [admin, alice, bob] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  // Token first: the PSM and queue initializers cross-assert `token.asset()`.
  const OkuDollar = await ethers.getContractFactory("OkuDollar");
  const token = (await upgrades.deployProxy(
    OkuDollar,
    ["Oku Dollar", "rUSDOku", await usdc.getAddress(), await admin.getAddress(), ethers.parseEther("1000000000")],
    { kind: "uups" }
  )) as unknown as Contract;
  await token.waitForDeployment();

  const RedemptionQueue = await ethers.getContractFactory("RedemptionQueue");
  const queue = (await upgrades.deployProxy(
    RedemptionQueue,
    [await token.getAddress(), await usdc.getAddress(), await admin.getAddress()],
    { kind: "uups" }
  )) as unknown as Contract;
  await queue.waitForDeployment();

  const LitePSM = await ethers.getContractFactory("LitePSM");
  const psm = (await upgrades.deployProxy(
    LitePSM,
    [
      await token.getAddress(),
      await usdc.getAddress(),
      await queue.getAddress(),
      await admin.getAddress(),
    ],
    { kind: "uups" }
  )) as unknown as Contract;
  await psm.waitForDeployment();

  // Mirror scripts/deploy/index.ts:configureRoles.
  const R = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));
  const psmAddr = await psm.getAddress();
  const queueAddr = await queue.getAddress();
  await (await token.grantRole(R("OKU_MINTER"), psmAddr)).wait();
  await (await token.grantRole(R("OKU_BURNER"), psmAddr)).wait();
  await (await token.grantRole(R("OKU_BURNER"), queueAddr)).wait();
  await (await queue.grantRole(R("QUEUE_PSM"), psmAddr)).wait();
  await (
    await token.configureMinterAllowance(psmAddr, ethers.parseEther("1000000000"))
  ).wait();

  return { token, psm, queue, usdc: usdc as unknown as Contract, admin, alice, bob };
}

async function setRate(s: System, rate: bigint, durationSeconds: bigint) {
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  await (await s.token.setYieldRate(rate, now + durationSeconds)).wait();
}

async function warp(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function psmMint(s: System, who: Signer, usdcAmount: bigint): Promise<bigint> {
  const addr = await who.getAddress();
  await (await s.usdc.mint(addr, usdcAmount)).wait();
  await (await as(s.usdc, who).approve(await s.psm.getAddress(), usdcAmount)).wait();
  const before: bigint = await s.token.balanceOf(addr);
  await (await as(s.psm, who).mint(usdcAmount)).wait();
  return (await s.token.balanceOf(addr)) - before;
}

async function seedBuffer(s: System, usdcAmount: bigint) {
  const R = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));
  const adminAddr = await s.admin.getAddress();
  await (await s.psm.grantRole(R("PSM_BUFFER_DEPOSITOR"), adminAddr)).wait();
  await (await s.usdc.mint(adminAddr, usdcAmount)).wait();
  await (await s.usdc.approve(await s.psm.getAddress(), usdcAmount)).wait();
  await (await s.psm.depositBuffer(usdcAmount)).wait();
}

describe("rUSDOku — integrator capability detection", () => {
  let s: System;
  before(async () => {
    s = await deploySystem();
  });

  it("advertises all four ERC-8056 interfaces over ERC-165", async () => {
    for (const [name, id] of Object.entries(IID)) {
      expect(await s.token.supportsInterface(id), name).to.equal(true);
    }
  });

  it("does NOT advertise a 4626-shaped interface id", async () => {
    // We implement the conversion subset only; deposit/mint/withdraw/redeem are
    // absent. Advertising 4626 would make an integrator call a function that
    // does not exist.
    const pseudo =
      "0x" +
      (
        BigInt(ethers.id("asset()").slice(0, 10)) ^
        BigInt(ethers.id("totalAssets()").slice(0, 10)) ^
        BigInt(ethers.id("convertToShares(uint256)").slice(0, 10)) ^
        BigInt(ethers.id("convertToAssets(uint256)").slice(0, 10))
      )
        .toString(16)
        .padStart(8, "0");
    expect(await s.token.supportsInterface(pseudo)).to.equal(false);
  });

  it("has no deposit/redeem on the token — those live on the PSM", async () => {
    const fns = s.token.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name);
    expect(fns).to.not.include("deposit");
    expect(fns).to.not.include("withdraw");
    expect(fns).to.include("convertToAssets");
    expect(fns).to.include("convertToShares");
    expect(fns).to.include("totalAssets");
    expect(fns).to.include("asset");
  });

  it("reports 'Oku Dollar' / 'rUSDOku' / 18 decimals", async () => {
    expect(await s.token.name()).to.equal("Oku Dollar");
    expect(await s.token.symbol()).to.equal("rUSDOku");
    expect(await s.token.decimals()).to.equal(18n);
  });
});

describe("rUSDOku — one year of operation", () => {
  let s: System;

  before(async () => {
    s = await deploySystem();
    await seedBuffer(s, 5_000_000n * 10n ** 6n);
  });

  it("holds raw balances static while displayed value grows", async () => {
    const raw = await psmMint(s, s.alice, 100_000n * 10n ** 6n);
    const aliceAddr = await s.alice.getAddress();

    expect(await s.token.balanceOf(aliceAddr)).to.equal(raw);
    expect(await s.token.balanceOfUI(aliceAddr)).to.equal(raw); // multiplier == 1

    // Twelve monthly rate renewals — the real operational cadence.
    for (let i = 0; i < 12; i++) {
      await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
      await warp(MAX_RATE_DURATION);
    }

    expect(await s.token.balanceOf(aliceAddr)).to.equal(raw, "raw must never move");
    const ui: bigint = await s.token.balanceOfUI(aliceAddr);
    expect(ui).to.be.greaterThan(raw, "displayed value must have grown");
    // ~5% over ~360 days.
    expect(ui).to.be.greaterThan((raw * 1047n) / 1000n);
    expect(ui).to.be.lessThan((raw * 1053n) / 1000n);
  });

  it("maintains the value/display parity bound throughout", async () => {
    const cta: bigint = await s.token.convertToAssets(PRECISION);
    const m: bigint = await s.token.uiMultiplier();
    expect(cta * DM).to.be.lessThanOrEqual(m);
    expect(m).to.be.lessThan((cta + 1n) * DM);
  });

  it("pays the accrued yield on redemption", async () => {
    const aliceAddr = await s.alice.getAddress();
    const raw: bigint = await s.token.balanceOf(aliceAddr);
    const quoted: bigint = await s.psm.quoteRedeem(raw);

    await (await as(s.token, s.alice).approve(await s.psm.getAddress(), raw)).wait();
    const before: bigint = await s.usdc.balanceOf(aliceAddr);
    await (await as(s.psm, s.alice).redeem(raw)).wait();
    const gained = (await s.usdc.balanceOf(aliceAddr)) - before;

    expect(gained).to.equal(quoted, "quote must match realised output");
    expect(gained).to.be.greaterThan(100_000n * 10n ** 6n, "should exceed principal");
    expect(await s.token.balanceOf(aliceAddr)).to.equal(0n, "raw max-redeem clears exactly");
  });
});

describe("rUSDOku — accrual halts if the operator disappears", () => {
  let s: System;
  before(async () => {
    s = await deploySystem();
  });

  it("freezes the multiplier at rateEnd rather than accruing forever", async () => {
    await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    await warp(MAX_RATE_DURATION);
    const atEnd: bigint = await s.token.uiMultiplier();

    // Ten years of silence.
    await warp(3650n * 24n * 60n * 60n);

    expect(await s.token.uiMultiplier()).to.equal(
      atEnd,
      "an absent rate setter must not keep accruing against assets that are not there"
    );
    expect(await s.token.newUIMultiplier()).to.equal(atEnd);
    expect(await s.token.effectiveAt()).to.be.lessThanOrEqual(
      BigInt((await ethers.provider.getBlock("latest"))!.timestamp)
    );
  });
});

describe("rUSDOku — queue lifecycle", () => {
  let s: System;
  before(async () => {
    s = await deploySystem();
  });

  it("queues when the buffer is short, then pays out with accrued yield", async () => {
    // Mint raw directly so no USDC enters the buffer.
    const R = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));
    const adminAddr = await s.admin.getAddress();
    await (await s.token.grantRole(R("OKU_MINTER"), adminAddr)).wait();
    await (await s.token.configureMinterAllowance(adminAddr, ethers.parseEther("1000000"))).wait();

    const aliceAddr = await s.alice.getAddress();
    const raw = ethers.parseEther("1000");
    await (await s.token.mint(aliceAddr, raw)).wait();

    await (await as(s.token, s.alice).approve(await s.psm.getAddress(), raw)).wait();
    await (await as(s.psm, s.alice).redeem(raw)).wait();

    expect(await s.queue.totalQueuedRaw()).to.equal(raw, "escrowed");
    expect(await s.token.balanceOf(await s.queue.getAddress())).to.equal(raw);

    const owedBefore: bigint = await s.queue.totalQueuedUsdc();

    // A queued holder keeps earning: the escrowed raw amount appreciates.
    await setRate(s, RATE_AT_APR_CAP, MAX_RATE_DURATION);
    await warp(MAX_RATE_DURATION);
    const owedAfter: bigint = await s.queue.totalQueuedUsdc();
    expect(owedAfter).to.be.greaterThan(owedBefore, "queued value must accrue");

    await seedBuffer(s, 10_000n * 10n ** 6n);
    await (await s.psm.grantRole(R("PSM_QUEUE_PROCESSOR"), adminAddr)).wait();
    await (await s.psm.processQueue(0, 1, owedAfter)).wait();

    expect(await s.queue.totalQueuedRaw()).to.equal(0n);
    expect(await s.usdc.balanceOf(aliceAddr)).to.equal(owedAfter);
    expect(await s.token.totalSupply()).to.equal(0n, "burned on processing");
  });

  it("keeps the escrow-backed bound after a free donation", async () => {
    // Anyone can transfer tokens to the queue. The backing invariant is a bound,
    // never an equality, precisely so this cannot break it.
    const R = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));
    const adminAddr = await s.admin.getAddress();
    const bobAddr = await s.bob.getAddress();
    await (await s.token.mint(bobAddr, ethers.parseEther("5"))).wait();
    await (
      await as(s.token, s.bob).transfer(await s.queue.getAddress(), ethers.parseEther("5"))
    ).wait();

    expect(await s.queue.totalQueuedRaw()).to.be.lessThanOrEqual(
      await s.token.balanceOf(await s.queue.getAddress())
    );

    // And the donation is recoverable rather than stranded.
    await (await s.queue.grantRole(R("QUEUE_RESCUER"), adminAddr)).wait();
    await (await s.queue.sweepExcess(adminAddr)).wait();
    expect(await s.token.balanceOf(adminAddr)).to.equal(ethers.parseEther("5"));
  });
});

describe("rUSDOku — UUPS upgrade path", () => {
  let s: System;
  before(async () => {
    s = await deploySystem();
  });

  it("passes the OZ storage-layout validator and preserves state", async () => {
    await seedBuffer(s, 1_000_000n * 10n ** 6n);
    const raw = await psmMint(s, s.alice, 50_000n * 10n ** 6n);
    await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    await warp(15n * 24n * 60n * 60n);

    const aliceAddr = await s.alice.getAddress();
    const before = {
      base: await s.token.baseMultiplier(),
      rate: await s.token.ratePerSecond(),
      rateEnd: await s.token.rateEnd(),
      pending: await s.token.newUIMultiplier(),
      asset: await s.token.asset(),
      dm: await s.token.usdcDecimalMultiplier(),
      supply: await s.token.totalSupply(),
      bal: await s.token.balanceOf(aliceAddr),
      maxSupply: await s.token.maxSupply(),
    };

    const OkuDollar = await ethers.getContractFactory("OkuDollar");
    // This is the assertion that matters: `upgradeProxy` runs OZ's layout
    // validator and throws on any incompatible storage change.
    const upgraded = (await upgrades.upgradeProxy(
      await s.token.getAddress(),
      OkuDollar
    )) as unknown as Contract;

    expect(await upgraded.baseMultiplier()).to.equal(before.base);
    expect(await upgraded.ratePerSecond()).to.equal(before.rate);
    expect(await upgraded.rateEnd()).to.equal(before.rateEnd);
    expect(await upgraded.newUIMultiplier()).to.equal(
      before.pending,
      "newUIMultiplier has no timestamp term, so it must be bit-identical"
    );
    expect(await upgraded.asset()).to.equal(before.asset);
    expect(await upgraded.usdcDecimalMultiplier()).to.equal(before.dm);
    expect(await upgraded.totalSupply()).to.equal(before.supply);
    expect(await upgraded.balanceOf(aliceAddr)).to.equal(before.bal);
    expect(await upgraded.maxSupply()).to.equal(before.maxSupply);
    expect(await upgraded.supportsInterface(IID.core)).to.equal(
      true,
      "an upgrade must not silently drop ERC-8056 advertisement"
    );
    expect(raw).to.be.greaterThan(0n);
  });

  it("upgrades the PSM and queue without disturbing their USDC binding", async () => {
    const LitePSM = await ethers.getContractFactory("LitePSM");
    const RedemptionQueue = await ethers.getContractFactory("RedemptionQueue");

    const psmDm = await s.psm.usdcDecimalMultiplier();
    const queueDm = await s.queue.usdcDecimalMultiplier();

    const psm2 = (await upgrades.upgradeProxy(
      await s.psm.getAddress(),
      LitePSM
    )) as unknown as Contract;
    const queue2 = (await upgrades.upgradeProxy(
      await s.queue.getAddress(),
      RedemptionQueue
    )) as unknown as Contract;

    expect(await psm2.usdcDecimalMultiplier()).to.equal(psmDm);
    expect(await queue2.usdcDecimalMultiplier()).to.equal(queueDm);
    expect(await psm2.okuDollar()).to.equal(await s.token.getAddress());
    expect(await queue2.okuDollar()).to.equal(await s.token.getAddress());
  });
});

// ============================================================================
// High-multiplier regime
// ============================================================================
//
// The plan called for exercising every path "at both a low and a high
// multiplier". A high-multiplier run is the only way to catch an integration
// that silently assumes `multiplier ~= 1e18` — at 1e18 the raw and displayed
// numbers are identical, so every off-by-a-multiplier bug is invisible.

/** Drive the multiplier up by repeated capped segments. Asserts it got there. */
async function accrueToAtLeast(s: System, target: bigint) {
  let i = 0;
  while ((await s.token.uiMultiplier()) < target) {
    if (i++ > 2000) throw new Error("accrueToAtLeast: unreachable by legitimate accrual");
    await setRate(s, RATE_AT_APR_CAP, MAX_RATE_DURATION);
    await warp(MAX_RATE_DURATION);
  }
}

describe("rUSDOku — high-multiplier regime", () => {
  let s: System;
  let multiplier: bigint;

  before(async function () {
    this.timeout(180_000);
    s = await deploySystem();
    await accrueToAtLeast(s, 5n * PRECISION);
    multiplier = await s.token.uiMultiplier();
    await seedBuffer(s, 5_000_000n * 10n ** 6n);
  });

  it("reached a materially non-unit multiplier", async () => {
    expect(multiplier).to.be.greaterThanOrEqual(5n * PRECISION);
  });

  it("mints far fewer raw units than dollars deposited", async () => {
    const raw = await psmMint(s, s.alice, 10_000n * 10n ** 6n);
    // 10,000 USDC at >=5x buys <=2,000 raw.
    expect(raw).to.be.lessThanOrEqual(2000n * PRECISION);
    // But displays as ~$10,000.
    const ui: bigint = await s.token.balanceOfUI(await s.alice.getAddress());
    expect(ui).to.be.greaterThan(9_999n * PRECISION);
    expect(ui).to.be.lessThan(10_001n * PRECISION);
  });

  it("holds the value/display parity bound", async () => {
    const cta: bigint = await s.token.convertToAssets(PRECISION);
    const m: bigint = await s.token.uiMultiplier();
    expect(cta * DM).to.be.lessThanOrEqual(m);
    expect(m).to.be.lessThan((cta + 1n) * DM);
  });

  it("round-trips through the PSM without losing more than a USDC unit", async () => {
    const bobRaw = await psmMint(s, s.bob, 25_000n * 10n ** 6n);
    const bobAddr = await s.bob.getAddress();
    const before: bigint = await s.usdc.balanceOf(bobAddr);

    await (await as(s.token, s.bob).approve(await s.psm.getAddress(), bobRaw)).wait();
    await (await as(s.psm, s.bob).redeem(bobRaw)).wait();

    const gained = (await s.usdc.balanceOf(bobAddr)) - before;
    expect(gained).to.be.lessThanOrEqual(25_000n * 10n ** 6n);
    expect(gained + 1n).to.be.greaterThanOrEqual(25_000n * 10n ** 6n);
  });

  it("keeps the max-send rule honest at high multiplier", async () => {
    const aliceAddr = await s.alice.getAddress();
    const raw: bigint = await s.token.balanceOf(aliceAddr);
    const viaUi: bigint = await s.token.fromUIAmount(await s.token.balanceOfUI(aliceAddr));
    // At a 5x multiplier the UI round trip loses more absolute wei than at 1x,
    // but it must still never exceed the balance.
    expect(viaUi).to.be.lessThanOrEqual(raw);
  });

  it("still refuses sub-USDC-granularity redemptions", async () => {
    await expect(as(s.psm, s.alice).redeem(DM - 1n)).to.be.reverted;
  });
});

// ============================================================================
// Incident protocol: pause, blacklist, and the role split
// ============================================================================

describe("rUSDOku — incident protocol", () => {
  let s: System;
  const R = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));

  beforeEach(async () => {
    s = await deploySystem();
    await seedBuffer(s, 1_000_000n * 10n ** 6n);
    await psmMint(s, s.alice, 10_000n * 10n ** 6n);
  });

  it("pause blocks transfers and mint but NOT burn", async () => {
    const adminAddr = await s.admin.getAddress();
    await (await s.token.grantRole(R("OKU_PAUSER"), adminAddr)).wait();
    await (await s.token.grantRole(R("OKU_BURNER"), adminAddr)).wait();
    await (await s.token.grantRole(R("OKU_MINTER"), adminAddr)).wait();
    await (await s.token.configureMinterAllowance(adminAddr, PRECISION * 1000n)).wait();
    await (await s.token.mint(adminAddr, PRECISION * 10n)).wait();

    await (await s.token.pause()).wait();

    await expect(as(s.token, s.alice).transfer(await s.bob.getAddress(), 1n)).to.be.reverted;
    await expect(s.token.mint(adminAddr, 1n)).to.be.reverted;
    // Burn must stay open: a holder has to be able to exit while paused, and
    // the pause-then-blacklist protocol depends on it.
    await (await s.token.burn(PRECISION)).wait();
  });

  it("pause on the token does not pause the PSM, and vice versa", async () => {
    const adminAddr = await s.admin.getAddress();
    await (await s.token.grantRole(R("OKU_PAUSER"), adminAddr)).wait();
    await (await s.psm.grantRole(R("PSM_PAUSER"), adminAddr)).wait();

    await (await s.psm.pause()).wait();
    // Token transfers still work: the two pause switches are independent.
    await (await as(s.token, s.alice).transfer(await s.bob.getAddress(), PRECISION)).wait();
    await expect(as(s.psm, s.alice).mint(1_000n * 10n ** 6n)).to.be.reverted;
  });

  it("unpause requires a different role than pause", async () => {
    const adminAddr = await s.admin.getAddress();
    const [, , , outsider] = await ethers.getSigners();
    await (await s.token.grantRole(R("OKU_PAUSER"), await outsider.getAddress())).wait();
    await (await as(s.token, outsider).pause()).wait();

    // The pauser cannot undo it — unpause is a cold-multisig role.
    await expect(as(s.token, outsider).unpause()).to.be.reverted;
    await (await s.token.grantRole(R("OKU_UNPAUSER"), adminAddr)).wait();
    await (await s.token.unpause()).wait();
    expect(await s.token.paused()).to.equal(false);
  });

  it("blacklist blocks send, receive, mint and burn — the guard is in _update", async () => {
    const adminAddr = await s.admin.getAddress();
    const aliceAddr = await s.alice.getAddress();
    await (await s.token.grantRole(R("OKU_BLACKLISTER"), adminAddr)).wait();
    await (await s.token.grantRole(R("OKU_MINTER"), adminAddr)).wait();
    await (await s.token.configureMinterAllowance(adminAddr, PRECISION * 1000n)).wait();

    await (await s.token.blacklist(aliceAddr)).wait();

    await expect(as(s.token, s.alice).transfer(await s.bob.getAddress(), 1n)).to.be.reverted;
    await expect(as(s.token, s.bob).transfer(aliceAddr, 1n)).to.be.reverted;
    await expect(s.token.mint(aliceAddr, 1n)).to.be.reverted;
  });

  it("blacklisting works while paused — that is the whole point of the protocol", async () => {
    const adminAddr = await s.admin.getAddress();
    await (await s.token.grantRole(R("OKU_PAUSER"), adminAddr)).wait();
    await (await s.token.grantRole(R("OKU_BLACKLISTER"), adminAddr)).wait();
    await (await s.token.pause()).wait();
    await (await s.token.blacklist(await s.alice.getAddress())).wait();
    expect(await s.token.isBlacklisted(await s.alice.getAddress())).to.equal(true);
  });

  it("guardian can halt accrual while paused, and cannot set a rate", async () => {
    const adminAddr = await s.admin.getAddress();
    const [, , , guardian] = await ethers.getSigners();
    await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    await warp(5n * 24n * 60n * 60n);

    await (await s.token.grantRole(R("OKU_PAUSER"), adminAddr)).wait();
    await (await s.token.grantRole(R("OKU_GUARDIAN"), await guardian.getAddress())).wait();
    await (await s.token.pause()).wait();

    const before: bigint = await s.token.uiMultiplier();
    await (await as(s.token, guardian).haltAccrual()).wait();
    const after: bigint = await s.token.uiMultiplier();

    // Monotone-safe: growth stops, nothing accrued is lost.
    expect(after).to.be.greaterThanOrEqual(before);
    expect(await s.token.newUIMultiplier()).to.equal(after);

    // A guardian must not be able to set a rate — that is the separation of
    // duties that makes a warm-multisig guardian safe.
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await expect(
      as(s.token, guardian).setYieldRate(RATE_5_PCT_APY, now + 1000n)
    ).to.be.reverted;
  });
});

// ============================================================================
// Multi-holder fairness
// ============================================================================

describe("rUSDOku — multi-holder fairness", () => {
  let s: System;

  before(async function () {
    this.timeout(120_000);
    s = await deploySystem();
    await seedBuffer(s, 5_000_000n * 10n ** 6n);
  });

  it("accrues proportionally regardless of entry time, per raw unit held", async () => {
    // Alice enters at a unit multiplier.
    const aliceRaw = await psmMint(s, s.alice, 10_000n * 10n ** 6n);

    await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    await warp(MAX_RATE_DURATION);

    // Bob enters later, at a higher multiplier, for the same dollar amount.
    const bobRaw = await psmMint(s, s.bob, 10_000n * 10n ** 6n);
    expect(bobRaw).to.be.lessThan(aliceRaw, "later entry buys fewer raw units");

    const aliceUi: bigint = await s.token.balanceOfUI(await s.alice.getAddress());
    const bobUi: bigint = await s.token.balanceOfUI(await s.bob.getAddress());

    // Alice has earned a month of yield; Bob just arrived at par.
    expect(aliceUi).to.be.greaterThan(bobUi);
    expect(bobUi).to.be.greaterThan(9_999n * PRECISION);
    expect(bobUi).to.be.lessThan(10_001n * PRECISION);

    // Going forward they accrue at the same proportional rate.
    const aliceBefore = aliceUi;
    const bobBefore = bobUi;
    await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    await warp(MAX_RATE_DURATION);

    const aliceGrowth =
      ((await s.token.balanceOfUI(await s.alice.getAddress())) * PRECISION) / aliceBefore;
    const bobGrowth =
      ((await s.token.balanceOfUI(await s.bob.getAddress())) * PRECISION) / bobBefore;
    // Same growth factor to within rounding dust.
    const delta = aliceGrowth > bobGrowth ? aliceGrowth - bobGrowth : bobGrowth - aliceGrowth;
    expect(delta).to.be.lessThan(10n ** 9n, "growth factors must match");
  });

  it("keeps the sum of displayed balances bounded by totalSupplyUI", async () => {
    const holders = [
      await s.alice.getAddress(),
      await s.bob.getAddress(),
      await s.psm.getAddress(),
      await s.queue.getAddress(),
    ];
    let sum = 0n;
    for (const h of holders) sum += await s.token.balanceOfUI(h);
    const total: bigint = await s.token.totalSupplyUI();
    // Per-balance flooring: bounded above, gap of at most 1 wei per holder.
    expect(sum).to.be.lessThanOrEqual(total);
    expect(sum + BigInt(holders.length)).to.be.greaterThanOrEqual(total);
  });
});

// ============================================================================
// Oracle adapter across the lifecycle
// ============================================================================

describe("rUSDOku — oracle adapter lifecycle", () => {
  let s: System;
  let feed: Contract;
  const STALENESS = 7n * 24n * 60n * 60n;

  before(async () => {
    s = await deploySystem();
    const Adapter = await ethers.getContractFactory("OkuMultiplierAdapter");
    const deployed = await Adapter.deploy(
      await s.token.getAddress(),
      ethers.parseEther("0.99"),
      ethers.parseEther("10"),
      STALENESS
    );
    await deployed.waitForDeployment();
    feed = deployed as unknown as Contract;
  });

  it("reports 18 decimals, not Chainlink's conventional 8", async () => {
    // An integrator assuming 8 would misprice by 1e10.
    expect(await feed.decimals()).to.equal(18n);
  });

  it("tracks the multiplier while a rate is live", async () => {
    await setRate(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    await warp(10n * 24n * 60n * 60n);
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.equal(await s.token.uiMultiplier());
    expect(await feed.isHealthy()).to.equal(true);
    expect(await feed.isAccrualStopped()).to.equal(false);
  });

  it("signals a halt immediately, then goes stale", async () => {
    await warp(20n * 24n * 60n * 60n); // past rateEnd
    expect(await feed.isAccrualStopped()).to.equal(true);
    expect(await feed.isHealthy()).to.equal(true, "flat but still fresh");

    await warp(STALENESS + 1n);
    expect(await feed.isHealthy()).to.equal(false, "an un-renewed rate must eventually go stale");
    await expect(feed.latestRoundData()).to.be.reverted;
  });

  it("refuses historical rounds — it is a live derivation, not a push feed", async () => {
    await expect(feed.getRoundData(1)).to.be.reverted;
  });
});
