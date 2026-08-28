/**
 * Generate ERC-7730 reference test fixtures (`testsv2/*.tests.json`).
 *
 * The registry REQUIRES a fixture per descriptor and its CI runs them: wallet
 * vendors use these to check their formatter against what we say the descriptor
 * should render. A descriptor without fixtures is not mergeable.
 *
 * Each case is an UNSIGNED raw transaction (the registry explicitly wants v/r/s
 * left off, so fixtures stay reproducible) plus the exact expected rendering.
 *
 * The `dataProvider` block supplies token metadata and address names inline so
 * runners need no network access - important because our tokens will not be in
 * any public token list.
 *
 * Cases deliberately cover the edges the registry asks for: zero, unlimited
 * approval at the threshold, and the uint96 request ceiling that is a real
 * revert boundary in SubscriptionModule.
 *
 * Usage:
 *   npm run metadata:fixtures
 */

import fs from "fs";
import path from "path";
import { Interface, Transaction, parseUnits } from "ethers";

const META_DIR = path.resolve(__dirname, "../../metadata/erc7730");
const TESTS_DIR = path.join(META_DIR, "testsv2");
const FORGE_OUT = path.resolve(__dirname, "../../out");

/**
 * Deterministic stand-in counterparties. Contract addresses come from the
 * descriptors themselves, so these fixtures track `metadata:sync` automatically.
 */
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const TREASURY = "0x3333333333333333333333333333333333333333";

const UNLIMITED = (1n << 255n) + 1n; // strictly above the descriptor threshold

interface Case {
  description: string;
  fn: string;
  args: unknown[];
  intent: string;
  fields: Array<{ label: string; value: string }>;
}

function loadIface(contract: string): Interface {
  const p = path.join(FORGE_OUT, `${contract}.sol`, `${contract}.json`);
  return new Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
}

/** Unsigned EIP-1559 transaction, hex-encoded. */
function rawTx(to: string, data: string, chainId: number): string {
  return Transaction.from({
    to,
    data,
    chainId,
    nonce: 0,
    gasLimit: 200_000n,
    maxFeePerGas: parseUnits("20", "gwei"),
    maxPriorityFeePerGas: parseUnits("1", "gwei"),
    value: 0n,
    type: 2,
  }).unsignedSerialized;
}

function descriptorAddress(file: string): { address: string; chainId: number } {
  const doc = JSON.parse(fs.readFileSync(path.join(META_DIR, file), "utf8"));
  const d = doc.context?.contract?.deployments?.[0] ?? doc.context?.eip712?.deployments?.[0];
  return { address: d.address, chainId: d.chainId };
}

function build(
  descriptorFile: string,
  contract: string,
  owner: string,
  cases: Case[],
  extraTokens: Record<string, { symbol: string; decimals: number; name: string }> = {}
): void {
  const { address, chainId } = descriptorAddress(descriptorFile);
  const iface = loadIface(contract);

  const tests = cases.map((c) => ({
    description: c.description,
    rawTx: rawTx(address, iface.encodeFunctionData(c.fn, c.args), chainId),
    expected: { intent: c.intent, owner, fields: c.fields },
  }));

  const doc = {
    $schema: "../../../specs/erc7730-tests-v2.schema.json",
    descriptor: `../${descriptorFile}`,
    dataProvider: {
      tokens: extraTokens,
      addressNames: {
        [ALICE.toLowerCase()]: "Alice",
        [BOB.toLowerCase()]: "Bob",
        [TREASURY.toLowerCase()]: "Treasury",
      },
    },
    tests,
  };

  const out = path.join(TESTS_DIR, descriptorFile.replace(/\.json$/, ".tests.json"));
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  wrote ${path.relative(process.cwd(), out)} (${tests.length} cases)`);
}

function main(): void {
  fs.mkdirSync(TESTS_DIR, { recursive: true });
  console.log("Generating ERC-7730 reference test fixtures...\n");

  const okuM = descriptorAddress("calldata-OkuM.json").address;
  const usdOku = descriptorAddress("calldata-USDOku.json").address;

  const okuMToken = { symbol: "OkuM", decimals: 18, name: "Oku Money" };
  const usdOkuToken = { symbol: "USDOku", decimals: 18, name: "Oku Dollar" };

  // ---- OkuM ---------------------------------------------------------------
  build(
    "calldata-OkuM.json",
    "OkuM",
    "TODO_SET_OWNER",
    [
      {
        description: "Send 1000 raw OkuM to Bob",
        fn: "transfer",
        args: [BOB, parseUnits("1000", 18)],
        intent: "Send OkuM",
        // 1000 OkuM RAW. At a multiplier above 1.0 this is worth MORE than
        // $1000 - the device cannot know that, which is the whole reason the
        // label names the unit.
        fields: [
          { label: "OkuM Amount", value: "1000 OkuM" },
          { label: "To", value: "Bob" },
        ],
      },
      {
        description: "Approve unlimited OkuM for Bob",
        fn: "approve",
        args: [BOB, UNLIMITED],
        intent: "Approve OkuM",
        fields: [
          { label: "OkuM Amount", value: "Unlimited OkuM" },
          { label: "Spender", value: "Bob" },
        ],
      },
      {
        description: "Approve zero OkuM (revoke)",
        fn: "approve",
        args: [BOB, 0n],
        intent: "Approve OkuM",
        fields: [
          { label: "OkuM Amount", value: "0 OkuM" },
          { label: "Spender", value: "Bob" },
        ],
      },
      {
        description: "Publish a +1% OkuM mark at epoch 7",
        fn: "setOkuMultiplier",
        args: [parseUnits("1.01", 18), 7n],
        intent: "Publish OkuM mark",
        fields: [
          { label: "New mark", value: "1.01 $/OkuM" },
          { label: "Mark number", value: "7" },
        ],
      },
      {
        description: "Grant OKU_RATE_SETTER to Alice",
        fn: "grantRole",
        args: [
          "0x4e62c3355f346fbd631866571a6968519690d3a074ec8a6f17ad30d29634aa34",
          ALICE,
        ],
        intent: "Grant role on OkuM",
        fields: [
          { label: "Role", value: "OKU_RATE_SETTER" },
          { label: "Account", value: "Alice" },
        ],
      },
    ],
    { [okuM.toLowerCase()]: okuMToken }
  );

  // ---- USDOku -------------------------------------------------------------
  build(
    "calldata-USDOku.json",
    "USDOku",
    "TODO_SET_OWNER",
    [
      {
        description: "Send 500 USDOku dollars to Bob",
        fn: "transfer",
        args: [BOB, parseUnits("500", 18)],
        intent: "Send USDOku",
        fields: [
          { label: "USDOku Amount", value: "500 USDOku" },
          { label: "To", value: "Bob" },
        ],
      },
      {
        description: "Mint 500 USDOku SHARES to Bob (shares, not dollars)",
        fn: "mint",
        args: [BOB, parseUnits("500", 18)],
        intent: "Mint USDOku shares",
        // Rendered via `unit`, NOT tokenAmount: a token binding here would be
        // wrong by usdOkuIndex()/1e18 and would drift every second.
        fields: [
          { label: "USDOku Shares", value: "500 shares" },
          { label: "To", value: "Bob" },
        ],
      },
      {
        description: "Set USDOku yield rate to ~10% APR for 30 days",
        fn: "setUsdOkuRate",
        args: [1000000003170979198n, 1735689600n],
        intent: "Set USDOku yield rate",
        // The device CANNOT show the APR - ERC-7730 has no arithmetic. The
        // operator must verify 10% off-device. See DISPLAY_CONVENTION.md.
        fields: [
          { label: "Yield rate", value: "1.000000003170979198 /s" },
          { label: "Rate ends", value: "2025-01-01T00:00:00Z" },
        ],
      },
    ],
    { [usdOku.toLowerCase()]: usdOkuToken }
  );

  // ---- Wrapper ------------------------------------------------------------
  build(
    "calldata-USDOkuWrapper.json",
    "USDOkuWrapper",
    "TODO_SET_OWNER",
    [
      {
        description: "Wrap 1000 raw OkuM into USDOku, min 1000 USDOku out",
        fn: "wrap",
        args: [parseUnits("1000", 18), ALICE, parseUnits("1000", 18)],
        intent: "Wrap OkuM into USDOku",
        // Two different tokens, both 18dp, in one call - a decimals heuristic
        // would not catch a mis-binding, which is why both are labelled.
        fields: [
          { label: "OkuM Amount", value: "1000 OkuM" },
          { label: "Min USDOku Amount", value: "1000 USDOku" },
          { label: "Receiver", value: "Alice" },
        ],
      },
      {
        description: "Unwrap 250 USDOku back to OkuM",
        fn: "unwrap",
        args: [parseUnits("250", 18), ALICE],
        intent: "Unwrap USDOku into OkuM",
        fields: [
          { label: "USDOku Amount", value: "250 USDOku" },
          { label: "Receiver", value: "Alice" },
        ],
      },
      {
        description: "Disable wrapping (sunset step 1)",
        fn: "setWrapEnabled",
        args: [false],
        intent: "Toggle USDOku wrapping",
        fields: [{ label: "Wrapping", value: "Disabled" }],
      },
    ],
    { [okuM.toLowerCase()]: okuMToken, [usdOku.toLowerCase()]: usdOkuToken }
  );

  // ---- SubscriptionModule -------------------------------------------------
  const usdc = JSON.parse(
    fs.readFileSync(path.join(META_DIR, "calldata-SubscriptionModule.json"), "utf8")
  ).metadata.constants.usdcAddress as string;

  build(
    "calldata-SubscriptionModule.json",
    "SubscriptionModule",
    "TODO_SET_OWNER",
    [
      {
        description: "Request subscription of 1000 USDC, min 990 OkuM out",
        fn: "requestSubscription",
        args: [parseUnits("1000", 6), parseUnits("990", 18)],
        intent: "Request OkuM subscription",
        // Mixed decimals in one call: 6dp USDC then 18dp raw OkuM.
        fields: [
          { label: "Amount", value: "1000 USDC" },
          { label: "Min OkuM Amount", value: "990 OkuM" },
        ],
      },
      {
        description: "Request redemption of 1000 raw OkuM, min 990 USDC out",
        fn: "requestRedemption",
        args: [parseUnits("1000", 18), parseUnits("990", 6)],
        intent: "Request OkuM redemption",
        // Same two units, REVERSED order relative to requestSubscription.
        fields: [
          { label: "OkuM Amount", value: "1000 OkuM" },
          { label: "Min Amount", value: "990 USDC" },
        ],
      },
      {
        description: "Request redemption at the uint96 ceiling",
        fn: "requestRedemption",
        args: [(1n << 96n) - 1n, 0n],
        intent: "Request OkuM redemption",
        // The largest amount the packed Request struct can hold; one wei more
        // reverts AmountExceedsRequestField.
        fields: [
          { label: "OkuM Amount", value: "79228162514.264337593543950335 OkuM" },
          { label: "Min Amount", value: "0 USDC" },
        ],
      },
      {
        description: "Cancel request 1",
        fn: "cancelRequest",
        args: [1n],
        intent: "Cancel request",
        fields: [{ label: "Request ID", value: "1" }],
      },
      {
        description: "Set fees to 10 bps in, 10 bps out",
        fn: "setFees",
        args: [10n, 10n],
        intent: "Set conversion fees",
        fields: [
          { label: "Subscribe fee", value: "10 bps" },
          { label: "Redeem fee", value: "10 bps" },
        ],
      },
    ],
    {
      [okuM.toLowerCase()]: okuMToken,
      [usdc.toLowerCase()]: { symbol: "USDC", decimals: 6, name: "USD Coin" },
    }
  );

  console.log(
    "\nFixtures generated. Expected values assume the placeholder token metadata\n" +
      "in each dataProvider block; re-run after `metadata:sync` to bind real addresses."
  );
}

main();
