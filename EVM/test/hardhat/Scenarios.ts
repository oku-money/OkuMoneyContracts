/**
 * Hardhat scenario suite for the v0.4 two-token model (OkuM + USDOku).
 *
 * SCOPE. Foundry is the authoritative functional coverage — 386 tests, the
 * stateful-fuzz invariants and the ERC-8056 conformance suite all live there.
 * This file is deliberately narrow: it covers only what forge cannot, or what
 * forge covers less honestly.
 *
 *   1. THE OZ STORAGE-LAYOUT VALIDATOR ON A REAL `upgradeProxy`, across all
 *      five UUPS proxies. This is the single most valuable thing in the file and
 *      forge cannot invoke it at all.
 *   2. Multi-contract scenarios wired exactly as `scripts/deploy/index.ts` wires
 *      them, over month- and year-scale horizons — a real deployment rather than
 *      a test-harness approximation.
 *   3. **THE HIGH-MULTIPLIER REGIME (>= 5x), AND THE NONZERO SOLVENCY GAP.**
 *      At `M_oku == 1e18` the raw and displayed numbers are identical, so every
 *      off-by-a-multiplier bug is invisible. The same argument now applies to
 *      the solvency gap: at gap zero, `liability == backing` and every
 *      wrap/unwrap mispricing is invisible too. So the scenarios that exercise
 *      conversion pricing run at >= 5x AND with a nonzero gap, on purpose.
 *   4. Integrator capability detection over the ABI and ERC-165 — including the
 *      one probe the two tokens must answer DIFFERENTLY.
 *
 * WHAT IS NOT HERE, AND WHY. Unit-level bounds (`MAX_STEP_BPS`,
 * `MAX_IMPLIED_APR`, `MAX_FEE_BPS`, rounding directions, per-function role
 * gates) are all pinned in Foundry, deterministically and far faster. Repeating
 * them here would buy nothing and would rot.
 *
 * ---------------------------------------------------------------------------
 * SEMANTICS THIS FILE HAS TO RESPECT (each one bit an earlier draft)
 * ---------------------------------------------------------------------------
 *
 *   - STEP COVERAGE IS STATIC AND PER-LEG. `setFees` requires
 *     `tin >= MAX_STEP_BPS` and `tout >= MAX_STEP_BPS`; `setOkuMultiplier`
 *     requires `stepBps <= MAX_STEP_BPS`. Composed, every admissible step is
 *     covered on each leg for all time. `initialize` seeds both legs at the
 *     floor, so the fixture needs NO fee write to be able to mark — and there is
 *     no ratchet, no `stepFeeSource` wiring, and no reset escape hatch.
 *
 *   - `MAX_STEP_BPS` IS 5 (0.05%). A 5x multiplier needs ~3,220 steps, which is
 *     not walkable in a Hardhat test, so `stepToAtLeast` is bounded to modest
 *     targets and larger ones are Foundry's business.
 *
 *   - EVERY STEP ARMS A 60s SYNC WINDOW, but on EVM it GATES NOTHING. It is an
 *     advisory signal for monitoring and for the future bridge adapter. On SVM
 *     the equivalent window gates the direct bridge legs, which EVM has no
 *     counterpart for — `okuM.mint`/`burn` here are the shared supply hooks the
 *     module and queue use for ordinary local subscription and redemption.
 *
 *   - THE SOLVENCY BOUND IS CUMULATIVE, NOT PER-WRITE. Worst-case accrual in one
 *     maximum-length segment (1000 bps APR over 30 days) is ~82 bps, below
 *     `MAX_SOLVENCY_GAP_BPS` (100), so a single rate write from a zero gap can
 *     NEVER be refused. Producing a nonzero gap means accruing `M_usd` while
 *     `M_oku` stands still; funding it means transferring OkuM to the wrapper,
 *     because donations count as backing deliberately — that IS the funding
 *     mechanism.
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

/** Role identifier. `Roles.sol` is `keccak256("NAME")` throughout. */
const R = (n: string) => ethers.keccak256(ethers.toUtf8Bytes(n));

const PRECISION = 10n ** 18n;
const BPS = 10_000n;
const DM = 10n ** 12n; // 6-decimal USDC -> 18-decimal dollars
const DAY = 24n * 60n * 60n;
const MAX_RATE_DURATION = 30n * DAY;

/** `Constants.MAX_STEP_BPS` — the per-step ceiling on `M_oku`. */
const MAX_STEP_BPS = 2n;
/** `Constants.MAX_SOLVENCY_GAP_BPS` — the cumulative ceiling on the gap. */
const MAX_SOLVENCY_GAP_BPS = 100n;
/** `Constants.MIN_MARK_INTERVAL`. Minimum wall-clock gap between two marks. */
const MIN_MARK_INTERVAL = 60n * 60n;

/** ~5% APY as a per-second `M_usd` rate. The live Sepolia rate. */
const RATE_5_PCT_APY = 1_000_000_001_546_176_000n;
/** Nominal ~1000 bps APR — sitting exactly under `MAX_IMPLIED_APR`. */
const RATE_AT_APR_CAP = PRECISION + 3_170_979_198n;

/**
 * A monthly `M_oku` mark at a 5% annual target is ~40.2 bps. 40 is used so the
 * realized index tracks marginally BEHIND the declared 5% index, which is the
 * direction that actually exercises the solvency gap.
 */
const MONTHLY_MARK_BPS = 40n;

/** The four ERC-8056 interface ids, from `Constants.sol`. */
const IID = {
  core: "0xa60bf13d",
  pending: "0x4bd27648",
  conversion: "0x57854fc3",
  balances: "0xd890fd71",
};

interface System {
  okuM: Contract;
  usdOku: Contract;
  wrapper: Contract;
  module: Contract;
  queue: Contract;
  usdc: Contract;
  admin: Signer;
  alice: Signer;
  bob: Signer;
  /** Cached addresses — every helper needs them and `getAddress()` is an await. */
  a: {
    okuM: string;
    usdOku: string;
    wrapper: string;
    module: string;
    queue: string;
    admin: string;
    alice: string;
    bob: string;
  };
}

// ============================================================================
// Fixture — mirrors scripts/deploy/index.ts, including the order
// ============================================================================
//
// MockUSDC -> OkuM -> RedemptionQueue -> SubscriptionModule -> USDOku ->
// USDOkuWrapper, then role wiring, then the three fail-closed writes.
//
// The order is not cosmetic: the module and queue initializers cross-assert
// `okuM.asset()` and `okuM.usdcDecimalMultiplier()`, so OkuM must exist first.
// USDOku has no dependency on any of them (its initializer takes only
// name/symbol/admin) but the wrapper binds both tokens, so it comes last.

async function deploySystem(): Promise<System> {
  const [admin, alice, bob] = await ethers.getSigners();
  const adminAddr = await admin.getAddress();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = (await MockUSDC.deploy()) as unknown as Contract;
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();

  const OkuMFactory = await ethers.getContractFactory("OkuM");
  const okuM = (await upgrades.deployProxy(
    OkuMFactory,
    ["Oku Money", "OkuM", usdcAddr, adminAddr, ethers.parseEther("1000000000")],
    { kind: "uups" }
  )) as unknown as Contract;
  await okuM.waitForDeployment();
  const okuMAddr = await okuM.getAddress();

  const QueueFactory = await ethers.getContractFactory("RedemptionQueue");
  const queue = (await upgrades.deployProxy(
    QueueFactory,
    [okuMAddr, usdcAddr, adminAddr],
    { kind: "uups" }
  )) as unknown as Contract;
  await queue.waitForDeployment();
  const queueAddr = await queue.getAddress();

  const ModuleFactory = await ethers.getContractFactory("SubscriptionModule");
  const module = (await upgrades.deployProxy(
    ModuleFactory,
    [okuMAddr, usdcAddr, queueAddr, adminAddr],
    { kind: "uups" }
  )) as unknown as Contract;
  await module.waitForDeployment();
  const moduleAddr = await module.getAddress();

  const UsdOkuFactory = await ethers.getContractFactory("USDOku");
  const usdOku = (await upgrades.deployProxy(
    UsdOkuFactory,
    ["USD Oku", "USDOku", adminAddr],
    { kind: "uups" }
  )) as unknown as Contract;
  await usdOku.waitForDeployment();
  const usdOkuAddr = await usdOku.getAddress();

  const WrapperFactory = await ethers.getContractFactory("USDOkuWrapper");
  const wrapper = (await upgrades.deployProxy(
    WrapperFactory,
    [okuMAddr, usdOkuAddr, adminAddr],
    { kind: "uups" }
  )) as unknown as Contract;
  await wrapper.waitForDeployment();
  const wrapperAddr = await wrapper.getAddress();

  // ---- Contract grants. These never go to a key in production. ----
  // Test-only: the admin needs supply authority to mint raw directly in
  // fixtures. `initialize` deliberately no longer grants OKU_MINTER/OKU_BURNER
  // to the deploy admin — supply authority belongs to contracts, and issuing it
  // to an EOA only to revoke it later made "no EOA can mint" a property of a
  // script assertion rather than of the contract. Granted explicitly here so
  // the grant is visible as a test affordance, not inherited silently.
  await (await okuM.grantRole(R("OKU_MINTER"), adminAddr)).wait();
  await (await okuM.grantRole(R("OKU_BURNER"), adminAddr)).wait();

  await (await okuM.grantRole(R("OKU_MINTER"), moduleAddr)).wait();
  await (await okuM.grantRole(R("OKU_BURNER"), moduleAddr)).wait();
  await (await okuM.grantRole(R("OKU_BURNER"), queueAddr)).wait();
  await (await okuM.configureMinterAllowance(moduleAddr, ethers.parseEther("1000000000"))).wait();

  // Same role constants, but AccessControl mappings are per contract: holding
  // OKU_MINTER on OkuM confers nothing on USDOku.
  await (await usdOku.grantRole(R("OKU_MINTER"), wrapperAddr)).wait();
  await (await usdOku.grantRole(R("OKU_BURNER"), wrapperAddr)).wait();

  // Deliberately post-init, to avoid a circular dependency.
  await (await queue.grantRole(R("QUEUE_PSM"), moduleAddr)).wait();

  // ---- The fail-closed write. Without this the rate authority is inert. ----
  // `setSolvencySource` unset => `setUsdOkuRate` reverts once liability exists.
  //
  // Was three writes. `okuM.setStepFeeSource(module)` is gone (the token no
  // longer reads the fee schedule), and `setFees` is no longer required —
  // `initialize` already seeded both legs at the step-coverage floor, so the
  // system can mark yield with no configuration at all.
  await (await usdOku.setSolvencySource(wrapperAddr)).wait();

  return {
    okuM,
    usdOku,
    wrapper,
    module,
    queue,
    usdc,
    admin,
    alice,
    bob,
    a: {
      okuM: okuMAddr,
      usdOku: usdOkuAddr,
      wrapper: wrapperAddr,
      module: moduleAddr,
      queue: queueAddr,
      admin: adminAddr,
      alice: await alice.getAddress(),
      bob: await bob.getAddress(),
    },
  };
}

// ============================================================================
// Time
// ============================================================================

async function now(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

async function warp(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

// NOTE: `clearSyncWindow` was removed with the sync window. Nothing user-facing
// is fenced by a mark any more, so there is nothing to clear. What a fixture
// must now advance past is `MIN_MARK_INTERVAL`, which gates the OPERATOR'S next
// mark — see `readyMark`.


// ============================================================================
// M_oku — the stepwise realized index
// ============================================================================

// NOTE: `ensureStepCoverage` was removed here. Step coverage is static now —
// `initialize` seeds both fee legs at `MAX_STEP_BPS` and `setFees` refuses to go
// below it — so any step `setOkuMultiplier` admits is already covered and there
// is nothing to arrange per step.


/**
 * Step `M_oku` to `target` without clearing the window it arms.
 *
 * WALKS IN `MAX_STEP_BPS` CHUNKS. At 5 bps a single write covers very little, so
 * a fixture asking for a 40 bps monthly mark needs eight of them. That is the
 * real production behaviour — the step ceiling sets a minimum cadence — and a
 * fixture's job is to put the multiplier somewhere, not to re-litigate the
 * bound. `StepAboveMaximum` is asserted deterministically in Foundry.
 */
async function stepToNoClear(s: System, target: bigint) {
  let current: bigint = await s.okuM.uiMultiplier();
  if (target <= current) throw new Error("stepToNoClear: not increasing");
  let iterations = 0;
  while (current < target) {
    if (iterations++ > 500) throw new Error("stepToNoClear: too many steps");
    let next = current + (current * MAX_STEP_BPS) / BPS;
    if (next > target) next = target;
    // Marks are cadence-limited (`MIN_MARK_INTERVAL`), so a walk has to advance
    // the clock between them. Note what is NOT here any more: no warp is needed
    // afterwards, because nothing user-facing is fenced by a mark.
    await readyMark(s);
    await (await s.okuM.setOkuMultiplier(next)).wait();
    current = next;
  }
}

/** Advance the clock just far enough that the next mark is admissible. */
async function readyMark(s: System) {
  const nextAt: bigint = await s.okuM.nextMarkAllowedAt();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  if (now < nextAt) {
    await ethers.provider.send("evm_increaseTime", [Number(nextAt - now) + 1]);
    await ethers.provider.send("evm_mine", []);
  }
}

/** Step `M_oku` to `target`, then clear the window so pricing ops work again. */
async function stepTo(s: System, target: bigint) {
  await stepToNoClear(s, target);
}

/** Step `M_oku` up by `bps` basis points of its current value. */
async function stepBy(s: System, bps: bigint) {
  const current: bigint = await s.okuM.uiMultiplier();
  await stepTo(s, current + (current * bps) / BPS);
}

/**
 * Drive `M_oku` to at least `target` by repeated `MAX_STEP_BPS` steps.
 *
 * BOUNDED AT 500 ITERATIONS, which at 5 bps reaches ~1.28x. Larger targets are
 * deliberately out of scope here: reaching 5x legitimately takes ~3,220 marks
 * and `MAX_MULTIPLIER` ~27,600, which is correct behaviour (the minimum-cadence
 * property doing its job) but is not walkable over RPC. Foundry covers the
 * high-multiplier states by writing the ERC-7201 slot directly.
 *
 * `setOkuMultiplier` is deliberately NOT itself sync-gated, so the loop does not
 * warp past the window on every iteration — only once at the end.
 *
 * Asserts rather than giving up quietly, so no test can pass vacuously against
 * a multiplier that never reached the value under test.
 */
async function stepToAtLeast(s: System, target: bigint) {
  let m: bigint = await s.okuM.uiMultiplier();
  let iterations = 0;
  while (m < target) {
    await readyMark(s);
    if (iterations++ > 500) {
      throw new Error(
        `stepToAtLeast: ${target} unreachable from ${m} in 500 steps of ` +
          `${MAX_STEP_BPS}bps. Targets far from 1.0 belong in Foundry, which can ` +
          `write the multiplier slot directly.`
      );
    }
    let next = m + (m * MAX_STEP_BPS) / BPS;
    if (next > target) next = target;
    await (await s.okuM.setOkuMultiplier(next)).wait();
    m = next;
  }
  expect(await s.okuM.uiMultiplier()).to.be.greaterThanOrEqual(target);
}

// ============================================================================
// M_usd — the continuous declared index
// ============================================================================

/** Declare a rate running `duration` seconds from now. Not sync-gated. */
async function setUsdRate(s: System, rate: bigint, duration: bigint) {
  await (await s.usdOku.setUsdOkuRate(rate, (await now()) + duration)).wait();
}

/** Declare a rate and run the clock to its end, so `M_usd` actually moves. */
async function accrueUsd(s: System, rate: bigint, duration: bigint) {
  const d = duration > MAX_RATE_DURATION ? MAX_RATE_DURATION : duration;
  await setUsdRate(s, rate, d);
  await warp(d);
}

// ============================================================================
// Flows
// ============================================================================

async function seedBuffer(s: System, usdcAmount: bigint) {
  await (await s.usdc.mint(s.a.admin, usdcAmount)).wait();
  await (await s.usdc.approve(s.a.module, usdcAmount)).wait();
  await (await s.module.depositBuffer(usdcAmount)).wait();
}

/**
 * Mint raw OkuM directly, bypassing the module. The fixture grants the admin
 * `OKU_MINTER` explicitly (see `deploySystem`) — `initialize` does not.
 */
async function mintRaw(s: System, to: string, amount: bigint) {
  if ((await s.okuM.minterAllowance(s.a.admin)) < amount) {
    await (
      await s.okuM.configureMinterAllowance(s.a.admin, ethers.parseEther("1000000000"))
    ).wait();
  }
  await (await s.okuM.mint(to, amount)).wait();
}

/**
 * Fund the wrapper's OkuM buffer — the on-chain shape of an issuer top-up.
 * Donations count as backing deliberately; this is how the solvency gap is
 * funded, and it needs no privileged call on the wrapper at all.
 */
async function fundBacking(s: System, amount: bigint) {
  await mintRaw(s, s.a.admin, amount);
  await (await s.okuM.transfer(s.a.wrapper, amount)).wait();
}

/** Subscribe through the module. Returns raw OkuM received. */
async function psmMint(s: System, who: Signer, usdcAmount: bigint): Promise<bigint> {
  const addr = await who.getAddress();
  await (await s.usdc.mint(addr, usdcAmount)).wait();
  await (await as(s.usdc, who).approve(s.a.module, usdcAmount)).wait();
  const before: bigint = await s.okuM.balanceOf(addr);
  await (await as(s.module, who).mint(usdcAmount)).wait();
  return (await s.okuM.balanceOf(addr)) - before;
}

/** Wrap raw OkuM into USDOku. Returns SHARES minted, the invariant quantity. */
async function wrap(s: System, who: Signer, okuMAmount: bigint): Promise<bigint> {
  const addr = await who.getAddress();
  await (await as(s.okuM, who).approve(s.a.wrapper, okuMAmount)).wait();
  const before: bigint = await s.usdOku.sharesOf(addr);
  await (await as(s.wrapper, who).wrap(okuMAmount)).wait();
  return (await s.usdOku.sharesOf(addr)) - before;
}

/**
 * Unwrap `usdOkuAmount` dollars back into OkuM. Returns raw OkuM received.
 *
 * Approves `MaxUint256` on purpose: the allowance is dollar-denominated on a
 * rebasing token, so an exact approval computed one block earlier can be short
 * by the time the unwrap lands. That drift is the max-send rule biting, and the
 * fix in production is the same as here — do not size an approval off a moving
 * `balanceOf`.
 */
async function unwrap(s: System, who: Signer, usdOkuAmount: bigint): Promise<bigint> {
  const addr = await who.getAddress();
  await (await as(s.usdOku, who).approve(s.a.wrapper, ethers.MaxUint256)).wait();
  const before: bigint = await s.okuM.balanceOf(addr);
  await (await as(s.wrapper, who).unwrap(usdOkuAmount)).wait();
  return (await s.okuM.balanceOf(addr)) - before;
}

/** Function names on a contract's ABI. */
function fnNames(c: Contract): string[] {
  return c.interface.fragments
    .filter((f: any) => f.type === "function")
    .map((f: any) => f.name);
}

// ============================================================================
// 1. Integrator capability detection
// ============================================================================

describe("OkuM / USDOku — integrator capability detection", () => {
  let s: System;
  before(async () => {
    s = await deploySystem();
  });

  it("advertises all four ERC-8056 interfaces on OkuM", async () => {
    for (const [name, id] of Object.entries(IID)) {
      expect(await s.okuM.supportsInterface(id), name).to.equal(true);
    }
  });

  it("does NOT advertise ERC-8056 on USDOku — the double-scaling hazard", async () => {
    // THE PROBE THE TWO TOKENS MUST ANSWER DIFFERENTLY.
    //
    // USDOku's `balanceOf` is ALREADY dollar-denominated: it returns
    // `sharesOf * usdOkuIndex() / 1e18`. An 8056-aware wallet that detected
    // support here would fetch `uiMultiplier()` and apply it on top of a value
    // that has already been scaled — displaying the balance squared, silently,
    // in the wallet UI. That is strictly worse than advertising nothing at all,
    // which is why `scripts/deploy/index.ts` treats a `true` here as a hard
    // abort rather than a warning, and why it is asserted in both places.
    expect(await s.usdOku.supportsInterface(IID.core)).to.equal(false);
    for (const [name, id] of Object.entries(IID)) {
      expect(await s.usdOku.supportsInterface(id), name).to.equal(false);
    }
  });

  it("does NOT advertise a 4626-shaped interface id on either token", async () => {
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
    expect(await s.okuM.supportsInterface(pseudo)).to.equal(false);
    expect(await s.usdOku.supportsInterface(pseudo)).to.equal(false);
  });

  it("has no 4626 entrypoints on OkuM — subscription lives on the module", async () => {
    const fns = fnNames(s.okuM);
    expect(fns).to.not.include("deposit");
    expect(fns).to.not.include("withdraw");
    expect(fns).to.not.include("redeem");
    expect(fns).to.not.include("maxDeposit");
    // The conversion subset IS present.
    expect(fns).to.include("convertToAssets");
    expect(fns).to.include("convertToShares");
    expect(fns).to.include("totalAssets");
    expect(fns).to.include("asset");
    // ...and so is the one place subscription/redemption actually happens.
    expect(fnNames(s.module)).to.include("mint");
    expect(fnNames(s.module)).to.include("redeem");
  });

  it("exposes no continuous-accrual surface on OkuM — `M_oku` is stepwise", async () => {
    // The v0.3 rate-per-second surface is GONE from the share token. An
    // integrator probing for it must get a clean absence, not a reverting stub.
    const fns = fnNames(s.okuM);
    for (const gone of [
      "setYieldRate",
      "baseMultiplier",
      "ratePerSecond",
      "lastAccrualTime",
      "rateEnd",
      "impliedAprBps",
      "beginSyncWindow",
      "endSyncWindow",
      "syncEpoch",
      // Removed with the step-coverage ratchet. The token no longer reads the
      // module's fee schedule at all, so these must be a clean absence for an
      // integrator probing the old coupling.
      "stepFeeSource",
      "setStepFeeSource",
      "stepHighWaterMark",
      "resetStepHighWaterMark",
    ]) {
      expect(fns, gone).to.not.include(gone);
    }
    expect(fns).to.include("setOkuMultiplier");
    expect(fns).to.include("lastSteppedAt");
    // The continuous surface moved to the token that is actually continuous.
    const usdFns = fnNames(s.usdOku);
    for (const present of ["setUsdOkuRate", "ratePerSecond", "rateEnd", "impliedAprBps"]) {
      expect(usdFns, present).to.include(present);
    }
  });

  it("reports the canonical metadata for both tokens", async () => {
    expect(await s.okuM.name()).to.equal("Oku Money");
    // No `r`/`s` prefix: an `r` reads as *rebasing*, which is precisely
    // backwards for the fixed-balance share token.
    expect(await s.okuM.symbol()).to.equal("OkuM");
    expect(await s.okuM.decimals()).to.equal(18n);

    expect(await s.usdOku.name()).to.equal("USD Oku");
    expect(await s.usdOku.symbol()).to.equal("USDOku");
    expect(await s.usdOku.decimals()).to.equal(18n);
  });

  it("starts with both indices at parity, free to enter and covered to exit", async () => {
    expect(await s.okuM.uiMultiplier()).to.equal(PRECISION);
    // Steps are immediate, so ERC-8056's pending extension is degenerate and
    // this equality is an ALWAYS invariant, not a genesis coincidence.
    expect(await s.okuM.newUIMultiplier()).to.equal(await s.okuM.uiMultiplier());
    expect(await s.okuM.effectiveAt()).to.equal(await s.okuM.lastSteppedAt());

    expect(await s.usdOku.usdOkuIndex()).to.equal(PRECISION);
    expect(await s.usdOku.solvencySource()).to.equal(s.a.wrapper);
    expect(await s.okuM.accrualHalted()).to.equal(false);

    // Fees ship AT the per-leg step-coverage floor, so the deployment can mark
    // yield with no configuration. `initialize` seeds it; `setFees` can only
    // raise it. The fixture performs no fee write at all.
    // Deposits free, exits covered. `tin` has no floor; `tout` does.
    expect(await s.module.tin()).to.equal(0n);
    expect(await s.module.tout()).to.equal(MAX_STEP_BPS);
  });
});

// ============================================================================
// 2. Twelve months of operation
// ============================================================================

describe("OkuM / USDOku — twelve months of operation", () => {
  let s: System;
  /** Raw OkuM alice bought at a unit multiplier. */
  let aliceRaw: bigint;
  /** Raw OkuM alice wrapped into USDOku on day zero. */
  let wrappedRaw: bigint;
  let aliceShares: bigint;
  /** Solvency gap observed after every monthly cycle. */
  const gaps: bigint[] = [];

  before(async function () {
    this.timeout(300_000);
    s = await deploySystem();
    await seedBuffer(s, 20_000_000n * 10n ** 6n);
  });

  it("holds raw balances static while displayed value grows", async () => {
    aliceRaw = await psmMint(s, s.alice, 100_000n * 10n ** 6n);
    expect(await s.okuM.balanceOf(s.a.alice)).to.equal(aliceRaw);
    expect(await s.okuM.balanceOfUI(s.a.alice)).to.equal(aliceRaw, "multiplier == 1");

    // 40% of the position goes into the dollar leg on day zero, so the same
    // horizon exercises both indices against the same principal.
    wrappedRaw = (aliceRaw * 40n) / 100n;
    aliceShares = await wrap(s, s.alice, wrappedRaw);
    expect(aliceShares).to.be.greaterThan(0n);

    // Twelve monthly cycles: mark the realized index, then declare the
    // forward-looking rate for the month ahead, then let the month elapse.
    // That is the real operational cadence, in the real order.
    for (let i = 0; i < 12; i++) {
      await stepBy(s, MONTHLY_MARK_BPS);
      await accrueUsd(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
      gaps.push(await s.wrapper.solvencyGapBps());
    }

    const remaining = aliceRaw - wrappedRaw;
    expect(await s.okuM.balanceOf(s.a.alice)).to.equal(remaining, "raw must never move");

    const ui: bigint = await s.okuM.balanceOfUI(s.a.alice);
    expect(ui).to.be.greaterThan(remaining, "displayed value must have grown");
    // Twelve 40 bps marks compound to ~4.91%.
    expect(ui).to.be.greaterThan((remaining * 1047n) / 1000n);
    expect(ui).to.be.lessThan((remaining * 1053n) / 1000n);
  });

  it("rebases USDOku balances pro rata over the same period", async () => {
    const index: bigint = await s.usdOku.usdOkuIndex();
    expect(index).to.be.greaterThan(PRECISION, "M_usd must have moved");

    // The invariant ledger is shares. The share count is untouched by twelve
    // months of rebasing; only the dollar view moved.
    expect(await s.usdOku.sharesOf(s.a.alice)).to.equal(aliceShares, "shares are invariant");

    const bal: bigint = await s.usdOku.balanceOf(s.a.alice);
    expect(bal).to.equal((aliceShares * index) / PRECISION, "balanceOf is exactly shares * M_usd");
    // Declared 5% for twelve 30-day segments: ~4.93%.
    expect(bal).to.be.greaterThan((wrappedRaw * 1047n) / 1000n);
    expect(bal).to.be.lessThan((wrappedRaw * 1053n) / 1000n);

    // Sole holder, so the liability is exactly this balance up to the per-holder
    // floor. Never assert equality across multiple holders.
    expect(bal).to.be.lessThanOrEqual(await s.usdOku.totalSupply());
  });

  it("maintains the value/display parity bound throughout", async () => {
    // The value layer is USDC-granular (6 dp) and the display layer is 18 dp, so
    // they are related by a floor rather than an equality.
    const cta: bigint = await s.okuM.convertToAssets(PRECISION);
    const m: bigint = await s.okuM.uiMultiplier();
    expect(cta * DM).to.be.lessThanOrEqual(m);
    expect(m).to.be.lessThan((cta + 1n) * DM);
  });

  it("keeps the solvency gap inside MAX_SOLVENCY_GAP_BPS at every mark", async () => {
    expect(gaps.length).to.equal(12);
    for (const [i, gap] of gaps.entries()) {
      expect(gap, `month ${i + 1}`).to.be.lessThanOrEqual(MAX_SOLVENCY_GAP_BPS);
    }
    // 40 bps of realized mark against ~40.2 bps of declared accrual leaves the
    // declared index a hair ahead, month on month. Tiny, positive, and the
    // reason `MONTHLY_MARK_BPS` is 40 rather than 41: a gap that is exactly zero
    // makes every wrap/unwrap mispricing invisible.
    expect(gaps[11]).to.be.greaterThan(0n, "declared should be marginally ahead");
    expect(gaps[11]).to.be.greaterThan(gaps[0], "and the divergence accumulates");
  });

  it("prices a later entrant at the higher multiplier", async () => {
    const bobRaw = await psmMint(s, s.bob, 100_000n * 10n ** 6n);
    expect(bobRaw).to.be.lessThan(aliceRaw, "later entry buys fewer raw units for the same dollars");

    // Bob arrives at par NET OF `tin`, which is now `MAX_STEP_BPS` rather than
    // zero — fees ship at the step-coverage floor. 5 bps of 100,000 is $50.
    const bobUi: bigint = await s.okuM.balanceOfUI(s.a.bob);
    expect(bobUi).to.be.greaterThan(99_940n * PRECISION);
    expect(bobUi).to.be.lessThan(100_001n * PRECISION);
  });

  it("keeps the sum of displayed balances bounded by totalSupplyUI", async () => {
    const holders = [s.a.alice, s.a.bob, s.a.wrapper, s.a.module, s.a.queue, s.a.admin];
    let sum = 0n;
    for (const h of holders) sum += await s.okuM.balanceOfUI(h);
    const total: bigint = await s.okuM.totalSupplyUI();
    // Per-balance flooring: bounded above, gap of at most 1 wei per holder.
    expect(sum).to.be.lessThanOrEqual(total);
    expect(sum + BigInt(holders.length)).to.be.greaterThanOrEqual(total);
  });

  it("pays the accrued yield on redemption", async () => {
    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    const principal = ((100_000n * 10n ** 6n) * 60n) / 100n; // the unwrapped 60%
    const quoted: bigint = await s.module.quoteRedeem(raw);

    await (await as(s.okuM, s.alice).approve(s.a.module, raw)).wait();
    const before: bigint = await s.usdc.balanceOf(s.a.alice);
    await (await as(s.module, s.alice).redeem(raw)).wait();
    const gained = (await s.usdc.balanceOf(s.a.alice)) - before;

    expect(gained).to.equal(quoted, "quote must match realised output");
    expect(gained).to.be.greaterThan(principal, "a year of marks, net of tout");
    expect(await s.okuM.balanceOf(s.a.alice)).to.equal(0n, "raw max-redeem clears exactly");
  });
});

// ============================================================================
// 3. The solvency cycle — declared ahead, then behind
// ============================================================================

describe("USDOku — the full rate cycle: declared ahead, then behind", () => {
  let s: System;
  let wrappedRaw: bigint;

  before(async function () {
    this.timeout(300_000);
    s = await deploySystem();
    await seedBuffer(s, 5_000_000n * 10n ** 6n);
    wrappedRaw = await psmMint(s, s.alice, 1_000_000n * 10n ** 6n);
    await wrap(s, s.alice, wrappedRaw);
  });

  it("starts gap-neutral: a fresh wrap creates liability and backing together", async () => {
    expect(await s.wrapper.declaredLiability()).to.equal(await s.wrapper.realizedBacking());
    expect(await s.wrapper.solvencyGapBps()).to.equal(0n);
    expect(await s.wrapper.backingRatioBps()).to.equal(BPS);
  });

  it("opens a gap when M_usd runs while M_oku stands still", async () => {
    await accrueUsd(s, RATE_AT_APR_CAP, MAX_RATE_DURATION);

    const gap: bigint = await s.wrapper.solvencyGapBps();
    // A full maximum-length segment at the APR cap is ~82 bps of divergence.
    expect(gap).to.be.greaterThan(70n, "declared has run ahead of realized");
    expect(gap).to.be.lessThanOrEqual(MAX_SOLVENCY_GAP_BPS, "but inside the bound");
    expect(await s.wrapper.backingRatioBps()).to.be.lessThan(BPS, "under-backed");
    expect(await s.wrapper.declaredLiability()).to.be.greaterThan(
      await s.wrapper.realizedBacking()
    );
  });

  it("refuses the next full-length segment — the bound is CUMULATIVE", async () => {
    // This is the assertion that pins the constants' interaction. Worst-case
    // accrual in ONE maximum-length segment is ~82 bps, below the 100 bps
    // bound, so a single write from a zero gap can never be refused. The bound
    // only bites once consecutive segments have out-run the realized marks —
    // which is exactly the state the previous test left behind.
    await expect(
      s.usdOku.setUsdOkuRate(RATE_AT_APR_CAP, (await now()) + MAX_RATE_DURATION)
    ).to.be.revertedWithCustomError(s.usdOku, "SolvencyGapExceeded");
  });

  it("can always SLOW DOWN, even sitting at the bound", async () => {
    // Both indices are monotone, so cutting the declared rate is the only
    // on-chain remedy for over-declaration. It must never be blocked by the
    // very condition it fixes: a zero-yield rate makes the projection equal the
    // spot liability, which the check cannot refuse.
    await (await s.usdOku.setUsdOkuRate(PRECISION, (await now()) + MAX_RATE_DURATION)).wait();
    expect(await s.usdOku.ratePerSecond()).to.equal(PRECISION);
    expect(await s.usdOku.impliedAprBps()).to.equal(0n);
  });

  it("gates NOTHING on this chain when a mark lands", async () => {
    // The sync window is GONE on EVM. It gated nothing: narrowed to "bridge
    // legs", EVM turned out to have none — `OkuM.mint`/`burn` are the shared
    // supply hooks the module and queue use for ordinary local subscription and
    // redemption, so gating them would gate the whole PSM.
    //
    // This test is the regression guard. Every operation below reverted at some
    // point during the refactor; all of them must stay live through a mark,
    // because the price they transact at is this chain's own `M_oku` and that is
    // correct whatever a peer chain currently believes.
    await stepToNoClear(s, ((await s.okuM.uiMultiplier()) * 10_001n) / 10_000n);

    await (await s.usdc.mint(s.a.alice, 1_000n * 10n ** 6n)).wait();
    await (await as(s.usdc, s.alice).approve(s.a.module, 1_000n * 10n ** 6n)).wait();
    await (await as(s.module, s.alice).mint(1_000n * 10n ** 6n)).wait();

    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    await (await as(s.okuM, s.alice).approve(s.a.wrapper, raw / 2n)).wait();
    await (await as(s.wrapper, s.alice)["wrap(uint256)"](raw / 2n)).wait();

    await (await s.usdOku.setUsdOkuRate(PRECISION, (await now()) + MAX_RATE_DURATION)).wait();
  });

  it("cadence-limits the OPERATOR instead — the only time gate left", async () => {
    await readyMark(s);
    const m: bigint = await s.okuM.uiMultiplier();
    await (await s.okuM.setOkuMultiplier(m + (m * MAX_STEP_BPS) / BPS)).wait();

    // A second mark immediately after is refused. This is what makes
    // MAX_STEP_BPS a bound on yield per unit TIME rather than per call.
    await expect(s.okuM.setOkuMultiplier((await s.okuM.uiMultiplier()) + 1n))
      .to.be.revertedWithCustomError(s.okuM, "MarkTooSoon");

    // And `distributeYield` is not a second door around it.
    await expect(s.okuM.distributeYield(1n)).to.be.revertedWithCustomError(
      s.okuM,
      "MarkTooSoon"
    );

    await readyMark(s);
    await (await s.okuM.setOkuMultiplier((await s.okuM.uiMultiplier()) + 1n)).wait();
  });

  it("closes the gap and crosses back over 10000 bps as realized catches up", async () => {
    const gapBefore: bigint = await s.wrapper.solvencyGapBps();
    expect(gapBefore).to.be.greaterThan(0n);
    expect(await s.wrapper.backingRatioBps()).to.be.lessThan(BPS);

    // Walk the realized index up until it overtakes the declared one. At
    // `MAX_STEP_BPS` = 5 this is many marks rather than two, which is the
    // minimum-cadence property working as intended — the orchestrator does
    // exactly this after an outage.
    await stepToAtLeast(s, await s.usdOku.usdOkuIndex());
    await stepBy(s, MAX_STEP_BPS);

    const gapAfter: bigint = await s.wrapper.solvencyGapBps();
    expect(gapAfter).to.be.lessThan(gapBefore, "realized catching up closes it");
    expect(gapAfter).to.be.lessThan(0n, "and overtakes — the gap is signed");
    expect(await s.wrapper.backingRatioBps()).to.be.greaterThan(BPS, "crossed back over par");
    expect(await s.wrapper.realizedBacking()).to.be.greaterThan(
      await s.wrapper.declaredLiability()
    );
  });

  it("restores rate headroom once realized backing has caught up", async () => {
    // The two levers — realized marks and declared yield — are linked on-chain,
    // not merely by policy. The write refused two tests ago now succeeds.
    await (
      await s.usdOku.setUsdOkuRate(RATE_AT_APR_CAP, (await now()) + MAX_RATE_DURATION)
    ).wait();
    expect(await s.usdOku.ratePerSecond()).to.equal(RATE_AT_APR_CAP);
  });

  it("funds the gap by donation, with no privileged call on the wrapper", async () => {
    const before: bigint = await s.wrapper.realizedBacking();
    await fundBacking(s, 10_000n * PRECISION);
    expect(await s.wrapper.realizedBacking()).to.be.greaterThan(before);
    expect(await s.wrapper.solvencyGapBps()).to.be.lessThan(0n, "over-backed");
  });
});

// ============================================================================
// 4. The high-multiplier regime
// ============================================================================
//
// A high-multiplier run is the only way to catch an integration that silently
// assumes `M_oku ~= 1e18` — at 1e18 the raw and displayed numbers are identical,
// so every off-by-a-multiplier bug is invisible.
//
// The same argument applies, newly, to the SOLVENCY GAP. At gap zero the
// wrapper's liability and backing are equal, `M_usd == M_oku`, and a conversion
// mispriced at `M_usd` instead of `M_oku` produces the identical number. So the
// conversion-pricing assertions below run at >= 5x AND against a nonzero gap.

/**
 * TARGET REDUCED FROM 5x TO 1.10x.
 *
 * At `MAX_STEP_BPS` = 5 a 5x multiplier needs ~3,220 marks, which is correct
 * behaviour — the step ceiling IS a minimum-cadence rule — but is not walkable
 * over RPC in a test. 1.25x takes ~447 marks, which is slow but real, and it is
 * enough to exercise every property this block cares about: the display layer at
 * a materially non-unit multiplier, the solvency gap, and redemption pricing.
 *
 * Foundry covers the genuinely high-multiplier states (up to `MAX_MULTIPLIER`)
 * by writing the ERC-7201 slot directly, which is the only tractable way to
 * reach them.
 */
describe("OkuM / USDOku — elevated-multiplier regime (>= 1.10x, nonzero gap)", () => {
  let s: System;
  let multiplier: bigint;
  // ~1.10x. At `MAX_STEP_BPS` = 2 with a 1-hour cadence this is ~480 marks,
  // near the practical ceiling for an RPC-driven walk. Higher multipliers are
  // Foundry's, where the ERC-7201 slot can be written directly.
  const TARGET = (11n * PRECISION) / 10n;

  before(async function () {
    this.timeout(600_000);
    s = await deploySystem();
    await stepToAtLeast(s, TARGET);
    multiplier = await s.okuM.uiMultiplier();
    await seedBuffer(s, 5_000_000n * 10n ** 6n);
  });

  it("reached a materially non-unit multiplier by legitimate marks only", async () => {
    expect(multiplier).to.be.greaterThanOrEqual(TARGET);
    expect(await s.okuM.newUIMultiplier()).to.equal(multiplier);
    expect(await s.okuM.effectiveAt()).to.equal(await s.okuM.lastSteppedAt());
  });

  it("keeps the exit fee at or above the step-coverage floor throughout", async () => {
    // The invariant that replaced the ratchet, and it is unconditional: no
    // sequence of marks can move the floor, because the floor is a constant.
    // Note it binds the EXIT leg only — `tin` is free, and ships at zero.
    expect(await s.module.tout()).to.be.greaterThanOrEqual(MAX_STEP_BPS);

    // `tout` cannot be lowered past it, whatever has been marked.
    await expect(
      s.module.setFees(0, MAX_STEP_BPS - 1n)
    ).to.be.revertedWithCustomError(s.module, "FeeBelowStepFloor");

    // Raising is free, and a zero mint fee stays valid.
    await (await s.module.setFees(0, 50)).wait();
  });

  it("mints fewer raw units than dollars deposited", async () => {
    const raw = await psmMint(s, s.alice, 10_000n * 10n ** 6n);
    // At >=1.10x, 10,000 USDC buys <=9,100 raw. Bound scaled with the target
    // when it came down from 5x — see this describe's header.
    expect(raw).to.be.lessThanOrEqual(9100n * PRECISION);
    expect(raw).to.be.greaterThan(0n);
    // And displays as the FULL $10,000: `tin` is zero, so nothing is withheld on
    // the way in. The 50 bps this block configured sits on `tout` alone.
    const ui: bigint = await s.okuM.balanceOfUI(s.a.alice);
    expect(ui).to.be.greaterThan(9_999n * PRECISION);
    expect(ui).to.be.lessThanOrEqual(10_000n * PRECISION);
  });

  it("holds the value/display parity bound at high multiplier", async () => {
    const cta: bigint = await s.okuM.convertToAssets(PRECISION);
    const m: bigint = await s.okuM.uiMultiplier();
    expect(cta * DM).to.be.lessThanOrEqual(m);
    expect(m).to.be.lessThan((cta + 1n) * DM);
  });

  it("round-trips through the module for exactly the quoted amount", async () => {
    const bobRaw = await psmMint(s, s.bob, 25_000n * 10n ** 6n);
    const quoted: bigint = await s.module.quoteRedeem(bobRaw);
    const before: bigint = await s.usdc.balanceOf(s.a.bob);

    await (await as(s.okuM, s.bob).approve(s.a.module, bobRaw)).wait();
    await (await as(s.module, s.bob).redeem(bobRaw)).wait();
    const gained = (await s.usdc.balanceOf(s.a.bob)) - before;

    expect(gained).to.equal(quoted);
    // 50 bps in and 50 bps out of 25,000 USDC, and nothing else.
    expect(gained).to.be.lessThan(25_000n * 10n ** 6n);
    expect(gained).to.be.greaterThan(24_740n * 10n ** 6n);
  });

  it("keeps the max-send rule honest at high multiplier", async () => {
    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    const viaUi: bigint = await s.okuM.fromUIAmount(await s.okuM.balanceOfUI(s.a.alice));
    // At >=5x the UI round trip loses more absolute wei than at 1x, but it must
    // still never exceed the balance. This is the shape of the May-2026
    // `InsufficientBalance()` incident.
    expect(viaUi).to.be.lessThanOrEqual(raw);
  });

  it("still refuses sub-USDC-granularity redemptions", async () => {
    await expect(as(s.module, s.alice).redeem(DM - 1n)).to.be.revertedWithCustomError(
      s.module,
      "AmountTooSmall"
    );
  });

  it("prices wrap and unwrap at M_oku, never at M_usd, across a nonzero gap", async () => {
    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    const m: bigint = await s.okuM.uiMultiplier();

    // Quotes are pure `M_oku`.
    expect(await s.wrapper.quoteWrap(raw)).to.equal((raw * m) / PRECISION);
    const shares = await wrap(s, s.alice, raw);
    expect(shares).to.be.greaterThan(0n);
    expect(await s.wrapper.solvencyGapBps()).to.equal(0n, "a wrap is gap-neutral");

    // Open a real gap: `M_usd` runs, `M_oku` stands still.
    await accrueUsd(s, RATE_AT_APR_CAP, MAX_RATE_DURATION);
    const gap: bigint = await s.wrapper.solvencyGapBps();
    expect(gap).to.be.greaterThan(0n, "the gap must be NONZERO for this to prove anything");
    expect(gap).to.be.lessThanOrEqual(MAX_SOLVENCY_GAP_BPS);

    // The index has diverged, so `M_oku` and `M_usd` now give different answers.
    const index: bigint = await s.usdOku.usdOkuIndex();
    expect(index).to.not.equal(m);

    const dollars: bigint = await s.usdOku.balanceOf(s.a.alice);
    const atMoku: bigint = await s.wrapper.quoteUnwrap(dollars);
    expect(atMoku).to.equal((dollars * PRECISION) / m, "unwrap quotes at M_oku");
    expect(atMoku).to.not.equal((dollars * PRECISION) / index, "and NOT at M_usd");

    // Unwrapping the grown balance needs more OkuM than was wrapped, and the
    // wrapper only holds what was wrapped — so it refuses until the buffer is
    // funded. That refusal is the gap being realized faster than it is funded,
    // and it is the ONLY thing unwrap ever fails on: it is never gated on
    // solvency, because refusing to let people out of an under-funded wrapper is
    // how a slow problem becomes a panic.
    await (await as(s.usdOku, s.alice).approve(s.a.wrapper, ethers.MaxUint256)).wait();
    await expect(
      as(s.wrapper, s.alice).unwrap(dollars)
    ).to.be.revertedWithCustomError(s.wrapper, "InsufficientBacking");

    // Issuer capital standing behind the smoothing.
    await fundBacking(s, 1_000n * PRECISION);
    const got = await unwrap(s, s.alice, await s.usdOku.balanceOf(s.a.alice));
    expect(got).to.be.greaterThan(raw, "the smoothing gap is realized on exit");
    // And the excess is exactly the index ratio, not some larger drain: the
    // extraction is bounded by MAX_SOLVENCY_GAP_BPS at the rate write.
    expect(got).to.be.lessThan((raw * (BPS + MAX_SOLVENCY_GAP_BPS)) / BPS);
  });

  it("round-trips wrap/unwrap within a couple of wei at >=5x", async () => {
    await (await s.usdOku.haltUsdOkuAccrual()).wait(); // freeze M_usd so the trip is clean
    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    expect(raw).to.be.greaterThan(0n);

    await wrap(s, s.alice, raw);
    const back = await unwrap(s, s.alice, await s.usdOku.balanceOf(s.a.alice));

    expect(back).to.be.lessThanOrEqual(raw, "rounding always favours the protocol");
    expect(back + 2n).to.be.greaterThanOrEqual(raw, "and loses at most ~2 wei");
  });
});

// ============================================================================
// 5. Operator absence
// ============================================================================

describe("Operator absence — sticky halt on OkuM, flat index on USDOku", () => {
  let s: System;

  beforeEach(async () => {
    s = await deploySystem();
  });

  it("haltAccrual is STICKY: it blocks every later step, not just the current one", async () => {
    // Captured AFTER the mark this test takes, so the assertion below isolates
    // the halt's effect rather than the mark's.
    await stepBy(s, 10n);
    const frozen: bigint = await s.okuM.uiMultiplier();

    await (await s.okuM.haltAccrual()).wait();
    expect(await s.okuM.accrualHalted()).to.equal(true);

    // Not a one-shot: time passing does not lift it, and neither does anything
    // the (possibly compromised) rate setter can do on its own.
    await expect(s.okuM.setOkuMultiplier(frozen + 1n)).to.be.revertedWithCustomError(
      s.okuM,
      "AccrualIsHalted"
    );
    await warp(30n * DAY);
    await expect(s.okuM.setOkuMultiplier(frozen + 1n)).to.be.revertedWithCustomError(
      s.okuM,
      "AccrualIsHalted"
    );

    // Monotone-safe: growth stops, nothing already accrued is lost.
    expect(await s.okuM.uiMultiplier()).to.equal(frozen);
    expect(await s.okuM.newUIMultiplier()).to.equal(frozen);

    // A halt does not consume the mark cadence: nothing about the multiplier
    // changed, so `lastSteppedAt` must not move. Otherwise the warm guardian key
    // could delay the next legitimate mark at will — a withhold power the RBAC
    // model does not grant it.
    // A halt is not a mark: it must not move `lastSteppedAt` and therefore must
    // not push out the next admissible mark.
    const afterHalt: bigint = await s.okuM.lastSteppedAt();
    await (await s.okuM.haltAccrual()).wait();
    expect(await s.okuM.lastSteppedAt()).to.equal(afterHalt);
  });

  it("resumeAccrual (cold) lifts the halt and stepping works again", async () => {
    await stepBy(s, 10n);
    await (await s.okuM.haltAccrual()).wait();
    await (await s.okuM.resumeAccrual()).wait();
    expect(await s.okuM.accrualHalted()).to.equal(false);
    await stepBy(s, 10n);
    expect(await s.okuM.uiMultiplier()).to.be.greaterThan(PRECISION);
  });

  it("a guardian can halt but cannot set — that is the separation of duties", async () => {
    const [, , , guardian] = await ethers.getSigners();
    await (await s.okuM.grantRole(R("OKU_GUARDIAN"), await guardian.getAddress())).wait();
    await (await s.usdOku.grantRole(R("OKU_GUARDIAN"), await guardian.getAddress())).wait();

    await (await as(s.okuM, guardian).haltAccrual()).wait();
    await (await as(s.usdOku, guardian).haltUsdOkuAccrual()).wait();

    // A warm guardian key must not be able to move either index upward.
    await expect(as(s.okuM, guardian).setOkuMultiplier(2n * PRECISION)).to.be.reverted;
    await expect(
      as(s.usdOku, guardian).setUsdOkuRate(RATE_5_PCT_APY, (await now()) + 1000n)
    ).to.be.reverted;
    // Nor lift its own halt: `resumeAccrual` is OKU_CAP_MANAGER, i.e. cold.
    await expect(as(s.okuM, guardian).resumeAccrual()).to.be.reverted;
  });

  it("freezes M_usd flat at rateEnd rather than accruing forever", async () => {
    await accrueUsd(s, RATE_5_PCT_APY, MAX_RATE_DURATION);
    const atEnd: bigint = await s.usdOku.usdOkuIndex();
    expect(atEnd).to.be.greaterThan(PRECISION);

    // Ten years of silence from an absent rate setter.
    await warp(3650n * DAY);

    expect(await s.usdOku.usdOkuIndex()).to.equal(
      atEnd,
      "an absent rate setter must not keep accruing against assets that are not there"
    );
    // And the APR cap binds the catch-up too, so a long outage cannot be fully
    // compensated afterwards. That is the protection working, not a bug.
    expect(await s.usdOku.rateEnd()).to.be.lessThan(await now());
  });

  it("leaves M_oku flat and truthful when no mark arrives", async () => {
    await stepBy(s, 25n);
    const marked: bigint = await s.okuM.uiMultiplier();
    const at: bigint = await s.okuM.lastSteppedAt();
    await warp(3650n * DAY);
    expect(await s.okuM.uiMultiplier()).to.equal(marked, "stepwise: no mark, no movement");
    expect(await s.okuM.lastSteppedAt()).to.equal(at, "and the staleness anchor does not drift");
  });
});

// ============================================================================
// 6. Queue lifecycle
// ============================================================================

describe("RedemptionQueue — lifecycle", () => {
  let s: System;

  before(async () => {
    s = await deploySystem();
  });

  it("queues when the buffer is short, then pays out with the accrued mark", async () => {
    // Mint raw directly so no USDC ever enters the buffer.
    const raw = ethers.parseEther("1000");
    await mintRaw(s, s.a.alice, raw);

    await (await as(s.okuM, s.alice).approve(s.a.module, raw)).wait();
    await (await as(s.module, s.alice).redeem(raw)).wait();

    expect(await s.queue.totalQueuedRaw()).to.equal(raw, "escrowed, not burned");
    expect(await s.okuM.balanceOf(s.a.queue)).to.equal(raw);
    expect(await s.queue.queueLength()).to.equal(1n);
    // The prevailing `tout` is snapshotted, so a later fee change cannot
    // retroactively tax someone already waiting.
    expect((await s.queue.getQueueEntry(0)).toutBps).to.equal(await s.module.tout());

    const owedBefore: bigint = await s.queue.totalQueuedUsdc();

    // A queued holder keeps earning: the escrowed RAW amount appreciates with
    // the multiplier, so waiting is not punished.
    await stepBy(s, 50n);
    const owedAfter: bigint = await s.queue.totalQueuedUsdc();
    expect(owedAfter).to.be.greaterThan(owedBefore, "queued value must accrue");

    // `totalQueuedUsdc` is deliberately fee-FREE — an upper bound used to size
    // the approval. The exact settlement is the per-entry view.
    const settlement: bigint = await s.queue.getQueueEntryValue(0);
    expect(settlement).to.be.lessThan(owedAfter);

    await seedBuffer(s, 10_000n * 10n ** 6n);
    await (await s.module.processQueue(0, 1, owedAfter)).wait();

    expect(await s.queue.totalQueuedRaw()).to.equal(0n);
    expect(await s.usdc.balanceOf(s.a.alice)).to.equal(settlement);
    expect(await s.okuM.totalSupply()).to.equal(0n, "burned on processing");
  });

  it("advances the head only past cleared slots, permissionlessly", async () => {
    expect(await s.queue.queueHead()).to.equal(0n);
    await (await as(s.queue, s.bob).advanceHead(10)).wait();
    expect(await s.queue.queueHead()).to.equal(1n);
    expect(await s.queue.queueLength()).to.equal(0n);
  });

  it("keeps the escrow-backed bound after a free donation, and recovers it", async () => {
    // Anyone can transfer tokens to the queue. The backing invariant is a bound,
    // never an equality, precisely so this cannot break it.
    await mintRaw(s, s.a.bob, ethers.parseEther("5"));
    await (await as(s.okuM, s.bob).transfer(s.a.queue, ethers.parseEther("5"))).wait();

    expect(await s.queue.totalQueuedRaw()).to.be.lessThanOrEqual(
      await s.okuM.balanceOf(s.a.queue)
    );

    // And the donation is recoverable rather than stranded.
    const before: bigint = await s.okuM.balanceOf(s.a.admin);
    await (await s.queue.sweepExcess(s.a.admin)).wait();
    expect((await s.okuM.balanceOf(s.a.admin)) - before).to.equal(ethers.parseEther("5"));
    // `sweepExcess` is capped at `balanceOf - totalQueuedRaw`, so with nothing
    // donated there is nothing it could reach.
    await expect(s.queue.sweepExcess(s.a.admin)).to.be.revertedWithCustomError(
      s.queue,
      "NoExcessToSweep"
    );
  });

  it("is blocked by neither the sync window nor the module pause", async () => {
    // Pause is unbounded and incident-driven, so gating queue processing on it
    // could strand users indefinitely — that is the property under test and it
    // is unchanged.
    //
    // The sync window no longer gates processing either. It used to, on the
    // grounds that the queue prices at the live multiplier; but that price is
    // this chain's own and is correct mid-propagation, so the gate delayed
    // queued users for nothing. Both halves of the title now hold trivially for
    // the window and substantively for the pause.
    const raw = ethers.parseEther("10");
    await mintRaw(s, s.a.alice, raw);
    await (await as(s.okuM, s.alice).approve(s.a.module, raw)).wait();
    await (await s.module.withdrawUsdc(s.a.admin, await s.usdc.balanceOf(s.a.module))).wait();
    await (await as(s.module, s.alice).redeem(raw)).wait();

    await stepToNoClear(s, ((await s.okuM.uiMultiplier()) * 10_001n) / 10_000n);
    // Not blocked: processing prices locally and correctly, and nothing on this
    // chain is fenced by a mark.
    await seedBuffer(s, 1_000n * 10n ** 6n);
    await (await s.module.processQueue(1, 2, await s.queue.totalQueuedUsdc())).wait();

    await (await s.module.pause()).wait();
    await seedBuffer(s, 1_000n * 10n ** 6n);
    // Paused, and processing still works.
    await (await s.module.processQueue(1, 2, await s.queue.totalQueuedUsdc())).wait();
    expect(await s.queue.totalQueuedRaw()).to.equal(0n);
  });
});

// ============================================================================
// 7. The sunset sequence
// ============================================================================

describe("USDOku sunset — wrap closes, unwrap never does", () => {
  let s: System;
  let raw: bigint;

  before(async () => {
    s = await deploySystem();
    await seedBuffer(s, 1_000_000n * 10n ** 6n);
    raw = await psmMint(s, s.alice, 100_000n * 10n ** 6n);
    await wrap(s, s.alice, raw / 2n);
  });

  it("step 1: setWrapEnabled(false) closes the entrance", async () => {
    expect(await s.wrapper.wrapEnabled()).to.equal(true);
    await expect(s.wrapper.setWrapEnabled(false)).to.emit(s.wrapper, "WrapEnabledSet");
    expect(await s.wrapper.wrapEnabled()).to.equal(false);

    await (await as(s.okuM, s.alice).approve(s.a.wrapper, raw / 2n)).wait();
    await expect(as(s.wrapper, s.alice).wrap(raw / 2n)).to.be.revertedWithCustomError(
      s.wrapper,
      "WrapDisabled"
    );
  });

  it("leaves the exit wide open, indefinitely", async () => {
    const dollars: bigint = await s.usdOku.balanceOf(s.a.alice);
    expect(dollars).to.be.greaterThan(0n);
    const got = await unwrap(s, s.alice, dollars);
    expect(got).to.be.greaterThan(0n);

    // Still open a decade later — and wrap is still shut. No timer, no
    // deadline, no "final redemption window".
    await warp(3650n * DAY);
    const rest: bigint = await s.okuM.balanceOf(s.a.alice);
    await (await as(s.okuM, s.alice).approve(s.a.wrapper, rest)).wait();
    await expect(as(s.wrapper, s.alice).wrap(rest)).to.be.revertedWithCustomError(
      s.wrapper,
      "WrapDisabled"
    );
    // A residual position from before the sunset still exits cleanly.
    const residual: bigint = await s.usdOku.balanceOf(s.a.alice);
    if (residual > 0n) {
      expect(await unwrap(s, s.alice, residual)).to.be.greaterThan(0n);
    }
  });

  it("has NO code path that disables unwrap — asserted over the ABI", async () => {
    // Winding down by making redemption fail for whoever is last in line is a
    // bank run with a published starting gun, not a sunset. The absence of the
    // lever is a design commitment, so it is asserted as one rather than left to
    // a code reading.
    const fns = fnNames(s.wrapper);
    expect(fns).to.include("setWrapEnabled");
    expect(fns).to.include("wrapEnabled");
    expect(fns).to.not.include("setUnwrapEnabled");
    expect(fns).to.not.include("unwrapEnabled");
    expect(fns).to.not.include("disableUnwrap");
    // The ONLY unwrap-named entrypoints are the operation (in both its
    // self-serve and receiver-parameterized overloads — the latter is what
    // `SubscriptionModule.redeemUsdOku` calls internally to land the OkuM leg
    // on itself rather than the caller) and its quote. Two overloads means two
    // ABI fragments named "unwrap"; `fnNames` is not signature-deduped, so both
    // show up. Neither is an admin lever — there is still no way to disable
    // either.
    expect(fns.filter((n) => /unwrap/i.test(n)).sort()).to.deep.equal([
      "quoteUnwrap",
      "unwrap",
      "unwrap",
    ]);
  });

  it("still lets an incident pause halt both directions — that is separate", async () => {
    // Pause is bounded, reversible incident response and gates BOTH directions.
    // The sunset lever is permanent, one-directional policy. Conflating them is
    // how a sunset becomes a trap.
    await (await s.wrapper.pause()).wait();
    await expect(as(s.wrapper, s.alice).unwrap(PRECISION)).to.be.reverted;
    await (await s.wrapper.unpause()).wait();
    await (await s.wrapper.setWrapEnabled(true)).wait();
    expect(await s.wrapper.wrapEnabled()).to.equal(true);
  });
});

// ============================================================================
// 8. Incident protocol
// ============================================================================

describe("Incident protocol — pause, blacklist, and the role split", () => {
  let s: System;

  beforeEach(async () => {
    s = await deploySystem();
    await seedBuffer(s, 1_000_000n * 10n ** 6n);
    await psmMint(s, s.alice, 10_000n * 10n ** 6n);
  });

  it("OkuM pause blocks transfers and mint but NOT burn", async () => {
    await mintRaw(s, s.a.admin, PRECISION * 10n);
    await (await s.okuM.pause()).wait();

    await expect(as(s.okuM, s.alice).transfer(s.a.bob, 1n)).to.be.reverted;
    await expect(s.okuM.mint(s.a.admin, 1n)).to.be.reverted;
    // Burn must stay open: a holder has to be able to exit while paused, and
    // the pause-then-blacklist protocol depends on it.
    await (await s.okuM.burn(PRECISION)).wait();
  });

  it("USDOku pause blocks transfers, mint and (transitively) wrap/unwrap", async () => {
    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    await wrap(s, s.alice, raw / 2n);
    // Admin holds OKU_MINTER on USDOku from `initialize`; in production only the
    // wrapper ever does. Minted here purely to have shares to burn while paused.
    await (await s.usdOku.mint(s.a.admin, PRECISION * 10n)).wait();
    const adminShares: bigint = await s.usdOku.sharesOf(s.a.admin);

    await (await s.usdOku.pause()).wait();

    await expect(as(s.usdOku, s.alice).transfer(s.a.bob, 1n)).to.be.reverted;
    await expect(s.usdOku.mint(s.a.admin, 1n)).to.be.reverted;
    await (await as(s.okuM, s.alice).approve(s.a.wrapper, raw / 2n)).wait();
    await expect(as(s.wrapper, s.alice).wrap(raw / 2n)).to.be.reverted;
    await expect(as(s.wrapper, s.alice).unwrap(PRECISION)).to.be.reverted;

    // Exit-path parity with `OkuM.burn`: burning shares is not pause-gated.
    await (await s.usdOku.burnShares(adminShares)).wait();
    expect(await s.usdOku.sharesOf(s.a.admin)).to.equal(0n);
  });

  it("the three pause switches are independent", async () => {
    await (await s.module.pause()).wait();
    // Token transfers and wrapping still work: each contract owns its own switch.
    await (await as(s.okuM, s.alice).transfer(s.a.bob, PRECISION)).wait();
    await expect(as(s.module, s.alice).mint(1_000n * 10n ** 6n)).to.be.reverted;
    expect(await s.okuM.paused()).to.equal(false);
    expect(await s.usdOku.paused()).to.equal(false);
    expect(await s.wrapper.paused()).to.equal(false);
  });

  it("unpause requires a different role than pause, on every contract", async () => {
    const [, , , outsider] = await ethers.getSigners();
    const outsiderAddr = await outsider.getAddress();
    for (const [c, pauseRole] of [
      [s.okuM, "OKU_PAUSER"],
      [s.usdOku, "OKU_PAUSER"],
      [s.wrapper, "WRAPPER_PAUSER"],
      [s.module, "PSM_PAUSER"],
    ] as Array<[Contract, string]>) {
      await (await c.grantRole(R(pauseRole), outsiderAddr)).wait();
      await (await as(c, outsider).pause()).wait();
      // The pauser cannot undo it — unpause is a cold-multisig role.
      await expect(as(c, outsider).unpause()).to.be.reverted;
      await (await c.unpause()).wait();
      expect(await c.paused()).to.equal(false);
    }
  });

  it("blacklist blocks send, receive and mint on both tokens", async () => {
    const raw: bigint = await s.okuM.balanceOf(s.a.alice);
    await wrap(s, s.alice, raw / 2n);

    await (await s.okuM.blacklist(s.a.alice)).wait();
    await (await s.usdOku.blacklist(s.a.alice)).wait();

    await expect(as(s.okuM, s.alice).transfer(s.a.bob, 1n)).to.be.reverted;
    await expect(as(s.okuM, s.bob).transfer(s.a.alice, 1n)).to.be.reverted;
    await expect(s.okuM.mint(s.a.alice, 1n)).to.be.reverted;

    await expect(as(s.usdOku, s.alice).transfer(s.a.bob, 1n)).to.be.reverted;
    await expect(s.usdOku.mint(s.a.alice, 1n)).to.be.reverted;
  });

  it("blacklisting works while paused — that is the whole point of the protocol", async () => {
    await (await s.okuM.pause()).wait();
    await (await s.usdOku.pause()).wait();
    await (await s.okuM.blacklist(s.a.alice)).wait();
    await (await s.usdOku.blacklist(s.a.alice)).wait();
    expect(await s.okuM.isBlacklisted(s.a.alice)).to.equal(true);
    expect(await s.usdOku.isBlacklisted(s.a.alice)).to.equal(true);
  });

  it("keeps the multiplier authority reachable while everything is paused", async () => {
    // Correcting the index during an incident must always be possible, so
    // `setOkuMultiplier` and `setUsdOkuRate` are deliberately not pause-gated.
    await (await s.okuM.pause()).wait();
    await (await s.usdOku.pause()).wait();
    await (await s.module.pause()).wait();
    await stepBy(s, 10n);
    expect(await s.okuM.uiMultiplier()).to.be.greaterThan(PRECISION);
    await (await s.usdOku.setUsdOkuRate(RATE_5_PCT_APY, (await now()) + 10n * DAY)).wait();
  });
});

// ============================================================================
// 9. Oracle adapter lifecycle
// ============================================================================

describe("OkuMultiplierAdapter — fresh, stale, refreshed", () => {
  let s: System;
  let feed: Contract;
  const STALENESS = 7n * DAY;

  before(async () => {
    s = await deploySystem();
    const Adapter = await ethers.getContractFactory("OkuMultiplierAdapter");
    const deployed = await Adapter.deploy(
      s.a.okuM,
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
    expect(await feed.description()).to.equal("OkuM uiMultiplier / USD");
  });

  it("is fresh at genesis — `initialize` stamps the staleness anchor", async () => {
    expect(await feed.isHealthy()).to.equal(true);
    const [, answer, startedAt, updatedAt] = await feed.latestRoundData();
    expect(answer).to.equal(PRECISION);
    expect(startedAt).to.equal(await s.okuM.lastSteppedAt());
    expect(updatedAt).to.equal(startedAt, "stepwise: the last step IS the last update");
  });

  it("no longer exposes isAccrualStopped — there is no rate to stop", async () => {
    // `M_oku` is a discrete mark, not a trajectory, so "accrual stopped" has no
    // referent. The honest signal is staleness of the last mark, below.
    expect(fnNames(feed)).to.not.include("isAccrualStopped");
    // The sync-window passthroughs went too — they surfaced a mechanism that
    // gated nothing, and their NatSpec claimed module mint/redeem reverted,
    // which had stopped being true.
    expect(fnNames(feed)).to.not.include("isSyncLocked");
    expect(fnNames(feed)).to.not.include("syncLockedUntil");
  });

  it("tracks the multiplier across a mark, and re-anchors staleness on it", async () => {
    await stepBy(s, 40n);
    const m: bigint = await s.okuM.uiMultiplier();
    const [, answer, startedAt, updatedAt] = await feed.latestRoundData();
    expect(answer).to.equal(m);
    expect(startedAt).to.equal(await s.okuM.effectiveAt());
    expect(updatedAt).to.equal(startedAt);
    expect(await feed.isHealthy()).to.equal(true);
  });

  it("stays healthy while flat but fresh, then goes stale with no new mark", async () => {
    await warp(STALENESS - 2n * DAY);
    expect(await feed.isHealthy()).to.equal(true, "flat but still fresh");

    await warp(3n * DAY);
    expect(await feed.isHealthy()).to.equal(
      false,
      "nobody should price collateral off an unmarked index indefinitely"
    );
    await expect(feed.latestRoundData()).to.be.revertedWithCustomError(feed, "StaleAnswer");
  });

  it("is refreshed by a new mark", async () => {
    await stepBy(s, 40n);
    expect(await feed.isHealthy()).to.equal(true);
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.equal(await s.okuM.uiMultiplier());
  });

  it("stays healthy through a mark — the price is correct, not in flux", async () => {
    // Previously "surfaces the sync window without folding it into isHealthy".
    // There is no window to surface any more, but the underlying property is
    // unchanged and worth keeping: a mark does not make the feed unhealthy.
    // Reporting otherwise would trigger needless liquidation pauses on an
    // accurate price.
    await stepToNoClear(s, ((await s.okuM.uiMultiplier()) * 10_001n) / 10_000n);
    expect(await feed.isHealthy()).to.equal(true);
    const [, answer] = await feed.latestRoundData();
    expect(answer).to.equal(await s.okuM.uiMultiplier());
  });

  it("refuses historical rounds — it is a live derivation, not a push feed", async () => {
    await expect(feed.getRoundData(1)).to.be.revertedWithCustomError(feed, "NoDataPresent");
  });

  it("has no adapter for M_usd, deliberately", async () => {
    // `M_usd` is a declared payout rate, not a value a lending market should
    // price collateral against. Nothing should be borrowed against USDOku at its
    // rebased balance while the solvency gap is nonzero.
    expect(await feed.token()).to.equal(s.a.okuM);
  });
});

// ============================================================================
// 10. The UUPS upgrade path — the OZ storage-layout validator
// ============================================================================
//
// THE REASON THIS FILE EXISTS. `upgrades.upgradeProxy` runs OpenZeppelin's real
// storage-layout validator against the on-chain manifest and throws on any
// incompatible change. Forge cannot invoke it, so this is the only place in the
// repo where a storage-layout regression is caught before a live upgrade.
//
// All five proxies, all with meaningful state, all after real activity.

describe("UUPS upgrade path — OZ layout validator on all five proxies", () => {
  let s: System;

  before(async function () {
    this.timeout(300_000);
    s = await deploySystem();
    await seedBuffer(s, 1_000_000n * 10n ** 6n);

    // Put real state everywhere before upgrading: a marked multiplier, a live
    // declared rate, a wrapped position, a queued redemption, a nonzero gap.
    const raw = await psmMint(s, s.alice, 50_000n * 10n ** 6n);
    await stepBy(s, 50n);
    await wrap(s, s.alice, raw / 2n);
    await accrueUsd(s, RATE_5_PCT_APY, 10n * DAY);

    // Drain the buffer so the next redemption escrows rather than settling.
    const queued = ethers.parseEther("100");
    await mintRaw(s, s.a.bob, queued);
    await (await s.module.withdrawUsdc(s.a.admin, await s.usdc.balanceOf(s.a.module))).wait();
    await (await as(s.okuM, s.bob).approve(s.a.module, queued)).wait();
    await (await as(s.module, s.bob).redeem(queued)).wait();
  });

  it("preserves OkuM state across the upgrade", async () => {
    const before = {
      multiplier: await s.okuM.uiMultiplier(),
      pending: await s.okuM.newUIMultiplier(),
      lastStepped: await s.okuM.lastSteppedAt(),
      halted: await s.okuM.accrualHalted(),
      asset: await s.okuM.asset(),
      dm: await s.okuM.usdcDecimalMultiplier(),
      supply: await s.okuM.totalSupply(),
      bal: await s.okuM.balanceOf(s.a.alice),
      maxSupply: await s.okuM.maxSupply(),
      allowance: await s.okuM.minterAllowance(s.a.module),
    };

    const OkuMFactory = await ethers.getContractFactory("OkuM");
    // THE assertion that matters: this call runs the layout validator.
    const up = (await upgrades.upgradeProxy(s.a.okuM, OkuMFactory)) as unknown as Contract;

    expect(await up.uiMultiplier()).to.equal(before.multiplier);
    expect(await up.newUIMultiplier()).to.equal(
      before.pending,
      "newUIMultiplier has no timestamp term, so it must be bit-identical"
    );
    expect(await up.lastSteppedAt()).to.equal(before.lastStepped);
    expect(await up.effectiveAt()).to.equal(before.lastStepped);
    expect(await up.accrualHalted()).to.equal(before.halted);
    expect(await up.asset()).to.equal(before.asset);
    expect(await up.usdcDecimalMultiplier()).to.equal(before.dm);
    expect(await up.totalSupply()).to.equal(before.supply);
    expect(await up.balanceOf(s.a.alice)).to.equal(before.bal);
    expect(await up.maxSupply()).to.equal(before.maxSupply);
    expect(await up.minterAllowance(s.a.module)).to.equal(before.allowance);
    expect(await up.supportsInterface(IID.core)).to.equal(
      true,
      "an upgrade must not silently drop ERC-8056 advertisement"
    );
    expect(await up.name()).to.equal("Oku Money");
  });

  it("preserves USDOku state across the upgrade", async () => {
    const before = {
      baseIndex: await s.usdOku.baseIndex(),
      rate: await s.usdOku.ratePerSecond(),
      last: await s.usdOku.lastAccrualTime(),
      end: await s.usdOku.rateEnd(),
      totalShares: await s.usdOku.totalShares(),
      shares: await s.usdOku.sharesOf(s.a.alice),
      source: await s.usdOku.solvencySource(),
    };
    expect(before.totalShares).to.be.greaterThan(0n, "fixture must have real liability");

    const UsdOkuFactory = await ethers.getContractFactory("USDOku");
    const up = (await upgrades.upgradeProxy(s.a.usdOku, UsdOkuFactory)) as unknown as Contract;

    // The share ledger and the index anchors are the whole state. Deliberately
    // NOT asserting `balanceOf`/`totalSupply`: they are time-dependent, and the
    // upgrade transaction itself mines a block.
    expect(await up.baseIndex()).to.equal(before.baseIndex);
    expect(await up.ratePerSecond()).to.equal(before.rate);
    expect(await up.lastAccrualTime()).to.equal(before.last);
    expect(await up.rateEnd()).to.equal(before.end);
    expect(await up.totalShares()).to.equal(before.totalShares);
    expect(await up.sharesOf(s.a.alice)).to.equal(before.shares);
    expect(await up.solvencySource()).to.equal(before.source);
    expect(await up.supportsInterface(IID.core)).to.equal(
      false,
      "and must not silently START advertising ERC-8056"
    );
    expect(await up.name()).to.equal("USD Oku");
  });

  it("preserves USDOkuWrapper state across the upgrade", async () => {
    const before = {
      okuM: await s.wrapper.okuM(),
      usdOku: await s.wrapper.usdOku(),
      wrapEnabled: await s.wrapper.wrapEnabled(),
      backing: await s.wrapper.realizedBacking(),
    };

    const WrapperFactory = await ethers.getContractFactory("USDOkuWrapper");
    const up = (await upgrades.upgradeProxy(s.a.wrapper, WrapperFactory)) as unknown as Contract;

    expect(await up.okuM()).to.equal(before.okuM);
    expect(await up.usdOku()).to.equal(before.usdOku);
    expect(await up.wrapEnabled()).to.equal(before.wrapEnabled);
    // `realizedBacking` is `M_oku`-derived only, so it is time-independent.
    expect(await up.realizedBacking()).to.equal(before.backing);
  });

  it("preserves SubscriptionModule and RedemptionQueue bindings across the upgrade", async () => {
    const beforeModule = {
      okuM: await s.module.okuM(),
      usdc: await s.module.usdc(),
      queue: await s.module.redemptionQueue(),
      dm: await s.module.usdcDecimalMultiplier(),
      tin: await s.module.tin(),
      tout: await s.module.tout(),
    };
    const beforeQueue = {
      okuM: await s.queue.okuM(),
      usdc: await s.queue.usdc(),
      dm: await s.queue.usdcDecimalMultiplier(),
      queued: await s.queue.totalQueuedRaw(),
      head: await s.queue.queueHead(),
      tail: await s.queue.queueTail(),
      entryTout: (await s.queue.getQueueEntry(0)).toutBps,
    };
    expect(beforeQueue.queued).to.be.greaterThan(0n, "fixture must have a live queue entry");

    const ModuleFactory = await ethers.getContractFactory("SubscriptionModule");
    const QueueFactory = await ethers.getContractFactory("RedemptionQueue");
    const m2 = (await upgrades.upgradeProxy(s.a.module, ModuleFactory)) as unknown as Contract;
    const q2 = (await upgrades.upgradeProxy(s.a.queue, QueueFactory)) as unknown as Contract;

    expect(await m2.okuM()).to.equal(beforeModule.okuM);
    expect(await m2.usdc()).to.equal(beforeModule.usdc);
    expect(await m2.redemptionQueue()).to.equal(beforeModule.queue);
    expect(await m2.usdcDecimalMultiplier()).to.equal(beforeModule.dm);
    expect(await m2.tin()).to.equal(beforeModule.tin);
    expect(await m2.tout()).to.equal(beforeModule.tout);

    expect(await q2.okuM()).to.equal(beforeQueue.okuM);
    expect(await q2.usdc()).to.equal(beforeQueue.usdc);
    expect(await q2.usdcDecimalMultiplier()).to.equal(beforeQueue.dm);
    expect(await q2.totalQueuedRaw()).to.equal(beforeQueue.queued);
    expect(await q2.queueHead()).to.equal(beforeQueue.head);
    expect(await q2.queueTail()).to.equal(beforeQueue.tail);
    // The per-entry `tout` snapshot must survive: it is the promise made to
    // someone already waiting in the queue.
    expect((await q2.getQueueEntry(0)).toutBps).to.equal(beforeQueue.entryTout);
  });

  it("still functions end to end after all five upgrades", async () => {
    // A layout check that passes on a proxy nobody can use afterwards is not
    // worth much. Drive one full cycle through the upgraded stack.
    await seedBuffer(s, 500_000n * 10n ** 6n);
    await stepBy(s, 20n);

    const raw = await psmMint(s, s.bob, 1_000n * 10n ** 6n);
    expect(raw).to.be.greaterThan(0n);
    const shares = await wrap(s, s.bob, raw);
    expect(shares).to.be.greaterThan(0n);
    const back = await unwrap(s, s.bob, await s.usdOku.balanceOf(s.a.bob));
    expect(back).to.be.greaterThan(0n);
    expect(back).to.be.lessThanOrEqual(raw);

    await (await as(s.okuM, s.bob).approve(s.a.module, back)).wait();
    const quoted: bigint = await s.module.quoteRedeem(back);
    const beforeUsdc: bigint = await s.usdc.balanceOf(s.a.bob);
    await (await as(s.module, s.bob).redeem(back)).wait();
    expect((await s.usdc.balanceOf(s.a.bob)) - beforeUsdc).to.equal(quoted);
  });
});
