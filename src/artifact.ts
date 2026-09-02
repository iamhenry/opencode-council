import { z } from "zod"

/**
 * The structured decision artifact the judge must produce. Every field is
 * required so downstream consumers can rely on a stable shape.
 */
export const DecisionArtifactSchema = z.object({
  recommendation: z.string().min(1),
  confidence: z.string().min(1),
  consensus: z.string().min(1),
  disagreements: z.array(z.string()),
  strongest_evidence: z.array(z.string()).min(1),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  blind_spots: z.array(z.string()),
  simplest_viable_option: z.string().min(1),
  change_my_mind_evidence: z.string().min(1),
  next_step: z.string().min(1),
  /** Filled by the tool, not the judge; validated permissively. */
  mode_used: z.enum(["low", "medium"]).optional(),
  /** "ok" | "degraded" — filled by the tool. */
  degradation: z.string().optional(),
  /** Disclosed failures — filled by the tool. */
  failures: z.array(z.string()).optional(),
})

export type DecisionArtifact = z.output<typeof DecisionArtifactSchema>

export type ArtifactParseResult =
  | { ok: true; artifact: DecisionArtifact }
  | { ok: false; error: string }

/** Extracts the first JSON object from a model response, tolerating code fences. */
export function extractJson(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function parseArtifact(text: string): ArtifactParseResult {
  const json = extractJson(text)
  if (json === undefined) return { ok: false, error: "No JSON object found in judge response." }
  const res = DecisionArtifactSchema.safeParse(json)
  if (res.success) return { ok: true, artifact: res.data }
  const issues = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
  return { ok: false, error: `Judge JSON failed schema validation: ${issues}` }
}

/** Human-readable markdown rendering of the artifact for tool output. */
export function renderArtifact(a: DecisionArtifact): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)")
  return [
    `## Recommendation`,
    a.recommendation,
    ``,
    `**Confidence:** ${a.confidence}  |  **Mode:** ${a.mode_used ?? "unknown"}${a.degradation ? `  |  **Degraded:** ${a.degradation}` : ""}`,
    ``,
    `### Consensus`,
    a.consensus,
    ``,
    `### Disagreements`,
    list(a.disagreements),
    ``,
    `### Strongest evidence`,
    list(a.strongest_evidence),
    ``,
    `### Assumptions`,
    list(a.assumptions),
    ``,
    `### Risks`,
    list(a.risks),
    ``,
    `### Blind spots`,
    list(a.blind_spots),
    ``,
    `### Simplest viable option`,
    a.simplest_viable_option,
    ``,
    `### Change-my-mind evidence`,
    a.change_my_mind_evidence,
    ``,
    `### Next step`,
    a.next_step,
    ...(a.failures?.length ? [``, `### Failures disclosed`, list(a.failures)] : []),
  ].join("\n")
}
