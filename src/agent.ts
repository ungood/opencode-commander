/**
 * opencode SDK integration.
 *
 * Connects to an opencode server running inside a container,
 * creates a session, sends a task prompt, and monitors progress
 * until completion or failure.
 */

import { createOpencodeClient } from "@opencode-ai/sdk"
import { log } from "./log.js"
import type { Container } from "./container.js"

export interface AgentResult {
  success: boolean
  sessionId: string
  /** Brief summary of what happened */
  summary: string
  /** Error message if failed */
  error?: string
}

/**
 * Build a structured task prompt from an issue.
 */
export function buildTaskPrompt(opts: {
  owner: string
  repo: string
  branch: string
  issueTitle: string
  issueBody: string
  issueNumber: number
}): string {
  return [
    `You are working on the repository ${opts.owner}/${opts.repo}.`,
    "",
    "## Task",
    opts.issueTitle,
    "",
    "## Description",
    opts.issueBody,
    "",
    "## Instructions",
    `- You are on branch \`${opts.branch}\``,
    "- Make the changes described above",
    "- Run any relevant tests",
    "- Commit your changes with clear, descriptive commit messages",
    "- Do NOT create a pull request -- the orchestrator will handle that",
    "",
    "## Context",
    `- Source issue: ${opts.owner}/${opts.repo}#${opts.issueNumber}`,
    "- When you are done, simply stop. The orchestrator will detect completion and create the PR.",
  ].join("\n")
}

/**
 * Run a task on an opencode server.
 *
 * Connects to the server, creates a session, sends the prompt,
 * and waits for the agent to finish.
 */
export async function runTask(
  container: Container,
  prompt: string,
  opts?: {
    /** Timeout in ms for the agent to complete (default: 30 min) */
    timeoutMs?: number
  }
): Promise<AgentResult> {
  const baseUrl = `http://127.0.0.1:${container.hostPort}`
  const timeoutMs = opts?.timeoutMs ?? 30 * 60 * 1000

  log.info("Connecting to opencode server", { baseUrl })

  const client = createOpencodeClient({ baseUrl })

  // Create a new session
  log.info("Creating session")
  const session = await client.session.create({
    body: { title: `Task: ${container.branch}` },
  })

  if (!session.data) {
    throw new Error("Failed to create session: no data returned")
  }

  const sessionId = session.data.id
  log.info("Session created", { sessionId })

  // Send the task prompt and wait for completion.
  // The SDK's prompt method blocks until the agent finishes its turn.
  log.info("Sending task prompt", { sessionId, promptLength: prompt.length })

  try {
    const result = await Promise.race([
      client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: prompt }],
        },
      }),
      timeout(timeoutMs),
    ])

    if (!result) {
      return {
        success: false,
        sessionId,
        summary: "Agent timed out",
        error: `Task did not complete within ${timeoutMs / 1000 / 60} minutes`,
      }
    }

    log.info("Agent completed", { sessionId })

    return {
      success: true,
      sessionId,
      summary: "Task completed successfully",
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error("Agent failed", { sessionId, error: errorMsg })

    return {
      success: false,
      sessionId,
      summary: "Agent failed",
      error: errorMsg,
    }
  }
}

/**
 * Monitor agent events via SSE for progress logging.
 *
 * This runs in the background and logs events as they arrive.
 * Returns an abort controller to stop monitoring.
 */
export function monitorEvents(container: Container): AbortController {
  const baseUrl = `http://127.0.0.1:${container.hostPort}`
  const controller = new AbortController()

  const client = createOpencodeClient({ baseUrl })

  // Start monitoring in the background
  ;(async () => {
    try {
      const events = await client.event.subscribe()
      for await (const event of events.stream) {
        const evt = event as { type?: string; properties?: Record<string, unknown> }
        if (controller.signal.aborted) break
        log.debug("Agent event", {
          type: evt.type ?? "unknown",
          ...(evt.properties ?? {}),
        })
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        log.warn("Event monitoring stopped", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })()

  return controller
}

/**
 * Helper: create a promise that rejects after a timeout.
 */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  )
}
