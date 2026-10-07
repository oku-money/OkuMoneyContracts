#!/usr/bin/env tsx
/**
 * Localnet upgrade drill: the REAL upgrade script against a real validator.
 *
 *   npm run drill:upgrade        (needs `anchor build` + `make fetch-token-2022`)
 *
 * Starts `solana-test-validator` on :8899 with lite_psm as an upgradeable
 * program (authority = a throwaway wallet) and the mainnet Token-2022 dump,
 * initializes it with deploy-init.ts, records the deploy baseline, then:
 *
 *   1. unchanged ELF                   -> no-op, nothing recorded
 *   2. ELF compiled for another id     -> refused before any upload (U-03)
 *   3. V2 ELF, direct                  -> upgraded, liveness + state checks, recorded
 *   4. authority -> "vault" keypair    (set-upgrade-authority.ts)
 *   5. direct with the vault as authority -> refused
 *   6. V3 ELF, propose                 -> buffer handed to the vault, program untouched
 *   7. the vault executes              (solana program upgrade, as Squads would)
 *   8. verify                          -> recorded as multisig
 *   9. role_admin CLIs                 propose, cancel, propose, accept
 *
 * V2/V3 are the real build with one byte of the embedded security.txt
 * changed: distinct ELFs, identical behaviour. Everything runs against a temp
 * ledger and a temp wallet; deployments/localnet.json and the localnet IDL
 * snapshots are gitignored and restored afterwards.
 */

import { ChildProcess, spawn, spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getUpgradeAuthority, readOnChainElf } from '../upgrade/lib/elfCompare';
import { readBuffer } from '../upgrade/lib/deployUpgrade';
import { recordDeployBaseline } from '../upgrade/lib/baseline';
import { getUpgradeRecords } from '../utils/addressBook';

const ROOT = process.cwd();
const SO = path.join(ROOT, 'target/deploy/lite_psm.so');
const IDL = path.join(ROOT, 'target/idl/lite_psm.json');
const TOKEN22 = path.join(ROOT, 'target/deploy/spl_token_2022.so');
const LOCALNET_JSON = path.join(ROOT, 'deployments/localnet.json');
const RPC = 'http://127.0.0.1:8899';

let validator: ChildProcess | undefined;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okum-svm-upgrade-drill-'));
let failures = 0;

function step(msg: string) {
  console.log(`\n\x1b[1m=== ${msg}\x1b[0m`);
}
function check(cond: boolean, msg: string) {
  console.log(`${cond ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${msg}`);
  if (!cond) failures++;
}

function writeKeypair(file: string): Keypair {
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/** Copy of the ELF with one security.txt byte changed (`Lite-PSM` -> `Lite-PS<c>`). */
function variant(c: string): string {
  const elf = fs.readFileSync(SO);
  const at = elf.indexOf(Buffer.from('OkuMoney Lite-PSM'));
  if (at < 0) throw new Error('security.txt name not found in the ELF');
  elf.write(c, at + 'OkuMoney Lite-PS'.length, 'latin1');
  const out = path.join(tmp, `lite_psm_${c}.so`);
  fs.writeFileSync(out, elf);
  return out;
}

/** Copy of the ELF with its embedded program id replaced (compiled "for another id"). */
function foreignIdElf(programId: PublicKey): string {
  const elf = fs.readFileSync(SO);
  const id = programId.toBuffer();
  let at = elf.indexOf(id);
  const other = Keypair.generate().publicKey.toBuffer();
  while (at >= 0) {
    other.copy(elf, at);
    at = elf.indexOf(id, at + 32);
  }
  const out = path.join(tmp, 'lite_psm_foreign.so');
  fs.writeFileSync(out, elf);
  return out;
}

function run(script: string, env: Record<string, string>, args: string[] = []): { code: number; out: string } {
  const r = spawnSync('npx', ['tsx', script, ...args], {
    cwd: ROOT,
    env: { ...process.env, NETWORK: 'localnet', ...env },
    encoding: 'utf-8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (process.env.DRILL_VERBOSE) console.log(out);
  return { code: r.status ?? 1, out };
}

async function waitForRpc(conn: Connection) {
  for (let i = 0; i < 60; i++) {
    try {
      await conn.getSlot();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('validator did not come up');
}

async function main() {
  for (const f of [SO, IDL, TOKEN22]) {
    if (!fs.existsSync(f)) throw new Error(`missing ${f} (anchor build; make fetch-token-2022)`);
  }
  const conn = new Connection(RPC, 'confirmed');
  try {
    await conn.getSlot();
    throw new Error('something is already listening on :8899 — stop it first');
  } catch (e: any) {
    if (/already listening/.test(e.message)) throw e;
  }

  const idl = JSON.parse(fs.readFileSync(IDL, 'utf-8'));
  const programId = new PublicKey(idl.address);
  const walletFile = path.join(tmp, 'wallet.json');
  const wallet = writeKeypair(walletFile);
  const vaultFile = path.join(tmp, 'vault.json');
  const vault = writeKeypair(vaultFile);
  const env = { WALLET_PATH: walletFile, MAX_RETRIES: '2', RETRY_DELAY_MS: '2000', PRIORITY_FEE: '1' };

  const localnetBackup = fs.existsSync(LOCALNET_JSON) ? fs.readFileSync(LOCALNET_JSON) : null;
  if (localnetBackup) fs.unlinkSync(LOCALNET_JSON);

  try {
    step('Start validator');
    validator = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', path.join(tmp, 'ledger'),
        '--mint', wallet.publicKey.toBase58(),
        '--upgradeable-program', programId.toBase58(), SO, walletFile,
        '--bpf-program', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', TOKEN22,
      ],
      { stdio: 'ignore' }
    );
    await waitForRpc(conn);
    fs.mkdirSync(path.dirname(LOCALNET_JSON), { recursive: true });
    fs.writeFileSync(
      LOCALNET_JSON,
      JSON.stringify({ network: 'localnet', timestamp: new Date().toISOString(), tokens: {}, programs: { litePsm: programId.toBase58() }, pdas: {} }, null, 2)
    );

    step('Initialize (deploy-init.ts) and record the deploy baseline');
    const init = run('scripts/deploy/deploy-init.ts', env);
    check(init.code === 0, 'deploy-init succeeded');
    if (init.code !== 0) throw new Error(init.out.slice(-3000));
    const base = await recordDeployBaseline({ network: 'localnet', connection: conn, programId, deployer: wallet.publicKey, soPath: SO, idlPath: IDL });
    check(base.recorded, 'deploy baseline recorded');

    const upgrade = (extra: Record<string, string>) => run('scripts/upgrade/index.ts', { ...env, TARGETS: 'LitePsm', ...extra });
    const records = () => getUpgradeRecords('localnet').filter((r) => r.mode !== 'deploy');

    step('1. Unchanged ELF');
    let r = upgrade({});
    check(r.code === 0 && /nothing to do/.test(r.out), 'no-op');
    check(records().length === 0, 'nothing recorded');

    step('2. ELF compiled for another program id');
    const before = (await readOnChainElf(conn, programId, fs.readFileSync(SO).length)).sha256;
    r = upgrade({ SO_PATH: foreignIdElf(programId) });
    check(r.code !== 0 && /compiled for a different declare_id/.test(r.out), 'refused by the identity check');
    check((await readOnChainElf(conn, programId, fs.readFileSync(SO).length)).sha256 === before, 'program untouched');

    step('2b. Dry run');
    r = upgrade({ SO_PATH: variant('N'), DRY_RUN: 'true' });
    check(r.code === 0 && /DRY RUN/.test(r.out), 'dry run passes');
    check((await readOnChainElf(conn, programId, fs.readFileSync(SO).length)).sha256 === before, 'dry run sent nothing');

    step('3. V2 direct upgrade');
    const v2 = variant('X');
    r = upgrade({ SO_PATH: v2 });
    check(r.code === 0, 'direct upgrade succeeded');
    if (r.code !== 0) console.log(r.out.slice(-4000));
    check(/simulated sync_display_multiplier/.test(r.out), 'liveness simulated');
    const v2elf = fs.readFileSync(v2);
    check((await readOnChainElf(conn, programId, v2elf.length)).sha256 === require('crypto').createHash('sha256').update(v2elf).digest('hex'), 'on-chain ELF is V2');
    check(records().at(-1)?.mode === 'direct', 'recorded as direct');

    step('4. Hand the upgrade authority to the "vault"');
    r = run('scripts/admin/set-upgrade-authority.ts', env, [
      `--program=${programId.toBase58()}`, `--new-authority=${vault.publicKey.toBase58()}`, `--confirm=${vault.publicKey.toBase58()}`,
    ]);
    check(r.code === 0, 'set-upgrade-authority succeeded');
    check((await getUpgradeAuthority(conn, programId))?.equals(vault.publicKey) === true, 'authority is the vault');

    step('5. Direct mode with the vault as authority');
    const v3 = variant('Y');
    r = upgrade({ SO_PATH: v3 });
    check(r.code !== 0 && /MODE=propose/.test(r.out), 'refused, pointing at MODE=propose');

    step('6. Propose');
    r = upgrade({ SO_PATH: v3, MODE: 'propose', SQUADS_VAULT: vault.publicKey.toBase58() });
    check(r.code === 0, 'proposal written');
    if (r.code !== 0) console.log(r.out.slice(-4000));
    const proposalRel = r.out.match(/(deployments\/proposals\/localnet-[^\s]+\.json)/)?.[1];
    check(!!proposalRel, 'proposal path printed');
    const proposal = JSON.parse(fs.readFileSync(path.join(ROOT, proposalRel!), 'utf-8'));
    const buffer = new PublicKey(proposal.buffer);
    check((await readBuffer(conn, buffer)).authority?.equals(vault.publicKey) === true, 'buffer authority is the vault');
    check((await readOnChainElf(conn, programId, v2elf.length)).sha256 === require('crypto').createHash('sha256').update(v2elf).digest('hex'), 'program still V2');

    step('7. The vault executes');
    execFileSync('solana', ['program', 'upgrade', buffer.toBase58(), programId.toBase58(), '--upgrade-authority', vaultFile, '--keypair', walletFile, '--url', 'localhost'], { stdio: 'pipe' });

    step('8. Verify');
    r = upgrade({ MODE: 'verify', PROPOSAL: proposalRel! });
    check(r.code === 0, 'verify succeeded');
    if (r.code !== 0) console.log(r.out.slice(-4000));
    check(records().at(-1)?.mode === 'multisig', 'recorded as multisig');
    fs.rmSync(path.join(ROOT, proposalRel!), { force: true });

    step('9. role_admin handover CLIs: propose -> cancel -> propose -> accept (as the vault)');
    execFileSync('solana', ['transfer', vault.publicKey.toBase58(), '2', '--allow-unfunded-recipient', '--keypair', walletFile, '--url', 'localhost'], { stdio: 'pipe' });
    const propose = () => run('scripts/admin/set-authority.ts', env, ['--role=roleAdmin', `--new=${vault.publicKey.toBase58()}`]);
    check(propose().code === 0, 'proposed');
    r = run('scripts/admin/cancel-role-admin-transfer.ts', env);
    check(r.code === 0 && /Pending transfer cleared/.test(r.out), 'cancelled by the current admin');
    check(propose().code === 0, 'proposed again');
    r = run('scripts/admin/accept-role-admin.ts', env);
    check(r.code === 0 && /accept_role_admin — sign as/.test(r.out), 'non-pending wallet gets the instruction printed, nothing sent');
    r = run('scripts/admin/accept-role-admin.ts', { ...env, WALLET_PATH: vaultFile });
    check(r.code === 0 && /role_admin is now/.test(r.out), 'accepted by the pending admin');
  } finally {
    validator?.kill('SIGTERM');
    if (fs.existsSync(LOCALNET_JSON)) fs.unlinkSync(LOCALNET_JSON);
    if (localnetBackup) fs.writeFileSync(LOCALNET_JSON, localnetBackup);
    for (const d of ['deployments/idl', 'deployments/proposals']) {
      const dir = path.join(ROOT, d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.startsWith('localnet-')) fs.rmSync(path.join(dir, f));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mUpgrade drill passed\x1b[0m');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  validator?.kill('SIGTERM');
  console.error(e);
  process.exit(1);
});
