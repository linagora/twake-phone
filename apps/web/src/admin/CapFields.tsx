import { OUTBOUND_CAPS, type OutboundCaps } from '@twake/telephony-client'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import type { CapForm, CapKey, CapsForm, Problem } from './validate.js'
import { useProblem } from './ui.js'

/**
 * The caps of a person or of the organisation (step 7), one row each: its default (said with its value), none, or a
 * value. The value field has the id `${prefix}-${cap}` (the focus goes there when it is wrong), the choice
 * `${prefix}-${cap}-mode`.
 */
export const CapFields = ({ prefix, legend, hint, caps, defaults, problems, onChange, disabled }: { prefix: string; legend: string; hint?: string; caps: CapsForm; defaults: OutboundCaps; problems: Partial<Record<string, Problem>>; onChange: (next: CapsForm) => void; disabled?: boolean }) => {
  const { t } = useT()
  const say = useProblem()
  const set = (k: CapKey, next: Partial<CapForm>) => onChange({ ...caps, [k]: { ...caps[k], ...next } })
  return (
    <fieldset className="field caps" aria-describedby={hint ? `${prefix}-hint` : undefined}>
      <legend>{legend}</legend>
      {hint ? (
        <span id={`${prefix}-hint`} className="badge">
          {hint}
        </span>
      ) : null}
      {OUTBOUND_CAPS.map(k => {
        const c = caps[k]
        const id = `${prefix}-${k}`
        const error = say(problems[k])
        const def = defaults[k]
        const name = t(`admin.cap.${k}` as Key)
        return (
          <div key={k} className="cap-row">
            <label htmlFor={`${id}-mode`}>{name}</label>
            <select id={`${id}-mode`} value={c.mode} onChange={e => set(k, { mode: e.target.value as CapForm['mode'] })} disabled={disabled}>
              <option value="default">{typeof def === 'number' ? t('admin.cap.defaultValue', { value: def }) : t('admin.cap.defaultNone')}</option>
              <option value="none">{t('admin.cap.none')}</option>
              <option value="value">{t('admin.cap.value')}</option>
            </select>
            {c.mode === 'value' ? (
              <input
                id={id}
                inputMode="numeric"
                autoComplete="off"
                maxLength={7}
                value={c.value}
                onChange={e => set(k, { value: e.target.value })}
                disabled={disabled}
                aria-label={t('admin.cap.valueOf', { name })}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
              />
            ) : null}
            {error ? (
              <span id={`${id}-error`} className="field-error">
                {error}
              </span>
            ) : null}
          </div>
        )
      })}
    </fieldset>
  )
}
