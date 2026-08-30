/**
 * Thin adapter over the OpenCode V1 SDK client. This is the ONLY module that
 * touches the real SDK, so unit tests mock the `CouncilClient` interface and
 * never the SDK itself.
 *
 * Spike findings (opencode 1.18.x, @opencode-ai/sdk 1.18.14):
 * - session.create accepts { parentID, title } (typed).
 * - session.prompt accepts { parts, model, system, tools } (typed).
 * - session.prompt `variant` exists in the runtime but is MISSING from the
 *   generated types (types lag runtime). We send it via a narrow cast and
 *   only for models whose capabilities.reasoning is true.
 * - config.providers returns only configured/authenticated providers, each
 *   with models carrying capabilities.reasoning.
 * - session.abort cancels a running prompt.
 */
import type { createOpencodeClient } from "@opencode-ai/sdk"

export type ModelRef = { providerID: string; modelID: string }

export type AvailableModel = ModelRef & { reasoning: boolean }

export type PromptSpec = {
  sessionID: string
  /** Role instructions, sent as the `system` field. */
  system: string
  /** User turn (question + context). */
  message: string
  model: ModelRef
  /** Reasoning variant; only sent when the model reports reasoning support. */
  variant?: string
  modelSupportsReasoning: boolean
  /** Per-prompt tool allow/deny map; council prompts always deny mutators. */
  tools: Readonly<Record<string, boolean>>
}

export type PromptResult = { text: string; sessionID: string }

export const DENIED_TOOLS: Record<string, boolean> = {
  edit: false,
  write: false,
  patch: false,
  bash: false,
  read: true,
  grep: true,
  glob: true,
  list: true,
  task: false,
  council: false,
  forge: false,
  question: false,
  todowrite: false,
  webfetch: true,
}

export interface CouncilClient {
  /** Models from configured/authenticated providers. */
  listModels(): Promise<AvailableModel[]>
  /** Fresh child session for audit; title must make its role obvious. */
  createChildSession(title: string, parentID: string): Promise<string>
  /** Sends one prompt turn; tools are always denied per DENIED_TOOLS. */
  prompt(spec: PromptSpec): Promise<PromptResult>
  abort(sessionID: string): Promise<void>
}

type SdkClient = ReturnType<typeof createOpencodeClient>

export function createSdkCouncilClient(sdk: SdkClient, directory: string): CouncilClient {
  return {
    async listModels() {
      const res = await sdk.config.providers({ query: { directory } })
      if (res.error) throw new Error(`Failed to list providers: ${JSON.stringify(res.error)}`)
      const out: AvailableModel[] = []
      for (const provider of res.data?.providers ?? []) {
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          out.push({
            providerID: provider.id,
            modelID,
            reasoning: model.capabilities?.reasoning ?? false,
          })
        }
      }
      return out
    },

    async createChildSession(title, parentID) {
      const res = await sdk.session.create({
        body: { parentID, title },
        query: { directory },
      })
      if (res.error) throw new Error(`Failed to create session "${title}": ${JSON.stringify(res.error)}`)
      return res.data!.id
    },

    async prompt(spec) {
      const body: Record<string, unknown> = {
        parts: [{ type: "text", text: spec.message }],
        system: spec.system,
        model: { providerID: spec.model.providerID, modelID: spec.model.modelID },
        tools: spec.tools ?? DENIED_TOOLS,
      }
      if (spec.variant && spec.modelSupportsReasoning) {
        // ponytail: variant is runtime-only (missing from generated SDK types);
        // cast until @opencode-ai/sdk types catch up.
        body.variant = spec.variant
      }
      const res = await sdk.session.prompt({
        path: { id: spec.sessionID },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: body as any,
        query: { directory },
      })
      if (res.error) throw new Error(`Prompt failed in session ${spec.sessionID}: ${JSON.stringify(res.error)}`)
      const text = (res.data?.parts ?? [])
        .filter((p) => (p as { type: string }).type === "text")
        .map((p) => (p as unknown as { text: string }).text)
        .join("\n")
        .trim()
      return { text, sessionID: spec.sessionID }
    },

    async abort(sessionID) {
      // Abort on an already-finished session is harmless; swallow errors so
      // cleanup never masks the original failure.
      try {
        await sdk.session.abort({ path: { id: sessionID }, query: { directory } })
      } catch {
        /* already stopped */
      }
    },
  }
}
