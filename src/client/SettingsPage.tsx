import { useCallback, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { KomariFormValues, KomariSettingsState } from './settings-form.js'
import type { KomariKey } from './locales.js'
import css from './SettingsPage.module.css'

/** Normalized outcome of one komari.probe call (Host RPC). */
export type ConnectionProbe =
  | { readonly ok: true; readonly node_count: number; readonly online_count: number }
  | { readonly ok: false; readonly message: string }

/** Injected dependencies of the row config card (slot inject face). */
export interface KomariSettingsInjected {
  hooks: {
    /** Card snapshot bound by the renderer as useKomariSettings. */
    komariSettings: SnapshotStore<KomariSettingsState>
  }
  /** Stage one field edit. */
  edit: <K extends keyof KomariFormValues>(field: K, value: KomariFormValues[K]) => void
  /** Write every staged edit through the config form. */
  save: () => void
  /** Probe the configured panel (komari.probe Host RPC). */
  probe: () => Promise<ConnectionProbe>
}

type SettingsPageProps = PropsRuntime<'plugins.row.config'> & PropsLocale<'dsh-komari'> & InjectFace<KomariSettingsInjected>

export function SettingsPage(props: SettingsPageProps): ReactNode {
  const { t } = props
  // The row page draws the title, icon and crumb itself; 'summary' is only the
  // fallback one-liner shown when the row carries no description of its own.
  if (props.view === 'summary') return t('page.summary')

  const state = props.useKomariSettings(snapshot => snapshot)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'empty' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState<string | undefined>(undefined)

  const testConnection = useCallback(async () => {
    setTestStatus('testing')
    setTestMessage(undefined)
    try {
      const result = await props.probe()
      if (result.ok && result.node_count > 0) {
        setTestStatus('ok')
        setTestMessage(t('test.ok') + ' — ' + String(result.node_count) + ' machine(s), ' + String(result.online_count) + ' online')
      } else if (result.ok) {
        setTestStatus('empty')
        setTestMessage(t('test.failed'))
      } else {
        setTestStatus('error')
        setTestMessage(result.message)
      }
    } catch (err) {
      setTestStatus('error')
      setTestMessage(err instanceof Error ? err.message : String(err))
    }
  }, [props, t])

  if (state.status !== 'ready') {
    return (
      <section className={css.section}>
        <div className={css.loading}>{state.status === 'loading' ? '…' : t('page.unavailable')}</div>
      </section>
    )
  }

  const { values } = state

  return (
    <section className={css.section}>
      {!state.writable && <p className={css.loading}>{t('page.readOnly')}</p>}
      {state.failed && <div className={css.error}>{t('action.saveFailed')}</div>}

      <div className={css.editor}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.endpoint')}</span>
          <input
            className={css.input}
            value={values.endpoint}
            placeholder={t('field.endpoint.placeholder')}
            onChange={e => props.edit('endpoint', e.target.value)}
          />
        </label>

        <div className={css.row}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.username')}</span>
            <input
              className={css.input}
              value={values.username}
              autoComplete="off"
              onChange={e => props.edit('username', e.target.value)}
            />
          </label>

          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.password')}</span>
            <input
              className={css.input}
              type="password"
              value={values.password}
              autoComplete="new-password"
              onChange={e => props.edit('password', e.target.value)}
            />
          </label>

          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.requestTimeoutMs')}</span>
            <input
              className={css.input}
              type="number"
              value={values.requestTimeoutMs}
              onChange={e => props.edit('requestTimeoutMs', Number(e.target.value))}
            />
          </label>

          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.transferTimeoutMs')}</span>
            <input
              className={css.input}
              type="number"
              value={values.transferTimeoutMs}
              onChange={e => props.edit('transferTimeoutMs', Number(e.target.value))}
            />
          </label>
        </div>

        <p className={css.hint}>{t('hint.credentials')}</p>
        <p className={css.hint}>{t('hint.exec')}</p>
      </div>

      <div className={css.actions}>
        <button
          type="button"
          className={css.primaryButton}
          onClick={props.save}
          disabled={!state.dirty || state.saving || !state.writable}
        >
          {state.saving ? '…' : state.saved ? t('action.saved') : t('action.save')}
        </button>
        <button
          type="button"
          className={css.secondaryButton}
          onClick={() => void testConnection()}
          disabled={testStatus === 'testing'}
        >
          {testStatus === 'testing' ? t('action.testing') : t('action.test')}
        </button>
        {testStatus === 'ok' && testMessage !== undefined && <span className={css.testOk}>{testMessage}</span>}
        {testStatus === 'empty' && testMessage !== undefined && <span className={css.testWarn}>{testMessage}</span>}
        {testStatus === 'error' && testMessage !== undefined && (
          <span className={css.testErr}>{t('test.error')}: {testMessage}</span>
        )}
      </div>
    </section>
  )
}
