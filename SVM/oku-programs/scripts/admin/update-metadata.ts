/**
 * Set the OkuM mint's Token-2022 `TokenMetadata` name/symbol in place.
 *
 * Wraps `lite_psm::update_token_metadata` (role_admin-gated). The
 * name/symbol are hardcoded on-chain in the program's single source of
 * truth (`OKU_M_METADATA_*` in `programs/lite-psm/src/constants.rs`):
 *   name   = "OkuMoney"
 *   symbol = "OkuM"
 * matching the EVM `OkuMoney` (OkuM) token.
 *
 * These are the TRUE on-chain identity that wallets and block explorers
 * display for the mint and its transfers. This does NOT touch the
 * ScaledUiAmount multiplier, so the "$1-pegged usdOku" display value
 * (raw_amount * multiplier, rendered by Token-2022-aware wallets) is
 * unaffected — usdOku is a UI-layer presentation, not the on-chain symbol.
 *
 * Metadata-only edit: no new mint, balances/ATAs untouched.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/update-metadata.ts
 *   NETWORK=mainnet-beta tsx scripts/admin/update-metadata.ts \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit, just print current vs intended
 */

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { LitePsm } from "../../target/types/lite_psm";
import { createProvider, detectNetwork } from "../utils/network";
import { loadDeploymentStrict } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { derivePsmConfigPDA } from "../utils/pdaHelpers";
import { confirmIfMainnet, isDryRun, summaryBlock } from "./_lib/confirm";

async function main() {
  const network = detectNetwork();
  logger.header(`update_token_metadata (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.okuM) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuMMint = new PublicKey(deployment.tokens?.okuM);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  // Read the current on-chain metadata so the operator can see the diff.
  const current = await getTokenMetadata(
    provider.connection,
    okuMMint,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(
    summaryBlock("update_token_metadata()", {
      "config PDA": psmConfig.toBase58(),
      "OkuM mint": okuMMint.toBase58(),
      "current name": current?.name ?? "<none>",
      "current symbol": current?.symbol ?? "<none>",
      "new name": "OkuMoney (hardcoded on-chain)",
      "new symbol": "OkuM (hardcoded on-chain)",
      "signer (role_admin)": provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success("--dry-run set; not submitting.");
  await confirmIfMainnet(
    network,
    "update_token_metadata() on mainnet — rewrites OkuM mint name/symbol to OkuMoney/OkuM",
    provider.connection
  );

  const sig = await program.methods
    .updateTokenMetadata()
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
      config: psmConfig,
      okuMMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await getTokenMetadata(
    provider.connection,
    okuMMint,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  logger.info(`new name:   ${after?.name ?? "<none>"}`);
  logger.info(`new symbol: ${after?.symbol ?? "<none>"}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
