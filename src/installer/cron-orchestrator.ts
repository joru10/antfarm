/**
 * Cron-based orchestration for Antfarm workflows.
 * 
 * When a workflow is installed, we register a cron job that periodically
 * checks for active runs and advances them. The cron job runs in an isolated
 * OpenClaw session with full tool access, including sessions_spawn.
 */

import { getNextStep, completeStep } from "./step-runner.js";
import { listWorkflowRuns } from "./run-store.js";
import type { WorkflowRunRecord } from "./types.js";

/**
 * Generate the cron job configuration for a workflow.
 */
export function generateCronConfig(workflowId: string): {
  name: string;
  schedule: { kind: "every"; everyMs: number };
  payload: { kind: "agentTurn"; message: string };
  sessionTarget: "isolated";
  enabled: boolean;
} {
  return {
    name: `antfarm-${workflowId}-orchestrator`,
    schedule: {
      kind: "every",
      everyMs: 30000, // Every 30 seconds
    },
    payload: {
      kind: "agentTurn",
      message: `You are the Antfarm workflow orchestrator for "${workflowId}".

Check for active workflow runs and advance them:

1. Run: antfarm daemon once --verbose
2. Check the spawn queue: antfarm daemon queue
3. For each spawn request, use sessions_spawn to start the agent:
   - agentId: (from request)
   - task: (from request)
   - label: (from request)
4. After spawning, dequeue: antfarm daemon dequeue <filename>

If no active runs or spawn requests, reply: HEARTBEAT_OK

Keep responses brief. Only report errors or significant state changes.`,
    },
    sessionTarget: "isolated",
    enabled: true,
  };
}

/**
 * Generate a simpler orchestration prompt for direct execution.
 * This is used when the cron job runs the orchestration logic.
 */
export function generateOrchestrationPrompt(workflowId: string): string {
  return `Antfarm orchestrator for workflow "${workflowId}".

1. Check active runs: Look for workflows in "running" status
2. For each active run:
   - Get next step info
   - Check if agent session exists and completed
   - If completed, advance workflow
   - If not started, spawn the agent
3. Report any errors or blocked workflows

Use the antfarm CLI and sessions_spawn tool as needed.
Reply HEARTBEAT_OK if nothing needs attention.`;
}

/**
 * Format spawn request for agent execution.
 */
export function formatSpawnInstruction(request: {
  agentId: string;
  task: string;
  sessionLabel: string;
  file: string;
}): string {
  return `Spawn request pending:
- Agent: ${request.agentId}
- Label: ${request.sessionLabel}
- Task: ${request.task.slice(0, 200)}${request.task.length > 200 ? "..." : ""}

Use sessions_spawn with these parameters, then run:
antfarm daemon dequeue ${request.file}`;
}
