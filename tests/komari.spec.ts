import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KomariAuthError,
  KomariClient,
  KomariError,
  normalizeEndpoint,
  pickLive,
  pickNode,
} from '../src/komari.js'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

type Handler = (url: string, init: RequestInit, callIndex: number) => Reply

const calls: { url: string; init: RequestInit }[] = []
let handler: Handler = () => ({ body: {} })

function installFetch(): void {
  calls.length = 0
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const callIndex = calls.length
    const request = init ?? {}
    calls.push({ url, init: request })
    const reply = handler(url, request, callIndex)
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    })
  }) as typeof fetch
}

const connection = {
  endpoint: 'https://panel.example.com',
  username: 'admin',
  password: 'secret',
  timeoutMs: 5000,
}

function loginOk(session = 'sess-1'): Reply {
  return { body: { status: 'success', message: '', data: { 'set-cookie': { session_token: session } } } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeEndpoint', () => {
  it('reduces the shapes a user may paste to one origin', () => {
    expect(normalizeEndpoint('status.example.com')).toBe('https://status.example.com')
    expect(normalizeEndpoint('https://status.example.com/')).toBe('https://status.example.com')
    expect(normalizeEndpoint('https://status.example.com/api/v1')).toBe('https://status.example.com')
    expect(normalizeEndpoint('http://status.example.com/api')).toBe('http://status.example.com')
    expect(normalizeEndpoint('  https://status.example.com//api/v1//  ')).toBe('https://status.example.com')
    expect(normalizeEndpoint('')).toBe('')
  })
})

describe('pickNode', () => {
  it('drops the agent token and every unknown field', () => {
    const node = pickNode({
      uuid: 'u-1',
      name: 'node-a',
      token: 'AGENT-SECRET',
      tags: 'prod;eu',
      cpu_cores: 4,
      passwd: 'nope',
      somethingNew: { deep: true },
    })
    expect(JSON.stringify(node)).not.toContain('AGENT-SECRET')
    expect(Object.keys(node)).not.toContain('token')
    expect(node.tags).toEqual(['prod', 'eu'])
    expect(node.cpu.cores).toBe(4)
    expect(node.uuid).toBe('u-1')
  })
})

describe('pickLive', () => {
  it('splits total connections into tcp/udp and keeps totals', () => {
    const live = pickLive({ connections: 644, connections_udp: 46, ram: 10, ram_total: 20, online: true })
    expect(live.connections).toEqual({ tcp: 598, udp: 46 })
    expect(live.ram).toEqual({ used: 10, total: 20 })
    expect(live.online).toBe(true)
  })
})

describe('KomariClient', () => {
  it('logs in once and reuses the session cookie', async () => {
    installFetch()
    handler = (url) => (url.endsWith('/api/login') ? loginOk() : { body: [{ uuid: 'u-1', name: 'a', token: 'SECRET' }] })
    const client = new KomariClient(connection)
    const nodes = await client.listNodes()
    await client.listNodes()
    expect(nodes).toHaveLength(1)
    expect(calls.filter(c => c.url.endsWith('/api/login'))).toHaveLength(1)
    expect((calls[1]?.init.headers as Record<string, string>).cookie).toBe('session_token=sess-1')
  })

  it('raises KomariAuthError with a 2FA hint on rejected credentials', async () => {
    installFetch()
    handler = () => ({ status: 401, body: { status: 'error', message: 'Invalid credentials' } })
    const client = new KomariClient(connection)
    await expect(client.login()).rejects.toBeInstanceOf(KomariAuthError)
    await expect(client.login()).rejects.toThrow(/Invalid credentials/)
  })

  it('re-authenticates exactly once after a session reset', async () => {
    installFetch()
    let listCalls = 0
    handler = (url) => {
      if (url.endsWith('/api/login')) return loginOk('sess-' + String(calls.length))
      listCalls += 1
      if (listCalls === 1) return { status: 401, body: { status: 'error', message: 'invalid session' } }
      return { body: [{ uuid: 'u-1', name: 'a' }] }
    }
    const client = new KomariClient(connection)
    const nodes = await client.listNodes()
    expect(nodes).toHaveLength(1)
    expect(calls.filter(c => c.url.endsWith('/api/login'))).toHaveLength(2)
  })

  it('surfaces a permission error when the account is not an admin', async () => {
    installFetch()
    handler = (url) => (url.endsWith('/api/login') ? loginOk() : { status: 401, body: { status: 'error', message: 'Permission denied' } })
    const client = new KomariClient(connection)
    await expect(client.listNodes()).rejects.toThrow(/administrator/)
  })

  it('reads live status through the rpc2 entry', async () => {
    installFetch()
    handler = (url) => {
      if (url.endsWith('/api/login')) return loginOk()
      const body = JSON.parse(String((calls[calls.length - 1]?.init.body) ?? '{}')) as { method?: string }
      expect(body.method).toBe('common:getNodesLatestStatus')
      return { body: { jsonrpc: '2.0', id: 1, result: { 'u-1': { online: true, cpu: 12.5, connections: 10, connections_udp: 4 } } } }
    }
    const client = new KomariClient(connection)
    const live = await client.latestStatus()
    expect(live['u-1']?.cpu).toBe(12.5)
    expect(live['u-1']?.connections.udp).toBe(4)
  })

  it('raises on an rpc2 error envelope', async () => {
    installFetch()
    handler = (url) => (url.endsWith('/api/login')
      ? loginOk()
      : { body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } } })
    const client = new KomariClient(connection)
    await expect(client.latestStatus()).rejects.toThrow(/boom/)
  })

  it('submits exec and reads the task result', async () => {
    installFetch()
    handler = (url) => {
      if (url.endsWith('/api/login')) return loginOk()
      if (url.endsWith('/api/admin/task/exec')) {
        const body = JSON.parse(String(calls[calls.length - 1]?.init.body)) as { command: string; clients: string[] }
        expect(body.command).toBe('uptime')
        expect(body.clients).toEqual(['u-1'])
        return { body: { status: 'success', message: '', data: { task_id: 't-1', clients: ['u-1'], queued_clients: [] } } }
      }
      return {
        body: {
          status: 'success',
          message: '',
          data: { task_id: 't-1', command: 'uptime', clients: ['u-1'], results: [{ client: 'u-1', result: 'up 3 days', exit_code: 0, finished_at: '2026-01-01T00:00:00Z' }] },
        },
      }
    }
    const client = new KomariClient(connection)
    const submitted = await client.exec('uptime', ['u-1'])
    expect(submitted.task_id).toBe('t-1')
    const task = await client.task('t-1')
    expect(task.results[0]?.exit_code).toBe(0)
    expect(task.results[0]?.result).toBe('up 3 days')
  })

  it('rejects with a clear error when the endpoint is unset', async () => {
    installFetch()
    const client = new KomariClient({ ...connection, endpoint: '' })
    await expect(client.listNodes()).rejects.toBeInstanceOf(KomariAuthError)
  })

  it('wraps transport failures in KomariError', async () => {
    calls.length = 0
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    const client = new KomariClient(connection)
    await expect(client.login()).rejects.toBeInstanceOf(KomariError)
  })
})
