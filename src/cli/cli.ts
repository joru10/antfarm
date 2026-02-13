#!/usr/bin/env node

// Runtime check: node:sqlite requires Node.js >= 22 (real Node, not Bun's wrapper)
try {
  await import("node:sqlite");
} catch {
  console.error(
    `Error: node:sqlite is not available.\n\n` +
    `Antfarm requires Node.js >= 22 with native SQLite support.\n` +
    `If you have Bun installed, its \`node\` wrapper does not support node:sqlite via ESM.\n\n` +
    `Fix: ensure the real Node.js 22+ is first on your PATH.\n` +
    `  Check: node -e "require('node:sqlite')"\n` +
    `  See: https://github.com/snarktank/antfarm/issues/54`
  );
  process.exit(1);
}

import { installWorkflow } from "../installer/install.js";
import { uninstallAllWorkflows, uninstallWorkflow, checkActiveRuns } from "../installer/uninstall.js";
import { getWorkflowStatus, listRuns } from "../installer/status.js";
import { runWorkflow } from "../installer/run.js";
import { listBundledWorkflows } from "../installer/workflow-fetch.js";
import { readRecentLogs, logger } from "../lib/logger.js";
import { getRecentEvents, getRunEvents, type AntfarmEvent, emitEvent } from "../installer/events.js";
import { startDaemon, stopDaemon, getDaemonStatus, isRunning } from "../server/daemonctl.js";
import { claimStep, completeStep, failStep, getStories } from "../installer/step-ops.js";
import { ensureCliSymlink } from "../installer/symlink.js";
import { getDb } from "../db.js";
import { listCronJobs } from "../installer/gateway-api.js";
import { teardownWorkflowCronsIfIdle } from "../installer/agent-cron.js";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "package.json");

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function formatEventTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

const DEFAULT_STALE_ACTIVE_RUN_MINUTES = 120;

function parseUtcTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  if (value.includes("T")) return Date.parse(value);
  return Date.parse(value.replace(" ", "T") + "Z");
}

function getStaleThresholdMs(minutesOverride?: number): number {
  if (minutesOverride && Number.isFinite(minutesOverride) && minutesOverride > 0) {
    return Math.floor(minutesOverride * 60_000);
  }
  const raw = process.env.ANTFARM_STALE_ACTIVE_RUN_MINUTES;
  if (!raw) return DEFAULT_STALE_ACTIVE_RUN_MINUTES * 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_ACTIVE_RUN_MINUTES * 60_000;
  return Math.floor(parsed * 60_000);
}

function formatEventLabel(evt: AntfarmEvent): string {
  const labels: Record<string, string> = {
    "run.started": "Run started",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "step.pending": "Step pending",
    "step.running": "Claimed step",
    "step.done": "Step completed",
    "step.failed": "Step failed",
    "step.timeout": "Step timed out",
    "story.started": "Story started",
    "story.done": "Story done",
    "story.verified": "Story verified",
    "story.retry": "Story retry",
    "story.failed": "Story failed",
    "pipeline.advanced": "Pipeline advanced",
  };
  return labels[evt.event] ?? evt.event;
}

function printEvents(events: AntfarmEvent[]): void {
  if (events.length === 0) { console.log("No events yet."); return; }
  for (const evt of events) {
    const time = formatEventTime(evt.ts);
    const agent = evt.agentId ? `  ${evt.agentId.split("/").pop()}` : "";
    const label = formatEventLabel(evt);
    const story = evt.storyTitle ? ` — ${evt.storyTitle}` : "";
    const detail = evt.detail ? ` (${evt.detail})` : "";
    const run = evt.runId ? `  [${evt.runId.slice(0, 8)}]` : "";
    console.log(`${time}${run}${agent}  ${label}${story}${detail}`);
  }
}

function printUsage() {
  process.stdout.write(
    [
      "antfarm install                      Install all bundled workflows",
      "antfarm uninstall [--force]          Full uninstall (workflows, agents, crons, DB)",
      "",
      "antfarm workflow list                List available workflows",
      "antfarm workflow install <name>      Install a workflow",
      "antfarm workflow uninstall <name>    Uninstall a workflow (blocked if runs active)",
      "antfarm workflow uninstall --all     Uninstall all workflows (--force to override)",
      "antfarm workflow run <name> <task>   Start a workflow run (--allow-concurrent to queue)",
      "antfarm workflow status <query>      Check run status (task substring, run ID prefix)",
      "antfarm workflow runs                List all workflow runs",
      "antfarm workflow resume <run-id>     Resume a failed run from where it left off",
      "antfarm workflow cleanup-stale [workflow-id] [--minutes N] [--dry-run]",
      "                                    Fail stale running runs stuck with no active step progress",
      "",
      "antfarm dashboard [start] [--port N]   Start dashboard daemon (default: 3333)",
      "antfarm dashboard stop                  Stop dashboard daemon",
      "antfarm dashboard status                Check dashboard status",
      "",
      "antfarm step claim <agent-id>       Claim pending step, output resolved input as JSON",
      "antfarm step complete <step-id>      Complete step (reads output from stdin)",
      "antfarm step fail <step-id> <error>  Fail step with retry logic",
      "antfarm step stories <run-id>       List stories for a run",
      "",
      "antfarm probe <agent-id>             Show scheduler + queue readiness for one agent",
      "",
      "antfarm logs [<lines>]               Show recent activity (from events)",
      "antfarm logs <run-id>                Show activity for a specific run",
      "",
      "antfarm version                      Show installed version",
      "antfarm update                       Pull latest, rebuild, and reinstall workflows",
    ].join("\n") + "\n",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [group, action, target] = args;

  if (group === "version" || group === "--version" || group === "-v") {
    console.log(`antfarm v${getVersion()}`);
    return;
  }

  if (group === "ant") {
    const { printAnt } = await import("./ant.js");
    printAnt();
    return;
  }

  if (group === "update") {
    const repoRoot = join(__dirname, "..", "..");
    console.log("Pulling latest...");
    try {
      execSync("git pull", { cwd: repoRoot, stdio: "inherit" });
    } catch {
      process.stderr.write("Failed to git pull. Are you in the antfarm repo?\n");
      process.exit(1);
    }
    console.log("Installing dependencies...");
    execSync("npm install", { cwd: repoRoot, stdio: "inherit" });
    console.log("Building...");
    execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });

    // Reinstall workflows
    const workflows = await listBundledWorkflows();
    if (workflows.length > 0) {
      console.log(`Reinstalling ${workflows.length} workflow(s)...`);
      for (const workflowId of workflows) {
        try {
          await installWorkflow({ workflowId });
          console.log(`  ✓ ${workflowId}`);
        } catch (err) {
          console.log(`  ✗ ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    ensureCliSymlink();
    console.log(`\nUpdated to v${getVersion()}.`);
    return;
  }

  if (group === "uninstall" && (!args[1] || args[1] === "--force")) {
    const force = args.includes("--force");
    const activeRuns = checkActiveRuns();
    if (activeRuns.length > 0 && !force) {
      process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`);
      for (const run of activeRuns) {
        process.stderr.write(`  - ${run.id} (${run.workflow_id}): ${run.task}\n`);
      }
      process.stderr.write(`\nUse --force to uninstall anyway.\n`);
      process.exit(1);
    }

    // Stop dashboard if running
    if (isRunning().running) {
      stopDaemon();
      console.log("Dashboard stopped.");
    }

    await uninstallAllWorkflows();
    console.log("Antfarm fully uninstalled (workflows, agents, crons, database, skill).");
    return;
  }

  if (group === "install" && !args[1]) {
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) { console.log("No bundled workflows found."); return; }

    console.log(`Installing ${workflows.length} workflow(s)...`);
    for (const workflowId of workflows) {
      try {
        await installWorkflow({ workflowId });
        console.log(`  ✓ ${workflowId}`);
      } catch (err) {
        console.log(`  ✗ ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    ensureCliSymlink();
    console.log(`\nDone. Start a workflow with: antfarm workflow run <name> "your task"`);

    // Auto-start dashboard if not already running
    if (!isRunning().running) {
      try {
        const result = await startDaemon(3333);
        console.log(`\nDashboard started (PID ${result.pid}): http://localhost:${result.port}`);
      } catch (err) {
        console.log(`\nNote: Could not start dashboard: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log("\nDashboard already running.");
    }
    return;
  }

  if (group === "dashboard") {
    const sub = args[1];

    if (sub === "stop") {
      if (stopDaemon()) {
        console.log("Dashboard stopped.");
      } else {
        console.log("Dashboard is not running.");
      }
      return;
    }

    if (sub === "status") {
      const st = getDaemonStatus();
      if (st && st.running) {
        console.log(`Dashboard running (PID ${st.pid ?? "unknown"})`);
      } else {
        console.log("Dashboard is not running.");
      }
      return;
    }

    // start (explicit or implicit)
    let port = 3333;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10) || 3333;
    } else if (sub && sub !== "start" && !sub.startsWith("-")) {
      // legacy: antfarm dashboard 4000
      const parsed = parseInt(sub, 10);
      if (!Number.isNaN(parsed)) port = parsed;
    }

    if (isRunning().running) {
      const status = getDaemonStatus();
      console.log(`Dashboard already running (PID ${status?.pid})`);
      console.log(`  http://localhost:${port}`);
      return;
    }

    const result = await startDaemon(port);
    console.log(`Dashboard started (PID ${result.pid})`);
    console.log(`  http://localhost:${result.port}`);
    return;
  }

  if (group === "step") {
    if (action === "claim") {
      if (!target) { process.stderr.write("Missing agent-id.\n"); process.exit(1); }
      const result = claimStep(target);
      if (!result.found) {
        process.stdout.write("NO_WORK\n");
      } else {
        process.stdout.write(JSON.stringify({ stepId: result.stepId, runId: result.runId, input: result.resolvedInput }) + "\n");
      }
      return;
    }
    if (action === "complete") {
      if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); }
      // Read output from args or stdin
      let output = args.slice(3).join(" ").trim();
      if (!output) {
        // Read from stdin (piped input)
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        output = Buffer.concat(chunks).toString("utf-8").trim();
      }
      const result = completeStep(target, output);
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    if (action === "fail") {
      if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); }
      const error = args.slice(3).join(" ").trim() || "Unknown error";
      const result = failStep(target, error);
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    if (action === "stories") {
      if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
      const stories = getStories(target);
      if (stories.length === 0) { console.log("No stories found for this run."); return; }
      for (const s of stories) {
        const retryInfo = s.retryCount > 0 ? ` (retry ${s.retryCount})` : "";
        console.log(`${s.storyId.padEnd(8)} [${s.status.padEnd(7)}] ${s.title}${retryInfo}`);
      }
      return;
    }
    process.stderr.write(`Unknown step action: ${action}\n`);
    printUsage();
    process.exit(1);
  }

  if (group === "logs") {
    const arg = args[1];
    if (arg && !/^\d+$/.test(arg)) {
      // Looks like a run ID (or prefix)
      const events = getRunEvents(arg);
      if (events.length === 0) {
        console.log(`No events found for run matching "${arg}".`);
      } else {
        printEvents(events);
      }
      return;
    }
    const limit = parseInt(arg, 10) || 50;
    const events = getRecentEvents(limit);
    printEvents(events);
    return;
  }

  if (group === "probe") {
    const agentId = args[1];
    const asJson = args.includes("--json");
    if (!agentId) {
      process.stderr.write("Missing agent-id.\n");
      process.exit(1);
    }

    const db = getDb();
    const pendingRows = db.prepare(
      `SELECT s.run_id as runId, s.step_id as stepId, r.created_at as runCreatedAt, r.task as task
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE s.agent_id = ? AND s.status = 'pending' AND r.status = 'running'
       ORDER BY r.created_at ASC, s.step_index ASC`
    ).all(agentId) as Array<{ runId: string; stepId: string; runCreatedAt: string; task: string }>;

    const runningRows = db.prepare(
      `SELECT s.run_id as runId, s.step_id as stepId, r.created_at as runCreatedAt
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE s.agent_id = ? AND s.status = 'running' AND r.status = 'running'
       ORDER BY r.created_at ASC, s.step_index ASC`
    ).all(agentId) as Array<{ runId: string; stepId: string; runCreatedAt: string }>;

    const workflowPrefix = agentId.includes("/") ? `antfarm/${agentId}` : `antfarm/${agentId}`;
    let cron: {
      found: boolean;
      enabled?: boolean;
      name?: string;
      id?: string;
      nextRunAt?: string;
      lastRunAt?: string;
      lastStatus?: string;
      lastError?: string;
      error?: string;
    } = { found: false };

    try {
      const cronResult = await listCronJobs();
      if (cronResult.ok && cronResult.jobs) {
        const matched = cronResult.jobs.find((job) => job.name === workflowPrefix);
        if (matched) {
          const job = matched as any;
          cron = {
            found: true,
            enabled: Boolean(job.enabled),
            name: job.name,
            id: job.id,
            nextRunAt: typeof job.state?.nextRunAtMs === "number" ? new Date(job.state.nextRunAtMs).toISOString() : undefined,
            lastRunAt: typeof job.state?.lastRunAtMs === "number" ? new Date(job.state.lastRunAtMs).toISOString() : undefined,
            lastStatus: typeof job.state?.lastStatus === "string" ? job.state.lastStatus : undefined,
            lastError: typeof job.state?.lastError === "string" ? job.state.lastError : undefined,
          };
        }
      } else {
        cron = { found: false, error: cronResult.error ?? "cron list failed" };
      }
    } catch (err) {
      cron = { found: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Probe fallback: direct OpenClaw CLI read for full cron state (helps when /tools/invoke list is partial).
    if (!cron.found) {
      try {
        const raw = execFileSync(
          "node",
          ["/app/dist/index.js", "cron", "list", "--json"],
          { encoding: "utf8", env: { ...process.env, OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT ?? "18789" } },
        );
        const parsed = JSON.parse(raw);
        const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
        const job = jobs.find((entry: any) => entry?.name === workflowPrefix);
        if (job) {
          cron = {
            found: true,
            enabled: Boolean(job.enabled),
            name: job.name,
            id: job.id,
            nextRunAt: typeof job.state?.nextRunAtMs === "number" ? new Date(job.state.nextRunAtMs).toISOString() : undefined,
            lastRunAt: typeof job.state?.lastRunAtMs === "number" ? new Date(job.state.lastRunAtMs).toISOString() : undefined,
            lastStatus: typeof job.state?.lastStatus === "string" ? job.state.lastStatus : undefined,
            lastError: typeof job.state?.lastError === "string" ? job.state.lastError : undefined,
          };
        }
      } catch {
        // Keep existing scheduler error state.
      }
    }

    const report = {
      agentId,
      timestamp: new Date().toISOString(),
      claimableNow: pendingRows.length > 0,
      queueDepth: pendingRows.length,
      runningCount: runningRows.length,
      oldestPending: pendingRows[0]
        ? {
            runId: pendingRows[0].runId,
            stepId: pendingRows[0].stepId,
            runCreatedAt: pendingRows[0].runCreatedAt,
            taskPreview: pendingRows[0].task.slice(0, 120),
            aheadInQueue: 0,
          }
        : null,
      upcomingQueue: pendingRows.slice(0, 10).map((row, index) => ({
        queuePos: index + 1,
        runId: row.runId,
        stepId: row.stepId,
        runCreatedAt: row.runCreatedAt,
        taskPreview: row.task.slice(0, 120),
      })),
      scheduler: cron,
    };

    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }

    const lines = [
      `Agent: ${report.agentId}`,
      `Time: ${report.timestamp}`,
      `Claimable now: ${report.claimableNow ? "yes" : "no"}`,
      `Queue depth: ${report.queueDepth}`,
      `Currently running steps: ${report.runningCount}`,
      "",
      "Scheduler:",
      `  Found: ${report.scheduler.found ? "yes" : "no"}`,
      `  Name: ${report.scheduler.name ?? "-"}`,
      `  Enabled: ${report.scheduler.enabled === undefined ? "-" : report.scheduler.enabled ? "yes" : "no"}`,
      `  Next wake: ${report.scheduler.nextRunAt ?? "-"}`,
      `  Last run: ${report.scheduler.lastRunAt ?? "-"}`,
      `  Last status: ${report.scheduler.lastStatus ?? "-"}`,
      `  Last error: ${report.scheduler.lastError ?? report.scheduler.error ?? "-"}`,
      "",
      "Queue (oldest first):",
    ];
    if (report.upcomingQueue.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const item of report.upcomingQueue) {
        lines.push(`  #${item.queuePos} ${item.runId.slice(0, 8)} ${item.stepId} ${item.runCreatedAt} ${item.taskPreview}`);
      }
      if (report.queueDepth > report.upcomingQueue.length) {
        lines.push(`  ... +${report.queueDepth - report.upcomingQueue.length} more`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  if (args.length < 2) { printUsage(); process.exit(1); }
  if (group !== "workflow") { printUsage(); process.exit(1); }

  if (action === "runs") {
    const runs = listRuns();
    if (runs.length === 0) { console.log("No workflow runs found."); return; }
    console.log("Workflow runs:");
    for (const r of runs) {
      console.log(`  [${r.status.padEnd(9)}] ${r.id.slice(0, 8)}  ${r.workflow_id.padEnd(14)}  ${r.task.slice(0, 50)}${r.task.length > 50 ? "..." : ""}`);
    }
    return;
  }

  if (action === "list") {
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) { process.stdout.write("No workflows available.\n"); } else {
      process.stdout.write("Available workflows:\n");
      for (const w of workflows) process.stdout.write(`  ${w}\n`);
    }
    return;
  }

  if (action === "cleanup-stale") {
    const dryRun = args.includes("--dry-run");
    const minutesIdx = args.indexOf("--minutes");
    let minutesOverride: number | undefined;
    if (minutesIdx !== -1) {
      const raw = args[minutesIdx + 1];
      const parsed = Number(raw);
      if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
        process.stderr.write("Invalid --minutes value. Use a positive number.\n");
        process.exit(1);
      }
      minutesOverride = parsed;
    }

    const workflowId = target && !target.startsWith("--") ? target : undefined;
    const thresholdMs = getStaleThresholdMs(minutesOverride);
    const nowMs = Date.now();
    const thresholdMinutes = Math.floor(thresholdMs / 60_000);
    const db = getDb();

    const runs = db.prepare(
      `SELECT id, workflow_id, task, created_at, updated_at
       FROM runs
       WHERE status = 'running'
         AND (? IS NULL OR workflow_id = ?)
       ORDER BY created_at ASC`
    ).all(workflowId ?? null, workflowId ?? null) as Array<{
      id: string;
      workflow_id: string;
      task: string;
      created_at: string;
      updated_at: string;
    }>;

    const staleRuns: Array<{
      id: string;
      workflowId: string;
      task: string;
      staleMinutes: number;
      stepId: string | null;
      agentId: string | null;
    }> = [];

    for (const run of runs) {
      const stepMeta = db.prepare(
        `SELECT
           MAX(updated_at) AS max_updated_at,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_steps
         FROM steps
         WHERE run_id = ?`
      ).get(run.id) as { max_updated_at: string | null; running_steps: number | null };

      const activeStep = db.prepare(
        `SELECT step_id, agent_id
         FROM steps
         WHERE run_id = ? AND status IN ('pending', 'running')
         ORDER BY step_index ASC
         LIMIT 1`
      ).get(run.id) as { step_id: string; agent_id: string } | undefined;

      const lastActivityMs = Math.max(
        parseUtcTimestamp(run.created_at),
        parseUtcTimestamp(run.updated_at),
        parseUtcTimestamp(stepMeta.max_updated_at),
      );

      if (lastActivityMs <= 0) continue;
      const runningSteps = stepMeta.running_steps ?? 0;
      const ageMs = nowMs - lastActivityMs;
      if (runningSteps === 0 && ageMs > thresholdMs) {
        staleRuns.push({
          id: run.id,
          workflowId: run.workflow_id,
          task: run.task,
          staleMinutes: Math.floor(ageMs / 60_000),
          stepId: activeStep?.step_id ?? null,
          agentId: activeStep?.agent_id ?? null,
        });
      }
    }

    if (staleRuns.length === 0) {
      console.log(`No stale running runs found (threshold: ${thresholdMinutes}m).`);
      return;
    }

    if (dryRun) {
      console.log(`Dry run: ${staleRuns.length} stale run(s) would be failed (threshold: ${thresholdMinutes}m):`);
      for (const run of staleRuns) {
        const step = run.stepId ? `${run.stepId} (${run.agentId ?? "unknown-agent"})` : "none";
        console.log(`  - ${run.id.slice(0, 8)}  ${run.workflowId}  stale=${run.staleMinutes}m  step=${step}  task=${run.task.slice(0, 80)}`);
      }
      return;
    }

    const cleanedWorkflows = new Set<string>();
    const timestamp = new Date().toISOString();
    db.exec("BEGIN");
    try {
      for (const run of staleRuns) {
        const reason = `Cleanup-stale: auto-failed after ${run.staleMinutes} minutes without active step progress`;
        db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'running'")
          .run(timestamp, run.id);
        db.prepare(
          "UPDATE steps SET status = 'failed', output = COALESCE(output, ?), updated_at = ? WHERE run_id = ? AND status IN ('waiting','pending','running')"
        ).run(reason, timestamp, run.id);
        cleanedWorkflows.add(run.workflowId);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    for (const run of staleRuns) {
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.failed",
        runId: run.id,
        workflowId: run.workflowId,
        detail: `Cleanup-stale failed run after ${run.staleMinutes} minutes of inactivity`,
      });
      await logger.warn("Cleanup-stale failed run", { workflowId: run.workflowId, runId: run.id });
    }

    for (const workflow of cleanedWorkflows) {
      try {
        await teardownWorkflowCronsIfIdle(workflow);
      } catch {
        // best-effort cleanup
      }
    }

    console.log(`Cleaned ${staleRuns.length} stale run(s) (threshold: ${thresholdMinutes}m):`);
    for (const run of staleRuns) {
      const step = run.stepId ? `${run.stepId} (${run.agentId ?? "unknown-agent"})` : "none";
      console.log(`  - ${run.id.slice(0, 8)}  ${run.workflowId}  stale=${run.staleMinutes}m  step=${step}`);
    }
    return;
  }

  if (!target) { printUsage(); process.exit(1); }

  if (action === "install") {
    const result = await installWorkflow({ workflowId: target });
    process.stdout.write(`Installed workflow: ${result.workflowId}\nAgent crons will start when a run begins.\n`);
    process.stdout.write(`\nStart with: antfarm workflow run ${result.workflowId} "your task"\n`);
    return;
  }

  if (action === "uninstall") {
    const force = args.includes("--force");
    const isAll = target === "--all" || target === "all";
    const activeRuns = checkActiveRuns(isAll ? undefined : target);
    if (activeRuns.length > 0 && !force) {
      process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`);
      for (const run of activeRuns) {
        process.stderr.write(`  - ${run.id} (${run.workflow_id}): ${run.task}\n`);
      }
      process.stderr.write(`\nUse --force to uninstall anyway.\n`);
      process.exit(1);
    }
    if (isAll) { await uninstallAllWorkflows(); } else { await uninstallWorkflow({ workflowId: target }); }
    return;
  }

  if (action === "status") {
    const query = args.slice(2).join(" ").trim();
    if (!query) { process.stderr.write("Missing search query.\n"); printUsage(); process.exit(1); }
    const result = getWorkflowStatus(query);
    if (result.status === "not_found") { process.stdout.write(`${result.message}\n`); return; }
    const { run, steps } = result;
    const lines = [
      `Run: ${run.id}`,
      `Workflow: ${run.workflow_id}`,
      `Task: ${run.task.slice(0, 120)}${run.task.length > 120 ? "..." : ""}`,
      `Status: ${run.status}`,
      `Created: ${run.created_at}`,
      `Updated: ${run.updated_at}`,
      "",
      "Steps:",
      ...steps.map((s) => `  [${s.status}] ${s.step_id} (${s.agent_id})`),
    ];
    const stories = getStories(run.id);
    if (stories.length > 0) {
      const done = stories.filter((s) => s.status === "done").length;
      const running = stories.filter((s) => s.status === "running").length;
      const failed = stories.filter((s) => s.status === "failed").length;
      lines.push("", `Stories: ${done}/${stories.length} done${running ? `, ${running} running` : ""}${failed ? `, ${failed} failed` : ""}`);
      for (const s of stories) {
        lines.push(`  ${s.storyId.padEnd(8)} [${s.status.padEnd(7)}] ${s.title}`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  if (action === "resume") {
    if (!target) { process.stderr.write("Missing run-id.\n"); printUsage(); process.exit(1); }
    const db = (await import("../db.js")).getDb();

    // Find the run (support prefix match)
    const run = db.prepare(
      "SELECT id, workflow_id, status FROM runs WHERE id = ? OR id LIKE ?"
    ).get(target, `${target}%`) as { id: string; workflow_id: string; status: string } | undefined;

    if (!run) { process.stderr.write(`Run not found: ${target}\n`); process.exit(1); }
    if (run.status !== "failed") {
      process.stderr.write(`Run ${run.id.slice(0, 8)} is "${run.status}", not "failed". Nothing to resume.\n`);
      process.exit(1);
    }

    // Find the failed step (or first non-done step)
    const failedStep = db.prepare(
      "SELECT id, step_id, type, current_story_id FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1"
    ).get(run.id) as { id: string; step_id: string; type: string; current_story_id: string | null } | undefined;

    if (!failedStep) {
      process.stderr.write(`No failed step found in run ${run.id.slice(0, 8)}.\n`);
      process.exit(1);
    }

    // If it's a loop step with a failed story, reset that story to pending
    if (failedStep.type === "loop") {
      const failedStory = db.prepare(
        "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' ORDER BY story_index ASC LIMIT 1"
      ).get(run.id) as { id: string } | undefined;
      if (failedStory) {
        db.prepare(
          "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
        ).run(failedStory.id);
      }
    }

    // Check if the failed step is a verify step linked to a loop step's verify_each
    const loopStep = db.prepare(
      "SELECT id, loop_config FROM steps WHERE run_id = ? AND type = 'loop' AND status IN ('running', 'failed') LIMIT 1"
    ).get(run.id) as { id: string; loop_config: string | null } | undefined;

    if (loopStep?.loop_config) {
      const lc = JSON.parse(loopStep.loop_config);
      if (lc.verifyEach && lc.verifyStep === failedStep.step_id) {
        // Reset the loop step (developer) to pending so it re-claims the story and populates context
        db.prepare(
          "UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(loopStep.id);
        // Reset verify step to waiting (fires after developer completes)
        db.prepare(
          "UPDATE steps SET status = 'waiting', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(failedStep.id);
        // Reset any failed stories to pending
        db.prepare(
          "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE run_id = ? AND status = 'failed'"
        ).run(run.id);

        // Reset run to running
        db.prepare(
          "UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(run.id);

        // Ensure crons are running for this workflow
        const { loadWorkflowSpec } = await import("../installer/workflow-spec.js");
        const { resolveWorkflowDir } = await import("../installer/paths.js");
        const { ensureWorkflowCrons } = await import("../installer/agent-cron.js");
        try {
          const workflowDir = resolveWorkflowDir(run.workflow_id);
          const workflow = await loadWorkflowSpec(workflowDir);
          await ensureWorkflowCrons(workflow);
        } catch (err) {
          process.stderr.write(`Warning: Could not start crons: ${err instanceof Error ? err.message : String(err)}\n`);
        }

        console.log(`Resumed run ${run.id.slice(0, 8)} — reset loop step "${loopStep.id.slice(0, 8)}" to pending, verify step "${failedStep.step_id}" to waiting`);
        process.exit(0);
      }
    }

    // Reset step to pending
    db.prepare(
      "UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(failedStep.id);

    // Reset run to running
    db.prepare(
      "UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?"
    ).run(run.id);

    // Ensure crons are running for this workflow
    const { loadWorkflowSpec } = await import("../installer/workflow-spec.js");
    const { resolveWorkflowDir } = await import("../installer/paths.js");
    const { ensureWorkflowCrons } = await import("../installer/agent-cron.js");
    try {
      const workflowDir = resolveWorkflowDir(run.workflow_id);
      const workflow = await loadWorkflowSpec(workflowDir);
      await ensureWorkflowCrons(workflow);
    } catch (err) {
      process.stderr.write(`Warning: Could not start crons: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    console.log(`Resumed run ${run.id.slice(0, 8)} from step "${failedStep.step_id}"`);
    return;
  }

  if (action === "run") {
    let notifyUrl: string | undefined;
    let allowConcurrent = false;
    const runArgs = args.slice(3);
    const nuIdx = runArgs.indexOf("--notify-url");
    if (nuIdx !== -1) {
      notifyUrl = runArgs[nuIdx + 1];
      runArgs.splice(nuIdx, 2);
    }
    const acIdx = runArgs.indexOf("--allow-concurrent");
    if (acIdx !== -1) {
      allowConcurrent = true;
      runArgs.splice(acIdx, 1);
    }
    const taskTitle = runArgs.join(" ").trim();
    if (!taskTitle) { process.stderr.write("Missing task title.\n"); printUsage(); process.exit(1); }
    const run = await runWorkflow({ workflowId: target, taskTitle, notifyUrl, allowConcurrent });
    process.stdout.write(
      [`Run: ${run.id}`, `Workflow: ${run.workflowId}`, `Task: ${run.task}`, `Status: ${run.status}`].join("\n") + "\n",
    );
    return;
  }

  process.stderr.write(`Unknown action: ${action}\n`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
