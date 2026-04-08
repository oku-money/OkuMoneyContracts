#!/usr/bin/env npx tsx
/**
 * Fork Test Runner
 *
 * Automatically manages Surfpool for mainnet fork testing:
 * - If Surfpool is already running with mainnet fork, uses it (does NOT kill on exit)
 * - If Surfpool is not running, starts it with mainnet fork, runs tests, then cleans up
 *
 * Usage:
 *   npm run test:fork
 *
 * Environment:
 *   Requires API_KEY in .env file for Alchemy RPC access
 */

import { config } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";
import { spawn, ChildProcess } from "child_process";
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
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://localhost:8899";
const WALLET_PATH = expandPath(process.env.ANCHOR_WALLET || "~/.config/solana/id.json");
const API_KEY = process.env.API_KEY;
const ALCHEMY_RPC = API_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${API_KEY}` : null;

// Program IDs from Anchor.toml
const PROGRAMS = {
  lite_psm: new PublicKey("AhKZ4TT5W4mnvR3CsX1t9ymQmZx4535AN9SsrThu6C1T"),
  oku_bridge_router: new PublicKey("7DtqfP4fyShjAoM35QC9m3a9Ukh4tqcVgzTNLuyTkgE"),
  oku_dollar: new PublicKey("EhYumXw6rb4C6M3p6uwozbXwAFALRHTp4RW9YoEudH6d"),
};

// Known mainnet addresses for fork verification
const MAINNET_ACCOUNTS = {
  USDC_MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  PYTH_SOL_USD: new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"),
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
    const connection = new Connection(RPC_URL, "confirmed");
    await connection.getSlot();
    return true;
  } catch {
    return false;
  }
}

async function checkSurfpoolFeatures(): Promise<boolean> {
  try {
    const response = await fetch(RPC_URL, {
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

async function checkMainnetFork(connection: Connection): Promise<boolean> {
  try {
    const accountInfo = await connection.getAccountInfo(MAINNET_ACCOUNTS.USDC_MINT);
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
  if (!ALCHEMY_RPC) {
    logError("API_KEY not found in .env file");
    log("Please add your Alchemy API key to .env:", colors.yellow);
    log("  API_KEY=your_alchemy_api_key", colors.dim);
    return false;
  }

  logInfo("Starting Surfpool with mainnet fork...");
  log(`  RPC: ${ALCHEMY_RPC.replace(API_KEY!, "****")}`, colors.dim);

  return new Promise((promiseResolve) => {
    surfpoolProcess = spawn(
      "surfpool",
      [
        "start",
        "--rpc-url",
        ALCHEMY_RPC!,
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

async function runForkTests(): Promise<number> {
  return new Promise((promiseResolve) => {
    const env = {
      ...process.env,
      ANCHOR_PROVIDER_URL: RPC_URL,
      ANCHOR_WALLET: WALLET_PATH,
    };

    const child = spawn(
      "npx",
      [
        "mocha",
        "--require",
        "tsx",
        "--timeout",
        "120000",
        "--grep",
        "Fork",
        "tests/**/*.ts",
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
  log("  Surfpool Fork Test Runner", colors.cyan);
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  console.log();

  const connection = new Connection(RPC_URL, "confirmed");

  // Step 1: Check if Surfpool is already running
  logInfo("Checking for existing Surfpool instance...");

  const alreadyRunning = await checkSurfpoolRunning();

  if (alreadyRunning) {
    logSuccess("Surfpool is already running");

    // Check if it's running with mainnet fork
    const isForking = await checkMainnetFork(connection);
    if (!isForking) {
      logWarning("Existing Surfpool is NOT running with mainnet fork");
      log("Fork tests require mainnet state (Pyth oracles, USDC, etc.)", colors.yellow);
      console.log();
      log("Options:", colors.yellow);
      log("  1. Stop the existing Surfpool and re-run this script", colors.dim);
      log("  2. Restart Surfpool with: surfpool start --rpc-url <mainnet-rpc>", colors.dim);
      console.log();
      process.exit(1);
    }

    logSuccess("Mainnet fork detected (USDC mint found)");
    logInfo("Using existing Surfpool instance (will NOT be stopped on exit)");
  } else {
    // Need to start Surfpool ourselves
    logInfo("No Surfpool instance detected");

    const started = await startSurfpool();
    if (!started) {
      process.exit(1);
    }

    // Wait for programs to be deployed via runbook
    logInfo("Waiting for program deployments...");
    const programsReady = await waitForPrograms(connection, 90000);
    if (!programsReady) {
      logError("Programs not deployed within timeout");
      await cleanup();
      process.exit(1);
    }
  }

  // Step 2: Verify Surfpool features
  const hasSurfpoolFeatures = await checkSurfpoolFeatures();
  if (hasSurfpoolFeatures) {
    logSuccess("Surfpool cheatcodes available");
  } else {
    logWarning("Surfpool cheatcodes not available");
  }

  // Step 3: Verify mainnet fork is active
  const isForking = await checkMainnetFork(connection);
  if (isForking) {
    logSuccess("Mainnet fork active");

    // Check Pyth oracle
    try {
      const pythInfo = await connection.getAccountInfo(MAINNET_ACCOUNTS.PYTH_SOL_USD);
      if (pythInfo) {
        logSuccess(`Pyth SOL/USD oracle available (${pythInfo.data.length} bytes)`);
      }
    } catch {
      logWarning("Pyth oracle not accessible");
    }
  }

  // Step 4: Verify program deployments
  console.log();
  logInfo("Verifying program deployments...");

  let allProgramsDeployed = true;
  for (const [name, programId] of Object.entries(PROGRAMS)) {
    const isDeployed = await checkProgramDeployed(connection, programId);
    if (isDeployed) {
      logSuccess(`${name}: ${programId.toBase58().slice(0, 8)}...`);
    } else {
      logError(`${name}: NOT DEPLOYED`);
      allProgramsDeployed = false;
    }
  }

  if (!allProgramsDeployed) {
    console.log();
    logError("Some programs are not deployed!");
    log("Make sure Surfpool completed the deployment runbook.", colors.yellow);
    await cleanup();
    process.exit(1);
  }

  // Step 5: Run fork tests
  console.log();
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  log("  Running Fork Tests", colors.cyan);
  log("═══════════════════════════════════════════════════════════", colors.cyan);
  console.log();

  const exitCode = await runForkTests();

  console.log();
  if (exitCode === 0) {
    logSuccess("All fork tests passed!");
  } else {
    logError(`Fork tests failed with exit code ${exitCode}`);
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
