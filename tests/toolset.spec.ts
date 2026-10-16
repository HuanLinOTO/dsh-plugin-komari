import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KomariClient } from '../src/komari.js'
import { buildKomariToolset, TOOLSET_DESCRIPTION, TOOLSET_NAME, type ResolvedConfig } from '../src/tools.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// The definitions are inspected, never executed, so the collaborators can be
// placeholders; only their types matter at build time.
const client = {} as unknown as KomariClient
const config = {
  endpoint: 'https://panel.example.com',
  username: 'admin',
  password: 'secret',
  requestTimeoutMs: 15000,
  transferTimeoutMs: 600000,
} satisfies ResolvedConfig

const TOOLSET_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

describe('komari toolset', () => {
  const toolset = buildKomariToolset(() => client, () => config)

  it('registers one toolset named for the panel, matching the toolsets name pattern', () => {
    expect(toolset.name).toBe(TOOLSET_NAME)
    expect(TOOLSET_NAME_PATTERN.test(toolset.name)).toBe(true)
    expect(toolset.name.length).toBeLessThanOrEqual(64)
    expect(toolset.description).toBe(TOOLSET_DESCRIPTION)
    expect(toolset.description.trim().length).toBeGreaterThan(20)
  })

  it('carries every model-facing tool', () => {
    expect(toolset.tools.map(t => t.name).sort()).toEqual([
      'komari_download_file',
      'komari_exec',
      'komari_list_nodes',
      'komari_upload_file',
    ])
  })

  it('satisfies the toolsets registration contract for every tool', () => {
    const reserved = 'get_tools'
    for (const tool of toolset.tools) {
      expect(tool.name).not.toBe(reserved)
      expect(tool.name).not.toBe('')
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(20)
      expect(typeof tool.execute).toBe('function')
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })

  it('builds fresh definitions per call so each plugin instance owns its closures', () => {
    const other = buildKomariToolset(() => client, () => config)
    expect(other).not.toBe(toolset)
    expect(other.tools[0]).not.toBe(toolset.tools[0])
  })

  it('declares the toolsets plugin as a peer dependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(pkg.peerDependencies?.['@huanlin/dsh-plugin-toolsets']).toBeDefined()
  })
})
