import crypto from "node:crypto";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";

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
      `SELECT r.id, r.created_at, s.step_id, s.agent_id
       FROM runs r
       LEFT JOIN steps s ON s.run_id = r.id AND s.status IN ('pending', 'running')
       WHERE r.workflow_id = ? AND r.status = 'running'
       ORDER BY r.created_at ASC
       LIMIT 1`
    ).get(workflow.id) as
      | { id: string; created_at: string; step_id: string | null; agent_id: string | null }
      | undefined;

    if (activeRun) {
      const activeStep = activeRun.step_id
        ? `${activeRun.step_id} (${activeRun.agent_id ?? "unknown-agent"})`
        : "unknown";
      throw new Error(
        `Workflow "${workflow.id}" already has an active run (${activeRun.id.slice(0, 8)}), currently at step ${activeStep}. ` +
        `Wait for completion or use --allow-concurrent to queue another run.`,
      );
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
