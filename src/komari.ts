/**
 * komari.ts — Komari panel HTTP client (host half).
 *
 * Talks to a Komari >= 1.4 panel over its own HTTP API (NOT the read-only
 * `/api/v1` plugin namespace, which cannot execute anything):
 *
 *   POST {base}/api/login                  {"username","password"} -> session_token cookie
 *   GET  {base}/api/admin/client/list      -> raw Client[] (admin view, contains the agent token!)
 *   POST {base}/api/rpc2                   {"method":"common:getNodesLatestStatus"} -> live report map
 *   POST {base}/api/admin/task/exec        {"command","clients":[uuid]} -> { task_id, clients, queued_clients }
 *   GET  {base}/api/admin/task/{task_id}   -> { task_id, command, clients, results:[{client,result,exit_code,finished_at}] }
 *
 * Two rules this module enforces:
 *   1. The session cookie never leaves the process; it is re-acquired on 401.
 *   2. The raw panel payload is NEVER handed to the model: every response is
 *      projected through an explicit whitelist (see pickNode/pickLive), because
 *      `GET /api/admin/client/list` carries each node's agent token in clear.
 */

/** Where the panel lives and how to authenticate. */
export interface KomariConnection {
  /** Normalized panel origin, e.g. `https://status.example.com`. No trailing slash. */
  endpoint: string
  username: string
  password: string
  /** Per-request HTTP timeout. */
  timeoutMs: number
}

/** Raised for transport / protocol failures (as opposed to a panel-level error body). */
export class KomariError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KomariError'
  }
}

/** Raised when the panel rejects the credentials or the session. */
export class KomariAuthError extends KomariError {
  constructor(message: string) {
    super(message)
    this.name = 'KomariAuthError'
  }
}

/**
 * Normalize a user-typed panel address.
 * Accepts `status.example.com`, `https://status.example.com/`,
 * `https://status.example.com/api/v1` and reduces all to the origin.
 * @param raw - address as typed on the settings page.
 * @returns the normalized origin, or `''` for blank input.
 */
export function normalizeEndpoint(raw: string): string {
  let s = raw.trim()
  if (s === '') return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/api(\/v1)?$/i, '')
  return s.replace(/\/+$/, '')
}

/** Node static information, whitelisted from the panel's admin client list. */
export interface KomariNode {
  uuid: string
  name: string
  region: string
  group: string
  tags: string[]
  hidden: boolean
  weight: number
  cpu: { name: string; cores: number; physical_cores: number }
  gpu_name: string
  arch: string
  os: string
  kernel_version: string
  virtualization: string
  mem_total: number
  swap_total: number
  disk_total: number
  billing: { price: number; currency: string; cycle_days: number; auto_renewal: boolean; expired_at: string | null }
  traffic_limit: number
  traffic_limit_type: string
  public_remark: string
  remark: string
  ipv4: string
  ipv6: string
  agent_version: string
  created_at: string | null
}

/** Node live status, whitelisted from the panel's latest-report map. */
export interface KomariLive {
  time: string | null
  online: boolean
  uptime: number
  cpu: number
  ram: { used: number; total: number }
  swap: { used: number; total: number }
  disk: { used: number; total: number }
  load: { load1: number; load5: number; load15: number }
  temp: number
  network: { up: number; down: number; total_up: number; total_down: number }
  connections: { tcp: number; udp: number }
  process: number
  gpu: { count: number; usage: number } | null
  ping: Record<string, unknown>
}

/** Accepted command submission. */
export interface KomariExecSubmit {
  task_id: string
  clients: string[]
  queued_clients: string[]
}

/** One node's result for an exec task. */
export interface KomariTaskResult {
  client: string
  result: string
  exit_code: number
  finished_at: string | null
}

/** An exec task with whatever results have landed so far. */
export interface KomariTask {
  task_id: string
  command: string
  clients: string[]
  results: KomariTaskResult[]
}

/** A remote file's metadata (from the agent's `stat` file operation). */
export interface KomariFileStat {
  name: string
  path: string
  size: number
  is_dir: boolean
  mode: string
  modified_at: string | null
}

/** One chunked-upload session bootstrap result. */
export interface KomariUploadSession {
  upload_id: string
  chunk_size: number
  chunk_count: number
  /** True when the target was created directly (zero-byte upload). */
  complete: boolean
}

/** Outcome of a connectivity probe (settings page "Test connection"). */
export interface KomariProbe {
  node_count: number
  online_count: number
  version?: string
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  return (typeof value === 'object' && value !== null) ? value as JsonRecord : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Komari sends `tags` as a `;`-separated string. */
function tagList(value: unknown): string[] {
  return asString(value).split(';').map(t => t.trim()).filter(Boolean)
}

/** Whitelist one admin client entry; drops `token` and every other unknown field. */
export function pickNode(raw: unknown): KomariNode {
  const c = asRecord(raw)
  return {
    uuid: asString(c.uuid),
    name: asString(c.name),
    region: asString(c.region),
    group: asString(c.group),
    tags: tagList(c.tags),
    hidden: c.hidden === true,
    weight: asNumber(c.weight),
    cpu: {
      name: asString(c.cpu_name),
      cores: asNumber(c.cpu_cores),
      physical_cores: asNumber(c.cpu_physical_cores),
    },
    gpu_name: asString(c.gpu_name),
    arch: asString(c.arch),
    os: asString(c.os),
    kernel_version: asString(c.kernel_version),
    virtualization: asString(c.virtualization),
    mem_total: asNumber(c.mem_total),
    swap_total: asNumber(c.swap_total),
    disk_total: asNumber(c.disk_total),
    billing: {
      price: asNumber(c.price),
      currency: asString(c.currency),
      cycle_days: asNumber(c.billing_cycle),
      auto_renewal: c.auto_renewal === true,
      expired_at: typeof c.expired_at === 'string' ? c.expired_at : null,
    },
    traffic_limit: asNumber(c.traffic_limit),
    traffic_limit_type: asString(c.traffic_limit_type, 'max'),
    public_remark: asString(c.public_remark),
    remark: asString(c.remark),
    ipv4: asString(c.ipv4),
    ipv6: asString(c.ipv6),
    agent_version: asString(c.version),
    created_at: typeof c.created_at === 'string' ? c.created_at : null,
  }
}

/** Whitelist one latest-report entry (mirrors the panel's own record projection). */
export function pickLive(raw: unknown): KomariLive {
  const r = asRecord(raw)
  const tcpTotal = asNumber(r.connections)
  const udp = asNumber(r.connections_udp)
  const gpuCount = asNumber(r.gpu_count)
  return {
    time: typeof r.time === 'string' ? r.time : null,
    online: r.online === true,
    uptime: asNumber(r.uptime),
    cpu: asNumber(r.cpu),
    ram: { used: asNumber(r.ram), total: asNumber(r.ram_total) },
    swap: { used: asNumber(r.swap), total: asNumber(r.swap_total) },
    disk: { used: asNumber(r.disk), total: asNumber(r.disk_total) },
    load: { load1: asNumber(r.load), load5: asNumber(r.load5), load15: asNumber(r.load15) },
    temp: asNumber(r.temp),
    network: {
      up: asNumber(r.net_out),
      down: asNumber(r.net_in),
      total_up: asNumber(r.net_total_up),
      total_down: asNumber(r.net_total_down),
    },
    connections: { tcp: Math.max(0, tcpTotal - udp), udp },
    process: asNumber(r.process),
    gpu: gpuCount > 0 ? { count: gpuCount, usage: asNumber(r.gpu_average_usage) } : null,
    ping: asRecord(r.ping),
  }
}

/**
 * Link an optional caller signal with a timeout into one abort signal.
 * @param signal - caller cancellation signal (`exec.signal`), maybe undefined.
 * @param ms - timeout in milliseconds.
 * @returns the linked signal plus a disposer clearing the timer.
 */
export function linkTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${ms}ms`)), ms)
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

interface RawResponse {
  status: number
  body: unknown
  setCookie: string[]
}

/** Pull a human-readable message out of a panel error body. */
function errorMessage(body: unknown, fallback: string): string {
  const b = asRecord(body)
  const direct = asString(b.message)
  if (direct !== '') return direct
  const nested = asString(asRecord(b.error).message)
  if (nested !== '') return nested
  return fallback
}

/**
 * Stateful Komari client bound to one `(endpoint, username, password)` triple.
 *
 * The session cookie is cached and re-acquired lazily: a single 401 triggers
 * exactly one re-login and one retry, so a revoked/expired session self-heals
 * without the tool layer knowing about it.
 */
export class KomariClient {
  private session: string | null = null
  private loginPromise: Promise<string> | null = null

  constructor(private readonly conn: KomariConnection) {}

  /** @returns the normalized panel origin this client talks to. */
  get endpoint(): string {
    return this.conn.endpoint
  }

  /** Drop the cached session (next call re-authenticates). */
  reset(): void {
    this.session = null
    this.loginPromise = null
  }

  /**
   * Authenticate against `POST /api/login` and cache the session cookie.
   * @param signal - caller cancellation signal.
   * @returns the session token.
   */
  async login(signal?: AbortSignal): Promise<string> {
    if (this.session !== null) return this.session
    if (this.loginPromise !== null) return await this.loginPromise
    this.loginPromise = this.doLogin(signal)
    try {
      this.session = await this.loginPromise
      return this.session
    } finally {
      this.loginPromise = null
    }
  }

  private async doLogin(signal?: AbortSignal): Promise<string> {
    const { endpoint, username, password, timeoutMs } = this.conn
    if (endpoint === '') throw new KomariAuthError('Komari panel address is not configured.')
    if (username === '' || password === '') throw new KomariAuthError('Komari username/password are not configured.')
    const link = linkTimeout(signal, timeoutMs)
    let res: Response
    try {
      res = await fetch(`${endpoint}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username, password, '2fa_code': '' }),
        signal: link.signal,
      })
    } catch (err) {
      throw new KomariError(`login request to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      link.dispose()
    }
    const text = await res.text()
    let body: unknown = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    if (!res.ok) {
      const message = errorMessage(body, `HTTP ${res.status}`)
      if (res.status === 401) throw new KomariAuthError(`Komari login rejected: ${message} (check username/password; accounts with 2FA enabled cannot be used here)`)
      if (res.status === 403) throw new KomariAuthError(`Komari panel refuses password login: ${message}`)
      throw new KomariError(`Komari login failed (HTTP ${res.status}): ${message}`)
    }
    const embedded = asString(asRecord(asRecord(asRecord(body).data)['set-cookie']).session_token)
    if (embedded !== '') return embedded
    const fromHeader = res.headers.getSetCookie?.().find(v => v.startsWith('session_token='))
      ?? res.headers.get('set-cookie')
      ?? ''
    const match = /session_token=([^;]+)/.exec(fromHeader)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
    throw new KomariError('Komari login succeeded but returned no session token.')
  }

  /**
   * One authenticated HTTP call returning the raw Response with its body NOT
   * consumed (binary streams need it). The connect-and-headers phase is bounded
   * by the configured request timeout; the caller owns the body phase (see the
   * transfer timeout in tools.ts). Retries once after a session reset on 401/403.
   * @param path - panel path beginning with a slash.
   * @param init - fetch init; headers are merged over the session cookie.
   * @param signal - caller cancellation signal.
   * @returns the raw response, body unread.
   */
  private async rawFetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const { endpoint, timeoutMs } = this.conn
    const attempt = async (session: string): Promise<Response> => {
      const link = linkTimeout(signal, timeoutMs)
      try {
        return await fetch(`${endpoint}${path}`, {
          ...init,
          headers: {
            accept: 'application/json',
            cookie: `session_token=${session}`,
            ...(init.headers ?? {}),
          },
          signal: link.signal,
        })
      } catch (err) {
        throw new KomariError(`request to ${endpoint}${path} failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        link.dispose()
      }
    }
    const first = await attempt(await this.login(signal))
    if (first.status !== 401 && first.status !== 403) return first
    await first.body?.cancel()
    this.reset()
    return await attempt(await this.login(signal))
  }

  /** One authenticated JSON call; retries once after a session reset on 401/403. */
  private async send(path: string, init: RequestInit, signal?: AbortSignal): Promise<RawResponse> {
    const res = await this.rawFetch(path, init, signal)
    const text = await res.text()
    let body: unknown = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body, setCookie: res.headers.getSetCookie?.() ?? [] }
  }

  /** Standard-envelope call: unwraps `data`, raises on `status:"error"` or non-2xx. */
  private async callData(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const res = await this.send(path, init, signal)
    if (res.status === 401 || res.status === 403) {
      throw new KomariAuthError(`Komari rejected the session (HTTP ${res.status}): ${errorMessage(res.body, 'permission denied')}. The account may need admin rights, or the panel may require 2FA for sensitive operations.`)
    }
    if (res.status >= 400) {
      throw new KomariError(`Komari request ${path} failed (HTTP ${res.status}): ${errorMessage(res.body, 'unknown error')}`)
    }
    return asRecord(res.body).data
  }

  /**
   * Call one JSON-RPC method through the panel's `/api/rpc2` entry and unwrap
   * the JSON-RPC envelope (NOT the `{status,data}` REST envelope).
   * @param method - RPC method name, e.g. `admin:fileStat`.
   * @param params - named parameters object.
   * @param signal - caller cancellation signal.
   */
  private async rpcCall(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const res = await this.send('/api/rpc2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }, signal)
    if (res.status === 401 || res.status === 403) {
      throw new KomariAuthError(`Komari refused ${method} (HTTP ${String(res.status)}): ${errorMessage(res.body, 'permission denied')}`)
    }
    if (res.status >= 400) {
      throw new KomariError(`Komari ${method} failed (HTTP ${String(res.status)}): ${errorMessage(res.body, 'unknown error')}`)
    }
    const envelope = asRecord(res.body)
    if (envelope.error !== undefined) {
      throw new KomariError(`Komari ${method} failed: ${errorMessage(envelope, 'unknown error')}`)
    }
    return envelope.result
  }

  /**
   * List every node including hidden ones (admin view), whitelisted.
   * @param signal - caller cancellation signal.
   */
  async listNodes(signal?: AbortSignal): Promise<KomariNode[]> {
    const res = await this.send('/api/admin/client/list', { method: 'GET' }, signal)
    if (res.status === 401 || res.status === 403) {
      throw new KomariAuthError(`Komari refused the node list (HTTP ${res.status}): ${errorMessage(res.body, 'permission denied')}. This account needs panel administrator rights.`)
    }
    if (res.status >= 400) {
      throw new KomariError(`Komari node list failed (HTTP ${res.status}): ${errorMessage(res.body, 'unknown error')}`)
    }
    const raw = Array.isArray(res.body) ? res.body : asRecord(res.body).data
    if (!Array.isArray(raw)) throw new KomariError('Komari node list returned an unexpected payload shape.')
    return raw.map(pickNode)
  }

  /**
   * Fetch the latest live report for every node, keyed by uuid.
   * Uses the `common:getNodesLatestStatus` RPC through the panel's `/api/rpc2` entry
   * (that method has no dedicated REST route).
   * @param signal - caller cancellation signal.
   */
  async latestStatus(signal?: AbortSignal): Promise<Record<string, KomariLive>> {
    const result = asRecord(await this.rpcCall('common:getNodesLatestStatus', {}, signal))
    const out: Record<string, KomariLive> = {}
    for (const [uuid, value] of Object.entries(result)) out[uuid] = pickLive(value)
    return out
  }

  /**
   * Submit a command for remote execution on the given nodes.
   * @param command - shell command run by the agent (root on most Linux nodes).
   * @param uuids - target node uuids.
   * @param signal - caller cancellation signal.
   */
  async exec(command: string, uuids: string[], signal?: AbortSignal): Promise<KomariExecSubmit> {
    const data = asRecord(await this.callData('/api/admin/task/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, clients: uuids }),
    }, signal))
    return {
      task_id: asString(data.task_id),
      clients: Array.isArray(data.clients) ? data.clients.map(v => asString(v)).filter(Boolean) : [],
      queued_clients: Array.isArray(data.queued_clients) ? data.queued_clients.map(v => asString(v)).filter(Boolean) : [],
    }
  }

  /**
   * Read one exec task with the results that have landed so far.
   * @param taskId - task id from {@link exec}.
   * @param signal - caller cancellation signal.
   */
  async task(taskId: string, signal?: AbortSignal): Promise<KomariTask> {
    const data = asRecord(await this.callData(`/api/admin/task/${encodeURIComponent(taskId)}`, { method: 'GET' }, signal))
    const results = Array.isArray(data.results) ? data.results : []
    return {
      task_id: asString(data.task_id, taskId),
      command: asString(data.command),
      clients: Array.isArray(data.clients) ? data.clients.map(v => asString(v)).filter(Boolean) : [],
      results: results.map(raw => {
        const r = asRecord(raw)
        return {
          client: asString(r.client),
          result: asString(r.result),
          exit_code: asNumber(r.exit_code),
          finished_at: typeof r.finished_at === 'string' ? r.finished_at : null,
        }
      }),
    }
  }

  /** Read one remote file's metadata through `admin:fileStat`. */
  async statFile(uuid: string, path: string, signal?: AbortSignal): Promise<KomariFileStat> {
    const info = asRecord(await this.rpcCall('admin:fileStat', { uuid, path }, signal))
    return {
      name: asString(info.name),
      path: asString(info.path, path),
      size: asNumber(info.size),
      is_dir: info.is_dir === true,
      mode: asString(info.mode),
      modified_at: typeof info.modified_at === 'string' ? info.modified_at : null,
    }
  }

  /**
   * Delete one path on a machine through `admin:fileDelete`.
   * @param uuid - target machine uuid.
   * @param path - absolute path to delete.
   * @param signal - caller cancellation signal.
   */
  async deleteFile(uuid: string, path: string, signal?: AbortSignal): Promise<void> {
    await this.rpcCall('admin:fileDelete', { uuid, path }, signal)
  }

  /**
   * Open a chunked upload session (`operation=init`).
   * @param uuid - target machine uuid.
   * @param path - absolute destination path on that machine.
   * @param size - total byte length of the file being uploaded.
   * @param signal - caller cancellation signal.
   */
  async uploadInit(uuid: string, path: string, size: number, signal?: AbortSignal): Promise<KomariUploadSession> {
    const data = asRecord(await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?operation=init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, size }),
    }, signal))
    return {
      upload_id: asString(data.upload_id),
      chunk_size: asNumber(data.chunk_size, 25 * 1024 * 1024),
      chunk_count: asNumber(data.chunk_count),
      complete: data.complete === true,
    }
  }

  /**
   * Send one chunk as a raw body. The panel requires `Content-Length` to equal
   * the chunk's exact expected size, so the byte array is passed whole.
   * @param uuid - target machine uuid.
   * @param uploadId - session id from {@link uploadInit}.
   * @param index - zero-based chunk index.
   * @param bytes - the chunk's bytes (last chunk may be shorter); must be
   *   ArrayBuffer-backed so it is assignable to the fetch body type.
   * @param signal - caller cancellation signal.
   */
  async uploadChunk(uuid: string, uploadId: string, index: number, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
    const query = `operation=chunk&upload_id=${encodeURIComponent(uploadId)}&chunk_index=${String(index)}`
    await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    }, signal)
  }

  /**
   * Commit the uploaded chunks (`operation=merge`).
   * @param uuid - target machine uuid.
   * @param uploadId - session id from {@link uploadInit}.
   * @param signal - caller cancellation signal.
   */
  async uploadMerge(uuid: string, uploadId: string, signal?: AbortSignal): Promise<void> {
    await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?operation=merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upload_id: uploadId }),
    }, signal)
  }

  /**
   * Abandon an upload session and drop the partially written file.
   * @param uuid - target machine uuid.
   * @param uploadId - session id from {@link uploadInit}.
   * @param signal - caller cancellation signal.
   */
  async uploadCancel(uuid: string, uploadId: string, signal?: AbortSignal): Promise<void> {
    await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?operation=cancel&upload_id=${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upload_id: uploadId }),
    }, signal)
  }

  /**
   * Open the raw download stream for one remote file. The caller consumes the
   * body; a non-2xx response carries a JSON error body instead of file bytes.
   * @param uuid - source machine uuid.
   * @param path - absolute source path on that machine.
   * @param signal - caller cancellation signal.
   */
  async downloadStream(uuid: string, path: string, signal?: AbortSignal): Promise<Response> {
    return await this.rawFetch(`/api/admin/client/${encodeURIComponent(uuid)}/file/download?path=${encodeURIComponent(path)}`, {
      method: 'GET',
      headers: { accept: '*/*' },
    }, signal)
  }

  /**
   * Read the panel's JSON error body from a failed transfer response.
   * @param res - the non-2xx response.
   */
  async transferError(res: Response): Promise<string> {
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    return errorMessage(body, text === '' ? `HTTP ${res.status}` : text.slice(0, 200))
  }

  /**
   * Connectivity probe for the settings page: login + one node list + live counts.
   * @param signal - caller cancellation signal.
   */
  async probe(signal?: AbortSignal): Promise<KomariProbe> {
    const nodes = await this.listNodes(signal)
    let online = 0
    try {
      const live = await this.latestStatus(signal)
      online = Object.values(live).filter(l => l.online).length
    } catch {
      // Live status is optional for the probe; the node list already proves auth works.
      online = nodes.filter(() => false).length
    }
    return { node_count: nodes.length, online_count: online }
  }
}
