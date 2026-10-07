/**
 * Shared CLI boilerplate for operator scripts: `parseArg`, `DRY_RUN`,
 * `--yes-mainnet`, and the `main().then/catch` exit wrapper. Defined once so
 * operator scripts can also be imported and called as functions (not just
 * spawned as processes) — required for the operator drill
 * (`test/hardhat/drill/operatorDrill.test.ts`) to exercise real script logic
 * in-process against a local chain.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — pass options as ENV VARS, not `--flags`, under `hardhat run`.
 * ---------------------------------------------------------------------------
 * `npx hardhat run <script>` parses argv ITSELF and rejects any parameter it
 * doesn't recognise, before the script ever executes:
 *
 *   npx hardhat run scripts/operator/psmOps.ts --action=mintOkuM
 *     -> Error HH310: Invalid param --action=mintOkuM.
 *        Command line params must be lowercase.
 *   npx hardhat run scripts/operator/psmOps.ts --yes-mainnet
 *     -> Error HH305: Unrecognized param --yes-mainnet
 *
 * Position is irrelevant (before or after the script path). The ONLY form that
 * works through `hardhat run` is the env-var form:
 *
 *   ACTION=mintOkuM AMOUNT=1000000000 \
 *     npx hardhat run scripts/operator/psmOps.ts --network sepolia
 *
 * `parseArg` still reads argv first, so the `--flag` form keeps working when a
 * script is invoked directly (e.g. via ts-node with HARDHAT_NETWORK set).
 * Every option has a working env-var equivalent, including the mainnet
 * confirmation (`YES_MAINNET=true`).
 */

import { logger } from "./logger";

/**
 * Parse `--name=value` / `--name value` from argv, falling back to the
 * SCREAMING_SNAKE_CASE env var. Under `hardhat run` only the env-var form
 * reaches the script — see the module doc above.
 *
 * Env-name resolution accepts both a snake_cased form and the literal
 * uppercase form, in that order:
 *
 *   parseArg("minAmountOut")        -> MIN_AMOUNT_OUT, then MINAMOUNTOUT
 *   parseArg("pendingEndTimestamp") -> PENDING_END_TIMESTAMP, then PENDINGENDTIMESTAMP
 *   parseArg("batch-size")          -> BATCH_SIZE
 *   parseArg("amount")              -> AMOUNT
 *
 * The snake_cased form is tried first because a bare `toUpperCase()` turns
 * camelCase options into unreadable names like `MINAMOUNTOUT`; the literal
 * form is still honoured so older names keep working.
 */
export function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  if (a) return a.split(/[= ]/)[1];

  const snake = name
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
  const literal = name.toUpperCase().replace(/-/g, "_");

  return process.env[snake] ?? process.env[literal];
}

/**
 * `true` if the mainnet-broadcast confirmation was given, via either
 * `YES_MAINNET=1` / `YES_MAINNET=true` in the environment (preferred) or the
 * legacy `--yes-mainnet` flag on argv.
 *
 * The env form is not a convenience — it's the only one that works under
 * `hardhat run`, which rejects `--yes-mainnet` outright (HH305). Accepted
 * values (`1` and `true`) match `grantRoles.ts` / `grantRolesMainnet.ts` so
 * there is one convention across all scripts.
 */
export function isYesMainnet(): boolean {
  return (
    process.argv.includes("--yes-mainnet") ||
    process.env.YES_MAINNET === "1" ||
    process.env.YES_MAINNET === "true"
  );
}

/**
 * `true` if `DRY_RUN=1` or `DRY_RUN=true` is set. Same accepted values as
 * {@link isYesMainnet}: a dry-run flag that silently ignores one spelling sends
 * real transactions, so every script must read it through here.
 */
export function isDryRun(): boolean {
  return process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
}

/**
 * Standard `main()` runner: invoke `fn`, exit 0 on success, log + exit 1 on
 * failure. Only call this from the `if (require.main === module)` guard so
 * importing a script's exported functions (e.g. from the drill) never calls
 * `process.exit`.
 */
export function runMain(fn: () => Promise<void>): void {
  fn()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error(e?.message ?? String(e));
      process.exit(1);
    });
}
