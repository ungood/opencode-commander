/**
 * The `run` command -- the core of the M0 bootstrap.
 *
 * Orchestrates the full flow:
 * 1. Parse task reference (owner/repo#issue)
 * 2. Fetch the issue from GitHub
 * 3. Spin up a Podman container with the repo cloned
 * 4. Wait for the opencode server to become healthy
 * 5. Send the task prompt and wait for completion
 * 6. Push the branch and create a PR
 * 7. Clean up the container
 */

import { parseTaskRef, fetchIssue, createPullRequest, commentOnIssue } from "./github.js"
import {
  createContainer,
  destroyContainer,
  findAvailablePort,
  waitForHealthy,
  getContainerLogs,
} from "./container.js"
import { buildTaskPrompt, runTask, monitorEvents } from "./agent.js"
import { log } from "./log.js"
import type { Container } from "./container.js"

export interface RunOptions {
  /** Task reference: "owner/repo#issue" */
  taskRef: string
  /** Timeout in minutes for the agent (default: 30) */
  timeoutMinutes?: number
  /** Whether to skip commenting on the issue */
  quiet?: boolean
  /** CPU limit for the container */
  cpuLimit?: string
  /** Memory limit for the container */
  memoryLimit?: string
}

export interface RunResult {
  success: boolean
  prUrl?: string
  error?: string
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { taskRef, timeoutMinutes = 30, quiet = false } = options

  // 1. Parse the task reference
  const ref = parseTaskRef(taskRef)
  const fullRepo = `${ref.owner}/${ref.repo}`
  const branch = `agent/issue-${ref.issue}`

  log.info("Starting task", { repo: fullRepo, issue: ref.issue, branch })

  // 2. Fetch the issue
  const issue = await fetchIssue(ref)
  log.info("Issue fetched", { title: issue.title })

  // 3. Create the container
  const hostPort = await findAvailablePort()
  let container: Container | undefined

  try {
    container = await createContainer({
      repo: fullRepo,
      branch,
      hostPort,
      cpuLimit: options.cpuLimit,
      memoryLimit: options.memoryLimit,
      timeoutMinutes,
    })

    // Post a comment that we're working on it
    if (!quiet) {
      await commentOnIssue(
        fullRepo,
        ref.issue,
        `🤖 opencode-commander is working on this issue.\n\nBranch: \`${branch}\`\nContainer: \`${container.id}\``
      ).catch((err) => {
        log.warn("Failed to post status comment", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    // 4. Wait for opencode to be healthy
    await waitForHealthy(container)

    // 5. Start monitoring events in the background
    const eventMonitor = monitorEvents(container)

    // 6. Build and send the task prompt
    const prompt = buildTaskPrompt({
      owner: ref.owner,
      repo: ref.repo,
      branch,
      issueTitle: issue.title,
      issueBody: issue.body,
      issueNumber: ref.issue,
    })

    const agentResult = await runTask(container, prompt, {
      timeoutMs: timeoutMinutes * 60 * 1000,
    })

    // Stop event monitoring
    eventMonitor.abort()

    if (!agentResult.success) {
      // Get container logs for debugging
      const logs = await getContainerLogs(container.id).catch(() => "(logs unavailable)")

      if (!quiet) {
        await commentOnIssue(
          fullRepo,
          ref.issue,
          `❌ opencode-commander failed to complete this task.\n\nError: ${agentResult.error ?? "Unknown error"}\n\n<details><summary>Container logs (last 100 lines)</summary>\n\n\`\`\`\n${logs}\n\`\`\`\n</details>`
        ).catch(() => {})
      }

      return {
        success: false,
        error: agentResult.error ?? "Agent failed",
      }
    }

    // 7. Push the branch.
    // The agent committed changes inside the container's clone.
    // We need to push from inside the container.
    log.info("Pushing branch", { branch })
    const pushResult = await pushBranchFromContainer(container, branch)
    if (!pushResult.success) {
      return {
        success: false,
        error: `Failed to push branch: ${pushResult.error}`,
      }
    }

    // 8. Create the PR
    const prBody = [
      `Closes #${ref.issue}`,
      "",
      "---",
      "",
      `*This PR was automatically created by [opencode-commander](https://github.com/ungood/opencode-commander) from issue #${ref.issue}.*`,
    ].join("\n")

    const prUrl = await createPullRequest({
      repo: fullRepo,
      branch,
      title: issue.title,
      body: prBody,
      issueNumber: ref.issue,
    })

    if (!quiet) {
      await commentOnIssue(
        fullRepo,
        ref.issue,
        `✅ opencode-commander has created a PR: ${prUrl}`
      ).catch(() => {})
    }

    log.info("Task completed successfully", { prUrl })
    return { success: true, prUrl }
  } finally {
    // Always clean up the container
    if (container) {
      await destroyContainer(container).catch((err) => {
        log.warn("Failed to destroy container", {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }
}

/**
 * Push the agent branch from inside the container.
 */
async function pushBranchFromContainer(
  container: Container,
  branch: string
): Promise<{ success: boolean; error?: string }> {
  const proc = Bun.spawn(
    [
      "podman",
      "exec",
      container.id,
      "bash",
      "-c",
      `cd /workspace && git push origin "${branch}"`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  )

  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    return { success: false, error: stderr.trim() }
  }

  return { success: true }
}
