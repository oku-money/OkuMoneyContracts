/**
 * Local ERC-7730 validation gate.
 *
 * WHY THIS EXISTS. The registry's own linter fetches a reference ABI from
 * Sourcify/Etherscan and validates display fields against it - but it has a
 * proxy heuristic that SKIPS that validation entirely when the target looks
 * like a proxy. All four of our contracts are UUPS proxies, so the registry
 * will very likely validate nothing about our field paths. The registry's
 * REVIEWING.md tells reviewers to watch for exactly this ("Could not fetch
 * ABI") and to fall back on asking the author to verify.
 *
 * So we do it ourselves, against the ABI we actually compiled:
 *
 *   1. every format key is a real selector in our ABI
 *   2. every format key reproduces the ABI fragment byte for byte
 *   3. every field path is a real parameter
 *   4. every parameter is either displayed or explicitly `visible: "never"`
 *   5. no value-bearing parameter is hidden
 *   6. (strict) no placeholders remain
 *
 * Usage:
 *   npm run metadata:validate          # pre-deployment: placeholders allowed
 *   npm run metadata:validate -- --strict   # pre-submission: placeholders fail
 */

import fs from "fs";
import path from "path";
import { keccak256, toUtf8Bytes, getAddress } from "ethers";
import { PLACEHOLDERS } from "./descriptorSpec";

const META_DIR = path.resolve(__dirname, "../../metadata/erc7730");
const FORGE_OUT = path.resolve(__dirname, "../../out");

const STRICT = process.argv.includes("--strict");

let errors = 0;
let warnings = 0;
const fail = (m: string) => {
  console.error(`  \x1b[31mERROR\x1b[0m  ${m}`);
  errors++;
};
const warn = (m: string) => {
  console.warn(`  \x1b[33mWARN\x1b[0m   ${m}`);
  warnings++;
};

/**
 * Parameters that carry value or authority. Hiding one of these is the single
 * most dangerous descriptor mistake, and the registry review checklist calls it
 * out by name, so we make it a hard error rather than trusting a human pass.
 */
const VALUE_BEARING = /amount|value|shares|supply|allowance|rate|multiplier|fee|spender|receiver|treasury|recipient|implementation|role|token|min/i;

interface AbiInput {
  name: string;
  type: string;
  components?: AbiInput[];
}
interface AbiEntry {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiInput[];
}

function canonicalType(i: AbiInput): string {
  if (i.type.startsWith("tuple")) {
    return `(${(i.components ?? []).map(canonicalType).join(",")})${i.type.slice(5)}`;
  }
  return i.type;
}
const typeOnly = (fn: AbiEntry) =>
  `${fn.name}(${(fn.inputs ?? []).map(canonicalType).join(",")})`;
const withNames = (fn: AbiEntry) =>
  `${fn.name}(${(fn.inputs ?? []).map((i) => `${canonicalType(i)} ${i.name}`).join(",")})`;
const selectorOf = (sig: string) => keccak256(toUtf8Bytes(sig)).slice(0, 10);

/** Strip parameter names from a descriptor key, per the ERC-7730 matching rule. */
function keyToTypeOnly(key: string): string {
  const open = key.indexOf("(");
  const name = key.slice(0, open);
  const inner = key.slice(open + 1, key.lastIndexOf(")"));
  if (inner.trim() === "") return `${name}()`;
  const types = inner.split(",").map((p) => p.trim().split(/\s+/)[0]);
  return `${name}(${types.join(",")})`;
}

function loadAbi(contract: string): AbiEntry[] {
  const p = path.join(FORGE_OUT, `${contract}.sol`, `${contract}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing artifact ${p} - run \`forge build\``);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi as AbiEntry[];
}

function checkPlaceholders(name: string, doc: any): void {
  const raw = JSON.stringify(doc);
  const hits: string[] = [];
  if (raw.includes(PLACEHOLDERS.owner)) hits.push("metadata.owner");
  if (raw.includes(PLACEHOLDERS.url)) hits.push("metadata.info.url");
  if (raw.includes(PLACEHOLDERS.address)) hits.push("zero address");
  if (raw.includes('"chainId": 0')) hits.push("chainId 0");

  if (hits.length === 0) return;
  const msg = `${name}: unresolved placeholders (${hits.join(", ")}) - run metadata:sync after deployment`;
  STRICT ? fail(msg) : warn(msg);
}

function checkDeployments(name: string, doc: any): void {
  const deployments =
    doc.context?.contract?.deployments ?? doc.context?.eip712?.deployments ?? [];
  if (deployments.length === 0) {
    fail(`${name}: context has no deployments`);
    return;
  }
  for (const d of deployments) {
    if (typeof d.chainId !== "number") fail(`${name}: deployment chainId must be a number`);
    // The schema demands EIP-55; a lowercase address silently fails wallet matching.
    try {
      if (d.address !== getAddress(d.address)) {
        const msg = `${name}: address ${d.address} is not EIP-55 checksummed`;
        d.address === PLACEHOLDERS.address ? void 0 : fail(msg);
      }
    } catch {
      fail(`${name}: address ${d.address} is not a valid address`);
    }
  }
}

function validateCalldata(file: string, contract: string): void {
  const doc = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));
  console.log(`\n${file}`);

  checkPlaceholders(file, doc);
  checkDeployments(file, doc);

  const abi = loadAbi(contract);
  const fns = abi.filter(
    (e) => e.type === "function" && e.stateMutability !== "view" && e.stateMutability !== "pure"
  );
  const bySelector = new Map(fns.map((f) => [selectorOf(typeOnly(f)), f]));
  const byExactKey = new Map(fns.map((f) => [withNames(f), f]));

  const formats = doc.display?.formats ?? {};
  const seenSelectors = new Set<string>();

  for (const [key, fmt] of Object.entries<any>(formats)) {
    // (1) selector must exist
    const sel = selectorOf(keyToTypeOnly(key));
    const fn = bySelector.get(sel);
    if (!fn) {
      fail(`${file}: "${key}" -> selector ${sel} not found in ${contract} ABI`);
      continue;
    }
    if (seenSelectors.has(sel)) {
      fail(`${file}: duplicate selector ${sel} - descriptor is invalid per spec`);
    }
    seenSelectors.add(sel);

    // (2) key must reproduce the fragment exactly (names included)
    if (!byExactKey.has(key)) {
      fail(
        `${file}: "${key}" does not match the ABI fragment exactly.\n         expected: "${withNames(fn)}"`
      );
    }

    // (3)+(4)+(5) field/parameter correspondence
    const fields: any[] = fmt.fields ?? [];
    const paths = new Set(fields.map((f) => f.path));
    for (const inp of fn.inputs ?? []) {
      if (!paths.has(inp.name)) {
        fail(`${file}: ${fn.name} parameter "${inp.name}" has no display field`);
      }
    }
    for (const f of fields) {
      if (!(fn.inputs ?? []).some((i) => i.name === f.path)) {
        fail(`${file}: ${fn.name} field path "${f.path}" is not a parameter`);
      }
      if (f.visible === "never" && VALUE_BEARING.test(f.path)) {
        fail(
          `${file}: ${fn.name} hides value-bearing parameter "${f.path}" - never hide these`
        );
      }
    }

    if (!fmt.intent) fail(`${file}: "${key}" has no intent`);
  }

  // Every state-changing function must be covered, or a signer blind-signs it.
  for (const fn of fns) {
    if (!seenSelectors.has(selectorOf(typeOnly(fn)))) {
      fail(`${file}: ${contract}.${fn.name} has no descriptor - would be blind-signed`);
    }
  }

  console.log(
    `  ${Object.keys(formats).length} formats checked against ${fns.length} ABI functions`
  );
}

function validateEip712(file: string): void {
  const doc = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));
  console.log(`\n${file}`);
  checkPlaceholders(file, doc);
  checkDeployments(file, doc);

  const formats = doc.display?.formats ?? {};
  for (const [key, fmt] of Object.entries<any>(formats)) {
    if (!fmt.intent) fail(`${file}: "${key}" has no intent`);
    for (const f of (fmt.fields ?? []) as any[]) {
      if (f.visible === "never" && VALUE_BEARING.test(f.path ?? "")) {
        fail(`${file}: hides value-bearing field "${f.path}"`);
      }
    }
  }
  console.log(`  ${Object.keys(formats).length} message format(s) checked`);
}

function main(): void {
  console.log(
    `ERC-7730 local validation${STRICT ? " (STRICT - pre-submission)" : " (placeholders allowed)"}`
  );
  console.log(
    "Covers what the registry linter skips on proxy contracts: selectors, exact\n" +
      "fragments, field paths, parameter coverage and hidden value-bearing fields."
  );

  const pairs: Array<[string, string]> = [
    ["calldata-OkuM.json", "OkuM"],
    ["calldata-USDOku.json", "USDOku"],
    ["calldata-USDOkuWrapper.json", "USDOkuWrapper"],
    ["calldata-SubscriptionModule.json", "SubscriptionModule"],
  ];
  for (const [file, contract] of pairs) validateCalldata(file, contract);
  for (const file of ["eip712-OkuM-permit.json", "eip712-USDOku-permit.json"]) {
    validateEip712(file);
  }

  console.log(`\n${errors} error(s), ${warnings} warning(s)`);
  if (errors > 0) {
    console.error("Descriptors are NOT safe to publish.");
    process.exit(1);
  }
  console.log("Descriptors are internally consistent with the compiled ABI.");
}

main();
