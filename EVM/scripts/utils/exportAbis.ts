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
  sol: string; // path under src/ to the .sol file
  name: string; // contract name (also the artifact filename)
}

const PRODUCTION_CONTRACTS: ContractSpec[] = [
  { sol: "token/OkuDollar.sol", name: "OkuDollar" },
  { sol: "oracle/OkuMultiplierAdapter.sol", name: "OkuMultiplierAdapter" },
  { sol: "psm/LitePSM.sol", name: "LitePSM" },
  { sol: "psm/RedemptionQueue.sol", name: "RedemptionQueue" },
];

const HARDHAT_ARTIFACTS_DIR = path.resolve(__dirname, "../../artifacts/src");
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

  for (const { sol, name } of PRODUCTION_CONTRACTS) {
    const src = path.join(HARDHAT_ARTIFACTS_DIR, sol, `${name}.json`);
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
