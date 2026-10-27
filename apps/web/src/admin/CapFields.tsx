import { FormControl, FormHelperText, FormLabel, Stack, TextField } from '@linagora/twake-mui'
import { OUTBOUND_CAPS, type OutboundCaps } from '@twake/telephony-client'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import type { CapForm, CapKey, CapsForm, Problem } from './validate.js'
import { FieldError, useProblem } from './ui.js'

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
    <FormControl component="fieldset" fullWidth className="u-mb-1" aria-describedby={hint ? `${prefix}-hint` : undefined}>
      <FormLabel component="legend">{legend}</FormLabel>
      {hint ? (
        <FormHelperText id={`${prefix}-hint`} component="span">
          {hint}
        </FormHelperText>
      ) : null}
      {OUTBOUND_CAPS.map(k => {
        const c = caps[k]
        const id = `${prefix}-${k}`
        const error = say(problems[k])
        const def = defaults[k]
        const name = t(`admin.cap.${k}` as Key)
        return (
          <div key={k} className="u-mt-1">
            <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap u-flex-items-center">
              <TextField
                select
                id={`${id}-mode`}
                label={name}
                value={c.mode}
                onChange={e => set(k, { mode: e.target.value as CapForm['mode'] })}
                disabled={disabled}
                slotProps={{
                  select: { native: true },
                  inputLabel: { shrink: true }
                }}
              >
                <option value="default">{typeof def === 'number' ? t('admin.cap.defaultValue', { value: def }) : t('admin.cap.defaultNone')}</option>
                <option value="none">{t('admin.cap.none')}</option>
                <option value="value">{t('admin.cap.value')}</option>
              </TextField>
              {c.mode === 'value' ? (
                <TextField
                  id={id}
                  value={c.value}
                  onChange={e => set(k, { value: e.target.value })}
                  disabled={disabled}
                  error={Boolean(error)}
                  slotProps={{
                    htmlInput: {
                      inputMode: 'numeric',
                      autoComplete: 'off',
                      maxLength: 7,
                      'aria-label': t('admin.cap.valueOf', { name }),
                      'aria-invalid': error ? true : undefined,
                      'aria-describedby': error ? `${id}-error` : undefined
                    }
                  }}
                />
              ) : null}
            </Stack>
            <FieldError id={id} error={error} />
          </div>
        )
      })}
    </FormControl>
  )
}
