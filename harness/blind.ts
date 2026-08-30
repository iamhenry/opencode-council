/**
 * Blinding enforcement (eval playbook non-negotiables).
 *
 * Everything a council run can see — case questions, context, workspace
 * directory names, seeded workspace files — must be free of meta cues. This
 * module is the single enforcement point; `run.ts` refuses to start a run and
 * `harness.test.ts` refuses to pass if any case text trips it.
 *
 * The harness-internal grader is exempt: it may know it is grading, but it
 * never sees model identities (see `scrubModelRefs`).
 */

export const FORBIDDEN_WORDS = [
  "eval",
  "test",
  "judge",
  "experiment",
  "rubric",
  "score",
  "compare",
  "benchmark",
  "candidate",
  "arena",
] as const

/** Case-insensitive substring match — stricter than word boundaries on purpose. */
export function findForbidden(text: string): string[] {
  const lower = text.toLowerCase()
  return FORBIDDEN_WORDS.filter((w) => lower.includes(w))
}

export function assertBlind(text: string, label: string): void {
  const hits = findForbidden(text)
  if (hits.length > 0) {
    throw new Error(`Blinding violation in ${label}: contains forbidden word(s) ${hits.join(", ")}`)
  }
}

/**
 * Removes model identities from text before it reaches the grader. Council
 * failure strings embed "provider/model" refs (always parenthesized in
 * artifacts); known refs from the resolved run are scrubbed first, then a
 * generic parenthesized-ref pass catches the rest.
 */
export function scrubModelRefs(text: string, knownRefs: string[] = []): string {
  let out = text
  for (const ref of knownRefs) {
    out = out.replaceAll(ref, "panelist model")
  }
  return out.replace(/\([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\)/gi, "(panelist model)")
}
