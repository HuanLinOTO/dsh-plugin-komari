/**
 * Test stub for \`@deepseek-ai/dsh-tools\`.
 *
 * \`src/tools.ts\` imports \`defineTool\` from the host package, which is an optional
 * peer that is not installed in this repository. Vite would otherwise refuse to
 * resolve it. The unit tests only inspect the definitions (name, description,
 * parameters, output contract), so an identity wrapper is enough; the real
 * \`defineTool\` (validation and freezing) runs in the host at plugin load.
 *
 * Type checking does NOT use this stub: \`tsc\` resolves the real package through
 * the \`paths\` mapping in tsconfig.json.
 */

/** Identity wrapper mirroring the host export used by this plugin. */
export function defineTool(definition: unknown): unknown {
  return definition
}
