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

const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined

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
  <div className="field">
    <label htmlFor={id}>
      {label}
      {required ? <span aria-hidden="true"> *</span> : null}
    </label>
    <input
      id={id}
      type={type}
      inputMode={inputMode}
      autoComplete={autoComplete}
      value={value}
      onChange={e => onChange(e.target.value)}
      required={required}
      disabled={disabled}
      maxLength={maxLength}
      list={list}
      placeholder={placeholder}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)}
    />
    {hint ? (
      <span id={`${id}-hint`} className="badge">
        {hint}
      </span>
    ) : null}
    {error ? (
      <span id={`${id}-error`} className="field-error">
        {error}
      </span>
    ) : null}
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
  <div className="field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)}>
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
    {hint ? (
      <span id={`${id}-hint`} className="badge">
        {hint}
      </span>
    ) : null}
    {error ? (
      <span id={`${id}-error`} className="field-error">
        {error}
      </span>
    ) : null}
  </div>
)

/** Several boxes under one legend; the first box carries `id` (the focus goes there when the group is in error). */
export const CheckGroup = <V extends string>({ id, legend, values, chosen, label, onChange, hint, error, disabled }: { id: string; legend: string; values: readonly V[]; chosen: readonly V[]; label: (v: V) => string; onChange: (next: V[]) => void; hint?: string; error?: string; disabled?: boolean }) => (
  <fieldset className="field" aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)} aria-invalid={error ? true : undefined}>
    <legend>{legend}</legend>
    <div className="checks">
      {values.map((v, i) => (
        <label key={v} className="check">
          <input
            type="checkbox"
            id={i === 0 ? id : `${id}-${v}`}
            checked={chosen.includes(v)}
            disabled={disabled}
            onChange={e => onChange(e.target.checked ? values.filter(x => x === v || chosen.includes(x)) : chosen.filter(x => x !== v))}
          />{' '}
          {label(v)}
        </label>
      ))}
    </div>
    {hint ? (
      <span id={`${id}-hint`} className="badge">
        {hint}
      </span>
    ) : null}
    {error ? (
      <span id={`${id}-error`} className="field-error">
        {error}
      </span>
    ) : null}
  </fieldset>
)

export const CheckBox = ({ id, label, checked, onChange, hint, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) => (
  <div className="field">
    <label className="check" htmlFor={id}>
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} /> {label}
    </label>
    {hint ? (
      <span id={`${id}-hint`} className="badge">
        {hint}
      </span>
    ) : null}
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

/** What a form says after a send: a success (status) or a failure (alert), the second read at once. */
export type Note = { kind: 'ok' | 'error'; text: string } | null

export const NoteLine = ({ note }: { note: Note }) =>
  note?.kind === 'error' ? (
    <p className="alert alert-error" role="alert">
      {note.text}
    </p>
  ) : (
    <p className="badge" role="status">
      {note?.text ?? ''}
    </p>
  )

/** A summary of the problems of a form, read at once (the focus goes to the first field in error). */
export const ProblemSummary = ({ count }: { count: number }) => {
  const { t } = useT()
  return count ? (
    <p className="alert alert-error" role="alert">
      {t(count === 1 ? 'admin.form.oneProblem' : 'admin.form.problems', { count })}
    </p>
  ) : null
}

/**
 * A delete button that asks first: "Delete X?" then yes or no, in a group named by the question (the yes button gets
 * the focus, Escape or no puts it back on the delete button).
 */
export const ConfirmDelete = ({ label, question, onConfirm, disabled, yes = 'admin.confirm.yes', no = 'admin.confirm.no' }: { label: string; question: string; onConfirm: () => void; disabled?: boolean; yes?: Key; no?: Key }) => {
  const { t } = useT()
  const [asking, setAsking] = useState(false)
  if (!asking)
    return (
      <button type="button" className="btn btn-danger" onClick={() => setAsking(true)} disabled={disabled} aria-label={label}>
        {t('admin.delete')}
      </button>
    )
  return (
    <span role="group" aria-label={question} className="confirm" onKeyDown={e => e.key === 'Escape' && setAsking(false)}>
      {question}{' '}
      <button
        type="button"
        className="btn btn-danger"
        autoFocus
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
        disabled={disabled}
      >
        {t(yes)}
      </button>{' '}
      <button type="button" className="btn" onClick={() => setAsking(false)} disabled={disabled}>
        {t(no)}
      </button>
    </span>
  )
}

/** A section of the administration with its heading. */
export const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section className="card" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    {children}
  </section>
)
