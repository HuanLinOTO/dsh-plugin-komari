import { describe, expect, it } from 'vitest'
import type { KomariNode } from '../src/komari.js'
import { formatBytes, formatDuration, renderExecOutput, renderListOutput, resolveNodeRefs, summarizeNode } from '../src/summary.js'

function node(partial: Partial<KomariNode> & { uuid: string; name: string }): KomariNode {
  return {
    region: '',
    group: '',
    tags: [],
    hidden: false,
    weight: 0,
    cpu: { name: '', cores: 0, physical_cores: 0 },
    gpu_name: 'None',
    arch: '',
    os: '',
    kernel_version: '',
    virtualization: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    billing: { price: 0, currency: '', cycle_days: 0, auto_renewal: false, expired_at: null },
    traffic_limit: 0,
    traffic_limit_type: 'max',
    public_remark: '',
    remark: '',
    ipv4: '',
    ipv6: '',
    agent_version: '',
    created_at: null,
    ...partial,
  }
}

const nodes = [
  node({ uuid: 'u-1', name: 'alpha', group: 'prod', mem_total: 100 }),
  node({ uuid: 'u-2', name: 'beta node', group: 'prod' }),
  node({ uuid: 'u-3', name: 'beta node 2', group: 'dev' }),
]

describe('formatters', () => {
  it('formats bytes at readable magnitudes', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2.0KB')
    expect(formatBytes(1024 * 1024 * 1024 * 3)).toBe('3.0GB')
  })

  it('formats durations compactly', () => {
    expect(formatDuration(0)).toBe('-')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h12m')
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe('2d5h')
  })
})

describe('summarizeNode', () => {
  it('falls back to the static total when the live report carries zeros', () => {
    const s = summarizeNode(nodes[0] as KomariNode, {
      time: '2026-01-01T00:00:00Z',
      online: true,
      uptime: 10,
      cpu: 5,
      ram: { used: 40, total: 0 },
      swap: { used: 0, total: 0 },
      disk: { used: 0, total: 0 },
      load: { load1: 1, load5: 0, load15: 0 },
      temp: 0,
      network: { up: 1, down: 2, total_up: 3, total_down: 4 },
      connections: { tcp: 1, udp: 2 },
      process: 3,
      gpu: null,
      ping: {},
    })
    expect(s.ram_total).toBe(100)
    expect(s.ram_used).toBe(40)
    expect(s.online).toBe(true)
  })

  it('reports offline when no live report exists', () => {
    const s = summarizeNode(nodes[1] as KomariNode, undefined)
    expect(s.online).toBe(false)
    expect(s.last_report).toBe('')
    expect(s.gpu).toBe('')
  })

  it('prefers the public remark over the private one', () => {
    expect(summarizeNode(node({ uuid: 'u', name: 'n', public_remark: 'pub', remark: 'priv' }), undefined).memo).toBe('pub')
    expect(summarizeNode(node({ uuid: 'u', name: 'n', remark: 'priv' }), undefined).memo).toBe('priv')
  })
})

describe('resolveNodeRefs', () => {
  it('resolves uuid, exact name and unique substring', () => {
    // 'alpha' resolves to u-1 again and is de-duplicated.
    const r = resolveNodeRefs(['u-1', 'beta node', 'alpha'], nodes)
    expect(r.matched.map(m => m.uuid)).toEqual(['u-1', 'u-2'])
    expect(r.unresolved).toEqual([])
    expect(r.ambiguous).toEqual([])
  })

  it('reports ambiguous substrings instead of guessing', () => {
    const r = resolveNodeRefs(['beta'], nodes)
    expect(r.matched).toEqual([])
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]?.candidates).toHaveLength(2)
  })

  it('reports unknown references and ignores blanks and duplicates', () => {
    const r = resolveNodeRefs(['ghost', '  ', 'u-1', 'alpha'], nodes)
    expect(r.unresolved).toEqual(['ghost'])
    expect(r.matched.map(m => m.uuid)).toEqual(['u-1'])
  })

  it('matches uuids case-insensitively', () => {
    const r = resolveNodeRefs(['U-2'], nodes)
    expect(r.matched[0]?.uuid).toBe('u-2')
  })
})

describe('renderers', () => {
  it('renders a machine list with state and totals', () => {
    const text = renderListOutput({
      endpoint: 'https://panel.example.com',
      total: 1,
      online: 1,
      offline: 0,
      nodes: [summarizeNode(nodes[0] as KomariNode, undefined)],
    })
    expect(text).toContain('https://panel.example.com')
    expect(text).toContain('OFFLINE alpha')
    expect(text).toContain('uuid: u-1')
  })

  it('renders exec results with exit codes and skip reasons', () => {
    const text = renderExecOutput({
      task_id: 't-1',
      command: 'uptime',
      status: 'partial',
      unresolved: ['ghost'],
      ambiguous: [{ ref: 'beta', candidates: ['beta node (u-2)'] }],
      pending: ['u-1'],
      results: [{ uuid: 'u-2', name: 'beta node', exit_code: 0, output: 'up 3 days', finished_at: '' }],
    })
    expect(text).toContain('command: uptime')
    expect(text).toContain('unresolved node reference(s): ghost')
    expect(text).toContain('still running on: u-1')
    expect(text).toContain('exit=0')
    expect(text).toContain('up 3 days')
  })
})
