/**
 * Stateful sequence fuzzer for `lite_psm` (the SVM counterpart of the EVM
 * handler-based invariant suites, `EVM/test/invariants/*`).
 *
 * Each seed boots a fresh bankrun cluster, initializes the PSM, then runs a
 * random sequence of instructions (user mint/redeem, buffer deposit/withdraw,
 * direct mint/burn, allowance and cap changes, pause/unpause, freeze/thaw, rate
 * schedule writes, the emergency multiplier override, display sync, time warps,
 * role rotation via `set_authority` and the two-step `role_admin` handover, and calls
 * signed by the wrong key). Roles move between a pool of keys; every role-gated call is
 * signed by the current holder, and now and then by someone else (often a former holder),
 * which must be refused. A small independent model of the PSM
 * predicts every outcome. After EVERY step the chain is compared against the
 * model:
 *
 *   - a call the model says is valid must succeed; one it says is invalid must
 *     fail with one of the violated conditions' errors (never succeed, never
 *     fail for an unrelated reason);
 *   - vault USDC, OkuM supply, every tracked OkuM / USDC balance, the three
 *     allowances, the supply cap and the pause flag equal the model exactly, so
 *     a failed call changes nothing, a paused PSM moves nothing, a frozen
 *     account never changes, and burns do not restore allowances;
 *   - mint and redeem amounts equal floor(usdc * P / m) and floor(raw * m / P)
 *     at the canonical multiplier, so the PSM can never pay out more than the
 *     schedule says (this also cross-checks the program against the TypeScript
 *     schedule mirror under random states);
 *   - the canonical multiplier never decreases, stays within [1.0, MAX], and is
 *     continuous across a rate write (equal immediately before and after);
 *   - the wallet display multiplier never exceeds the canonical one (exact
 *     integer comparison of the f64);
 *   - in the slot of an emergency override, user and buffer operations fail
 *     with OverrideInProgress;
 *   - every role and `pending_role_admin` equal the model, so a rotation takes effect
 *     immediately, a former holder loses the role, and only the pending admin can accept.
 *
 * While paused, value-moving calls are often generated with otherwise-valid arguments, so
 * `Paused` is the only reason they can fail.
 *
 * Run:   npm run test:fuzz                       (FUZZ_SEEDS=8 x FUZZ_STEPS=250)
 *        FUZZ_SEEDS=200 FUZZ_STEPS=500 npm run test:fuzz
 *        FUZZ_SEED=42 npm run test:fuzz          (replay one seed; prints the trace)
 *        FUZZ_SEED_START=1100 FUZZ_SEEDS=25 ...  (seeds 1100..1124)
 * Each bankrun cluster stays resident until the process exits (~100 MB per seed), so a very
 * long campaign belongs in batches of ~25 seeds per process, stepping FUZZ_SEED_START.
 * A failure prints the seed, the step, the operation trace and the diff.
 *
 * Validated by mutation: each of these bugs, planted in a scratch copy of the program, is
 * caught within 10 seeds x 300 steps: allowance not consumed (direct burn), pause ignored in
 * withdraw_buffer and in direct burn, mint rounding up, redeem paying one unit extra, mint
 * ignoring the override-slot lock, rate writes not re-anchoring, set_max_supply allowing a cap
 * below supply, supply cap and allowance off by one, slippage check wrong at equality, a
 * pause gate that compares against the stored instead of the effective rate, accept_role_admin
 * skipping its signer check, set_authority not writing, cancel not clearing the proposal, and
 * pause accepting any signer. Boundary-targeted
 * amounts and the paused-expiry scenario exist because uniform random inputs missed the last
 * three. When changing the generators, re-run such mutants: a green run proves little on its own.
 */

import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import {
  MAX_MULTIPLIER,
  MAX_RATE,
  PRECISION,
  computeMultiplier,
  effectiveRate,
  ratePerSecondForApy,
  scheduleFromConfig,
  Schedule,
} from "@okumoney/yield-tooling";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  readDisplayMultiplier,
  tryProcess,
  warpBy,
  warpSlots,
} from "../shared/bankrun";

const { Keypair, SystemProgram } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;
type Ix = anchor.web3.TransactionInstruction;

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 8);
const SEED_START = Number(process.env.FUZZ_SEED_START ?? 1000);
const STEPS = Number(process.env.FUZZ_STEPS ?? 250);
const ONE_SEED = process.env.FUZZ_SEED !== undefined ? Number(process.env.FUZZ_SEED) : undefined;
const VERBOSE = process.env.FUZZ_VERBOSE === "1" || ONE_SEED !== undefined;

const U64_MAX = (1n << 64n) - 1n;
const DAY = 86_400;
const MAX_WINDOW = 90 * DAY;

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) and helpers
// ---------------------------------------------------------------------------

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  /** Weighted pick over [item, weight] pairs. */
  weighted<T>(xs: ReadonlyArray<readonly [T, number]>): T {
    const total = xs.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [x, w] of xs) {
      r -= w;
      if (r < 0) return x;
    }
    return xs[xs.length - 1][0];
  }
  /** Log-uniform bigint in [lo, hi]. */
  amount(lo: bigint, hi: bigint): bigint {
    const l = Math.log(Number(lo)), h = Math.log(Number(hi));
    const v = BigInt(Math.floor(Math.exp(l + this.next() * (h - l))));
    return v < lo ? lo : v > hi ? hi : v;
  }
}

const bn = (x: bigint) => new BN(x.toString());

/** Exact test of `x <= canonical / 1e18` for a non-negative finite f64 `x`. */
function f64LeWad(x: number, canonical: bigint): boolean {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const mant = exp === 0 ? frac : frac | (1n << 52n);
  const e = (exp === 0 ? 1 : exp) - 1075;
  const lhs = mant * PRECISION; // x * 1e18 = lhs * 2^e
  return e >= 0 ? lhs << BigInt(e) <= canonical : lhs <= canonical << BigInt(-e);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Accounts the model tracks (index into `Fuzz.accts`): users 0..2, then the role pool
 * (payer = initial role_admin, cold, warm, orchestrator, two spares, direct minter,
 * direct burner). Every role is always held by one pool account; roles move between them.
 * Each account has a USDC and an OkuM token account, both tracked.
 */
const USERS = [0, 1, 2];
const POOL = [3, 4, 5, 6, 7, 8, 9, 10];
const [PAYER, COLD, WARM, ORCH, , , DMINT, DBURN] = POOL;

const ROLES = [
  "roleAdmin", "pauser", "unpauser", "freezer", "unfreezer", "bufferDepositor", "bufferWithdrawer",
  "capManager", "allowanceManager", "rateManager", "directMinter", "directBurner",
] as const;
type Role = (typeof ROLES)[number];

interface Model {
  vault: bigint;
  supply: bigint;
  maxSupply: bigint;
  allowMint: bigint;
  allowDirectMint: bigint;
  allowDirectBurn: bigint;
  paused: boolean;
  okuM: bigint[]; // per account
  frozen: boolean[]; // per account (its OkuM token account)
  usdc: bigint[]; // per account
  roles: Record<Role, number>; // account index holding each role
  pendingAdmin: number; // -1 = none
  lastMultiplier: bigint;
}

interface Ctx {
  cfg: any;
  now: bigint;
  slot: bigint;
  m: bigint; // canonical multiplier now
  sched: Schedule;
  lock: boolean; // same slot as an emergency override
}

interface Op {
  name: string;
  ixs: any[]; // Anchor method builders (or instructions)
  signers: Keypair[];
  /** Error names that make this call invalid; empty = must succeed. "TOKEN" = a
   *  non-Anchor (SPL / Token-2022) failure is acceptable. */
  violations: string[];
  apply: () => void;
  /** Extra read-back checks on the config after a success. */
  post?: (cfgAfter: any) => void;
  /** After a successful emergency override, probe the same slot. */
  override?: boolean;
}

class Fail extends Error {}

// ---------------------------------------------------------------------------
// The fuzzer
// ---------------------------------------------------------------------------

describe("lite-psm sequence fuzz", function () {
  this.timeout(0);

  const seeds = ONE_SEED !== undefined ? [ONE_SEED] : Array.from({ length: SEEDS }, (_, i) => SEED_START + i);
  for (const seed of seeds) {
    it(`seed ${seed} (${STEPS} steps)`, async () => {
      const f = new Fuzz(seed);
      await f.setup();
      await f.run(STEPS);
    });
  }
});

class Fuzz {
  h!: BankrunHarness;
  program!: Program<LitePsm>;
  rng: Rng;
  trace: string[] = [];
  counts = new Map<string, { tried: number; ok: number }>();

  usdcMint!: PublicKey;
  okuMMint!: PublicKey;
  config!: PublicKey;
  vaultUsdc!: PublicKey;

  accts!: Keypair[]; // see USERS / POOL
  rogue = Keypair.generate(); // never holds a role
  okuMAta!: PublicKey[];
  usdcAta!: PublicKey[];
  /** Set while setup, probes and directed scenarios run: always sign with the right key. */
  exact = false;

  m!: Model;
  step = 0;

  constructor(readonly seed: number) {
    this.rng = new Rng(seed);
  }

  // ------------------------------------------------------------------ setup

  async setup() {
    const h = (this.h = await startBankrun());
    const program = (this.program = h.program);
    this.usdcMint = await createMintViaBankrun(h, h.payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID);
    const init = await initializePsm(h, program, h.payer, this.usdcMint);
    this.config = init.configPda;
    this.okuMMint = init.okuMMint;
    this.vaultUsdc = init.vaultUsdcAta;

    this.accts = [
      Keypair.generate(), Keypair.generate(), Keypair.generate(),
      h.payer, coldMultisig, warmMultisig, psmOrchestrator,
      Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate(),
    ];
    await fundKeypairs(h, [...this.accts.filter((k) => k !== h.payer), this.rogue], 100 * anchor.web3.LAMPORTS_PER_SOL);

    // Token accounts for every tracked account. OkuM ones are pre-created so freeze/thaw
    // and burns always have a target.
    this.okuMAta = [];
    this.usdcAta = [];
    for (const kp of this.accts) {
      this.okuMAta.push(await ensureAtaViaBankrun(h, kp.publicKey, this.okuMMint, TOKEN_2022_PROGRAM_ID));
      this.usdcAta.push(await ensureAtaViaBankrun(h, kp.publicKey, this.usdcMint, TOKEN_PROGRAM_ID));
    }
    const FUND = 1_000_000_000_000_000n; // 1e9 USDC each
    for (const ata of this.usdcAta) await mintToViaBankrun(h, this.usdcMint, ata, h.payer, FUND, TOKEN_PROGRAM_ID);

    const n = this.accts.length;
    this.m = {
      vault: 0n,
      supply: 0n,
      maxSupply: BigInt(MAX_SUPPLY.toString()),
      allowMint: BigInt(MINTER_ALLOWANCE.toString()),
      allowDirectMint: 0n,
      allowDirectBurn: 0n,
      paused: false,
      okuM: Array(n).fill(0n),
      frozen: Array(n).fill(false),
      usdc: Array(n).fill(FUND),
      // As `initializePsm` assigns them (shared/setup.ts); the direct roles start disabled.
      roles: {
        roleAdmin: PAYER, pauser: WARM, unpauser: COLD, freezer: WARM, unfreezer: COLD,
        bufferDepositor: ORCH, bufferWithdrawer: COLD, capManager: COLD, allowanceManager: COLD,
        rateManager: ORCH, directMinter: -1, directBurner: -1,
      },
      pendingAdmin: -1,
      lastMultiplier: PRECISION,
    };

    // Seed the model through the same code paths as the fuzz steps.
    const ctx = () => this.readCtx();
    this.exact = true;
    await this.exec(this.opSetAuthority(await ctx(), "directMinter", DMINT), "setup");
    await this.exec(this.opSetAuthority(await ctx(), "directBurner", DBURN), "setup");
    await this.exec(this.opSetDirectMinterAllowance(await ctx(), 100_000_000_000n), "setup");
    await this.exec(this.opSetDirectBurnerAllowance(await ctx(), 100_000_000_000n), "setup");
    await this.exec(this.opDeposit(await ctx(), 200_000_000_000n), "setup");
    await this.exec(this.opDirectMint(await ctx(), DBURN, 5_000_000_000n), "setup"); // the burner starts with a balance
    this.exact = false;
    await this.check(await ctx(), "setup");
  }

  // ------------------------------------------------------------------ driver

  async run(steps: number) {
    try {
      for (this.step = 1; this.step <= steps; this.step++) {
        await warpSlots(this.h, 1n); // releases any override lock from the previous step
        const ctx = await this.readCtx();
        // While paused, mostly try value-moving operations (they must ALL be rejected and move
        // nothing) and leave the paused state quickly so the other paths get exercised.
        const pr = this.rng.next();
        const moving = ["mint", "redeem", "deposit", "withdraw", "directMint", "directBurn", "directBurn", "rate", "successor", "override"];
        const tightCap = this.m.maxSupply - this.m.supply < 1_000_000_000n;
        const kind = tightCap && !this.m.paused && pr < 0.2 ? "maxSupply" // a pinned cap would starve every mint
          : this.m.paused && pr < 0.25 ? "unpause" : this.m.paused && pr < 0.7 ? this.rng.pick(moving) : this.rng.weighted<string>([
          ["mint", 22], ["redeem", 20], ["deposit", 6], ["withdraw", 5],
          ["directMint", 8], ["directBurn", 6],
          ["allowance", 9], ["maxSupply", 3], ["pause", 2], ["unpause", 2],
          ["freeze", 3], ["thaw", 3],
          ["rate", 7], ["successor", 4], ["withSuccessor", 4], ["override", 3],
          ["sync", 3], ["warp", 9], ["rogue", 5], ["scenario", 3],
          ["setAuthority", 5], ["acceptAdmin", 2], ["cancelAdmin", 1],
        ]);
        if (kind === "scenario") {
          await this.scenarioPausedExpiry();
          continue;
        }
        if (kind === "warp") {
          const secs = this.rng.weighted<number>([[this.rng.int(60) + 1, 4], [this.rng.int(6 * 3600) + 60, 4], [this.rng.int(10 * DAY) + DAY, 2], [this.rng.int(120 * DAY) + 30 * DAY, 1]]);
          await warpBy(this.h, secs);
          this.log(`warp +${secs}s`);
          await this.check(await this.readCtx(), "warp");
          continue;
        }
        const op = this.build(kind, ctx);
        await this.exec(op, kind, ctx);
        if (op.override && this.lastOk) await this.probeSameSlot();
      }
      this.assertCoverage();
      const summary = [...this.counts].filter(([n]) => !n.startsWith("lockProbe:")).map(([n, c]) => `${n} ${c.ok}/${c.tried}`).join(", ");
      console.log(`      ops ok/tried: ${summary}`);
    } catch (e: any) {
      const tail = this.trace.slice(-25).join("\n  ");
      const msg = e instanceof Fail ? e.message : `${e?.stack ?? e}`;
      throw new Error(`seed ${this.seed} step ${this.step}: ${msg}\n--- last operations ---\n  ${tail}\nreplay: FUZZ_SEED=${this.seed} FUZZ_STEPS=${this.step} npm run test:fuzz`);
    }
  }

  lastOk = false;

  async exec(op: Op, tag: string, ctx?: Ctx) {
    void tag;
    void ctx;
    const res = await this.send(op.ixs, op.signers);
    const cnt = this.counts.get(op.name) ?? { tried: 0, ok: 0 };
    cnt.tried++;
    this.lastOk = res.ok;
    if (op.violations.length === 0) {
      if (!res.ok) throw new Fail(`${op.name}: model says valid, chain rejected: ${res.err}\n${res.logs.slice(-6).join("\n")}`);
      cnt.ok++;
      op.apply();
    } else {
      if (res.ok) throw new Fail(`${op.name}: chain ACCEPTED a call the model rejects (${op.violations.join(" | ")})`);
      const code = /Error Code: (\w+)/.exec(res.logs.join("\n"))?.[1];
      const nonAnchorOk = op.violations.includes("TOKEN") || op.violations.includes("FROZEN");
      if (code ? !op.violations.includes(code) : !nonAnchorOk) {
        throw new Fail(`${op.name}: rejected for the wrong reason. expected one of [${op.violations.join(", ")}], got ${code ?? res.err}\n${res.logs.slice(-6).join("\n")}`);
      }
    }
    this.counts.set(op.name, cnt);
    this.log(`${op.name} ${res.ok ? "ok" : "rejected"}${op.violations.length ? ` (${op.violations[0]}${op.violations.length > 1 ? "+" : ""})` : ""}`);
    const after = await this.readCtx();
    if (res.ok && op.post) op.post(after.cfg);
    await this.check(after, op.name);
  }

  /**
   * Directed scenario: pause while a rate window runs out. Once the window has closed the
   * stored rate is stale (the effective rate is the successor or 1.0), and a paused PSM must
   * still refuse any rate above the EFFECTIVE one, including a rate equal to the stale stored
   * one. Random steps reach this combination too rarely to rely on.
   */
  async scenarioPausedExpiry() {
    this.exact = true;
    try {
      await this.scenarioPausedExpiryBody();
    } finally {
      this.exact = false;
    }
  }

  async scenarioPausedExpiryBody() {
    const r = this.rng;
    const run = async (mk: (c: Ctx) => Op) => {
      await warpSlots(this.h, 1n);
      const c = await this.readCtx();
      await this.exec(mk(c), "scenario", c);
    };
    if (this.m.paused) await run((c) => this.opUnpause(c));
    const rate = ratePerSecondForApy(0.2 + r.next() * 2.5);
    const dur = 60 + r.int(3 * 3600);
    await run((c) => this.opSetRate(c, rate, c.now + BigInt(dur)));
    if (r.chance(0.5)) {
      await run((c) => this.opSetNext(c, ratePerSecondForApy(0.02 + r.next()), c.sched.rateEnd + BigInt(100 + r.int(5000))));
    }
    await run((c) => this.opPause(c));
    await warpBy(this.h, dur + 1 + r.int(5000));
    this.log(`scenario: warped past the window (+${dur}s+)`);
    for (let i = 0; i < 4; i++) {
      await run((c) => {
        const eff = effectiveRate(c.sched, c.now);
        const near = [c.sched.ratePerSecond, c.sched.ratePerSecond - 1n, eff, eff + 1n, PRECISION];
        const next = r.pick(near.filter((x) => x >= PRECISION && x <= MAX_RATE));
        return this.opSetRate(c, next, next === PRECISION ? 0n : c.now + 1000n);
      });
    }
    await run((c) => this.opUnpause(c));
  }

  /** After an override: the same slot must refuse every user / buffer operation. */
  async probeSameSlot() {
    const ctx = await this.readCtx();
    if (!ctx.lock) throw new Fail("override succeeded but the config does not show the lock for this slot");
    this.exact = true;
    const probes = [this.opMint(ctx, 0, 1_000_000n), this.opRedeem(ctx, 0, 1_000n, 0n), this.opDeposit(ctx, 1_000_000n), this.opWithdraw(ctx, 1n), this.opDirectMint(ctx, 0, 1_000n), this.opDirectBurn(ctx, 1_000n)];
    this.exact = false;
    for (const p of probes) {
      p.name = `lockProbe:${p.name}`;
      if (!p.violations.includes("OverrideInProgress")) throw new Fail(`probe ${p.name} lacks the lock violation (model bug)`);
      await this.exec(p, "probe", ctx);
    }
  }

  assertCoverage() {
    // An operation that is attempted often but never succeeds means the fuzzer
    // is not exercising it (the EVM suites' NoHandlerActionAlwaysReverts).
    for (const [name, c] of this.counts) {
      if (name.startsWith("lockProbe:") || name === "rogue" || name === "setup" || name === "acceptRoleAdmin" || name === "cancelRoleAdminTransfer") continue;
      if (c.tried >= 40 && c.ok === 0) throw new Fail(`${name}: ${c.tried} attempts, none succeeded`);
    }
  }

  log(s: string) {
    const line = `#${this.step} ${s}`;
    this.trace.push(line);
    if (VERBOSE) console.log(`    ${line}`);
  }

  // ------------------------------------------------------------------ chain

  async send(ixs: any[], signers: Keypair[]) {
    const real: Ix[] = await Promise.all(ixs.map((b) => (b.instruction ? b.instruction() : b)));
    const r = await tryProcess(this.h, real, signers);
    return { ok: r.result === null, err: r.result as string | null, logs: (r.meta?.logMessages ?? []) as string[] };
  }

  async readCtx(): Promise<Ctx> {
    const cfg: any = await this.program.account.psmConfig.fetch(this.config);
    const clock = await this.h.context.banksClient.getClock();
    const slot = await this.h.context.banksClient.getSlot();
    const now = BigInt(clock.unixTimestamp);
    const sched = scheduleFromConfig(cfg);
    return { cfg, now, slot, m: computeMultiplier(sched, now), sched, lock: BigInt(cfg.lastOverrideSlot.toString()) === slot };
  }

  async tokenAmount(ata: PublicKey, prog: PublicKey) {
    return getAccount(this.h.provider.connection as any, ata, undefined, prog);
  }

  /** Compare chain and model, then the schedule invariants. */
  async check(after: Ctx, what: string) {
    const fail = (m: string) => {
      throw new Fail(`after ${what}: ${m}`);
    };
    const eq = (label: string, chain: bigint, model: bigint) => {
      if (chain !== model) fail(`${label}: chain ${chain} != model ${model}`);
    };
    const m = this.m;
    const vault = await this.tokenAmount(this.vaultUsdc, TOKEN_PROGRAM_ID);
    eq("vault USDC", vault.amount, m.vault);
    const mint = await getMint(this.h.provider.connection as any, this.okuMMint, undefined, TOKEN_2022_PROGRAM_ID);
    eq("OkuM supply", mint.supply, m.supply);
    eq("sum of tracked OkuM balances vs supply", m.okuM.reduce((a, b) => a + b, 0n), m.supply);
    for (let i = 0; i < this.accts.length; i++) {
      const a = await this.tokenAmount(this.okuMAta[i], TOKEN_2022_PROGRAM_ID);
      eq(`OkuM balance of account ${i}`, a.amount, m.okuM[i]);
      if (a.isFrozen !== m.frozen[i]) fail(`account ${i} frozen flag: chain ${a.isFrozen} != model ${m.frozen[i]}`);
      const u = await this.tokenAmount(this.usdcAta[i], TOKEN_PROGRAM_ID);
      eq(`USDC balance of account ${i}`, u.amount, m.usdc[i]);
    }
    const c = after.cfg;
    eq("max_supply", BigInt(c.maxSupply.toString()), m.maxSupply);
    eq("minter_allowance", BigInt(c.minterAllowance.toString()), m.allowMint);
    eq("direct_minter_allowance", BigInt(c.directMinterAllowance.toString()), m.allowDirectMint);
    eq("direct_burner_allowance", BigInt(c.directBurnerAllowance.toString()), m.allowDirectBurn);
    if (c.isPaused !== m.paused) fail(`is_paused: chain ${c.isPaused} != model ${m.paused}`);
    for (const role of ROLES) {
      const want = m.roles[role] < 0 ? anchor.web3.PublicKey.default : this.accts[m.roles[role]].publicKey;
      if (!c[role].equals(want)) fail(`role ${role}: chain ${c[role].toBase58()} != model account ${m.roles[role]}`);
    }
    const wantPending = m.pendingAdmin < 0 ? anchor.web3.PublicKey.default : this.accts[m.pendingAdmin].publicKey;
    if (!c.pendingRoleAdmin.equals(wantPending)) fail(`pending_role_admin: chain ${c.pendingRoleAdmin.toBase58()} != model ${m.pendingAdmin}`);
    if (m.supply > m.maxSupply && m.maxSupply >= 0n) {
      // The cap can be lowered only to >= supply, so supply can never exceed it.
      fail(`supply ${m.supply} exceeds max_supply ${m.maxSupply}`);
    }

    // Schedule invariants.
    if (after.m < PRECISION || after.m > MAX_MULTIPLIER) fail(`canonical multiplier ${after.m} outside [1e18, MAX]`);
    if (after.m < m.lastMultiplier) fail(`multiplier decreased: ${m.lastMultiplier} -> ${after.m}`);
    m.lastMultiplier = after.m;
    const disp = await readDisplayMultiplier(this.h, this.okuMMint);
    if (!f64LeWad(disp.effective, after.m)) fail(`display multiplier ${disp.effective} exceeds canonical ${after.m}`);
  }

  // ------------------------------------------------------------------ ops

  /** With probability `p`, one of the boundary values (positive ones only), else undefined. */
  edge(p: number, xs: bigint[]): bigint | undefined {
    const ys = xs.filter((x) => x > 0n && x < 10n ** 13n);
    return ys.length > 0 && this.rng.chance(p) ? this.rng.pick(ys) : undefined;
  }

  /** USDC that mints about `raw` OkuM at multiplier `m`: ceil(raw*m/P), nudged by -1/0/+1. */
  usdcFor(raw: bigint, m: bigint): bigint {
    const u = (raw * m + PRECISION - 1n) / PRECISION + BigInt(this.rng.int(3) - 1);
    return u > 0n ? u : 1n;
  }

  /**
   * While paused, arguments that would be valid if the PSM were not paused, so `Paused` is
   * the only reason the call can fail. Without this a pause bug hides behind an unrelated
   * rejection (insufficient balance, allowance, ...). Undefined if no such call exists now.
   */
  validWhilePaused(kind: string, ctx: Ctx): Op | undefined {
    const r = this.rng;
    const md = this.m;
    const pickRaw = (cap: bigint) => (cap >= 1n ? r.amount(1n, cap < 2_000_000_000n ? cap : 2_000_000_000n) : undefined);
    const live = (i: number) => !md.frozen[i];
    switch (kind) {
      case "directBurn": {
        const b = md.roles.directBurner;
        if (b < 0 || !live(b)) return undefined;
        const cap = [md.okuM[b], md.allowDirectBurn, md.supply].reduce((a, x) => (x < a ? x : a));
        const raw = pickRaw(cap);
        return raw === undefined ? undefined : this.opDirectBurn(ctx, raw);
      }
      case "directMint": {
        const to = r.pick(USERS.filter(live));
        const cap = md.allowDirectMint < md.maxSupply - md.supply ? md.allowDirectMint : md.maxSupply - md.supply;
        const raw = to === undefined ? undefined : pickRaw(cap);
        return raw === undefined ? undefined : this.opDirectMint(ctx, to, raw);
      }
      case "redeem": {
        const u = r.pick(USERS.filter((i) => live(i) && md.okuM[i] > 0n));
        if (u === undefined) return undefined;
        const byVault = (md.vault * PRECISION) / ctx.m;
        const raw = pickRaw(md.okuM[u] < byVault ? md.okuM[u] : byVault);
        return raw === undefined ? undefined : this.opRedeem(ctx, u, raw, 0n);
      }
      case "withdraw": {
        const amt = pickRaw(md.vault);
        return amt === undefined ? undefined : this.opWithdraw(ctx, amt);
      }
      case "deposit": return this.opDeposit(ctx, r.amount(1n, 1_000_000_000n));
    }
    return undefined;
  }

  build(kind: string, ctx: Ctx): Op {
    const r = this.rng;
    const user = r.int(3);
    const md = this.m;
    const remCap = md.maxSupply - md.supply;
    if (md.paused && r.chance(0.6)) {
      const op = this.validWhilePaused(kind, ctx);
      if (op) return op;
    }
    switch (kind) {
      case "mint": {
        // Boundaries: exactly at / one past the supply cap and the PSM mint allowance.
        const e = this.edge(0.35, [remCap, remCap + 1n, md.allowMint, md.allowMint + 1n]);
        return this.opMint(ctx, user, e !== undefined ? this.usdcFor(e, ctx.m) : r.amount(1n, 5_000_000_000n));
      }
      case "redeem": {
        const bal = this.m.okuM[user];
        // Boundaries: the whole balance (+1), and the amount whose payout is exactly the buffer (+/-1).
        const e = this.edge(0.35, [bal, bal + 1n, ((md.vault + 1n) * PRECISION) / ctx.m, (md.vault * PRECISION) / ctx.m]);
        const raw = e ?? (bal > 0n && r.chance(0.8) ? (r.chance(0.3) ? bal : r.amount(1n, bal)) : r.amount(1n, 5_000_000_000n));
        const exact = (raw * ctx.m) / PRECISION;
        const minOut = r.chance(0.2) ? exact + BigInt(r.int(3)) : 0n; // sometimes demands too much, sometimes exactly enough
        return this.opRedeem(ctx, user, raw, minOut);
      }
      case "deposit": return this.opDeposit(ctx, r.amount(1n, 100_000_000_000n));
      case "withdraw": {
        const e = this.edge(0.3, [md.vault, md.vault + 1n, md.vault - 1n]);
        return this.opWithdraw(ctx, e ?? (r.chance(0.8) ? r.amount(1n, md.vault > 1n ? md.vault : 1n) : r.amount(1n, 10n * md.vault + 10n)));
      }
      case "directMint": {
        const e = this.edge(0.35, [md.allowDirectMint, md.allowDirectMint + 1n, remCap, remCap + 1n]);
        // Often to the current burner, so direct burns have something to burn.
        const to = md.roles.directBurner >= 0 && r.chance(0.3) ? md.roles.directBurner : r.int(this.accts.length);
        return this.opDirectMint(ctx, to, e ?? r.amount(1n, 40_000_000_000n));
      }
      case "directBurn": {
        const bal = md.roles.directBurner >= 0 ? md.okuM[md.roles.directBurner] : 0n;
        const e = this.edge(0.35, [md.allowDirectBurn, md.allowDirectBurn + 1n, bal, bal + 1n, md.supply + 1n]);
        return this.opDirectBurn(ctx, e ?? (bal > 0n && r.chance(0.8) ? r.amount(1n, bal) : r.amount(1n, 1_000_000_000n)));
      }
      case "allowance": {
        const v = r.chance(0.1) ? 0n : r.amount(10_000_000_000n, 900_000_000_000n);
        return r.weighted<Op>([[this.opSetMinterAllowance(ctx, v), 1], [this.opSetDirectMinterAllowance(ctx, v), 1], [this.opSetDirectBurnerAllowance(ctx, v), 1]]);
      }
      case "maxSupply": {
        const s = this.m.supply;
        const tight = md.maxSupply - s < 1_000_000_000n;
        const e = tight ? undefined : this.edge(0.4, [s, s - 1n, s + 1n]); // never re-pin an already tight cap
        return this.opSetMaxSupply(ctx, e ?? (!tight && r.chance(0.3) ? (s > 0n ? s - BigInt(1 + r.int(5)) : 0n) : s + r.amount(10_000_000_000n, 2_000_000_000_000n)));
      }
      case "pause": return this.opPause(ctx);
      case "unpause": return this.opUnpause(ctx);
      case "freeze": return this.opFreeze(ctx, r.int(this.accts.length));
      case "thaw": return this.opThaw(ctx, r.int(this.accts.length));
      case "setAuthority": {
        const role: Role = r.chance(0.3) ? "roleAdmin" : r.pick(ROLES);
        const to = r.chance(0.05) ? -1 : r.chance(0.15) ? md.roles.roleAdmin : r.pick(POOL);
        return this.opSetAuthority(ctx, role, to);
      }
      case "acceptAdmin": return this.opAcceptRoleAdmin(ctx);
      case "cancelAdmin": return this.opCancelRoleAdmin(ctx);
      case "rate": {
        const [rate, end] = this.randRate(ctx);
        return this.opSetRate(ctx, rate, end);
      }
      case "successor": {
        const rate = this.randRateValue(ctx);
        const base = ctx.cfg.okumRateEnd.toString() !== "0" ? BigInt(ctx.cfg.okumRateEnd.toString()) : ctx.now + BigInt(DAY);
        return this.opSetNext(ctx, rate, base + BigInt(r.chance(0.1) ? -r.int(100) : 1 + r.int(100 * DAY)));
      }
      case "withSuccessor": {
        const [rate, end] = this.randRate(ctx);
        const nrate = this.randRateValue(ctx);
        const nend = end + BigInt(r.chance(0.1) ? -r.int(100) : 1 + r.int(100 * DAY));
        return this.opWithSuccessor(ctx, rate, end, nrate, nend);
      }
      case "override": {
        const cur = ctx.m;
        const bump = r.chance(0.15) ? 0n : r.chance(0.1) ? MAX_MULTIPLIER : BigInt(1 + r.int(50)) * (cur / 1000n + 1n);
        const target = r.chance(0.05) ? MAX_MULTIPLIER + 1n : cur + bump;
        return this.opOverride(ctx, target);
      }
      case "sync": return this.opSync(ctx);
      case "rogue": return this.opRogue(ctx);
    }
    throw new Error(`unknown op ${kind}`);
  }

  randRateValue(ctx?: Ctx): bigint {
    const r = this.rng;
    if (ctx && r.chance(0.35)) {
      // Near the stored and the effective (currently accruing) rate: this is where a pause gate
      // that compares against the wrong one is visible.
      const eff = effectiveRate(ctx.sched, ctx.now);
      const near = [ctx.sched.ratePerSecond, eff, ctx.sched.pendingRatePerSecond].flatMap((x) => [x - 1n, x, x + 1n]);
      return r.pick(near.filter((x) => x >= PRECISION - 1n && x <= MAX_RATE + 1n));
    }
    return r.weighted<bigint>([
      [ratePerSecondForApy(r.next() * 3), 12],
      [PRECISION, 2],
      [MAX_RATE, 1],
      [MAX_RATE + 1n, 1],
      [PRECISION - 1n, 1],
    ]);
  }

  randRate(ctx: Ctx): [bigint, bigint] {
    const r = this.rng;
    const rate = this.randRateValue(ctx);
    let end: bigint;
    if (rate === PRECISION) end = r.chance(0.85) ? 0n : ctx.now + BigInt(DAY);
    else end = r.weighted<bigint>([
      [ctx.now + BigInt(1 + r.int(MAX_WINDOW)), 14],
      [ctx.now + BigInt(MAX_WINDOW), 1],
      [ctx.now + BigInt(MAX_WINDOW + 1), 1],
      [ctx.now - BigInt(r.int(10)), 1],
      [0n, 1],
    ]);
    return [rate, end];
  }

  /**
   * Who signs a `role`-gated call: normally the current holder. Outside exact mode, now and
   * then another pool account (often a former holder), which must be refused with
   * `Unauthorized` and change nothing. A disabled role (zero key) refuses everyone.
   */
  signer(role: Role): { kp: Keypair; idx: number; wrong: boolean } {
    const holder = this.m.roles[role];
    if (holder < 0 || (!this.exact && this.rng.chance(0.06))) {
      const i = this.rng.pick(POOL.filter((x) => x !== holder));
      return { kp: this.accts[i], idx: i, wrong: true };
    }
    return { kp: this.accts[holder], idx: holder, wrong: false };
  }

  /** A wrong signer fails the account constraint before any handler check runs. */
  gate(sig: { wrong: boolean }, v: string[]): string[] {
    return sig.wrong ? ["Unauthorized"] : v;
  }

  // ---- PSM ops

  common(ctx: Ctx, v: string[], lockGated = true): string[] {
    if (this.m.paused) v.push("Paused");
    if (lockGated && ctx.lock) v.push("OverrideInProgress");
    return v;
  }

  opMint(ctx: Ctx, i: number, usdc: bigint): Op {
    const v = this.common(ctx, []);
    const raw = (usdc * PRECISION) / ctx.m;
    if (usdc === 0n) v.push("ZeroAmount");
    if (raw === 0n) v.push("AmountTooSmall");
    if (this.m.supply + raw > this.m.maxSupply) v.push("MaxSupplyExceeded");
    if (raw > this.m.allowMint) v.push("AllowanceExceeded");
    if (this.m.frozen[i]) v.push("FROZEN");
    const u = this.accts[i];
    return {
      name: "mintOkuM",
      ixs: [anchorIx(this.program.methods.mintOkuM(bn(usdc)).accountsPartial({
        user: u.publicKey, config: this.config, usdcMint: this.usdcMint, okuMMint: this.okuMMint,
        userUsdcAta: this.usdcAta[i], userOkuMAta: this.okuMAta[i], vaultUsdc: this.vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }))],
      signers: [u], violations: v,
      apply: () => {
        const m = this.m;
        m.usdc[i] -= usdc; m.vault += usdc; m.okuM[i] += raw; m.supply += raw; m.allowMint -= raw;
      },
    };
  }

  opRedeem(ctx: Ctx, i: number, raw: bigint, minOut: bigint): Op {
    const v = this.common(ctx, []);
    const out = (raw * ctx.m) / PRECISION;
    if (raw === 0n) v.push("ZeroAmount");
    if (out > U64_MAX) v.push("Overflow");
    if (out < minOut) v.push("SlippageExceeded");
    if (this.m.okuM[i] < raw) v.push("InsufficientUserBalance");
    if (this.m.vault < out) v.push("InsufficientBuffer");
    if (this.m.frozen[i]) v.push("FROZEN");
    const u = this.accts[i];
    return {
      name: "redeemOkuM",
      ixs: [anchorIx(this.program.methods.redeemOkuM(bn(raw), bn(minOut)).accountsPartial({
        user: u.publicKey, config: this.config, usdcMint: this.usdcMint, okuMMint: this.okuMMint,
        userUsdcAta: this.usdcAta[i], userOkuMAta: this.okuMAta[i], vaultUsdc: this.vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }))],
      signers: [u], violations: v,
      apply: () => {
        const m = this.m;
        m.okuM[i] -= raw; m.supply -= raw; m.vault -= out; m.usdc[i] += out;
      },
    };
  }

  opDeposit(ctx: Ctx, amount: bigint): Op {
    const sig = this.signer("bufferDepositor");
    const d = sig.idx;
    const v = this.common(ctx, []);
    if (amount === 0n) v.push("ZeroAmount");
    if (this.m.usdc[d] < amount) v.push("TOKEN");
    return {
      name: "depositBuffer",
      ixs: [anchorIx(this.program.methods.depositBuffer(bn(amount)).accountsPartial({
        bufferDepositor: sig.kp.publicKey, config: this.config,
        bufferDepositorUsdcAta: this.usdcAta[d], vaultUsdc: this.vaultUsdc,
        usdcMint: this.usdcMint, tokenProgram: TOKEN_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v),
      apply: () => { this.m.usdc[d] -= amount; this.m.vault += amount; },
    };
  }

  opWithdraw(ctx: Ctx, amount: bigint): Op {
    const sig = this.signer("bufferWithdrawer");
    const w = sig.idx;
    const v = this.common(ctx, []);
    if (amount === 0n) v.push("ZeroAmount");
    if (this.m.vault < amount) v.push("InsufficientBuffer");
    return {
      name: "withdrawBuffer",
      ixs: [anchorIx(this.program.methods.withdrawBuffer(bn(amount)).accountsPartial({
        bufferWithdrawer: sig.kp.publicKey, config: this.config,
        withdrawerUsdcAta: this.usdcAta[w], vaultUsdc: this.vaultUsdc,
        usdcMint: this.usdcMint, tokenProgram: TOKEN_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v),
      apply: () => { this.m.vault -= amount; this.m.usdc[w] += amount; },
    };
  }

  opDirectMint(ctx: Ctx, holder: number, raw: bigint): Op {
    const sig = this.signer("directMinter");
    const v = this.common(ctx, []);
    if (raw === 0n) v.push("ZeroAmount");
    if (this.m.supply + raw > this.m.maxSupply) v.push("MaxSupplyExceeded");
    if (raw > this.m.allowDirectMint) v.push("AllowanceExceeded");
    if (this.m.frozen[holder]) v.push("FROZEN");
    return {
      name: "mintOkuMDirect",
      ixs: [anchorIx(this.program.methods.mintOkuMDirect(bn(raw)).accountsPartial({
        directMinter: sig.kp.publicKey, config: this.config, okuMMint: this.okuMMint,
        recipient: this.accts[holder].publicKey, recipientOkuMAta: this.okuMAta[holder],
        token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v),
      apply: () => { this.m.okuM[holder] += raw; this.m.supply += raw; this.m.allowDirectMint -= raw; },
    };
  }

  opDirectBurn(ctx: Ctx, raw: bigint): Op {
    const sig = this.signer("directBurner");
    const b = sig.idx; // burns from the signer's own OkuM account
    const v = this.common(ctx, []);
    if (raw === 0n) v.push("ZeroAmount");
    if (raw > this.m.allowDirectBurn) v.push("AllowanceExceeded");
    if (raw > this.m.supply) v.push("Overflow"); // supply - raw is computed before the burn CPI
    if (this.m.okuM[b] < raw) v.push("TOKEN");
    if (this.m.frozen[b]) v.push("FROZEN");
    return {
      name: "burnOkuMDirect",
      ixs: [anchorIx(this.program.methods.burnOkuMDirect(bn(raw)).accountsPartial({
        directBurner: sig.kp.publicKey, config: this.config, okuMMint: this.okuMMint,
        burnerOkuMAta: this.okuMAta[b], token2022Program: TOKEN_2022_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v),
      apply: () => { this.m.okuM[b] -= raw; this.m.supply -= raw; this.m.allowDirectBurn -= raw; },
    };
  }

  // ---- admin ops (not pause- or lock-gated)

  allowanceIx(method: "setMinterAllowance" | "setDirectMinterAllowance" | "setDirectBurnerAllowance", amount: bigint, signer: Keypair) {
    return anchorIx((this.program.methods as any)[method](bn(amount)).accountsPartial({
      allowanceManager: signer.publicKey, config: this.config,
    }));
  }
  opSetMinterAllowance(_c: Ctx, v: bigint): Op {
    const sig = this.signer("allowanceManager");
    return { name: "setMinterAllowance", ixs: [this.allowanceIx("setMinterAllowance", v, sig.kp)], signers: [sig.kp], violations: this.gate(sig, []), apply: () => { this.m.allowMint = v; } };
  }
  opSetDirectMinterAllowance(_c: Ctx, v: bigint): Op {
    const sig = this.signer("allowanceManager");
    return { name: "setDirectMinterAllowance", ixs: [this.allowanceIx("setDirectMinterAllowance", v, sig.kp)], signers: [sig.kp], violations: this.gate(sig, []), apply: () => { this.m.allowDirectMint = v; } };
  }
  opSetDirectBurnerAllowance(_c: Ctx, v: bigint): Op {
    const sig = this.signer("allowanceManager");
    return { name: "setDirectBurnerAllowance", ixs: [this.allowanceIx("setDirectBurnerAllowance", v, sig.kp)], signers: [sig.kp], violations: this.gate(sig, []), apply: () => { this.m.allowDirectBurn = v; } };
  }

  opSetMaxSupply(_c: Ctx, next: bigint): Op {
    const sig = this.signer("capManager");
    const v: string[] = [];
    if (next < this.m.supply) v.push("BelowCurrentSupply");
    return {
      name: "setMaxSupply",
      ixs: [anchorIx(this.program.methods.setMaxSupply(bn(next)).accountsPartial({
        capManager: sig.kp.publicKey, config: this.config, okuMMint: this.okuMMint, token2022Program: TOKEN_2022_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v), apply: () => { this.m.maxSupply = next; },
    };
  }

  opPause(_c: Ctx): Op {
    const sig = this.signer("pauser");
    return {
      name: "pause",
      ixs: [anchorIx(this.program.methods.pause().accountsPartial({ pauser: sig.kp.publicKey, config: this.config }))],
      signers: [sig.kp], violations: this.gate(sig, this.m.paused ? ["AlreadyPaused"] : []), apply: () => { this.m.paused = true; },
    };
  }
  opUnpause(_c: Ctx): Op {
    const sig = this.signer("unpauser");
    return {
      name: "unpause",
      ixs: [anchorIx(this.program.methods.unpause().accountsPartial({ unpauser: sig.kp.publicKey, config: this.config }))],
      signers: [sig.kp], violations: this.gate(sig, this.m.paused ? [] : ["NotPaused"]), apply: () => { this.m.paused = false; },
    };
  }

  opFreeze(_c: Ctx, i: number): Op {
    const sig = this.signer("freezer");
    return {
      name: "freezeAccount",
      ixs: [anchorIx(this.program.methods.freezeAccount().accountsPartial({
        freezer: sig.kp.publicKey, config: this.config, okuMMint: this.okuMMint,
        targetOkuMAta: this.okuMAta[i], token2022Program: TOKEN_2022_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, this.m.frozen[i] ? ["TOKEN"] : []), apply: () => { this.m.frozen[i] = true; },
    };
  }
  opThaw(_c: Ctx, i: number): Op {
    const sig = this.signer("unfreezer");
    return {
      name: "thawAccount",
      ixs: [anchorIx(this.program.methods.thawAccount().accountsPartial({
        unfreezer: sig.kp.publicKey, config: this.config, okuMMint: this.okuMMint,
        targetOkuMAta: this.okuMAta[i], token2022Program: TOKEN_2022_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, this.m.frozen[i] ? [] : ["TOKEN"]), apply: () => { this.m.frozen[i] = false; },
    };
  }

  opSync(_c: Ctx): Op {
    return {
      name: "syncDisplay",
      ixs: [anchorIx(this.program.methods.syncDisplayMultiplier().accountsPartial({
        cranker: this.rogue.publicKey, config: this.config, okuMMint: this.okuMMint, token2022Program: TOKEN_2022_PROGRAM_ID,
      }))],
      signers: [this.rogue], violations: [], apply: () => {},
    };
  }

  // ---- schedule ops

  /** Violations of writing (rate, end) as the active rate on `sched`. */
  activeViolations(rate: bigint, end: bigint, now: bigint, sched: Schedule): string[] {
    const v: string[] = [];
    if (rate < PRECISION) return ["InvalidRate"];
    if (rate > MAX_RATE) return ["RateTooHigh"];
    if (rate === PRECISION) {
      if (end !== 0n) v.push("EndTimestampNotAllowed");
    } else {
      if (end <= now) v.push("EndTimestampInPast");
      else if (end - now > BigInt(MAX_WINDOW)) v.push("RateWindowTooLong");
    }
    if (v.length === 0 && this.m.paused && rate > effectiveRate(sched, now)) v.push("Paused");
    return v;
  }

  successorViolations(rate: bigint, pend: bigint, now: bigint, sched: Schedule): string[] {
    if (rate < PRECISION) return ["InvalidRate"];
    if (rate > MAX_RATE) return ["RateTooHigh"];
    const v: string[] = [];
    if (sched.rateEnd === 0n) return ["NoRateEndSet"];
    if (now >= sched.rateEnd) return ["RateAlreadyExpired"];
    if (pend <= sched.rateEnd) return ["PendingEndNotAfterRateEnd"];
    if (pend - sched.rateEnd > BigInt(MAX_WINDOW)) return ["RateWindowTooLong"];
    if (this.m.paused && rate > effectiveRate(sched, now)) v.push("Paused");
    return v;
  }

  /** Read-back after an active-rate write: stored fields, re-anchor and continuity. */
  readBack(ctx: Ctx, rate: bigint, end: bigint, pending?: { rate: bigint; end: bigint }) {
    return (cfg: any) => {
      const s = scheduleFromConfig(cfg);
      const fail = (m: string) => { throw new Fail(`schedule write read-back: ${m}`); };
      if (s.ratePerSecond !== rate || s.rateEnd !== end) fail(`stored (${s.ratePerSecond}, ${s.rateEnd}) != written (${rate}, ${end})`);
      if (s.lastAccrualTime !== ctx.now) fail(`last_accrual_time ${s.lastAccrualTime} != now ${ctx.now}`);
      if (s.baseMultiplier !== ctx.m) fail(`re-anchor base ${s.baseMultiplier} != pre-write multiplier ${ctx.m} (curve not continuous)`);
      const wantRate = pending ? pending.rate : PRECISION;
      const wantEnd = pending ? pending.end : 0n;
      if (s.pendingRatePerSecond !== wantRate || s.pendingRateEnd !== wantEnd) fail(`pending (${s.pendingRatePerSecond}, ${s.pendingRateEnd}) != expected (${wantRate}, ${wantEnd})`);
    };
  }

  rateIx(_ctx: Ctx, kind: "set" | "next" | "with", a: bigint, b: bigint, c: bigint | undefined, d: bigint | undefined, signer: Keypair) {
    const accts = { rateManager: signer.publicKey, config: this.config };
    const m = this.program.methods as any;
    if (kind === "set") return anchorIx(m.setOkumYieldRate(bn(a), bn(b)).accountsPartial(accts));
    if (kind === "next") return anchorIx(m.setNextOkumYieldRate(bn(a), bn(b)).accountsPartial(accts));
    return anchorIx(m.setOkumYieldRateWithSuccessor(bn(a), bn(b), bn(c!), bn(d!)).accountsPartial(accts));
  }

  opSetRate(ctx: Ctx, rate: bigint, end: bigint): Op {
    const sig = this.signer("rateManager");
    const v = this.activeViolations(rate, end, ctx.now, ctx.sched);
    return { name: "setYieldRate", ixs: [this.rateIx(ctx, "set", rate, end, undefined, undefined, sig.kp)], signers: [sig.kp], violations: this.gate(sig, v), apply: () => {}, post: this.readBack(ctx, rate, end) };
  }

  opSetNext(ctx: Ctx, rate: bigint, pend: bigint): Op {
    const sig = this.signer("rateManager");
    const v = this.successorViolations(rate, pend, ctx.now, ctx.sched);
    return {
      name: "setNextYieldRate", ixs: [this.rateIx(ctx, "next", rate, pend, undefined, undefined, sig.kp)], signers: [sig.kp], violations: this.gate(sig, v), apply: () => {},
      post: (cfg) => {
        const s = scheduleFromConfig(cfg);
        if (s.pendingRatePerSecond !== rate || s.pendingRateEnd !== pend) throw new Fail(`successor stored (${s.pendingRatePerSecond}, ${s.pendingRateEnd}) != (${rate}, ${pend})`);
        if (s.ratePerSecond !== ctx.sched.ratePerSecond || s.rateEnd !== ctx.sched.rateEnd || s.baseMultiplier !== ctx.sched.baseMultiplier) throw new Fail("staging a successor changed the active schedule");
      },
    };
  }

  opWithSuccessor(ctx: Ctx, rate: bigint, end: bigint, nrate: bigint, nend: bigint): Op {
    let v = this.activeViolations(rate, end, ctx.now, ctx.sched);
    if (v.length === 0) {
      // The successor is validated against the schedule the first write produces.
      const after: Schedule = { ...ctx.sched, ratePerSecond: rate, rateEnd: end, baseMultiplier: ctx.m, lastAccrualTime: ctx.now, pendingRatePerSecond: PRECISION, pendingRateEnd: 0n };
      v = this.successorViolations(nrate, nend, ctx.now, after);
    }
    const sig = this.signer("rateManager");
    return { name: "setYieldRateWithSuccessor", ixs: [this.rateIx(ctx, "with", rate, end, nrate, nend, sig.kp)], signers: [sig.kp], violations: this.gate(sig, v), apply: () => {}, post: this.readBack(ctx, rate, end, { rate: nrate, end: nend }) };
  }

  opOverride(ctx: Ctx, target: bigint): Op {
    const sig = this.signer("rateManager");
    const v: string[] = [];
    if (ctx.lock) v.push("OverrideInProgress");
    if (this.m.paused) v.push("Paused");
    if (target <= ctx.m) v.push("MultiplierCannotDecrease");
    if (target > MAX_MULTIPLIER) v.push("MultiplierTooHigh");
    return {
      name: "setOkumMultiplier",
      ixs: [anchorIx(this.program.methods.setOkumMultiplier(bn(target)).accountsPartial({
        rateManager: sig.kp.publicKey, config: this.config, okuMMint: this.okuMMint, token2022Program: TOKEN_2022_PROGRAM_ID,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v), apply: () => {}, override: !sig.wrong,
      post: (cfg) => {
        const s = scheduleFromConfig(cfg);
        if (s.baseMultiplier !== target || s.ratePerSecond !== PRECISION || s.rateEnd !== 0n || s.pendingRatePerSecond !== PRECISION || s.pendingRateEnd !== 0n || s.lastAccrualTime !== ctx.now) {
          throw new Fail(`override did not leave a flat schedule at ${target}: ${JSON.stringify(s, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
        }
        if (BigInt(cfg.lastOverrideSlot.toString()) !== ctx.slot) throw new Fail("override did not stamp last_override_slot");
      },
    };
  }

  // ---- role rotation

  /**
   * `set_authority(role, new)`. `to = -1` passes the zero key. For `roleAdmin` this only
   * proposes; `accept_role_admin` commits.
   */
  opSetAuthority(_c: Ctx, role: Role, to: number): Op {
    const sig = this.signer("roleAdmin");
    const v: string[] = [];
    if (to < 0 || to === this.m.roles.roleAdmin) v.push("InvalidAuthority");
    const key = to < 0 ? anchor.web3.PublicKey.default : this.accts[to].publicKey;
    return {
      name: "setAuthority",
      ixs: [anchorIx((this.program.methods as any).setAuthority({ [role]: {} }, key).accountsPartial({
        roleAdmin: sig.kp.publicKey, config: this.config,
      }))],
      signers: [sig.kp], violations: this.gate(sig, v),
      apply: () => {
        if (role === "roleAdmin") this.m.pendingAdmin = to;
        else this.m.roles[role] = to;
      },
    };
  }

  /** `accept_role_admin`, signed by the pending admin (sometimes by someone else). */
  opAcceptRoleAdmin(_c: Ctx): Op {
    const pending = this.m.pendingAdmin;
    const who = pending >= 0 && (this.exact || this.rng.chance(0.8)) ? pending : this.rng.pick(POOL);
    const v: string[] = [];
    if (pending < 0) v.push("NoPendingRoleAdmin");
    else if (who !== pending) v.push("NotPendingRoleAdmin");
    return {
      name: "acceptRoleAdmin",
      ixs: [anchorIx((this.program.methods as any).acceptRoleAdmin().accountsPartial({
        newRoleAdmin: this.accts[who].publicKey, config: this.config,
      }))],
      signers: [this.accts[who]], violations: v,
      apply: () => { this.m.roles.roleAdmin = pending; this.m.pendingAdmin = -1; },
    };
  }

  /** `cancel_role_admin_transfer`, signed by the current admin. */
  opCancelRoleAdmin(_c: Ctx): Op {
    const sig = this.signer("roleAdmin");
    return {
      name: "cancelRoleAdminTransfer",
      ixs: [anchorIx((this.program.methods as any).cancelRoleAdminTransfer().accountsPartial({
        roleAdmin: sig.kp.publicKey, config: this.config,
      }))],
      signers: [sig.kp], violations: this.gate(sig, this.m.pendingAdmin < 0 ? ["NoPendingRoleAdmin"] : []),
      apply: () => { this.m.pendingAdmin = -1; },
    };
  }

  /** A privileged call signed by the wrong key must fail with Unauthorized and change nothing. */
  opRogue(ctx: Ctx): Op {
    const r = this.rogue;
    const m = this.program.methods as any;
    const which = this.rng.int(7);
    let ix: any;
    switch (which) {
      case 0: ix = anchorIx(m.pause().accountsPartial({ pauser: r.publicKey, config: this.config })); break;
      case 1: ix = anchorIx(m.unpause().accountsPartial({ unpauser: r.publicKey, config: this.config })); break;
      case 2: ix = anchorIx(m.setMaxSupply(bn(1n)).accountsPartial({ capManager: r.publicKey, config: this.config, okuMMint: this.okuMMint, token2022Program: TOKEN_2022_PROGRAM_ID })); break;
      case 3: ix = this.allowanceIx("setMinterAllowance", 10n ** 15n, r); break;
      case 4: ix = this.rateIx(ctx, "set", PRECISION, 0n, undefined, undefined, r); break;
      case 5: ix = anchorIx(m.freezeAccount().accountsPartial({ freezer: r.publicKey, config: this.config, okuMMint: this.okuMMint, targetOkuMAta: this.okuMAta[0], token2022Program: TOKEN_2022_PROGRAM_ID })); break;
      default: ix = anchorIx(m.mintOkuMDirect(bn(1_000_000n)).accountsPartial({
        directMinter: r.publicKey, config: this.config, okuMMint: this.okuMMint, recipient: this.accts[0].publicKey, recipientOkuMAta: this.okuMAta[0],
        token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }));
    }
    return { name: "rogue", ixs: [ix], signers: [r], violations: ["Unauthorized"], apply: () => {} };
  }
}

/** Ops carry Anchor method builders; `send` resolves them to instructions. */
function anchorIx(builder: any): any {
  return builder;
}
