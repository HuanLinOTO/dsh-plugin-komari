import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTRY_ID, PKG_NAME, ROW_KEY } from '../src/client/row-key.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('plugins.row.config row key', () => {
  it('ROW_KEY is package name + row id', () => {
    expect(ROW_KEY).toBe(PKG_NAME + '#' + ENTRY_ID)
  })

  it('PKG_NAME matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(PKG_NAME).toBe(pkg.name)
  })

  it('ENTRY_ID matches the cordis.patch.yml row id and its name matches the package', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    const id = /- id:\s*(\S+)/.exec(patch)?.[1]
    const name = /name:\s*'([^']+)'/.exec(patch)?.[1]
    expect(id).toBe(ENTRY_ID)
    expect(name).toBe(PKG_NAME)
  })

  it('declares the bundle patch and a client half', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string }; client?: { inject?: string[] } }
      files?: string[]
      exports?: Record<string, unknown>
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('lib/')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(Object.keys(pkg.exports ?? {})).toContain('./client')
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
  })
})
