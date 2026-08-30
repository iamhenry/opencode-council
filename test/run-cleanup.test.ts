import { describe, expect, it, vi } from "vitest"
import { readdirSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Failure-cleanup guarantee: when a run throws after a case workspace was
// created (here: parent session create fails mid-case), main() must still
// remove every sanitized temp workspace and close the server.
const state = globalThis as typeof globalThis & { __councilCleanupServers?: { closeCalls: number }[] }

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: async () => {
    const server = { url: "http://127.0.0.1:0", closeCalls: 0, close: function (this: { closeCalls: number }) { this.closeCalls++ } }
    ;(globalThis as typeof globalThis & { __councilCleanupServers?: unknown[] }).__councilCleanupServers ??= []
    ;(globalThis as typeof globalThis & { __councilCleanupServers: unknown[] }).__councilCleanupServers.push(server)
    return server
  },
  createOpencodeClient: () => ({
    config: {
      providers: async () => ({
        data: {
          providers: [
            { id: "prov-a", models: { "model-a": { capabilities: { reasoning: false } } } },
            { id: "prov-b", models: { "model-b": { capabilities: { reasoning: false } } } },
          ],
        },
      }),
    },
    session: {
      create: vi
        .fn()
        // 1st call: grader preflight session — succeeds.
        .mockResolvedValueOnce({ data: { id: "warmup" }, error: null })
        // 2nd call: first case's parent session — throws mid-run.
        .mockRejectedValue(new Error("boom")),
      prompt: async () => ({ data: { parts: [{ type: "text", text: '{"ok":true}' }] }, error: null }),
    },
  }),
}))

import { main } from "../harness/run.js"

describe("failure cleanup", () => {
  it("removes case workspaces and closes the server even when a case throws", async () => {
    const prefix = "streak-tracker-cli-"
    // Pre-clean any leftovers so the assertion only sees this run.
    for (const d of readdirSync(tmpdir())) {
      if (d.startsWith(prefix)) await rm(path.join(tmpdir(), d), { recursive: true, force: true })
    }

    await expect(main()).rejects.toThrow("boom")

    expect(readdirSync(tmpdir()).filter((d) => d.startsWith(prefix))).toEqual([])
    const servers = state.__councilCleanupServers ?? []
    expect(servers).toHaveLength(1)
    expect(servers[0]!.closeCalls).toBe(1)
  })
})
