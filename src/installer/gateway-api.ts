import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

interface GatewayConfig {
  url: string;
  port: number;
  token?: string;
}

function resolveOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return path.join(stateDir, "openclaw.json");
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function parsePortFromUrl(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.port) {
      const parsed = Number(url.port);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    if (url.protocol === "https:" || url.protocol === "wss:") return 443;
    if (url.protocol === "http:" || url.protocol === "ws:") return 80;
  } catch {
    return undefined;
  }
  return undefined;
}

async function readOpenClawConfig(): Promise<{ port?: number; token?: string }> {
  const configPath = resolveOpenClawConfigPath();
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const port =
      config.gateway?.port ??
      parsePortFromUrl(config.gateway?.remote?.url) ??
      parsePortFromUrl(config.gateway?.url);
    const token =
      config.gateway?.auth?.token ??
      config.gateway?.remote?.token;
    return {
      port,
      token,
    };
  } catch {
    return {};
  }
}

async function getGatewayConfig(): Promise<GatewayConfig> {
  const envPort = Number(process.env.OPENCLAW_GATEWAY_PORT);
  const config = await readOpenClawConfig();
  const port =
    Number.isFinite(envPort) && envPort > 0
      ? envPort
      : (config.port ?? 18789);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token: config.token,
  };
}

// ---------------------------------------------------------------------------
// OpenClaw CLI fallback helpers
// ---------------------------------------------------------------------------

type CliRunner =
  | { command: string; staticArgs: string[]; env?: Record<string, string> }
  | null;

let cachedRunner: CliRunner = null;

/** Locate an OpenClaw CLI runner. Checks PATH, common binaries, then /app/dist/index.js, then npx. */
async function findOpenclawRunner(): Promise<Exclude<CliRunner, null>> {
  if (cachedRunner) return cachedRunner;

  // 1. Check PATH via `which`
  const fromPath = await new Promise<string | null>((resolve) => {
    execFile("which", ["openclaw"], (err, stdout) => {
      if (!err && stdout.trim()) resolve(stdout.trim());
      else resolve(null);
    });
  });
  if (fromPath) {
    cachedRunner = { command: fromPath, staticArgs: [] };
    return cachedRunner;
  }

  // 2. Check common global install locations
  const candidates = [
    path.join(os.homedir(), ".npm-global", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/opt/homebrew/bin/openclaw",
  ];
  for (const c of candidates) {
    try {
      await fs.access(c, 0o1 /* fs.constants.X_OK */);
      cachedRunner = { command: c, staticArgs: [] };
      return cachedRunner;
    } catch { /* skip */ }
  }

  // 3. Use the bundled gateway CLI entrypoint inside OpenClaw gateway containers
  try {
    await fs.access("/app/dist/index.js", 0o1 /* fs.constants.X_OK */);
    cachedRunner = {
      command: "node",
      staticArgs: ["/app/dist/index.js"],
      env: { OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT ?? "18789" },
    };
    return cachedRunner;
  } catch { /* skip */ }

  // 4. Fall back to npx
  cachedRunner = { command: "npx", staticArgs: ["openclaw"] };
  return cachedRunner;
}

/** Run an openclaw CLI command and return stdout. */
function runCli(args: string[]): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const runner = await findOpenclawRunner();
    const finalArgs = [...runner.staticArgs, ...args];
    const gateway = await getGatewayConfig();
    const env = {
      ...process.env,
      OPENCLAW_GATEWAY_PORT: String(gateway.port),
      ...(gateway.token ? { OPENCLAW_GATEWAY_TOKEN: gateway.token } : {}),
      ...(runner.env ?? {}),
    };
    execFile(runner.command, finalArgs, { timeout: 30_000, env }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout);
        return;
      }

      const dockerArgs = [
        "exec",
        "-e",
        "OPENCLAW_GATEWAY_PORT=18789",
        ...(gateway.token ? ["-e", `OPENCLAW_GATEWAY_TOKEN=${gateway.token}`] : []),
        "openclaw-openclaw-gateway-1",
        "/app/dist/index.js",
        ...args,
      ];

      execFile("docker", dockerArgs, { timeout: 30_000, env: process.env }, (dockerErr, dockerStdout, dockerStderr) => {
        if (!dockerErr) {
          resolve(dockerStdout);
          return;
        }
        reject(new Error((dockerStderr || dockerErr.message || stderr || err.message).trim()));
      });
    });
  });
}

const UPDATE_HINT =
  `This may be fixed by updating OpenClaw: npm update -g openclaw`;

// ---------------------------------------------------------------------------
// Cron operations — HTTP first, CLI fallback
// ---------------------------------------------------------------------------

export async function createAgentCronJob(job: {
  name: string;
  schedule: { kind: string; everyMs?: number; anchorMs?: number };
  sessionTarget: string;
  agentId: string;
  payload: { kind: string; message: string };
  enabled: boolean;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  // --- Try HTTP first ---
  const httpResult = await createAgentCronJobHTTP(job);
  if (httpResult !== null) return httpResult;

  // --- Fallback to CLI ---
  try {
    const args = ["cron", "add", "--json", "--name", job.name];

    if (job.schedule.kind === "every" && job.schedule.everyMs) {
      args.push("--every", `${job.schedule.everyMs}ms`);
    }

    args.push("--session", job.sessionTarget === "isolated" ? "isolated" : "main");
    args.push("--agent", job.agentId);
    args.push("--no-deliver");

    if (job.payload?.message) {
      args.push("--message", job.payload.message);
    }

    if (!job.enabled) {
      args.push("--disabled");
    }

    const stdout = await runCli(args);
    // Try to parse JSON output for the job id
    try {
      const parsed = JSON.parse(stdout);
      return { ok: true, id: parsed.id ?? parsed.jobId };
    } catch {
      // CLI succeeded but output wasn't JSON — still ok
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: `CLI fallback failed: ${err}. ${UPDATE_HINT}` };
  }
}

/** HTTP-only attempt. Returns null on 404 (signals: use CLI fallback). */
async function createAgentCronJobHTTP(job: {
  name: string;
  schedule: { kind: string; everyMs?: number; anchorMs?: number };
  sessionTarget: string;
  agentId: string;
  payload: { kind: string; message: string };
  enabled: boolean;
}): Promise<{ ok: boolean; error?: string; id?: string } | null> {
  const gateway = await getGatewayConfig();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (gateway.token) headers["Authorization"] = `Bearer ${gateway.token}`;

    const response = await fetch(`${gateway.url}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tool: "cron",
        args: { action: "add", job: { ...job, delivery: { mode: "none", channel: "last" } } },
        sessionKey: "agent:main:main",
      }),
    });

    if (response.status === 404) return null; // signal CLI fallback

    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `Gateway returned ${response.status}: ${text}` };
    }

    const result = await response.json();
    if (!result.ok) {
      return { ok: false, error: result.error?.message ?? "Unknown error" };
    }
    return { ok: true, id: result.result?.id };
  } catch {
    return null; // network error → try CLI
  }
}

/**
 * Preflight check: verify cron is accessible (HTTP or CLI).
 */
export async function checkCronToolAvailable(): Promise<{ ok: boolean; error?: string }> {
  // Try HTTP
  const gateway = await getGatewayConfig();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (gateway.token) headers["Authorization"] = `Bearer ${gateway.token}`;

    const response = await fetch(`${gateway.url}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "cron", args: { action: "list" } }),
    });

    if (response.ok) return { ok: true };

    // Non-404 errors are real failures
    if (response.status !== 404) {
      const text = await response.text();
      return { ok: false, error: `Gateway returned ${response.status}: ${text}` };
    }
  } catch {
    // network error — fall through to CLI check
  }

  // Try CLI fallback
  try {
    await runCli(["cron", "list", "--json"]);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: `Cannot access cron: neither the /tools/invoke HTTP endpoint nor the openclaw CLI are available. ${UPDATE_HINT}`,
    };
  }
}

export async function listCronJobs(): Promise<{ ok: boolean; jobs?: Array<{ id: string; name: string }>; error?: string }> {
  // --- Try HTTP first ---
  const httpResult = await listCronJobsHTTP();
  if (httpResult !== null) return httpResult;

  // --- CLI fallback ---
  try {
    let stdout: string;
    try {
      stdout = await runCli(["cron", "list", "--json", "--all"]);
    } catch {
      stdout = await runCli(["cron", "list", "--json"]);
    }
    const parsed = JSON.parse(stdout);
    const jobs: Array<{ id: string; name: string }> = parsed.jobs ?? parsed ?? [];
    return { ok: true, jobs };
  } catch (err) {
    return { ok: false, error: `CLI fallback failed: ${err}. ${UPDATE_HINT}` };
  }
}

/** HTTP-only list. Returns null on 404/network error. */
async function listCronJobsHTTP(): Promise<{ ok: boolean; jobs?: Array<{ id: string; name: string }>; error?: string } | null> {
  const gateway = await getGatewayConfig();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (gateway.token) headers["Authorization"] = `Bearer ${gateway.token}`;

    const response = await fetch(`${gateway.url}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "cron", args: { action: "list" }, sessionKey: "agent:main:main" }),
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      return { ok: false, error: `Gateway returned ${response.status}` };
    }

    const result = await response.json();
    if (!result.ok) {
      return { ok: false, error: result.error?.message ?? "Unknown error" };
    }

    let jobs: Array<{ id: string; name: string }> = [];
    const content = result.result?.content;
    if (Array.isArray(content) && content[0]?.text) {
      try {
        const parsed = JSON.parse(content[0].text);
        jobs = parsed.jobs ?? [];
      } catch { /* fallback */ }
    }
    if (jobs.length === 0) {
      jobs = result.result?.jobs ?? result.jobs ?? [];
    }
    return { ok: true, jobs };
  } catch {
    return null;
  }
}

export async function deleteCronJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  // --- Try HTTP first ---
  const httpResult = await deleteCronJobHTTP(jobId);
  if (httpResult !== null) return httpResult;

  // --- CLI fallback ---
  try {
    await runCli(["cron", "rm", jobId, "--json"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `CLI fallback failed: ${err}. ${UPDATE_HINT}` };
  }
}

/** HTTP-only delete. Returns null on 404/network error. */
async function deleteCronJobHTTP(jobId: string): Promise<{ ok: boolean; error?: string } | null> {
  const gateway = await getGatewayConfig();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (gateway.token) headers["Authorization"] = `Bearer ${gateway.token}`;

    const response = await fetch(`${gateway.url}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "cron", args: { action: "remove", id: jobId }, sessionKey: "agent:main:main" }),
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      return { ok: false, error: `Gateway returned ${response.status}` };
    }

    const result = await response.json();
    return result.ok ? { ok: true } : { ok: false, error: result.error?.message ?? "Unknown error" };
  } catch {
    return null;
  }
}

export async function deleteAgentCronJobs(namePrefix: string): Promise<void> {
  const listResult = await listCronJobs();
  if (!listResult.ok || !listResult.jobs) return;

  for (const job of listResult.jobs) {
    if (job.name.startsWith(namePrefix)) {
      await deleteCronJob(job.id);
    }
  }
}
