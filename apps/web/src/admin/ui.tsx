import { Alert, Button, Card, CardContent, Checkbox, FormControl, FormControlLabel, FormGroup, FormHelperText, FormLabel, Stack, TextField as MuiTextField, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Key } from '../i18n/index.js'
import { useT } from '../i18n/useT.js'
import type { Problem } from './validate.js'

// The pieces the administration forms share (step 7): a label for every field, its hint and its error tied to it
// (aria-describedby, aria-invalid), the focus on the first field in error, a confirmation before a deletion.

/** The words of a problem. */
export const useProblem = () => {
  const { t } = useT()
  return useCallback((problem: Problem | undefined) => (problem ? t(problem.key, problem.params) : undefined), [t])
}

/**
 * The error of a field, named `${id}-error` (its aria-describedby). The sign before it is drawn, not read: a screen
 * reader says the error once, without "warning" before each one (review 7 n°15).
 */
export const FieldError = ({ id, error }: { id: string; error?: string | undefined }) =>
  error ? (
    <FormHelperText id={`${id}-error`} component="span" error className="u-fw-bold">
      <span aria-hidden="true">⚠ </span>
      {error}
    </FormHelperText>
  ) : null

/**
 * The latest `value`, for the callbacks that read what a screen shows: a change of language changes the words, never
 * what was read nor what is typed (a read that depended on them would start again, review 7 n°13).
 */
export const useLatest = <V,>(value: V) => {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined

/** The hint under a field, named `${id}-hint` (its aria-describedby). */
const Hint = ({ id, hint }: { id: string; hint?: string | undefined }) =>
  hint ? (
    <FormHelperText id={`${id}-hint`} component="span">
      {hint}
    </FormHelperText>
  ) : null

interface TextFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  error?: string
  type?: 'text' | 'password' | 'tel' | 'number'
  inputMode?: 'text' | 'tel' | 'numeric'
  autoComplete?: string
  required?: boolean
  disabled?: boolean
  maxLength?: number
  list?: string
  placeholder?: string
}

export const TextField = ({ id, label, value, onChange, hint, error, type = 'text', inputMode, autoComplete = 'off', required, disabled, maxLength = 256, list, placeholder }: TextFieldProps) => (
  <div className="u-mb-1">
    <MuiTextField
      id={id}
      label={label}
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      required={required}
      disabled={disabled}
      placeholder={placeholder}
      error={Boolean(error)}
      fullWidth
      slotProps={{
        htmlInput: {
          inputMode,
          autoComplete,
          maxLength,
          list,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': describedBy(hint && `${id}-hint`, error && `${id}-error`)
        }
      }}
    />
    <Hint id={id} hint={hint} />
    <FieldError id={id} error={error} />
  </div>
)

interface SelectFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  hint?: string
  error?: string
  disabled?: boolean
}

export const SelectField = ({ id, label, value, onChange, options, hint, error, disabled }: SelectFieldProps) => (
  <div className="u-mb-1">
    <MuiTextField
      select
      id={id}
      label={label}
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      error={Boolean(error)}
      fullWidth
      slotProps={{
        // The browser's own list: the keyboard and screen readers know it, and so do the tests' change events.
        select: { native: true },
        inputLabel: { shrink: true },
        htmlInput: { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy(hint && `${id}-hint`, error && `${id}-error`) }
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </MuiTextField>
    <Hint id={id} hint={hint} />
    <FieldError id={id} error={error} />
  </div>
)

/** Several boxes under one legend; the first box carries `id` (the focus goes there when the group is in error). */
export const CheckGroup = <V extends string>({ id, legend, values, chosen, label, onChange, hint, error, disabled }: { id: string; legend: string; values: readonly V[]; chosen: readonly V[]; label: (v: V) => string; onChange: (next: V[]) => void; hint?: string; error?: string; disabled?: boolean }) => (
  <FormControl component="fieldset" error={Boolean(error)} fullWidth className="u-mb-1" aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)} aria-invalid={error ? true : undefined}>
    <FormLabel component="legend">{legend}</FormLabel>
    <FormGroup row>
      {values.map((v, i) => (
        <FormControlLabel
          key={v}
          label={label(v)}
          control={
            <Checkbox
              id={i === 0 ? id : `${id}-${v}`}
              checked={chosen.includes(v)}
              disabled={disabled}
              onChange={e => onChange(e.target.checked ? values.filter(x => x === v || chosen.includes(x)) : chosen.filter(x => x !== v))}
            />
          }
        />
      ))}
    </FormGroup>
    <Hint id={id} hint={hint} />
    <FieldError id={id} error={error} />
  </FormControl>
)

export const CheckBox = ({ id, label, checked, onChange, hint, error, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; error?: string; disabled?: boolean }) => (
  <div className="u-mb-1">
    <FormControlLabel
      label={label}
      control={
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onChange={e => onChange(e.target.checked)}
          slotProps={{ input: { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy(hint && `${id}-hint`, error && `${id}-error`) } }}
        />
      }
    />
    <Hint id={id} hint={hint} />
    <FieldError id={id} error={error} />
  </div>
)

/**
 * Puts the focus on the first field in error, in the order of the form (`prefix`: the ids of its fields), once the
 * form can take it: after a refusal of the Gateway, its fields are still disabled (sending) when the refusal is read;
 * the focus goes to the field at the first render that enables it.
 */
export const useFocusLater = () => {
  const pending = useRef<string | null>(null)
  useEffect(() => {
    if (!pending.current) return
    const el = document.getElementById(pending.current) ?? document.getElementById(`${pending.current}-mode`)
    if (el && !(el as HTMLInputElement).disabled) {
      el.focus()
      pending.current = null
    }
  })
  return useCallback((order: readonly string[], problems: Partial<Record<string, unknown>>, prefix: string) => {
    const first = order.find(f => problems[f])
    pending.current = first ? `${prefix}-${first}` : null
  }, [])
}

/**
 * What a form says after a send: a success (status) or a failure (alert), the second read at once. `focus`: the
 * focus goes to it, when what had it is gone (a row deleted or acknowledged, its buttons with it).
 */
export type Note = { kind: 'ok' | 'error'; text: string; focus?: boolean } | null

export const NoteLine = ({ note }: { note: Note }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (note?.focus) ref.current?.focus()
  }, [note])
  return note?.kind === 'error' ? (
    <Alert ref={ref} severity="error" role="alert" tabIndex={-1} className="u-mb-1">
      {note.text}
    </Alert>
  ) : (
    <Typography ref={ref} component="p" variant="body2" color="textSecondary" role="status" tabIndex={-1} className="u-mb-1">
      {note?.text ?? ''}
    </Typography>
  )
}

/**
 * Runs `read` again `everyMs` after each answer (never two at once, never out of order), while the page is shown: a
 * hidden tab reads nothing, and reads at once when shown again (review 7 n°5). Stops when the screen goes away.
 * `now`: the first read at once, else after `everyMs` (the screen read it already).
 */
export const useRefresh = (read: () => Promise<unknown>, everyMs: number, enabled = true, now = false) => {
  // The latest `read` (what it reads may change, the timer goes on).
  const latest = useLatest(read)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const next = () => {
      clearTimeout(timer)
      if (live && !document.hidden) timer = setTimeout(run, everyMs)
    }
    const run = () => {
      if (running || !live || document.hidden) return
      running = true
      void latest
        .current()
        .catch(() => undefined)
        .finally(() => {
          running = false
          next()
        })
    }
    const shown = () => {
      if (document.hidden) clearTimeout(timer)
      else run()
    }
    if (now) run()
    else next()
    document.addEventListener('visibilitychange', shown)
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [latest, everyMs, enabled, now])
}

/** A summary of the problems of a form, read at once (the focus goes to the first field in error). */
export const ProblemSummary = ({ count }: { count: number }) => {
  const { t } = useT()
  return count ? (
    <Alert severity="error" role="alert" className="u-mb-1">
      {t(count === 1 ? 'admin.form.oneProblem' : 'admin.form.problems', { count })}
    </Alert>
  ) : null
}

/**
 * A delete button that asks first: "Delete X?" then yes or no, in a group named by the question (the yes button gets
 * the focus, Escape or no puts it back on the delete button; after yes, the page puts it on what it says).
 */
export const ConfirmDelete = ({
  label,
  question,
  onConfirm,
  disabled,
  yes = 'admin.confirm.yes',
  no = 'admin.confirm.no',
  action = 'admin.delete',
  tone = 'danger'
}: {
  label: string
  question: string
  onConfirm: () => void
  disabled?: boolean
  yes?: Key
  no?: Key
  /** The button that asks: Delete unless said (a new secret, which also undoes something, asks the same way). */
  action?: Key
  tone?: 'danger' | 'plain'
}) => {
  const { t } = useT()
  const [asking, setAsking] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const back = useRef(false)
  useEffect(() => {
    if (asking || !back.current) return
    back.current = false
    button.current?.focus()
  }, [asking])
  const keep = () => {
    back.current = true
    setAsking(false)
  }
  if (!asking)
    return (
      <Button ref={button} variant="outlined" color={tone === 'danger' ? 'error' : 'primary'} onClick={() => setAsking(true)} disabled={disabled} aria-label={label}>
        {t(action)}
      </Button>
    )
  return (
    <Stack
      component="span"
      direction="row"
      spacing={1}
      useFlexGap
      role="group"
      aria-label={question}
      className="u-flex-items-center u-flex-wrap"
      onKeyDown={e => {
        if (e.key === 'Escape') keep()
      }}
    >
      {question}{' '}
      <Button
        color="error"
        autoFocus
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
        disabled={disabled}
      >
        {t(yes)}
      </Button>{' '}
      <Button variant="outlined" onClick={keep} disabled={disabled}>
        {t(no)}
      </Button>
    </Stack>
  )
}

/** A section of the administration with its heading. */
export const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <Card component="section" variant="outlined" aria-labelledby={id} className="u-mb-1">
    <CardContent>
      <Typography variant="h5" component="h2" id={id} gutterBottom>
        {title}
      </Typography>
      {children}
    </CardContent>
  </Card>
)
