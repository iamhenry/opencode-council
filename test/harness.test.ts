import { describe, expect, it } from "vitest"
import { assertBlind, findForbidden, scrubModelRefs, FORBIDDEN_WORDS } from "../harness/blind.js"
import { CASES, assertCasesBlind } from "../harness/cases.js"
import { graderSystemPrompt, graderUserPrompt, parseGrades, RUBRIC } from "../harness/rubric.js"
import { buildReport, baselineRefusal, compareToBaseline, renderDecisionForGrader } from "../harness/run.js"
import { DecisionArtifactSchema } from "../src/artifact.js"
import type { CaseResult, Baseline } from "../harness/run.js"

// ---------------------------------------------------------------------------
// Blinding (playbook non-negotiables)

describe("blinding", () => {
  it("checker flags every forbidden word", () => {
    for (const w of FORBIDDEN_WORDS) {
      expect(findForbidden(`xx ${w} yy`)).toContain(w)
      expect(findForbidden(`XX ${w.toUpperCase()} YY`)).toContain(w)
    }
  })

  it("checker matches substrings, not just words", () => {
    expect(findForbidden("latest release")).toContain("test")
    expect(findForbidden("evaluator")).toContain("eval")
  })

  it("assertBlind throws with the offending label and words", () => {
    expect(() => assertBlind("compare the options", "my label")).toThrow(/my label.*compare/)
  })

  it("every case string a council run can see is blind", () => {
    expect(() => assertCasesBlind(assertBlind)).not.toThrow()
    expect(CASES.length).toBeGreaterThanOrEqual(2)
    expect(CASES.length).toBeLessThanOrEqual(3)
  })

  it("cases cover lean and deep", () => {
    expect(CASES.some((c) => c.mode === "lean")).toBe(true)
    expect(CASES.some((c) => c.mode === "deep")).toBe(true)
    expect(CASES.some((c) => c.mode === "auto")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Grader prompt hygiene and parsing

function validArtifactJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommendation: "Use a JSON file",
    confidence: "high",
    consensus: "all agree",
    disagreements: [],
    strongest_evidence: ["a few hundred rows is nothing"],
    assumptions: [],
    risks: ["corruption on crash"],
    blind_spots: [],
    simplest_viable_option: "One JSON file with a write lock",
    change_my_mind_evidence: "Multi-device sync",
    next_step: "Write the load/save helpers",
    ...extra,
  })
}

describe("grader", () => {
  it("grader prompts never contain model identities", () => {
    const sys = graderSystemPrompt()
    const user = graderUserPrompt([{ label: "A", question: "q", decision: "d" }])
    expect(sys).not.toMatch(/\/[a-z0-9]/) // "provider/model" shape
    expect(user).not.toMatch(/\([a-z0-9.-]+\/[a-z0-9.-]+\)/)
  })

  it("rubric has 3-6 criteria", () => {
    expect(RUBRIC.length).toBeGreaterThanOrEqual(3)
    expect(RUBRIC.length).toBeLessThanOrEqual(6)
  })

  it("parseGrades accepts valid grader JSON", () => {
    const json = JSON.stringify({
      decisions: [{ label: "A", criteria: { answers_question: { score: 2, note: "direct" } }, note: "solid" }],
    })
    const res = parseGrades(json)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.grades[0]!.criteria.answers_question!.score).toBe(2)
  })

  it("parseGrades tolerates prose around the JSON and rejects invalid scores", () => {
    expect(parseGrades(`Sure!\n${JSON.stringify({ decisions: [{ label: "A", criteria: {} }] })}\nDone`).ok).toBe(true)
    expect(parseGrades(JSON.stringify({ decisions: [{ label: "A", criteria: { x: { score: 5 } } }] })).ok).toBe(false)
    expect(parseGrades("no json here").ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Model-ref scrubbing

describe("scrubModelRefs", () => {
  it("scrubs known refs and parenthesized provider/model pairs", () => {
    const out = scrubModelRefs("Panelist (openai/gpt-5.6-sol): timeout; also (acme/other-model) failed", ["openai/gpt-5.6-sol"])
    expect(out).not.toContain("openai/gpt-5.6-sol")
    expect(out).not.toContain("acme/other-model")
    expect(out.match(/panelist model/g)?.length).toBe(2)
  })

  it("scrubs model refs out of a rendered artifact with failures", () => {
    const artifact = DecisionArtifactSchema.parse(JSON.parse(validArtifactJson({ failures: ["Panelist (xai/grok-4.6): timed out after 180000ms"] })))
    const out = scrubModelRefs(renderDecisionForGrader(artifact), ["xai/grok-4.6"])
    expect(out).not.toContain("xai/grok-4.6")
    expect(out).toContain("(panelist model): timed out")
  })
})

// ---------------------------------------------------------------------------
// Report shape and baseline comparison

function fakeCase(caseId: string, total: number | null, modeUsed: string | null): CaseResult {
  return {
    caseId,
    slug: `${caseId}-ws`,
    modeRequested: "auto",
    question: "q?",
    machine: {
      artifactSchemaValid: modeUsed !== null,
      modeUsed,
      degradation: null,
      failures: [],
      councilError: null,
      sessionEvidence: { childSessionCount: 3, messageCount: 5, modelIDsSeen: ["m1"], error: null },
    },
    artifact: modeUsed !== null ? (DecisionArtifactSchema.parse(JSON.parse(validArtifactJson())) as CaseResult["artifact"]) : null,
    grade: total === null ? null : { total, maxTotal: 10, criteria: {}, note: "n" },
    gradeError: null,
  }
}

function fakeReport(cases: CaseResult[]): ReturnType<typeof buildReport> {
  return buildReport({
    startedAt: "2026-08-30T10:00:00.000Z",
    finishedAt: "2026-08-30T10:05:00.000Z",
    commit: "abc123",
    models: { panel: ["a/x", "b/y"], router: "c/z", judge: "a/x", grader: "d/w" },
    cases,
    comparison: null,
  })
}

describe("report shape", () => {
  it("has stable top-level sections with timestamps isolated from comparison fields", () => {
    const report = fakeReport([fakeCase("a", 8, "lean")])
    expect(Object.keys(report)).toEqual(["harness", "council", "run", "cases", "aggregate", "comparison"])
    expect(report.harness.schema).toBe(1)
    expect(report.council.version).toBeTruthy()
    expect(report.council.commit).toBe("abc123")
    expect(report.run.startedAt).toBe("2026-08-30T10:00:00.000Z")
    expect(report.run.durationMs).toBe(300_000)
    expect(report.comparison).toBeNull()
    expect(report.aggregate.allArtifactsValid).toBe(true)
    expect(report.aggregate.modesCovered).toEqual(["lean"])
    expect(report.aggregate.meanGradeTotal).toBe(8)
  })

  it("mean grade is null when any case is ungraded", () => {
    const report = fakeReport([fakeCase("a", 8, "lean"), fakeCase("b", null, null)])
    expect(report.aggregate.meanGradeTotal).toBeNull()
    expect(report.aggregate.allArtifactsValid).toBe(false)
  })
})

describe("baseline comparison", () => {
  const baseline: Baseline = {
    harness: { name: "opencode-council-quality-run", schema: 1 },
    council: { version: "0.1.1", commit: "abc123" },
    run: { startedAt: "2026-08-30T09:00:00.000Z" },
    cases: [
      { caseId: "a", machine: fakeCase("a", 8, "lean").machine, grade: { total: 8 } },
      { caseId: "b", machine: fakeCase("b", 6, "deep").machine, grade: { total: 6 } },
    ],
    aggregate: { allArtifactsValid: true, modesCovered: ["lean", "deep"], degradedRuns: 0, runsWithFailures: 0, meanGradeTotal: 7 },
  }

  it("reports same/better/worse verdicts per case and in aggregate", () => {
    const report = fakeReport([fakeCase("a", 8, "lean"), fakeCase("b", 4, "deep")])
    const cmp = compareToBaseline(report, baseline)
    expect(cmp.perCase[0]!.gradeTotal.verdict).toBe("same")
    expect(cmp.perCase[1]!.gradeTotal.verdict).toBe("worse")
    expect(cmp.aggregate.verdict).toBe("worse")
    expect(cmp.commitChanged).toBe(false)
  })

  it("handles new cases and ungraded runs without pretending significance", () => {
    const report = fakeReport([fakeCase("a", 9, "lean"), fakeCase("new", null, null)])
    const cmp = compareToBaseline(report, baseline)
    expect(cmp.perCase[0]!.gradeTotal.verdict).toBe("better")
    expect(cmp.perCase[1]!.gradeTotal.verdict).toBe("no-baseline")
    expect(cmp.aggregate.verdict).toBe("no-baseline")
    expect(cmp.note).toMatch(/directional/)
  })

  it("flags commit drift between baseline and current run", () => {
    const report = fakeReport([fakeCase("a", 8, "lean")])
    const cmp = compareToBaseline(report, { ...baseline, council: { version: "0.1.1", commit: "def456" } })
    expect(cmp.commitChanged).toBe(true)
  })
})

describe("deliberate baseline refresh gate", () => {
  it("refuses writing to the baseline path without --accept-baseline", () => {
    const msg = baselineRefusal("/r/harness/baseline.json", "/r/harness/baseline.json", false)
    expect(msg).toMatch(/--accept-baseline/)
    expect(msg).toMatch(/baseline/)
  })

  it("allows the overwrite with --accept-baseline and any other out path", () => {
    expect(baselineRefusal("/r/harness/baseline.json", "/r/harness/baseline.json", true)).toBeNull()
    expect(baselineRefusal("/tmp/run.json", "/r/harness/baseline.json", false)).toBeNull()
  })
})

describe("model drift comparison", () => {
  const models = { panel: ["a/x", "b/y"], router: "c/z", judge: "a/x", grader: "d/w" }
  const base: Baseline = {
    harness: { name: "opencode-council-quality-run", schema: 1 },
    council: { version: "0.1.1", commit: "abc123" },
    run: { startedAt: "2026-08-30T09:00:00.000Z" },
    cases: [{ caseId: "a", machine: fakeCase("a", 8, "lean").machine, grade: { total: 8 } }],
    aggregate: { allArtifactsValid: true, modesCovered: ["lean"], degradedRuns: 0, runsWithFailures: 0, meanGradeTotal: 8 },
  }
  const baselineWithModels: Baseline = {
    ...base,
    council: { ...base.council, models },
  }

  it("reports no drift when model identities match", () => {
    const report = fakeReport([fakeCase("a", 8, "lean")])
    const cmp = compareToBaseline(report, baselineWithModels)
    expect(cmp.models.changed).toBe(false)
    expect(cmp.models.comparable).toBe(true)
    expect(cmp.models.deltas.every((d) => d.from === d.to)).toBe(true)
    expect(cmp.note).not.toMatch(/not directly comparable/)
  })

  it("flags changed identities and warns grade deltas are not comparable", () => {
    const report = fakeReport([fakeCase("a", 8, "lean")])
    const cmp = compareToBaseline(report, { ...baselineWithModels, council: { ...baselineWithModels.council, models: { ...models, grader: "d/v" } } })
    expect(cmp.models.changed).toBe(true)
    expect(cmp.models.comparable).toBe(false)
    const graderDelta = cmp.models.deltas.find((d) => d.role === "grader")
    expect(graderDelta).toEqual({ role: "grader", from: "d/v", to: "d/w" })
    expect(cmp.note).toMatch(/not directly comparable/)
  })

  it("treats a baseline without recorded models as not comparable", () => {
    const report = fakeReport([fakeCase("a", 8, "lean")])
    const cmp = compareToBaseline(report, base)
    expect(cmp.models.changed).toBe(false)
    expect(cmp.models.comparable).toBe(false)
    expect(cmp.models.deltas).toEqual([])
    expect(cmp.note).toMatch(/not directly comparable/)
  })
})
