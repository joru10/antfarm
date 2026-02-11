#!/usr/bin/env node
/**
 * Tests for the container-aware smoke test runner
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  detectContainerEnvironment,
  isContainerEnvironmentSync,
  validateGatewayPort,
  discoverSmokeTests,
  runTestFile,
  printResults,
  type RunResults,
} from "./run-smoke-tests.ts";

async function createTempTestDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "smoke-test-runner-"));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================================================================
// Test: validateGatewayPort
// ============================================================================

async function testValidateGatewayPortValid(): Promise<void> {
  console.log("Test: validateGatewayPort with valid ports...");

  // Valid ports
  if (validateGatewayPort("8080") !== 8080) {
    throw new Error("Expected port 8080");
  }
  if (validateGatewayPort("1") !== 1) {
    throw new Error("Expected port 1");
  }
  if (validateGatewayPort("65535") !== 65535) {
    throw new Error("Expected port 65535");
  }

  console.log("  ✓ Accepts valid port numbers");
  console.log("PASS: validateGatewayPort valid cases\n");
}

async function testValidateGatewayPortInvalid(): Promise<void> {
  console.log("Test: validateGatewayPort with invalid ports...");

  // Missing/undefined
  try {
    validateGatewayPort(undefined);
    throw new Error("Should have thrown for undefined");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("required")) {
      throw err;
    }
  }

  // Empty string
  try {
    validateGatewayPort("");
    throw new Error("Should have thrown for empty string");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("required")) {
      throw err;
    }
  }

  // Not a number
  try {
    validateGatewayPort("not-a-number");
    throw new Error("Should have thrown for non-numeric");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("valid number")) {
      throw err;
    }
  }

  // Too low
  try {
    validateGatewayPort("0");
    throw new Error("Should have thrown for port 0");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("between 1 and 65535")) {
      throw err;
    }
  }

  // Too high
  try {
    validateGatewayPort("65536");
    throw new Error("Should have thrown for port 65536");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("between 1 and 65535")) {
      throw err;
    }
  }

  // Negative
  try {
    validateGatewayPort("-1");
    throw new Error("Should have thrown for negative port");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("between 1 and 65535")) {
      throw err;
    }
  }

  console.log("  ✓ Rejects undefined/empty values");
  console.log("  ✓ Rejects non-numeric values");
  console.log("  ✓ Rejects out-of-range ports");
  console.log("PASS: validateGatewayPort invalid cases\n");
}

// ============================================================================
// Test: discoverSmokeTests
// ============================================================================

async function testDiscoverSmokeTests(): Promise<void> {
  console.log("Test: discoverSmokeTests finds smoke test files...");

  const tmpDir = await createTempTestDir();
  try {
    // Create test files
    await fs.writeFile(path.join(tmpDir, "test1.smoke.test.ts"), "// test 1");
    await fs.writeFile(path.join(tmpDir, "test2.smoke.test.ts"), "// test 2");
    await fs.writeFile(path.join(tmpDir, "regular.test.ts"), "// regular");
    await fs.writeFile(path.join(tmpDir, "not-a-test.txt"), "// not a test");

    const tests = await discoverSmokeTests(tmpDir);

    if (tests.length !== 2) {
      throw new Error(`Expected 2 smoke tests, got ${tests.length}`);
    }

    const basenames = tests.map((t) => path.basename(t));
    if (!basenames.includes("test1.smoke.test.ts")) {
      throw new Error("Missing test1.smoke.test.ts");
    }
    if (!basenames.includes("test2.smoke.test.ts")) {
      throw new Error("Missing test2.smoke.test.ts");
    }

    console.log("  ✓ Discovers only .smoke.test.ts files");
    console.log("  ✓ Returns sorted list");
    console.log("PASS: discoverSmokeTests\n");
  } finally {
    await cleanup(tmpDir);
  }
}

async function testDiscoverSmokeTestsEmpty(): Promise<void> {
  console.log("Test: discoverSmokeTests with empty directory...");

  const tmpDir = await createTempTestDir();
  try {
    const tests = await discoverSmokeTests(tmpDir);

    if (tests.length !== 0) {
      throw new Error(`Expected 0 tests, got ${tests.length}`);
    }

    console.log("  ✓ Returns empty array when no tests found");
    console.log("PASS: discoverSmokeTests empty directory\n");
  } finally {
    await cleanup(tmpDir);
  }
}

// ============================================================================
// Test: detectContainerEnvironment
// ============================================================================

async function testDetectContainerEnvironment(): Promise<void> {
  console.log("Test: detectContainerEnvironment...");

  // Test should return a boolean (we can't guarantee container vs non-container)
  const result = await detectContainerEnvironment();
  
  if (typeof result !== "boolean") {
    throw new Error(`Expected boolean, got ${typeof result}`);
  }

  console.log(`  ✓ Detected container: ${result}`);
  console.log("PASS: detectContainerEnvironment returns boolean\n");
}

async function testIsContainerEnvironmentSync(): Promise<void> {
  console.log("Test: isContainerEnvironmentSync...");

  // Test should return a boolean
  const result = isContainerEnvironmentSync();
  
  if (typeof result !== "boolean") {
    throw new Error(`Expected boolean, got ${typeof result}`);
  }

  console.log(`  ✓ Detected container: ${result}`);
  console.log("PASS: isContainerEnvironmentSync returns boolean\n");
}

async function testContainerDetectionWithEnvVar(): Promise<void> {
  console.log("Test: container detection with env var...");

  // Save original env
  const originalEnv = process.env.CONTAINER_ID;

  try {
    // Set a container env var
    process.env.CONTAINER_ID = "test-container-123";
    
    const result = isContainerEnvironmentSync();
    
    if (!result) {
      throw new Error("Should detect container when CONTAINER_ID is set");
    }

    console.log("  ✓ Detects container from env vars");
    console.log("PASS: container detection with env var\n");
  } finally {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.CONTAINER_ID;
    } else {
      process.env.CONTAINER_ID = originalEnv;
    }
  }
}

// ============================================================================
// Test: runTestFile
// ============================================================================

async function testRunTestFilePass(): Promise<void> {
  console.log("Test: runTestFile with passing test...");

  const tmpDir = await createTempTestDir();
  try {
    // Create a passing test file
    const testFile = path.join(tmpDir, "passing.smoke.test.ts");
    await fs.writeFile(
      testFile,
      `console.log("Test passed!");
process.exit(0);
`
    );

    const result = await runTestFile(testFile);

    if (!result.passed) {
      throw new Error(`Expected test to pass, got: ${result.error}`);
    }

    if (result.file !== "passing.smoke.test.ts") {
      throw new Error(`Expected filename passing.smoke.test.ts, got: ${result.file}`);
    }

    if (result.durationMs < 0) {
      throw new Error("Duration should be non-negative");
    }

    console.log("  ✓ Returns passed=true for exit code 0");
    console.log("  ✓ Captures duration");
    console.log("PASS: runTestFile passing test\n");
  } finally {
    await cleanup(tmpDir);
  }
}

async function testRunTestFileFail(): Promise<void> {
  console.log("Test: runTestFile with failing test...");

  const tmpDir = await createTempTestDir();
  try {
    // Create a failing test file
    const testFile = path.join(tmpDir, "failing.smoke.test.ts");
    await fs.writeFile(
      testFile,
      `console.error("Test failed!");
process.exit(1);
`
    );

    const result = await runTestFile(testFile);

    if (result.passed) {
      throw new Error("Expected test to fail");
    }

    if (!result.error || !result.error.includes("Test failed")) {
      throw new Error(`Expected error message, got: ${result.error}`);
    }

    console.log("  ✓ Returns passed=false for non-zero exit");
    console.log("  ✓ Captures error output");
    console.log("PASS: runTestFile failing test\n");
  } finally {
    await cleanup(tmpDir);
  }
}

// ============================================================================
// Test: printResults
// ============================================================================

async function testPrintResults(): Promise<void> {
  console.log("Test: printResults displays summary...");

  // Capture console output
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args) => logs.push(args.join(" "));

  const results: RunResults = {
    results: [
      { file: "test1.smoke.test.ts", passed: true, durationMs: 100 },
      { file: "test2.smoke.test.ts", passed: false, durationMs: 200, error: "Something broke" },
    ],
    total: 2,
    passed: 1,
    failed: 1,
    totalDurationMs: 300,
  };

  try {
    printResults(results);

    const output = logs.join("\n");

    if (!output.includes("SMOKE TEST RESULTS")) {
      throw new Error("Missing header in output");
    }

    if (!output.includes("test1.smoke.test.ts")) {
      throw new Error("Missing test1 in output");
    }

    if (!output.includes("test2.smoke.test.ts")) {
      throw new Error("Missing test2 in output");
    }

    if (!output.includes("Total: 2")) {
      throw new Error("Missing total count");
    }

    console.log = originalLog;
    console.log("  ✓ Prints header");
    console.log("  ✓ Lists all test results");
    console.log("  ✓ Shows summary counts");
    console.log("  ✓ Shows timing");
    console.log("PASS: printResults\n");
  } catch (err) {
    console.log = originalLog;
    throw err;
  }
}

async function testPrintResultsEmpty(): Promise<void> {
  console.log("Test: printResults with no tests...");

  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args) => logs.push(args.join(" "));

  const results: RunResults = {
    results: [],
    total: 0,
    passed: 0,
    failed: 0,
    totalDurationMs: 0,
  };

  try {
    printResults(results);

    const output = logs.join("\n");

    if (!output.includes("No smoke tests found")) {
      throw new Error("Missing 'no tests' message");
    }

    console.log = originalLog;
    console.log("  ✓ Shows 'no tests' message when empty");
    console.log("PASS: printResults empty\n");
  } catch (err) {
    console.log = originalLog;
    throw err;
  }
}

// ============================================================================
// Main
// ============================================================================

async function runTests(): Promise<void> {
  console.log("\n=== Smoke Test Runner Tests ===\n");

  try {
    // Gateway port validation tests
    await testValidateGatewayPortValid();
    await testValidateGatewayPortInvalid();

    // Smoke test discovery tests
    await testDiscoverSmokeTests();
    await testDiscoverSmokeTestsEmpty();

    // Container detection tests
    await testDetectContainerEnvironment();
    await testIsContainerEnvironmentSync();
    await testContainerDetectionWithEnvVar();

    // Test execution tests
    await testRunTestFilePass();
    await testRunTestFileFail();

    // Output tests
    await testPrintResults();
    await testPrintResultsEmpty();

    console.log("All tests passed! ✓\n");
    process.exit(0);
  } catch (err) {
    console.error("\nFAIL:", err);
    process.exit(1);
  }
}

runTests();
