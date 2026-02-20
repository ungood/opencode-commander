/**
 * Podman container lifecycle management.
 *
 * Handles creating, running, monitoring, and tearing down containers
 * for agent task execution.
 */

import { log } from "./log.js"

export interface ContainerConfig {
  /** Full repo identifier, e.g. "ungood/opencode-commander" */
  repo: string
  /** Branch name to create inside the container */
  branch: string
  /** Port on the host to map to the opencode server inside the container */
  hostPort: number
  /** CPU limit (e.g. "2.0") */
  cpuLimit?: string
  /** Memory limit (e.g. "4g") */
  memoryLimit?: string
  /** Task timeout in minutes */
  timeoutMinutes?: number
}

export interface Container {
  id: string
  hostPort: number
  repo: string
  branch: string
}

/**
 * Run a command via Bun.spawn and return { stdout, stderr, exitCode }.
 */
async function exec(
  cmd: string[],
  opts?: { env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  log.debug("exec", { cmd: cmd.join(" ") })
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts?.env },
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

/**
 * Find an available port by letting the OS assign one.
 */
export async function findAvailablePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })
  const port = server.port
  server.stop()
  if (port === undefined) {
    throw new Error("Failed to find an available port")
  }
  return port
}

/**
 * Create and start a Podman container for a task.
 *
 * The container:
 * 1. Clones the repo
 * 2. Creates the agent branch
 * 3. Runs `nix develop --command opencode serve`
 * 4. Exposes the opencode server on a mapped port
 *
 * We use `op run` to inject secrets (API keys, GitHub token) as
 * environment variables.
 */
export async function createContainer(
  config: ContainerConfig
): Promise<Container> {
  const { repo, branch, hostPort, cpuLimit = "2.0", memoryLimit = "4g" } = config

  log.info("Creating container", { repo, branch, hostPort })

  // Build the container startup script.
  // This runs inside the container after creation.
  const startupScript = [
    "set -euo pipefail",
    "",
    `echo "Cloning ${repo}..."`,
    `git clone "https://github.com/${repo}.git" /workspace`,
    "cd /workspace",
    "",
    `echo "Creating branch ${branch}..."`,
    `git checkout -b "${branch}"`,
    "",
    'echo "Starting opencode server..."',
    "nix develop --command opencode serve --port 4096 --hostname 0.0.0.0",
  ].join("\n")

  // Create the container using podman.
  // We use `op run` to inject secrets from 1Password.
  const createCmd = [
    "op",
    "run",
    "--",
    "podman",
    "run",
    "--detach",
    "--name",
    `commander-${branch.replace(/\//g, "-")}`,
    "--publish",
    `${hostPort}:4096`,
    "--cpus",
    cpuLimit,
    "--memory",
    memoryLimit,
    // Pass through secrets injected by `op run`
    ...(process.env["ANTHROPIC_API_KEY"]
      ? ["--env", "ANTHROPIC_API_KEY"]
      : []),
    ...(process.env["OPENAI_API_KEY"] ? ["--env", "OPENAI_API_KEY"] : []),
    ...(process.env["GITHUB_TOKEN"] ? ["--env", "GITHUB_TOKEN"] : []),
    // Use a Nix-enabled base image (NixOS-based)
    "nixos/nix:latest",
    "bash",
    "-c",
    startupScript,
  ]

  const result = await exec(createCmd)

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create container (exit ${result.exitCode}): ${result.stderr}`
    )
  }

  const containerId = result.stdout.slice(0, 12) // podman returns full hash

  log.info("Container created", { id: containerId, hostPort })

  return {
    id: containerId,
    hostPort,
    repo,
    branch,
  }
}

/**
 * Wait for the opencode server inside a container to become healthy.
 *
 * Polls the health endpoint until it responds or timeout is reached.
 */
export async function waitForHealthy(
  container: Container,
  timeoutMs: number = 300_000 // 5 minutes for nix develop + server start
): Promise<void> {
  const healthUrl = `http://127.0.0.1:${container.hostPort}/global/health`
  const startTime = Date.now()
  const pollIntervalMs = 3_000

  log.info("Waiting for opencode server to be healthy", {
    url: healthUrl,
    timeoutMs,
  })

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) {
        const data = (await response.json()) as { healthy: boolean }
        if (data.healthy) {
          log.info("opencode server is healthy", {
            containerId: container.id,
            elapsed: Date.now() - startTime,
          })
          return
        }
      }
    } catch {
      // Server not ready yet, keep polling
    }
    await Bun.sleep(pollIntervalMs)
  }

  throw new Error(
    `Timed out waiting for opencode server in container ${container.id} after ${timeoutMs}ms`
  )
}

/**
 * Tear down a container.
 */
export async function destroyContainer(container: Container): Promise<void> {
  log.info("Destroying container", { id: container.id })

  // Stop the container
  const stopResult = await exec(["podman", "stop", "--time", "10", container.id])
  if (stopResult.exitCode !== 0) {
    log.warn("Failed to stop container", {
      id: container.id,
      error: stopResult.stderr,
    })
  }

  // Remove the container
  const rmResult = await exec(["podman", "rm", "--force", container.id])
  if (rmResult.exitCode !== 0) {
    log.warn("Failed to remove container", {
      id: container.id,
      error: rmResult.stderr,
    })
  }

  log.info("Container destroyed", { id: container.id })
}

/**
 * Get logs from a container.
 */
export async function getContainerLogs(containerId: string): Promise<string> {
  const result = await exec(["podman", "logs", "--tail", "100", containerId])
  return result.stdout || result.stderr
}
