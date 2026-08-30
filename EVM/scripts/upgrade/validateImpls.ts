/**
 * Standalone UUPS implementation validator.
 *
 * Runs OpenZeppelin's upgrade-safety checks against every implementation
 * without needing a deployed proxy or a live manifest.
 *
 * This is the check that confirms our ERC-7201 namespaced storage is understood
 * by the plugin. `forge` does not exercise it at all, and a manifest is only
 * written on a real (non-dev) network, so without this the layout safety of the
 * whole contract set would be unverified until the first testnet deploy.
 *
 * Usage:
 *   npm run upgrade:validate
 */

import { ethers, upgrades } from "hardhat";

const TARGETS = ["OkuM", "USDOku", "LitePSM"];

async function main(): Promise<void> {
  let failures = 0;

  for (const name of TARGETS) {
    const factory = await ethers.getContractFactory(name);
    try {
      await upgrades.validateImplementation(factory, { kind: "uups" });
      console.log(`  OK    ${name}`);
    } catch (e: any) {
      failures++;
      const detail = String(e.message).split("\n").slice(0, 12).join("\n        ");
      console.log(`  FAIL  ${name}: ${detail}`);
    }
  }

  if (failures === 0) {
    console.log("\nALL IMPLEMENTATIONS VALID (UUPS, ERC-7201 namespaced storage)");
    process.exit(0);
  }
  console.log(`\n${failures} IMPLEMENTATION(S) FAILED VALIDATION`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
