import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { RingGroup } from '@twake/telephony-client'
import { ConfirmDelete, NoteLine, ProblemSummary, Section, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { GROUP_FIELDS, checkGroup, emptyGroup, groupRefusal, refusalOf, type GroupField, type GroupForm, type Problems } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The organisation's simultaneous ring groups (ADR 0014): a number of its own that rings its members at once, the
 * first to answer takes the call. Administrators only; checked here as the Gateway checks it (step 7, review 7 n°7),
 * each problem next to its field, the focus on the first one; the Gateway checks every field again and says whether
 * the number is free. "New group" never replaces one (409), a deletion is confirmed first, and a member nobody holds
 * now is shown as vacant.
 */
export const RingGroups = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const [groups, setGroups] = useState<RingGroup[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<GroupForm>(emptyGroup)
  // The number of the group being changed: its number is then not editable (another number is another group).
  const [editing, setEditing] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problems<GroupField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)

  const load = useCallback(() => {
    client
      .listGroups()
      .then(r => setGroups(r.items))
      .catch((err: unknown) => {
        // 501: the platform has no groups; 404: the organisation has no telephony platform at all.
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.groupsLoadError') })
      })
  }, [client, t])
  useEffect(load, [load])

  const set = (key: keyof GroupForm) => (value: string) => setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptyGroup())
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkGroup(editing ? { ...form, number: editing } : form)
    setProblems(checked.problems)
    if (!checked.group) {
      focusLater(GROUP_FIELDS, checked.problems, 'group')
      return
    }
    setBusy(true)
    try {
      const saved = editing ? await client.setGroup(checked.group) : await client.createGroup(checked.group)
      setNote({ kind: 'ok', text: t('admin.groupSaved', { number: saved.number }) })
      reset()
      load()
    } catch (err) {
      const refusal = groupRefusal(err)
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(GROUP_FIELDS, next, 'group')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (g: RingGroup) => {
    setNote(null)
    setProblems({})
    setEditing(g.number)
    setForm({ number: g.number, name: g.name, members: g.members.join(', ') })
    setTimeout(() => document.getElementById('group-name')?.focus(), 0)
  }

  const remove = async (g: RingGroup) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteGroup(g.number)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.groupDeleted', { number: g.number }), focus: true })
      if (editing === g.number) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
    }
  }

  if (unavailable)
    return (
      <Section id="groups" title={t('admin.groups')}>
        <p className="alert">{t('admin.groupsUnavailable')}</p>
      </Section>
    )
  const count = Object.keys(problems).length
  return (
    <>
      <Section id="groups" title={t('admin.groups')}>
        <p>{t('admin.groupsHelp')}</p>
        {groups === null ? null : groups.length ? (
          <ul className="list admin-list" aria-label={t('admin.groupsList')}>
            {groups.map(g => (
              <li key={g.number}>
                <span>
                  <strong>{g.number}</strong> {g.name} :{' '}
                  {g.members.length ? g.members.map(m => `${m}${g.vacant?.includes(m) ? ` ${t('admin.groupMemberVacant')}` : ''}`).join(', ') : t('admin.groupNoMembers')}
                </span>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => edit(g)} disabled={busy} aria-label={t('admin.groupEdit', { number: g.number })}>
                    {t('admin.groupEditShort')}
                  </button>
                  <ConfirmDelete label={t('admin.groupDelete', { number: g.number })} question={t('admin.groupDeleteConfirm', { number: g.number })} onConfirm={() => void remove(g)} disabled={busy} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('admin.groupsNone')}</p>
        )}
      </Section>
      <Section id="group-form" title={editing ? t('admin.groupEdit', { number: editing }) : t('admin.groupNew')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="group-form">
          <ProblemSummary count={count} />
          <TextField id="group-number" label={t('admin.groupNumber')} inputMode="numeric" value={editing ?? form.number} onChange={set('number')} error={say(problems.number)} required disabled={busy || editing !== null} maxLength={6} />
          <TextField id="group-name" label={t('admin.groupName')} value={form.name} onChange={set('name')} error={say(problems.name)} required disabled={busy} maxLength={64} />
          <TextField id="group-members" label={t('admin.groupMembers')} hint={t('admin.groupMembersHint')} value={form.members} onChange={set('members')} error={say(problems.members)} required disabled={busy} />
          <div className="actions actions-start">
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {t('admin.groupSave')}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={reset} disabled={busy}>
                {t('admin.groupCancel')}
              </button>
            ) : null}
          </div>
        </form>
        <NoteLine note={note} />
      </Section>
    </>
  )
}
