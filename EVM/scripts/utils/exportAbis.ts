/**
 * Curated ABI export for downstream consumers.
 *
 * Reads Hardhat artifacts from EVM/artifacts/src/ and writes a slim JSON file
 * (abi + bytecode + deployedBytecode) for each production contract into the
 * repo-root artifacts/evm/ directory.
 *
 * This is a one-way mirror: artifacts/evm/ is considered read-only by
 * downstream consumers. To refresh, run `npx hardhat compile` then
 * `npm run export-abis` in EVM/.
 */

import fs from "fs";
import path from "path";

interface ContractSpec {
  /** Directory under the artifacts root holding `<name>.sol/`. */
  sol: string;
  /** Contract name (also the artifact filename). */
  name: string;
  /**
   * Artifact root. Defaults to `artifacts/src`. MockUSDC lives under
   * `artifacts/test` because it is compiled via the `test/mocks/*.sol`
   * source-path override in hardhat.config.ts — it is exported because the
   * deploy script deploys it on testnets, so downstream consumers need its ABI.
   */
  root?: "src" | "test";
}

const PRODUCTION_CONTRACTS: ContractSpec[] = [
  { sol: "token/OkuM.sol", name: "OkuM" },
  { sol: "token/USDOku.sol", name: "USDOku" },
  { sol: "wrapper/USDOkuWrapper.sol", name: "USDOkuWrapper" },
  { sol: "subscription/SubscriptionModule.sol", name: "SubscriptionModule" },
  { sol: "oracle/OkuMultiplierAdapter.sol", name: "OkuMultiplierAdapter" },
  { sol: "mocks/MockUSDC.sol", name: "MockUSDC", root: "test" },
];

const ARTIFACTS_ROOT = path.resolve(__dirname, "../../artifacts");
const HARDHAT_ARTIFACTS_DIR = path.join(ARTIFACTS_ROOT, "src");
const OUT_DIR = path.resolve(__dirname, "../../../artifacts/evm");

function main(): void {
  if (!fs.existsSync(HARDHAT_ARTIFACTS_DIR)) {
    console.error(
      `Hardhat artifacts not found at ${HARDHAT_ARTIFACTS_DIR}. Run \`npx hardhat compile\` first.`
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let exported = 0;
  let skipped = 0;

  for (const { sol, name, root } of PRODUCTION_CONTRACTS) {
    const src = path.join(ARTIFACTS_ROOT, root ?? "src", sol, `${name}.json`);
    if (!fs.existsSync(src)) {
      console.warn(`  ! ${name}: missing artifact at ${src}`);
      skipped++;
      continue;
    }

    const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
    const slim = {
      contractName: artifact.contractName,
      sourceName: artifact.sourceName,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
    };

    fs.writeFileSync(
      path.join(OUT_DIR, `${name}.json`),
      JSON.stringify(slim, null, 2) + "\n"
    );
    console.log(`  ✓ ${name}`);
    exported++;
  }

  console.log(
    `\nExported ${exported} contract ABI(s) to ${path.relative(process.cwd(), OUT_DIR)}${
      skipped > 0 ? ` (skipped ${skipped})` : ""
    }.`
  );
  if (skipped > 0) process.exit(1);
}

main();
