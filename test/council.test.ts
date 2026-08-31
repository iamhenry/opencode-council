import { describe, expect, it, vi } from "vitest"
import { runCouncil } from "../src/council.js"
import type { CouncilToolArgs } from "../src/council.js"
import { resolveCouncilModels, CouncilModelError } from "../src/models.js"
import { DecisionArtifactSchema, parseArtifact, renderArtifact } from "../src/artifact.js"
import { DENIED_TOOLS, createSdkCouncilClient } from "../src/opencode.js"
import { TimeoutError, CancelledError, withTimeout, runPanelist } from "../src/panel.js"
import { parseConfig, parseModelRef } from "../src/config.js"
import type { CouncilClient, AvailableModel, PromptSpec, PromptResult } from "../src/opencode.js"

// ---------------------------------------------------------------------------
// Mock CouncilClient — the only SDK boundary in tests.

type PromptCall = { sessionID: string; system: string; message: string; model: AvailableModel & {}; spec: PromptSpec }

function validArtifactJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommendation: "Use option A",
    confidence: "high",
    consensus: "All panelists agree A is simplest",
    disagreements: [],
    strongest_evidence: ["Panelist: option A has the fewest moving parts"],
    assumptions: ["requirements are stable"],
    risks: ["migration cost"],
    blind_spots: ["ops burden"],
    simplest_viable_option: "Option A",
    change_my_mind_evidence: "Show option B scales past 10k rps",
    next_step: "Prototype A this week",
    ...extra,
  })
}

function isRouterSystem(system: string): boolean {
  return system.includes('{"mode": "lean" | "deep"')
}
function isJudgeSystem(system: string): boolean {
  return system.includes("You are the JUDGE")
}
function isComposerSystem(system: string): boolean {
  return system.includes("You are the COMPOSER")
}

type MockOptions = {
  models?: AvailableModel[]
  routerMode?: "lean" | "deep"
  panelistText?: (role: string, call: PromptCall) => string
  judgeText?: (call: PromptCall) => string
  failSessionTitles?: RegExp
  hangSessionTitles?: RegExp
  /** Hangs; when the session is aborted, rejects late (server teardown race). */
  lateRejectSessionTitles?: RegExp
  delayMs?: number
}

function makeMockClient(opts: MockOptions = {}) {
  const models: AvailableModel[] =
    opts.models ??
    [
      { providerID: "p1", modelID: "alpha", reasoning: false },
      { providerID: "p1", modelID: "beta", reasoning: true },
      { providerID: "p2", modelID: "gamma", reasoning: false },
    ]
  const sessionTitles = new Map<string, string>()
  const promptCalls: PromptCall[] = []
  const abortedSessions: string[] = []
  let sessionCounter = 0
  let hungSessions: string[] = []
  const pendingRejects = new Map<string, (err: Error) => void>()

  const client: CouncilClient = {
    async listModels() {
      return models
    },
    async createChildSession(title, parentID) {
      expect(parentID).toBe("parent-1")
      const id = `s${++sessionCounter}`
      sessionTitles.set(id, title)
      return id
    },
    async prompt(spec) {
      const call: PromptCall = {
        sessionID: spec.sessionID,
        system: spec.system,
        message: spec.message,
        model: spec.model as AvailableModel & {},
        spec,
      }
      promptCalls.push(call)
      const title = sessionTitles.get(spec.sessionID) ?? ""
      if (opts.hangSessionTitles?.test(title)) {
        hungSessions.push(spec.sessionID)
        await new Promise(() => {}) // never resolves; only abort/timeout ends it
      }
      if (opts.lateRejectSessionTitles?.test(title)) {
        hungSessions.push(spec.sessionID)
        // Hangs until abort() tears it down, then rejects asynchronously —
        // mimicking a real SDK request that dies during session teardown
        // after the timeout already resolved the race.
        await new Promise<never>((_, reject) => {
          pendingRejects.set(spec.sessionID, reject)
        })
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (opts.failSessionTitles?.test(title)) {
        throw new Error(`mock failure for session "${title}"`)
      }
      if (isRouterSystem(spec.system)) {
        return {
          sessionID: spec.sessionID,
          text: JSON.stringify({ mode: opts.routerMode ?? "lean", reason: "test reason" }),
        }
      }
      if (isJudgeSystem(spec.system)) {
        const text = opts.judgeText ? opts.judgeText(call) : validArtifactJson()
        return { sessionID: spec.sessionID, text }
      }
      if (isComposerSystem(spec.system)) {
        return { sessionID: spec.sessionID, text: "Prose summary of the decision." }
      }
      // panelist: role is in the session title
      const role = title.includes("Skeptic")
        ? "Skeptic"
        : title.includes("Architect")
          ? "Architect"
          : title.includes("Pragmatist")
            ? "Pragmatist"
            : "Panelist"
      let text = opts.panelistText?.(role, call) ?? `${role} says: my independent take.`
      // Allow panelistText to block (promise) so tests can prove parallelism.
      if (typeof (text as { then?: unknown })?.then === "function") text = await text
      return { sessionID: spec.sessionID, text }
    },
    async abort(sessionID) {
      abortedSessions.push(sessionID)
      const reject = pendingRejects.get(sessionID)
      if (reject) {
        pendingRejects.delete(sessionID)
        setTimeout(() => reject(new Error("ERR_SOCKET: request aborted by session teardown")), 5)
      }
    },
  }
  return {
    client,
    promptCalls,
    abortedSessions,
    hungSessions: () => hungSessions,
    sessionTitle: (id: string) => sessionTitles.get(id) ?? "",
    titles: () => [...sessionTitles.values()],
  }
}

const TEST_MODEL_CONFIG = {
  panelModels: ["p1/alpha", "p1/beta", "p2/gamma"],
  routerModel: "p1/alpha",
  judgeModel: "p1/alpha",
  composerModel: "p1/alpha",
}
const CONFIG = parseConfig({ ...TEST_MODEL_CONFIG, timeoutMs: 2000 })

async function run(mock: ReturnType<typeof makeMockClient>, args: Partial<CouncilToolArgs> = {}) {
  return runCouncil(
    mock.client,
    CONFIG,
    { question: "Which database should we pick?", mode: "lean", ...args },
    "parent-1",
    new AbortController().signal,
  )
}

// ---------------------------------------------------------------------------

describe("config", () => {
  it("uses the production model defaults", () => {
    expect(parseConfig({})).toMatchObject({
      panelModels: ["openai/gpt-5.6-sol", "ollama-cloud/kimi-k3", "xai/grok-4.6"],
      routerModel: "ollama-cloud/glm-5.3-flash",
      judgeModel: "openai/gpt-5.6-sol",
      composerModel: "openai/gpt-5.6-sol",
    })
  })
  it("rejects invalid options with actionable errors", () => {
    expect(() => parseConfig({ timeoutMs: -5 })).toThrow(/timeoutMs/)
  })
  it("parses provider/model refs strictly", () => {
    expect(parseModelRef("anthropic/claude-x")).toEqual({ providerID: "anthropic", modelID: "claude-x" })
    expect(() => parseModelRef("no-slash")).toThrow(/provider\/model/)
    expect(() => parseModelRef("/model")).toThrow(/provider\/model/)
  })
})

describe("model resolution", () => {
  it("fails actionably with no authenticated providers", async () => {
    const mock = makeMockClient({ models: [] })
    await expect(resolveCouncilModels(mock.client, CONFIG, 2)).rejects.toThrow(/auth login/)
  })
  it("requires distinct model IDs for the panel", async () => {
    const mock = makeMockClient({
      models: [
        { providerID: "p1", modelID: "same", reasoning: false },
        { providerID: "p2", modelID: "same", reasoning: false },
      ],
    })
    const config = parseConfig({
      panelModels: ["p1/same", "p2/same"],
      routerModel: "p1/same",
      judgeModel: "p1/same",
    })
    await expect(resolveCouncilModels(mock.client, config, 2)).rejects.toThrow(/distinct model IDs/)
  })
  it("fails actionably when a configured model is unavailable", async () => {
    const mock = makeMockClient()
    await expect(
      resolveCouncilModels(mock.client, { ...CONFIG, panelModels: ["p1/nope", "p1/alpha"] }, 2),
    ).rejects.toThrow(/not available.*Available models/)
  })
  it("requires 3 configured panel models for deep mode", async () => {
    const mock = makeMockClient()
    await expect(
      resolveCouncilModels(mock.client, { ...CONFIG, panelModels: ["p1/alpha", "p1/beta"] }, 3),
    ).rejects.toThrow(/3 distinct panel models/)
  })
  it("explicit config overrides the built-in role models", async () => {
    const mock = makeMockClient()
    const config = parseConfig({
      ...TEST_MODEL_CONFIG,
      routerModel: "p2/gamma",
      judgeModel: "p1/beta",
      composer: true,
      composerModel: "p2/gamma",
    })
    const resolved = await resolveCouncilModels(mock.client, config, 2)
    expect(resolved.router).toMatchObject({ providerID: "p2", modelID: "gamma" })
    expect(resolved.judge).toMatchObject({ providerID: "p1", modelID: "beta" })
    expect(resolved.composer).toMatchObject({ providerID: "p2", modelID: "gamma" })
  })
})

describe("routing", () => {
  it("explicit lean skips the router entirely", async () => {
    const mock = makeMockClient()
    await run(mock, { mode: "lean" })
    expect(mock.promptCalls.filter((c) => isRouterSystem(c.system))).toHaveLength(0)
  })
  it("explicit deep overrides the router", async () => {
    const mock = makeMockClient({ routerMode: "lean" })
    await run(mock, { mode: "deep" })
    expect(mock.promptCalls.filter((c) => isRouterSystem(c.system))).toHaveLength(0)
    expect(mock.titles().filter((t) => t.includes("panelist"))).toHaveLength(3)
  })
  it("auto makes exactly one dedicated router call and routes by its output", async () => {
    const mock = makeMockClient({ routerMode: "deep" })
    await run(mock, { mode: "auto" })
    const routerCalls = mock.promptCalls.filter((c) => isRouterSystem(c.system))
    expect(routerCalls).toHaveLength(1)
    expect(routerCalls[0]!.spec.model).toMatchObject({ providerID: "p1", modelID: "alpha" })
    expect(mock.titles().filter((t) => t.includes("Architect"))).toHaveLength(1)
  })
  it("auto with failed/uncertain router falls back to lean and discloses", async () => {
    const mock = makeMockClient()
    // Router model is p1/alpha; make router calls throw via hang? Simpler: fail router by
    // making its session title fail.
    const mock2 = makeMockClient({ failSessionTitles: /mode router/ })
    const res = await run(mock2, { mode: "auto" })
    expect(res.artifact.mode_used).toBe("lean")
    expect(res.artifact.degradation).toBeUndefined() // router fallback is not panel degradation
    expect(mock2.promptCalls.filter((c) => isRouterSystem(c.system))).toHaveLength(1)
    void mock
  })
})

describe("role counts and parallel independence", () => {
  it("lean runs exactly 2 panelists with equivalent inputs", async () => {
    const mock = makeMockClient()
    await run(mock, { mode: "lean" })
    const panelists = mock.promptCalls.filter((c) => !isRouterSystem(c.system) && !isJudgeSystem(c.system))
    expect(panelists).toHaveLength(2)
    expect(panelists[0]!.message).toBe(panelists[1]!.message)
    expect(new Set(panelists.map((p) => p.model.modelID))).toEqual(new Set(["alpha", "beta"]))
  })
  it("deep runs Architect, Skeptic, Pragmatist with equivalent inputs", async () => {
    const mock = makeMockClient()
    await run(mock, { mode: "deep" })
    const panelists = mock.promptCalls.filter((c) => !isRouterSystem(c.system) && !isJudgeSystem(c.system))
    expect(panelists).toHaveLength(3)
    expect(panelists.map((p) => p.system)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ARCHITECT"),
        expect.stringContaining("SKEPTIC"),
        expect.stringContaining("PRAGMATIST"),
      ]),
    )
    expect(panelists.every((p) => p.message === panelists[0]!.message)).toBe(true)
  })
  it("panelists run in parallel: both prompts issued before either resolves", async () => {
    let issued = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => (release = r))
    const mock = makeMockClient({
      panelistText: () => {
        issued++
        if (issued === 1) return gate.then(() => "first panelist waited for second") // blocks first until second arrives
        release!()
        return "independent take"
      },
    })
    const res = await run(mock, { mode: "lean" })
    expect(issued).toBe(2)
    expect(mock.promptCalls.filter((c) => !isRouterSystem(c.system) && !isJudgeSystem(c.system))).toHaveLength(2)
    void res
  })
  it("panelists cannot see each other: no cross-session visibility in inputs", async () => {
    const mock = makeMockClient()
    await run(mock, { mode: "deep" })
    const panelists = mock.promptCalls.filter((c) => !isRouterSystem(c.system) && !isJudgeSystem(c.system))
    for (const p of panelists) {
      expect(p.message).not.toContain("says:") // no other panelist's response embedded
      expect(p.system).toMatch(/independent/i)
      expect(p.system).toMatch(/have NOT seen/)
    }
  })
})

describe("judge payload and artifact", () => {
  it("judge receives full panelist responses attributed by role", async () => {
    const mock = makeMockClient({
      panelistText: (role) => `UNIQUE-${role}-TAKE`,
      routerMode: "deep",
    })
    const res = await run(mock, { mode: "deep" })
    const judge = mock.promptCalls.find((c) => isJudgeSystem(c.system))!
    expect(judge.message).toContain("UNIQUE-Architect-TAKE")
    expect(judge.message).toContain("UNIQUE-Skeptic-TAKE")
    expect(judge.message).toContain("UNIQUE-Pragmatist-TAKE")
    expect(judge.system).toContain("Panel roles, in order: Architect, Skeptic, Pragmatist")
    expect(judge.system).toMatch(/not take majority votes/i)
    expect(res.artifact.recommendation).toBe("Use option A")
    expect(res.artifact.mode_used).toBe("deep")
  })
  it("judge output passes schema validation; invalid fields are rejected", () => {
    expect(parseArtifact(validArtifactJson()).ok).toBe(true)
    expect(parseArtifact("no json here").ok).toBe(false)
    expect(parseArtifact(JSON.stringify({ recommendation: "x" })).ok).toBe(false)
    const bad = JSON.parse(validArtifactJson())
    delete bad.strongest_evidence
    expect(parseArtifact(JSON.stringify(bad)).ok).toBe(false)
    expect(DecisionArtifactSchema.safeParse(JSON.parse(validArtifactJson())).success).toBe(true)
  })
  it("judge repair retry recovers from one invalid judge output", async () => {
    let judgeCalls = 0
    const mock = makeMockClient({
      judgeText: () => (judgeCalls++ === 0 ? "I will not answer in JSON" : validArtifactJson()),
    })
    const res = await run(mock, { mode: "lean" })
    expect(res.artifact.recommendation).toBe("Use option A")
    const judgeCallsMade = mock.promptCalls.filter((c) => isJudgeSystem(c.system))
    expect(judgeCallsMade).toHaveLength(2)
    expect(judgeCallsMade[1]!.message).toContain("invalid")
  })
  it("judge failing twice throws with the validation error", async () => {
    const mock = makeMockClient({ judgeText: () => "still no json" })
    await expect(run(mock, { mode: "lean" })).rejects.toThrow(/repair attempt/)
  })
  it("artifact renders all required sections", () => {
    const artifact = JSON.parse(validArtifactJson({ mode_used: "lean" }))
    const md = renderArtifact(artifact)
    for (const section of [
      "Recommendation",
      "Confidence",
      "Consensus",
      "Disagreements",
      "Strongest evidence",
      "Assumptions",
      "Risks",
      "Blind spots",
      "Simplest viable option",
      "Change-my-mind evidence",
      "Next step",
    ]) {
      expect(md).toContain(section)
    }
  })
})

describe("session isolation and permissions", () => {
  it("creates clearly titled child sessions under the parent", async () => {
    const leanMock = makeMockClient()
    await run(leanMock, { mode: "lean" })
    const leanTitles = leanMock.titles()
    expect(leanTitles.some((t) => t.startsWith("Council — lean panelist 1 Panelist"))).toBe(true)
    expect(leanTitles.some((t) => t.startsWith("Council — lean panelist 2 Panelist"))).toBe(true)
    expect(leanTitles.some((t) => t.startsWith("Council — judge ("))).toBe(true)
    const deepMock = makeMockClient()
    await run(deepMock, { mode: "deep" })
    const deepTitles = deepMock.titles()
    expect(deepTitles.some((t) => t.startsWith("Council — deep panelist 1 Architect"))).toBe(true)
    expect(deepTitles.some((t) => t.startsWith("Council — deep panelist 2 Skeptic"))).toBe(true)
    expect(deepTitles.some((t) => t.startsWith("Council — deep panelist 3 Pragmatist"))).toBe(true)
    const autoMock = makeMockClient()
    await run(autoMock, { mode: "auto" })
    expect(autoMock.titles()).toContain("Council — mode router")
  })
  it("every prompt denies mutating and agentic tools and allows only read-only tools", async () => {
    const mock = makeMockClient()
    await run(mock, { mode: "deep" })
    expect(mock.promptCalls.length).toBeGreaterThan(0)
    for (const call of mock.promptCalls) {
      const tools = call.spec.tools ?? {}
      expect(tools).toMatchObject(DENIED_TOOLS)
      for (const denied of ["edit", "write", "patch", "bash", "task", "council", "forge", "question"]) {
        expect(tools[denied]).toBe(false)
      }
      expect(call.spec.system).toContain("ask the user questions")
      expect(call.spec.system).toContain("complete the task best-effort")
      for (const allowed of ["read", "grep", "glob"]) {
        expect(tools[allowed]).toBe(true)
      }
    }
  })
  it("sdk adapter maps CouncilClient to real session endpoints with the tools map", async () => {
    const sessionCreate = vi.fn(async () => ({ data: { id: "s-1" }, error: undefined }))
    const sessionPrompt = vi.fn(async () => ({ data: { parts: [{ type: "text", text: "hi" }] }, error: undefined }))
    const sessionAbort = vi.fn(async () => ({ data: {}, error: undefined }))
    const providers = vi.fn(async () => ({
      data: { providers: [{ id: "p1", models: { alpha: { capabilities: { reasoning: true } } } }] },
      error: undefined,
    }))
    // Minimal stand-in for the SDK client shape.
    const sdk = {
      session: { create: sessionCreate, prompt: sessionPrompt, abort: sessionAbort },
      config: { providers },
    } as unknown as Parameters<typeof createSdkCouncilClient>[0]
    const client = createSdkCouncilClient(sdk, "/tmp/dir")
    const sid = await client.createChildSession("Council — judge (p1/alpha)", "parent-9")
    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ body: { parentID: "parent-9", title: "Council — judge (p1/alpha)" } }),
    )
    const out = await client.prompt({
      sessionID: sid,
      system: "sys",
      message: "msg",
      model: { providerID: "p1", modelID: "alpha" },
      variant: "high",
      modelSupportsReasoning: true,
    })
    expect(out.text).toBe("hi")
    const body = sessionPrompt.mock.calls[0]![0].body as Record<string, unknown>
    expect(body.system).toBe("sys")
    expect(body.variant).toBe("high")
    expect(body.tools).toMatchObject({
      edit: false,
      bash: false,
      task: false,
      council: false,
      forge: false,
      question: false,
      read: true,
    })
    await expect(
      client.prompt({
        sessionID: sid,
        system: "sys",
        message: "msg",
        model: { providerID: "p1", modelID: "alpha" },
        modelSupportsReasoning: false,
      }),
    ).resolves.toBeTruthy()
    const body2 = sessionPrompt.mock.calls[1]![0].body as Record<string, unknown>
    expect(body2.variant).toBeUndefined() // variant withheld for non-reasoning models
    await client.abort(sid)
    expect(sessionAbort).toHaveBeenCalled()
  })
})

describe("partial failure and degradation", () => {
  it("one failed panelist yields a degraded result with disclosed failure", async () => {
    const mock = makeMockClient({ failSessionTitles: /Skeptic/ })
    const res = await run(mock, { mode: "deep" })
    expect(res.artifact.degradation).toMatch(/degraded: 1 of 3 panelists failed/)
    expect(res.artifact.failures).toHaveLength(1)
    expect(res.artifact.failures![0]).toContain("Skeptic")
    expect(res.artifact.failures![0]).toContain("mock failure")
  })
  it("judge is told about failed panelists", async () => {
    const mock = makeMockClient({ failSessionTitles: /panelist 1 Panelist \(p1\/alpha\)/ })
    await run(mock, { mode: "lean" })
    const judge = mock.promptCalls.find((c) => isJudgeSystem(c.system))!
    expect(judge.message).toContain("Panelist failures")
    expect(judge.message).toContain("mock failure")
  })
  it("all panelists failing throws with all failures listed", async () => {
    const mock = makeMockClient({ failSessionTitles: /panelist/ })
    await expect(run(mock, { mode: "lean" })).rejects.toThrow(/failed completely.*Panelist.*mock failure/s)
  })
})

describe("cancellation and timeouts", () => {
  it("timeout aborts the hung session and degrades the result", async () => {
    const mock = makeMockClient({ hangSessionTitles: /Skeptic/ })
    const config = parseConfig({ ...TEST_MODEL_CONFIG, timeoutMs: 50 })
    const res = await runCouncil(
      mock.client,
      config,
      { question: "q?", mode: "deep" },
      "parent-1",
      new AbortController().signal,
    )
    expect(res.artifact.degradation).toMatch(/degraded/)
    expect(mock.abortedSessions.length).toBeGreaterThanOrEqual(1)
    expect(mock.promptCalls.some((c) => mock.sessionTitle(c.sessionID).includes("Skeptic"))).toBe(true)
    expect(TimeoutError).toBeDefined()
  })
  it("a hung prompt rejecting after timeout/abort never escapes as unhandledRejection; council still degrades to a terminal artifact", async () => {
    // Regression: live verifier run (opencode serve 1.18.23) crashed the host
    // with an unhandled TimeoutError when an aborted hung prompt rejected
    // during teardown. The losing race path must stay fully observed.
    const rejections: unknown[] = []
    const onUnhandled = (err: unknown) => rejections.push(err)
    process.on("unhandledRejection", onUnhandled)
    try {
      const mock = makeMockClient({ lateRejectSessionTitles: /Skeptic/ })
      const config = parseConfig({ ...TEST_MODEL_CONFIG, timeoutMs: 50 })
      const res = await runCouncil(
        mock.client,
        config,
        { question: "q?", mode: "deep" },
        "parent-1",
        new AbortController().signal,
      )
      // Timeout became an ordinary disclosed panel failure; terminal artifact.
      expect(res.artifact.degradation).toMatch(/degraded: 1 of 3 panelists failed/)
      expect(res.artifact.failures![0]).toContain("Skeptic")
      expect(res.artifact.recommendation).toBeTruthy()
      expect(mock.abortedSessions.length).toBeGreaterThanOrEqual(1)
      // Let the post-abort teardown rejection surface while we watch.
      await new Promise((r) => setTimeout(r, 50))
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
  it("cancellation signal stops the council and aborts in-flight sessions", async () => {
    const mock = makeMockClient({ hangSessionTitles: /panelist|judge/ })
    const ac = new AbortController()
    const promise = runCouncil(
      mock.client,
      CONFIG,
      { question: "q?", mode: "deep" },
      "parent-1",
      ac.signal,
    )
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    await expect(promise).rejects.toThrow(CancelledError)
    expect(mock.abortedSessions.length).toBeGreaterThanOrEqual(1)
  })
  it("a pre-aborted signal rejects promptly with zero sessions and zero model calls", async () => {
    // Regression: live verifier run saw an already-aborted ctx.abort still
    // create two child sessions and run models for 35.8s, because listeners
    // on an already-aborted signal never fire.
    const mock = makeMockClient()
    const ac = new AbortController()
    ac.abort()
    const promise = runCouncil(mock.client, CONFIG, { question: "q?", mode: "auto" }, "parent-1", ac.signal)
    await expect(promise).rejects.toThrow(CancelledError)
    expect(mock.titles()).toEqual([])
    expect(mock.promptCalls).toHaveLength(0)
    expect(mock.abortedSessions).toEqual([])
  })
  it("withTimeout rejects immediately when the signal aborted before the listener is installed", async () => {
    const ac = new AbortController()
    ac.abort()
    const started = Date.now()
    await expect(withTimeout(new Promise((r) => setTimeout(r, 60_000, "x")), 60_000, ac.signal)).rejects.toThrow(
      CancelledError,
    )
    expect(Date.now() - started).toBeLessThan(50)
  })
  it("runPanelist with an already-aborted signal creates no session", async () => {
    const mock = makeMockClient()
    const ac = new AbortController()
    ac.abort()
    await expect(
      runPanelist({
        client: mock.client,
        parentID: "parent-1",
        title: "Council — should not exist",
        system: "s",
        message: "m",
        model: { providerID: "p1", modelID: "alpha" },
        supportsVariant: false,
        timeoutMs: 1000,
        signal: ac.signal,
      }),
    ).rejects.toThrow(CancelledError)
    expect(mock.titles()).toEqual([])
    expect(mock.promptCalls).toHaveLength(0)
  })
})

describe("composer (opt-in)", () => {
  it("is off by default", async () => {
    const mock = makeMockClient()
    const res = await run(mock, { mode: "lean" })
    expect(res.composerOutput).toBeUndefined()
    expect(mock.titles().some((t) => t.includes("composer"))).toBe(false)
  })
  it("opt-in adds prose and its failure is disclosed, not fatal", async () => {
    const config = parseConfig({ ...TEST_MODEL_CONFIG, composer: true })
    const mock = makeMockClient()
    const res = await runCouncil(mock.client, config, { question: "q?", mode: "lean" }, "parent-1", new AbortController().signal)
    expect(res.composerOutput).toBe("Prose summary of the decision.")
    expect(res.output).toContain("Prose summary")
    const mock2 = makeMockClient({ failSessionTitles: /composer/ })
    const res2 = await runCouncil(mock2.client, config, { question: "q?", mode: "lean" }, "parent-1", new AbortController().signal)
    expect(res2.artifact.failures!.some((f) => f.includes("composer"))).toBe(true)
  })
})
