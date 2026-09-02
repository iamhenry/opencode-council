import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { renderArtifact } from "./artifact.js"
import { parseConfig } from "./config.js"
import { runCouncil, CouncilModelError } from "./council.js"
import type { CouncilToolArgs } from "./council.js"
import { createSdkCouncilClient } from "./opencode.js"
import type { Plugin } from "@opencode-ai/plugin"

/**
 * opencode-council — a multi-model decision council for OpenCode V1.
 *
 * Spawns fresh, read-only SDK child sessions (panelists + judge), runs them in
 * parallel, and returns a validated structured decision artifact. Never
 * mutates the repo; all internal sessions deny edit/write/patch/bash/task.
 *
 * Configure via opencode.json:
 *   "plugin": [["opencode-council", { "panelModels": [...], ... }]]
 */
export const CouncilPlugin: Plugin = async (input, options) => {
  const config = parseConfig(options)
  const council = createSdkCouncilClient(input.client, input.directory)

  return {
    tool: {
      council: tool({
        description: [
          "Convene a multi-model council to deliberate on a question and return a structured decision artifact.",
          "Spawns independent read-only child sessions (2 panelists in lean mode; Architect/Skeptic/Pragmatist in deep mode), then a judge that weighs evidence — never a majority vote.",
          "Use for consequential decisions that benefit from independent model perspectives. Does not edit files or run commands.",
        ].join(" "),
        args: {
          question: z.string().describe("The decision or question for the council to deliberate on."),
          context: z
            .string()
            .optional()
            .describe("Optional current proposal, code excerpts, or background the panelists should consider."),
          mode: z
            .enum(["auto", "lean", "deep"])
            .default("auto")
            .describe(
              "lean: 2 generalist panelists. deep: Architect + Skeptic + Pragmatist. auto: one router call classifies the question; uncertain routes lean.",
            ),
          panel_models: z
            .array(z.string())
            .min(2)
            .max(3)
            .optional()
            .describe(
              'Per-call panel model overrides as "provider/model" (2 for lean, 3 for deep). Must be distinct model IDs available from authenticated providers.',
            ),
          router_model: z
            .string()
            .min(1)
            .optional()
            .describe('Per-call router override as "provider/model". Used only in auto mode.'),
          judge_model: z
            .string()
            .min(1)
            .optional()
            .describe('Per-call judge override as "provider/model".'),
        },
        execute: async (args, ctx) => {
          const result = await runCouncil(council, config, args as CouncilToolArgs, ctx.sessionID, ctx.abort)
          ctx.metadata({
            title: `Council — ${result.artifact.mode_used} — ${result.artifact.degradation ? "degraded" : "ok"}`,
            metadata: result.artifact,
          })
          return {
            title: `Council decision (${result.artifact.mode_used}${result.artifact.degradation ? ", degraded" : ""})`,
            output: result.output,
            metadata: result.artifact,
          }
        },
      }),
    },
  }
}

export default CouncilPlugin
export { renderArtifact, CouncilModelError }
