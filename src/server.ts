import { CouncilPlugin } from "./index.js"

/**
 * V1 PluginModule entrypoint for OpenCode's server-kind loader.
 *
 * OpenCode 1.18.x detects a V1 plugin when the module default-export is an
 * object with `id`/`server`; that bypasses the legacy loader, which would
 * otherwise call *every* runtime export (including `CouncilModelError`) as a
 * plugin. Keep the named exports here minimal — only `CouncilPlugin`.
 */
const serverPlugin = {
  id: "opencode-council",
  server: CouncilPlugin,
}

export default serverPlugin
export { CouncilPlugin }
