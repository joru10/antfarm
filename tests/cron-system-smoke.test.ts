#!/usr/bin/env node
/**
 * Smoke test: Cron system gateway port override
 * 
 * Verifies that OPENCLAW_GATEWAY_PORT environment variable is respected
 * when connecting to the gateway in container environments.
 */

import { getGatewayConfig, getGatewayUrl, type GatewayConfig } from "./gateway-api.ts";

// ============================================================================
// Test: getGatewayConfig respects OPENCLAW_GATEWAY_PORT
// ============================================================================

function testGetGatewayConfigDefaultPort(): void {
  console.log("Test: getGatewayConfig uses default port when env not set...");

  // Save original env
  const originalPort = process.env.OPENCLAW_GATEWAY_PORT;
  delete process.env.OPENCLAW_GATEWAY_PORT;

  try {
    const config = getGatewayConfig();

    if (config.port !== 18789) {
      throw new Error(`Expected default port 18789, got ${config.port}`);
    }

    if (config.url !== "http://127.0.0.1:18789") {
      throw new Error(`Expected URL http://127.0.0.1:18789, got ${config.url}`);
    }

    console.log("  ✓ Uses default port 18789");
    console.log("  ✓ Constructs correct default URL");
    console.log("PASS: getGatewayConfig default port\n");
  } finally {
    // Restore original env
    if (originalPort !== undefined) {
      process.env.OPENCLAW_GATEWAY_PORT = originalPort;
    }
  }
}

function testGetGatewayConfigCustomPort(): void {
  console.log("Test: getGatewayConfig respects OPENCLAW_GATEWAY_PORT env var...");

  // Save original env
  const originalPort = process.env.OPENCLAW_GATEWAY_PORT;
  process.env.OPENCLAW_GATEWAY_PORT = "8080";

  try {
    const config = getGatewayConfig();

    if (config.port !== 8080) {
      throw new Error(`Expected port 8080, got ${config.port}`);
    }

    if (config.url !== "http://127.0.0.1:8080") {
      throw new Error(`Expected URL http://127.0.0.1:8080, got ${config.url}`);
    }

    console.log("  ✓ Respects OPENCLAW_GATEWAY_PORT=8080");
    console.log("  ✓ Constructs correct custom URL");
    console.log("PASS: getGatewayConfig custom port\n");
  } finally {
    // Restore original env
    if (originalPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalPort;
    }
  }
}

function testGetGatewayConfigVariousPorts(): void {
  console.log("Test: getGatewayConfig handles various port values...");

  const originalPort = process.env.OPENCLAW_GATEWAY_PORT;
  const testCases = [
    { port: "1", expected: 1 },
    { port: "3000", expected: 3000 },
    { port: "8080", expected: 8080 },
    { port: "65535", expected: 65535 },
  ];

  try {
    for (const tc of testCases) {
      process.env.OPENCLAW_GATEWAY_PORT = tc.port;
      const config = getGatewayConfig();

      if (config.port !== tc.expected) {
        throw new Error(`Expected port ${tc.expected}, got ${config.port}`);
      }

      const expectedUrl = `http://127.0.0.1:${tc.expected}`;
      if (config.url !== expectedUrl) {
        throw new Error(`Expected URL ${expectedUrl}, got ${config.url}`);
      }
    }

    console.log("  ✓ Handles port 1 (minimum valid)");
    console.log("  ✓ Handles port 3000");
    console.log("  ✓ Handles port 8080");
    console.log("  ✓ Handles port 65535 (maximum valid)");
    console.log("PASS: getGatewayConfig various ports\n");
  } finally {
    // Restore original env
    if (originalPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalPort;
    }
  }
}

function testGetGatewayConfigInvalidPorts(): void {
  console.log("Test: getGatewayConfig falls back to default for invalid ports...");

  const originalPort = process.env.OPENCLAW_GATEWAY_PORT;
  const invalidCases = ["0", "-1", "65536", "not-a-number", ""];

  try {
    for (const invalidPort of invalidCases) {
      process.env.OPENCLAW_GATEWAY_PORT = invalidPort;
      const config = getGatewayConfig();

      // Should fall back to default
      if (config.port !== 18789) {
        throw new Error(`Expected fallback to default port 18789 for "${invalidPort}", got ${config.port}`);
      }
    }

    console.log("  ✓ Falls back to default for port 0");
    console.log("  ✓ Falls back to default for negative port");
    console.log("  ✓ Falls back to default for port > 65535");
    console.log("  ✓ Falls back to default for non-numeric");
    console.log("  ✓ Falls back to default for empty string");
    console.log("PASS: getGatewayConfig invalid port fallback\n");
  } finally {
    // Restore original env
    if (originalPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalPort;
    }
  }
}

// ============================================================================
// Test: getGatewayUrl helper
// ============================================================================

function testGetGatewayUrl(): void {
  console.log("Test: getGatewayUrl returns correct URL...");

  const originalPort = process.env.OPENCLAW_GATEWAY_PORT;
  process.env.OPENCLAW_GATEWAY_PORT = "9090";

  try {
    const url = getGatewayUrl();

    if (url !== "http://127.0.0.1:9090") {
      throw new Error(`Expected URL http://127.0.0.1:9090, got ${url}`);
    }

    console.log("  ✓ getGatewayUrl returns correct URL");
    console.log("PASS: getGatewayUrl\n");
  } finally {
    // Restore original env
    if (originalPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalPort;
    }
  }
}

// ============================================================================
// Test: Debug output
// ============================================================================

function testDebugOutput(): void {
  console.log("Test: Gateway URL is output for debugging...");

  const originalPort = process.env.OPENCLAW_GATEWAY_PORT;
  process.env.OPENCLAW_GATEWAY_PORT = "7777";

  try {
    const config = getGatewayConfig();
    
    // Output the gateway URL (as required for debugging)
    console.log(`  Gateway URL: ${config.url}`);
    console.log(`  Gateway Port: ${config.port}`);

    if (!config.url.includes(":7777")) {
      throw new Error("Debug output should contain the custom port");
    }

    console.log("  ✓ Gateway URL is accessible for debugging");
    console.log("PASS: Debug output\n");
  } finally {
    // Restore original env
    if (originalPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalPort;
    }
  }
}

// ============================================================================
// Main
// ============================================================================

function runTests(): void {
  console.log("\n=== Cron System Smoke Tests - Gateway Port Override ===\n");

  try {
    // Test getGatewayConfig function
    testGetGatewayConfigDefaultPort();
    testGetGatewayConfigCustomPort();
    testGetGatewayConfigVariousPorts();
    testGetGatewayConfigInvalidPorts();

    // Test getGatewayUrl helper
    testGetGatewayUrl();

    // Test debug output
    testDebugOutput();

    console.log("All smoke tests passed! ✓\n");
    process.exit(0);
  } catch (err) {
    console.error("\nFAIL:", err);
    process.exit(1);
  }
}

runTests();
