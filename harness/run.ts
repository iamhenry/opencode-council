/**
 * Blind quality harness for opencode-council.
 *
 * One command spawns a real OpenCode server, runs every organic case through
 * the actual Council runtime with live models, collects machine checks plus
 * real session evidence, grades decisions through a blinded grader, and
 * writes a machine-readable report that can be compared against a baseline.
 *
 * Blinding: case prompts and workspace names are organic (enforced by
 * harness/blind.ts); the grader sees anonymous labels with model refs
 * scrubbed. Trust artifacts and session transcripts, never self-report.
 *
 * Usage: bun harness/run.ts [--out <path>] [--baseline <path>] [--no-compare] [--accept-baseline]
 * Env: COUNCIL_PANEL_MODELS="a/x,b/y" COUNCIL_GRADER_MODEL="a/z" COUNCIL_TIMEOUT_MS=180000
 */
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runCouncil } from "../src/council.js"
import type { CouncilToolArgs } from "../src/council.js"
import type { DecisionArtifact } from "../src/artifact.js"
import { parseConfig } from "../src/config.js"
import { createSdkCouncilClient } from "../src/opencode.js"
import { assertBlind, assertCasesBlind, scrubModelRefs } from "./blind.js"
import { CASES, assertCasesBlind as checkCases } from "./cases.js"
import { graderSystemPrompt, graderUserPrompt, parseGrades, RUBRIC } from "./rubric.js"

const HARNESS_ROOT = path.dirname(fileURLToPath(new URL(import.meta.url)))
const PKG = JSON.parse(readFileSync(path.join(HARNESS_ROOT, "..", "package.json"), "utf8"))
const DEFAULT_OUT = path.join(HARNESS_ROOT, "last-run.json")
const DEFAULT_BASELINE = path.join(HARNESS_ROOT, "baseline.json")

// ---------------------------------------------------------------------------
// Pure helpers (unit-covered in test/harness.test.ts)

export type MachineChecks = {
  artifactSchemaValid: boolean
  modeUsed: string | null
  degradation: string | null
  failures: string[]
  councilError: string | null
  sessionEvidence: {
    childSessionCount: number | null
    messageCount: number | null
    modelIDsSeen: string[]
    error: string | null
  }
}

export type CaseResult = {
  caseId: string
  slug: string
  modeRequested: string
  question: string
  machine: MachineChecks
  artifact: DecisionArtifact | null
  grade: { total: number; maxTotal: number; criteria: Record<string, { score: number; note: string }>; note: string } | null
  gradeError: string | null
}

export type RunReport = {
  harness: { name: string; schema: 1 }
  council: { version: string; commit: string; models: { panel: string[]; router: string; judge: string; grader: string } }
  run: { startedAt: string; finishedAt: string; durationMs: number; casesRun: number }
  cases: CaseResult[]
  aggregate: {
    allArtifactsValid: boolean
    modesCovered: string[]
    degradedRuns: number
    runsWithFailures: number
    meanGradeTotal: number | null
  }
  comparison: ComparisonResult | null
}

export type Baseline = {
  harness: { name: string; schema: 1 }
  council: {
    version: string
    commit: string
    /** Recorded in v0.1.1+ baselines; absent in hand-written ones — drift then reported as not comparable. */
    models?: RunReport["council"]["models"]
  }
  run: { startedAt: string }
  cases: { caseId: string; machine: MachineChecks; grade: { total: number } | null }[]
  aggregate: RunReport["aggregate"]
}

export type ModelDrift = {
  changed: boolean
  /** False when models differ or the baseline does not record them — grade deltas are then not directly comparable. */
  comparable: boolean
  deltas: { role: keyof RunReport["council"]["models"]; from: string | null; to: string | null }[]
}

export type ComparisonResult = {
  baselineVersion: string
  baselineCommit: string
  commitChanged: boolean
  models: ModelDrift
  perCase: {
    caseId: string
    gradeTotal: { current: number | null; baseline: number | null; delta: number | null; verdict: "better" | "worse" | "same" | "no-baseline" | "ungraded" }
    modeUsed: { current: string | null; baseline: string | null; changed: boolean }
    artifactValid: { current: boolean; baseline: boolean }
  }[]
  aggregate: { meanGradeDelta: number | null; verdict: "better" | "worse" | "same" | "no-baseline" | "ungraded" }
  note: string
}

export function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: HARNESS_ROOT, encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

export function buildReport(input: {
  startedAt: string
  finishedAt: string
  commit: string
  models: RunReport["council"]["models"]
  cases: CaseResult[]
  comparison: ComparisonResult | null
}): RunReport {
  const cases = input.cases
  const totals = cases.map((c) => c.grade?.total).filter((t): t is number => typeof t === "number")
  return {
    harness: { name: "opencode-council-quality-run", schema: 1 },
    council: { version: PKG.version as string, commit: input.commit, models: input.models },
    run: {
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: Date.parse(input.finishedAt) - Date.parse(input.startedAt),
      casesRun: cases.length,
    },
    cases,
    aggregate: {
      allArtifactsValid: cases.every((c) => c.machine.artifactSchemaValid),
      modesCovered: [...new Set(cases.map((c) => c.machine.modeUsed).filter((m): m is string => m !== null))],
      degradedRuns: cases.filter((c) => c.machine.degradation !== null).length,
      runsWithFailures: cases.filter((c) => c.machine.failures.length > 0).length,
      meanGradeTotal: totals.length === cases.length && cases.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
    },
    comparison: input.comparison,
  }
}

/** Compact text rendering of a decision artifact for the grader (no model refs; scrubbed separately). */
export function renderDecisionForGrader(a: DecisionArtifact): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)")
  return [
    "## Recommendation",
    a.recommendation,
    `**Confidence:** ${a.confidence}  |  **Mode:** ${a.mode_used}`,
    "",
    "### Consensus",
    a.consensus,
    "",
    "### Disagreements",
    list(a.disagreements),
    "",
    "### Strongest evidence",
    list(a.strongest_evidence),
    "",
    "### Risks",
    list(a.risks),
    "",
    "### Blind spots",
    list(a.blind_spots),
    "",
    "### Simplest viable option",
    a.simplest_viable_option,
    "",
    "### Change-my-mind evidence",
    a.change_my_mind_evidence,
    "",
    "### Next step",
    a.next_step,
    ...(a.failures?.length ? ["", "### Failures disclosed", list(a.failures)] : []),
  ].join("\n")
}

function verdict(current: number | null, baseline: number | null): ComparisonResult["perCase"][number]["gradeTotal"]["verdict"] {  if (current === null || baseline === null) return "ungraded"
  if (current > baseline) return "better"
  if (current < baseline) return "worse"
  return "same"
}

/** Pure arg check so the deliberate-overwrite gate is unit-testable. */
export function baselineRefusal(outPath: string, baselinePath: string, acceptBaseline: boolean): string | null {
  if (outPath !== baselinePath) return null
  if (acceptBaseline) return null
  return `Refusing: --out must not be the baseline file (${baselinePath}). Baselines are written deliberately: pass --accept-baseline with --out ${baselinePath} once a run is verified.`
}

export function compareToBaseline(report: RunReport, baseline: Baseline): ComparisonResult {
  const perCase = report.cases.map((c) => {
    const b = baseline.cases.find((x) => x.caseId === c.caseId)
    const delta = c.grade && b?.grade ? c.grade.total - b.grade.total : null
    return {
      caseId: c.caseId,
      gradeTotal: {
        current: c.grade?.total ?? null,
        baseline: b?.grade?.total ?? null,
        delta,
        verdict: !b ? "no-baseline" : delta === null ? "ungraded" : verdict(c.grade!.total, b.grade!.total),
      },
      modeUsed: { current: c.machine.modeUsed, baseline: b?.machine.modeUsed ?? null, changed: b !== undefined && b.machine.modeUsed !== c.machine.modeUsed },
      artifactValid: { current: c.machine.artifactSchemaValid, baseline: b?.machine.artifactSchemaValid ?? false },
    }
  })
  const deltas = perCase.map((p) => p.gradeTotal.delta).filter((d): d is number => d !== null)
  const roles = ["panel", "router", "judge", "grader"] as const
  const baselineModels = baseline.council.models
  const modelDeltas = baselineModels
    ? roles.map((role) => {
        const from = role === "panel" ? (baselineModels.panel ?? []).join(",") : baselineModels[role]
        const to = role === "panel" ? report.council.models.panel.join(",") : report.council.models[role]
        return { role, from, to }
      })
    : []
  const modelsChanged = modelDeltas.some((d) => d.from !== d.to)
  const modelDrift: ModelDrift = {
    changed: modelsChanged,
    comparable: baselineModels !== undefined && !modelsChanged,
    deltas: modelDeltas,
  }
  const gradeWarning = modelDrift.comparable ? "" : " Models differ from the baseline (or the baseline records none) — grade deltas are not directly comparable."
  return {
    baselineVersion: baseline.council.version,
    baselineCommit: baseline.council.commit,
    commitChanged: baseline.council.commit !== report.council.commit,
    models: modelDrift,
    perCase,
    aggregate: {
      meanGradeDelta:
        report.aggregate.meanGradeTotal !== null && typeof baseline.aggregate.meanGradeTotal === "number"
          ? report.aggregate.meanGradeTotal - baseline.aggregate.meanGradeTotal
          : null,
      verdict: deltas.length === report.cases.length && report.cases.length > 0 ? verdict(report.aggregate.meanGradeTotal, baseline.aggregate.meanGradeTotal) : deltas.length === 0 ? "ungraded" : "no-baseline",
    },
    note: "Single-run grade deltas are directional signals, not statistically significant. Machine checks (mode used, artifact validity, failures) are the harder evidence." + gradeWarning,
  }
}

// ---------------------------------------------------------------------------
// Live run plumbing

function envModels(): string[] | undefined {
  const raw = process.env.COUNCIL_PANEL_MODELS
  if (!raw) return undefined
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean)
  return list.length >= 2 ? list : undefined
}

async function collectEvidence(
  sdk: ReturnType<typeof createOpencodeClient>,
  directory: string,
  parentID: string,
): Promise<MachineChecks["sessionEvidence"]> {
  try {
    const childrenRes = await sdk.session.children({ path: { id: parentID }, query: { directory } })
    // SDK response shapes vary between 1.18.x patch releases; normalize defensively.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = childrenRes.data as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const children: { id: string }[] = Array.isArray(d) ? d : (d?.sessions ?? [])
    let messageCount = 0
    const modelIDs = new Set<string>()
    for (const child of children) {
      const mres = await sdk.session.messages({ path: { id: child.id }, query: { directory } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = mres.data as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgs: any[] = Array.isArray(md) ? md : (md?.messages ?? md?.parts ?? [])
      for (const m of msgs) {
        const info = m?.info ?? m
        if (info?.role === "assistant" || info?.modelID) messageCount++
        if (typeof info?.modelID === "string") modelIDs.add(info.modelID)
      }
    }
    return { childSessionCount: children.length, messageCount, modelIDsSeen: [...modelIDs].sort(), error: null }
  } catch (err) {
    return { childSessionCount: null, messageCount: null, modelIDsSeen: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function gradeOf(grade: CaseResult["grade"], note: string): CaseResult["grade"] {
  return grade ? { ...grade, note: grade.note || note } : null
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const outArg = argv.includes("--out") ? argv[argv.indexOf("--out") + 1]! : DEFAULT_OUT
  const baselineArg = argv.includes("--baseline") ? argv[argv.indexOf("--baseline") + 1]! : DEFAULT_BASELINE
  const noCompare = argv.includes("--no-compare")
  const acceptBaseline = argv.includes("--accept-baseline")

  const outPath = path.resolve(outArg)
  const baselinePath = path.resolve(baselineArg)
  const refusal = baselineRefusal(outPath, baselinePath, acceptBaseline)
  if (refusal) {
    console.error(refusal)
    return 2
  }

  // Blinding gate: refuse to run if any candidate-visible string trips it.
  checkCases(assertBlind)

  const config = parseConfig({
    panelModels: envModels(),
    timeoutMs: process.env.COUNCIL_TIMEOUT_MS ? Number(process.env.COUNCIL_TIMEOUT_MS) : undefined,
  })

  const startedAt = new Date().toISOString()
  const commit = currentCommit()
  // Hoisted so the finally below can sanitize temp workspaces even when the
  // run throws mid-case (session create, council, evidence, grading).
  const workspaces: string[] = []
  console.log(`Spawning OpenCode server (council v${PKG.version}, commit ${commit.slice(0, 12)})…`)
  const server = await createOpencodeServer({ port: 49152 + (process.pid % 15000), timeout: 30_000 })
  try {
    const sdk = createOpencodeClient({ baseUrl: server.url })
    const available = await createSdkCouncilClient(sdk, process.cwd()).listModels()
    if (available.length === 0) throw new Error("No authenticated providers found — run `opencode auth login` first.")

    const graderModel = pickGraderModel(available, config.judgeModel, config.panelModels)

    // Grader preflight: fail fast on broken/region-locked grader auth before
    // spending panel runs.
    try {
      const pre = await sdk.session.create({ body: { title: "Warmup" }, query: { directory: process.cwd() } })
      const pres = await sdk.session.prompt({
        path: { id: pre.data!.id },
        body: {
          parts: [{ type: "text", text: 'Reply with exactly {"ok":true}' }],
          model: { providerID: graderModel.split("/")[0]!, modelID: graderModel.split("/").slice(1).join("/") },
        },
        query: { directory: process.cwd() },
      })
      if (pres.error) {
        throw new Error(`grader model ${graderModel} is not usable: ${JSON.stringify(pres.error).slice(0, 300)}`)
      }
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)} — pick another via COUNCIL_GRADER_MODEL`)
    }

    const cases: CaseResult[] = []
    const sanitizedForGrader: { label: string; question: string; decision: string }[] = []
    const labelByCaseId = new Map<string, string>()

    for (const c of CASES) {
      console.log(`\n=== ${c.caseId} (${c.slug}, mode=${c.mode}) ===`)
      const ws = await mkdtemp(path.join(tmpdir(), `${c.slug}-`))
      workspaces.push(ws)
      for (const [name, content] of Object.entries(c.seedFiles)) {
        mkdirSync(path.dirname(path.join(ws, name)), { recursive: true })
        await writeFile(path.join(ws, name), content)
      }

      // Council client is scoped to the sanitized workspace so every internal
      // session (router/panelists/judge) is created inside it.
      const councilClient = createSdkCouncilClient(sdk, ws)
      const parent = await sdk.session.create({ body: { title: `Planning — ${c.slug}` }, query: { directory: ws } })
      const parentID = parent.data!.id

      const args: CouncilToolArgs = { question: c.question, mode: c.mode, context: c.context }
      const caseStarted = Date.now()
      let artifact: DecisionArtifact | null = null
      let councilError: string | null = null
      try {
        const outcome = await runCouncil(councilClient, config, args, parentID, AbortSignal.timeout(config.timeoutMs * 5))
        artifact = outcome.artifact
      } catch (err) {
        councilError = err instanceof Error ? err.message : String(err)
        console.error(`Council run failed: ${councilError.slice(0, 500)}`)
      }
      console.log(`Council finished in ${((Date.now() - caseStarted) / 1000).toFixed(1)}s`)

      const evidence = await collectEvidence(sdk, ws, parentID)
      cases.push({
        caseId: c.caseId,
        slug: c.slug,
        modeRequested: c.mode,
        question: c.question,
        machine: {
          artifactSchemaValid: artifact !== null,
          modeUsed: artifact?.mode_used ?? null,
          degradation: artifact?.degradation ?? null,
          failures: artifact?.failures ?? (councilError ? [`council: ${councilError}`] : []),
          councilError,
          sessionEvidence: evidence,
        },
        artifact,
        grade: null,
        gradeError: null,
      })

      if (artifact) {
        // Grader sees the rendered decision with model identities scrubbed.
        const panelRefs = available.map((r) => `${r.providerID}/${r.modelID}`)
        const label = String.fromCharCode(65 + sanitizedForGrader.length) // A, B, C…
        labelByCaseId.set(c.caseId, label)
        sanitizedForGrader.push({ label, question: c.question, decision: scrubModelRefs(renderDecisionForGrader(artifact), panelRefs) })
      }
    }

    // --- Grading: one blinded pass over all decisions, single scale. ---
    console.log(`\n=== Grading ${sanitizedForGrader.length} decision(s) as ${graderModel} ===`)
    if (sanitizedForGrader.length > 0) {
      try {
        const graderSession = await sdk.session.create({ body: { title: "Decision quality review" }, query: { directory: process.cwd() } })
        const gres = await sdk.session.prompt({
          path: { id: graderSession.data!.id },
          body: {
            parts: [{ type: "text", text: graderUserPrompt(sanitizedForGrader) }],
            system: graderSystemPrompt(),
            model: { providerID: graderModel.split("/")[0]!, modelID: graderModel.split("/").slice(1).join("/") },
          },
          query: { directory: process.cwd() },
        })
        if (gres.error) {
          const msg = typeof gres.error === "string" ? gres.error : JSON.stringify(gres.error).slice(0, 500)
          for (const c of cases) c.gradeError = `Grader prompt failed: ${msg}`
          console.error(`Grader prompt failed: ${msg}`)
        } else {
          const gtext = (gres.data?.parts ?? [])
            .filter((p) => (p as { type: string }).type === "text")
            .map((p) => (p as unknown as { text: string }).text)
            .join("\n")
          const parsed = parseGrades(gtext)
          if (!parsed.ok) {
            for (const c of cases) c.gradeError = parsed.error
            console.error(`Grader failed: ${parsed.error}`)
          } else {
            for (const c of cases) {
              if (!c.artifact) continue
              const label = labelByCaseId.get(c.caseId)!
              const g = parsed.grades.find((d) => d.label === label)
              if (!g) {
                c.gradeError = `No grade found for label ${label}`
                continue
              }
              const crit: Record<string, { score: number; note: string }> = {}
              let total = 0
              for (const rc of RUBRIC) {
                const cg = g.criteria[rc.id]
                crit[rc.id] = { score: cg?.score ?? 0, note: cg?.note ?? "" }
                total += cg?.score ?? 0
              }
              c.grade = gradeOf({ total, maxTotal: RUBRIC.length * 2, criteria: crit }, g.note)
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        for (const c of cases) c.gradeError = msg
        console.error(`Grader failed: ${msg}`)
      }
    }

    const finishedAt = new Date().toISOString()
    const report = buildReport({
      startedAt,
      finishedAt,
      commit,
      models: {
        panel: config.panelModels,
        router: config.routerModel ?? "(auto)",
        judge: config.judgeModel,
        grader: graderModel,
      },
      cases,
      comparison: null,
    })

    if (!noCompare && existsSync(baselinePath)) {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline
      report.comparison = compareToBaseline(report, baseline)
    }

    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n")
    console.log(`\nReport written: ${outPath}`)
    console.log(`Artifacts valid: ${report.aggregate.allArtifactsValid} | modes: ${report.aggregate.modesCovered.join(",") || "none"} | mean grade: ${report.aggregate.meanGradeTotal ?? "ungraded"} / ${RUBRIC.length * 2}`)
    if (report.comparison) {
      console.log(`vs baseline ${report.comparison.baselineVersion}: ${report.comparison.aggregate.verdict} (delta ${report.comparison.aggregate.meanGradeDelta ?? "n/a"})`)
      if (report.comparison.models.changed) {
        for (const d of report.comparison.models.deltas) {
          if (d.from !== d.to) console.warn(`Model drift on ${d.role}: ${d.from} → ${d.to} — grade deltas are not directly comparable.`)
        }
      }
    }
    return 0
  } finally {
    // Workspace and server teardown are both guaranteed, even on throw.
    await Promise.allSettled(workspaces.map((w) => rm(w, { recursive: true, force: true })))
    server.close()
  }
}

function pickGraderModel(
  available: { providerID: string; modelID: string }[],
  judgeModel: string,
  panelModels: string[],
): string {
  const env = process.env.COUNCIL_GRADER_MODEL
  if (env) return env
  // Deterministic fallback: first available model whose family is not on the
  // panel or judging this run, so the grader is independent of the graded.
  const used = new Set([...panelModels, judgeModel].map((r) => r.split("/")[1] ?? r))
  const candidate = available.find((m) => !used.has(m.modelID))
  if (!candidate) throw new Error("No model available for the grader that is independent of the panel; set COUNCIL_GRADER_MODEL explicitly.")
  return `${candidate.providerID}/${candidate.modelID}`
}

if (import.meta.main) {
  process.exitCode = await main()
}
