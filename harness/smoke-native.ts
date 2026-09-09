// Run: bun harness/smoke-native.ts (two short panel calls and one judge).
import assert from "node:assert/strict"
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk"
import { createSdkCouncilClient } from "../src/opencode.js"
import { runCouncil } from "../src/council.js"
import { parseConfig } from "../src/config.js"

const server = await createOpencodeServer({ port: 49152 + (process.pid % 15000), timeout: 30_000 })
try {
  const sdk = createOpencodeClient({ baseUrl: server.url })
  const client = createSdkCouncilClient(sdk, process.cwd())
  const created = await sdk.session.create({ body: { title: "Council native smoke" } })
  assert.ok(created.data?.id, "native parent session must be created")
  const parent = created.data.id
  const started = Date.now()
  const completed = new Set<string>()
  const children: string[] = []
  const nativeCreate = client.createChildSession
  const nativePrompt = client.prompt
  client.createChildSession = async (title, parentID) => {
    if (title.includes("judge")) assert.equal(completed.size, 2, "judge must follow both native completions")
    const id = await nativeCreate(title, parentID)
    children.push(id)
    console.log(JSON.stringify({ event: "created", title, sessionID: id, ms: Date.now() - started }))
    return id
  }
  client.prompt = async (spec) => {
    const result = await nativePrompt(spec)
    completed.add(spec.sessionID)
    console.log(JSON.stringify({ event: "native-completed", sessionID: spec.sessionID, ms: Date.now() - started }))
    return result
  }
  try {
    const result = await runCouncil(client, parseConfig({
      panelModels: ["ollama-cloud/glm-5.3-flash", "ollama-cloud/kimi-k3"],
      judgeModel: "ollama-cloud/glm-5.3-flash",
      timeoutMs: 1, // Old implementation times out; real native calls exceed this.
    }), {
      mode: "low",
      question: "For an in-memory list of three numbers, use the built-in sort or write a custom sorting algorithm?",
      context: "Smoke test only. No tools or research. Each panelist: one sentence. Judge: shortest valid required JSON artifact.",
    }, parent, new AbortController().signal)
    assert.equal(result.artifact.degradation, undefined)
    assert.ok(Date.now() - started > 1)
    console.log(JSON.stringify({ result: "PASS", parent, children, ms: Date.now() - started }))
  } finally {
    await Promise.allSettled(children.map((id) => client.abort(id)))
  }
} finally {
  server.close()
}
