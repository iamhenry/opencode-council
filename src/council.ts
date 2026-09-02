import { renderArtifact } from "./artifact.js"
import type { DecisionArtifact } from "./artifact.js"
import type { CouncilConfig } from "./config.js"
import { runJudge } from "./judge.js"
import type { PanelResponse } from "./judge.js"
import { resolveCouncilModels, CouncilModelError } from "./models.js"
import { runRouter, runPanelist, CancelledError } from "./panel.js"
import {
  architectPrompt,
  leanPanelistPrompt,
  panelUserPrompt,
  pragmatistPrompt,
  skepticPrompt,
} from "./prompts.js"
import type { CouncilClient } from "./opencode.js"

export type CouncilToolArgs = {
  question: string
  context?: string
  mode: "auto" | "lean" | "deep"
  panel_models?: string[]
  router_model?: string
  judge_model?: string
}

export type PanelistFailure = { role: string; model: string; error: string }

const ROLES: Record<"lean" | "deep", { role: string; system: () => string }[]> = {
  // Lean: two independent generalist panelists with equivalent inputs.
  lean: [
    { role: "Panelist", system: leanPanelistPrompt },
    { role: "Panelist", system: leanPanelistPrompt },
  ],
  deep: [
    { role: "Architect", system: architectPrompt },
    { role: "Skeptic", system: skepticPrompt },
    { role: "Pragmatist", system: pragmatistPrompt },
  ],
}

const ROUTER_SYSTEM = `You classify questions for a deliberation panel. "lean" uses 2 generalist panelists; "deep" uses a 3-role panel (Architect, Skeptic, Pragmatist) and takes roughly twice as long.

Route to "deep" ONLY when the question clearly involves trade-offs across architecture, security, or long-term maintainability that generalists would likely miss. When uncertain, route to "lean".

Respond with a single JSON object and nothing else: {"mode": "lean" | "deep", "reason": "<one sentence>"}`

export type CouncilOutcome = {
  artifact: DecisionArtifact
  output: string
}

export async function runCouncil(
  client: CouncilClient,
  config: CouncilConfig,
  args: CouncilToolArgs,
  parentSessionID: string,
  signal: AbortSignal,
): Promise<CouncilOutcome> {
  if (!args.question || args.question.trim().length === 0) {
    throw new Error("council requires a non-empty `question`.")
  }
  // A pre-aborted run must reject before any router/panel/judge
  // session is created or any model is invoked.
  if (signal.aborted) throw new CancelledError("council cancelled")

  // Per-call model args override config (explicit wins).
  const effectiveConfig: CouncilConfig = {
    ...config,
    ...(args.panel_models?.length ? { panelModels: args.panel_models } : {}),
    ...(args.router_model ? { routerModel: args.router_model } : {}),
    ...(args.judge_model ? { judgeModel: args.judge_model } : {}),
  }

  // Mode: explicit wins; auto makes exactly one dedicated structured router
  // call, and uncertain/failed routing falls back to lean.
  let mode: "lean" | "deep"
  let modeReason: string
  if (args.mode !== "auto") {
    mode = args.mode
    modeReason = "explicitly requested"
  } else {
    const leanMin = await resolveCouncilModels(client, effectiveConfig, 2)
    const route = await runRouter({
      client,
      parentID: parentSessionID,
      model: leanMin.router!,
      supportsVariant: leanMin.router!.supportsVariant,
      variant: config.variant,
      question: args.question,
      signal,
      timeoutMs: Math.min(config.timeoutMs, 60_000),
      systemPrompt: ROUTER_SYSTEM,
    })
    if (route.mode === "deep" && effectiveConfig.panelModels && effectiveConfig.panelModels.length < 3) {
      // Only 2 panel models configured: deep needs 3 distinct roles, so stay
      // lean instead of guessing a third model.
      mode = "lean"
      modeReason = `router chose deep but only 2 panel models configured; kept lean`
    } else {
      mode = route.mode
      modeReason = route.reason
    }
  }

  const roleCount = mode === "deep" ? 3 : 2
  // Routing is complete (or was explicitly skipped), so do not validate an
  // unused router while resolving the panel and judge.
  const models = await resolveCouncilModels(client, effectiveConfig, roleCount, { router: false })
  const panel = models.panel
  const variant = config.variant

  const roleSpecs = ROLES[mode]!
  const userMessage = panelUserPrompt({ question: args.question, context: args.context })

  // Panelists run in PARALLEL and independently: equivalent inputs, no
  // cross-visibility. Individual failure degrades but does not abort the run.
  const settled = await Promise.allSettled(
    roleSpecs.map((spec, i) => {
      const model = panel[i]!
      return runPanelist({
        client,
        parentID: parentSessionID,
        title: `Council — ${mode} panelist ${i + 1} ${spec.role} (${model.providerID}/${model.modelID})`,
        system: spec.system(),
        message: userMessage,
        model,
        supportsVariant: model.supportsVariant,
        variant,
        timeoutMs: config.timeoutMs,
        signal,
      }).then((res) => ({ role: spec.role, model, text: res.text }))
    }),
  )

  const responses: PanelResponse[] = []
  const failures: PanelistFailure[] = []
  settled.forEach((s, i) => {
    const spec = roleSpecs[i]!
    const model = panel[i]!
    if (s.status === "fulfilled") {
      responses.push({ role: spec.role, model: `${model.providerID}/${model.modelID}`, text: s.value.text })
    } else {
      failures.push({
        role: spec.role,
        model: `${model.providerID}/${model.modelID}`,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      })
    }
  })

  if (signal.aborted) throw new CancelledError("council cancelled")

  if (responses.length === 0) {
    const detail = failures.map((f) => `${f.role} (${f.model}): ${f.error}`).join("; ")
    throw new Error(`council panel failed completely — no panelist succeeded. Failures: ${detail}`)
  }

  // Judge may overlap panel models; defaults to the first panel model.
  const judgeModel = models.judge

  const artifact = await runJudge({
    client,
    parentID: parentSessionID,
    model: judgeModel,
    supportsVariant: judgeModel.supportsVariant,
    variant,
    question: args.question,
    context: args.context,
    responses,
    failures: failures.map((f) => `${f.role} (${f.model}): ${f.error}`),
    panelRoles: roleSpecs.map((r) => r.role),
    timeoutMs: config.timeoutMs,
    signal,
  })

  artifact.mode_used = mode
  artifact.degradation =
    failures.length > 0
      ? `degraded: ${failures.length} of ${roleSpecs.length} panelists failed; result based on ${responses.length} panelist(s)`
      : undefined
  artifact.failures = failures.map((f) => `${f.role} (${f.model}): ${f.error}`)

  return {
    artifact,
    output: renderArtifact(artifact),
  }
}

export { CouncilModelError }
