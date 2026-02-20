# opencode-commander

An orchestration system that dispatches AI coding agent tasks across multiple repositories using GitHub Issues as the communication layer, Podman containers as the execution environment, and opencode as the agent runtime.

## Problem

Running separate opencode instances in different directories is tedious. Skills, commands, and configurations drift between repos. There's no way to batch-dispatch work, prioritize tasks, or monitor agent progress from a single interface.

## Solution Overview

**opencode-commander** is a TypeScript service that:

1. Monitors GitHub repos (opted-in via topic) for issues labeled for agent work
2. Triages and queues tasks by priority (label-based)
3. Spins up Podman containers with Nix-managed dev environments
4. Runs opencode inside each container to complete the task
5. Creates PRs with the results
6. Handles human-in-the-loop via issue comments
7. Picks up PR review feedback and dispatches follow-up tasks

The user interacts with the system through opencode itself, via an MCP server that commander exposes.

## Architecture

```
                    You (opencode)
                         |
                    MCP Server API
                         |
               +--------------------+
               | opencode-commander |
               |   (orchestrator)   |
               +---------+----------+
                    |          |
          +---------+    +----+------+
          | GitHub   |    | Task     |
          | Poller   |    | Queue    |
          +----+-----+    +----+-----+
               |               |
               v               v
         GitHub Issues    +----------+
                          | Dispatch |
                          | Engine   |
                          +----+-----+
                               |
                    +----------+----------+
                    |          |          |
                 +--+--+   +--+--+   +--+--+
                 | Pod |   | Pod |   | Pod |
                 |  1  |   |  2  |   |  N  |
                 +--+--+   +--+--+   +--+--+
                    |          |          |
                 opencode   opencode   opencode
                    |          |          |
                   PRs       PRs       PRs
```

## Core Components

### 1. MCP Server Interface

The primary control plane. Exposes tools to opencode so you can manage commander from your normal workflow.

**Tools to expose:**
- `commander_status` -- show queue depth, running agents, container resource usage
- `commander_dispatch` -- manually dispatch a task to a specific repo
- `commander_queue` -- list/reorder the task queue
- `commander_pause` / `commander_resume` -- pause/resume processing
- `commander_logs` -- stream logs from a running agent container
- `commander_config` -- view/update commander configuration
- `commander_repos` -- list monitored repos, add/remove repos

### 2. GitHub Poller

Watches repos for actionable issues on a configurable interval (default: 30s).

**Repo discovery:** Repos opt-in by adding the GitHub topic `opencode-commander`. The poller uses the GitHub Search API to find all repos with this topic that the configured user has access to.

**Issue detection:**
- New issues with a trigger label (e.g., `agent` or `agent/ready`)
- PR review comments requesting changes on agent-created PRs (detected via `agent-pr` label on the PR)
- Issue comments that unblock a previously waiting task

**What it produces:** Normalized task objects pushed onto the queue.

### 3. Task Queue

A persistent, priority-ordered queue stored in SQLite (local file, easy to back up, no external dependencies).

**Task schema:**
- `id` -- unique task ID
- `github_issue_url` -- source issue
- `repo` -- owner/repo
- `title` -- issue title
- `body` -- issue body / review comment
- `priority` -- derived from GitHub labels (`priority/critical`, `priority/high`, `priority/medium`, `priority/low`)
- `status` -- `queued` | `dispatched` | `running` | `waiting_human` | `completed` | `failed`
- `created_at`, `updated_at`
- `attempts` -- retry count
- `parent_task_id` -- for follow-up tasks from PR reviews
- `container_id` -- assigned container (when running)
- `pr_url` -- resulting PR (when completed)

**Priority ordering:**
1. `priority/critical` -- preempt if no slots available
2. `priority/high`
3. `priority/medium` (default when no label)
4. `priority/low`

Within the same priority: FIFO.

### 4. Dispatch Engine

Manages the pool of Podman containers and assigns tasks to them.

**Container lifecycle:**
1. Task is dequeued
2. Container is created from a Nix-built image
3. Repo is cloned, branch `agent/<task-id>` created
4. `nix develop` runs to configure the project-specific environment
5. opencode is started in headless mode (`opencode serve`)
6. Task prompt is sent via the opencode SDK
7. Agent works until completion, failure, or human-input-needed
8. PR is created (on success), issue is updated, container is torn down

**Concurrency control:**
- Configurable max containers (default: 4, respects system resources)
- Adjustable at runtime via MCP tool
- Resource limits per container (CPU, memory) configurable

**Timeout and health monitoring:**
- Heartbeat check: poll opencode server health endpoint every 30s
- Task timeout: configurable per-priority (default: 30min for medium)
- Stuck detection: if no tool calls or file changes for 5 minutes, consider stuck

### 5. Agent Communication Protocol

How the orchestrator interacts with opencode inside each container.

**Sending work:**
```typescript
// Using opencode SDK
const client = createOpencodeClient({ baseUrl: containerUrl })
const session = await client.session.create({ body: { title: issueTitle } })
await client.session.prompt({
  path: { id: session.id },
  body: {
    parts: [{ type: "text", text: taskPrompt }],
  }
})
```

**Monitoring progress:**
- Subscribe to SSE events from the opencode server
- Watch for session status changes
- Detect when the agent uses the `question` tool (via events)

**Human-in-the-loop:**
When the agent needs human input (detected via the `question` tool or explicit signals):
1. Commander posts a comment on the GitHub issue with the agent's question
2. Task status changes to `waiting_human`
3. Container is kept alive (with a longer timeout)
4. When a human replies on the issue, the poller detects it
5. The response is forwarded to the opencode session
6. Task resumes

**PR Review feedback loop:**
When a reviewer requests changes on an agent-created PR:
1. Poller detects the review via polling
2. A new follow-up task is created, linked to the parent task
3. The follow-up task includes the review comments as context
4. A new container picks it up, checks out the existing PR branch, and addresses feedback

### 6. Container Environment

Each container is a reproducible Nix-built environment.

**Layers:**
1. **Base image** -- Nix-built OCI image with: git, opencode, podman-compatible entrypoint
2. **agentkit layer** -- Shared skills/commands configured via agentkit's Nix modules
3. **Project layer** -- Project-specific `flake.nix` with `nix develop` for language toolchains, LSPs, etc.

**Container startup sequence:**
```
1. op run -- podman create --env-file ... --mount ...
2. git clone <repo> /workspace && cd /workspace
3. git checkout -b agent/<task-id>
4. nix develop --command opencode serve --port 4096 --hostname 0.0.0.0
5. (orchestrator connects via SDK)
```

`nix develop` runs at container start rather than being baked into the image. This avoids needing a per-repo image build pipeline. Can be optimized with shared Nix store caching in a later milestone.

**Secrets injection:**
- `op run` injects LLM API keys and GitHub token as env vars at container start
- Nothing persisted to disk inside the container
- GitHub token scoped to repo-level access

**Networking:**
- Each container gets a mapped port for the opencode server
- Orchestrator communicates over `localhost:<mapped-port>`

### 7. Model Selection

Each repo's own `opencode.json` (or agentkit-managed config) determines which LLM model the agent uses. Commander does not override model selection -- this keeps configuration close to the code and avoids coupling the orchestrator to model choices.

## Task Prompt Construction

When dispatching a task, commander builds a structured prompt from the issue:

```
You are working on the repository {owner}/{repo}.

## Task
{issue title}

## Description
{issue body}

## Instructions
- You are on branch `agent/{task-id}`
- Make the changes described above
- Run any relevant tests
- Commit your changes and create a PR with a clear description

## Context
{any linked issues or PR review comments for follow-up tasks}
```

For PR review follow-ups, the prompt includes the original PR diff and the review comments.

## GitHub Issue Lifecycle

```
Issue Created (with "agent" label)
  -> [queued] -- commander adds comment: "Queued, position #N"
  -> [dispatched] -- container starting
  -> [running] -- comment: "Working on it..."
       |
       +-> needs input -> [waiting_human] -> comment with question
       |                       -> human replies -> [running]
       |
       +-> completes -> [completed] -> PR created, label "agent/done"
       |
       +-> fails -> [failed] -> comment with error, label "agent/failed"

PR gets "request changes" review
  -> new follow-up task [queued], linked to parent
```

## Configuration

```toml
[github]
poll_interval = "30s"
topic = "opencode-commander"
trigger_label = "agent"

[queue]
database = "~/.local/share/opencode-commander/queue.db"

[containers]
runtime = "podman"
max_concurrent = 4
cpu_limit = "2.0"
memory_limit = "4g"
task_timeout = "30m"
stuck_timeout = "5m"
base_image = "ghcr.io/ungood/opencode-commander-base:latest"

[secrets]
provider = "op"
vault = "Development"

[mcp]
port = 7070
```

## Path to MVP / Bootstrap

The goal is to reach a point where opencode-commander can receive an issue on its own repo and produce a PR that improves itself. Once that loop closes, every subsequent milestone can be partially built by the system.

### What "bootstrap" requires

Strip everything down to a single command:

```
commander run ungood/opencode-commander#12
```

This must:
1. Fetch the issue body from GitHub
2. Clone the repo into a Podman container
3. Create a branch, start opencode, send the task prompt
4. Wait for completion (or timeout)
5. Push the branch and create a PR
6. Print the PR URL

That's it. No queue, no polling, no MCP server, no priority system, no human-in-the-loop. Just: issue in, PR out.

### What you can skip for bootstrap

- **Task queue / SQLite** -- single task, no persistence needed
- **GitHub poller** -- you trigger manually
- **MCP server** -- CLI is the interface
- **Priority / triage** -- one task at a time
- **Human-in-the-loop** -- if it gets stuck, it fails and you read the logs
- **PR review loop** -- review manually, file a new issue if needed
- **Concurrency** -- one container at a time

### What you can't skip

- **Nix flake for the project** -- the repo itself needs a `flake.nix` with agentkit so the container can run `nix develop`
- **Container lifecycle** -- spawn, run, tear down a Podman container
- **opencode headless integration** -- start `opencode serve`, send a prompt via SDK, detect completion
- **GitHub API basics** -- fetch issue, push branch, create PR (can be `gh` CLI shelling out, doesn't need Octokit yet)
- **`op run` secrets injection** -- API keys need to get into the container

### Bootstrap implementation plan

**Step 1: Project scaffolding** -- DONE
- Created `ungood/opencode-commander` repo
- `flake.nix` with flake-parts, TypeScript toolchain, opencode, bun, gh, op
- `package.json` with bun, @opencode-ai/sdk, TypeScript
- `AGENTS.md` describing the project so opencode can work on it
- CLI skeleton, all core modules (cli, run, github, container, agent, log)
- Verified: `nix develop` gives a shell with opencode + bun + node, `bun run typecheck` passes

**Steps 2-5: remaining bootstrap work** -- see milestones below

### After bootstrap

Once the bootstrap loop works, subsequent milestones can be partially self-built. The workflow becomes:

1. File an issue describing the feature
2. Run `opencode-commander run ungood/opencode-commander#N`
3. Review the PR, merge or request changes
4. Repeat

## Agent-Sized Milestones

Each milestone below is scoped so that a single opencode agent session can complete it. They are ordered by dependency -- later milestones depend on earlier ones being merged.

### M0.1: Use the official opencode Docker image for containers

The current `container.ts` uses `nixos/nix:latest` as the base image and runs `nix develop` inside it to get opencode. This is slow and fragile. opencode publishes an official Docker image (`ghcr.io/anomalyco/opencode`) that already has the opencode binary. Switch to using that image directly, which eliminates the need for Nix inside the container for the bootstrap case. Keep `nix develop` as a future optimization for project-specific toolchains.

**Files:** `src/container.ts`
**Verify:** `bun run typecheck` passes. The container startup script should use the official image and run `opencode serve` directly.

### M0.2: Add a configuration module

Extract hardcoded values (container defaults, timeouts, image name, resource limits) into a `src/config.ts` module that loads from environment variables and/or a `commander.toml` config file. The run command and container module should read from this config instead of using inline defaults.

**Files:** `src/config.ts` (new), `src/run.ts`, `src/container.ts`, `src/cli.ts`, `package.json` (add toml parser dep)
**Verify:** `bun run typecheck` passes. Config values can be overridden via env vars (e.g. `COMMANDER_TIMEOUT=60`).

### M0.3: Add error handling and structured exit codes

Improve error handling across the codebase. Add specific error classes (e.g. `ContainerError`, `AgentError`, `GitHubError`) so failures are diagnosable. Ensure the CLI prints a clear summary on failure and exits with distinct codes (1=agent failure, 2=container failure, 3=github failure, etc).

**Files:** `src/errors.ts` (new), `src/cli.ts`, `src/run.ts`, `src/container.ts`, `src/agent.ts`, `src/github.ts`
**Verify:** `bun run typecheck` passes.

### M0.4: Handle git authentication inside containers

The container needs to authenticate with GitHub to clone private repos and push branches. Add logic to pass the `GITHUB_TOKEN` env var into the container and configure git to use it for HTTPS auth (via `git credential helper` or URL rewriting). Test that the startup script can clone a repo and push a branch.

**Files:** `src/container.ts`
**Verify:** `bun run typecheck` passes. The startup script configures `git config credential.helper` or uses `https://<token>@github.com` URL scheme.

### M0.5: Add an integration test harness

Create a test script that validates the end-to-end flow without needing a real GitHub issue. It should: (1) create a container with a small test repo, (2) start opencode, (3) send a trivial prompt ("create hello.txt"), (4) verify the file was created, (5) tear down. Use Bun's built-in test runner.

**Files:** `tests/integration.test.ts` (new), `package.json` (add test script)
**Verify:** `bun test` runs the integration test (may require podman to be running).

### M1.1: Add SQLite task queue schema and CRUD

Create `src/queue.ts` with a SQLite-backed task queue. Use `bun:sqlite` (Bun's built-in SQLite). Define the task schema from the plan (id, github_issue_url, repo, title, body, priority, status, created_at, updated_at, attempts, parent_task_id, container_id, pr_url). Implement CRUD operations: `enqueue()`, `dequeue()`, `getTask()`, `updateTask()`, `listTasks()`.

**Files:** `src/queue.ts` (new), `package.json` (no new deps -- use bun:sqlite)
**Verify:** `bun run typecheck` passes. Add basic unit tests in `tests/queue.test.ts`.

### M1.2: Add `queue` and `status` CLI subcommands

Add two new CLI subcommands:
- `opencode-commander queue` -- list tasks in the queue with their status, priority, and age
- `opencode-commander status` -- show overall system status (queue depth, any running containers)

Wire these into the existing CLI argument parser in `src/cli.ts`.

**Files:** `src/cli.ts`, `src/queue.ts` (import)
**Verify:** `bun run typecheck` passes. `bun run dev -- queue` and `bun run dev -- status` produce output.

### M1.3: Sequential task processor

Create a `src/processor.ts` module that implements a processing loop: dequeue a task from the SQLite queue, run it through the existing `run()` pipeline, update the task status, repeat. Add a `opencode-commander process` CLI subcommand that runs until the queue is empty.

**Files:** `src/processor.ts` (new), `src/cli.ts`, `src/queue.ts`
**Verify:** `bun run typecheck` passes.

### M1.4: Retry logic and failure handling

When a task fails, increment its `attempts` counter and re-enqueue it with a backoff delay (configurable max attempts, default 3). Add a `failed` terminal state for tasks that exhaust retries. Update the processor to check attempts before re-enqueuing.

**Files:** `src/processor.ts`, `src/queue.ts`
**Verify:** `bun run typecheck` passes. Add tests for retry logic in `tests/queue.test.ts`.

### M1.5: Concurrent container pool

Add concurrency support to the processor. Manage a pool of up to `max_concurrent` containers (configurable, default 4). Use a semaphore or worker pool pattern. The processor should dequeue and dispatch tasks in parallel up to the concurrency limit.

**Files:** `src/processor.ts`, `src/config.ts`
**Verify:** `bun run typecheck` passes.

### M2.1: GitHub repo discovery via topic

Create `src/poller.ts` with a function that discovers repos opted-in to commander via the GitHub topic `opencode-commander`. Use `gh api` to search for repos with this topic that the authenticated user has access to. Return a list of `owner/repo` strings.

**Files:** `src/poller.ts` (new), `src/github.ts` (add search helper)
**Verify:** `bun run typecheck` passes.

### M2.2: Issue detection and task creation pipeline

Extend `src/poller.ts` to scan discovered repos for issues with the trigger label (e.g. `agent`). For each matching issue, check if a task already exists in the queue; if not, create one. Normalize issue data into task queue entries with priority derived from labels (`priority/critical`, `priority/high`, etc).

**Files:** `src/poller.ts`, `src/queue.ts`, `src/github.ts`
**Verify:** `bun run typecheck` passes.

### M2.3: Issue lifecycle management

Add functions to manage issue labels and status comments throughout the task lifecycle: add `agent/queued` label when enqueued, `agent/running` when dispatched, `agent/done` or `agent/failed` on completion. Post status comments at each transition. Update `src/run.ts` to call these lifecycle hooks.

**Files:** `src/github.ts`, `src/run.ts`
**Verify:** `bun run typecheck` passes.

### M2.4: `watch` daemon mode

Add a `opencode-commander watch` CLI subcommand that runs a long-lived loop: poll for new issues (configurable interval, default 30s), enqueue tasks, and process them. Combine the poller from M2.1-M2.2 with the processor from M1.3. Handle graceful shutdown on SIGINT/SIGTERM.

**Files:** `src/cli.ts`, `src/poller.ts`, `src/processor.ts`
**Verify:** `bun run typecheck` passes. `bun run dev -- watch` starts polling and can be stopped with ctrl-c.

### M3.1: MCP server scaffold with status and queue tools

Create `src/mcp.ts` that implements an MCP server exposing `commander_status` and `commander_queue` tools. Use the `@modelcontextprotocol/sdk` npm package. The tools should read from the SQLite queue and return formatted results.

**Files:** `src/mcp.ts` (new), `src/cli.ts` (add `mcp` subcommand), `package.json` (add @modelcontextprotocol/sdk)
**Verify:** `bun run typecheck` passes.

### M3.2: MCP dispatch, pause, and resume tools

Add `commander_dispatch`, `commander_pause`, `commander_resume`, `commander_logs`, and `commander_repos` tools to the MCP server. `dispatch` manually enqueues a task. `pause`/`resume` control the processor. `logs` streams container output. `repos` lists monitored repos.

**Files:** `src/mcp.ts`, `src/processor.ts` (add pause/resume support)
**Verify:** `bun run typecheck` passes.

### M3.3: Human-in-the-loop via issue comments

Monitor SSE events from running agents to detect when the agent uses the `question` tool or gets stuck waiting for input. When detected: post the agent's question as a comment on the GitHub issue, set task status to `waiting_human`, and keep the container alive. When the poller detects a human reply, forward it to the opencode session.

**Files:** `src/agent.ts`, `src/poller.ts`, `src/run.ts`, `src/github.ts`
**Verify:** `bun run typecheck` passes.

### M3.4: Stuck detection and timeout improvements

Enhance the agent monitoring to detect stuck agents: if no tool calls or file changes for a configurable duration (default 5 min), abort the session and mark the task as failed. Add per-priority timeout overrides (critical=60min, high=45min, medium=30min, low=15min). Log detailed diagnostics when a timeout occurs.

**Files:** `src/agent.ts`, `src/config.ts`
**Verify:** `bun run typecheck` passes.

### M4.1: PR review detection and follow-up tasks

Add a function to `src/poller.ts` that detects "request changes" reviews on PRs labeled `agent-pr`. When found, create a follow-up task linked to the parent task, including the review comments as context in the prompt. The new task checks out the existing PR branch rather than creating a new one.

**Files:** `src/poller.ts`, `src/queue.ts`, `src/agent.ts` (update prompt builder), `src/container.ts` (support existing branch checkout)
**Verify:** `bun run typecheck` passes.

### M4.2: Comprehensive logging and error reporting

Replace the basic `log.ts` with structured JSON logging. Add request/response logging for all `gh` CLI calls and SDK interactions. Add a `--log-file` CLI option to write logs to a file. Add a `commander logs <task-id>` subcommand to retrieve logs for a specific task from the database.

**Files:** `src/log.ts`, `src/cli.ts`, `src/queue.ts` (store logs per task)
**Verify:** `bun run typecheck` passes.

### M5.1: Container Nix store caching

Add a shared Nix store volume that persists across container runs. When a container is created, mount the shared volume at `/nix/store` so that `nix develop` can reuse previously-built derivations. This dramatically speeds up container startup for repos that have been built before.

**Files:** `src/container.ts`, `src/config.ts`
**Verify:** `bun run typecheck` passes.

### M5.2: Orphan container cleanup on startup

On startup, scan for running podman containers matching the `commander-*` naming pattern that aren't tracked in the task queue. Stop and remove them. Add a `commander cleanup` CLI subcommand that does this on demand.

**Files:** `src/container.ts`, `src/cli.ts`
**Verify:** `bun run typecheck` passes.

## Tech Stack

- **Language:** TypeScript, run with Bun
- **Container runtime:** Podman (rootless)
- **Environment management:** Nix flakes (flake-parts)
- **Agent runtime:** opencode (headless server mode + SDK)
- **Database:** SQLite (via bun:sqlite built-in)
- **GitHub API:** `gh` CLI (Octokit planned for later milestones)
- **Secrets:** 1Password CLI (`op run`)
- **Interface:** MCP server (consumed by opencode, via @modelcontextprotocol/sdk)
- **Build:** Nix flake for the dev shell

## Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Container image strategy | `nix develop` at runtime | Avoids per-repo build pipeline. Optimize with caching in M4. |
| Crash recovery | Deferred to M4 | Manual cleanup for now. Reconciliation loop added later. |
| Issue-to-PR mapping | 1 issue = 1 PR | Simple tracking. Batching deferred to M4. |
| Model selection | Repo's opencode config decides | Keeps config close to code, no orchestrator coupling. |
| Cost guardrails | Deferred to M4 | Track costs manually. Budget limits added later. |

## Appendix: Pi Coding Agent vs OpenCode as Agent Runtime

Pi (badlogic/pi-mono, 14k stars) is an alternative coding agent CLI that could serve as the agent runtime inside containers instead of opencode. Below is a comparison of the two tools specifically through the lens of orchestration.

### Programmatic Control

**opencode:**
- HTTP server mode (`opencode serve`) with full OpenAPI 3.1 spec
- Official TypeScript SDK (`@opencode-ai/sdk`) with typed client
- SSE event stream for real-time monitoring
- Session management: create, prompt, abort, fork, revert
- Structured output support (JSON schema responses)
- Can connect to a running server from multiple clients

**pi:**
- RPC mode (`pi --mode rpc`) over stdin/stdout with JSON-line protocol
- TypeScript SDK via `createAgentSession()` for in-process embedding
- Print mode (`pi -p`) for one-shot scripting
- Rich event stream: agent_start/end, turn_start/end, message deltas, tool execution events
- Steering and follow-up message queuing mid-run
- Extension UI protocol for handling interactive prompts programmatically

**Verdict:** Both are viable. opencode's HTTP server is more natural for container orchestration (connect over network to a mapped port). Pi's RPC mode requires stdin/stdout plumbing or in-process embedding, which is harder across container boundaries. Pi's SDK is in-process only, meaning the orchestrator would need to run pi as a library inside the same Node process -- not a container boundary model. For network-based orchestration, opencode wins.

### Extensibility Model

**opencode:**
- MCP server support (native)
- Agent skills (SKILL.md files)
- Custom commands (markdown files)
- Custom tools via config
- Rules/AGENTS.md for project instructions
- Plugins system

**pi:**
- TypeScript extensions with full API access (tools, commands, keyboard shortcuts, events, UI)
- Skills (SKILL.md, compatible with Agent Skills standard)
- Prompt templates (markdown)
- Pi packages (bundle and share via npm/git)
- Explicitly no MCP (philosophy: CLI tools + READMEs instead)
- Extensions can replace/modify core behavior (compaction, tools, sub-agents, permission gates)

**Verdict:** Pi's extension system is more powerful and flexible -- you can modify almost anything about how the agent works. But for orchestration purposes, opencode's extensibility is sufficient. The key difference: pi's "no MCP" philosophy means the orchestrator can't expose itself as an MCP server that pi consumes natively. You'd need a pi extension to bridge that gap.

### Container Friendliness

**opencode:**
- Docker image available (`ghcr.io/anomalyco/opencode`)
- `opencode serve` designed for headless operation
- Server listens on configurable host:port
- Health check endpoint (`/global/health`)
- Auth can be set via env vars or API call
- Permissions can be configured via env var (`OPENCODE_PERMISSION`)

**pi:**
- No official container image
- `pi --mode rpc` is headless but uses stdin/stdout (not network)
- `pi -p "prompt"` for fire-and-forget execution
- No built-in health check endpoint
- Auth via env vars (e.g., `ANTHROPIC_API_KEY`)
- No permission system by default (by design -- "run in a container")

**Verdict:** opencode is explicitly designed for the headless server use case. Pi can be run headless but the ergonomics favor stdin/stdout process management rather than network-based orchestration. Running pi in a container would mean either: (a) spawning `pi -p` per task (simple but no session continuity, no progress monitoring), or (b) spawning `pi --mode rpc` and managing JSON-line protocol over docker exec / stdin pipe (complex).

### Nix Integration

**opencode:**
- agentkit already provides Nix modules for configuring opencode skills/commands
- `nix develop` integrates via devshell module
- Home-manager module for user-wide config

**pi:**
- No Nix-specific tooling
- Skills installed via `git clone` or `pi install`
- Configuration via dotfiles (`~/.pi/agent/`)
- Package management via npm/git (`pi install npm:...`)

**Verdict:** You've already built agentkit around opencode. Using pi would require building a parallel Nix integration layer from scratch.

### Model Support

Both support 15+ providers and hundreds of models. Both support Anthropic, OpenAI, Google, and many others. No meaningful difference here for orchestration purposes.

### Human-in-the-Loop

**opencode:**
- `question` tool fires events visible via SSE
- Permission requests have a dedicated API endpoint
- Session can be paused and resumed via SDK

**pi:**
- Extension UI protocol: `select`, `confirm`, `input` requests over RPC
- Steering messages can interrupt mid-run
- Extensions can implement arbitrary confirmation flows

**Verdict:** Both can handle human-in-the-loop, but the mechanisms differ. opencode's approach (detect `question` tool usage via SSE, respond through session API) maps more cleanly to the "post question as GitHub comment, wait for reply" pattern. Pi's extension UI protocol would require building a bridge extension.

### Summary

| Factor | opencode | pi |
|---|---|---|
| Network-based headless server | Yes (`serve`) | No (stdin/stdout RPC) |
| Official TypeScript SDK | Yes (HTTP client) | Yes (in-process only) |
| Container image | Official | None |
| Health monitoring | HTTP endpoint | N/A |
| Nix/agentkit integration | Already built | Would need building |
| Extension power | Good (MCP, skills, plugins) | Excellent (full TypeScript API) |
| Human-in-the-loop for orchestration | Clean (SSE events + API) | Possible (needs extension bridge) |
| Community/ecosystem | Growing | Large (14k stars, 120 contributors) |

### Recommendation

**Stick with opencode** for this project. The reasons are pragmatic, not philosophical:

1. **agentkit already exists** -- you've built the Nix integration. Using pi means rebuilding it.
2. **HTTP server model fits container orchestration** -- connecting to `localhost:<port>` via SDK is the natural pattern. Pi's stdin/stdout RPC requires process-level plumbing that's awkward across container boundaries.
3. **Health monitoring is built-in** -- the orchestrator needs to detect stuck/dead agents. opencode's health endpoint is ready-made.
4. **MCP compatibility** -- the commander exposes itself as an MCP server. opencode speaks MCP natively. Pi explicitly rejects MCP.

Pi is arguably the better *interactive* coding agent (more extensible, more hackable), but opencode is the better *headless orchestration target*. If pi ever adds a network server mode, the calculus changes.
