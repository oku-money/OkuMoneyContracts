/**
 * Print the *current* implementation address behind each proxy + its raw bytecode size.
 * Use after a fork is up to see what code is actually deployed live.
 */

import { ethers, upgrades } from "hardhat";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { resolveNetworkContext } from "../utils/networkContext";

const TARGETS = ["OkuMoney", "OkuDollar", "LitePSM"];

async function main() {
  const { networkName } = await resolveNetworkContext();
  console.log(`Inspecting impls on ${networkName} (live key reused on fork):`);
  for (const t of TARGETS) {
    if (!hasAddress(networkName, t)) {
      console.log(`  ${t.padEnd(18)} <not deployed>`);
      continue;
    }
    const proxy = loadAddress(networkName, t);
    try {
      const impl = await upgrades.erc1967.getImplementationAddress(proxy);
      const code = await ethers.provider.getCode(impl);
      const sizeBytes = (code.length - 2) / 2;
      console.log(`  ${t.padEnd(18)} proxy=${proxy} impl=${impl} implSize=${sizeBytes}B`);
    } catch (e: any) {
      console.log(`  ${t.padEnd(18)} proxy=${proxy} <error: ${e.message?.slice(0, 80)}>`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
