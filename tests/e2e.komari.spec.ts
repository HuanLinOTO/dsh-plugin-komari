/**
 * Live-panel end-to-end test.
 *
 * Self-skips unless KOMARI_E2E_ENDPOINT / KOMARI_E2E_USERNAME /
 * KOMARI_E2E_PASSWORD are set, so the default \`pnpm test\` run stays green and
 * no credentials are needed. It exercises the same code path the tools use,
 * against a real Komari panel.
 *
 *   $env:KOMARI_E2E_ENDPOINT='https://status.example.com'
 *   $env:KOMARI_E2E_USERNAME='admin'
 *   $env:KOMARI_E2E_PASSWORD='...'
 *   pnpm vitest run tests/e2e.komari.spec.ts
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KomariClient } from '../src/komari.js'
import { resolveNodeRefs, summarizeNode } from '../src/summary.js'
import { downloadToLocalFile, uploadLocalFile } from '../src/transfer.js'

const endpoint = process.env.KOMARI_E2E_ENDPOINT ?? ''
const username = process.env.KOMARI_E2E_USERNAME ?? ''
const password = process.env.KOMARI_E2E_PASSWORD ?? ''
const enabled = endpoint !== '' && username !== '' && password !== ''

describe.skipIf(!enabled)('live Komari panel', () => {
  const client = new KomariClient({ endpoint, username, password, timeoutMs: 20000 })

  it('authenticates and lists machines without leaking agent tokens', async () => {
    const nodes = await client.listNodes()
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes[0]?.uuid).not.toBe('')
    expect(JSON.stringify(nodes)).not.toContain('"token"')
  })

  it('reads live status for the listed machines', async () => {
    const nodes = await client.listNodes()
    const live = await client.latestStatus()
    expect(Object.keys(live).length).toBeGreaterThan(0)
    const summarized = nodes.map(n => summarizeNode(n, live[n.uuid]))
    expect(summarized.some(s => s.online)).toBe(true)
  })

  it('runs a harmless command on one online machine and reads the result', async () => {
    const nodes = await client.listNodes()
    const live = await client.latestStatus()
    const online = nodes.find(n => live[n.uuid]?.online === true)
    expect(online).toBeDefined()
    const resolved = resolveNodeRefs([online?.uuid ?? ''], nodes)
    expect(resolved.matched).toHaveLength(1)

    const submitted = await client.exec('echo dsh-komari-e2e', resolved.matched.map(m => m.uuid))
    expect(submitted.task_id).not.toBe('')

    let task = await client.task(submitted.task_id)
    for (let i = 0; i < 20 && (task.results[0]?.result ?? '') === ''; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      task = await client.task(submitted.task_id)
    }
    expect(JSON.stringify(task.results)).toContain('dsh-komari-e2e')
  }, 40000)

  it('round-trips a file up to and back from an online machine', async () => {
    const nodes = await client.listNodes()
    const live = await client.latestStatus()
    const online = nodes.filter(n => live[n.uuid]?.online === true)

    // Pick the first online machine whose agent serves the file API, and learn
    // its path style by probing the usual temp roots.
    let target: { uuid: string; name: string; dir: string; sep: string } | undefined
    for (const candidate of online) {
      for (const probe of ['/tmp', 'C:\\Windows\\Temp']) {
        try {
          const info = await client.statFile(candidate.uuid, probe)
          if (info.is_dir) {
            target = { uuid: candidate.uuid, name: candidate.name, dir: probe, sep: probe === '/tmp' ? '/' : '\\' }
            break
          }
        } catch {
          // agent does not expose this path (or no file API at all); try the next
        }
      }
      if (target !== undefined) break
    }
    expect(target).toBeDefined()
    if (target === undefined) return

    const dir = await mkdtemp(join(tmpdir(), 'komari-e2e-'))
    const localFile = join(dir, 'source.txt')
    const fetchedFile = join(dir, 'fetched.txt')
    const payload = 'dsh-komari round-trip ' + String(Date.now())
    await writeFile(localFile, payload)
    const remotePath = target.dir + target.sep + 'dsh-komari-e2e.txt'

    try {
      const up = await uploadLocalFile(client, target.uuid, localFile, remotePath)
      expect(up.bytes).toBe(Buffer.byteLength(payload))

      const info = await client.statFile(target.uuid, remotePath)
      expect(info.is_dir).toBe(false)
      expect(info.size).toBe(Buffer.byteLength(payload))

      const down = await downloadToLocalFile(client, target.uuid, remotePath, fetchedFile)
      expect(down.bytes).toBe(Buffer.byteLength(payload))
      expect(await readFile(fetchedFile, 'utf8')).toBe(payload)
    } finally {
      await client.deleteFile(target.uuid, remotePath).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})
