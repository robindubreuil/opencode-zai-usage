/**
 * Server plugin: `zai_usage` tool + `zai-usage` RPC.
 *
 * Credentials come from OpenCode's integration layer — never from the
 * filesystem. One quota fetch is shared by every consumer (tool calls, badge,
 * dialog) behind a TTL cache, deduplicated in flight, and refreshed whenever
 * a session goes idle.
 */

import { Plugin } from "@opencode/plugin"
import { ZaiUsageRpc, type UsageSnapshot } from "./rpc"
import { renderMarkdown } from "./render"
import {
  CredentialsError,
  ZaiError,
  fetchModelUsage,
  fetchQuotaSnapshot,
  fetchToolUsage,
  type Platform,
} from "./zai"

/** Z.ai integrations in OpenCode, most specific first. */
const INTEGRATION_IDS = ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"] as const

const INTEGRATION_PLATFORM: Record<(typeof INTEGRATION_IDS)[number], Platform> = {
  "zai-coding-plan": "global",
  zai: "global",
  "zhipuai-coding-plan": "cn",
  zhipuai: "cn",
}

/** Tool-visible cache lifetime: fresh enough to avoid fetch storms, stale enough to feel instant. */
const TOOL_MAX_AGE_MS = 10_000
/** Minimum age before event-triggered background refreshes fetch again. */
const REFRESH_MIN_AGE_MS = 30_000
/** Guaranteed refresh floor covering usage that never fires local events. */
const DRIFT_INTERVAL_MS = 5 * 60_000

interface Credentials {
  readonly token: string
  readonly platform: Platform
}

function explain(error: unknown): string {
  if (!(error instanceof ZaiError)) return error instanceof Error ? error.message : String(error)
  switch (error.kind) {
    case "auth":
      return `${error.message} Re-authenticate via /connect, then retry.`
    case "server":
      return `${error.message} Try again later.`
    default:
      return error.message
  }
}

export default Plugin.define({
  id: "zai-usage",
  async setup(ctx) {
    // Env fallback platform only matters when no integration connection exists.
    const envPlatform: Platform = ctx.options?.platform === "cn" ? "cn" : "global"

    const resolveCredentials = async (): Promise<Credentials | undefined> => {
      for (const id of INTEGRATION_IDS) {
        try {
          const connection = await ctx.integration.connection.active(id)
          if (!connection) continue
          const credential = await ctx.integration.connection.resolve(connection)
          if (credential && credential.type === "key" && typeof credential.key === "string" && credential.key) {
            return { token: credential.key, platform: INTEGRATION_PLATFORM[id] }
          }
        } catch {
          // Integration unavailable — try the next candidate.
        }
      }
      // Env names follow OpenCode's integration methods (ZHIPU_API_KEY); ZAI_API_KEY kept for compatibility.
      const token = process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY
      return token ? { token, platform: envPlatform } : undefined
    }

    let cache: { snapshot: UsageSnapshot; at: number } | undefined
    let inflight: Promise<UsageSnapshot> | undefined

    const refresh = async (): Promise<UsageSnapshot> => {
      inflight ??= (async () => {
        const credentials = await resolveCredentials()
        if (!credentials) throw new CredentialsError()
        const quota = await fetchQuotaSnapshot(credentials.token, credentials.platform)
        const snapshot: UsageSnapshot = { ...quota, platform: credentials.platform, fetchedAt: Date.now() }
        cache = { snapshot, at: Date.now() }
        await registration.events.emit("refreshed", snapshot)
        return snapshot
      })()
      try {
        return await inflight
      } finally {
        inflight = undefined
      }
    }

    const registration = await ctx.rpc.register(ZaiUsageRpc, {
      get: async (input, context) => {
        const raw = input as { maxAgeMs?: number }
        const maxAgeMs =
          typeof raw.maxAgeMs === "number" && Number.isFinite(raw.maxAgeMs) && raw.maxAgeMs >= 0 ? raw.maxAgeMs : 60_000
        try {
          if (cache && Date.now() - cache.at <= maxAgeMs) return cache.snapshot
          return await refresh()
        } catch (error) {
          const message = explain(error)
          if (error instanceof CredentialsError) return context.error("no_credentials", message, { message })
          return context.error("unavailable", message, { message })
        }
      },
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "zai_usage",
        description:
          "Report the user's Z.ai GLM Coding Plan quota — 5-hour token window, weekly limit, and MCP tool usage, with reset times. Use when asked about quota, usage, limits, or remaining credits.",
        input: {
          type: "object",
          properties: {
            detail: {
              type: "boolean",
              description: "Include the 24-hour model and tool usage breakdown (two extra API calls)",
            },
          },
          additionalProperties: false,
        },
        async execute(args, context) {
          const { detail } = args as { detail?: boolean }

          let snapshot: UsageSnapshot
          try {
            snapshot = cache && Date.now() - cache.at <= TOOL_MAX_AGE_MS ? cache.snapshot : await refresh()
          } catch (error) {
            throw new Error(explain(error))
          }

          if (!detail) return { content: renderMarkdown(snapshot) }

          // The primary quota call already succeeded; detail rows degrade gracefully.
          const credentials = await resolveCredentials()
          if (!credentials) return { content: renderMarkdown(snapshot) }
          const [model, tools] = await Promise.allSettled([
            fetchModelUsage(credentials.token, credentials.platform, context.signal),
            fetchToolUsage(credentials.token, credentials.platform, context.signal),
          ])
          return {
            content: renderMarkdown(
              snapshot,
              model.status === "fulfilled" ? model.value : undefined,
              tools.status === "fulfilled" ? tools.value : undefined,
            ),
          }
        },
      })
    })

    // Keep the badge current.
    //
    // `session.usage.updated` fires on every model call of every session —
    // including parallel ones — so refreshes track live consumption mid-run.
    // `session.idle` covers anything that slips through. Both share the same
    // age gate and in-flight dedup, capping fetches at one per REFRESH_MIN_AGE_MS.
    // The drift interval guarantees convergence for usage that happens outside
    // this instance (another machine or tool on the same plan).
    const refreshIfStale = (minAgeMs: number) => {
      if (!cache || Date.now() - cache.at > minAgeMs) void refresh().catch(() => {})
    }

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.usage.updated" || event.type === "session.idle") {
          refreshIfStale(REFRESH_MIN_AGE_MS)
        }
      }
    })()

    const driftTimer = setInterval(() => refreshIfStale(REFRESH_MIN_AGE_MS), DRIFT_INTERVAL_MS)

    // Prime the badge; a user without Z.ai configured simply sees no badge.
    void refresh().catch((error) => console.error(`[zai-usage] initial fetch failed: ${explain(error)}`))

    return () => {
      clearInterval(driftTimer)
      controller.abort()
    }
  },
})
