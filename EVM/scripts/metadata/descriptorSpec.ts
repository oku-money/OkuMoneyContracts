/**
 * Declarative source of truth for the ERC-7730 clear-signing descriptors.
 *
 * Why a spec + generator rather than hand-maintained JSON:
 *
 *   1. ERC-7730 format keys must reproduce the ABI fragment EXACTLY - canonical
 *      types, no space after commas, one space before each parameter name. A
 *      generator derives them from the compiled ABI, so they cannot drift.
 *   2. Field `path` values must match ABI parameter names. Same argument.
 *   3. The v2 schema is strict (`additionalProperties: false` almost
 *      everywhere), so per-function commentary has to live here, in code, not
 *      in the emitted JSON.
 *
 * The emitted JSON under metadata/erc7730/ is the committed, reviewable
 * artifact; this file is how it is maintained.
 *
 * UNITS ARE THE WHOLE POINT. OkuM is an ERC-8056 scaled-UI token, so a raw
 * amount is NOT a dollar amount, and ERC-7730 has no way to express a display
 * multiplier. Labels therefore name the token explicitly ("OkuM Amount",
 * "USDOku Amount", "USDOku Shares") so a signer cannot read a raw figure as
 * dollars. USDC keeps a bare "Amount" - its ticker is unambiguous and
 * "USDC Amount" would just be noise.
 */

export interface FieldSpec {
  path: string;
  label?: string;
  format?: string;
  params?: Record<string, unknown>;
  visible?: string;
  $ref?: string;
}

export interface FormatSpec {
  /** Short handle, not shown to users. */
  id: string;
  /** Human intent. Ledger truncates, so keep it short. */
  intent: string;
  /** Ordered display fields. MUST cover every ABI parameter. */
  fields: FieldSpec[];
  /** Authoring note - kept out of the emitted JSON (schema forbids it). */
  note?: string;
}

export interface ContractSpec {
  /** Hardhat artifact name, also the descriptor file suffix. */
  contract: string;
  /** Emitted into the top-level `$comment`. */
  comment: string;
  /** Extra `metadata.constants` this descriptor needs. */
  constants?: Record<string, string>;
  formats: Record<string, FormatSpec>;
}

// ---------------------------------------------------------------------------
// Shared field builders
// ---------------------------------------------------------------------------

const addr = (path: string, label: string, types: string[]): FieldSpec => ({
  path,
  label,
  format: "addressName",
  params: { types },
});

/** An amount of the contract being called (the token is `@.to`). */
const selfToken = (path: string, label: string, unlimited = false): FieldSpec => ({
  path,
  label,
  format: "tokenAmount",
  params: unlimited
    ? {
        tokenPath: "@.to",
        threshold: "0x8000000000000000000000000000000000000000000000000000000000000000",
        message: "Unlimited",
      }
    : { tokenPath: "@.to" },
});

/** An amount of some other token, addressed by a metadata constant. */
const constToken = (path: string, label: string, constant: string): FieldSpec => ({
  path,
  label,
  format: "tokenAmount",
  params: { token: `$.metadata.constants.${constant}` },
});

const ref = (path: string, name: string, label?: string): FieldSpec => ({
  path,
  $ref: `$.display.definitions.${name}`,
  ...(label ? { label } : {}),
});

const hidden = (path: string): FieldSpec => ({ path, format: "raw", visible: "never" });

const timestamp = (path: string, label: string): FieldSpec => ({
  path,
  label,
  format: "date",
  params: { encoding: "timestamp" },
});

/** Role grant/revoke/renounce, shared by all four proxies. */
const roleFormats = (contractLabel: string): Record<string, FormatSpec> => ({
  "grantRole(bytes32 role,address account)": {
    id: "grantRole",
    intent: `Grant role on ${contractLabel}`,
    fields: [ref("role", "roleName"), ref("account", "roleHolder")],
  },
  "revokeRole(bytes32 role,address account)": {
    id: "revokeRole",
    intent: `Revoke role on ${contractLabel}`,
    fields: [ref("role", "roleName"), ref("account", "roleHolder")],
  },
  "renounceRole(bytes32 role,address callerConfirmation)": {
    id: "renounceRole",
    intent: `Renounce role on ${contractLabel}`,
    fields: [ref("role", "roleName"), ref("callerConfirmation", "roleHolder", "Confirm self")],
  },
  "upgradeToAndCall(address newImplementation,bytes data)": {
    id: "upgradeToAndCall",
    intent: `Upgrade ${contractLabel} logic`,
    note:
      "Highest-consequence signature on this contract: replaces all logic. " +
      "`data` is arbitrary calldata executed against the new implementation, normally empty.",
    fields: [ref("newImplementation", "newImplementation"), ref("data", "upgradeInitData")],
  },
});

// ---------------------------------------------------------------------------
// OkuM
// ---------------------------------------------------------------------------

const okuM: ContractSpec = {
  contract: "OkuM",
  comment:
    "OkuM is an ERC-8056 scaled-UI token. EVERY amount here is RAW OkuM, never dollars. " +
    "A raw amount's dollar value is `amount * uiMultiplier() / 1e18` and it only RISES, so a " +
    "device showing '1000 OkuM' is showing strictly less than the app's dollar figure. Labels " +
    "read 'OkuM Amount' so a signer cannot mistake the number for dollars. Note also that a " +
    "bounded OkuM approval GROWS in dollar value over time, because it is raw-denominated. " +
    "See metadata/DISPLAY_CONVENTION.md.",
  formats: {
    "transfer(address to,uint256 amount)": {
      id: "transfer",
      intent: "Send OkuM",
      fields: [
        selfToken("amount", "OkuM Amount"),
        addr("to", "To", ["wallet", "eoa", "contract"]),
      ],
    },
    "transferFrom(address from,address to,uint256 value)": {
      id: "transferFrom",
      intent: "Send OkuM on behalf of",
      fields: [
        selfToken("value", "OkuM Amount"),
        addr("from", "From", ["wallet", "eoa", "contract"]),
        addr("to", "To", ["wallet", "eoa", "contract"]),
      ],
    },
    "approve(address spender,uint256 value)": {
      id: "approve",
      intent: "Approve OkuM",
      note: "Raw-denominated, so the dollar value of this approval rises with M_oku.",
      fields: [
        selfToken("value", "OkuM Amount", true),
        addr("spender", "Spender", ["eoa", "contract"]),
      ],
    },
    "permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)":
      {
        id: "permit",
        intent: "Approve OkuM by signature",
        fields: [
          selfToken("value", "OkuM Amount", true),
          addr("owner", "Owner", ["wallet", "eoa"]),
          addr("spender", "Spender", ["eoa", "contract"]),
          timestamp("deadline", "Expires"),
          hidden("v"),
          hidden("r"),
          hidden("s"),
        ],
      },
    "setOkuMultiplier(uint256 newMultiplier,uint256 epoch)": {
      id: "setOkuMultiplier",
      intent: "Publish OkuM mark",
      note:
        "ORACLE WRITE - instantly re-values every holder's balance and anything pricing off " +
        "uiMultiplier(). `epoch` is a bare monotonic mark counter, NOT a timestamp and NOT a " +
        "block number, despite sitting next to something that behaves like a price.",
      fields: [
        {
          path: "newMultiplier",
          label: "New mark",
          format: "unit",
          params: { base: "$/OkuM", decimals: 18 },
        },
        { path: "epoch", label: "Mark number", format: "raw" },
      ],
    },
    "haltAccrual()": { id: "haltAccrual", intent: "Halt OkuM marks", fields: [] },
    "resumeAccrual()": { id: "resumeAccrual", intent: "Resume OkuM marks", fields: [] },
    "mint(address to,uint256 amount)": {
      id: "mint",
      intent: "Mint OkuM",
      fields: [
        selfToken("amount", "OkuM Amount"),
        addr("to", "To", ["wallet", "eoa", "contract"]),
      ],
    },
    "burn(uint256 amount)": {
      id: "burn",
      intent: "Burn OkuM",
      fields: [selfToken("amount", "OkuM Amount")],
    },
    "configureMinterAllowance(address minter_,uint256 newAllowance)": {
      id: "configureMinterAllowance",
      intent: "Set OkuM minter allowance",
      note: "Absolute overwrite of the minter's remaining budget, not a delta.",
      fields: [
        selfToken("newAllowance", "OkuM Amount"),
        addr("minter_", "Minter", ["contract"]),
      ],
    },
    "setMaxSupply(uint256 newMaxSupply)": {
      id: "setMaxSupply",
      intent: "Set OkuM supply cap",
      fields: [selfToken("newMaxSupply", "OkuM Amount")],
    },
    "blacklist(address account)": {
      id: "blacklist",
      intent: "Blacklist on OkuM",
      fields: [addr("account", "Account", ["wallet", "eoa", "contract"])],
    },
    "unblacklist(address account)": {
      id: "unblacklist",
      intent: "Unblacklist on OkuM",
      fields: [addr("account", "Account", ["wallet", "eoa", "contract"])],
    },
    "pause()": { id: "pause", intent: "Pause OkuM", fields: [] },
    "unpause()": { id: "unpause", intent: "Unpause OkuM", fields: [] },
    ...roleFormats("OkuM"),
    "initialize(string name_,string symbol_,address _admin,uint256 initialMaxSupply,address _asset)":
      {
        id: "initialize",
        intent: "Initialize OkuM",
        note: "Signed once, by the deployer, through the proxy constructor.",
        fields: [
          { path: "name_", label: "Name", format: "raw" },
          { path: "symbol_", label: "Symbol", format: "raw" },
          addr("_admin", "Admin", ["eoa", "contract"]),
          { path: "initialMaxSupply", label: "OkuM Amount", format: "raw" },
          addr("_asset", "Backing asset", ["token"]),
        ],
      },
  },
};

// ---------------------------------------------------------------------------
// USDOku
// ---------------------------------------------------------------------------

const usdOku: ContractSpec = {
  contract: "USDOku",
  comment:
    "USDOku is a REBASING token: balanceOf returns DOLLARS while the internal ledger is SHARES. " +
    "transfer/transferFrom/approve/permit are all denominated in dollars, but mint and burn are " +
    "denominated in SHARES - they are labelled 'USDOku Shares' and deliberately do NOT use a " +
    "tokenAmount binding, which would be wrong by usdOkuIndex()/1e18 and drift every second. " +
    "Note also that a USDOku approval SHRINKS in share purchasing power over time - the exact " +
    "opposite drift direction to OkuM. See metadata/DISPLAY_CONVENTION.md.",
  formats: {
    "transfer(address to,uint256 amount)": {
      id: "transfer",
      intent: "Send USDOku",
      fields: [
        selfToken("amount", "USDOku Amount"),
        addr("to", "To", ["wallet", "eoa", "contract"]),
      ],
    },
    "transferFrom(address from,address to,uint256 amount)": {
      id: "transferFrom",
      intent: "Send USDOku on behalf of",
      fields: [
        selfToken("amount", "USDOku Amount"),
        addr("from", "From", ["wallet", "eoa", "contract"]),
        addr("to", "To", ["wallet", "eoa", "contract"]),
      ],
    },
    "approve(address spender,uint256 value)": {
      id: "approve",
      intent: "Approve USDOku",
      note: "Dollar-denominated, so this approval's SHARE purchasing power falls as M_usd rises.",
      fields: [
        selfToken("value", "USDOku Amount", true),
        addr("spender", "Spender", ["eoa", "contract"]),
      ],
    },
    "permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)":
      {
        id: "permit",
        intent: "Approve USDOku by signature",
        fields: [
          selfToken("value", "USDOku Amount", true),
          addr("owner", "Owner", ["wallet", "eoa"]),
          addr("spender", "Spender", ["eoa", "contract"]),
          timestamp("deadline", "Expires"),
          hidden("v"),
          hidden("r"),
          hidden("s"),
        ],
      },
    "mint(address to,uint256 shares)": {
      id: "mint",
      intent: "Mint USDOku shares",
      note: "SHARES, not dollars. A tokenAmount binding here would be wrong and drift.",
      fields: [
        { path: "shares", label: "USDOku Shares", format: "unit", params: { base: "shares", decimals: 18 } },
        addr("to", "To", ["wallet", "eoa", "contract"]),
      ],
    },
    "burn(address from,uint256 shares)": {
      id: "burn",
      intent: "Burn USDOku shares",
      note: "SHARES, not dollars. Debits `from` directly with no transfer step.",
      fields: [
        { path: "shares", label: "USDOku Shares", format: "unit", params: { base: "shares", decimals: 18 } },
        addr("from", "From", ["wallet", "eoa", "contract"]),
      ],
    },
    "setUsdOkuRate(uint256 newRate,uint256 endTimestamp)": {
      id: "setUsdOkuRate",
      intent: "Set USDOku yield rate",
      note:
        "`newRate` is an 18dp PER-SECOND compounding rate, not an APR and not bps: " +
        "1000000003170979198 is roughly 10% nominal. ERC-7730 has no arithmetic, so the device " +
        "cannot show the APR - the operator runbook must require verifying it off-device. " +
        "The rate must already be pre-funded (MAX_SOLVENCY_GAP_BPS is zero).",
      fields: [
        { path: "newRate", label: "Yield rate", format: "unit", params: { base: "/s", decimals: 18 } },
        timestamp("endTimestamp", "Rate ends"),
      ],
    },
    "haltUsdOkuAccrual()": { id: "haltUsdOkuAccrual", intent: "Halt USDOku accrual", fields: [] },
    "resumeUsdOkuAccrual()": {
      id: "resumeUsdOkuAccrual",
      intent: "Resume USDOku accrual",
      fields: [],
    },
    "setWrapper(address newWrapper)": {
      id: "setWrapper",
      intent: "Set USDOku wrapper",
      note: "One-time wiring of the solvency source used by setUsdOkuRate.",
      fields: [addr("newWrapper", "Wrapper", ["contract"])],
    },
    "blacklist(address account)": {
      id: "blacklist",
      intent: "Blacklist on USDOku",
      fields: [addr("account", "Account", ["wallet", "eoa", "contract"])],
    },
    "unblacklist(address account)": {
      id: "unblacklist",
      intent: "Unblacklist on USDOku",
      fields: [addr("account", "Account", ["wallet", "eoa", "contract"])],
    },
    "pause()": { id: "pause", intent: "Pause USDOku", fields: [] },
    "unpause()": { id: "unpause", intent: "Unpause USDOku", fields: [] },
    ...roleFormats("USDOku"),
    "initialize(string name_,string symbol_,address _admin)": {
      id: "initialize",
      intent: "Initialize USDOku",
      fields: [
        { path: "name_", label: "Name", format: "raw" },
        { path: "symbol_", label: "Symbol", format: "raw" },
        addr("_admin", "Admin", ["eoa", "contract"]),
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// USDOkuWrapper
// ---------------------------------------------------------------------------

const wrapper: ContractSpec = {
  contract: "USDOkuWrapper",
  comment:
    "The wrapper moves between two 18-decimal tokens, so a decimals heuristic cannot tell them " +
    "apart - `wrap` takes RAW OkuM in and returns USDOku DOLLARS, and the two amounts sit in the " +
    "same call. Both directions price at M_oku (the realized index), never at M_usd. Note `unwrap` " +
    "has no slippage parameter by design, because M_oku is monotone. " +
    "See metadata/DISPLAY_CONVENTION.md.",
  constants: {
    okuMAddress: "0x0000000000000000000000000000000000000000",
    usdOkuAddress: "0x0000000000000000000000000000000000000000",
  },
  formats: {
    "wrap(uint256 okuMAmount,address receiver,uint256 minUsdOkuOut)": {
      id: "wrap",
      intent: "Wrap OkuM into USDOku",
      fields: [
        constToken("okuMAmount", "OkuM Amount", "okuMAddress"),
        constToken("minUsdOkuOut", "Min USDOku Amount", "usdOkuAddress"),
        addr("receiver", "Receiver", ["wallet", "eoa", "contract"]),
      ],
    },
    "unwrap(uint256 usdOkuAmount,address receiver)": {
      id: "unwrap",
      intent: "Unwrap USDOku into OkuM",
      note: "No minOut by design - priced at the monotone M_oku.",
      fields: [
        constToken("usdOkuAmount", "USDOku Amount", "usdOkuAddress"),
        addr("receiver", "Receiver", ["wallet", "eoa", "contract"]),
      ],
    },
    "withdrawSurplus(uint256 okuMAmount,address to)": {
      id: "withdrawSurplus",
      intent: "Withdraw wrapper surplus",
      note:
        "The only path other than unwrap by which OkuM leaves the wrapper. Checked against the " +
        "liability PROJECTED to rateEnd, so it cannot strand a redemption.",
      fields: [
        constToken("okuMAmount", "OkuM Amount", "okuMAddress"),
        addr("to", "To", ["eoa", "contract"]),
      ],
    },
    "setWrapEnabled(bool enabled)": {
      id: "setWrapEnabled",
      intent: "Toggle USDOku wrapping",
      note: "Sunset step 1. Disables wrap only - unwrap can never be disabled.",
      fields: [
        {
          path: "enabled",
          label: "Wrapping",
          format: "enum",
          params: { $ref: "$.metadata.enums.wrapEnabled" },
        },
      ],
    },
    ...roleFormats("wrapper"),
    "initialize(address _okuM,address _usdOku,address _admin)": {
      id: "initialize",
      intent: "Initialize wrapper",
      fields: [
        addr("_okuM", "OkuM", ["token"]),
        addr("_usdOku", "USDOku", ["token"]),
        addr("_admin", "Admin", ["eoa", "contract"]),
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// SubscriptionModule
// ---------------------------------------------------------------------------

const subscription: ContractSpec = {
  contract: "SubscriptionModule",
  comment:
    "Requests MIX DECIMALS within a single call: requestSubscription takes 6dp USDC then 18dp raw " +
    "OkuM, and requestRedemption reverses that order. Pricing happens at FULFILMENT against the " +
    "live M_oku, never at the request block, so the amount signed here is an input and a floor - " +
    "not a quote. `sweepToken` amounts take whatever decimals the swept token has, which is why " +
    "that field binds tokenPath to its sibling parameter. See metadata/DISPLAY_CONVENTION.md.",
  constants: {
    okuMAddress: "0x0000000000000000000000000000000000000000",
    usdcAddress: "0x0000000000000000000000000000000000000000",
  },
  formats: {
    "requestSubscription(uint256 usdcAmount,uint256 minOkuMOut)": {
      id: "requestSubscription",
      intent: "Request OkuM subscription",
      note: "Escrows USDC. Priced at fulfilment, so minOkuMOut is the signer's only protection.",
      fields: [
        constToken("usdcAmount", "Amount", "usdcAddress"),
        constToken("minOkuMOut", "Min OkuM Amount", "okuMAddress"),
      ],
    },
    "requestRedemption(uint256 okuMAmount,uint256 minUsdcOut)": {
      id: "requestRedemption",
      intent: "Request OkuM redemption",
      note: "Escrows raw OkuM. Priced at fulfilment.",
      fields: [
        constToken("okuMAmount", "OkuM Amount", "okuMAddress"),
        constToken("minUsdcOut", "Min Amount", "usdcAddress"),
      ],
    },
    "cancelRequest(uint256 requestId)": {
      id: "cancelRequest",
      intent: "Cancel request",
      fields: [ref("requestId", "requestId")],
    },
    "fulfillSubscription(uint256 requestId)": {
      id: "fulfillSubscription",
      intent: "Fulfil subscription",
      fields: [ref("requestId", "requestId")],
    },
    "fulfillRedemption(uint256 requestId)": {
      id: "fulfillRedemption",
      intent: "Fulfil redemption",
      fields: [ref("requestId", "requestId")],
    },
    "rejectRequest(uint256 requestId,bytes32 reasonCode)": {
      id: "rejectRequest",
      intent: "Reject request",
      note: "reasonCode is an opaque bytes32 resolved off-chain; no compliance detail on-chain.",
      fields: [ref("requestId", "requestId"), { path: "reasonCode", label: "Reason", format: "raw" }],
    },
    "setFees(uint256 newTin,uint256 newTout)": {
      id: "setFees",
      intent: "Set conversion fees",
      fields: [
        { path: "newTin", label: "Subscribe fee", format: "unit", params: { base: "bps" } },
        { path: "newTout", label: "Redeem fee", format: "unit", params: { base: "bps" } },
      ],
    },
    "setTreasury(address newTreasury)": {
      id: "setTreasury",
      intent: "Set treasury",
      note: "Does not migrate the USDC allowance; the new treasury must approve the module.",
      fields: [addr("newTreasury", "Treasury", ["eoa", "contract"])],
    },
    "sweepToken(address token,address to,uint256 amount)": {
      id: "sweepToken",
      intent: "Sweep stray tokens",
      note:
        "`amount` decimals are polymorphic. Binding tokenPath to the sibling `token` parameter " +
        "is what makes this displayable at all.",
      fields: [
        { path: "amount", label: "Amount", format: "tokenAmount", params: { tokenPath: "token" } },
        addr("token", "Token", ["token"]),
        addr("to", "To", ["eoa", "contract"]),
      ],
    },
    "pause()": { id: "pause", intent: "Pause requests", fields: [] },
    "unpause()": { id: "unpause", intent: "Unpause requests", fields: [] },
    ...roleFormats("module"),
    "initialize(address _okuM,address _usdc,address _admin,address _treasury)": {
      id: "initialize",
      intent: "Initialize module",
      fields: [
        addr("_okuM", "OkuM", ["token"]),
        addr("_usdc", "USDC", ["token"]),
        addr("_admin", "Admin", ["eoa", "contract"]),
        addr("_treasury", "Treasury", ["eoa", "contract"]),
      ],
    },
  },
};

export const CONTRACT_SPECS: ContractSpec[] = [okuM, usdOku, wrapper, subscription];

/**
 * ERC-2612 permit is signed OFF-CHAIN, so it never appears as calldata on the
 * signer's device and needs its own EIP-712 descriptor per token.
 *
 * Two files, not one: the struct is identical but `value` means RAW OkuM on one
 * and USDOku DOLLARS on the other, so they are not interchangeable.
 */
export const PERMIT_SPECS = [
  {
    contract: "OkuM",
    label: "OkuM Amount",
    comment:
      "ERC-2612 permit for OkuM. `value` is RAW OkuM, not dollars, and its dollar value rises " +
      "with M_oku - so this approval authorises strictly more value tomorrow than today.",
  },
  {
    contract: "USDOku",
    label: "USDOku Amount",
    comment:
      "ERC-2612 permit for USDOku. `value` is USDOku DOLLARS, not shares. Its share purchasing " +
      "power falls as M_usd rises - the opposite drift direction to OkuM's permit.",
  },
] as const;

/** Values the generator emits that MUST be replaced before registry submission. */
export const PLACEHOLDERS = {
  owner: "TODO_SET_OWNER",
  url: "https://example.invalid/TODO",
  address: "0x0000000000000000000000000000000000000000",
  chainId: 0,
};
