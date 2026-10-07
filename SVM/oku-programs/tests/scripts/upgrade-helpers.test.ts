/**
 * Unit tests for the pure parts of the SVM upgrade tooling
 * (scripts/upgrade/lib/identity.ts, lib/idlDiff.ts, preState.ts). The
 * end-to-end path is the localnet drill: scripts/test/upgrade-drill.ts.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { checkProgramIdentity, IdentitySources } from '../../scripts/upgrade/lib/identity';
import { diffIdl, accountLayout } from '../../scripts/upgrade/lib/idlDiff';
import { decodePsmConfig, diffSnapshots, StateSnapshot } from '../../scripts/upgrade/preState';
import { PSM_CONFIG_LEN } from '../../scripts/lib/account-sizes';

const IDL_PATH = path.join(__dirname, '../../../../artifacts/svm/lite_psm.json');
const idl = () => JSON.parse(fs.readFileSync(IDL_PATH, 'utf-8'));

describe('upgrade identity binding', () => {
  const id = new PublicKey(idl().address);
  const elf = Buffer.concat([Buffer.alloc(64, 1), id.toBuffer(), Buffer.alloc(64, 2)]);
  const ok: IdentitySources = {
    expected: id,
    declareId: id.toBase58(),
    idlAddress: id.toBase58(),
    anchorToml: id.toBase58(),
    anchorTomlRequired: true,
    keypairPubkey: id.toBase58(),
    elf,
  };

  it('passes when every source agrees', () => {
    expect(checkProgramIdentity(ok)).to.deep.equal([]);
  });

  it('flags each disagreeing source (U-02 / U-03)', () => {
    const other = Keypair.generate().publicKey.toBase58();
    for (const k of ['declareId', 'idlAddress', 'anchorToml', 'keypairPubkey'] as const) {
      const out = checkProgramIdentity({ ...ok, [k]: other });
      expect(out, k).to.have.length(1);
    }
  });

  it('rejects an ELF compiled for another declare_id!', () => {
    const foreign = Buffer.concat([Buffer.alloc(64), Keypair.generate().publicKey.toBuffer()]);
    expect(checkProgramIdentity({ ...ok, elf: foreign }).join()).to.match(/compiled for a different/);
  });

  it('requires the Anchor.toml entry off localnet, tolerates its absence on localnet', () => {
    expect(checkProgramIdentity({ ...ok, anchorToml: undefined })).to.have.length(1);
    expect(checkProgramIdentity({ ...ok, anchorToml: undefined, anchorTomlRequired: false })).to.deep.equal([]);
  });

  it('a missing keypair file is not an error, a mismatched one is', () => {
    expect(checkProgramIdentity({ ...ok, keypairPubkey: undefined })).to.deep.equal([]);
  });
});

describe('upgrade IDL diff', () => {
  it('the committed IDL is identical to itself', () => {
    expect(diffIdl(idl(), idl())).to.deep.equal({ layoutBreaks: [], clientChanges: [] });
  });

  it('PsmConfig layout is fixed-size and sums to PSM_CONFIG_LEN', () => {
    const l = accountLayout(idl(), 'PsmConfig')!;
    expect(l).to.not.equal(null);
    const last = l[l.length - 1];
    expect(last.offset + last.size).to.equal(PSM_CONFIG_LEN);
  });

  const cfgFields = (i: any) => i.types.find((t: any) => t.name === 'PsmConfig').type.fields;

  it('a field reorder is a layout break even though every name survives', () => {
    const next = idl();
    const f = cfgFields(next);
    [f[1], f[2]] = [f[2], f[1]];
    expect(diffIdl(idl(), next).layoutBreaks.join()).to.match(/offset/);
  });

  it('a type change is a layout break', () => {
    const next = idl();
    const f = cfgFields(next).find((x: any) => x.name === 'max_supply');
    f.type = 'u128';
    expect(diffIdl(idl(), next).layoutBreaks.length).to.be.greaterThan(0);
  });

  it('consuming reserved from the front with the size held is allowed', () => {
    const next = idl();
    const f = cfgFields(next);
    const r = f.findIndex((x: any) => x.name === 'reserved');
    const n = f[r].type.array[1];
    f.splice(r, 1, { name: 'new_flag', type: 'u64' }, { name: 'reserved', type: { array: ['u8', n - 8] } });
    const d = diffIdl(idl(), next);
    expect(d.layoutBreaks).to.deep.equal([]);
    expect(d.clientChanges.join()).to.match(/new field new_flag/);
  });

  it('growing the account is a layout break (no realloc path)', () => {
    const next = idl();
    cfgFields(next).push({ name: 'extra', type: 'u64' });
    expect(diffIdl(idl(), next).layoutBreaks.join()).to.match(/size/);
  });

  it('a changed discriminator is a layout break', () => {
    const next = idl();
    next.accounts[0].discriminator = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(diffIdl(idl(), next).layoutBreaks.join()).to.match(/discriminator/);
  });

  it('instruction and error changes are client changes, not layout breaks', () => {
    const next = idl();
    next.instructions = next.instructions.filter((i: any) => i.name !== 'pause');
    next.errors[0].name = 'Renamed';
    const d = diffIdl(idl(), next);
    expect(d.layoutBreaks).to.deep.equal([]);
    expect(d.clientChanges.join()).to.match(/instruction pause removed/);
    expect(d.clientChanges.join()).to.match(/Renamed/);
  });
});

describe('upgrade state snapshots', () => {
  it('decodes PsmConfig with camelCase fields', () => {
    const i = idl();
    const buf = Buffer.alloc(PSM_CONFIG_LEN);
    Buffer.from(i.accounts[0].discriminator).copy(buf);
    const cfg = decodePsmConfig(i, buf);
    expect(cfg).to.have.property('roleAdmin');
    expect(cfg).to.have.property('okumBaseMultiplier');
  });

  it('volatile fields never diff; config and invariant fields do, with their kind', () => {
    const a: StateSnapshot = {
      okuMMint: { value: 'A', kind: 'invariant' },
      pauser: { value: 'P', kind: 'config' },
      'vault.amount': { value: '1', kind: 'volatile' },
    };
    const b: StateSnapshot = {
      okuMMint: { value: 'B', kind: 'invariant' },
      pauser: { value: 'Q', kind: 'config' },
      'vault.amount': { value: '2', kind: 'volatile' },
    };
    const d = diffSnapshots(a, b);
    expect(d.map((x) => [x.field, x.kind])).to.deep.equal([
      ['okuMMint', 'invariant'],
      ['pauser', 'config'],
    ]);
  });
});
