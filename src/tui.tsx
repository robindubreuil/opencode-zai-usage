/** @jsxImportSource @opentui/solid */
/**
 * CLI plugin: live quota badge in the status line + `/zai` command.
 *
 * Zero model calls, zero credentials. All data arrives through the
 * `zai-usage` RPC served by the server plugin in `src/index.ts`.
 */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { ZaiUsageRpc, type UsageSnapshot } from "./rpc"
import { badgeLevel, badgeText, renderPlain } from "./render"

const BADGE_MAX_AGE_MS = 60_000
const DIALOG_MAX_AGE_MS = 15_000

const describe = (error: unknown): string => {
  const candidate = error as { data?: { message?: string }; message?: string }
  return candidate?.data?.message ?? candidate?.message ?? "Usage is unavailable right now. Try again in a moment."
}

export default Plugin.define({
  id: "zai-usage.tui",
  async setup(context) {
    const zai = context.client.rpc(ZaiUsageRpc)
    const theme = context.theme

    const [snapshot, setSnapshot] = createSignal<UsageSnapshot | undefined>(undefined)
    // Ticker so countdowns in the badge stay fresh even between refreshes.
    const [tick, setTick] = createSignal(0)
    const timer = setInterval(() => setTick((value) => value + 1), 60_000)

    const pull = async (maxAgeMs: number) => {
      try {
        setSnapshot((await zai.get({ maxAgeMs })) as unknown as UsageSnapshot)
      } catch {
        setSnapshot(undefined)
      }
    }
    void pull(BADGE_MAX_AGE_MS)

    // The server refreshes after each session goes idle and pushes updates.
    const unsubscribe = zai.events.on("refreshed", (event) => {
      setSnapshot(event.data as unknown as UsageSnapshot)
    })

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        void tick()
        const current = snapshot()
        const text = current && badgeText(current)
        if (!current || !text) return null
        const level = badgeLevel(current)
        const fg =
          level === "error"
            ? theme.text.feedback.error.base
            : level === "warning"
              ? theme.text.feedback.warning.base
              : theme.text.muted
        return <text fg={fg}>{text}</text>
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "zai.usage.show",
          title: "Z.ai usage",
          group: "Z.ai",
          palette: true,
          slash: { name: "zai" },
          run: async () => {
            try {
              const fresh = (await zai.get({ maxAgeMs: DIALOG_MAX_AGE_MS })) as unknown as UsageSnapshot
              setSnapshot(fresh)
              const shown = context.ui.dialog.alert({
                title: "Z.ai Coding Plan",
                message: renderPlain(fresh, { selectedModelID: context.ui.model.current()?.modelID }),
              })
              // Presentation hint only — content is already narrow-safe if unsupported.
              try {
                context.ui.dialog.set({ size: "large" })
              } catch {
                // Best effort.
              }
              await shown
            } catch (error) {
              await context.ui.dialog.alert({ title: "Z.ai usage", message: describe(error) })
            }
          },
        },
      ],
    }))

    return () => {
      clearInterval(timer)
      unsubscribe()
      removeSlot()
    }
  },
})
