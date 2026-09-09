import { z } from "zod"
import { extractJson } from "./artifact.js"
import { DENIED_TOOLS, TerminalPromptError } from "./opencode.js"
import type { CouncilClient, ModelRef, PromptResult } from "./opencode.js"
import { routerSystemPrompt, routerUserPrompt } from "./prompts.js"

const RouterOutput = z.object({
  mode: z.enum(["low", "medium"]),
  reason: z.string().default(""),
})

export type Route = { mode: "low" | "medium"; reason: string; routerFailed?: boolean }

export async function runRouter(input: {
  client: CouncilClient
  parentID: string
  model: ModelRef
  supportsVariant: boolean
  variant?: string
  question: string
  signal: AbortSignal
  timeoutMs: number
  systemPrompt?: string
}): Promise<Route> {
  // Cancellation must propagate, never become a low-route fallback.
  if (input.signal.aborted) throw new CancelledError("cancelled")
  try {
    const sessionID = await input.client.createChildSession(`Council — mode router`, input.parentID)
    const res = await withCancellation(
      input.client.prompt({
        sessionID,
        system: input.systemPrompt ?? routerSystemPrompt(),
        message: routerUserPrompt(input.question),
        model: input.model,
        variant: input.variant,
        modelSupportsReasoning: input.supportsVariant,
        tools: DENIED_TOOLS,
      }),
      input.signal,
      () => input.client.abort(sessionID),
    )
    const parsed = RouterOutput.safeParse(extractJson(res.text))
    if (!parsed.success) return { mode: "low", reason: "router returned unparseable output; defaulted to low", routerFailed: true }
    return parsed.data
  } catch (err) {
    if (!(err instanceof TerminalPromptError)) throw err
    // Only a confirmed router failure may fall back to low.
    return { mode: "low", reason: `router failed (${String(err)}); defaulted to low`, routerFailed: true }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

export class CancelledError extends Error {}

/** Native completion owns waiting; only user cancellation interrupts it. */
export async function withCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onCancel?: () => Promise<void> | void,
): Promise<T> {
  // An already-aborted signal never fires "abort" for new listeners, so check
  // the flag up front and clean up a prompt already submitted during creation.
  if (signal.aborted) {
    promise.catch(() => {})
    await onCancel?.()
    throw new CancelledError("cancelled")
  }
  let onAbort: () => void
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CancelledError("cancelled"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    // Cancellation can leave a late SDK rejection during teardown.
    promise.catch(() => {})
    return await Promise.race([promise, abortPromise])
  } catch (err) {
    if (err instanceof CancelledError) await onCancel?.()
    throw err
  } finally {
    signal.removeEventListener("abort", onAbort!)
  }
}

/**
 * Runs one native prompt in a fresh child; aborts only on user cancellation.
 */
export async function runPanelist(input: {
  client: CouncilClient
  parentID: string
  title: string
  system: string
  message: string
  model: ModelRef
  supportsVariant: boolean
  variant?: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<PromptResult> {
  // Stage-boundary guard: no session is created for an already-cancelled run.
  if (input.signal.aborted) throw new CancelledError("cancelled")
  const sessionID = await input.client.createChildSession(input.title, input.parentID)
  return withCancellation(
    input.client.prompt({
      sessionID,
      system: input.system,
      message: input.message,
      model: input.model,
      variant: input.variant,
      modelSupportsReasoning: input.supportsVariant,
      // Every council prompt denies mutators — this is the enforcement point.
      tools: DENIED_TOOLS,
    }),
    input.signal,
    () => input.client.abort(sessionID),
  )
}
