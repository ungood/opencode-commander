/**
 * GitHub integration via the `gh` CLI.
 *
 * For the bootstrap MVP we shell out to `gh` rather than using Octokit.
 * This keeps dependencies minimal and leverages existing auth.
 */

import { log } from "./log.js"

export interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
  url: string
}

export interface TaskRef {
  owner: string
  repo: string
  issue: number
}

/**
 * Parse a task reference string like "owner/repo#123".
 */
export function parseTaskRef(ref: string): TaskRef {
  const match = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/)
  if (!match) {
    throw new Error(
      `Invalid task reference: "${ref}". Expected format: owner/repo#issue`
    )
  }
  const [, owner, repo, issueStr] = match
  return { owner: owner!, repo: repo!, issue: parseInt(issueStr!, 10) }
}

/**
 * Fetch an issue from GitHub.
 */
export async function fetchIssue(ref: TaskRef): Promise<Issue> {
  const fullRepo = `${ref.owner}/${ref.repo}`
  log.info("Fetching issue", { repo: fullRepo, issue: ref.issue })

  const proc = Bun.spawn(
    [
      "gh",
      "issue",
      "view",
      String(ref.issue),
      "--repo",
      fullRepo,
      "--json",
      "number,title,body,labels,url",
    ],
    { stdout: "pipe", stderr: "pipe" }
  )

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`gh issue view failed (exit ${exitCode}): ${stderr.trim()}`)
  }

  const data = JSON.parse(stdout) as {
    number: number
    title: string
    body: string
    labels: { name: string }[]
    url: string
  }

  return {
    number: data.number,
    title: data.title,
    body: data.body,
    labels: data.labels.map((l) => l.name),
    url: data.url,
  }
}

/**
 * Create a pull request using the `gh` CLI.
 *
 * Assumes the branch has already been pushed to the remote.
 */
export async function createPullRequest(opts: {
  repo: string
  branch: string
  title: string
  body: string
  issueNumber: number
}): Promise<string> {
  log.info("Creating pull request", { repo: opts.repo, branch: opts.branch })

  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      opts.repo,
      "--head",
      opts.branch,
      "--title",
      opts.title,
      "--body",
      opts.body,
      "--label",
      "agent-pr",
    ],
    { stdout: "pipe", stderr: "pipe" }
  )

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`gh pr create failed (exit ${exitCode}): ${stderr.trim()}`)
  }

  const prUrl = stdout.trim()
  log.info("Pull request created", { url: prUrl })
  return prUrl
}

/**
 * Post a comment on a GitHub issue.
 */
export async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  log.info("Commenting on issue", { repo, issue: issueNumber })

  const proc = Bun.spawn(
    [
      "gh",
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      body,
    ],
    { stdout: "pipe", stderr: "pipe" }
  )

  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(
      `gh issue comment failed (exit ${exitCode}): ${stderr.trim()}`
    )
  }
}
