/**
 * index.ts — dsh-komari cordis plugin entry (host half).
 *
 * Bundle-style DSH plugin: one cordis.patch.yml row, no DSH source patches.
 * The browser half ships via \`./client\` (see src/client/index.ts).
 *
 * Architecture:
 *   - Two model-facing tools (komari_list_nodes, komari_exec) registered once
 *     at load; each reads the live config/client through getters, so a settings
 *     edit takes effect on the next call without re-registration.
 *   - Settings ARE the profile-owned Cordis Config: endpoint / username /
 *     password / requestTimeoutMs are \`.volatile()\`, so \`apply\` receives live
 *     references whose \`.get()\` always returns the latest accepted value. Edits
 *     made on the plugin's configure page (Settings -> Plugins) persist per
 *     profile in \`cordis.patch.yml\` under the entry id \`dsh-komari\` and update
 *     those references in place — the entry is never remounted.
 *   - \`settings.configure({ auto: false })\` suppresses the schema-generated form,
 *     because this plugin ships its own \`plugins.row.config\` card.
 *   - One RPC route (\`komari.probe\`) backs the card's "Test connection" button.
 *
 * An empty endpoint is a legal state (first boot, before the user configures
 * the panel): the plugin loads, tools report a clear "not configured" error,
 * and the settings card is where the address gets filled in.
 */

import z from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: pulls the \`ctx.settings\` Context merge (SettingsForms).
import type {} from '@deepseek-ai/dsh-settings'
// Runtime: \`ctx.connection.fetch\` (used by the probe route).
import type {} from '@deepseek-ai/dsh-client-connection'
import { KomariClient, normalizeEndpoint, type KomariConnection } from './komari.js'
import { registerTools, type ResolvedConfig } from './tools.js'
import { registerRpc } from './rpc.js'

export const name = 'dsh-komari'
export const inject = ['toolsets', 'connection']

/** The live Cordis config the Loader passes to \`apply\`. */
export interface EntryConfig {
  /** Live panel address, e.g. \`https://status.example.com\`. */
  endpoint: Volatile<string> | string
  /** Live panel account name. */
  username: Volatile<string> | string
  /** Live panel account password. */
  password: Volatile<string> | string
  /** Live per-request HTTP timeout. */
  requestTimeoutMs: Volatile<number> | number
  /** Live upper bound for one whole file transfer. */
  transferTimeoutMs: Volatile<number> | number
}

/**
 * Schemastery schema for the plugin's profile-owned Config.
 * Every user-editable field is \`.volatile()\`; the defaults below are the
 * composition-layer seed, and a committed settings edit updates the running
 * reference in place.
 */
export const Config = z.object({
  endpoint: z.string()
    .default('')
    .description('Komari panel address, e.g. https://status.example.com (a trailing /api or /api/v1 is ignored).')
    .volatile(),
  username: z.string()
    .default('')
    .description('Komari panel account name. Must have administrator rights (remote execution is admin-only).')
    .volatile(),
  password: z.string()
    .default('')
    .description('Komari panel account password. Stored in the active profile\'s cordis.patch.yml (plain text).')
    .volatile(),
  requestTimeoutMs: z.number()
    .default(15000)
    .description('HTTP timeout for one panel request, in milliseconds.')
    .volatile(),
  transferTimeoutMs: z.number()
    .default(600000)
    .description('Upper bound for one whole file upload/download, in milliseconds.')
    .volatile(),
}) as unknown as z<EntryConfig>

/** Read the current value of a volatile (or plain, in hand-built contexts) field. */
function live<T>(ref: Volatile<T> | T): T {
  if (typeof ref === 'object' && ref !== null && typeof (ref as Volatile<T>).get === 'function') {
    return (ref as Volatile<T>).get() as T
  }
  return ref as T
}

function resolveConfig(entry: EntryConfig): ResolvedConfig {
  return {
    endpoint: normalizeEndpoint(live(entry.endpoint) ?? ''),
    username: (live(entry.username) ?? '').trim(),
    password: live(entry.password) ?? '',
    requestTimeoutMs: live(entry.requestTimeoutMs) ?? 15000,
    transferTimeoutMs: live(entry.transferTimeoutMs) ?? 600000,
  }
}

function toConnection(resolved: ResolvedConfig): KomariConnection {
  return {
    endpoint: resolved.endpoint,
    username: resolved.username,
    password: resolved.password,
    timeoutMs: resolved.requestTimeoutMs,
  }
}

export function apply(ctx: Context, config: EntryConfig = {} as EntryConfig): void {
  let resolved = resolveConfig(config)
  let client = new KomariClient(toConnection(resolved))

  // Re-read the volatile references on every access; a committed settings edit
  // rebuilds the client (fresh endpoint + session) without re-registering tools.
  const getResolved = (): ResolvedConfig => {
    const next = resolveConfig(config)
    if (next.endpoint !== resolved.endpoint
      || next.username !== resolved.username
      || next.password !== resolved.password
      || next.requestTimeoutMs !== resolved.requestTimeoutMs
      || next.transferTimeoutMs !== resolved.transferTimeoutMs) {
      resolved = next
      client = new KomariClient(toConnection(next))
      ctx.logger.info(`dsh-komari: configuration updated (endpoint=${next.endpoint === '' ? '(unset)' : next.endpoint})`)
    }
    return resolved
  }
  const getClient = (): KomariClient => {
    void getResolved()
    return client
  }

  if (resolved.endpoint === '') {
    ctx.logger.warn('dsh-komari: panel address is not configured yet — set it on the plugin configure page (Settings -> Plugins -> dsh-komari).')
  }

  // 1. Model-facing tools, contributed as one lazily-loaded toolset
  //    (get_tools("komari") loads them; the getters keep them on live config).
  registerTools(ctx, getClient, getResolved)

  // 2. Settings presentation policy: this plugin ships its own configuration
  //    card on the Plugins page, so suppress the schema-generated page.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      try {
        return sctx.settings.configure({ auto: false }, ctx.fiber)
      } catch (err) {
        // A second composition of this entry re-configures the same plugin
        // instance; the first policy already won, which is what we want.
        ctx.logger.debug(`dsh-komari: settings policy already configured (${err instanceof Error ? err.message : String(err)})`)
        return () => {}
      }
    })
  })

  // 3. Connectivity probe for the settings card's "Test connection" button.
  registerRpc(ctx, { getClient })
}
