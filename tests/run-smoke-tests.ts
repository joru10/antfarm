#!/usr/bin/env node
/**
 * Container-aware smoke test runner
 * 
 * Executes all *.smoke.test.ts files in the tests/ directory
 * and aggregates results for CI/CD pipelines.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TestRunnerConfig {
  gatewayPort: number;
  isContainer: boolean;
  testPattern: string;
  testDir: string;
}

export interface TestResult {
  file: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface RunResults {
  results: TestResult[];
  total: number;
  passed: number;
  failed: number;
  totalDurationMs: number;
}

/**
 * Detect if running in a container environment
 */
export async function detectContainerEnvironment(): Promise<boolean> {
  // Check for Docker's marker file
  try {
    await fs.access("/.dockerenv");
    return true;
  } catch {
    // File doesn't exist or not accessible
  }

  // Check for common container environment variables
  const containerEnvVars = [
    "KUBERNETES_SERVICE_HOST",
    "CONTAINER_ID",
    "container",
    "DOCKER_CONTAINER",
  ];

  for (const envVar of containerEnvVars) {
    if (process.env[envVar]) {
      return true;
    }
  }

  // Check cgroup for container indicators
  try {
    const cgroup = await fs.readFile("/proc/self/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods") || cgroup.includes("containerd")) {
      return true;
    }
  } catch {
    // Can't read cgroup, not necessarily in a container
  }

  return false;
}

// Sync version - only checks env vars (reliable in all container environments)
export function isContainerEnvironmentSync(): boolean {
  // Check for common container environment variables
  const containerEnvVars = [
    "KUBERNETES_SERVICE_HOST",
    "CONTAINER_ID",
    "container",
    "DOCKER_CONTAINER",
  ];

  for (const envVar of containerEnvVars) {
    if (process.env[envVar]) {
      return true;
    }
  }

  return false;
}

/**
 * Validate and parse gateway port from environment
 */
export function validateGatewayPort(envValue: string | undefined): number {
  if (envValue === undefined || envValue === "") {
    throw new Error("OPENCLAW_GATEWAY_PORT environment variable is required");
  }

  const port = parseInt(envValue, 10);

  if (isNaN(port)) {
    throw new Error(`OPENCLAW_GATEWAY_PORT must be a valid number, got: "${envValue}"`);
  }

  if (port < 1 || port > 65535) {
    throw new Error(`OPENCLAW_GATEWAY_PORT must be between 1 and 65535, got: ${port}`);
  }

  return port;
}

/**
 * Discover all smoke test files in the given directory
 */
export async function discoverSmokeTests(testDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(testDir, { withFileTypes: true });
    const testFiles: string[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".smoke.test.ts")) {
        testFiles.push(path.join(testDir, entry.name));
      }
    }

    return testFiles.sort();
  } catch (err) {
    throw new Error(`Failed to discover tests in ${testDir}: ${err}`);
  }
}

/**
 * Run a single test file
 */
export async function runTestFile(testFile: string): Promise<TestResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn("node", [testFile], {
      stdio: "pipe",
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startTime;

      if (code === 0) {
        resolve({
          file: path.basename(testFile),
          passed: true,
          durationMs,
        });
      } else {
        resolve({
          file: path.basename(testFile),
          passed: false,
          durationMs,
          error: stderr || stdout || `Exit code: ${code}`,
        });
      }
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - startTime;
      resolve({
        file: path.basename(testFile),
        passed: false,
        durationMs,
        error: err.message,
      });
    });
  });
}

/**
 * Run all discovered smoke tests
 */
export async function runAllTests(testFiles: string[]): Promise<RunResults> {
  const results: TestResult[] = [];
  const startTime = Date.now();

  for (const testFile of testFiles) {
    const result = await runTestFile(testFile);
    results.push(result);
  }

  const totalDurationMs = Date.now() - startTime;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return {
    results,
    total: results.length,
    passed,
    failed,
    totalDurationMs,
  };
}

/**
 * Print test results summary
 */
export function printResults(results: RunResults): void {
  console.log("\n" + "=".repeat(60));
  console.log("SMOKE TEST RESULTS");
  console.log("=".repeat(60));

  if (results.results.length === 0) {
    console.log("\nNo smoke tests found.");
    return;
  }

  for (const result of results.results) {
    const status = result.passed ? "✓ PASS" : "✗ FAIL";
    const timing = `(${result.durationMs}ms)`;
    console.log(`\n${status} ${result.file} ${timing}`);
    
    if (!result.passed && result.error) {
      console.log(`  Error: ${result.error.slice(0, 200)}${result.error.length > 200 ? "..." : ""}`);
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log(`Total: ${results.total} | Passed: ${results.passed} | Failed: ${results.failed}`);
  console.log(`Total duration: ${results.totalDurationMs}ms`);
  console.log("=".repeat(60) + "\n");
}

/**
 * Main entry point
 */
export async function main(): Promise<number> {
  const startTime = Date.now();

  console.log("\n🧪 Antfarm Smoke Test Runner");
  console.log("-".repeat(40));

  // Detect container environment
  const isContainer = await detectContainerEnvironment();
  console.log(`Container environment: ${isContainer ? "yes" : "no"}`);

  // Validate gateway port
  let gatewayPort: number;
  try {
    gatewayPort = validateGatewayPort(process.env.OPENCLAW_GATEWAY_PORT);
    console.log(`Gateway port: ${gatewayPort}`);
  } catch (err) {
    console.error(`✗ Configuration error: ${err}`);
    return 1;
  }

  // Set env var for child processes
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);

  // Discover tests
  const testDir = path.join(__dirname);
  console.log(`Test directory: ${testDir}`);

  let testFiles: string[];
  try {
    testFiles = await discoverSmokeTests(testDir);
    console.log(`Found ${testFiles.length} smoke test(s)`);
  } catch (err) {
    console.error(`✗ Failed to discover tests: ${err}`);
    return 1;
  }

  if (testFiles.length === 0) {
    console.log("\nNo smoke tests found. Exiting with success (nothing to run).");
    return 0;
  }

  // Run tests
  console.log("\nRunning tests...\n");
  const results = await runAllTests(testFiles);

  // Print summary
  printResults(results);

  // Return appropriate exit code
  return results.failed > 0 ? 1 : 0;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
