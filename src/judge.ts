import { parseArtifact } from "./artifact.js"
import type { DecisionArtifact } from "./artifact.js"
import { runPanelist } from "./panel.js"
import type { CouncilClient, ModelRef } from "./opencode.js"
import { judgeRepairPrompt, judgeSystemPrompt, judgeUserPrompt } from "./prompts.js"

export type PanelResponse = { role: string; model: string; text: string }

export async function runJudge(input: {
  client: CouncilClient
  parentID: string
  model: ModelRef
  supportsVariant: boolean
  variant?: string
  question: string
  context?: string
  responses: PanelResponse[]
  failures: string[]
  panelRoles: string[]
  timeoutMs: number
  signal: AbortSignal
}): Promise<DecisionArtifact> {
  const system = judgeSystemPrompt(input.panelRoles)
  const message = judgeUserPrompt({
    question: input.question,
    context: input.context,
    responses: input.responses,
    failures: input.failures,
  })

  const first = await runPanelist({
    client: input.client,
    parentID: input.parentID,
    title: `Council — judge (${input.model.providerID}/${input.model.modelID})`,
    system,
    message,
    model: input.model,
    supportsVariant: input.supportsVariant,
    variant: input.variant,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })

  const firstParse = parseArtifact(first.text)
  if (firstParse.ok) return { ...firstParse.artifact }

  // One repair round: show the judge its invalid output and the error.
  const repaired = await runPanelist({
    client: input.client,
    parentID: input.parentID,
    title: `Council — judge (repair)`,
    system,
    message: judgeRepairPrompt(first.text, firstParse.error),
    model: input.model,
    supportsVariant: input.supportsVariant,
    variant: input.variant,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
  const secondParse = parseArtifact(repaired.text)
  if (secondParse.ok) return { ...secondParse.artifact }

  throw new Error(
    `Judge produced an invalid decision artifact after one repair attempt. Validation error: ${firstParse.error}. Judge output (truncated): ${repaired.text.slice(0, 1000)}`,
  )
}
