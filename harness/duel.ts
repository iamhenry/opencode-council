/**
 * Champion-challenger capability duel (pure logic — unit-covered in
 * test/duel.test.ts). KISS by design: no dashboard, no Elo, no shared
 * framework, no new dependencies. Two runs per case per side, decision
 * artifacts frozen into the champion file once, then compared under blinded,
 * randomized A/B labels via one grader call per case per criterion axis.
 *
 * The grader sees anonymous labels (A/B) with model refs scrubbed; the
 * position of champion/challenger within A/B is randomized per case run with
 * a seeded PRNG so results are reproducible but label bias can't stack.
 */

import { z } from "zod"
import type { DecisionArtifact } from "../src/artifact.js"

// ---------------------------------------------------------------------------
// Blinded slot assignment

/** Mulberry32 — tiny seeded PRNG, sufficient for A/B assignment. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic hash so case IDs map to reproducible seeds. */
export function seedFor(caseId: string, attempt: number): number {
  let h = 2166136261
  const text = `${caseId}#${attempt}`
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Which label (A or B) holds the champion for a given case/attempt. */
export function championSlot(caseId: string, attempt: number): "A" | "B" {
  return seededRandom(seedFor(caseId, attempt))() < 0.5 ? "A" : "B"
}

// ---------------------------------------------------------------------------
// Duel grading

export const DUEL_CRITERIA = [
  { id: "correctness", description: "Does the recommendation concretely answer the question for the stated constraints, technically correct for 2026-era practice? Wrong or unboundedly hand-wavy scores 0-1." },
  { id: "evidence", description: "Evidence cites the scenario's concrete constraints (numbers, team, deadlines) and real trade-offs. Generic filler scores 0-1." },
  { id: "hidden_risks", description: "Risks/blind spots surface at least one non-obvious failure mode specific to this scenario (not boilerplate caveats). Only obvious risks score 0-1." },
  { id: "simplicity", description: "The simplest viable option is genuinely the least machinery that solves the stated problem, buildable now. Overbuilt or vague scores 0-1." },
  { id: "actionability", description: "The next step is small, concrete, and verifiable when done. 'Research more' without shape scores 0-1." },
] as const

export type DuelCriterionId = (typeof DUEL_CRITERIA)[number]["id"]

/** Per-criterion duel outcome between champion and challenger. */
export type CriterionDuel = { criterion: DuelCriterionId; champion: number; challenger: number; note: string }

/** One graded head-to-head pair (champion artifact vs challenger artifact). */
export type DuelGrade = { caseId: string; attempt: number; championSlot: "A" | "B"; criteria: CriterionDuel[] }

/** Tallied result across both runs of a case (or all cases). */
export type DuelTally = { wins: number; losses: number; ties: number; unknown: number }

// ---------------------------------------------------------------------------
// Grader prompts (rubric hidden from council runs; labels anonymous)

export function duelGraderSystemPrompt(): string {
  const criteria = DUEL_CRITERIA.map((c) => `- ${c.id}: ${c.description}`).join("\n")
  return [
    "You compare two decision artifacts for the SAME question, given under anonymous labels A and B.",
    "For each criterion below, score each label 0-2 and say which is strictly better on that criterion.",
    '"tie" means the scores are equal or the difference is cosmetic. "unknown" means a label is missing, garbled, or ungradeable — never guess.',
    "",
    "Criteria:",
    criteria,
    "",
    'Respond with a single JSON object and nothing else: {"duels":[{"label_a_scores":{"<criterion_id>":number},"label_b_scores":{"<criterion_id>":number},"verdicts":{"<criterion_id>":"a"|"b"|"tie"|"unknown"},"note":string}]}',
  ].join("\n")
}

export function duelGraderUserPrompt(item: { caseId: string; question: string; context?: string; a: string; b: string }): string {
  return [
    `## Question\n${item.question}${item.context ? `\n\n## Context\n${item.context}` : ""}`,
    `## Decision A\n${item.a}`,
    `## Decision B\n${item.b}`,
    "",
    "Compare the two decisions now.",
  ].join("\n\n")
}

export type ParsedDuel = { label_a_scores: Record<string, number>; label_b_scores: Record<string, number>; verdicts: Record<string, "a" | "b" | "tie" | "unknown">; note: string }

const Verdict = z.enum(["a", "b", "tie", "unknown"])

export function parseDuel(text: string): { ok: true; duels: ParsedDuel[] } | { ok: false; error: string } {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return { ok: false, error: "No JSON object found in duel grader response." }
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    return { ok: false, error: `Duel grader JSON unparseable: ${err instanceof Error ? err.message : String(err)}` }
  }
  const schema = z.object({
    duels: z.array(
      z.object({
        label_a_scores: z.record(z.string(), z.number().min(0).max(2)),
        label_b_scores: z.record(z.string(), z.number().min(0).max(2)),
        verdicts: z.record(z.string(), Verdict),
        note: z.string().default(""),
      }),
    ),
  })
  const res = schema.safeParse(json)
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { ok: false, error: `Duel grader JSON failed schema validation: ${issues}` }
  }
  return { ok: true, duels: res.data.duels }
}

/**
 * Convert one grader duel (anonymous A/B) into a champion-vs-challenger
 * DuelGrade, using the known champion slot. A missing/garbled label or any
 * ungradeable criterion becomes "unknown" for that criterion — never a
 * fabricated win or loss.
 */
export function duelFromGrader(input: {
  caseId: string
  attempt: number
  parsed: ParsedDuel
  criteria: readonly DuelCriterionId[]
}): DuelGrade {
  const championSlot_ = championSlot(input.caseId, input.attempt)
  const championIsA = championSlot_ === "A"
  const criteria: CriterionDuel[] = input.criteria.map((c) => {
    const aScore = input.parsed.label_a_scores[c] ?? null
    const bScore = input.parsed.label_b_scores[c] ?? null
    const verdict = input.parsed.verdicts[c] ?? "unknown"
    const scoreVerdict = aScore === null || bScore === null ? "unknown" : aScore === bScore ? "tie" : aScore > bScore ? "a" : "b"
    if (verdict === "unknown" || verdict !== scoreVerdict) {
      // Never fabricate a winner from missing data — record unknown on both sides.
      return { criterion: c, champion: 0, challenger: 0, note: "unknown" }
    }
    const championScore = championIsA ? aScore : bScore
    const challengerScore = championIsA ? bScore : aScore
    return { criterion: c, champion: championScore, challenger: challengerScore, note: verdict }
  })
  return { caseId: input.caseId, attempt: input.attempt, championSlot: championSlot_, criteria }
}

// ---------------------------------------------------------------------------
// Tallies and promotion

const CRITERIA_IDS = DUEL_CRITERIA.map((c) => c.id) as DuelCriterionId[]

/** Per-criterion verdict from one duel pair, from the challenger's perspective. */
export function pairVerdict(c: CriterionDuel): "win" | "loss" | "tie" | "unknown" {
  if (c.note === "unknown") return "unknown"
  if (c.champion === c.challenger) return "tie"
  return c.challenger > c.champion ? "win" : "loss"
}

/** Aggregate duels for one case (both attempts) into a tally per criterion. */
export function tallyCase(duels: DuelGrade[]): Record<DuelCriterionId, DuelTally> {
  const out = {} as Record<DuelCriterionId, DuelTally>
  for (const id of CRITERIA_IDS) out[id] = { wins: 0, losses: 0, ties: 0, unknown: 0 }
  for (const d of duels) {
    for (const c of d.criteria) {
      if (!CRITERIA_IDS.includes(c.criterion)) continue // unknown criterion from grader: ignore
      const v = pairVerdict(c)
      if (v === "unknown") out[c.criterion].unknown++
      else if (v === "tie") out[c.criterion].ties++
      else if (v === "win") out[c.criterion].wins++
      else out[c.criterion].losses++
    }
  }
  return out
}

/** Sum tallies across cases (both attempts of both sides included by caller). */
export function tallyAll(byCase: Record<string, Record<DuelCriterionId, DuelTally>>): Record<DuelCriterionId, DuelTally> {
  const out = {} as Record<DuelCriterionId, DuelTally>
  for (const id of CRITERIA_IDS) out[id] = { wins: 0, losses: 0, ties: 0, unknown: 0 }
  for (const t of Object.values(byCase)) {
    for (const id of CRITERIA_IDS) {
      out[id].wins += t[id]?.wins ?? 0
      out[id].losses += t[id]?.losses ?? 0
      out[id].ties += t[id]?.ties ?? 0
      out[id].unknown += t[id]?.unknown ?? 0
    }
  }
  return out
}

export type PromotionGate = {
  regressionPass: boolean
  capabilityWinsMoreThanLosses: boolean
  holdoutNoRegress: boolean
  promoted: boolean
  reasons: string[]
}

/**
 * Promotion gate — all must hold:
 *  1. every regression case passes its machine gates (artifact valid, explicit mode honored, no failures/degradation),
 *  2. across the 4 development cases × 2 runs × 5 criteria, challenger wins strictly more pairs than it loses,
 *  3. the holdout does not regress: challenger losses ≤ challenger wins on it.
 */
export function promotionGate(input: {
  regressionResults: { caseId: string; machine: { artifactSchemaValid: boolean; modeUsed: string | null; degradation: string | null; failures: string[] }; modeRequested: string }[]
  capabilityTallies: Record<string, Record<DuelCriterionId, DuelTally>>
  holdoutCaseId: string
}): PromotionGate {
  const reasons: string[] = []

  const passesRegression = (r: (typeof input.regressionResults)[number]) =>
    r.machine.artifactSchemaValid &&
    (r.modeRequested === "auto" ? r.machine.modeUsed === "lean" || r.machine.modeUsed === "deep" : r.machine.modeUsed === r.modeRequested) &&
    r.machine.degradation === null &&
    r.machine.failures.length === 0
  const regressionPass = input.regressionResults.every(passesRegression)
  if (!regressionPass) {
    const bad = input.regressionResults.filter((r) => !passesRegression(r))
    reasons.push(`regression gates failed for: ${bad.map((b) => b.caseId).join(", ")}`)
  }

  const developmentTallies = Object.fromEntries(Object.entries(input.capabilityTallies).filter(([caseId]) => caseId !== input.holdoutCaseId))
  const all = tallyAll(developmentTallies)
  const wins = Object.values(all).reduce((a, t) => a + t.wins, 0)
  const losses = Object.values(all).reduce((a, t) => a + t.losses, 0)
  const capabilityWinsMoreThanLosses = wins > losses
  if (!capabilityWinsMoreThanLosses) reasons.push(`challenger wins (${wins}) not greater than losses (${losses})`)

  const holdoutTally = input.capabilityTallies[input.holdoutCaseId]
  const holdoutCounts = holdoutTally
    ? Object.values(holdoutTally).reduce(
        (sum, tally) => ({ wins: sum.wins + tally.wins, losses: sum.losses + tally.losses, ties: sum.ties + tally.ties, unknown: sum.unknown + tally.unknown }),
        { wins: 0, losses: 0, ties: 0, unknown: 0 },
      )
    : null
  const expectedHoldoutGrades = DUEL_CRITERIA.length * 2
  const holdoutNoRegress = holdoutCounts !== null &&
    holdoutCounts.unknown === 0 &&
    holdoutCounts.wins + holdoutCounts.losses + holdoutCounts.ties === expectedHoldoutGrades &&
    holdoutCounts.losses <= holdoutCounts.wins
  if (!holdoutNoRegress) reasons.push(`holdout ${input.holdoutCaseId} regressed (losses exceed wins)`)

  return { regressionPass, capabilityWinsMoreThanLosses, holdoutNoRegress, promoted: regressionPass && capabilityWinsMoreThanLosses && holdoutNoRegress, reasons }
}

// ---------------------------------------------------------------------------
// Sanitization

/**
 * Remove anything that could leak machine/session/local-path specifics from a
 * stored report: absolute paths, temp-dir prefixes, session ids, timestamps.
 * Model identities are kept in the champion file as run-config, not session
 * data; per-case sessionEvidence is dropped entirely.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[^\s"'`,)]+/g, "<path>")
    .replace(/\/var\/folders\/[^\s"'`,)]+/g, "<path>")
    .replace(/\/tmp\/[^\s"'`,)]+/g, "<path>")
    .replace(/ses_[a-zA-Z0-9]+/g, "<session>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
}

/** Strip per-case runtime/session details before storing artifacts long-term. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeCaseResult(c: any): any {
  const { sessionEvidence, ...machineRest } = c.machine ?? {}
  void sessionEvidence
  return {
    ...c,
    question: sanitizeText(c.question ?? ""),
    machine: machineRest,
    artifact: c.artifact
      ? JSON.parse(sanitizeText(JSON.stringify(c.artifact)))
      : null,
  }
}

// ---------------------------------------------------------------------------
// Champion file shape

export type ChampionPair = { caseId: string; attempt: number; artifact: DecisionArtifact }

export type ChampionFile = {
  champion: { name: string; schema: 1 }
  council: { version: string; commit: string; models: { panel: string[]; router: string; judge: string } }
  frozenAt: string
  pairs: ChampionPair[]
}

export function holdoutCaseId(): string {
  return "cap-procedure-holdout"
}

/** Keep holdout artifacts out of tuning-facing reports. */
export function excludeHoldout<T extends { caseId: string }>(cases: T[], holdoutId: string): T[] {
  return cases.filter((c) => c.caseId !== holdoutId)
}
