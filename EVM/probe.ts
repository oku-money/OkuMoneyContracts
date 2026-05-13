import { getChainMetadata } from "./scripts/config/chains";
for (const n of ["opSepolia", "baseSepolia", "bscTestnet", "sepolia", "base", "bsc"]) {
  try { console.log(`get(${n}):`, getChainMetadata(n).chainId); }
  catch (e: any) { console.log(`get(${n}): ERR -> ${e.message}`); }
}
