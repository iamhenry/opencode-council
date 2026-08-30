import type { CouncilConfig } from "./config.js"
import { parseModelRef } from "./config.js"
import type { AvailableModel, CouncilClient, ModelRef } from "./opencode.js"

export type ResolvedModel = ModelRef & { supportsVariant: boolean }

export class CouncilModelError extends Error {}

/**
 * Resolves configured model refs against authenticated providers and picks
 * panel models when not configured. Panel roles REQUIRE distinct model IDs —
 * identical models would simulate diversity without producing it.
 */
export async function resolveCouncilModels(
  client: CouncilClient,
  config: CouncilConfig,
  roleCount: number,
): Promise<{ panel: ResolvedModel[]; router: ResolvedModel; judge: ResolvedModel; composer?: ResolvedModel }> {
  const available = await client.listModels()
  if (available.length === 0) {
    throw new CouncilModelError(
      "No authenticated providers found. Run `opencode auth login` or configure providers, then retry. Council needs at least " +
        roleCount +
        " distinct models.",
    )
  }

  const byKey = new Map<string, AvailableModel>(available.map((m) => [`${m.providerID}/${m.modelID}`, m]))
  const resolve = (ref: string, role: string): ResolvedModel => {
    const parsed = parseModelRef(ref)
    const found = byKey.get(`${parsed.providerID}/${parsed.modelID}`)
    if (!found) {
      const sample = available.slice(0, 25).map((m) => `${m.providerID}/${m.modelID}`).join(", ")
      throw new CouncilModelError(
        `Council ${role} model "${ref}" is not available from authenticated providers. Available models include: ${sample}`,
      )
    }
    return { providerID: found.providerID, modelID: found.modelID, supportsVariant: found.reasoning }
  }

  // Panel models: configured refs must be distinct; otherwise auto-pick the
  // first `roleCount` models with distinct model IDs across providers.
  let panel: ResolvedModel[]
  if (config.panelModels) {
    const keys = new Set(config.panelModels.map((r) => parseModelRef(r).modelID))
    if (keys.size !== config.panelModels.length) {
      throw new CouncilModelError(
        `Panel models must have distinct model IDs; got duplicates in [${config.panelModels.join(", ")}].`,
      )
    }
    if (config.panelModels.length < roleCount) {
      throw new CouncilModelError(
        `${roleCount} distinct panel models are required for this mode, but only ${config.panelModels.length} are configured in council.panelModels: [${config.panelModels.join(", ")}].`,
      )
    }
    panel = config.panelModels.map((r, i) => resolve(r, `panelist ${i + 1}`))
  } else {
    const picked: ResolvedModel[] = []
    const seenModels = new Set<string>()
    for (const m of available) {
      if (seenModels.has(m.modelID)) continue
      seenModels.add(m.modelID)
      const r = resolve(`${m.providerID}/${m.modelID}`, "panelist")
      picked.push(r)
      if (picked.length === roleCount) break
    }
    if (picked.length < roleCount) {
      const have = available.map((m) => `${m.providerID}/${m.modelID}`).join(", ")
      throw new CouncilModelError(
        `Council needs ${roleCount} DISTINCT models for its panel but only ${picked.length} distinct model(s) are available from authenticated providers. Available: ${have}. Configure distinct models via council.panelModels.`,
      )
    }
    panel = picked
  }

  const fallback = config.routerModel ?? config.smallModel ?? panel[0]!.providerID + "/" + panel[0]!.modelID
  const judgeRef = config.judgeModel ?? panel[0]!.providerID + "/" + panel[0]!.modelID
  const result = {
    panel,
    router: resolve(fallback, "router"),
    judge: resolve(judgeRef, "judge"),
    composer: config.composer
      ? resolve(config.composerModel ?? fallback, "composer")
      : undefined,
  }
  return result
}
