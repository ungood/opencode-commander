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

**Step 1: Project scaffolding (day 1)**
- Create `ungood/opencode-commander` repo
- `flake.nix` with agentkit, TypeScript toolchain, opencode
- Basic `package.json` with TypeScript, tsx for running
- `AGENTS.md` describing the project so opencode can work on it
- Verify: `nix develop` gives you a shell with opencode + node

**Step 2: Container script (day 2)**
- Shell script or minimal TS that:
  - `podman run` with a Nix-enabled base image
  - Mounts/clones a repo at `/workspace`
  - Runs `nix develop --command opencode serve --port 4096 --hostname 0.0.0.0`
- `op run` wraps the podman invocation to inject secrets
- Verify: you can `curl http://localhost:<port>/global/health` from the host

**Step 3: opencode SDK integration (day 3)**
- TypeScript code that:
  - Connects to a running opencode server via `createOpencodeClient`
  - Creates a session
  - Sends a prompt
  - Subscribes to SSE events, waits for session to finish
  - Detects success or failure
- Verify: send "create a file called hello.txt with 'hello world'" and confirm it works

**Step 4: Wire it together as `commander run` (day 4)**
- CLI entry point: `commander run <owner/repo>#<issue-number>`
- Fetches issue title + body via `gh issue view --json`
- Spawns container with repo cloned, branch created
- Sends constructed prompt to opencode
- On completion: pushes branch, runs `gh pr create`
- On failure: prints error, exits non-zero
- Verify: file an issue on opencode-commander, run the command, get a PR

**Step 5: Self-improvement test (day 5)**
- File a real issue on the opencode-commander repo: "Add a --timeout flag to the run command"
- Run `commander run ungood/opencode-commander#1`
- Review the PR
- If it works: the system is bootstrapped
- If it doesn't: fix the failure manually, iterate

### After bootstrap

Once the bootstrap loop works, subsequent milestones can be partially self-built. The workflow becomes:

1. File an issue describing the feature (e.g., "Add SQLite task queue")
2. Run `commander run ungood/opencode-commander#N`
3. Review the PR, merge or request changes
4. Repeat

The original milestones remain the roadmap, but they're restructured below to reflect what bootstrap already covers.

## Milestones

### M0: Bootstrap MVP (Week 1)
- Project scaffolding with TypeScript + Nix flake + agentkit
- Single-command `commander run <owner/repo>#<issue>` CLI
- Podman container lifecycle (create with nix, run opencode, tear down)
- opencode SDK integration (start server, send prompt, wait for completion)
- GitHub issue fetch + PR creation (via `gh` CLI)
- `op run` for secrets injection
- **Exit criteria:** file an issue on the commander repo, get a working PR back

### M1: Queue + Multi-task (Week 2-3)
- SQLite task queue with basic CRUD
- `commander queue` / `commander status` CLI commands
- Sequential task processing (dequeue, run, repeat)
- Configurable concurrency (multiple containers)
- Basic retry on failure (up to N attempts)
- Container resource limits (CPU, memory)

### M2: GitHub Integration (Week 3-4)
- GitHub poller: repo discovery via topic, issue detection via labels
- Issue-to-task pipeline: normalize issues into task queue entries
- Issue comment updates (status changes, completion, failure)
- Label management on issues
- `commander watch` -- long-running daemon mode

### M3: MCP Server + Human Loop (Week 5-6)
- MCP server exposing commander tools to opencode
- Human-in-the-loop: detect agent questions, post to issue, resume on reply
- Stuck detection and timeout handling

### M4: PR Review Loop + Polish (Week 7-8)
- PR review detection (requested changes on agent PRs)
- Follow-up task creation with review context
- Comprehensive logging and error reporting
- Documentation

### M5: Hardening (Ongoing)
- Home lab deployment (NixOS container host)
- Orphan container reconciliation on startup
- Webhook-based GitHub events (replace polling for faster response)
- Shared Nix store volume for faster `nix develop`
- Pre-built per-repo images for frequently-used repos
- Multi-issue PR batching
- Cost tracking per task with budget guardrails
- Metrics and observability (Prometheus/Grafana or similar)
- Multiple LLM provider fallback strategies

## Tech Stack

- **Language:** TypeScript (Node.js)
- **Container runtime:** Podman (rootless)
- **Environment management:** Nix flakes + agentkit
- **Agent runtime:** opencode (headless server mode + SDK)
- **Database:** SQLite (via better-sqlite3 or drizzle)
- **GitHub API:** Octokit
- **Secrets:** 1Password CLI (`op run`)
- **Interface:** MCP server (consumed by opencode)
- **Build:** Nix flake for the commander itself

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
