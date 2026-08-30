/**
 * Organic council cases. Prompts must read like ordinary user requests —
 * state the goal, never the meta. Everything here is candidate-visible, so
 * `assertBlind` is applied to every string (enforced at startup and in tests).
 */

export type HarnessCase = {
  /** Report-side identifier. Never shown to a council run. */
  caseId: string
  /** Project-shaped workspace directory name — the only path label a run sees. */
  slug: string
  /** lean/deep are requested explicitly; auto exercises the router. */
  mode: "lean" | "deep" | "auto"
  question: string
  context?: string
  /** Files seeded into the sanitized workspace so it looks like a real project. */
  seedFiles: Record<string, string>
}

export const CASES: HarnessCase[] = [
  {
    caseId: "streak-storage",
    slug: "streak-tracker-cli",
    mode: "lean",
    question:
      "I'm building a tiny habit-streak tracker that runs in the terminal. Should streak data live in a plain JSON file or a SQLite database? Expect a few hundred entries per person, one machine, no syncing planned.",
    context: "Solo project, TypeScript, ships as a single npm package.",
    seedFiles: {
      "package.json": JSON.stringify(
        { name: "streak-tracker-cli", version: "0.1.0", bin: { streak: "./dist/cli.js" } },
        null,
        2,
      ),
      "README.md": "# streak-tracker-cli\n\nTrack daily habit streaks from the terminal.\n",
    },
  },
  {
    caseId: "accounts-auth",
    slug: "note-app-accounts",
    mode: "deep",
    question:
      "We're adding user accounts to our note-taking web app. Should we build session auth ourselves with cookies, or adopt an auth library like Better Auth? Team of two, shipping weekly, a few thousand users expected in year one, and we need email plus Google sign-in.",
    context:
      "Stack is Next.js on Vercel with a Postgres database. We can spare at most two weeks for the whole feature.",
    seedFiles: {
      "README.md": "# note-app-accounts\n\nNotes app. Adding accounts this quarter.\n",
    },
  },
  {
    caseId: "package-shape",
    slug: "cli-package-shape",
    mode: "auto",
    question:
      "Our TypeScript package ships both a library and a command-line tool from one repo. Releases have been awkward because the two halves version at different paces. Should we split into two packages in one repo, split into two repos, or keep one package with one version?",
    seedFiles: {
      "package.json": JSON.stringify(
        { name: "cli-package-shape", version: "1.4.2", bin: { shape: "./dist/cli.js" } },
        null,
        2,
      ),
    },
  },
]

/** Blinding self-check over every candidate-visible string. Throws on any hit. */
export function assertCasesBlind(assertBlind: (text: string, label: string) => void): void {
  for (const c of CASES) {
    assertBlind(c.slug, `case ${c.caseId} slug`)
    assertBlind(c.question, `case ${c.caseId} question`)
    if (c.context) assertBlind(c.context, `case ${c.caseId} context`)
    for (const [name, content] of Object.entries(c.seedFiles)) {
      assertBlind(name, `case ${c.caseId} seed file name`)
      assertBlind(content, `case ${c.caseId} seed file ${name}`)
    }
  }
}
