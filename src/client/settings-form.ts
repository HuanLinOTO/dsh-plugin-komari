/**
 * Staged form over the \`dsh-komari\` entry's profile Config.
 *
 * The client transport is \`ctx.configForms\`: this controller binds the entry's
 * shared ConfigForm (\`ctx.configForms.get('dsh-komari')\`), whose reads ride the
 * settings describe mirror and whose writes go through the Host settings
 * service (\`form.set\` resolves to whether the Host accepted the write).
 *
 * It stages the four editable fields, overlays drafts on the accepted value,
 * and publishes one snapshot the page renders through its bound hook.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** A minimal snapshot store: a value + a listener set (no browser-bundle symbols). */
class MiniSnapshotStore<T> implements SnapshotStore<T> {
  private snapshot: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.snapshot = initial
  }

  getSnapshot(): T {
    return this.snapshot
  }

  set(value: T): void {
    this.snapshot = value
    for (const listener of [...this.listeners]) listener()
  }

  update(mutator: (draft: T) => void): void {
    // Shallow clone then mutate: the projections here are plain objects with no
    // nested mutation, so a deep draft is unnecessary.
    const draft = { ...this.snapshot as object } as T
    mutator(draft)
    this.set(draft)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** The four fields the settings card edits (mirrors the host entry Config). */
export interface KomariFormValues {
  readonly endpoint: string
  readonly username: string
  readonly password: string
  readonly requestTimeoutMs: number
  readonly transferTimeoutMs: number
}

/** Composition-layer defaults, mirroring the host Config schema exactly. */
export const KOMARI_FORM_DEFAULTS: KomariFormValues = {
  endpoint: '',
  username: '',
  password: '',
  requestTimeoutMs: 15000,
  transferTimeoutMs: 600000,
}

/** Page-level state shared with the component. */
export interface KomariSettingsState {
  /** \`loading\` until the first Host view, \`unavailable\` when the entry is not served. */
  status: ConfigFormSnapshot<KomariFormValues>['status']
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether staged edits exist that a save would write. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save landed (transient flash). */
  saved: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
  /** Whether the endpoint field already holds a value (drives the summary). */
  configured: boolean
  /** Accepted value overlaid with staged drafts. */
  values: KomariFormValues
}

/** How long the "Saved" confirmation stays visible after a landed save. */
const SAVED_FLASH_MS = 2000

/**
 * Bridges the \`dsh-komari\` entry's ConfigForm onto the page's staged form.
 */
export class KomariSettingsController {
  private readonly store: MiniSnapshotStore<KomariSettingsState>
  private readonly staged = new Map<keyof KomariFormValues, unknown>()
  private saving = false
  private saved = false
  private failed = false
  private savedTimer: ReturnType<typeof setTimeout> | undefined

  /** @param form - the bound config form for the \`dsh-komari\` entry. */
  constructor(private readonly form: ConfigForm<KomariFormValues>) {
    this.store = new MiniSnapshotStore<KomariSettingsState>(this.project())
    form.subscribe(() => { this.publish() })
  }

  /** @returns the store the page's slot registration injects. */
  get snapshot(): SnapshotStore<KomariSettingsState> {
    return this.store
  }

  /** Stage one field edit; the draft overlays the accepted value until save. */
  edit<K extends keyof KomariFormValues>(field: K, value: KomariFormValues[K]): void {
    this.staged.set(field, value)
    this.failed = false
    this.publish()
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  save(): void {
    void this.commit()
  }

  private async commit(): Promise<void> {
    if (this.staged.size === 0 || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const [field, value] of this.staged) {
      try {
        const accepted = await this.form.set(field, value)
        if (!accepted) landed = false
      } catch {
        landed = false
      }
    }
    this.saving = false
    if (landed) {
      this.staged.clear()
      this.flashSaved()
    }
    this.failed = !landed
    this.publish()
  }

  private flashSaved(): void {
    this.saved = true
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer)
    this.savedTimer = setTimeout(() => {
      this.savedTimer = undefined
      this.saved = false
      this.publish()
    }, SAVED_FLASH_MS)
  }

  private publish(): void {
    this.store.set(this.project())
  }

  private project(): KomariSettingsState {
    const snapshot = this.form.getSnapshot()
    const values: KomariFormValues = { ...KOMARI_FORM_DEFAULTS }
    if (snapshot.status === 'ready' && snapshot.value !== undefined) {
      Object.assign(values, snapshot.value)
    }
    for (const [field, value] of this.staged) {
      (values as Record<keyof KomariFormValues, unknown>)[field] = value
    }
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      saving: this.saving,
      saved: this.saved,
      failed: this.failed,
      configured: values.endpoint.trim() !== '' && values.username.trim() !== '',
      values,
    }
  }
}
