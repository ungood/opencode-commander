/**
 * Simple structured logging utility.
 *
 * All output goes to stderr so that stdout is reserved for
 * machine-readable output (e.g. the final PR URL).
 */

type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let minLevel: LogLevel = "info"

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function timestamp(): string {
  return new Date().toISOString()
}

function format(level: LogLevel, msg: string, extra?: Record<string, unknown>): string {
  const base = `[${timestamp()}] ${level.toUpperCase().padEnd(5)} ${msg}`
  if (extra && Object.keys(extra).length > 0) {
    return `${base} ${JSON.stringify(extra)}`
  }
  return base
}

export const log = {
  debug(msg: string, extra?: Record<string, unknown>): void {
    if (shouldLog("debug")) console.error(format("debug", msg, extra))
  },
  info(msg: string, extra?: Record<string, unknown>): void {
    if (shouldLog("info")) console.error(format("info", msg, extra))
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    if (shouldLog("warn")) console.error(format("warn", msg, extra))
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    if (shouldLog("error")) console.error(format("error", msg, extra))
  },
}
