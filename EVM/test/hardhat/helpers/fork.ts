import { network } from "hardhat";
import { rpcUrl, forkBlock } from "../../../scripts/config/rpc";

let warned = false;

/**
 * Reset the in-process network to a clean mainnet fork. Pins the block when an archive
 * endpoint is available (ANKR_FREEMIUM_API_KEY, ALCHEMY_API_KEY or an explicit URL),
 * otherwise forks latest and warns once.
 */
export async function resetMainnetFork(): Promise<void> {
  const blockNumber = forkBlock("mainnet");
  if (blockNumber === undefined && !warned) {
    warned = true;
    console.warn("[fork] no archive RPC configured (set ANKR_FREEMIUM_API_KEY): forking at latest, not deterministic");
  }
  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: rpcUrl("mainnet", "fork"), blockNumber } }],
  });
}
