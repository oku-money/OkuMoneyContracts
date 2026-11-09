import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'chai';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { NETWORK_CONFIGS } from '../../scripts/config/networks';
import { USDC_DECIMALS } from '../../scripts/config/constants';
import { deployTokens, assertConfiguredUsdcMint } from '../../scripts/deploy/lib/tokens';
import { verifyDeployment, PSM_CONFIG_USDC_MINT_OFFSET } from '../../scripts/deploy/lib/verify';
import { PSM_CONFIG_LEN } from '../../scripts/lib/account-sizes';

// Cyfrin audit finding #4: `PsmConfig.usdc_mint` is stored once and never changes,
// so a mainnet deploy must bind the real Circle USDC and never a deployer-owned mock.

const CIRCLE_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function mintAccount(owner: PublicKey, decimals: number, initialized = true, len = 82) {
  const data = Buffer.alloc(len);
  data[44] = decimals;
  data[45] = initialized ? 1 : 0;
  return { owner, data, lamports: 1, executable: false };
}

/** A provider that serves one mint and throws on anything that would create a mock. */
function fakeProvider(account: ReturnType<typeof mintAccount> | null) {
  const asked: string[] = [];
  const provider: any = {
    connection: {
      getAccountInfo: async (k: PublicKey) => {
        asked.push(k.toBase58());
        return account;
      },
    },
    get wallet(): never {
      throw new Error('a mock USDC must never be created for a real-USDC network');
    },
  };
  return { provider, asked };
}

describe('deploy:init reserve mint', () => {
  const realNetworks = Object.values(NETWORK_CONFIGS).filter((n) => !n.usdc.isNative);

  it('every real-USDC network is configured with a concrete mint', () => {
    expect(realNetworks.map((n) => n.name)).to.include.members(['mainnet-beta', 'mainnet-fork']);
    for (const n of realNetworks) {
      expect(n.usdc.mint.equals(PublicKey.default), n.name).to.equal(false);
    }
    expect(NETWORK_CONFIGS['mainnet-beta'].usdc.mint.toBase58()).to.equal(CIRCLE_USDC);
  });

  it('deployTokens returns the configured mint for real-USDC networks and creates no mock', async () => {
    for (const n of realNetworks) {
      const { provider, asked } = fakeProvider(mintAccount(TOKEN_PROGRAM_ID, USDC_DECIMALS));
      const { usdcMint } = await deployTokens(provider, PublicKey.default, n.name);
      expect(usdcMint.equals(n.usdc.mint), n.name).to.equal(true);
      expect(asked, n.name).to.deep.equal([n.usdc.mint.toBase58()]);
    }
  });

  it('refuses a configured mint that is missing, not classic SPL, uninitialized or not 6 decimals', async () => {
    const mint = Keypair.generate().publicKey;
    const cases: Array<[string, ReturnType<typeof mintAccount> | null, RegExp]> = [
      ['missing', null, /does not exist/],
      ['token-2022 owner', mintAccount(TOKEN_2022_PROGRAM_ID, USDC_DECIMALS), /not a classic SPL Token mint/],
      ['wrong length', mintAccount(TOKEN_PROGRAM_ID, USDC_DECIMALS, true, 165), /not a classic SPL Token mint/],
      ['uninitialized', mintAccount(TOKEN_PROGRAM_ID, USDC_DECIMALS, false), /not initialized/],
      ['9 decimals', mintAccount(TOKEN_PROGRAM_ID, 9), /9 decimals/],
    ];
    for (const [label, account, message] of cases) {
      let err: Error | undefined;
      try {
        await assertConfiguredUsdcMint(fakeProvider(account).provider, mint);
      } catch (e: any) {
        err = e;
      }
      expect(err, label).to.not.equal(undefined);
      expect(err!.message, label).to.match(message);
    }
  });
});

describe('verifyDeployment: stored usdc_mint', () => {
  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../../artifacts/svm/lite_psm.json'), 'utf-8')
  );

  it('PSM_CONFIG_USDC_MINT_OFFSET matches the IDL layout', () => {
    const def = idl.types.find((t: any) => t.name === 'PsmConfig');
    const size = (t: string) => {
      if (t === 'u8') return 1;
      if (t === 'pubkey') return 32;
      throw new Error(`unexpected field type ahead of usdc_mint: ${t}`);
    };
    let offset = 8; // discriminator
    for (const f of def.type.fields) {
      if (f.name === 'usdc_mint') break;
      offset += size(f.type);
    }
    expect(PSM_CONFIG_USDC_MINT_OFFSET).to.equal(offset);
  });

  const psmConfigAddr = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey;
  const recordedMint = Keypair.generate().publicKey;

  function deployment(usdc: PublicKey) {
    return {
      tokens: { usdc: usdc.toBase58(), okuM: Keypair.generate().publicKey.toBase58() },
      pdas: { psmConfig: psmConfigAddr.toBase58(), psmVaultUsdc: Keypair.generate().publicKey.toBase58() },
    } as any;
  }

  function provider(storedMint: PublicKey) {
    const data = Buffer.alloc(PSM_CONFIG_LEN);
    Buffer.from('91ddc833e9c956b4', 'hex').copy(data, 0);
    storedMint.toBuffer().copy(data, PSM_CONFIG_USDC_MINT_OFFSET);
    return {
      connection: {
        getAccountInfo: async (k: PublicKey) =>
          k.equals(psmConfigAddr)
            ? { owner: programId, data, lamports: 1, executable: false }
            : { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1, executable: false },
      },
    } as any;
  }

  it('passes when the stored mint is the recorded one', async () => {
    expect(await verifyDeployment(provider(recordedMint), deployment(recordedMint), programId)).to.equal(true);
  });

  it('fails when the stored mint is not the recorded one', async () => {
    const other = Keypair.generate().publicKey;
    expect(await verifyDeployment(provider(other), deployment(recordedMint), programId)).to.equal(false);
  });

  it('fails when the stored mint is not the configured reserve, even if it matches the record', async () => {
    const circle = new PublicKey(CIRCLE_USDC);
    // A mock recorded AND stored: self-consistent, but not the configured reserve.
    expect(await verifyDeployment(provider(recordedMint), deployment(recordedMint), programId, circle)).to.equal(false);
    expect(await verifyDeployment(provider(circle), deployment(circle), programId, circle)).to.equal(true);
  });
});
