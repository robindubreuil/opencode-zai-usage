/**
 * GLM Coding Plan pricing facts.
 *
 * Source of truth: https://docs.z.ai/devpack/overview (checked 2026-10).
 * These are reference values for display only — never used to fabricate
 * live quota numbers, which always come from the monitoring API.
 *
 * Global plan only. The China plan (open.bigmodel.cn) has different,
 * undocumented terms and gets no pricing block rather than a guess.
 */

export interface Multipliers {
  readonly input: number
  readonly cached: number
  readonly output: number
}

/** Credit multipliers per model, keyed by normalized model id. */
export const MODEL_MULTIPLIERS: Readonly<Record<string, Multipliers>> = {
  "glm-5.3": { input: 6.9, cached: 1.7, output: 24 },
  "glm-5.3-flash": { input: 2.3, cached: 0.56, output: 8 },
}

/** Documented automatic routing of older model requests. */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "glm-5.2": "glm-5.3",
  "glm-5.1": "glm-5.3",
  "glm-4.7": "glm-5.3-flash",
}

/** Resolve a model id to its canonical multiplier table key, following documented routing. */
export function canonicalModel(modelID: string): string | undefined {
  const normalized = modelID.toLowerCase().split(/[#?]/)[0].trim().split("/").pop()!.trim()
  return normalized in MODEL_MULTIPLIERS ? normalized : MODEL_ALIASES[normalized]
}

/** Display names for the multiplier table keys. */
export const MODEL_NAMES: Readonly<Record<string, string>> = {
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3-Flash",
}

export function multipliersFor(modelID: string): Multipliers | undefined {
  return MODEL_MULTIPLIERS[canonicalModel(modelID) ?? ""]
}

export interface PlanCredits {
  readonly fiveHour: number
  readonly weekly: number
}

/** Credit allowances per plan tier. */
export const PLAN_CREDITS: Readonly<Record<string, PlanCredits>> = {
  lite: { fiveHour: 2_000, weekly: 10_000 },
  pro: { fiveHour: 12_000, weekly: 60_000 },
  max: { fiveHour: 28_000, weekly: 140_000 },
}

/** MCP tools (web search, web reader, zread) cost per call. */
export const MCP_CREDIT_PER_CALL = 1.2

/** Off-peak hours are charged at this fraction of the standard credit rate. */
export const OFF_PEAK_RATE = 0.5

// ---------------------------------------------------------------------------
// Peak window: Monday–Friday, 14:00–18:00 Singapore time (UTC+8, no DST).
// ---------------------------------------------------------------------------

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 86_400_000

export interface PeakStatus {
  readonly peak: boolean
  /** UTC ms when the current status flips. */
  readonly transitionsAt: number
}

function sgtToUtc(date: Date, hour: number): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0, 0) - SGT_OFFSET_MS
}

export function peakStatus(now: number = Date.now()): PeakStatus {
  const sgt = new Date(now + SGT_OFFSET_MS)
  const weekday = sgt.getUTCDay() // 0 Sun … 6 Sat
  const hour = sgt.getUTCHours()

  if (weekday >= 1 && weekday <= 5 && hour >= 14 && hour < 18) {
    return { peak: true, transitionsAt: sgtToUtc(sgt, 18) }
  }

  // Off-peak: the next weekday 14:00 SGT strictly after now.
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(sgt.getTime() + offset * DAY_MS)
    const candidateWeekday = day.getUTCDay()
    if (candidateWeekday < 1 || candidateWeekday > 5) continue
    const candidate = sgtToUtc(day, 14)
    if (candidate > now) return { peak: false, transitionsAt: candidate }
  }
  return { peak: false, transitionsAt: now } // unreachable: a weekday always occurs within 7 days
}
