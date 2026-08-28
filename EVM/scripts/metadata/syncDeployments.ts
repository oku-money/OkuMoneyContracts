/**
 * Bind the ERC-7730 descriptors to real deployed addresses.
 *
 * The descriptors are authored against the ABI ahead of deployment and carry
 * placeholders. This fills them in from the address book once a network is
 * live, and emits one descriptor per chain.
 *
 * ONE FILE PER CHAIN, deliberately. Our four proxies are CREATE2-deterministic
 * so they share an address across chains, but USDC does not - and
 * SubscriptionModule amounts must bind to the local USDC to display at all.
 * The alternative (`metadata.maps` keyed by `@.chainId`) is documented in the
 * ERC text but is NOT wired into the v2 schema's metadata properties, so it
 * would validate only by accident and a stricter registry validator could
 * reject it. Per-chain files are unambiguous.
 *
 * Usage:
 *   NETWORK=base OWNER="Oku Money" OWNER_URL="https://oku.money" \
 *     npm run metadata:sync
 *
 * Then re-run `npm run metadata:fixtures` and
 * `npm run metadata:validate -- --strict`.
 */

import fs from "fs";
import path from "path";
import { getAddress } from "ethers";
import { loadAddress } from "../utils/addressBook";
import { getChainMetadata, getChainAddresses } from "../config/chains";
import { PLACEHOLDERS } from "./descriptorSpec";

const META_DIR = path.resolve(__dirname, "../../metadata/erc7730");
const OUT_DIR = path.join(META_DIR, "deployed");

/** Ledger truncates the owner URL at 26 characters (measured with erc7730 lint). */
const MAX_URL = 26;

const CALLDATA: Array<[string, string]> = [
  ["calldata-OkuM.json", "OkuM"],
  ["calldata-USDOku.json", "USDOku"],
  ["calldata-USDOkuWrapper.json", "USDOkuWrapper"],
  ["calldata-SubscriptionModule.json", "SubscriptionModule"],
];

const EIP712: Array<[string, string, string]> = [
  // file, proxy to bind, EIP-712 domain name (the ERC-20 name at initialize)
  ["eip712-OkuM-permit.json", "OkuM", "Oku Money"],
  ["eip712-USDOku-permit.json", "USDOku", "Oku Dollar"],
];

function main(): void {
  const network = process.env.NETWORK;
  const owner = process.env.OWNER;
  const url = process.env.OWNER_URL;

  if (!network) throw new Error("Set NETWORK=<chain> (a key in scripts/config/chains.ts)");
  if (!owner) throw new Error('Set OWNER="<official entity name>"');
  if (!url) throw new Error('Set OWNER_URL="https://..."');
  if (url.length > MAX_URL) {
    console.warn(
      `WARNING: OWNER_URL is ${url.length} chars; Ledger truncates at ${MAX_URL}. ` +
        "Consider a shorter canonical domain."
    );
  }

  const { chainId } = getChainMetadata(network);
  const bookKey = network;

  const resolved: Record<string, string> = {};
  for (const [, contract] of CALLDATA) {
    const addr = loadAddress(bookKey, contract);
    if (!addr) {
      throw new Error(
        `${contract} is not in the address book for "${bookKey}". Deploy first.`
      );
    }
    resolved[contract] = getAddress(addr);
  }

  // USDC: the mock on testnets, the real token on mainnets.
  const mock = loadAddress(bookKey, "MockUSDC");
  const usdc = getAddress(mock ?? getChainAddresses(network).tokens.usdc);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Binding descriptors to ${network} (chainId ${chainId})\n`);
  console.log(`  owner: ${owner}`);
  console.log(`  url:   ${url}`);
  console.log(`  USDC:  ${usdc}${mock ? "  (MockUSDC)" : ""}\n`);

  for (const [file, contract] of CALLDATA) {
    const doc = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));

    doc.context.contract.deployments = [{ chainId, address: resolved[contract] }];
    doc.metadata.owner = owner;
    doc.metadata.info.url = url;

    if (doc.metadata.constants) {
      const c = doc.metadata.constants as Record<string, string>;
      if ("okuMAddress" in c) c.okuMAddress = resolved.OkuM;
      if ("usdOkuAddress" in c) c.usdOkuAddress = resolved.USDOku;
      if ("usdcAddress" in c) c.usdcAddress = usdc;
    }

    // `includes` is resolved relative to the descriptor, so the shared file
    // must sit alongside the per-chain output.
    const out = path.join(OUT_DIR, file.replace(/\.json$/, `-${network}.json`));
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
    console.log(`  wrote ${path.relative(process.cwd(), out)}`);
  }

  for (const [file, contract, domainName] of EIP712) {
    const doc = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));
    doc.context.eip712.deployments = [{ chainId, address: resolved[contract] }];
    // Bind the domain name too: it is the ERC-20 name passed at initialize, and
    // pinning it narrows what this descriptor can be applied to.
    doc.context.eip712.domain = { name: domainName };
    doc.metadata.owner = owner;
    doc.metadata.info.url = url;

    const out = path.join(OUT_DIR, file.replace(/\.json$/, `-${network}.json`));
    fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
    console.log(`  wrote ${path.relative(process.cwd(), out)}`);
  }

  // The shared definitions must be copied next to the per-chain descriptors.
  fs.copyFileSync(
    path.join(META_DIR, "common-oku-definitions.json"),
    path.join(OUT_DIR, "common-oku-definitions.json")
  );
  console.log(`  wrote ${path.relative(process.cwd(), path.join(OUT_DIR, "common-oku-definitions.json"))}`);

  const stillPlaceholder = Object.values(resolved).some((a) => a === PLACEHOLDERS.address);
  if (stillPlaceholder) {
    console.error("\nERROR: a resolved address is still the zero address.");
    process.exit(1);
  }

  console.log(
    "\nNext:\n" +
      "  1. npm run metadata:fixtures     # regenerate against real addresses\n" +
      "  2. npm run metadata:validate -- --strict\n" +
      "  3. npx uvx --python 3.12 erc7730 lint metadata/erc7730/deployed/*.json\n" +
      "  4. copy metadata/erc7730/deployed/* into registry/<entity>/ and open the PR"
  );
}

main();
