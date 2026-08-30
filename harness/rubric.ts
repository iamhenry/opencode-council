/**
 * Hidden grading rubric. Held back from council runs — only the grader sees
 * this file's prompts. The grader may know it is grading but receives
 * decisions under anonymous labels (A, B, C…) with model identities scrubbed.
 */
import { z } from "zod"

export type RubricCriterion = { id: string; description: string }

/** 5 concrete criteria, 0–2 each → max 10 per decision. */
export const RUBRIC: RubricCriterion[] = [
  {
    id: "answers_question",
    description:
      "The recommendation picks a concrete option and directly answers the question as asked, with justification tied to the stated constraints. Generic hedging scores 0.",
  },
  {
    id: "specific_evidence",
    description:
      "Strongest evidence cites the stated constraints or concrete trade-offs (numbers, effort, failure modes). Generic filler like 'it depends' or unsourced claims score 0-1.",
  },
  {
    id: "non_obvious_risks",
    description:
      "Risks or blind spots include at least one non-obvious concern a generic answer would miss. Only restating the obvious scores 0-1.",
  },
  {
    id: "genuinely_simple",
    description:
      "The simplest viable option is actually the simplest thing that could work, stated so it could be started today. Overbuilt or vague options score 0-1.",
  },
  {
    id: "actionable_next_step",
    description:
      "The next step is small, concrete, and checkable when done. 'Do more research' with no shape scores 0-1.",
  },
]

const CriterionGrade = z.object({
  score: z.number().min(0).max(2),
  note: z.string().default(""),
})

const DecisionGrade = z.object({
  label: z.string().min(1),
  criteria: z.record(z.string(), CriterionGrade),
  note: z.string().default(""),
})

export const GradesSchema = z.object({ decisions: z.array(DecisionGrade).min(1) })
export type DecisionGrade = z.output<typeof DecisionGrade>

export function graderSystemPrompt(): string {
  const criteria = RUBRIC.map((c) => `- ${c.id}: ${c.description}`).join("\n")
  return [
    "You grade decision artifacts for quality. You receive several decisions, each under an anonymous label; you do not know and must not guess where they came from.",
    "",
    "For each decision, score each criterion 0-2 (0 = missing or weak, 1 = partial, 2 = strong) and add a one-sentence note. Be strict: a generic answer that could have been written without reading the question scores low.",
    "",
    "Criteria:",
    criteria,
    "",
    'Respond with a single JSON object and nothing else: {"decisions":[{"label":string,"criteria":{"<criterion_id>":{"score":number,"note":string}},"note":string}]} — one entry per decision label, every criterion scored.',
  ].join("\n")
}

export function graderUserPrompt(items: { label: string; question: string; decision: string }[]): string {
  const sections = items.map(
    (it) => `## Decision ${it.label}\n\n### Original question\n${it.question}\n\n### Decision\n${it.decision}`,
  )
  return [sections.join("\n\n---\n\n"), "", "Grade every decision now."].join("\n")
}

export type GradesResult =
  | { ok: true; grades: DecisionGrade[] }
  | { ok: false; error: string }

/** Extracts and validates the grader's JSON, tolerating prose or fences. */
export function parseGrades(text: string): GradesResult {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return { ok: false, error: "No JSON object found in grader response." }
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    return { ok: false, error: `Grader JSON unparseable: ${err instanceof Error ? err.message : String(err)}` }
  }
  const res = GradesSchema.safeParse(json)
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { ok: false, error: `Grader JSON failed schema validation: ${issues}` }
  }
  return { ok: true, grades: res.data.decisions }
}
