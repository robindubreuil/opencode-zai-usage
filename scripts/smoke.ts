/**
 * Dev-only live smoke test (not shipped):
 *
 *   npx tsx scripts/smoke.ts [global|cn]
 *
 * Reads the token from ZHIPU_API_KEY/ZAI_API_KEY or falls back to OpenCode's
 * auth store. Prints parsed output — never the token.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fetchModelUsage, fetchQuotaSnapshot, fetchToolUsage, type Platform } from "../src/zai"
import { renderMarkdown } from "../src/render"

function tokenFromAuthStore(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8")) as Record<string, { key?: string }>
    return auth["zai-coding-plan"]?.key ?? auth["zai"]?.key ?? auth["zhipuai-coding-plan"]?.key ?? auth["zhipuai"]?.key
  } catch {
    return undefined
  }
}

const platform: Platform = process.argv[2] === "cn" ? "cn" : "global"
const token = process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY ?? tokenFromAuthStore()

if (!token) {
  console.error("No token found (ZHIPU_API_KEY, ZAI_API_KEY, or OpenCode auth store).")
  process.exit(1)
}

const signal = AbortSignal.timeout(30_000)
const quota = await fetchQuotaSnapshot(token, platform, signal)
const [model, tools] = await Promise.all([
  fetchModelUsage(token, platform, signal).catch(() => undefined),
  fetchToolUsage(token, platform, signal).catch(() => undefined),
])

console.log(renderMarkdown({ ...quota, platform, fetchedAt: Date.now() }, model, tools))
