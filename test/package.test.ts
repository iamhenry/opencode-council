import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkgPath = resolve(fileURLToPath(new URL("../package.json", import.meta.url)))
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

describe("package metadata (source-first GitHub install)", () => {
  it("resolves package-root entrypoints to TypeScript source, not dist", () => {
    expect(pkg.main).toBe("./src/index.ts")
    expect(pkg.types).toBe("./src/index.ts")
    expect(pkg.exports["."].import).toBe("./src/index.ts")
  })

  it("ships source and never dist in the published/installable payload", () => {
    expect(pkg.files).toContain("src")
    expect(pkg.files).not.toContain("dist")
  })

  it("points at the public GitHub repository", () => {
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/iamhenry/opencode-council.git",
    })
    expect(pkg.bugs).toBe("https://github.com/iamhenry/opencode-council/issues")
    expect(pkg.homepage).toBe("https://github.com/iamhenry/opencode-council#readme")
  })
})

describe("loader shape (OpenCode 1.18.x readV1Plugin detect semantics)", () => {
  it("package-root default stays the legacy plugin function", async () => {
    const mod = await import("../src/index.js")
    expect(typeof mod.default).toBe("function")
    expect(mod.default).toBe(mod.CouncilPlugin)
  })

  it("server entry default is a V1 PluginModule detected before legacy iteration", async () => {
    const mod = await import("../src/server.js")
    // Mirrors readV1Plugin(..., "detect"): default must be a record carrying
    // exactly one of server/tui plus an id, so the legacy loader — which calls
    // every runtime export as a plugin — is bypassed.
    expect(mod.default).toBeTypeOf("object")
    expect(mod.default.id).toBe("opencode-council")
    expect(typeof mod.default.server).toBe("function")
    expect("tui" in mod.default).toBe(false)
    expect(mod.default.server).toBe(mod.CouncilPlugin)
  })

  it("server entry exports only the V1 module and CouncilPlugin", async () => {
    const mod = await import("../src/server.js")
    expect(Object.keys(mod).sort()).toEqual(["CouncilPlugin", "default"])
  })

  it("server entrypoint is wired in package exports", () => {
    expect(pkg.exports["./server"].import).toBe("./src/server.ts")
    expect(pkg.exports["."].import).toBe("./src/index.ts")
  })
})
