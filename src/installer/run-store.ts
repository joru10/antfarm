import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowRunRecord } from "./types.js";
import { resolveRunRoot } from "./paths.js";

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function listWorkflowRuns(): Promise<WorkflowRunRecord[]> {
  const root = resolveRunRoot();
  try {
    const entries = await fs.readdir(root);
    const runs: WorkflowRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(root, entry);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        runs.push(JSON.parse(raw) as WorkflowRunRecord);
      } catch {
        // Skip malformed entries.
      }
    }
    return runs;
  } catch {
    return [];
  }
}

export async function writeWorkflowRun(record: WorkflowRunRecord): Promise<void> {
  const root = resolveRunRoot();
  await ensureDir(root);
  const filePath = path.join(root, `${record.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

export function normalizeTitle(value: string): string {
  return value.trim().toLowerCase();
}

export async function findRunByTaskTitle(taskTitle: string): Promise<WorkflowRunRecord | null> {
  const normalized = normalizeTitle(taskTitle);
  const runs = await listWorkflowRuns();
  const match = runs.find((run) => normalizeTitle(run.taskTitle) === normalized);
  return match ?? null;
}

// Alias for step-runner compatibility
export const readWorkflowRun = findRunByTaskTitle;
