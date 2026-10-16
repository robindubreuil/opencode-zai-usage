/**
 * Output rendering for Z.ai usage data.
 *
 * Pure module. Three surfaces, one set of formatting helpers:
 *  - renderMarkdown  → `zai_usage` tool output (token-efficient markdown)
 *  - renderPlain     → `/zai` TUI dialog (aligned plain text)
 *  - badgeText       → status-line badge (`ZAI 21% · 2h 41m`)
 */

import type { ModelUsage, QuotaSnapshot, ToolUsage } from "./zai"

export interface UsagePayload extends QuotaSnapshot {
  readonly platform?: "global" | "cn"
  readonly fetchedAt?: number
}

const numberFormat = new Intl.NumberFormat("en-US")

export const thousands = (value: number): string => numberFormat.format(value)

export function short(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}

export function bar(percentage: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, percentage))
  const filled = Math.round((clamped / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function countdown(ms: number): string {
  if (ms <= 0) return "now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "<1m"
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/** Local clock time; includes the weekday when the reset is more than a day out. */
export function clock(at: number, now = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })
  if (at - now >= 86_400_000) return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`
  return time
}

function monthDay(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** `<countdown> (<clock>)`, e.g. `2h 41m (21:00)` or `3d 13h (Sat 15:02)`. */
function resetCell(resetAt: number | undefined, now: number): string {
  if (resetAt === undefined || resetAt <= now) return "—"
  return `${countdown(resetAt - now)} (${clock(resetAt, now)})`
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function header(payload: UsagePayload): string {
  const plan = payload.plan ? ` — ${titleCase(payload.plan)}` : ""
  const region = payload.platform === "cn" ? " · CN" : ""
  return `### Z.ai Coding Plan${plan}${region}`
}

interface Row {
  readonly label: string
  readonly percentage: number
  readonly resetAt?: number
  readonly extra?: string
}

function rowsOf(payload: UsagePayload): Row[] {
  const rows: Row[] = []
  if (payload.fiveHour) rows.push({ label: "5h tokens", ...payload.fiveHour })
  if (payload.weekly) rows.push({ label: "Weekly", ...payload.weekly })
  if (payload.mcp) {
    rows.push({
      label: "MCP tools",
      percentage: payload.mcp.percentage,
      resetAt: payload.mcp.resetAt,
      extra: `${thousands(payload.mcp.used)}/${thousands(payload.mcp.total)}`,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Tool output (markdown)
// ---------------------------------------------------------------------------

export function renderMarkdown(payload: UsagePayload, model?: ModelUsage, tools?: ToolUsage, now = Date.now()): string {
  const lines: string[] = [header(payload), ""]

  const table = rowsOf(payload).map((row) => {
    const extra = row.extra ? ` · \`${row.extra}\`` : ""
    const reset = row.label === "MCP tools" && row.resetAt !== undefined ? monthDay(row.resetAt) : resetCell(row.resetAt, now)
    return `| ${row.label} | ${Math.round(row.percentage)}% \`${bar(row.percentage)}\`${extra} | ${reset} |`
  })
  lines.push(
    "| Window | Usage | Resets |",
    "| --- | --- | --- |",
    ...(table.length > 0 ? table : ["| no quota data returned | | |"]),
  )

  if (model) {
    const models = model.models
      .slice(0, 3)
      .map((entry) => `${entry.name} ${short(entry.tokens)}`)
      .join(" · ")
    lines.push("", `**24h usage**: ${thousands(model.tokens)} tokens · ${thousands(model.calls)} calls${models ? ` — ${models}` : ""}`)
  }
  if (tools && (tools.searches > 0 || tools.webReads > 0 || tools.zread > 0)) {
    lines.push(`**24h tools**: ${thousands(tools.searches)} searches · ${thousands(tools.webReads)} web reads · ${thousands(tools.zread)} zread`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// TUI dialog (plain text)
// ---------------------------------------------------------------------------

export function renderPlain(payload: UsagePayload, now = Date.now()): string {
  const lines = [header(payload).replace(/^### /, ""), ""]
  for (const row of rowsOf(payload)) {
    const label = `${row.label} `.padEnd(12)
    const pct = `${String(Math.round(row.percentage)).padStart(3)}%`
    const extra = row.extra ? `  ${row.extra} used` : ""
    const reset = row.resetAt !== undefined && row.resetAt > now ? `  resets ${row.label === "MCP tools" ? monthDay(row.resetAt) : `${clock(row.resetAt, now)} (in ${countdown(row.resetAt - now)})`}` : ""
    lines.push(`${label}${pct} ${bar(row.percentage)}${extra}${reset}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Status-line badge
// ---------------------------------------------------------------------------

/** Compact badge driven by the 5h window (weekly as fallback). */
export function badgeText(payload: UsagePayload, now = Date.now()): string | undefined {
  const window = payload.fiveHour ?? payload.weekly
  if (!window) return undefined
  const pct = Math.round(window.percentage)
  const suffix = window.resetAt !== undefined && window.resetAt > now ? ` · ${countdown(window.resetAt - now)}` : ""
  return `ZAI ${pct}%${suffix}`
}

/** Badge color thresholds on the same window the badge shows. */
export function badgeLevel(payload: UsagePayload): "normal" | "warning" | "error" {
  const percentage = payload.fiveHour?.percentage ?? payload.weekly?.percentage ?? 0
  if (percentage >= 90) return "error"
  if (percentage >= 60) return "warning"
  return "normal"
}
