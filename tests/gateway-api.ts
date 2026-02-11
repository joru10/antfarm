/**
 * Gateway API utilities for smoke tests
 * 
 * Provides getGatewayConfig that respects OPENCLAW_GATEWAY_PORT environment variable
 * for containerized test environments.
 */

export interface GatewayConfig {
  url: string;
  port: number;
}

/**
 * Get gateway configuration from environment or defaults
 * Respects OPENCLAW_GATEWAY_PORT for container environments
 */
export function getGatewayConfig(): GatewayConfig {
  // Check for environment variable override first (container support)
  const envPort = process.env.OPENCLAW_GATEWAY_PORT;
  
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) {
      return {
        url: `http://127.0.0.1:${port}`,
        port,
      };
    }
  }
  
  // Default port
  const defaultPort = 18789;
  return {
    url: `http://127.0.0.1:${defaultPort}`,
    port: defaultPort,
  };
}

/**
 * Get the gateway URL for debugging output
 */
export function getGatewayUrl(): string {
  return getGatewayConfig().url;
}
