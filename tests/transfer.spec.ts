import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KomariClient } from '../src/komari.js'
import { defaultDownloadPath, downloadToLocalFile, uploadLocalFile } from '../src/transfer.js'

interface Reply {
  status?: number
  body?: unknown
  raw?: BodyInit
  headers?: Record<string, string>
}

type Handler = (url: string, init: RequestInit) => Reply

const urls: string[] = []
let handler: Handler = () => ({ body: {} })

function installFetch(): void {
  urls.length = 0
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    const reply = handler(url, init ?? {})
    const headers = { 'content-type': 'application/json', ...(reply.headers ?? {}) }
    if (reply.raw !== undefined) {
      return new Response(reply.raw, { status: reply.status ?? 200, headers })
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers,
    })
  }) as typeof fetch
}

const LOGIN = { status: 'success', message: '', data: { 'set-cookie': { session_token: 'sess-1' } } }

function makeClient(): KomariClient {
  return new KomariClient({
    endpoint: 'https://panel.example.com',
    username: 'admin',
    password: 'secret',
    timeoutMs: 5000,
  })
}

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'komari-transfer-'))
  installFetch()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('uploadLocalFile', () => {
  it('slices the file by the session chunk size, then merges', async () => {
    const local = join(dir, 'payload.bin')
    await writeFile(local, 'abcdefghij')
    const chunks: string[] = []
    let merged = false
    handler = (url, init) => {
      if (url.endsWith('/api/login')) return { body: LOGIN }
      if (url.includes('operation=init')) {
        const body = JSON.parse(String(init.body)) as { path: string; size: number }
        expect(body).toEqual({ path: '/root/payload.bin', size: 10 })
        return { body: { status: 'success', data: { upload_id: 'up-1', chunk_size: 4, chunk_count: 3 } } }
      }
      if (url.includes('operation=chunk')) {
        const index = Number(/chunk_index=(\d+)/.exec(url)?.[1])
        expect(index).toBe(chunks.length)
        expect(init.headers).toMatchObject({ 'content-type': 'application/octet-stream' })
        // The panel requires Content-Length to equal the chunk's exact expected size.
        expect((init.body as Uint8Array).byteLength).toBe(index === 2 ? 2 : 4)
        chunks.push(new TextDecoder().decode(init.body as Uint8Array))
        return { body: { status: 'success', data: { received: true } } }
      }
      if (url.includes('operation=merge')) {
        const body = JSON.parse(String(init.body)) as { upload_id: string }
        expect(body.upload_id).toBe('up-1')
        merged = true
        return { body: { status: 'success', data: { complete: true } } }
      }
      throw new Error('unexpected ' + url)
    }

    const outcome = await uploadLocalFile(makeClient(), 'u-1', local, '/root/payload.bin')
    expect(outcome).toEqual({ bytes: 10, chunks: 3 })
    expect(chunks).toEqual(['abcd', 'efgh', 'ij'])
    expect(merged).toBe(true)
    expect(urls.some(u => u.includes('operation=cancel'))).toBe(false)
  })

  it('creates an empty file in one call when the size is zero', async () => {
    const local = join(dir, 'empty.txt')
    await writeFile(local, '')
    let chunkCalls = 0
    handler = (url) => {
      if (url.endsWith('/api/login')) return { body: LOGIN }
      if (url.includes('operation=init')) return { body: { status: 'success', data: { complete: true } } }
      chunkCalls += 1
      return { body: { status: 'success', data: {} } }
    }
    const outcome = await uploadLocalFile(makeClient(), 'u-1', local, '/root/empty.txt')
    expect(outcome).toEqual({ bytes: 0, chunks: 0 })
    expect(chunkCalls).toBe(0)
  })

  it('cancels the session and surfaces the failure when a chunk is rejected', async () => {
    const local = join(dir, 'payload.bin')
    await writeFile(local, 'abcdefghij')
    handler = (url) => {
      if (url.endsWith('/api/login')) return { body: LOGIN }
      if (url.includes('operation=init')) {
        return { body: { status: 'success', data: { upload_id: 'up-2', chunk_size: 4, chunk_count: 3 } } }
      }
      if (url.includes('operation=chunk')) {
        return { status: 400, body: { status: 'error', message: 'chunk 1 has size 4, want 8' } }
      }
      if (url.includes('operation=cancel')) {
        return { body: { status: 'success', data: { cancelled: true } } }
      }
      return { body: { status: 'success', data: {} } }
    }
    await expect(uploadLocalFile(makeClient(), 'u-1', local, '/root/payload.bin'))
      .rejects.toThrow(/chunk 1 has size 4, want 8/)
    expect(urls.some(u => u.includes('operation=cancel'))).toBe(true)
    expect(urls.some(u => u.includes('operation=merge'))).toBe(false)
  })

  it('rejects a missing local file before touching the panel', async () => {
    handler = (url) => (url.endsWith('/api/login') ? { body: LOGIN } : { body: { status: 'success', data: {} } })
    await expect(uploadLocalFile(makeClient(), 'u-1', join(dir, 'nope.bin'), '/root/x'))
      .rejects.toThrow(/cannot read local file/)
    expect(urls.some(u => u.includes('file/upload'))).toBe(false)
  })
})

describe('downloadToLocalFile', () => {
  it('streams the response body to disk and reports the metadata', async () => {
    handler = (url) => {
      if (url.endsWith('/api/login')) return { body: LOGIN }
      expect(url).toContain('/api/admin/client/u-1/file/download?path=%2Fvar%2Flog%2Fsyslog')
      return {
        raw: 'line one\nline two\n',
        headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="syslog.txt"' },
      }
    }
    const dest = join(dir, 'nested', 'syslog.txt')
    const outcome = await downloadToLocalFile(makeClient(), 'u-1', '/var/log/syslog', dest)
    expect(outcome.bytes).toBe(18)
    expect(outcome.content_type).toBe('text/plain; charset=utf-8')
    expect(outcome.filename).toBe('syslog.txt')
    expect(await readFile(dest, 'utf8')).toBe('line one\nline two\n')
  })

  it('surfaces the panel error body instead of writing a file', async () => {
    handler = (url) => {
      if (url.endsWith('/api/login')) return { body: LOGIN }
      return { status: 404, body: { status: 'error', message: 'no such file' } }
    }
    const dest = join(dir, 'missing.txt')
    await expect(downloadToLocalFile(makeClient(), 'u-1', '/nope', dest)).rejects.toThrow(/no such file/)
    await expect(readFile(dest, 'utf8')).rejects.toThrow()
  })

  it('writes an empty file when the body is empty', async () => {
    handler = (url) => (url.endsWith('/api/login') ? { body: LOGIN } : { raw: '', headers: { 'content-type': 'application/octet-stream' } })
    const dest = join(dir, 'empty.bin')
    const outcome = await downloadToLocalFile(makeClient(), 'u-1', '/root/empty.bin', dest)
    expect(outcome.bytes).toBe(0)
    expect((await readFile(dest)).byteLength).toBe(0)
  })
})

describe('defaultDownloadPath', () => {
  it('keeps the remote basename under the temp directory', () => {
    const p = defaultDownloadPath('/var/log/syslog')
    expect(p.startsWith(tmpdir())).toBe(true)
    expect(p.endsWith('syslog')).toBe(true)
    expect(defaultDownloadPath('C:\\Temp\\app.zip').endsWith('app.zip')).toBe(true)
  })
})
