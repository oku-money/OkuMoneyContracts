/**
 * Emit ERC-7730 v2 descriptors from the compiled ABI + descriptorSpec.ts.
 *
 * Deriving the format keys from the ABI is the point: ERC-7730 requires the key
 * to reproduce the fragment exactly (canonical types, no space after a comma,
 * one space before each parameter name) and wallets derive every display path
 * from those parameter names. Hand-maintaining that against a moving ABI is a
 * silent-breakage machine.
 *
 * The generator FAILS if the spec and the ABI disagree, so a renamed parameter
 * or a new function is a build error rather than a descriptor that quietly
 * stops matching.
 *
 * Usage:
 *   npm run metadata:build
 */

import fs from "fs";
import path from "path";
import { CONTRACT_SPECS, PERMIT_SPECS, PLACEHOLDERS, FieldSpec } from "./descriptorSpec";

const SCHEMA =
  "https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/specs/erc7730-v2.schema.json";

const OUT_DIR = path.resolve(__dirname, "../../metadata/erc7730");
const FORGE_OUT = path.resolve(__dirname, "../../out");

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

/** Canonical type string, expanding tuples per the ERC-7730 key rules. */
function canonicalType(i: AbiInput): string {
  if (i.type.startsWith("tuple")) {
    const inner = (i.components ?? []).map(canonicalType).join(",");
    return `(${inner})${i.type.slice("tuple".length)}`;
  }
  return i.type;
}

/** The ERC-7730 format key: `name(type param,type param)`. */
function formatKey(fn: AbiEntry): string {
  const params = (fn.inputs ?? []).map((i) => `${canonicalType(i)} ${i.name}`).join(",");
  return `${fn.name}(${params})`;
}

function loadAbi(contract: string): AbiEntry[] {
  const p = path.join(FORGE_OUT, `${contract}.sol`, `${contract}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing Forge artifact ${p}. Run \`forge build\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")).abi as AbiEntry[];
}

function stateChanging(abi: AbiEntry[]): AbiEntry[] {
  return abi.filter(
    (e) => e.type === "function" && e.stateMutability !== "view" && e.stateMutability !== "pure"
  );
}

/** Strip authoring-only keys; the v2 schema forbids extras on field objects. */
function emitField(f: FieldSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.$ref) {
    out.path = f.path;
    out.$ref = f.$ref;
    if (f.label) out.label = f.label;
    return out;
  }
  out.path = f.path;
  if (f.label) out.label = f.label;
  if (f.format) out.format = f.format;
  if (f.params) out.params = f.params;
  if (f.visible) out.visible = f.visible;
  return out;
}

let errors = 0;
const err = (m: string) => {
  console.error(`  ERROR ${m}`);
  errors++;
};

function buildContract(spec: (typeof CONTRACT_SPECS)[number]): void {
  const abi = loadAbi(spec.contract);
  const fns = stateChanging(abi);
  const abiKeys = new Set(fns.map(formatKey));
  const specKeys = new Set(Object.keys(spec.formats));

  // Every spec key must be a real ABI fragment, byte for byte.
  for (const k of specKeys) {
    if (!abiKeys.has(k)) {
      err(`${spec.contract}: format key not in ABI: "${k}"`);
    }
  }
  // Every state-changing function must be covered - an unlisted one is a
  // function a signer would blind-sign.
  for (const k of abiKeys) {
    if (!specKeys.has(k)) {
      err(`${spec.contract}: ABI function has no descriptor: "${k}"`);
    }
  }

  // Every parameter must be displayed or explicitly hidden.
  for (const fn of fns) {
    const key = formatKey(fn);
    const fmt = spec.formats[key];
    if (!fmt) continue;
    const paths = new Set(fmt.fields.map((f) => f.path));
    for (const inp of fn.inputs ?? []) {
      if (!paths.has(inp.name)) {
        err(`${spec.contract}.${fn.name}: parameter "${inp.name}" has no field`);
      }
    }
    for (const f of fmt.fields) {
      if (!(fn.inputs ?? []).some((i) => i.name === f.path)) {
        err(`${spec.contract}.${fn.name}: field path "${f.path}" is not a parameter`);
      }
    }
  }

  const formats: Record<string, unknown> = {};
  // Preserve ABI order so the emitted file reads in a stable order.
  for (const fn of fns) {
    const key = formatKey(fn);
    const s = spec.formats[key];
    if (!s) continue;
    formats[key] = {
      $id: s.id,
      intent: s.intent,
      fields: s.fields.map(emitField),
    };
  }

  const doc: Record<string, unknown> = {
    $schema: SCHEMA,
    $comment: spec.comment,
    includes: "./common-oku-definitions.json",
    context: {
      $id: spec.contract,
      contract: {
        deployments: [{ chainId: PLACEHOLDERS.chainId, address: PLACEHOLDERS.address }],
      },
    },
    metadata: {
      owner: PLACEHOLDERS.owner,
      contractName: spec.contract,
      info: { url: PLACEHOLDERS.url },
      ...(spec.constants ? { constants: spec.constants } : {}),
    },
    display: { formats },
  };

  const file = path.join(OUT_DIR, `calldata-${spec.contract}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  wrote ${path.relative(process.cwd(), file)} (${Object.keys(formats).length} formats)`);
}

function buildPermit(spec: (typeof PERMIT_SPECS)[number]): void {
  const doc = {
    $schema: SCHEMA,
    $comment: spec.comment,
    context: {
      $id: `${spec.contract} permit`,
      eip712: {
        domain: { name: undefined as unknown as string },
        deployments: [{ chainId: PLACEHOLDERS.chainId, address: PLACEHOLDERS.address }],
      },
    },
    metadata: {
      owner: PLACEHOLDERS.owner,
      contractName: spec.contract,
      info: { url: PLACEHOLDERS.url },
    },
    display: {
      formats: {
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)": {
          $id: "permit",
          intent: `Approve ${spec.contract} by signature`,
          fields: [
            {
              path: "value",
              label: spec.label,
              format: "tokenAmount",
              params: {
                tokenPath: "@.to",
                threshold:
                  "0x8000000000000000000000000000000000000000000000000000000000000000",
                message: "Unlimited",
              },
            },
            {
              path: "owner",
              label: "Owner",
              format: "addressName",
              params: { types: ["wallet", "eoa"] },
            },
            {
              path: "spender",
              label: "Spender",
              format: "addressName",
              params: { types: ["eoa", "contract"] },
            },
            { path: "deadline", label: "Expires", format: "date", params: { encoding: "timestamp" } },
            { path: "nonce", format: "raw", visible: "never" },
          ],
        },
      },
    },
  };

  // The EIP-712 domain `name` is the ERC-20 name passed at initialize; it is
  // filled by syncDeployments alongside the addresses.
  delete (doc.context as any).eip712.domain;

  const file = path.join(OUT_DIR, `eip712-${spec.contract}-permit.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  wrote ${path.relative(process.cwd(), file)}`);
}

/**
 * Role hashes -> displayable names, plus the shared field definitions.
 *
 * Showing the literal role CONSTANT rather than a prettified name is
 * deliberate: a cold-multisig signer works from a runbook that says "grant
 * OKU_RATE_SETTER to X", and a device showing exactly that string is directly
 * verifiable against it. A friendlier "Rate setter" would force a mental
 * mapping at precisely the wrong moment.
 *
 * Ledger truncates enum entries at 20 characters (measured with `erc7730
 * lint`), so the single over-length constant is abbreviated.
 */
const ROLE_DISPLAY_OVERRIDES: Record<string, string> = {
  OKU_ALLOWANCE_MANAGER: "OKU_ALLOWANCE_MGR", // 21 chars -> 17
};

const ROLE_NAMES = [
  "OKU_UPGRADER", "OKU_PAUSER", "OKU_UNPAUSER", "OKU_MINTER", "OKU_BURNER",
  "OKU_BLACKLISTER", "OKU_UNBLACKLISTER", "OKU_CAP_MANAGER", "OKU_ALLOWANCE_MANAGER",
  "OKU_RATE_SETTER", "OKU_GUARDIAN", "OKU_ACCRUAL_RESUMER",
  "USD_UPGRADER", "USD_PAUSER", "USD_UNPAUSER",
  "WRAPPER_UPGRADER", "WRAPPER_ADMIN",
  "SUB_UPGRADER", "SUB_PAUSER", "SUB_UNPAUSER", "REQUEST_FULFILLER",
  "SUB_FEE_MANAGER", "SUB_TREASURY_MANAGER", "SUB_SWEEPER",
];

const MAX_ENUM_ENTRY = 20;

function buildCommon(): void {
  // Lazy require so the generator still runs if ethers resolution changes.
  const { keccak256, toUtf8Bytes } = require("ethers");

  const roles: Record<string, string> = {
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "DEFAULT_ADMIN_ROLE",
  };
  for (const name of ROLE_NAMES) {
    const display = ROLE_DISPLAY_OVERRIDES[name] ?? name;
    if (display.length > MAX_ENUM_ENTRY) {
      err(`role display name "${display}" exceeds ${MAX_ENUM_ENTRY} chars`);
    }
    roles[keccak256(toUtf8Bytes(name))] = display;
  }

  const doc = {
    $schema: SCHEMA,
    $comment:
      "Shared definitions for the OkuDollar suite, included by every calldata descriptor. " +
      "Carries no `context`, so it is never applied to a transaction on its own - it exists " +
      "only to be merged. The `roles` enum turns opaque bytes32 role hashes into the exact " +
      "constant names used in the operator runbook, which is what makes a cold-multisig role " +
      "grant verifiable on a device.",
    metadata: {
      enums: {
        roles,
        wrapEnabled: { true: "Enabled", false: "Disabled" },
      },
    },
    display: {
      definitions: {
        roleName: { label: "Role", format: "enum", params: { $ref: "$.metadata.enums.roles" } },
        roleHolder: {
          label: "Account",
          format: "addressName",
          params: { types: ["wallet", "eoa", "contract"] },
        },
        newImplementation: {
          label: "New logic",
          format: "addressName",
          params: { types: ["contract"] },
        },
        upgradeInitData: { label: "Init calldata", format: "raw" },
        requestId: { label: "Request ID", format: "raw" },
      },
      formats: {},
    },
  };

  const file = path.join(OUT_DIR, "common-oku-definitions.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(
    `  wrote ${path.relative(process.cwd(), file)} (${Object.keys(roles).length} roles)`
  );
}

function main(): void {
  console.log("Building ERC-7730 descriptors from the compiled ABI...\n");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  buildCommon();
  for (const spec of CONTRACT_SPECS) buildContract(spec);
  for (const spec of PERMIT_SPECS) buildPermit(spec);

  if (errors > 0) {
    console.error(`\n${errors} spec/ABI mismatch(es). Descriptors are NOT trustworthy.`);
    process.exit(1);
  }
  console.log("\nAll descriptors match the compiled ABI.");
  console.log("Placeholders remain - run `npm run metadata:sync` after deployment.");
}

main();
