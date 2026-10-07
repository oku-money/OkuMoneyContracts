/**
 * Storage-layout baselines: the layout of the implementation currently behind
 * each proxy, recorded when that implementation was installed (by the deploy
 * script, and by every upgrade).
 *
 * WHY THIS EXISTS ALONGSIDE `.openzeppelin/<chain>.json`
 * The OpenZeppelin manifest is the plugin's own record, and the upgrade script
 * still requires it (`prepareUpgrade` validates against it). But the manifest
 * can be wrong without anyone noticing: `forceImport` attributes whatever
 * factory it is given to the on-chain implementation, so importing the
 * *proposed* source records the new layout as the old one and the storage
 * check then compares the new layout with itself (audit U-01). The baseline is
 * an independent record, bound to the implementation's runtime code hash, so
 * an upgrade validates against what is actually deployed, not against what
 * some machine's manifest claims.
 *
 * Files (same live/fork split as the address book):
 *   scripts/config/upgradeBaselines.json         TRACKED   — live chains
 *   scripts/config/upgradeBaselines.local.json   GITIGNORED — `fork:*` keys
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
import type { ContractFactory } from "ethers";
import {
  getStorageLayout,
  getStorageUpgradeReport,
  getVersion,
  withValidationDefaults,
  StorageLayout,
} from "@openzeppelin/upgrades-core";
import { readValidations } from "@openzeppelin/hardhat-upgrades/dist/utils/validations";
import { isForkKey } from "./addressBook";

const BASELINE_PATH = path.join(__dirname, "../config/upgradeBaselines.json");
const LOCAL_BASELINE_PATH = path.join(__dirname, "../config/upgradeBaselines.local.json");

export interface LayoutBaseline {
  contract: string;
  /** Hardhat factory the implementation was compiled from (e.g. "LitePSM"). */
  factory: string;
  proxy: string;
  impl: string;
  /** keccak256 of the implementation's runtime code at record time. */
  implCodeHash: string;
  /** OZ storage layout (including ERC-7201 namespaces) of `factory`. */
  layout: StorageLayout;
  recordedAt: string;
  recordedBy: "deploy" | "upgrade";
  gitCommit?: string;
}

type BaselineFile = { [bookKey: string]: { [contract: string]: LayoutBaseline } };

function readFile(p: string): BaselineFile {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeFile(p: string, data: BaselineFile): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function fileFor(bookKey: string): string {
  return isForkKey(bookKey) ? LOCAL_BASELINE_PATH : BASELINE_PATH;
}

export function loadBaseline(bookKey: string, contract: string): LayoutBaseline | undefined {
  return readFile(fileFor(bookKey))[bookKey]?.[contract];
}

export function gitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** OZ storage layout of a locally compiled factory. */
export async function layoutOf(factory: ContractFactory): Promise<StorageLayout> {
  const validations = await readValidations(hre);
  return getStorageLayout(validations, getVersion(factory.bytecode));
}

export async function runtimeCodeHash(address: string, blockTag?: number): Promise<string> {
  const code = await ethers.provider.getCode(address, blockTag);
  if (!code || code === "0x") throw new Error(`no code at ${address}`);
  return ethers.keccak256(code);
}

/**
 * Record `factoryName`'s layout as the baseline for `contract` on `bookKey`.
 * `impl` must already be the implementation behind `proxy` and must have been
 * built from `factoryName` in this tree — callers guarantee that (the deploy
 * script just deployed it; the upgrade script just installed it).
 */
export async function recordBaseline(args: {
  bookKey: string;
  contract: string;
  factoryName: string;
  factory: ContractFactory;
  proxy: string;
  impl: string;
  recordedBy: LayoutBaseline["recordedBy"];
}): Promise<LayoutBaseline> {
  const slotImpl = await upgrades.erc1967.getImplementationAddress(args.proxy);
  if (slotImpl.toLowerCase() !== args.impl.toLowerCase()) {
    throw new Error(
      `refusing to record a baseline for ${args.contract}: proxy ${args.proxy} points at ` +
        `${slotImpl}, not ${args.impl}`
    );
  }
  const baseline: LayoutBaseline = {
    contract: args.contract,
    factory: args.factoryName,
    proxy: args.proxy,
    impl: args.impl,
    implCodeHash: await runtimeCodeHash(args.impl),
    layout: await layoutOf(args.factory),
    recordedAt: new Date().toISOString(),
    recordedBy: args.recordedBy,
    gitCommit: gitCommit(),
  };
  const p = fileFor(args.bookKey);
  const data = readFile(p);
  data[args.bookKey] = { ...(data[args.bookKey] ?? {}), [args.contract]: baseline };
  writeFile(p, data);
  return baseline;
}

/**
 * Fail closed unless `newFactory` is storage-compatible with the baseline AND
 * the baseline describes the implementation actually behind the proxy.
 */
export async function assertCompatibleWithBaseline(args: {
  bookKey: string;
  contract: string;
  proxy: string;
  oldImpl: string;
  newFactory: ContractFactory;
}): Promise<LayoutBaseline> {
  const baseline = loadBaseline(args.bookKey, args.contract);
  if (!baseline) {
    throw new Error(
      `No storage-layout baseline for ${args.contract} on "${args.bookKey}" ` +
        `(${path.relative(process.cwd(), fileFor(args.bookKey))}). The deploy script and every ` +
        `upgrade record one; without it there is no trustworthy record of the deployed ` +
        `layout. Restore it from git rather than regenerating it from current source.`
    );
  }
  if (baseline.proxy.toLowerCase() !== args.proxy.toLowerCase()) {
    throw new Error(
      `Baseline for ${args.contract} describes proxy ${baseline.proxy}, not ${args.proxy}`
    );
  }
  if (baseline.impl.toLowerCase() !== args.oldImpl.toLowerCase()) {
    throw new Error(
      `Baseline for ${args.contract} describes implementation ${baseline.impl}, but the proxy ` +
        `points at ${args.oldImpl}. Something upgraded it outside this script (or a ` +
        `multisig upgrade was never verified with MODE=verify).`
    );
  }
  const onChainHash = await runtimeCodeHash(args.oldImpl);
  if (onChainHash !== baseline.implCodeHash) {
    throw new Error(
      `Implementation ${args.oldImpl} runtime code hash ${onChainHash} does not match the ` +
        `baseline (${baseline.implCodeHash})`
    );
  }
  const updated = await layoutOf(args.newFactory);
  const report = getStorageUpgradeReport(baseline.layout, updated, withValidationDefaults({}));
  if (!report.ok) {
    throw new Error(
      `${args.contract}: new implementation is storage-INCOMPATIBLE with the deployed ` +
        `layout (baseline recorded ${baseline.recordedAt} by ${baseline.recordedBy}):\n` +
        report.explain()
    );
  }
  return baseline;
}
