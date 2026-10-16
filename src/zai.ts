/**
 * Z.ai GLM Coding Plan monitoring API client.
 *
 * Pure module: no OpenCode imports, no filesystem access, no state.
 * Endpoint shapes validated against the live API (2026-10).
 *
 * Auth quirk: the `Authorization` header carries the raw API key with no
 * "Bearer" prefix. The quota endpoint reports percentages only — absolute
 * token limits are plan-dependent and are never invented here.
 */

export type Platform = "global" | "cn"

export const PLATFORM_HOST: Record<Platform, string> = {
  global: "api.z.ai",
  cn: "open.bigmodel.cn",
}

export type FailureKind = "auth" | "rate_limited" | "server" | "network" | "bad_response"

export class ZaiError extends Error {
  readonly kind: FailureKind
  readonly status?: number

  constructor(kind: FailureKind, message: string, status?: number) {
    super(message)
    this.name = "ZaiError"
    this.kind = kind
    this.status = status
  }
}

/** Raised when no Z.ai credentials are available. */
export class CredentialsError extends Error {
  constructor() {
    super(
      "No Z.ai credentials found. Run /connect in OpenCode and select \"Z.AI Coding Plan\"" +
        " (or set the ZHIPU_API_KEY environment variable), then try again.",
    )
    this.name = "CredentialsError"
  }
}

export interface WindowUsage {
  readonly percentage: number
  readonly resetAt?: number
}

export interface McpUsage extends WindowUsage {
  readonly used: number
  readonly total: number
  readonly tools: readonly { readonly code: string; readonly usage: number }[]
}

export interface QuotaSnapshot {
  readonly plan?: string
  readonly fiveHour?: WindowUsage
  readonly weekly?: WindowUsage
  readonly mcp?: McpUsage
}

export interface ModelUsage {
  readonly tokens: number
  readonly calls: number
  readonly models: readonly { readonly name: string; readonly tokens: number }[]
}

export interface ToolUsage {
  readonly searches: number
  readonly webReads: number
  readonly zread: number
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface RawLimit {
  type?: unknown
  unit?: unknown
  number?: unknown
  percentage?: unknown
  usage?: unknown
  currentValue?: unknown
  nextResetTime?: unknown
  usageDetails?: unknown
}

interface RawQuotaData {
  level?: unknown
  limits?: unknown
}

interface RawTotalUsage {
  totalModelCallCount?: unknown
  totalTokensUsage?: unknown
  modelSummaryList?: unknown
  totalNetworkSearchCount?: unknown
  totalWebReadMcpCount?: unknown
  totalZreadMcpCount?: unknown
}

// limit window identifiers observed in `limits[]`:
//   ("TOKENS_LIMIT", unit 3, number 5) → 5-hour token window
//   ("TOKENS_LIMIT", unit 6, number 1) → weekly token window
//   ("TIME_LIMIT",   unit 5, number 1) → MCP tool usage, calendar month
const isFiveHour = (limit: RawLimit) => limit.type === "TOKENS_LIMIT" && limit.unit === 3 && limit.number === 5
const isWeekly = (limit: RawLimit) => limit.type === "TOKENS_LIMIT" && limit.unit === 6 && limit.number === 1
const isMcp = (limit: RawLimit) => limit.type === "TIME_LIMIT"

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function windowUsage(limit: RawLimit): WindowUsage {
  const resetAt = number(limit.nextResetTime)
  return {
    percentage: number(limit.percentage) ?? 0,
    ...(resetAt !== undefined && { resetAt }),
  }
}

function mcpUsage(limit: RawLimit): McpUsage {
  const details = Array.isArray(limit.usageDetails) ? limit.usageDetails : []
  const tools = details
    .map((entry): { code: string; usage: number } | undefined => {
      if (typeof entry !== "object" || entry === null) return undefined
      const record = entry as Record<string, unknown>
      const code = typeof record.modelCode === "string" ? record.modelCode : undefined
      const usage = number(record.usage)
      return code !== undefined && usage !== undefined ? { code, usage } : undefined
    })
    .filter((tool): tool is { code: string; usage: number } => tool !== undefined)

  const resetAt = number(limit.nextResetTime)
  return {
    ...windowUsage(limit),
    used: number(limit.currentValue) ?? 0,
    total: number(limit.usage) ?? 0,
    tools,
    ...(resetAt !== undefined && { resetAt }),
  }
}

function parseQuota(data: unknown): QuotaSnapshot {
  if (typeof data !== "object" || data === null) throw new ZaiError("bad_response", "Malformed quota response.")
  const raw = data as RawQuotaData
  const limits = Array.isArray(raw.limits) ? (raw.limits as RawLimit[]) : []
  const fiveHour = limits.find(isFiveHour)
  const weekly = limits.find(isWeekly)
  const mcp = limits.find(isMcp)

  if (!fiveHour && !weekly && !mcp) {
    throw new ZaiError("bad_response", "Quota response contained no recognizable limits.")
  }

  return {
    ...(typeof raw.level === "string" && raw.level && { plan: raw.level }),
    ...(fiveHour && { fiveHour: windowUsage(fiveHour) }),
    ...(weekly && { weekly: windowUsage(weekly) }),
    ...(mcp && { mcp: mcpUsage(mcp) }),
  }
}

function parseModelUsage(data: unknown): ModelUsage {
  const raw = (typeof data === "object" && data !== null ? data : {}) as { totalUsage?: RawTotalUsage }
  const total = (typeof raw.totalUsage === "object" && raw.totalUsage !== null ? raw.totalUsage : {}) as RawTotalUsage
  const summary = Array.isArray(total.modelSummaryList) ? total.modelSummaryList : []
  const models = summary
    .map((entry): { name: string; tokens: number } | undefined => {
      if (typeof entry !== "object" || entry === null) return undefined
      const record = entry as Record<string, unknown>
      const name = typeof record.modelName === "string" ? record.modelName : undefined
      const tokens = number(record.totalTokens)
      return name !== undefined && tokens !== undefined ? { name, tokens } : undefined
    })
    .filter((model): model is { name: string; tokens: number } => model !== undefined)
    .sort((left, right) => right.tokens - left.tokens)

  return {
    tokens: number(total.totalTokensUsage) ?? 0,
    calls: number(total.totalModelCallCount) ?? 0,
    models,
  }
}

function parseToolUsage(data: unknown): ToolUsage {
  const raw = (typeof data === "object" && data !== null ? data : {}) as { totalUsage?: RawTotalUsage }
  const total = (typeof raw.totalUsage === "object" && raw.totalUsage !== null ? raw.totalUsage : {}) as RawTotalUsage
  return {
    searches: number(total.totalNetworkSearchCount) ?? 0,
    webReads: number(total.totalWebReadMcpCount) ?? 0,
    zread: number(total.totalZreadMcpCount) ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000

interface Envelope {
  code?: unknown
  msg?: unknown
  success?: unknown
  data?: unknown
}

async function request<T>(platform: Platform, path: string, token: string, signal: AbortSignal, query?: URLSearchParams): Promise<T> {
  const url = new URL(`https://${PLATFORM_HOST[platform]}${path}`)
  if (query) url.search = query.toString()

  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: token, "Accept-Language": "en-US,en" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ZaiError("network", `Could not reach ${PLATFORM_HOST[platform]}: ${reason}`)
  }

  if (response.status === 401 || response.status === 403) {
    throw new ZaiError("auth", `Z.ai rejected the credentials (HTTP ${response.status}).`, response.status)
  }
  if (response.status === 429) {
    throw new ZaiError("rate_limited", "Z.ai is rate-limiting usage queries (HTTP 429).", response.status)
  }
  if (!response.ok) {
    throw new ZaiError(
      response.status >= 500 ? "server" : "bad_response",
      `Z.ai request failed with HTTP ${response.status}.`,
      response.status,
    )
  }

  let body: Envelope
  try {
    body = (await response.json()) as Envelope
  } catch {
    throw new ZaiError("bad_response", "Z.ai returned a non-JSON response.", response.status)
  }
  if (body.code !== 200 || body.success !== true) {
    const detail = typeof body.msg === "string" && body.msg ? `: ${body.msg}` : "."
    throw new ZaiError("bad_response", `Z.ai API error (code ${String(body.code)})${detail}`)
  }
  return body.data as T
}

/** 24h rolling window in the format the monitoring API expects, local time. */
function window24h(now = new Date()): URLSearchParams {
  const pad = (value: number) => String(value).padStart(2, "0")
  const format = (date: Date, minutes: string) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${minutes}`
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours())
  return new URLSearchParams({ startTime: format(start, "00:00"), endTime: format(end, "59:59") })
}

const QUOTA_PATH = "/api/monitor/usage/quota/limit"

export async function fetchQuotaSnapshot(token: string, platform: Platform, signal: AbortSignal = new AbortController().signal): Promise<QuotaSnapshot> {
  const data = await request<unknown>(platform, QUOTA_PATH, token, signal)
  return parseQuota(data)
}

export async function fetchModelUsage(token: string, platform: Platform, signal: AbortSignal = new AbortController().signal): Promise<ModelUsage> {
  const data = await request<unknown>(platform, "/api/monitor/usage/model-usage", token, signal, window24h())
  return parseModelUsage(data)
}

export async function fetchToolUsage(token: string, platform: Platform, signal: AbortSignal = new AbortController().signal): Promise<ToolUsage> {
  const data = await request<unknown>(platform, "/api/monitor/usage/tool-usage", token, signal, window24h())
  return parseToolUsage(data)
}
