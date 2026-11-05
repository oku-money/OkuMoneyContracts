import { expect } from 'chai';
import { SVM_MAINNET_NETWORKS } from '@okumoney/yield-tooling';
import { getDeploymentConfig } from '../../scripts/deploy/lib/config';
import { MINTER_ALLOWANCE } from '../../scripts/config/constants';

// Cyfrin audit finding #2: mainnet initializes with PSM minting closed.
describe('deploy config: PSM minting closed on mainnet', () => {
  afterEach(() => {
    delete process.env.PSM_MINTING_CLOSED;
  });

  it('every mainnet network initializes with minter_allowance 0, whatever the env says', () => {
    process.env.PSM_MINTING_CLOSED = 'false';
    expect(SVM_MAINNET_NETWORKS.size).to.be.greaterThan(0);
    for (const n of SVM_MAINNET_NETWORKS) {
      expect(getDeploymentConfig(n).minterAllowance.toString(), n).to.equal('0');
    }
  });

  it('devnet / localnet keep the testnet allowance unless PSM_MINTING_CLOSED=true', () => {
    expect(getDeploymentConfig('devnet').minterAllowance.toString()).to.equal(String(MINTER_ALLOWANCE));
    expect(getDeploymentConfig('localnet').minterAllowance.toString()).to.equal(String(MINTER_ALLOWANCE));
    process.env.PSM_MINTING_CLOSED = 'true';
    expect(getDeploymentConfig('devnet').minterAllowance.toString()).to.equal('0');
  });
});
