#!/usr/bin/env bash
# Dry-run the full deploy script on a local Hardhat fork for each supported
# EVM chain. No on-chain transactions — every chain starts a fresh fork node
# against its live RPC, runs the deploy, then tears the node down.
#
# Address-book entries land under `fork:<chain>` (see networkContext.ts), so
# the live `<chain>` keys are not touched.
#
# Usage:
#   ./scripts/deploy/dryRunForks.sh                # all 6 chains
#   ./scripts/deploy/dryRunForks.sh sepolia base   # specific subset
#
# Exit code 0 if every chain's deploy completes; non-zero otherwise.

set -uo pipefail

# Default chain list — every EVM chain we run testnet deploys on.
DEFAULT_CHAINS=(sepolia baseSepolia arbSepolia bscTestnet base bsc)

CHAINS=("${@:-${DEFAULT_CHAINS[@]}}")
if [ "$#" -gt 0 ]; then
  CHAINS=("$@")
fi

EVM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${EVM_ROOT}/.dry-run-logs"
mkdir -p "$LOG_DIR"

cd "$EVM_ROOT"

# Kill any leftover hardhat node processes from prior runs.
pkill -9 -f "hardhat node" 2>/dev/null || true
sleep 1

declare -A RESULTS

for chain in "${CHAINS[@]}"; do
  echo
  echo "============================================================"
  echo " Dry-run: $chain"
  echo "============================================================"

  NODE_LOG="${LOG_DIR}/${chain}-node.log"
  DEPLOY_LOG="${LOG_DIR}/${chain}-deploy.log"
  rm -f "$NODE_LOG" "$DEPLOY_LOG"

  # Start the fork in a detached session. Use setsid to fully unhook from this
  # shell so the script can continue without the node holding stdio.
  setsid bash -c "FORK_NETWORK=${chain} npx hardhat node >${NODE_LOG} 2>&1" </dev/null >/dev/null 2>&1 &
  NODE_PID=$!
  disown $NODE_PID 2>/dev/null || true

  # Poll for the RPC to come up. Hardhat usually takes 5-15s depending on the
  # forked chain's RPC latency.
  echo "  Waiting for fork RPC..."
  RPC_UP=false
  for i in $(seq 1 60); do
    if curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
         --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
         http://127.0.0.1:8545 >/dev/null 2>&1; then
      RPC_UP=true
      break
    fi
    sleep 1
  done

  if [ "$RPC_UP" != "true" ]; then
    echo "  ✗ RPC did not come up after 60s. See $NODE_LOG"
    RESULTS["$chain"]="rpc-down"
    pkill -9 -f "hardhat node" 2>/dev/null || true
    sleep 1
    continue
  fi

  # Sanity: confirm the running fork's chainId matches the chain we want.
  CHAIN_ID_HEX=$(curl -s -X POST -H "Content-Type: application/json" \
                      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
                      http://127.0.0.1:8545 | sed 's/.*"result":"\([^"]*\)".*/\1/')
  echo "  Fork chainId: $CHAIN_ID_HEX"

  # Run the deploy. NETWORK=<chain> matches the fork; bookKey will be
  # fork:<chain> per networkContext.ts.
  echo "  Running deploy..."
  if NETWORK="$chain" npx hardhat run scripts/deploy/index.ts --network localhost \
       > "$DEPLOY_LOG" 2>&1; then
    echo "  ✓ Deploy completed"
    RESULTS["$chain"]="ok"
  else
    echo "  ✗ Deploy failed. See $DEPLOY_LOG"
    RESULTS["$chain"]="deploy-failed"
  fi

  # Tear down the fork.
  pkill -9 -f "hardhat node" 2>/dev/null || true
  sleep 2
done

echo
echo "============================================================"
echo " Summary"
echo "============================================================"
FAILED=0
for chain in "${CHAINS[@]}"; do
  status="${RESULTS[$chain]:-unknown}"
  case "$status" in
    ok) echo "  $chain: ✓ ok" ;;
    *) echo "  $chain: ✗ $status"; FAILED=$((FAILED + 1)) ;;
  esac
done
echo
echo "Logs:        $LOG_DIR/"

exit "$FAILED"
