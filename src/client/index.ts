/**
 * dsh-komari browser half: registers the Komari configuration card into the
 * Plugins page's 'plugins.row.config' slot, keyed '<package>#<row id>'.
 *
 * Transport stays ctx.configForms: this half binds the host entry's shared
 * ConfigForm (via ctx.configForms.get with the cordis.patch.yml row id),
 * stages edits in a controller, and writes through form.set on save. Reads ride
 * the settings describe mirror; writes persist per profile in cordis.patch.yml
 * and update the running host instance in place (no remount).
 *
 * The "Test connection" button probes the panel through one Host RPC endpoint
 * (komari.probe), served as an exact Fetch route on the shared /api channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the Plugins page SlotMap merge (the 'plugins.row.config' key).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SettingsPage, type ConnectionProbe, type KomariSettingsInjected } from './SettingsPage.js'
import { KomariSettingsController, type KomariFormValues } from './settings-form.js'
import { en, NS, zh, type KomariKey } from './locales.js'
import { ENTRY_ID, ROW_KEY } from './row-key.js'
import type { ProbeResponseWire } from '../rpc.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-komari': KomariKey
  }
}

export const inject = ['slots', 'locale', 'connection', 'configForms']

type ProbeRpcResult = RpcResult<ProbeResponseWire>

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-komari: dictionaries')

  const connection = ctx.connection as unknown as ConnectionHandle

  const controller = new KomariSettingsController(
    ctx.configForms.get<KomariFormValues>(ENTRY_ID),
  )

  const probe = async (): Promise<ConnectionProbe> => {
    const result = await connection.rpc.call('/api', 'komari.probe', {}) as ProbeRpcResult
    if (result.ok) {
      return { ok: true, node_count: result.value.node_count, online_count: result.value.online_count }
    }
    return { ok: false, message: result.error.message }
  }

  const settingsInjected = (): KomariSettingsInjected => ({
    hooks: { komariSettings: controller.snapshot },
    edit: (field, value) => controller.edit(field, value),
    save: () => controller.save(),
    probe,
  })

  // Register the row's configure card only while the Host serves this entry's
  // config, so a deployment that disabled the host row leaves no trace here.
  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.row.config', function* () {
      yield ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
        inject: settingsInjected,
      }, SettingsPage)
    })),
    'dsh-komari: plugins row config card',
  )
}
