import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkgPath = resolve(fileURLToPath(new URL("../package.json", import.meta.url)))
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

describe("package metadata (source-first GitHub install)", () => {
  it("resolves entrypoints to TypeScript source, not dist", () => {
    expect(pkg.main).toBe("./src/index.ts")
    expect(pkg.types).toBe("./src/index.ts")
    expect(pkg.exports["."].import).toBe("./src/index.ts")
    // OpenCode's server-kind loader prefers exports["./server"], then main.
    expect(pkg.exports["./server"].import).toBe("./src/index.ts")
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
