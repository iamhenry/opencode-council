import { z } from "zod"
import { extractJson } from "./artifact.js"
import { DENIED_TOOLS } from "./opencode.js"
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
    const res = await withTimeout(
      input.client.prompt({
        sessionID,
        system: input.systemPrompt ?? routerSystemPrompt(),
        message: routerUserPrompt(input.question),
        model: input.model,
        variant: input.variant,
        modelSupportsReasoning: input.supportsVariant,
        tools: DENIED_TOOLS,
      }),
      input.timeoutMs,
      input.signal,
      () => input.client.abort(sessionID),
    )
    const parsed = RouterOutput.safeParse(extractJson(res.text))
    if (!parsed.success) return { mode: "low", reason: "router returned unparseable output; defaulted to low", routerFailed: true }
    return parsed.data
  } catch (err) {
    if (err instanceof CancelledError) throw err
    // Uncertain router → low. Never let router failure kill the council.
    return { mode: "low", reason: `router failed (${String(err)}); defaulted to low`, routerFailed: true }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
  }
}

export class CancelledError extends Error {}

/** Races a promise against the timeout and the cancellation signal. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  onTimeout?: (value: T | undefined) => Promise<void> | void,
): Promise<T> {
  // An already-aborted signal never fires "abort" for new listeners, so check
  // the flag up front: reject immediately instead of racing to the timeout.
  if (signal.aborted) throw new CancelledError("cancelled")
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CancelledError("cancelled"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    // Explicitly observe the losing prompt path: once the race settles (e.g.
    // via timeout), the hung SDK prompt can still reject during abort/teardown.
    // Promise.race technically holds a handler, but that late rejection was
    // observed live (opencode serve 1.18.23, 180s panelist timeout) escaping
    // as an unhandledRejection that crashed the host. This no-op observer
    // guarantees the loser is always observed; race semantics are unchanged.
    promise.catch(() => {})
    return await Promise.race([promise, abortPromise, timeoutPromise])
  } catch (err) {
    if (onTimeout) await onTimeout(undefined)
    throw err
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort!)
  }
}

/**
 * Runs one panelist: creates a titled child session, prompts it, enforces the
 * stage timeout, and aborts its session on timeout/cancellation.
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
  return withTimeout(
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
    input.timeoutMs,
    input.signal,
    () => input.client.abort(sessionID),
  )
}
