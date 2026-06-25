/**
 * Storage-layout compatibility probe.
 *
 * Calls `upgrades.validateUpgrade` (a non-broadcasting dry-run) against each
 * registered proxy. Prints which targets are upgrade-compatible vs require
 * a fresh redeploy.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/checkLayout.ts --network localhost
 */

import { ethers, upgrades } from "hardhat";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { resolveNetworkContext } from "../utils/networkContext";
import { logger } from "../utils/logger";

const TARGETS: Record<string, string> = {
  OkuMoney: "OkuMoney",
  OkuDollar: "OkuDollar",
  RedemptionQueue: "RedemptionQueue",
  LitePSM: "LitePSM",
};

async function main() {
  const ctx = await resolveNetworkContext();
  const { networkName, chainConfig } = ctx;
  const bookKey = networkName;

  logger.header(`Storage layout check on ${chainConfig.name} (book key: ${bookKey})`);

  const results: Array<{ name: string; proxy: string; ok: boolean; err?: string }> = [];

  for (const [name, factoryName] of Object.entries(TARGETS)) {
    if (!hasAddress(bookKey, name)) {
      results.push({ name, proxy: "<not deployed>", ok: false, err: "no address book entry" });
      continue;
    }
    const proxyAddress = loadAddress(bookKey, name);

    // Sanity: bytecode at the address?
    const code = await ethers.provider.getCode(proxyAddress);
    if (!code || code === "0x") {
      results.push({ name, proxy: proxyAddress, ok: false, err: "no bytecode at proxy" });
      continue;
    }

    const Factory = await ethers.getContractFactory(factoryName);

    try {
      // First, attempt forceImport. If the OZ manifest doesn't know about
      // this proxy yet (different machine / older manifest), forceImport
      // registers it. No-op if already registered.
      try {
        await upgrades.forceImport(proxyAddress, Factory, { kind: "uups" });
      } catch (e: any) {
        // forceImport itself can fail if the on-chain bytecode's storage
        // is structurally incompatible with the local Factory's layout.
        // That's exactly the case we're trying to detect — bubble it up.
        results.push({
          name,
          proxy: proxyAddress,
          ok: false,
          err: `forceImport: ${(e.message || String(e)).split("\n")[0]}`,
        });
        continue;
      }

      // Now run validateUpgrade. This is the same check `upgradeProxy` runs
      // internally before broadcasting; it never touches chain.
      await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups" });
      results.push({ name, proxy: proxyAddress, ok: true });
    } catch (e: any) {
      results.push({
        name,
        proxy: proxyAddress,
        ok: false,
        err: (e.message || String(e)).split("\n").slice(0, 6).join(" | "),
      });
    }
  }

  console.log();
  console.log("Storage-layout compatibility:");
  for (const r of results) {
    const status = r.ok ? "✓ COMPATIBLE" : "✗ INCOMPATIBLE";
    console.log(`  ${r.name.padEnd(18)} ${r.proxy} ${status}`);
    if (r.err) console.log(`    ${r.err.slice(0, 280)}`);
  }
  console.log();
  const incompat = results.filter((r) => !r.ok);
  if (incompat.length > 0) {
    console.log(
      `${incompat.length} of ${results.length} target(s) require a fresh redeploy.`
    );
  } else {
    console.log(`All ${results.length} target(s) are upgrade-compatible.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Layout check failed: ${err.message || err}`);
    console.error(err);
    process.exit(1);
  });
