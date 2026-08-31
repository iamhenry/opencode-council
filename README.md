# opencode-council

An [OpenCode](https://opencode.ai) V1 plugin that convenes a **multi-model council** for consequential decisions.

The `council` tool spawns fresh, read-only child sessions — panelists that deliberate **in parallel and independently**, then a **judge** that weighs evidence (never a majority vote) and returns a validated, structured decision artifact.

## How it works

```
question ──▶ [auto? router: lean|deep] ──▶ panelists (parallel, independent) ──▶ judge ──▶ decision artifact
```

- **lean** — 2 independent generalist panelists + judge. Fast.
- **deep** — Architect, Skeptic, Pragmatist (parallel, mutually blind) + judge. Thorough.
- **auto** (default) — exactly one dedicated structured router call classifies the question; when uncertain (or the router fails), it routes **lean**.
- The judge selects and weighs **evidence**, attributes it by role, and discloses disagreements, risks, blind spots, and the simplest viable option.
- If any panelist fails, the council **continues with the survivors** and marks the result `degraded`, disclosing every failure. If all panelists fail, the tool errors with the failure details.
- Composer (config opt-in) adds a short plain-language prose answer on top.

## The decision artifact

Every run returns a validated object containing: `recommendation`, `confidence`, `consensus`, `disagreements`, `strongest_evidence` (attributed by role), `assumptions`, `risks`, `blind_spots`, `simplest_viable_option`, `change_my_mind_evidence`, `next_step`, plus `mode_used`, `degradation`, and disclosed `failures`. The judge gets one automatic repair retry if its JSON fails schema validation.

## Safety

- All internal sessions **deny** `edit`, `write`, `patch`, `bash`, and `task` — the council never mutates your repo. Only read-only inspection tools (`read`, `grep`, `glob`, `list`, `webfetch`) are enabled.
- Child sessions are clearly titled (`Council — deep panelist 2 Skeptic (provider/model)`) for audit.
- Cancellation and per-stage timeouts propagate: timed-out or cancelled panelists are **aborted**, disclosed as failures, and never block the run.

## Install

This plugin is **source-first**: the package entrypoints point at TypeScript source (`src/index.ts`), which the OpenCode runtime (Bun) imports directly. No `dist` build is required.

### From GitHub

Verified against the OpenCode **1.18.23** loader source (`packages/opencode/src/plugin/shared.ts` + `loader.ts`, `packages/core/src/npm.ts`): non-path plugin specs are parsed with `npm-package-arg` and installed with `@npmcli/arborist`, so every npm/git specifier npm accepts works. All of these resolve to this repo:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "github:iamhenry/opencode-council",
    // or pin a ref/tag:
    "github:iamhenry/opencode-council#v0.1.1",
    // or the npm shorthand / explicit git URL:
    "iamhenry/opencode-council",
    "git+https://github.com/iamhenry/opencode-council.git"
  ]
}
```

With per-plugin options:

```jsonc
{
  "plugin": [
    ["github:iamhenry/opencode-council", { "panelModels": ["openai/gpt-5.6-sol", "ollama-cloud/kimi-k3"], "mode": "deep" }]
  ]
}
```

The loader resolves the entrypoint from `exports["./server"]` first, then `main` — both point at `src/index.ts` here.

### From npm (once published)

```sh
# "plugin": ["opencode-council"] in opencode.json, or:
bun add opencode-council   # or npm i opencode-council
```

Requires at least **2 distinct models** available from your authenticated providers (`opencode auth login`). Panel roles require *distinct* model IDs — the council fails actionably if fewer are available.

## Configure

In `opencode.json` (spec shown as the GitHub form; npm name works identically once published):

```json
{
  "plugin": [
    ["github:iamhenry/opencode-council", {
      "panelModels": ["openai/gpt-5.6-sol", "ollama-cloud/kimi-k3", "xai/grok-4.6"],
      "routerModel": "ollama-cloud/glm-5.3-flash",
      "judgeModel": "openai/gpt-5.6-sol",
      "composerModel": "openai/gpt-5.6-sol",
      "variant": "high",
      "composer": false,
      "timeoutMs": 180000
    }]
  ]
}
```

All options are optional:

| Option | Default | Meaning |
|---|---|---|
| `panelModels` | Sol 5.6, Kimi K3, Grok 4.6 | Lean uses the first 2; deep uses all 3. Must be distinct model IDs. |
| `routerModel` | GLM 5.3 Flash | Router (auto mode) model. `smallModel` remains an optional custom fallback. |
| `judgeModel` | Sol 5.6 | Judge may overlap panel models. |
| `variant` | none | Reasoning variant (e.g. `"high"`) — sent **only** to models reporting reasoning support. |
| `composer` | `false` | Opt-in prose composer. |
| `composerModel` | Sol 5.6 | Composer model when enabled. |
| `timeoutMs` | `180000` | Per-stage timeout (router capped at 60s). |

Precedence is built-in defaults → plugin config → per-call tool overrides. Pass `panel_models` to the tool for a one-off panel.

## Use

Ask your agent to call the `council` tool:

- "Use the council tool in deep mode: should we migrate from Postgres to SQLite for the edge deploy? Context: <…>"
- "Run council (auto) on which caching layer to adopt."

## Quality baseline (blind harness)

A small repo-local harness reruns **2–3 organic council cases** against a real OpenCode server and live models, machine-checks every decision artifact against real session transcripts, grades the decisions with a **blinded grader** (anonymous labels, hidden rubric, model identities scrubbed), and emits a JSON report you can diff against a checked-in baseline.

```sh
bun run council:eval                       # writes harness/last-run.json (gitignored), compares vs harness/baseline.json when present
bun run council:eval -- --out /tmp/r.json  # custom output path (normal runs can never overwrite the baseline file)
```

To refresh the baseline, verify a run looks right first, then opt in explicitly:

```sh
bun run council:eval -- --accept-baseline --out harness/baseline.json
```

Without `--accept-baseline`, writing to the baseline path is refused with exit code 2.

Report shape: `council` (version/commit/models), `run` (timestamps), `cases` (per-case machine checks + session evidence + grade), `aggregate`, and `comparison` vs the baseline (same/better/worse verdicts — single-run deltas are directional, not significant). The comparison also reports model drift (`comparison.models`): when panel/router/judge/grader identities differ from the baseline (or the baseline records none), it warns that grade deltas are not directly comparable.

Configuration (optional): `COUNCIL_PANEL_MODELS="provider/a,provider/b,provider/c"`, `COUNCIL_GRADER_MODEL="provider/g"`, `COUNCIL_TIMEOUT_MS`. Costs: a full run makes ~8–11 model calls (router + panelists + judge per case, one grader pass).

Blinding is enforced in code: candidate-visible prompts and workspace names are checked against a forbidden-words list before any session spawns, and harness tests keep it that way. See `harness/`.

## Capability duel (champion–challenger)

Beyond the regression gate, a KISS capability harness measures whether a config change actually makes the council **better on hard development calls** — 5 capability cases (each run twice), a frozen **champion** file, and blinded A/B duels per criterion:

1. **Freeze** a champion once: every case × 2 runs with the current config, artifacts sanitized (paths/sessions/uuids stripped) and written to `harness/champion.json`.
2. **Duel**: a challenger config runs the same cases × 2; a grader sees each pair under **anonymous A/B labels** (champion position seeded-random per case run, model refs scrubbed) and picks a winner per criterion (`correctness`, `evidence`, `hidden_risks`, `simplicity`, `actionability`). Unknowns are recorded, never fabricated into wins.
3. **Promote** only if *all* hold: every regression case passes its machine gates, challenger wins > losses across the four development duels, and the procedural **holdout** case (embedded trap, excluded from tuning summaries) does not regress.

```sh
bun run council:freeze                   # freeze current config as champion (harness/champion.json)
bun run council:capability               # duel vs frozen champion, report → harness/last-capability.json
bun run council:promote                  # duel + regression gates; exit 1 if promotion blocked
```

`--freeze-champion`/`--cases` flags map straight through to `bun harness/run.ts`. The champion file records the freezing council version, commit, and models; panel/judge drift vs the frozen champion is warned at duel time. All stored artifacts are sanitized; challenger model config stays in the report's `council` block.

## Development

```sh
bun install
bun test          # tests, SDK boundary mocked
bun run typecheck
bun run build     # optional — emits dist/ (gitignored, not needed at runtime)
```

The runtime entrypoints are `src/index.ts`; `dist/` is a generated artifact for typecheck/pack hygiene only. `npm pack` includes `src/` (see the `files` field), so even the tarball is source-first.

## V1 runtime notes

- Built and tested against OpenCode **1.18.x** (V1). No V2 beta APIs.
- Install spec verified from the 1.18.23 source: config specs that are not local paths go through `npm-package-arg` + `@npmcli/arborist` (`Npm.add`), then the loader imports the entrypoint with Bun's native TS support. `exports["./server"]` wins over `main` for server-kind plugins.
- The generated SDK types lag the runtime: `session.prompt` `variant` is sent via a narrow cast, only to reasoning-capable models. `format` is not used — structured output is enforced by prompt + zod validation + one judge repair retry.
- Model discovery uses `config.providers()`, which returns only configured/authenticated providers.
