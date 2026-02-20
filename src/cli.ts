#!/usr/bin/env bun

/**
 * opencode-commander CLI entry point.
 *
 * Usage:
 *   opencode-commander run <owner/repo#issue> [options]
 *
 * Options:
 *   --timeout <minutes>   Agent timeout in minutes (default: 30)
 *   --quiet               Don't post status comments on the issue
 *   --cpu <limit>         CPU limit per container (default: 2.0)
 *   --memory <limit>      Memory limit per container (default: 4g)
 *   --verbose             Enable debug logging
 *   --help                Show help
 */

import { run } from "./run.js"
import { log, setLogLevel } from "./log.js"

interface CliArgs {
  command: string
  taskRef?: string
  timeout: number
  quiet: boolean
  cpu: string
  memory: string
  verbose: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "",
    timeout: 30,
    quiet: false,
    cpu: "2.0",
    memory: "4g",
    verbose: false,
    help: false,
  }

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!

    switch (arg) {
      case "--timeout":
        args.timeout = parseInt(argv[++i]!, 10)
        if (isNaN(args.timeout)) {
          throw new Error("--timeout requires a numeric value")
        }
        break
      case "--quiet":
        args.quiet = true
        break
      case "--cpu":
        args.cpu = argv[++i]!
        break
      case "--memory":
        args.memory = argv[++i]!
        break
      case "--verbose":
        args.verbose = true
        break
      case "--help":
      case "-h":
        args.help = true
        break
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`)
        }
        if (!args.command) {
          args.command = arg
        } else if (!args.taskRef) {
          args.taskRef = arg
        }
        break
    }
    i++
  }

  return args
}

function printUsage(): void {
  console.error(`opencode-commander - Orchestrate AI coding agents across multiple repositories

Usage:
  opencode-commander run <owner/repo#issue> [options]

Commands:
  run    Fetch a GitHub issue, run an agent in a container, and create a PR

Options:
  --timeout <minutes>   Agent timeout in minutes (default: 30)
  --quiet               Don't post status comments on the issue
  --cpu <limit>         CPU limit per container (default: 2.0)
  --memory <limit>      Memory limit per container (default: 4g)
  --verbose             Enable debug logging
  --help, -h            Show this help message

Examples:
  opencode-commander run ungood/opencode-commander#12
  opencode-commander run ungood/myapp#5 --timeout 60 --verbose`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || !args.command) {
    printUsage()
    process.exit(args.help ? 0 : 1)
  }

  if (args.verbose) {
    setLogLevel("debug")
  }

  switch (args.command) {
    case "run": {
      if (!args.taskRef) {
        console.error("Error: missing task reference (e.g. owner/repo#123)")
        printUsage()
        process.exit(1)
      }

      const result = await run({
        taskRef: args.taskRef,
        timeoutMinutes: args.timeout,
        quiet: args.quiet,
        cpuLimit: args.cpu,
        memoryLimit: args.memory,
      })

      if (result.success) {
        // Print the PR URL to stdout (machine-readable output)
        console.log(result.prUrl)
        process.exit(0)
      } else {
        log.error("Task failed", { error: result.error })
        process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown command: ${args.command}`)
      printUsage()
      process.exit(1)
  }
}

main().catch((err) => {
  log.error("Fatal error", {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
