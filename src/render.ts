/**
 * Output rendering for Z.ai usage data.
 *
 * Pure module. Four surfaces, one set of formatting helpers:
 *  - renderMarkdown  → `zai_usage` tool output (token-efficient markdown)
 *  - renderPlain     → `/zai` TUI dialog (aligned plain text)
 *  - badgeText       → status-line badge (`ZAI 21% · 2h 41m`)
 *
 * Quota limits are credit allowances (see docs.z.ai/devpack/overview), so
 * windows are labelled as credits and absolute values are derived from the
 * plan tier reported by the API — never invented.
 */

import type { ModelUsage, QuotaSnapshot, ToolUsage } from "./zai"
import { MCP_CREDIT_PER_CALL, MODEL_MULTIPLIERS, MODEL_NAMES, OFF_PEAK_RATE, PLAN_CREDITS, canonicalModel, peakStatus } from "./pricing"

export interface UsagePayload extends QuotaSnapshot {
  readonly platform?: "global" | "cn"
  readonly fetchedAt?: number
}

export interface MarkdownOptions {
  readonly model?: ModelUsage
  readonly tools?: ToolUsage
  readonly selectedModelID?: string
  /** Include the reference pricing block (detail mode). */
  readonly pricing?: boolean
  readonly now?: number
}

export interface PlainOptions {
  readonly selectedModelID?: string
  readonly now?: number
}

const LABEL_5H = "5h credits"
const LABEL_WEEKLY = "Weekly credits"
const LABEL_MCP = "MCP tools"
const LABEL_PAD = 16

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
  if (payload.fiveHour) rows.push({ label: LABEL_5H, ...payload.fiveHour })
  if (payload.weekly) rows.push({ label: LABEL_WEEKLY, ...payload.weekly })
  if (payload.mcp) {
    rows.push({
      label: LABEL_MCP,
      percentage: payload.mcp.percentage,
      resetAt: payload.mcp.resetAt,
      extra: `${thousands(payload.mcp.used)}/${thousands(payload.mcp.total)}`,
    })
  }
  return rows
}

/** Absolute credits derived from the API percentage and the documented plan allowance. */
function creditsLine(payload: UsagePayload): string | undefined {
  const plan = payload.plan ? PLAN_CREDITS[payload.plan.toLowerCase()] : undefined
  if (!plan) return undefined
  const window = (pct: number | undefined, total: number) =>
    pct === undefined ? undefined : `≈${thousands(Math.round((pct / 100) * total))}/${thousands(total)}`
  const fiveHour = payload.fiveHour ? window(payload.fiveHour.percentage, plan.fiveHour) : undefined
  const weekly = payload.weekly ? window(payload.weekly.percentage, plan.weekly) : undefined
  const parts = [
    fiveHour && `5h ${fiveHour}`,
    weekly && `weekly ${weekly}`,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

// ---------------------------------------------------------------------------
// Pricing block (reference data from docs.z.ai/devpack/overview)
// ---------------------------------------------------------------------------

function sgtClock(at: number): string {
  // Transition instants are always at 14:00 or 18:00 SGT; render that fixed clock time.
  return new Date(at).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" })
}

function modelLine(key: string, selected: boolean, plain: boolean): string {
  const entry = MODEL_MULTIPLIERS[key]
  if (!entry) return ""
  const marker = selected ? (plain ? " (selected)" : " **(selected)**") : ""
  return `- ${MODEL_NAMES[key] ?? key}${marker}: in ×${entry.input} · cached ×${entry.cached} · out ×${entry.output}`
}

function pricingLines(selectedModelID: string | undefined, now: number, plain: boolean): string[] {
  const status = peakStatus(now)
  const state = status.peak ? "peak — 1× credits" : `off-peak — ${OFF_PEAK_RATE}× credits`
  const verb = status.peak ? "ends" : "next peak"
  const when = `${sgtClock(status.transitionsAt)} SGT (${countdown(status.transitionsAt - now)})`
  const bold = (text: string) => (plain ? text : `**${text}**`)
  const selectedKey = selectedModelID !== undefined ? canonicalModel(selectedModelID) : undefined

  const lines = [
    `${bold("Pricing")} — peak hours Mon–Fri 14:00–18:00 SGT · off-peak ${OFF_PEAK_RATE}× · per docs.z.ai`,
    `- Now: ${bold(state)} — ${verb} ${when}`,
  ]
  for (const key of Object.keys(MODEL_MULTIPLIERS)) {
    const line = modelLine(key, key === selectedKey, plain)
    if (line) lines.push(line)
  }
  lines.push(`- MCP tools (search/reader/zread): ${MCP_CREDIT_PER_CALL} credits/call`)
  return lines
}

// ---------------------------------------------------------------------------
// Tool output (markdown)
// ---------------------------------------------------------------------------

export function renderMarkdown(payload: UsagePayload, options: MarkdownOptions = {}): string {
  const now = options.now ?? Date.now()
  const lines: string[] = [header(payload), ""]

  const table = rowsOf(payload).map((row) => {
    const extra = row.extra ? ` · \`${row.extra}\`` : ""
    const reset = row.label === LABEL_MCP && row.resetAt !== undefined ? monthDay(row.resetAt) : resetCell(row.resetAt, now)
    return `| ${row.label} | ${Math.round(row.percentage)}% \`${bar(row.percentage)}\`${extra} | ${reset} |`
  })
  lines.push(
    "| Window | Usage | Resets |",
    "| --- | --- | --- |",
    ...(table.length > 0 ? table : ["| no quota data returned | | |"]),
  )

  const credits = creditsLine(payload)
  if (credits) lines.push("", `**Credits**: ${credits}`)

  if (options.model) {
    const models = options.model.models
      .slice(0, 3)
      .map((entry) => `${entry.name} ${short(entry.tokens)}`)
      .join(" · ")
    lines.push("", `**24h usage**: ${thousands(options.model.tokens)} tokens · ${thousands(options.model.calls)} calls${models ? ` — ${models}` : ""}`)
  }
  if (options.tools && (options.tools.searches > 0 || options.tools.webReads > 0 || options.tools.zread > 0)) {
    lines.push(`**24h tools**: ${thousands(options.tools.searches)} searches · ${thousands(options.tools.webReads)} web reads · ${thousands(options.tools.zread)} zread`)
  }

  // Pricing facts are documented for the global plan only.
  if (options.pricing && payload.platform !== "cn") {
    lines.push("", ...pricingLines(options.selectedModelID, now, false))
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// TUI dialog (plain text)
// ---------------------------------------------------------------------------

export function renderPlain(payload: UsagePayload, options: PlainOptions = {}): string {
  const now = options.now ?? Date.now()
  const lines = [header(payload).replace(/^### /, ""), ""]

  for (const row of rowsOf(payload)) {
    const label = `${row.label} `.padEnd(LABEL_PAD)
    const pct = `${String(Math.round(row.percentage)).padStart(3)}%`
    const extra = row.extra ? `  ${row.extra} used` : ""
    const reset =
      row.resetAt !== undefined && row.resetAt > now
        ? `  resets ${row.label === LABEL_MCP ? monthDay(row.resetAt) : `${clock(row.resetAt, now)} (in ${countdown(row.resetAt - now)})`}`
        : ""
    lines.push(`${label}${pct} ${bar(row.percentage)}${extra}${reset}`)
  }

  const credits = creditsLine(payload)
  if (credits) lines.push("", `Credits: ${credits}`)

  if (payload.platform === "global") {
    lines.push("", ...pricingLines(options.selectedModelID, now, true))
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Status-line badge
// ---------------------------------------------------------------------------

/** Compact badge driven by the 5h window (weekly as fallback). */
export function badgeText(payload: UsagePayload, now: number = Date.now()): string | undefined {
  const window = payload.fiveHour ?? payload.weekly
  if (!window) return undefined
  const pct = Math.round(window.percentage)
  const suffix = window.resetAt !== undefined && window.resetAt > now ? ` · ${countdown(window.resetAt - now)}` : ""
  const peak = peakStatus(now).peak ? " · peak" : ""
  return `ZAI ${pct}%${suffix}${peak}`
}

/** Badge color thresholds on the same window the badge shows. */
export function badgeLevel(payload: UsagePayload): "normal" | "warning" | "error" {
  const percentage = payload.fiveHour?.percentage ?? payload.weekly?.percentage ?? 0
  if (percentage >= 90) return "error"
  if (percentage >= 60) return "warning"
  return "normal"
}
