/**
 * Curated IDL export for downstream consumers.
 *
 * Copies the 3 production IDLs from target/idl/ (produced by `anchor build`)
 * into the repo-root artifacts/svm/ directory.
 *
 * This is a one-way mirror: artifacts/svm/ is considered read-only by
 * downstream consumers. To refresh, run `anchor build` then
 * `npm run export-idls` in SVM/oku-programs/.
 */

import * as fs from 'fs';
import * as path from 'path';

const IDL_NAMES = ['lite_psm', 'oku_dollar', 'oku_bridge_router'];

const SVM_IDL_DIR = path.resolve(__dirname, '../../target/idl');
const OUT_DIR = path.resolve(__dirname, '../../../../artifacts/svm');

function main(): void {
  if (!fs.existsSync(SVM_IDL_DIR)) {
    console.error(
      `Anchor IDL directory not found at ${SVM_IDL_DIR}. Run \`anchor build\` first.`
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let exported = 0;
  let skipped = 0;

  for (const name of IDL_NAMES) {
    const src = path.join(SVM_IDL_DIR, `${name}.json`);
    if (!fs.existsSync(src)) {
      console.warn(`  ! ${name}: missing IDL at ${src}`);
      skipped++;
      continue;
    }
    fs.copyFileSync(src, path.join(OUT_DIR, `${name}.json`));
    console.log(`  ✓ ${name}`);
    exported++;
  }

  console.log(
    `\nExported ${exported} IDL(s) to ${path.relative(process.cwd(), OUT_DIR)}${
      skipped > 0 ? ` (skipped ${skipped})` : ''
    }.`
  );
  if (skipped > 0) process.exit(1);
}

main();
