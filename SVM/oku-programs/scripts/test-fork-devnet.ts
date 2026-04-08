#!/usr/bin/env npx tsx
/**
 * Devnet Fork Test Runner
 *
 * Automatically manages Surfpool for devnet fork testing (bridge scripts):
 * - If Surfpool is already running with devnet fork, uses it (does NOT kill on exit)
 * - If Surfpool is not running, starts it with devnet fork, runs tests, then cleans up
 *
 * This is specifically for testing bridge scripts against forked devnet state
 * before executing on live devnet.
 *
 * Usage:
 *   npm run test:fork:devnet
 *   tsx scripts/test-fork-devnet.ts
 *   tsx scripts/test-fork-devnet.ts --bridge  # Run bridge-specific tests
 *
 * Environment:
 *   Uses API_KEY from .env for Alchemy RPC access, or falls back to public devnet
 */

import { config } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";
import { spawn, ChildProcess, execSync } from "child_process";
import { Connection, PublicKey } from "@solana/web3.js";

// Load environment variables
config({ path: resolve(__dirname, "../.env") });

// Expand ~ to home directory
function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return p.replace("~", homedir());
  }
  return p;
}

// Configuration
const SURFPOOL_RPC = "http://localhost:8899";
const WALLET_PATH = expandPath(process.env.ANCHOR_WALLET || "~/.config/solana/id.json");
const API_KEY = process.env.API_KEY;

// Devnet RPC - prefer Alchemy if API_KEY is set, otherwise use public endpoint
const DEVNET_RPC = API_KEY
  ? `https://solana-devnet.g.alchemy.com/v2/${API_KEY}`
  : "https://api.devnet.solana.com";

// Program IDs from Anchor.toml
const PROGRAMS = {
  lite_psm: new PublicKey("AhKZ4TT5W4mnvR3CsX1t9ymQmZx4535AN9SsrThu6C1T"),
  oku_bridge_router: new PublicKey("7DtqfP4fyShjAoM35QC9m3a9Ukh4tqcVgzTNLuyTkgE"),
  oku_dollar: new PublicKey("BjjK75Vxj6zsC49qYfcVYFPLqyXXkcaFzacTXwohmfVC"),
};

// Known devnet addresses for fork verification
const DEVNET_ACCOUNTS = {
  // Pyth devnet USDC/USD feed
  PYTH_USDC_USD: new PublicKey("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7"),
};

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message: string) {
  log(`✓ ${message}`, colors.green);
}

function logError(message: string) {
  log(`✗ ${message}`, colors.red);
}

function logWarning(message: string) {
  log(`⚠ ${message}`, colors.yellow);
}

function logInfo(message: string) {
  log(`ℹ ${message}`, colors.cyan);
}

// Track if we started Surfpool so we know whether to clean up
let surfpoolProcess: ChildProcess | null = null;
let weStartedSurfpool = false;

async function checkSurfpoolRunning(): Promise<boolean> {
  try {
    const connection = new Connection(SURFPOOL_RPC, "confirmed");
    await connection.getSlot();
    return true;
  } catch {
    return false;
  }
}

async function checkSurfpoolFeatures(): Promise<boolean> {
  try {
    const response = await fetch(SURFPOOL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_getSurfnetInfo",
        params: [],
      }),
    });
    const json = await response.json();
    return !json.error;
  } catch {
    return false;
  }
}

async function checkDevnetFork(connection: Connection): Promise<boolean> {
  try {
    // Check for Pyth devnet oracle as indicator of devnet fork
    const accountInfo = await connection.getAccountInfo(DEVNET_ACCOUNTS.PYTH_USDC_USD);
    return accountInfo !== null;
  } catch {
    return false;
  }
}

async function checkProgramDeployed(
  connection: Connection,
  programId: PublicKey
): Promise<boolean> {
  try {
    const accountInfo = await connection.getAccountInfo(programId);
    if (!accountInfo) return false;
    return accountInfo.executable;
  } catch {
    return false;
  }
}

async function waitForSurfpool(maxWaitMs: number = 60000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 1000;

  while (Date.now() - startTime < maxWaitMs) {
    if (await checkSurfpoolRunning()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, checkInterval));
  }
  return false;
}

async function waitForPrograms(connection: Connection, maxWaitMs: number = 60000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    let allDeployed = true;
    for (const programId of Object.values(PROGRAMS)) {
      if (!(await checkProgramDeployed(connection, programId))) {
        allDeployed = false;
        break;
      }
    }
    if (allDeployed) {
      return true;
    }
    await new Promise((r) => setTimeout(r, checkInterval));
  }
  return false;
}

async function startSurfpool(): Promise<boolean> {
  logInfo("Starting Surfpool with devnet fork...");
  log(`  RPC: ${DEVNET_RPC.includes("alchemy") ? DEVNET_RPC.replace(API_KEY!, "****") : DEVNET_RPC}`, colors.dim);

  return new Promise((promiseResolve) => {
    surfpoolProcess = spawn(
      "surfpool",
      [
        "start",
        "--rpc-url",
        DEVNET_RPC,
        "--no-tui",
        "--log-level",
        "warn",
      ],
      {
        cwd: resolve(__dirname, ".."),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      }
    );

    weStartedSurfpool = true;

    // Log surfpool output for debugging
    surfpoolProcess.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        log(`  [surfpool] ${line}`, colors.dim);
      }
    });

    surfpoolProcess.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        // Filter out noisy logs
        if (!line.includes("TRACE") && !line.includes("DEBUG")) {
          log(`  [surfpool] ${line}`, colors.dim);
        }
      }
    });

    surfpoolProcess.on("error", (err) => {
      logError(`Failed to start Surfpool: ${err.message}`);
      promiseResolve(false);
    });

    surfpoolProcess.on("close", (code) => {
      if (code !== 0 && code !== null) {
        logError(`Surfpool exited with code ${code}`);
      }
      surfpoolProcess = null;
    });

    // Wait for Surfpool to be ready
    waitForSurfpool(60000).then((ready) => {
      if (ready) {
        logSuccess("Surfpool started");
        promiseResolve(true);
      } else {
        logError("Surfpool failed to start within timeout");
        promiseResolve(false);
      }
    });
  });
}

function stopSurfpool(): Promise<void> {
  return new Promise((promiseResolve) => {
    if (!surfpoolProcess) {
      promiseResolve();
      return;
    }

    logInfo("Stopping Surfpool...");

    surfpoolProcess.on("close", () => {
      logSuccess("Surfpool stopped");
      surfpoolProcess = null;
      promiseResolve();
    });

    // Send SIGTERM for graceful shutdown
    surfpoolProcess.kill("SIGTERM");

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (surfpoolProcess) {
        surfpoolProcess.kill("SIGKILL");
      }
    }, 5000);
  });
}

async function runBridgeTests(): Promise<number> {
  return new Promise((promiseResolve) => {
    const env = {
      ...process.env,
      ANCHOR_PROVIDER_URL: SURFPOOL_RPC,
      ANCHOR_WALLET: WALLET_PATH,
      NETWORK: "devnet-fork",
    };

    // Check if --bridge flag is passed
    const isBridgeTest = process.argv.includes("--bridge");

    const testPattern = isBridgeTest
      ? "tests/**/bridge*.ts"
      : "tests/**/*.ts";

    const grepPattern = isBridgeTest ? "Bridge" : "Fork";

    logInfo(`Running ${isBridgeTest ? "bridge" : "fork"} tests...`);

    const child = spawn(
      "npx",
      [
        "mocha",
        "--require",
        "tsx",
        "--timeout",
        "120000",
        "--grep",
        grepPattern,
        testPattern,
      ],
      {
        cwd: resolve(__dirname, ".."),
        env,
        stdio: "inherit",
      }
    );

    child.on("close", (code) => {
      promiseResolve(code ?? 1);
    });
  });
}

async function cleanup() {
  if (weStartedSurfpool && surfpoolProcess) {
    await stopSurfpool();
  }
}

// Handle process termination
process.on("SIGINT", async () => {
  console.log();
  logWarning("Interrupted");
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function main() {
  console.log();
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  log("  Surfpool Devnet Fork Test Runner", colors.cyan);
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  console.log();

  const connection = new Connection(SURFPOOL_RPC, "confirmed");

  // Step 1: Check if Surfpool is already running
  logInfo("Checking for existing Surfpool instance...");

  const alreadyRunning = await checkSurfpoolRunning();

  if (alreadyRunning) {
    logSuccess("Surfpool is already running");

    // Check if it's running with devnet fork
    const isForking = await checkDevnetFork(connection);
    if (!isForking) {
      logWarning("Existing Surfpool may not be running with devnet fork");
      log("Checking for deployed programs anyway...", colors.yellow);
    } else {
      logSuccess("Devnet fork detected (Pyth devnet oracle found)");
    }

    logInfo("Using existing Surfpool instance (will NOT be stopped on exit)");
  } else {
    // Need to start Surfpool ourselves
    logInfo("No Surfpool instance detected");

    const started = await startSurfpool();
    if (!started) {
      process.exit(1);
    }

    // Wait for programs to be available (from fork)
    logInfo("Waiting for forked programs to be available...");
    const programsReady = await waitForPrograms(connection, 90000);
    if (!programsReady) {
      logWarning("Programs not available yet - they may need to be deployed to devnet first");
      log("If this is a fresh deployment, deploy to devnet first:", colors.yellow);
      log("  NETWORK=devnet npm run deploy", colors.dim);
    }
  }

  // Step 2: Verify Surfpool features
  const hasSurfpoolFeatures = await checkSurfpoolFeatures();
  if (hasSurfpoolFeatures) {
    logSuccess("Surfpool cheatcodes available");
  } else {
    logWarning("Surfpool cheatcodes not available");
  }

  // Step 3: Verify program deployments
  console.log();
  logInfo("Verifying program availability...");

  let allProgramsAvailable = true;
  for (const [name, programId] of Object.entries(PROGRAMS)) {
    const isDeployed = await checkProgramDeployed(connection, programId);
    if (isDeployed) {
      logSuccess(`${name}: ${programId.toBase58().slice(0, 8)}...`);
    } else {
      logError(`${name}: NOT AVAILABLE`);
      allProgramsAvailable = false;
    }
  }

  if (!allProgramsAvailable) {
    console.log();
    logWarning("Some programs are not available on devnet!");
    log("Deploy to devnet first with: NETWORK=devnet npm run deploy", colors.yellow);
    log("Or run this script after deployment completes.", colors.dim);
    console.log();
    log("Continuing anyway to show what's missing...", colors.yellow);
  }

  // Step 4: Run tests
  console.log();
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  log("  Running Devnet Fork Tests", colors.cyan);
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  console.log();

  const exitCode = await runBridgeTests();

  console.log();
  if (exitCode === 0) {
    logSuccess("All devnet fork tests passed!");
  } else {
    logError(`Tests failed with exit code ${exitCode}`);
  }

  // Clean up only if we started Surfpool
  await cleanup();

  process.exit(exitCode);
}

main().catch(async (err) => {
  logError(`Unexpected error: ${err.message}`);
  await cleanup();
  process.exit(1);
});
