import { createAgentCronJob, deleteAgentCronJobs, listCronJobs, checkCronToolAvailable } from "./gateway-api.js";
import type { WorkflowSpec } from "./types.js";
import { getDb } from "../db.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAntfarmCli, resolveOpenClawStateDir } from "./paths.js";

const DEFAULT_EVERY_MS = 300_000; // 5 minutes
const DEFAULT_AGENT_TIMEOUT_SECONDS = 30 * 60; // 30 minutes

function buildAgentPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Check for pending work and execute it.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

Step 1 — Check for pending work:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`

If output is "NO_WORK", reply HEARTBEAT_OK and stop.

Step 2 — If JSON is returned, it contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Step 3 — Do the work described in the input. Format your output with KEY: value lines as specified.

Step 4 — MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

export function buildWorkPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Execute the pending work below.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

The claimed step JSON is provided below. It contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Do the work described in the input. Format your output with KEY: value lines as specified.

MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

const DEFAULT_POLLING_TIMEOUT_SECONDS = 120;
const DEFAULT_POLLING_MODEL = "default";

export function buildPollingPrompt(workflowId: string, agentId: string, workModel?: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();
  const model = typeof workModel === "string" && workModel.trim().length > 0 ? workModel.trim() : null;
  const workPrompt = buildWorkPrompt(workflowId, agentId);
  const spawnParams = model
    ? `Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- model: "${model}"
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.`
    : `Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.

IMPORTANT: Do not pass a model parameter when spawning. Let the agent default model apply.`;

  return `Step 1 — Quick check for pending work (lightweight, no side effects):
\`\`\`
node ${cli} step peek "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop immediately. Do NOT run step claim.

Step 2 — If "HAS_WORK", claim the step:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop.

If JSON is returned, parse it to extract stepId, runId, and input fields.
${spawnParams}

Full work prompt to include in the spawned task:
---START WORK PROMPT---
${workPrompt}
---END WORK PROMPT---

Reply with a short summary of what you spawned.`;
}

function buildWorkflowPollingPrompt(workflowId: string, agents: WorkflowSpec["agents"]): string {
  const cli = resolveAntfarmCli();
  const intro = `You are the Antfarm workflow cron driver.

Process agents in order and spawn at most ONE worker session in this run.
Stop immediately after the first successful sessions_spawn.
If no agent has work, reply HEARTBEAT_OK.`;

  const blocks = agents
    .map((agent, idx) => {
      const fullAgentId = `${workflowId}_${agent.id}`;
      const model = typeof agent.model === "string" && agent.model.trim().length > 0 ? agent.model.trim() : null;
      const workPrompt = buildWorkPrompt(workflowId, agent.id);
      const spawnParams = model
        ? `Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- model: "${model}"
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.`
        : `Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.

IMPORTANT: Do not pass a model parameter when spawning. Let the agent default model apply.`;
      return `Agent ${idx + 1}/${agents.length}: "${fullAgentId}"
Step 1 — Quick check for pending work:
\`\`\`
node ${cli} step peek "${fullAgentId}"
\`\`\`
If output is "NO_WORK", continue to the next agent.

Step 2 — If "HAS_WORK", claim the step:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`
If output is "NO_WORK", continue to the next agent.

If JSON is returned, parse it to extract stepId, runId, and input fields.
${spawnParams}

Full work prompt to include in the spawned task:
---START WORK PROMPT---
${workPrompt}
---END WORK PROMPT---

After a successful spawn, reply with a short summary and STOP. Do not process further agents this run.

If this agent had no work (or claim returned NO_WORK), continue to next agent.`;
    })
    .join("\n\n");

  return `${intro}

${blocks}

If no sessions were spawned for any agent, reply HEARTBEAT_OK.`;
}

export async function setupAgentCrons(workflow: WorkflowSpec): Promise<void> {
  const agents = workflow.agents;
  if (agents.length === 0) {
    throw new Error(`Workflow "${workflow.id}" has no agents to schedule.`);
  }
  // Allow per-workflow cron interval via cron.interval_ms in workflow.yml
  const everyMs = (workflow as any).cron?.interval_ms ?? DEFAULT_EVERY_MS;

  // Resolve polling model at workflow level for the single driver cron.
  const workflowPollingModel = workflow.polling?.model ?? DEFAULT_POLLING_MODEL;
  const workflowPollingTimeout = workflow.polling?.timeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS;
  const prompt = buildWorkflowPollingPrompt(workflow.id, agents);
  const timeoutSeconds = workflowPollingTimeout;
  const payload: { kind: "agentTurn"; message: string; timeoutSeconds: number; model?: string } = {
    kind: "agentTurn",
    message: prompt,
    timeoutSeconds,
  };
  if (workflowPollingModel && workflowPollingModel !== "default") {
    payload.model = workflowPollingModel;
  }

  const cronName = `antfarm/${workflow.id}/driver`;
  const agentId = `${workflow.id}_${agents[0].id}`;
  const result = await createAgentCronJob({
    name: cronName,
    schedule: { kind: "every", everyMs, anchorMs: Date.now() },
    sessionTarget: "isolated",
    agentId,
    payload,
    delivery: { mode: "none" },
    enabled: true,
  });

  if (!result.ok) {
    throw new Error(`Failed to create workflow driver cron for "${workflow.id}": ${result.error}`);
  }
  await forceWorkflowWakeModeNow(workflow.id);
}

export async function removeAgentCrons(workflowId: string): Promise<void> {
  await deleteAgentCronJobs(`antfarm/${workflowId}/`);
}

async function forceWorkflowWakeModeNow(workflowId: string): Promise<void> {
  const cronPath = path.join(resolveOpenClawStateDir(), "cron", "jobs.json");
  try {
    const raw = await fs.readFile(cronPath, "utf-8");
    const parsed = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.jobs)) return;
    let changed = false;
    const prefix = `antfarm/${workflowId}/`;
    for (const job of parsed.jobs) {
      const name = String(job.name ?? "");
      if (!name.startsWith(prefix)) continue;
      if (job.wakeMode !== "now") {
        job.wakeMode = "now";
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(cronPath, JSON.stringify(parsed, null, 2));
    }
  } catch {
    // Non-fatal: if we cannot normalize wake mode, cron jobs still exist.
  }
}

// ── Run-scoped cron lifecycle ───────────────────────────────────────

/**
 * Count active (running) runs for a given workflow.
 */
function countActiveRuns(workflowId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE workflow_id = ? AND status = 'running'"
  ).get(workflowId) as { cnt: number };
  return row.cnt;
}

/**
 * Check if crons already exist for a workflow.
 */
async function workflowCronsExist(workflowId: string): Promise<boolean> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return false;
  const prefix = `antfarm/${workflowId}/`;
  return result.jobs.some((j) => j.name.startsWith(prefix));
}

/**
 * Start crons for a workflow when a run begins.
 * No-ops if crons already exist (another run of the same workflow is active).
 */
export async function ensureWorkflowCrons(workflow: WorkflowSpec): Promise<void> {
  if (await workflowCronsExist(workflow.id)) return;

  // Preflight: verify cron tool is accessible before attempting to create jobs
  const preflight = await checkCronToolAvailable();
  if (!preflight.ok) {
    throw new Error(preflight.error!);
  }

  await setupAgentCrons(workflow);
}

/**
 * Tear down crons for a workflow when a run ends.
 * Only removes if no other active runs exist for this workflow.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  const active = countActiveRuns(workflowId);
  if (active > 0) return;
  await removeAgentCrons(workflowId);
}
