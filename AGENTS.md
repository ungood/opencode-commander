# opencode-commander

An orchestration system that dispatches AI coding agent tasks across multiple repositories using GitHub Issues as the communication layer, Podman containers as the execution environment, and opencode as the agent runtime.

## Project Structure

```
src/
  cli.ts        -- CLI entry point, argument parsing
  run.ts        -- Main `run` command orchestrating the full flow
  github.ts     -- GitHub API integration via `gh` CLI
  container.ts  -- Podman container lifecycle management
  agent.ts      -- opencode SDK integration (connect, prompt, monitor)
  log.ts        -- Structured logging utility
docs/
  plan.md       -- Full project plan with milestones and architecture
```

## Tech Stack

- **Language:** TypeScript, run with Bun
- **Container runtime:** Podman (rootless)
- **Environment:** Nix flakes (flake-parts)
- **Agent runtime:** opencode (headless server mode + SDK)
- **GitHub API:** `gh` CLI (Octokit planned for later milestones)
- **Secrets:** 1Password CLI (`op run`)

## Architecture

The system follows a pipeline: GitHub Issue -> Container -> opencode agent -> PR.

The `run` command (`src/run.ts`) is the main orchestrator:
1. Parses `owner/repo#issue` reference
2. Fetches the issue via `gh issue view`
3. Creates a Podman container (via `op run` for secrets injection)
4. Waits for the opencode server to become healthy
5. Sends a structured task prompt via the opencode SDK
6. Waits for the agent to finish
7. Pushes the branch and creates a PR via `gh pr create`
8. Cleans up the container

## Conventions

- All logging goes to stderr; stdout is reserved for machine-readable output (e.g. PR URL)
- Shell out to `gh` for GitHub operations (migration to Octokit planned for M2)
- Container names follow the pattern `commander-agent-issue-<N>`
- Agent branches follow the pattern `agent/issue-<N>`
- Use `op run` to inject secrets as environment variables

## Current Status

M0 (Bootstrap MVP) -- single-command CLI that takes an issue and produces a PR.

## Testing

Run type checking:
```
bun run typecheck
```

## How to Build

```
nix develop   # enter dev shell
bun install   # install dependencies
bun run dev -- run owner/repo#123  # run a task
```
