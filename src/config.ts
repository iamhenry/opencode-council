import { z } from "zod"

export const DEFAULT_COUNCIL_PANEL_MODELS = [
  "openai/gpt-5.6-sol",
  "opencode-go/kimi-k3",
  "xai/grok-4.6",
]
export const DEFAULT_COUNCIL_ROUTER_MODEL = "opencode-go/glm-5.3-flash"
export const DEFAULT_COUNCIL_JUDGE_MODEL = "openai/gpt-5.6-sol"
export const DEFAULT_COUNCIL_COMPOSER_MODEL = "openai/gpt-5.6-sol"

export const CouncilConfigSchema = z.object({
  /** Panel models as "provider/model". 2 for lean, 3 for deep. Must be distinct model IDs. */
  panelModels: z.array(z.string().min(1)).min(2).max(3).default([...DEFAULT_COUNCIL_PANEL_MODELS]),
  /** Router (auto mode) model. */
  routerModel: z.string().min(1).default(DEFAULT_COUNCIL_ROUTER_MODEL),
  /** Judge model; may overlap panel models. */
  judgeModel: z.string().min(1).default(DEFAULT_COUNCIL_JUDGE_MODEL),
  /** Optional router fallback retained for explicit custom configurations. */
  smallModel: z.string().min(1).optional(),
  /** Reasoning variant (e.g. "high"/"medium") sent only to reasoning-capable models. */
  variant: z.string().min(1).optional(),
  /** Opt-in composer that renders a short prose answer from the artifact. */
  composer: z.boolean().default(false),
  composerModel: z.string().min(1).default(DEFAULT_COUNCIL_COMPOSER_MODEL),
  /** Per-stage timeout in ms. Elapsed stage = aborted, counted as failure. */
  timeoutMs: z.number().int().positive().default(180_000),
})

export type CouncilConfig = z.output<typeof CouncilConfigSchema>

export function parseConfig(options: unknown): CouncilConfig {
  const res = CouncilConfigSchema.safeParse(options ?? {})
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`opencode-council config error: ${issues}`)
  }
  return res.data
}

export function parseModelRef(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model reference "${ref}" — expected "provider/model" (e.g. "anthropic/claude-sonnet-4").`)
  }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}
