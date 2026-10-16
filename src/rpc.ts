/**
 * RPC contract shared by the server plugin (`.`) and the TUI plugin (`./tui`).
 *
 * The server owns credentials, fetching, and caching. The TUI is a dumb
 * renderer: it calls `get` and subscribes to `refreshed`. The API key never
 * leaves the server plugin.
 */

import { Rpc } from "@opencode/plugin/rpc"
import type { McpUsage, Platform, WindowUsage } from "./zai"

const windowSchema = {
  type: "object",
  properties: {
    percentage: { type: "number" },
    resetAt: { type: "number" },
  },
  required: ["percentage"],
  additionalProperties: false,
} as const

const mcpSchema = {
  type: "object",
  properties: {
    percentage: { type: "number" },
    resetAt: { type: "number" },
    used: { type: "number" },
    total: { type: "number" },
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: { code: { type: "string" }, usage: { type: "number" } },
        required: ["code", "usage"],
        additionalProperties: false,
      },
    },
  },
  required: ["percentage", "used", "total", "tools"],
  additionalProperties: false,
} as const

const snapshotSchema = {
  type: "object",
  properties: {
    plan: { type: "string" },
    platform: { type: "string", enum: ["global", "cn"] },
    fetchedAt: { type: "number" },
    fiveHour: windowSchema,
    weekly: windowSchema,
    mcp: mcpSchema,
  },
  required: ["fetchedAt"],
  additionalProperties: false,
} as const

const messageSchema = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
} as const

export interface UsageSnapshot {
  /** Index signature keeps this assignable to the RPC's JSON record types. */
  readonly [key: string]: unknown
  readonly plan?: string
  readonly platform?: Platform
  readonly fetchedAt: number
  readonly fiveHour?: WindowUsage
  readonly weekly?: WindowUsage
  readonly mcp?: McpUsage
}

export const ZaiUsageRpc = Rpc.define({
  id: "zai-usage",
  methods: {
    /** Current quota snapshot. `maxAgeMs` bounds the age of cached data (default 60s, 0 forces a refetch). */
    get: {
      input: {
        type: "object",
        properties: { maxAgeMs: { type: "number" } },
        additionalProperties: false,
      },
      output: snapshotSchema,
      errors: {
        no_credentials: messageSchema,
        unavailable: messageSchema,
      },
    },
  },
  events: {
    /** Emitted after every successful fetch so clients can update live displays. */
    refreshed: { schema: snapshotSchema },
  },
})
