import { spawnSync } from 'child_process';
import * as path from 'path';
import { expect } from 'chai';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEFAULT_DIRECT_MINTER } from '../../scripts/config/constants';
import {
  GRANT_ROLES_REFUSED_NETWORKS,
  assertGrantRolesNetworkAllowed,
  resolveDelegate,
} from '../../scripts/admin/_lib/grant-roles-guard';

// Cyfrin audit finding #15: grant-roles defaulted its delegate to the devnet direct-minter
// key and ran on mainnet, so the old `admin:grant-roles:mainnet` alias handed four
// operational roles (incl. rate_manager) to that key.

const ROOT = path.join(__dirname, '../..');

describe('grant-roles guard (Cyfrin #15)', () => {
  describe('assertGrantRolesNetworkAllowed', () => {
    it('refuses mainnet-beta and mainnet-fork, naming set-authority.ts', () => {
      for (const n of ['mainnet-beta', 'mainnet-fork'] as const) {
        expect(() => assertGrantRolesNetworkAllowed(n)).to.throw(/refuses .*set-authority\.ts/);
        expect(GRANT_ROLES_REFUSED_NETWORKS).to.include(n);
      }
    });

    it('allows the devnet / testnet clusters', () => {
      for (const n of ['localnet', 'devnet', 'devnet-fork'] as const) {
        expect(() => assertGrantRolesNetworkAllowed(n)).not.to.throw();
      }
    });
  });

  describe('resolveDelegate', () => {
    it('has no default: a missing delegate is an error, not the devnet key', () => {
      expect(() => resolveDelegate(undefined)).to.throw(/--delegate=<pubkey> is required/);
      expect(() => resolveDelegate('')).to.throw(/required/);
    });

    it('rejects a malformed or zero pubkey', () => {
      expect(() => resolveDelegate('not-a-pubkey')).to.throw(/not a valid pubkey/);
      expect(() => resolveDelegate(PublicKey.default.toBase58())).to.throw(/zero pubkey/);
    });

    it('returns an explicit delegate unchanged (the devnet key only when asked for by name)', () => {
      const k = Keypair.generate().publicKey;
      expect(resolveDelegate(k.toBase58()).equals(k)).to.equal(true);
      expect(resolveDelegate(DEFAULT_DIRECT_MINTER).toBase58()).to.equal(DEFAULT_DIRECT_MINTER);
    });
  });

  describe('the script itself', () => {
    function run(network: string, args: string[]) {
      return spawnSync('npx', ['tsx', 'scripts/admin/grant-roles.ts', ...args], {
        cwd: ROOT,
        env: { ...process.env, NETWORK: network },
        encoding: 'utf8',
        timeout: 25_000,
      });
    }

    it('refuses mainnet-beta before touching a provider, delegate given or not', () => {
      const k = Keypair.generate().publicKey.toBase58();
      const r = run('mainnet-beta', [`--delegate=${k}`, '--dry-run']);
      expect(r.status).to.not.equal(0);
      expect(`${r.stdout}${r.stderr}`).to.match(/refuses mainnet-beta/);
    });

    it('refuses a run with no --delegate on any network', () => {
      const r = run('devnet', ['--dry-run']);
      expect(r.status).to.not.equal(0);
      expect(`${r.stdout}${r.stderr}`).to.match(/--delegate=<pubkey> is required/);
    });

    it('no longer ships the mainnet alias', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const scripts = require('../../package.json').scripts as Record<string, string>;
      expect(scripts).to.not.have.property('admin:grant-roles:mainnet');
      expect(scripts).to.have.property('admin:grant-roles:devnet');
    });
  });
});
