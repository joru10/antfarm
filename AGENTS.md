# Antfarm Agents

Antfarm provisions multi-agent workflows for OpenClaw. It installs workflow agent workspaces, wires agents into the OpenClaw config, and keeps a run record per task.

## Project Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 5.9
- **Module System**: ES2022 with NodeNext resolution
- **Build**: `npm run build` compiles src/ to dist/
- **Test Runner**: Node.js built-in with `--experimental-strip-types`

## Development Commands

```bash
# Build the project
npm run build

# Run a test file directly
node --experimental-strip-types tests/<test-file>.ts

# Typecheck tests
npx tsc -p tsconfig.tests.json
```

## Why Antfarm

- **Repeatable workflow execution**: Start the same set of agents with a consistent prompt and workspace every time.
- **Structured collaboration**: Each workflow defines roles (lead, developer, verifier, reviewer) and how they hand off work.
- **Traceable runs**: Runs are stored by task title so you can check status without hunting through logs.
- **Clean lifecycle**: Install, update, or uninstall workflows without manual cleanup.

## What it changes in OpenClaw

- Adds workflow agents to `openclaw.json`.
- Creates workflow workspaces under `~/.openclaw/workspaces/workflows`.
- Stores workflow definitions and run state under `~/.openclaw/antfarm`.
- Inserts an Antfarm guidance block into the main agent's `AGENTS.md` and `TOOLS.md`.

## Uninstalling

- `antfarm workflow uninstall <workflow-id>` removes the workflow's agents, workspaces, and run records.
- `antfarm workflow uninstall --all` wipes all Antfarm-installed workflows and their state.

If something fails, report the exact error and ask the user to resolve it before continuing.
