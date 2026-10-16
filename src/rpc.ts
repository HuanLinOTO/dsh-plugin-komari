/**
 * rpc.ts — host-side connectivity probe for the browser settings card.
 *
 * Wire endpoint (POST, exact Fetch route on the shared \`/api\` channel,
 * Connection client-request / server-response envelopes):
 *   - \`komari.probe\`  payload: {} -> { node_count, online_count } | error
 *
 * Why an exact Fetch route and not a dedicated \`rpc.handle\` channel: in the web
 * profile the webserver is a sibling loader row, never an ancestor of this
 * fiber, so dedicated channels cannot resolve it. Exact routes dispatch inside
 * the already-mounted \`/api\` carrier (the dsh-mineru pattern), inheriting its
 * Host/Origin trust fence and browser authentication.
 *
 * Config read/write does NOT ride this channel: the settings page reads and
 * writes the entry's volatile Config through the Host settings service
 * (\`ctx.configForms\` on the browser side).
 */

import type { Context } from '@deepseek-ai/cordis'
import { API_PATH, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { KomariClient } from './komari.js'

/** Local alias: the carrier-neutral Connection RPC result shape. */
type RpcResult<T> = ConnectionRpcResult<T>

/** Wire shape of the \`komari.probe\` response. */
export interface ProbeResponseWire {
  readonly node_count: number
  readonly online_count: number
}

type ProbeValue = ProbeResponseWire

/** Wire endpoint this route owns; the client calls \`rpc.call('/api', 'komari.probe', {})\`. */
export const PROBE_ENDPOINT = 'komari.probe'

function ok(value: ProbeValue): RpcResult<ProbeValue> {
  return { ok: true, value }
}

function fail(message: string): RpcResult<ProbeValue> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** Connection client-request envelope (mirror of dsh-client-connection's wire contract). */
interface ClientRequestEnvelope {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

function envelopeResponse(rpcId: string, result: RpcResult<unknown>): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export interface KomariRpcDeps {
  readonly getClient: () => KomariClient
}

/**
 * Register the \`komari.probe\` exact Fetch route on the host's connection service.
 * @param ctx - host context (\`connection\` is injected by the entry).
 * @param deps - live client getter (sees the latest accepted config).
 */
export function registerRpc(ctx: Context, deps: KomariRpcDeps): void {
  ctx.logger.info(`dsh-komari: registering ${API_PATH}/${PROBE_ENDPOINT} Fetch route`)
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: `${API_PATH}/${PROBE_ENDPOINT}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') {
          return new Response('not found', { status: 404 })
        }
        const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (mediaType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const envelope = body as Partial<ClientRequestEnvelope> | null
        if (envelope === null || typeof envelope !== 'object'
          || envelope.type !== 'client-request'
          || typeof envelope.rpcId !== 'string' || envelope.rpcId === ''
          || typeof envelope.method !== 'string') {
          return envelopeResponse('invalid-request', fail('invalid client-request message'))
        }
        if (envelope.method !== PROBE_ENDPOINT) {
          return envelopeResponse(envelope.rpcId, fail(
            `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(PROBE_ENDPOINT)}`,
          ))
        }
        try {
          const probe = await deps.getClient().probe(request.signal)
          return envelopeResponse(envelope.rpcId, ok({
            node_count: probe.node_count,
            online_count: probe.online_count,
          }))
        } catch (err) {
          return envelopeResponse(envelope.rpcId, fail(err instanceof Error ? err.message : String(err)))
        }
      },
    }),
    `dsh-komari: ${API_PATH}/${PROBE_ENDPOINT} Fetch route`,
  )
}
