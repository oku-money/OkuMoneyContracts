/**
 * Curated IDL export for downstream consumers.
 *
 * Copies the production IDL(s) from target/idl/ (produced by `anchor build`)
 * into the repo-root artifacts/svm/ directory. Currently a single program
 * (`lite_psm`); the export is dynamic so it scales to more without a code
 * change (see note below).
 *
 * This is a one-way mirror: artifacts/svm/ is considered read-only by
 * downstream consumers. To refresh, run `anchor build` then
 * `npm run export-idls` in SVM/oku-programs/.
 */

import * as fs from 'fs';
import * as path from 'path';

const SVM_IDL_DIR = path.resolve(__dirname, '../../target/idl');
const OUT_DIR = path.resolve(__dirname, '../../../../artifacts/svm');

/**
 * Reads the Anchor IDL directory dynamically, so adding a program to
 * Cargo.toml does not require touching this file.
 */
function discoverIdlNames(idlDir: string): string[] {
  return fs
    .readdirSync(idlDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function main(): void {
  if (!fs.existsSync(SVM_IDL_DIR)) {
    console.error(
      `Anchor IDL directory not found at ${SVM_IDL_DIR}. Run \`anchor build\` first.`
    );
    process.exit(1);
  }

  const idlNames = discoverIdlNames(SVM_IDL_DIR);
  if (idlNames.length === 0) {
    console.error(`No IDLs found at ${SVM_IDL_DIR}.`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let exported = 0;

  for (const name of idlNames) {
    const src = path.join(SVM_IDL_DIR, `${name}.json`);
    fs.copyFileSync(src, path.join(OUT_DIR, `${name}.json`));
    console.log(`  ✓ ${name}`);
    exported++;
  }

  console.log(
    `\nExported ${exported} IDL(s) to ${path.relative(process.cwd(), OUT_DIR)}.`
  );
}

main();
