import crypto from "node:crypto";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";

const DEFAULT_STALE_ACTIVE_RUN_MINUTES = 120;

function parseUtcTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  if (value.includes("T")) return Date.parse(value);
  return Date.parse(value.replace(" ", "T") + "Z");
}

function getStaleActiveRunThresholdMs(): number {
  const raw = process.env.ANTFARM_STALE_ACTIVE_RUN_MINUTES;
  if (!raw) return DEFAULT_STALE_ACTIVE_RUN_MINUTES * 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_ACTIVE_RUN_MINUTES * 60_000;
  return Math.floor(parsed * 60_000);
}

export async function runWorkflow(params: {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  allowConcurrent?: boolean;
}): Promise<{ id: string; workflowId: string; task: string; status: string }> {
  const workflowDir = resolveWorkflowDir(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();

  if (!params.allowConcurrent) {
    const activeRun = db.prepare(
      `SELECT
         r.id,
         r.created_at,
         r.updated_at AS run_updated_at,
         (
           SELECT s2.step_id
           FROM steps s2
           WHERE s2.run_id = r.id AND s2.status IN ('pending', 'running')
           ORDER BY s2.step_index ASC
           LIMIT 1
         ) AS step_id,
         (
           SELECT s2.agent_id
           FROM steps s2
           WHERE s2.run_id = r.id AND s2.status IN ('pending', 'running')
           ORDER BY s2.step_index ASC
           LIMIT 1
         ) AS agent_id,
         (
           SELECT MAX(s2.updated_at)
           FROM steps s2
           WHERE s2.run_id = r.id
         ) AS step_updated_at,
         (
           SELECT COUNT(*)
           FROM steps s2
           WHERE s2.run_id = r.id AND s2.status = 'running'
         ) AS running_steps
       FROM runs r
       WHERE r.workflow_id = ? AND r.status = 'running'
       ORDER BY r.created_at ASC
       LIMIT 1`
    ).get(workflow.id) as
      | {
          id: string;
          created_at: string;
          run_updated_at: string;
          step_id: string | null;
          agent_id: string | null;
          step_updated_at: string | null;
          running_steps: number;
        }
      | undefined;

    if (activeRun) {
      const nowMs = Date.now();
      const staleThresholdMs = getStaleActiveRunThresholdMs();
      const lastActivityMs = Math.max(
        parseUtcTimestamp(activeRun.created_at),
        parseUtcTimestamp(activeRun.run_updated_at),
        parseUtcTimestamp(activeRun.step_updated_at),
      );
      const isStale = activeRun.running_steps === 0 && lastActivityMs > 0 && (nowMs - lastActivityMs) > staleThresholdMs;

      if (isStale) {
        const staleMinutes = Math.floor((nowMs - lastActivityMs) / 60_000);
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), activeRun.id);
          db.prepare(
            "UPDATE steps SET status = 'failed', output = COALESCE(output, ?), updated_at = ? WHERE run_id = ? AND status IN ('waiting','pending','running')",
          ).run(
            `Auto-failed stale run after ${staleMinutes} minutes without progress`,
            new Date().toISOString(),
            activeRun.id,
          );
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }

        emitEvent({
          ts: new Date().toISOString(),
          event: "run.failed",
          runId: activeRun.id,
          workflowId: workflow.id,
          detail: `Auto-recovered stale active run after ${staleMinutes} minutes without progress`,
        });
        await logger.warn("Auto-failed stale active run", {
          workflowId: workflow.id,
          runId: activeRun.id,
        });
      } else {
      const activeStep = activeRun.step_id
        ? `${activeRun.step_id} (${activeRun.agent_id ?? "unknown-agent"})`
        : "unknown";
      throw new Error(
        `Workflow "${workflow.id}" already has an active run (${activeRun.id.slice(0, 8)}), currently at step ${activeStep}. ` +
        `Wait for completion or use --allow-concurrent to queue another run.`,
      );
      }
    }
  }

  const initialContext: Record<string, string> = {
    task: params.taskTitle,
    ...workflow.context,
  };

  db.exec("BEGIN");
  try {
    const notifyUrl = params.notifyUrl ?? workflow.notifications?.url ?? null;
    const insertRun = db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, notify_url, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)"
    );
    insertRun.run(runId, workflow.id, params.taskTitle, JSON.stringify(initialContext), notifyUrl, now, now);

    const insertStep = db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const stepUuid = crypto.randomUUID();
      const agentId = `${workflow.id}/${step.agent}`;
      const status = i === 0 ? "pending" : "waiting";
      const maxRetries = step.max_retries ?? step.on_fail?.max_retries ?? 2;
      const stepType = step.type ?? "single";
      const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
      insertStep.run(stepUuid, runId, step.id, agentId, i, step.input, step.expects, status, maxRetries, stepType, loopConfig, now, now);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Start crons for this workflow (no-op if already running from another run)
  try {
    await ensureWorkflowCrons(workflow);
  } catch (err) {
    // Roll back the run since it can't advance without crons
    const db2 = getDb();
    db2.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot start workflow run: cron setup failed. ${message}`);
  }

  emitEvent({ ts: new Date().toISOString(), event: "run.started", runId, workflowId: workflow.id });

  await logger.info(`Run started: "${params.taskTitle}"`, {
    workflowId: workflow.id,
    runId,
    stepId: workflow.steps[0]?.id,
  });

  return { id: runId, workflowId: workflow.id, task: params.taskTitle, status: "running" };
}
