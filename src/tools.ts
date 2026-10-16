/**
 * tools.ts — model-facing Komari tools.
 *
 *   komari_list_nodes — list every monitored machine with its latest live status
 *   komari_exec       — run a shell command on one or more machines, collect output
 *
 * Conventions (plugin-development-guide.md §3):
 *   C4 — execute returns one canonical JSON value; render is a separate pure projection.
 *   C5 — infrastructure failures throw; "the command failed on the machine" is a normal value.
 *   C6 — exec.signal is honored at every await point.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolsetDefinition } from '@huanlin/dsh-plugin-toolsets'
import { KomariClient, linkTimeout, type KomariLive } from './komari.js'
import {
  renderDownloadOutput,
  renderExecOutput,
  renderListOutput,
  renderUploadOutput,
  resolveNodeRefs,
  summarizeNode,
  type NodeSummary,
} from './summary.js'
import { defaultDownloadPath, downloadToLocalFile, uploadLocalFile } from './transfer.js'

/** Live (volatile) configuration resolved for one tool call. */
export interface ResolvedConfig {
  endpoint: string
  username: string
  password: string
  requestTimeoutMs: number
  /** Upper bound for one whole file transfer (upload or download). */
  transferTimeoutMs: number
}

/** Name of the lazily-loaded toolset this plugin contributes. */
export const TOOLSET_NAME = 'komari'

/** Model-facing "when to use this toolset" statement (English, per toolsets contract). */
export const TOOLSET_DESCRIPTION =
  "Query and operate the user's Komari monitoring panel: list monitored machines with live status, run shell commands "
  + 'on them, and move files between this machine and them. Load it whenever the user mentions Komari, a status panel, '
  + 'or one of their servers/machines by name.'

const DEFAULT_WAIT_SECONDS = 30
const MAX_WAIT_SECONDS = 300
const POLL_INTERVAL_MS = 1000

/** One result row of komari_exec. */
interface ExecResultRow {
  uuid: string
  name: string
  exit_code: number
  output: string
  /** ISO-8601 finish timestamp; empty when the machine had not reported yet. */
  finished_at: string
}

function textRender<T>(fn: (value: T) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as T) }]
}

/** Await one poll interval, honoring cancellation. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Register the Komari tools.
 * Tools read the live client/config through getters, so a settings edit takes
 * effect on the next call without re-registering anything.
 * @param ctx - host context (tools is injected by the entry).
 * @param getClient - live client getter.
 * @param getConfig - live config getter.
 */
export function buildKomariToolset(getClient: () => KomariClient, getConfig: () => ResolvedConfig): ToolsetDefinition {
  const client = (): KomariClient => getClient()
  const tools: ToolDefinition[] = [
    defineTool({
    name: 'komari_list_nodes',
    description:
      'List the machines monitored by the configured Komari panel together with each one\'s latest live status '
      + '(online flag, CPU %, load, memory/disk/swap usage, network totals, uptime, connections, temperature). '
      + 'Every entry carries the uuid and name that komari_exec accepts as a target. '
      + 'Returns endpoint, totals and nodes[].',
    parameters: {
      group: {
        type: 'string',
        description: 'Only return machines whose Komari group equals this value (exact match). Omit for all groups.',
      },
      include_offline: {
        type: 'boolean',
        description: 'Include machines that are currently offline. Default: true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', required: true, description: 'Panel address the data came from.' },
          total: { type: 'integer', required: true, description: 'Number of machines returned.' },
          online: { type: 'integer', required: true, description: 'How many of them are online.' },
          offline: { type: 'integer', required: true, description: 'How many of them are offline.' },
          warning: { type: 'string', description: 'Set when live status could not be fetched (static data only).' },
          nodes: {
            type: 'array',
            required: true,
            description: 'One entry per machine.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                uuid: { type: 'string', required: true, description: 'Machine uuid (pass to komari_exec).' },
                name: { type: 'string', required: true, description: 'Machine display name.' },
                group: { type: 'string', description: 'Komari group.' },
                region: { type: 'string', description: 'Region flag/label.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
                online: { type: 'boolean', required: true, description: 'Whether the agent is currently online.' },
                last_report: { type: 'string', description: 'ISO-8601 timestamp of the latest agent report; empty when none arrived.' },
                uptime_seconds: { type: 'integer', description: 'Machine uptime in seconds.' },
                cpu_percent: { type: 'number', description: 'CPU usage percent.' },
                load1: { type: 'number', description: '1-minute load average.' },
                ram_used: { type: 'integer', description: 'Used memory in bytes.' },
                ram_total: { type: 'integer', description: 'Total memory in bytes.' },
                disk_used: { type: 'integer', description: 'Used disk in bytes.' },
                disk_total: { type: 'integer', description: 'Total disk in bytes.' },
                swap_used: { type: 'integer', description: 'Used swap in bytes.' },
                swap_total: { type: 'integer', description: 'Total swap in bytes.' },
                net_up_per_sec: { type: 'integer', description: 'Current upload rate in bytes/sec.' },
                net_down_per_sec: { type: 'integer', description: 'Current download rate in bytes/sec.' },
                net_total_up: { type: 'integer', description: 'Lifetime uploaded bytes.' },
                net_total_down: { type: 'integer', description: 'Lifetime downloaded bytes.' },
                tcp_connections: { type: 'integer', description: 'TCP connection count.' },
                udp_connections: { type: 'integer', description: 'UDP connection count.' },
                process_count: { type: 'integer', description: 'Process count.' },
                temperature: { type: 'number', description: 'Temperature in Celsius (0 when unreported).' },
                os: { type: 'string', description: 'Operating system.' },
                arch: { type: 'string', description: 'CPU architecture.' },
                cpu_model: { type: 'string', description: 'CPU model.' },
                virtualization: { type: 'string', description: 'Virtualization type.' },
                gpu: { type: 'string', description: 'GPU model, empty when none.' },
                memo: { type: 'string', description: 'Remark configured for this machine.' },
              },
            },
          },
        },
      },
      render: textRender(renderListOutput),
    },
    timeoutMs: 60000,
    execute: async (args: unknown, exec: ToolRunContext) => {
      const a = args as { group?: string; include_offline?: boolean }
      exec.signal.throwIfAborted()
      const endpoint = getConfig().endpoint
      const nodes = await client().listNodes(exec.signal)
      let live: Record<string, KomariLive> = {}
      let warning: string | undefined
      try {
        live = await client().latestStatus(exec.signal)
      } catch (err) {
        warning = 'live status unavailable (' + (err instanceof Error ? err.message : String(err))
          + '); static data only'
      }
      const group = typeof a.group === 'string' && a.group !== '' ? a.group : undefined
      const includeOffline = a.include_offline !== false
      const summaries = nodes
        .filter(n => (group === undefined ? true : n.group === group))
        .map(n => summarizeNode(n, live[n.uuid]))
        .filter(s => includeOffline || s.online)
        .sort((x, y) => {
          if (x.online !== y.online) return x.online ? -1 : 1
          const g = x.group.localeCompare(y.group)
          return g !== 0 ? g : x.name.localeCompare(y.name)
        })
      const out: {
        endpoint: string
        total: number
        online: number
        offline: number
        warning?: string
        nodes: NodeSummary[]
      } = {
        endpoint,
        total: summaries.length,
        online: summaries.filter(s => s.online).length,
        offline: summaries.filter(s => !s.online).length,
        nodes: summaries,
      }
      if (warning !== undefined) out.warning = warning
      return out
    },
  }),

    defineTool({
    name: 'komari_exec',
    description:
      'Run a shell command on one or more monitored machines through the Komari panel and return each machine\'s '
      + 'output and exit code. The command runs through the panel agent with that agent\'s privileges — root on most '
      + 'Linux nodes, the agent service account on Windows (PowerShell: avoid bash-only syntax such as "&&"). '
      + 'DANGEROUS: these are production machines and this tool executes for real. Before running anything destructive '
      + '(restart, delete, edit configuration, install packages, or a batch command), state the exact plan and get '
      + 'explicit user confirmation first. '
      + 'Targets accept a uuid, an exact machine name, or a unique name substring; ambiguous or unknown references are '
      + 'reported and skipped. Waits up to wait_seconds for output and reports whatever is still running.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to execute on each target machine (sh on Linux, PowerShell on Windows).',
      },
      nodes: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Target machines: a uuid, an exact name, or a unique name substring (e.g. ["润才 腾讯 广州BGP"]).',
      },
      wait_seconds: {
        type: 'integer',
        description: 'How long to wait for results before returning what has landed. Default '
          + String(DEFAULT_WAIT_SECONDS) + ', max ' + String(MAX_WAIT_SECONDS) + '.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'Komari task id (empty when nothing was submitted).' },
          command: { type: 'string', required: true, description: 'The command that was submitted.' },
          status: {
            type: 'string',
            required: true,
            description: '"completed" (every target reported), "partial" (some still running), or "rejected" (no valid target).',
          },
          message: { type: 'string', description: 'Why the submission was rejected, when status is "rejected".' },
          unresolved: { type: 'array', items: { type: 'string' }, description: 'Node references that matched no machine.' },
          ambiguous: {
            type: 'array',
            description: 'Node references that matched several machines and were skipped.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                candidates: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          targets: {
            type: 'array',
            required: true,
            description: 'Machines the command was submitted to.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                uuid: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
          pending: { type: 'array', items: { type: 'string' }, description: 'Targets whose result had not arrived yet.' },
          results: {
            type: 'array',
            required: true,
            description: 'Results that arrived within the wait window.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                uuid: { type: 'string', required: true },
                name: { type: 'string', required: true },
                exit_code: { type: 'integer', required: true, description: 'Exit code (-1 when the machine was offline).' },
                output: { type: 'string', required: true, description: 'Command output (stdout, often with stderr).' },
                finished_at: { type: 'string', description: 'ISO-8601 finish timestamp; empty when not reported yet.' },
              },
            },
          },
        },
      },
      render: textRender(renderExecOutput),
    },
    timeoutMs: 320000,
    execute: async (args: unknown, exec: ToolRunContext) => {
      const a = args as { command: string; nodes: string[]; wait_seconds?: number }
      exec.signal.throwIfAborted()
      const command = a.command
      const requested = Array.isArray(a.nodes) ? a.nodes : []
      const waitSeconds = Math.min(
        Math.max(1, typeof a.wait_seconds === 'number' && Number.isFinite(a.wait_seconds)
          ? Math.floor(a.wait_seconds)
          : DEFAULT_WAIT_SECONDS),
        MAX_WAIT_SECONDS,
      )

      const all = await client().listNodes(exec.signal)
      const resolved = resolveNodeRefs(requested, all)
      const targets = resolved.matched.map(m => ({ uuid: m.uuid, name: m.name }))

      if (targets.length === 0) {
        const detail = resolved.ambiguous.length > 0
          ? 'ambiguous node reference(s): ' + resolved.ambiguous.map(x => '"' + x.ref + '" matches ' + x.candidates.join(', ')).join('; ')
          : 'no machine matched: ' + resolved.unresolved.join(', ')
        return {
          task_id: '',
          command,
          status: 'rejected' as const,
          message: detail,
          unresolved: resolved.unresolved,
          ambiguous: resolved.ambiguous,
          targets,
          pending: [] as string[],
          results: [] as ExecResultRow[],
        }
      }

      const submitted = await client().exec(command, targets.map(t => t.uuid), exec.signal)
      const nameOf = new Map(targets.map(t => [t.uuid, t.name]))
      const deadline = Date.now() + waitSeconds * 1000
      let collected: ExecResultRow[] = []
      let expected = targets.length
      for (;;) {
        exec.signal.throwIfAborted()
        const task = await client().task(submitted.task_id, exec.signal)
        expected = task.clients.length > 0 ? task.clients.length : targets.length
        collected = task.results.map(r => ({
          uuid: r.client,
          name: nameOf.get(r.client) ?? r.client,
          exit_code: r.exit_code,
          output: r.result,
          finished_at: r.finished_at ?? '',
        }))
        if (collected.length >= expected || Date.now() >= deadline) break
        await delay(POLL_INTERVAL_MS, exec.signal)
      }

      const done = new Set(collected.map(r => r.uuid))
      const pending = targets.map(t => t.uuid).filter(uuid => !done.has(uuid))
      return {
        task_id: submitted.task_id,
        command,
        status: pending.length === 0 ? 'completed' : 'partial',
        unresolved: resolved.unresolved,
        ambiguous: resolved.ambiguous,
        targets,
        pending,
        results: collected.sort((x, y) => x.name.localeCompare(y.name)),
      }
    },
  }),

    defineTool({
    name: 'komari_upload_file',
    description:
      'Copy a file from THIS machine (where dsh runs) to one or more monitored machines, using the Komari panel\'s '
      + 'chunked upload stream. Files up to 8 GiB are accepted; large files are sent in chunks and the remote path is '
      + 'created or overwritten. '
      + 'DANGEROUS: this overwrites the destination path on production machines; get explicit user confirmation before '
      + 'replacing an existing file. '
      + 'Targets accept a uuid, an exact machine name, or a unique name substring; ambiguous or unknown references are '
      + 'reported and skipped.',
    parameters: {
      local_path: {
        type: 'string',
        required: true,
        description: 'Path of the source file on the machine running dsh (absolute, or relative to the dsh working directory).',
      },
      remote_path: {
        type: 'string',
        required: true,
        description: 'Absolute destination path on the target machine(s), e.g. /root/app.tar.gz or C:\\Temp\\app.zip.',
      },
      nodes: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Target machines: a uuid, an exact name, or a unique name substring.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          local_path: { type: 'string', required: true, description: 'Source path that was read.' },
          remote_path: { type: 'string', required: true, description: 'Destination path on the target machines.' },
          bytes: { type: 'integer', required: true, description: 'Size of the local file in bytes.' },
          status: {
            type: 'string',
            required: true,
            description: '"uploaded" (every target succeeded), "partial" (some failed), or "rejected" (no valid target).',
          },
          message: { type: 'string', description: 'Why the transfer was rejected, when status is "rejected".' },
          unresolved: { type: 'array', items: { type: 'string' }, description: 'Node references that matched no machine.' },
          ambiguous: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                candidates: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          results: {
            type: 'array',
            required: true,
            description: 'One entry per targeted machine.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                uuid: { type: 'string', required: true },
                name: { type: 'string', required: true },
                ok: { type: 'boolean', required: true, description: 'Whether this machine received the file.' },
                bytes: { type: 'integer', required: true, description: 'Bytes written on this machine (0 on failure).' },
                chunks: { type: 'integer', description: 'Chunk count sent to this machine.' },
                error: { type: 'string', description: 'Failure reason for this machine.' },
              },
            },
          },
        },
      },
      render: textRender(renderUploadOutput),
    },
    timeoutMs: 900000,
    execute: async (args: unknown, exec: ToolRunContext) => {
      const a = args as { local_path: string; remote_path: string; nodes: string[] }
      exec.signal.throwIfAborted()
      const localPath = a.local_path
      const remotePath = a.remote_path
      const requested = Array.isArray(a.nodes) ? a.nodes : []

      const all = await client().listNodes(exec.signal)
      const resolved = resolveNodeRefs(requested, all)
      if (resolved.matched.length === 0) {
        const detail = resolved.ambiguous.length > 0
          ? 'ambiguous node reference(s): ' + resolved.ambiguous.map(x => '"' + x.ref + '" matches ' + x.candidates.join(', ')).join('; ')
          : 'no machine matched: ' + resolved.unresolved.join(', ')
        return {
          local_path: localPath,
          remote_path: remotePath,
          bytes: 0,
          status: 'rejected' as const,
          message: detail,
          unresolved: resolved.unresolved,
          ambiguous: resolved.ambiguous,
          results: [] as { uuid: string; name: string; ok: boolean; bytes: number; chunks?: number; error?: string }[],
        }
      }

      const link = linkTimeout(exec.signal, getConfig().transferTimeoutMs)
      const results: { uuid: string; name: string; ok: boolean; bytes: number; chunks?: number; error?: string }[] = []
      let total = 0
      try {
        for (const target of resolved.matched) {
          exec.signal.throwIfAborted()
          try {
            const outcome = await uploadLocalFile(client(), target.uuid, localPath, remotePath, link.signal)
            total = outcome.bytes
            results.push({ uuid: target.uuid, name: target.name, ok: true, bytes: outcome.bytes, chunks: outcome.chunks })
          } catch (err) {
            results.push({
              uuid: target.uuid,
              name: target.name,
              ok: false,
              bytes: 0,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } finally {
        link.dispose()
      }
      const failed = results.filter(r => !r.ok).length
      return {
        local_path: localPath,
        remote_path: remotePath,
        bytes: total,
        status: failed === 0 ? 'uploaded' : 'partial',
        unresolved: resolved.unresolved,
        ambiguous: resolved.ambiguous,
        results,
      }
    },
  }),

    defineTool({
    name: 'komari_download_file',
    description:
      'Copy a file from one monitored machine to THIS machine (where dsh runs), through the Komari panel\'s binary '
      + 'download stream. The bytes are streamed to disk; the response metadata (resolved filename and content type) is '
      + 'reported back. Directories cannot be downloaded. '
      + 'Targets accept a uuid, an exact machine name, or a unique name substring.',
    parameters: {
      remote_path: {
        type: 'string',
        required: true,
        description: 'Absolute source path on the target machine, e.g. /var/log/syslog.',
      },
      node: {
        type: 'string',
        required: true,
        description: 'Source machine: a uuid, an exact name, or a unique name substring.',
      },
      local_path: {
        type: 'string',
        description: 'Where to write the file locally. Defaults to a komari-downloads/ folder in the OS temp directory.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string', required: true, description: 'Machine name the file was read from.' },
          uuid: { type: 'string', required: true, description: 'Machine uuid.' },
          remote_path: { type: 'string', required: true, description: 'Source path that was read.' },
          local_path: { type: 'string', required: true, description: 'Local path the file was written to.' },
          bytes: { type: 'integer', required: true, description: 'Bytes written locally.' },
          content_type: { type: 'string', description: 'Content type reported by the panel.' },
          filename: { type: 'string', description: 'Filename reported by the panel.' },
        },
      },
      render: textRender(renderDownloadOutput),
    },
    timeoutMs: 900000,
    execute: async (args: unknown, exec: ToolRunContext) => {
      const a = args as { remote_path: string; node: string; local_path?: string }
      exec.signal.throwIfAborted()
      const all = await client().listNodes(exec.signal)
      const resolved = resolveNodeRefs([a.node], all)
      if (resolved.matched.length === 0) {
        const detail = resolved.ambiguous.length > 0
          ? 'ambiguous node reference: ' + resolved.ambiguous.map(x => '"' + x.ref + '" matches ' + x.candidates.join(', ')).join('; ')
          : 'no machine matched: ' + resolved.unresolved.join(', ')
        throw new Error('komari_download_file: ' + detail)
      }
      const target = resolved.matched[0]
      if (target === undefined) throw new Error('komari_download_file: no machine matched')
      const dest = typeof a.local_path === 'string' && a.local_path !== ''
        ? a.local_path
        : defaultDownloadPath(a.remote_path)

      const link = linkTimeout(exec.signal, getConfig().transferTimeoutMs)
      try {
        const outcome = await downloadToLocalFile(client(), target.uuid, a.remote_path, dest, link.signal)
        const out: {
          node: string
          uuid: string
          remote_path: string
          local_path: string
          bytes: number
          content_type?: string
          filename?: string
        } = {
          node: target.name,
          uuid: target.uuid,
          remote_path: a.remote_path,
          local_path: outcome.path,
          bytes: outcome.bytes,
        }
        if (outcome.content_type !== null) out.content_type = outcome.content_type
        if (outcome.filename !== null) out.filename = outcome.filename
        return out
      } finally {
        link.dispose()
      }
    },
    }),
  ]
  return {
    name: TOOLSET_NAME,
    description: TOOLSET_DESCRIPTION,
    tools,
  }
}

/**
 * Contribute the Komari tools as one lazily-loaded toolset: they stay out of the
 * global tool list until the model calls `get_tools("komari")`, and the model
 * sees {@link TOOLSET_DESCRIPTION} as the when-to-use line instead.
 * @param ctx - host context (`toolsets` is injected by the entry).
 * @param getClient - live client getter.
 * @param getConfig - live config getter.
 */
export function registerTools(ctx: Context, getClient: () => KomariClient, getConfig: () => ResolvedConfig): void {
  ctx.toolsets.register(buildKomariToolset(getClient, getConfig))
}
