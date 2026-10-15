import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { RingGroup } from '@twake/telephony-client'
import { useGateway } from '../gateway.js'
import { useT } from '../i18n/useT.js'
import { groupRefusalKey, parseMembers } from '../ringGroups.js'

type Note = { kind: 'ok' | 'error'; text: string } | null
interface Form {
  number: string
  name: string
  members: string
}
const EMPTY: Form = { number: '', name: '', members: '' }

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The organisation's simultaneous ring groups (ADR 0014): a number of its own that rings its members at once, the
 * first to answer takes the call. Administrators only; the Gateway decides who, and checks every field again. "New
 * group" never replaces one (409), a deletion is confirmed first, and a member nobody holds now is shown as vacant.
 */
export const RingGroups = () => {
  const { t } = useT()
  const { client } = useGateway()
  const [groups, setGroups] = useState<RingGroup[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<Form>(EMPTY)
  // The number of the group being changed: its number is then not editable (another number is another group).
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  // The group whose deletion waits for a confirmation.
  const [confirming, setConfirming] = useState<string | null>(null)

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

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    setBusy(true)
    try {
      const group = { number: editing ?? form.number.trim(), name: form.name, members: parseMembers(form.members) }
      const saved = editing ? await client.setGroup(group) : await client.createGroup(group)
      setNote({ kind: 'ok', text: t('admin.groupSaved', { number: saved.number }) })
      setForm(EMPTY)
      setEditing(null)
      load()
    } catch (err) {
      setNote({ kind: 'error', text: t(groupRefusalKey(err) ?? 'admin.groupSaveError') })
    } finally {
      setBusy(false)
    }
  }

  const edit = (g: RingGroup) => {
    setNote(null)
    setEditing(g.number)
    setForm({ number: g.number, name: g.name, members: g.members.join(', ') })
  }

  const remove = async (g: RingGroup) => {
    setNote(null)
    setConfirming(null)
    setBusy(true)
    try {
      await client.deleteGroup(g.number)
      setNote({ kind: 'ok', text: t('admin.groupDeleted', { number: g.number }) })
      if (editing === g.number) {
        setEditing(null)
        setForm(EMPTY)
      }
    } catch {
      setNote({ kind: 'error', text: t('admin.groupDeleteError') })
    } finally {
      setBusy(false)
      load()
    }
  }

  if (unavailable) {
    return (
      <section className="card" aria-labelledby="groups">
        <h2 id="groups">{t('admin.groups')}</h2>
        <p className="alert">{t('admin.groupsUnavailable')}</p>
      </section>
    )
  }
  return (
    <section className="card" aria-labelledby="groups">
      <h2 id="groups">{t('admin.groups')}</h2>
      <p>{t('admin.groupsHelp')}</p>
      {groups === null ? null : groups.length ? (
        <ul className="list" aria-label={t('admin.groupsList')}>
          {groups.map(g => (
            <li key={g.number}>
              <span>
                <strong>{g.number}</strong> {g.name} :{' '}
                {g.members.length
                  ? g.members.map(m => `${m}${g.vacant?.includes(m) ? ` ${t('admin.groupMemberVacant')}` : ''}`).join(', ')
                  : t('admin.groupNoMembers')}
              </span>{' '}
              {confirming === g.number ? (
                <span role="group" aria-label={t('admin.groupDeleteConfirm', { number: g.number })}>
                  {t('admin.groupDeleteConfirm', { number: g.number })}{' '}
                  <button type="button" className="btn" onClick={() => void remove(g)} disabled={busy}>
                    {t('admin.groupDeleteYes')}
                  </button>{' '}
                  <button type="button" className="btn" onClick={() => setConfirming(null)} disabled={busy}>
                    {t('admin.groupDeleteNo')}
                  </button>
                </span>
              ) : (
                <>
                  <button type="button" className="btn" onClick={() => edit(g)} disabled={busy} aria-label={t('admin.groupEdit', { number: g.number })}>
                    {t('admin.groupEditShort')}
                  </button>{' '}
                  <button type="button" className="btn" onClick={() => setConfirming(g.number)} disabled={busy} aria-label={t('admin.groupDelete', { number: g.number })}>
                    {t('admin.groupDeleteShort')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('admin.groupsNone')}</p>
      )}
      <form onSubmit={e => void save(e)} aria-label={editing ? t('admin.groupEdit', { number: editing }) : t('admin.groupNew')}>
        <h3>{editing ? t('admin.groupEdit', { number: editing }) : t('admin.groupNew')}</h3>
        <div className="field">
          <label htmlFor="group-number">{t('admin.groupNumber')}</label>
          <input id="group-number" type="text" inputMode="tel" autoComplete="off" maxLength={64} required value={form.number} onChange={set('number')} disabled={busy || editing !== null} />
        </div>
        <div className="field">
          <label htmlFor="group-name">{t('admin.groupName')}</label>
          <input id="group-name" type="text" autoComplete="off" maxLength={64} required value={form.name} onChange={set('name')} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="group-members">{t('admin.groupMembers')}</label>
          <input id="group-members" type="text" autoComplete="off" required value={form.members} onChange={set('members')} disabled={busy} aria-describedby="group-members-hint" />
          <span id="group-members-hint" className="badge">
            {t('admin.groupMembersHint')}
          </span>
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {t('admin.groupSave')}
          </button>
          {editing ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditing(null)
                setForm(EMPTY)
              }}
              disabled={busy}
            >
              {t('admin.groupCancel')}
            </button>
          ) : null}
        </div>
      </form>
      {note?.kind === 'error' ? (
        <p className="alert alert-error" role="alert">
          {note.text}
        </p>
      ) : (
        <p className="badge" role="status">
          {note?.text ?? ''}
        </p>
      )}
    </section>
  )
}
