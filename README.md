# opencode-commander

Orchestrate AI coding agents across multiple repositories.

Uses GitHub Issues as the communication layer, Podman containers as the execution environment, and [opencode](https://opencode.ai) as the agent runtime. Environments are managed with [Nix](https://nixos.org).

**Status:** M0 Bootstrap MVP -- single-command CLI. See [docs/plan.md](docs/plan.md) for the full project plan.

## Quick Start

```sh
nix develop          # enter dev shell (provides bun, node, opencode, gh, op)
bun install          # install dependencies

# Run a task from a GitHub issue
bun run dev -- run owner/repo#123
```

## Usage

```
opencode-commander run <owner/repo#issue> [options]

Options:
  --timeout <minutes>   Agent timeout (default: 30)
  --quiet               Don't post status comments on the issue
  --cpu <limit>         CPU limit per container (default: 2.0)
  --memory <limit>      Memory limit per container (default: 4g)
  --verbose             Debug logging
```

## How It Works

1. Fetches the issue body from GitHub via `gh`
2. Spins up a Podman container with the repo cloned
3. Starts opencode in headless mode inside the container
4. Sends a structured task prompt via the opencode SDK
5. Waits for the agent to finish
6. Pushes the branch and creates a PR via `gh`
7. Cleans up the container

## License

MIT
