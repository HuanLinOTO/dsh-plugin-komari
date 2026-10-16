/**
 * summary.ts — pure projection / formatting helpers for the Komari tools.
 *
 * Deliberately free of @deepseek-ai/* imports so the unit tests can exercise
 * every branch without resolving the host packages.
 */

import type { KomariLive, KomariNode } from './komari.js'

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + units[unit]
}

/** Compact duration, e.g. 8d20h / 3h12m / 45s. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return d + 'd' + h + 'h'
  if (h > 0) return h + 'h' + m + 'm'
  if (m > 0) return m + 'm' + s + 's'
  return s + 's'
}

/** One machine as the model sees it: static record merged with the live report. */
export interface NodeSummary {
  uuid: string
  name: string
  group: string
  region: string
  tags: string[]
  online: boolean
  /** ISO-8601 timestamp of the latest report; empty when none arrived. */
  last_report: string
  uptime_seconds: number
  cpu_percent: number
  load1: number
  ram_used: number
  ram_total: number
  disk_used: number
  disk_total: number
  swap_used: number
  swap_total: number
  net_up_per_sec: number
  net_down_per_sec: number
  net_total_up: number
  net_total_down: number
  tcp_connections: number
  udp_connections: number
  process_count: number
  temperature: number
  os: string
  arch: string
  cpu_model: string
  virtualization: string
  gpu: string
  memo: string
}

/**
 * Merge one machine's static record with its latest live report.
 * Totals fall back to the static record when the live report carries zeros.
 * @param node - whitelisted static record.
 * @param live - whitelisted live record, if the panel reported one.
 */
export function summarizeNode(node: KomariNode, live: KomariLive | undefined): NodeSummary {
  const ramTotal = live !== undefined && live.ram.total > 0 ? live.ram.total : node.mem_total
  const diskTotal = live !== undefined && live.disk.total > 0 ? live.disk.total : node.disk_total
  const swapTotal = live !== undefined && live.swap.total > 0 ? live.swap.total : node.swap_total
  return {
    uuid: node.uuid,
    name: node.name,
    group: node.group,
    region: node.region,
    tags: node.tags,
    online: live?.online ?? false,
    last_report: live?.time ?? '',
    uptime_seconds: live?.uptime ?? 0,
    cpu_percent: live?.cpu ?? 0,
    load1: live?.load.load1 ?? 0,
    ram_used: live?.ram.used ?? 0,
    ram_total: ramTotal,
    disk_used: live?.disk.used ?? 0,
    disk_total: diskTotal,
    swap_used: live?.swap.used ?? 0,
    swap_total: swapTotal,
    net_up_per_sec: live?.network.up ?? 0,
    net_down_per_sec: live?.network.down ?? 0,
    net_total_up: live?.network.total_up ?? 0,
    net_total_down: live?.network.total_down ?? 0,
    tcp_connections: live?.connections.tcp ?? 0,
    udp_connections: live?.connections.udp ?? 0,
    process_count: live?.process ?? 0,
    temperature: live?.temp ?? 0,
    os: node.os,
    arch: node.arch,
    cpu_model: node.cpu.name,
    virtualization: node.virtualization,
    gpu: node.gpu_name === 'None' ? '' : node.gpu_name,
    memo: node.public_remark !== '' ? node.public_remark : node.remark,
  }
}

/** One resolved node reference. */
export interface ResolvedRef {
  ref: string
  uuid: string
  name: string
}

/** Outcome of mapping user-supplied node references onto real machines. */
export interface RefResolution {
  matched: ResolvedRef[]
  unresolved: string[]
  ambiguous: { ref: string; candidates: string[] }[]
}

/**
 * Map node references (uuid, exact name, or unique name substring) onto nodes.
 * Exact uuid wins, then exact name (case-insensitive), then a unique substring
 * of the name/uuid; an ambiguous substring is reported instead of guessed.
 * @param refs - references as supplied by the model.
 * @param nodes - machines to resolve against.
 */
export function resolveNodeRefs(refs: string[], nodes: KomariNode[]): RefResolution {
  const matched: ResolvedRef[] = []
  const unresolved: string[] = []
  const ambiguous: { ref: string; candidates: string[] }[] = []
  const seen = new Set<string>()
  for (const raw of refs) {
    const ref = raw.trim()
    if (ref === '') continue
    const needle = ref.toLowerCase()
    const byUuid = nodes.find(n => n.uuid.toLowerCase() === needle)
    const byName = byUuid ?? nodes.find(n => n.name.trim().toLowerCase() === needle)
    let hit = byName
    if (hit === undefined) {
      const candidates = nodes.filter(n => n.name.toLowerCase().includes(needle) || n.uuid.toLowerCase().includes(needle))
      if (candidates.length === 1) hit = candidates[0]
      else if (candidates.length > 1) {
        ambiguous.push({ ref, candidates: candidates.map(n => n.name + ' (' + n.uuid + ')') })
        continue
      }
    }
    if (hit === undefined) {
      unresolved.push(ref)
      continue
    }
    if (seen.has(hit.uuid)) continue
    seen.add(hit.uuid)
    matched.push({ ref, uuid: hit.uuid, name: hit.name })
  }
  return { matched, unresolved, ambiguous }
}

/** Render the komari_list_nodes value as text. */
export function renderListOutput(value: {
  endpoint: string
  total: number
  online: number
  offline: number
  warning?: string
  nodes: NodeSummary[]
}): string {
  const lines: string[] = [
    'Komari ' + value.endpoint + ' — ' + String(value.total) + ' machine(s): ' + String(value.online) + ' online, ' + String(value.offline) + ' offline',
  ]
  if (value.warning !== undefined) lines.push('Warning: ' + value.warning)
  lines.push('')
  for (const n of value.nodes) {
    const where = [n.group, n.region].filter(Boolean).join(' ')
    const parts = [
      (n.online ? 'ONLINE  ' : 'OFFLINE ') + n.name,
      where === '' ? '' : '[' + where + ']',
      n.online ? 'cpu ' + n.cpu_percent.toFixed(1) + '%' : '',
      n.ram_total > 0 ? 'mem ' + formatBytes(n.ram_used) + '/' + formatBytes(n.ram_total) : '',
      n.disk_total > 0 ? 'disk ' + formatBytes(n.disk_used) + '/' + formatBytes(n.disk_total) : '',
      n.online ? 'load ' + n.load1.toFixed(2) : '',
      n.online ? 'up ' + formatDuration(n.uptime_seconds) : '',
      'up-total ' + formatBytes(n.net_total_up) + '  down-total ' + formatBytes(n.net_total_down),
    ].filter(p => p !== '')
    lines.push('- ' + parts.join('  '))
    lines.push('  uuid: ' + n.uuid + (n.memo === '' ? '' : '  |  ' + n.memo.replace(/\s+/g, ' ').slice(0, 80)))
  }
  return lines.join('\n')
}

/** Render the komari_upload_file value as text. */
export function renderUploadOutput(value: {
  local_path: string
  bytes: number
  status: string
  unresolved?: string[]
  ambiguous?: { ref: string; candidates: string[] }[]
  results: { uuid: string; name: string; ok: boolean; bytes: number; error?: string }[]
}): string {
  const lines: string[] = [
    'Komari upload ' + value.status + ': ' + value.local_path + ' (' + formatBytes(value.bytes) + ')',
  ]
  for (const a of value.ambiguous ?? []) {
    lines.push('ambiguous node reference "' + a.ref + '": ' + a.candidates.join(', '))
  }
  if ((value.unresolved ?? []).length > 0) lines.push('unresolved node reference(s): ' + (value.unresolved ?? []).join(', '))
  lines.push('')
  for (const r of value.results) {
    lines.push(r.ok
      ? 'ok   ' + r.name + ' (' + r.uuid + ')  ' + formatBytes(r.bytes)
      : 'FAIL ' + r.name + ' (' + r.uuid + ')  ' + (r.error ?? 'unknown error'))
  }
  return lines.join('\n').trimEnd()
}

/** Render the komari_download_file value as text. */
export function renderDownloadOutput(value: {
  node: string
  remote_path: string
  local_path: string
  bytes: number
}): string {
  return [
    'Komari download: ' + value.node + ':' + value.remote_path,
    'saved to ' + value.local_path + ' (' + formatBytes(value.bytes) + ')',
  ].join('\n')
}

/** Render the komari_exec value as text. */
export function renderExecOutput(value: {
  task_id: string
  command: string
  status: string
  message?: string
  unresolved?: string[]
  ambiguous?: { ref: string; candidates: string[] }[]
  pending?: string[]
  results: { uuid: string; name: string; exit_code: number; output: string; finished_at: string }[]
}): string {
  const lines: string[] = [
    'Komari exec ' + value.status + ' (task ' + value.task_id + ')',
    'command: ' + value.command,
  ]
  if (value.message !== undefined) lines.push('note: ' + value.message)
  for (const a of value.ambiguous ?? []) {
    lines.push('ambiguous node reference "' + a.ref + '": ' + a.candidates.join(', '))
  }
  if ((value.unresolved ?? []).length > 0) lines.push('unresolved node reference(s): ' + (value.unresolved ?? []).join(', '))
  if ((value.pending ?? []).length > 0) lines.push('still running on: ' + (value.pending ?? []).join(', '))
  lines.push('')
  for (const r of value.results) {
    lines.push('=== ' + r.name + ' (' + r.uuid + ') exit=' + String(r.exit_code) + ' ===')
    lines.push(r.output.trim() === '' ? '(no output)' : r.output.trimEnd())
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
