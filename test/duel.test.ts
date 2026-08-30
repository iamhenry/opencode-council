import { describe, expect, it } from "vitest"
import {
  DUEL_CRITERIA,
  championSlot,
  duelFromGrader,
  duelGraderSystemPrompt,
  duelGraderUserPrompt,
  excludeHoldout,
  holdoutCaseId,
  parseDuel,
  pairVerdict,
  promotionGate,
  sanitizeCaseResult,
  sanitizeText,
  seedFor,
  seededRandom,
  tallyAll,
  tallyCase,
  type CriterionDuel,
  type DuelGrade,
} from "../harness/duel.js"
import { findForbidden } from "../harness/blind.js"
import { CAPABILITY_CASES } from "../harness/capability.js"

const CRITERIA_IDS = DUEL_CRITERIA.map((c) => c.id)

// ---------------------------------------------------------------------------
// Blinded slot assignment

describe("slot assignment", () => {
  it("seededRandom is deterministic and in [0,1)", () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it("seedFor is deterministic and varies per input", () => {
    expect(seedFor("cap-x", 1)).toBe(seedFor("cap-x", 1))
    expect(seedFor("cap-x", 1)).not.toBe(seedFor("cap-x", 2))
    expect(seedFor("cap-x", 1)).not.toBe(seedFor("cap-y", 1))
  })

  it("championSlot is deterministic and both slots occur across cases", () => {
    for (const c of CAPABILITY_CASES) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const slot = championSlot(c.caseId, attempt)
        expect(slot === "A" || slot === "B").toBe(true)
        expect(slot).toBe(championSlot(c.caseId, attempt))
      }
    }
    const slots = new Set(CAPABILITY_CASES.flatMap((c) => [championSlot(c.caseId, 1), championSlot(c.caseId, 2)]))
    expect(slots.has("A")).toBe(true)
    expect(slots.has("B")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Grader prompt hygiene

describe("duel grader prompts", () => {
  it("prompts never contain model identities", () => {
    const sys = duelGraderSystemPrompt()
    const user = duelGraderUserPrompt({ caseId: "c", question: "q", a: "da", b: "db" })
    // "provider/model" shape (e.g. "openai/gpt-5") must never appear in grader
    // prompts. Risky words contain "/" (hidden_risks) so require letters on
    // BOTH sides with a digit in the model part — real model refs have one.
    expect(sys).not.toMatch(/[a-z][a-z0-9_-]*\/[a-z0-9_.-]*\d[a-z0-9_.-]*/)
    expect(user).not.toMatch(/[a-z][a-z0-9_-]*\/[a-z0-9_.-]*\d[a-z0-9_.-]*/)
    expect(sys).toContain("A and B")
  })

  it("prompts expose no champion/challenger identity", () => {
    const user = duelGraderUserPrompt({ caseId: "c", question: "q", a: "da", b: "db" })
    expect(user.toLowerCase()).not.toContain("champion")
    expect(user.toLowerCase()).not.toContain("challenger")
    expect(duelGraderSystemPrompt().toLowerCase()).not.toContain("champion")
  })
})

// ---------------------------------------------------------------------------
// parseDuel + duelFromGrader

describe("parseDuel", () => {
  it("parses a valid grader response", () => {
    const json = JSON.stringify({
      duels: [{ label_a_scores: { correctness: 2 }, label_b_scores: { correctness: 1 }, verdicts: { correctness: "a" }, note: "clear" }],
    })
    const res = parseDuel(json)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.duels[0]?.verdicts.correctness).toBe("a")
  })

  it("tolerates prose around the JSON", () => {
    const text = 'Sure! Here is the result:\n{"duels":[{"label_a_scores":{},"label_b_scores":{},"verdicts":{},"note":"n"}]}\nHope that helps.'
    expect(parseDuel(text).ok).toBe(true)
  })

  it("rejects missing/garbled JSON and schema violations", () => {
    expect(parseDuel("no json here").ok).toBe(false)
    expect(parseDuel('{"duels":"nope"}').ok).toBe(false)
    expect(parseDuel('{"duels":[{"label_a_scores":{"correctness":9},"label_b_scores":{},"verdicts":{},"note":""}]}').ok).toBe(false) // out of 0-2 range
    expect(parseDuel('{"duels":[{"label_a_scores":{},"label_b_scores":{},"verdicts":{"correctness":"challenger"},"note":""}]}').ok).toBe(false)
  })
})

describe("duelFromGrader", () => {
  it("maps A/B verdicts onto champion/challenger by known slot (both slots covered)", () => {
    const caseA = CAPABILITY_CASES.find((c) => championSlot(c.caseId, 1) === "A") ?? CAPABILITY_CASES[0]!
    const caseB = CAPABILITY_CASES.find((c) => championSlot(c.caseId, 1) === "B") ?? CAPABILITY_CASES[0]!
    const parsed = {
      label_a_scores: Object.fromEntries(CRITERIA_IDS.map((id) => [id, 2])),
      label_b_scores: Object.fromEntries(CRITERIA_IDS.map((id) => [id, 0])),
      verdicts: Object.fromEntries(CRITERIA_IDS.map((id) => [id, "a" as const])),
      note: "",
    }
    const gA = duelFromGrader({ caseId: caseA.caseId, attempt: 1, parsed, criteria: CRITERIA_IDS })
    expect(gA.championSlot).toBe("A")
    for (const c of gA.criteria) {
      expect(c.champion).toBe(2)
      expect(c.challenger).toBe(0)
      expect(c.note).toBe("a")
    }
    const gB = duelFromGrader({ caseId: caseB.caseId, attempt: 1, parsed, criteria: CRITERIA_IDS })
    expect(gB.championSlot).toBe("B")
    for (const c of gB.criteria) {
      expect(c.champion).toBe(0)
      expect(c.challenger).toBe(2)
      expect(c.note).toBe("a")
    }
  })

  it("never fabricates wins from unknown/missing data", () => {
    const g = duelFromGrader({
      caseId: "cap-x",
      attempt: 1,
      parsed: { label_a_scores: {}, label_b_scores: {}, verdicts: {}, note: "" },
      criteria: CRITERIA_IDS,
    })
    for (const c of g.criteria) {
      expect(c.champion).toBe(0)
      expect(c.challenger).toBe(0)
      expect(c.note).toBe("unknown")
      expect(pairVerdict(c)).toBe("unknown") // unknown recorded as unknown, never a fabricated win/loss
    }
  })

  it("missing one label score forces unknown even when a verdict exists", () => {
    const g = duelFromGrader({
      caseId: "cap-x",
      attempt: 1,
      parsed: { label_a_scores: { correctness: 2 }, label_b_scores: {}, verdicts: { correctness: "a" }, note: "" },
      criteria: ["correctness"],
    })
    expect(g.criteria[0]?.note).toBe("unknown")
    expect(g.criteria[0]?.champion).toBe(0)
    expect(g.criteria[0]?.challenger).toBe(0)
  })

  it("contradictory scores and verdicts become unknown", () => {
    const g = duelFromGrader({
      caseId: "cap-x",
      attempt: 1,
      parsed: { label_a_scores: { correctness: 2 }, label_b_scores: { correctness: 0 }, verdicts: { correctness: "tie" }, note: "" },
      criteria: ["correctness"],
    })
    expect(g.criteria[0]?.note).toBe("unknown")
    expect(pairVerdict(g.criteria[0]!)).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// Tallies

function grade(caseId: string, attempt: number, criteria: CriterionDuel[]): DuelGrade {
  return { caseId, attempt, championSlot: championSlot(caseId, attempt), criteria }
}

describe("tallyCase / tallyAll", () => {
  it("counts wins, losses, ties, unknowns per criterion", () => {
    const duels = [
      grade("cap-x", 1, [
        { criterion: "correctness", champion: 2, challenger: 0, note: "win" },
        { criterion: "evidence", champion: 0, challenger: 2, note: "loss" },
        { criterion: "simplicity", champion: 1, challenger: 1, note: "tie" },
        { criterion: "hidden_risks", champion: 0, challenger: 0, note: "unknown" },
        { criterion: "actionability", champion: 2, challenger: 1, note: "win" },
      ]),
      grade("cap-x", 2, [
        { criterion: "correctness", champion: 2, challenger: 2, note: "tie" },
        { criterion: "evidence", champion: 0, challenger: 0, note: "unknown" },
        { criterion: "simplicity", champion: 1, challenger: 2, note: "loss" },
        { criterion: "hidden_risks", champion: 2, challenger: 0, note: "win" },
        { criterion: "actionability", champion: 0, challenger: 0, note: "unknown" },
      ]),
    ]
    const t = tallyCase(duels)
    // Tallies are from the challenger's perspective.
    expect(t.correctness).toEqual({ wins: 0, losses: 1, ties: 1, unknown: 0 })
    expect(t.evidence).toEqual({ wins: 1, losses: 0, ties: 0, unknown: 1 })
    expect(t.simplicity).toEqual({ wins: 1, losses: 0, ties: 1, unknown: 0 })
    expect(t.hidden_risks).toEqual({ wins: 0, losses: 1, ties: 0, unknown: 1 })
    expect(t.actionability).toEqual({ wins: 0, losses: 1, ties: 0, unknown: 1 })

    const all = tallyAll({ "cap-x": t })
    expect(all.correctness).toEqual(t.correctness)
  })

  it("ignores criteria ids the grader invented", () => {
    const duels = [grade("cap-x", 1, [{ criterion: "made_up_criterion" as never, champion: 2, challenger: 0, note: "win" }])]
    const t = tallyCase(duels)
    for (const id of CRITERIA_IDS) expect(t[id]).toEqual({ wins: 0, losses: 0, ties: 0, unknown: 0 })
  })
})

// ---------------------------------------------------------------------------
// Promotion gate

const passingRegression = (caseId: string) => ({
  caseId,
  modeRequested: "deep",
  machine: { artifactSchemaValid: true, modeUsed: "deep", degradation: null, failures: [] as string[] },
})

function tallyWith(wins: number, losses: number): Record<string, ReturnType<typeof tallyCase>> {
  // Build the tally shape directly via tallyCase so shapes stay in sync.
  const duels: DuelGrade[] = [
    grade("cap-dummy", 1, [{ criterion: "correctness", champion: wins, challenger: 0, note: "" }, { criterion: "evidence", champion: losses, challenger: wins, note: "" }]),
  ]
  // Adjust: use pairVerdict semantics via champion/challenger totals.
  void duels
  return {
    "cap-dummy": tallyCase([
      grade("cap-dummy", 1, [
        ...Array.from({ length: wins }, () => ({ criterion: "correctness" as const, champion: 0, challenger: 2, note: "w" })),
        ...Array.from({ length: losses }, () => ({ criterion: "correctness" as const, champion: 2, challenger: 0, note: "l" })),
      ]),
    ]),
  }
}

describe("promotionGate", () => {
  it("promotes when all three gates hold", () => {
    const gate = promotionGate({
      regressionResults: [passingRegression("r1"), passingRegression("r2"), passingRegression("r3")],
      capabilityTallies: { ...tallyWith(3, 1), "cap-hold": tallyWith(10, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(gate.regressionPass).toBe(true)
    expect(gate.capabilityWinsMoreThanLosses).toBe(true)
    expect(gate.holdoutNoRegress).toBe(true)
    expect(gate.promoted).toBe(true)
    expect(gate.reasons).toEqual([])
  })

  it("blocks on any regression failure", () => {
    const bad = passingRegression("r1")
    bad.machine.failures = ["council error"]
    const gate = promotionGate({
      regressionResults: [bad, passingRegression("r2"), passingRegression("r3")],
      capabilityTallies: { ...tallyWith(5, 0), "cap-hold": tallyWith(10, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(gate.regressionPass).toBe(false)
    expect(gate.promoted).toBe(false)
    expect(gate.reasons.some((r) => r.includes("regression"))).toBe(true)
  })

  it("blocks on regression mode mismatch and degradation", () => {
    const mismatch = passingRegression("r1")
    mismatch.machine.modeUsed = "lean"
    const degraded = passingRegression("r2")
    degraded.machine.degradation = "panel shrank"
    const gate = promotionGate({
      regressionResults: [mismatch, degraded, passingRegression("r3")],
      capabilityTallies: { ...tallyWith(5, 0), "cap-hold": tallyWith(10, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(gate.promoted).toBe(false)
  })

  it("accepts lean or deep as the resolved mode for an auto regression case", () => {
    const auto = passingRegression("auto")
    auto.modeRequested = "auto"
    auto.machine.modeUsed = "lean"
    const gate = promotionGate({
      regressionResults: [auto],
      capabilityTallies: { ...tallyWith(2, 0), "cap-hold": tallyWith(10, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(gate.regressionPass).toBe(true)
    expect(gate.promoted).toBe(true)
  })

  it("blocks when challenger wins ≤ losses", () => {
    const gate = promotionGate({
      regressionResults: [passingRegression("r1")],
      capabilityTallies: { ...tallyWith(2, 2), "cap-hold": tallyWith(10, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(gate.capabilityWinsMoreThanLosses).toBe(false)
    expect(gate.promoted).toBe(false)
  })

  it("blocks when the holdout regresses (losses > wins) or is missing", () => {
    const holdoutTally = tallyWith(0, 10)
    const gate = promotionGate({
      regressionResults: [passingRegression("r1")],
      capabilityTallies: { ...tallyWith(5, 0), "cap-procedure-holdout": holdoutTally["cap-dummy"]! },
      holdoutCaseId: holdoutCaseId(),
    })
    expect(gate.holdoutNoRegress).toBe(false)
    expect(gate.promoted).toBe(false)

    const missing = promotionGate({
      regressionResults: [passingRegression("r1")],
      capabilityTallies: tallyWith(5, 0),
      holdoutCaseId: holdoutCaseId(),
    })
    expect(missing.holdoutNoRegress).toBe(false)
    expect(missing.promoted).toBe(false)
  })

  it("blocks when holdout grading is incomplete or unknown", () => {
    const incomplete = promotionGate({
      regressionResults: [passingRegression("r1")],
      capabilityTallies: { ...tallyWith(2, 0), "cap-hold": tallyWith(1, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(incomplete.holdoutNoRegress).toBe(false)
    expect(incomplete.promoted).toBe(false)
  })

  it("excludes the holdout from capability win counts", () => {
    const gate = promotionGate({
      regressionResults: [passingRegression("r1")],
      capabilityTallies: { ...tallyWith(0, 1), "cap-hold": tallyWith(10, 0)["cap-dummy"]! },
      holdoutCaseId: "cap-hold",
    })
    expect(gate.capabilityWinsMoreThanLosses).toBe(false)
    expect(gate.holdoutNoRegress).toBe(true)
    expect(gate.promoted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Sanitization

describe("sanitizeText / sanitizeCaseResult", () => {
  it("strips machine paths, session ids, uuids", () => {
    const out = sanitizeText("see /Users/alice/x/y.ts and /var/folders/ab/cd/T/xyz and /tmp/w and ses_abc123 and 123e4567-e89b-12d3-a456-426614174000")
    expect(out).not.toContain("/Users/")
    expect(out).not.toContain("/var/folders/")
    expect(out).not.toContain("/tmp/")
    expect(out).not.toContain("ses_")
    expect(out).not.toContain("123e4567")
    expect(out).toContain("<path>")
    expect(out).toContain("<session>")
    expect(out).toContain("<uuid>")
  })

  it("sanitizeCaseResult drops sessionEvidence and sanitizes question/artifact", () => {
    const res = sanitizeCaseResult({
      caseId: "c",
      question: "path is /Users/me/secret",
      machine: { failures: [], sessionEvidence: { modelIDsSeen: ["x/y"] } },
      artifact: { recommendation: "use /tmp/store" },
    })
    expect(res.machine.sessionEvidence).toBeUndefined()
    expect(res.machine.failures).toEqual([])
    expect(res.question).not.toContain("/Users/")
    expect(JSON.stringify(res.artifact)).not.toContain("/tmp/")
  })
})

// ---------------------------------------------------------------------------
// Capability case blinding

describe("capability cases blinding", () => {
  it("no capability case string contains a forbidden word", () => {
    const strings = CAPABILITY_CASES.flatMap((c) => [
      c.caseId,
      c.slug,
      c.question,
      c.context ?? "",
      ...Object.entries(c.seedFiles).flatMap(([k, v]) => [k, v]),
    ])
    for (const s of strings) expect(findForbidden(s)).toEqual([])
  })
})

describe("holdout report isolation", () => {
  it("keeps holdout cases and artifacts out of tuning-facing results", () => {
    const cases = [
      { caseId: "cap-dev", artifact: { recommendation: "visible" } },
      { caseId: holdoutCaseId(), artifact: { recommendation: "hidden" } },
    ]
    const visible = excludeHoldout(cases, holdoutCaseId())
    expect(visible.map((c) => c.caseId)).toEqual(["cap-dev"])
    expect(JSON.stringify(visible)).not.toContain("hidden")
  })
})
