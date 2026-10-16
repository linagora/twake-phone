import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { OUTBOUND_CAPS, TRUNK_OUTBOUND_CLASSES, type AdminUser, type OutboundProfile, type OutboundSettings } from '@twake/telephony-client'
import { CapFields } from '../../admin/CapFields.js'
import { CheckGroup, ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { PROFILE_FIELDS, checkProfile, emptyProfile, profileForm, profileRefusal, refusalOf, type ProfileField, type ProfileForm, type Problems } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status
const NONE = ''

/**
 * The rights profiles (step 7, FR-D6; FR-H3): what their holders may call on the public network and their caps, the
 * profile of those given none, and who has which. Saved whole (PUT /admin/outbound), one person at a time for the
 * assignments (PUT /admin/outbound/users/:userId).
 */
export const Rights = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const [settings, setSettings] = useState<OutboundSettings | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<ProfileForm>(emptyProfile)
  const [editing, setEditing] = useState<OutboundProfile | null>(null)
  const [problems, setProblems] = useState<Problems<ProfileField>>({})
  const [defaultProfile, setDefaultProfile] = useState(NONE)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [peopleNote, setPeopleNote] = useState<Note>(null)

  const show = useCallback((s: OutboundSettings) => {
    setSettings(s)
    setDefaultProfile(s.policy.defaultProfile ?? NONE)
    setChosen(Object.fromEntries(s.assignments.map(a => [a.userId, a.profileId])))
  }, [])
  const load = useCallback(() => {
    client.getOutbound().then(show, (err: unknown) => {
      if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
      else setNote({ kind: 'error', text: t('admin.loadError') })
    })
    client.listAdminUsers().then(
      r => setUsers(r.items),
      () => setUsers([])
    )
  }, [client, show, t])
  useEffect(load, [load])

  const reset = () => {
    setEditing(null)
    setForm(emptyProfile())
    setProblems({})
  }

  /** Sends the whole setting with `change` made to it. */
  const send = async (change: (s: OutboundSettings) => Pick<OutboundSettings, 'policy' | 'profiles' | 'assignments'>) => {
    const next = await client.setOutbound(change(settings!))
    show(next)
    return next
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    if (!settings) return
    const checked = checkProfile(form, { isNew: !editing, ids: settings.profiles.map(x => x.id) })
    setProblems(checked.problems)
    if (!checked.profile) {
      focusLater(PROFILE_FIELDS, checked.problems, 'profile')
      return
    }
    const profile = checked.profile
    setBusy(true)
    try {
      await send(s => ({ ...s, profiles: editing ? s.profiles.map(x => (x.id === profile.id ? profile : x)) : [...s.profiles, profile] }))
      setNote({ kind: 'ok', text: t('admin.rights.saved', { id: profile.id }) })
      reset()
    } catch (err) {
      const refusal = profileRefusal(err)
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(PROFILE_FIELDS, next, 'profile')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (profile: OutboundProfile) => {
    setNote(null)
    setProblems({})
    setEditing(profile)
    setForm(profileForm(profile))
    setTimeout(() => document.getElementById('profile-name')?.focus(), 0)
  }

  // A profile removed is no one's any more: those who had it get the default one.
  const remove = async (profile: OutboundProfile) => {
    setNote(null)
    setBusy(true)
    try {
      await send(s => {
        const { defaultProfile: def, ...policy } = s.policy
        return { policy: def === profile.id ? policy : s.policy, profiles: s.profiles.filter(x => x.id !== profile.id), assignments: s.assignments.filter(a => a.profileId !== profile.id) }
      })
      setNote({ kind: 'ok', text: t('admin.rights.deleted', { id: profile.id }) })
      if (editing?.id === profile.id) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
    } finally {
      setBusy(false)
    }
  }

  const saveDefault = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    setBusy(true)
    try {
      await send(s => {
        const { defaultProfile: _old, ...policy } = s.policy
        return { ...s, policy: defaultProfile ? { ...policy, defaultProfile } : policy }
      })
      setNote({ kind: 'ok', text: t('admin.rights.defaultSaved') })
    } catch (err) {
      setNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
    } finally {
      setBusy(false)
    }
  }

  const assign = async (user: AdminUser) => {
    setPeopleNote(null)
    setBusy(true)
    const profileId = chosen[user.userId] || null
    try {
      await client.setUserProfile(user.userId, profileId)
      setSettings(s => (s ? { ...s, assignments: [...s.assignments.filter(a => a.userId !== user.userId), ...(profileId ? [{ userId: user.userId, profileId }] : [])] } : s))
      setPeopleNote({ kind: 'ok', text: t('admin.rights.assigned', { name: user.displayName ?? user.userId }) })
    } catch (err) {
      setPeopleNote({ kind: 'error', text: say(refusalOf(err, () => undefined).problem)! })
    } finally {
      setBusy(false)
    }
  }

  if (unavailable)
    return (
      <Section id="rights" title={t('admin.nav.rights')}>
        <p className="alert">{t('admin.rights.unavailable')}</p>
      </Section>
    )
  if (!settings)
    return (
      <Section id="rights" title={t('admin.nav.rights')}>
        <NoteLine note={note ?? { kind: 'ok', text: t('admin.loading') }} />
      </Section>
    )

  const classLabel = (c: string) => t(`admin.class.${c}` as Key)
  const profileName = (pr: OutboundProfile) => (pr.name ? `${pr.name} (${pr.id})` : pr.id)
  const options = [{ value: NONE, label: t('admin.rights.noProfile') }, ...settings.profiles.map(pr => ({ value: pr.id, label: profileName(pr) }))]
  const assigned = (userId: string) => settings.assignments.find(a => a.userId === userId)?.profileId ?? NONE
  const capsText = (pr: OutboundProfile) =>
    OUTBOUND_CAPS.filter(k => pr.caps?.[k] !== undefined)
      .map(k => `${t(`admin.cap.${k}` as Key)} : ${pr.caps![k] === null ? t('admin.cap.none') : pr.caps![k]}`)
      .join(' · ')
  const count = Object.keys(problems).length
  return (
    <>
      <Section id="rights" title={t('admin.nav.rights')}>
        <p>{t('admin.rights.help')}</p>
        {settings.profiles.length ? (
          <ul className="list admin-list" aria-label={t('admin.rights.list')}>
            {settings.profiles.map(pr => (
              <li key={pr.id}>
                <div>
                  <h3>
                    {profileName(pr)}
                    {settings.policy.defaultProfile === pr.id ? <span className="badge"> · {t('admin.rights.isDefault')}</span> : null}
                  </h3>
                  <dl className="facts facts-compact">
                    <div>
                      <dt>{t('admin.rights.allowed')}</dt>
                      <dd>{pr.allowed.length ? pr.allowed.map(classLabel).join(', ') : t('admin.rights.internalOnly')}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.rights.caps')}</dt>
                      <dd>{capsText(pr) || t('admin.rights.capsDefault')}</dd>
                    </div>
                    <div>
                      <dt>{t('admin.rights.holders')}</dt>
                      <dd>{settings.assignments.filter(a => a.profileId === pr.id).length}</dd>
                    </div>
                  </dl>
                </div>
                <div className="actions actions-end">
                  <button type="button" className="btn" onClick={() => edit(pr)} disabled={busy} aria-label={t('admin.rights.edit', { id: pr.id })}>
                    {t('admin.edit')}
                  </button>
                  <ConfirmDelete label={t('admin.rights.delete', { id: pr.id })} question={t('admin.rights.deleteConfirm', { id: pr.id })} onConfirm={() => void remove(pr)} disabled={busy} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('admin.rights.none')}</p>
        )}
        <form onSubmit={e => void saveDefault(e)} className="inline-form">
          <SelectField id="rights-default" label={t('admin.rights.default')} hint={t('admin.rights.defaultHint')} value={defaultProfile} onChange={setDefaultProfile} options={options} disabled={busy} />
          <button type="submit" className="btn" disabled={busy}>
            {t('admin.rights.defaultSave')}
          </button>
        </form>
      </Section>
      <Section id="profile-form" title={editing ? t('admin.rights.edit', { id: editing.id }) : t('admin.rights.new')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="profile-form">
          <ProblemSummary count={count} />
          <TextField id="profile-id" label={t('admin.rights.id')} hint={t('admin.slugHint')} value={form.id} onChange={v => setForm(f => ({ ...f, id: v }))} error={say(problems.id)} required disabled={busy || !!editing} maxLength={32} />
          <TextField id="profile-name" label={t('admin.rights.name')} value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} error={say(problems.name)} disabled={busy} maxLength={64} />
          <CheckGroup id="profile-allowed" legend={t('admin.rights.allowed')} hint={t('admin.rights.allowedHint')} values={TRUNK_OUTBOUND_CLASSES} chosen={form.allowed} label={classLabel} onChange={v => setForm(f => ({ ...f, allowed: v }))} error={say(problems.allowed)} disabled={busy} />
          <CapFields prefix="profile" legend={t('admin.rights.caps')} hint={t('admin.rights.capsHint')} caps={form.caps} defaults={settings.defaults.caps.user} problems={problems} onChange={caps => setForm(f => ({ ...f, caps }))} disabled={busy} />
          <div className="actions actions-start">
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
              {t('admin.rights.save')}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={reset} disabled={busy}>
                {t('admin.cancel')}
              </button>
            ) : null}
          </div>
        </form>
        <NoteLine note={note} />
      </Section>
      <Section id="rights-people" title={t('admin.rights.people')}>
        <p>{t('admin.rights.peopleHelp')}</p>
        {users.length ? (
          <div className="table-scroll" role="region" tabIndex={0} aria-label={t('admin.rights.people')}>
            <table className="admin-table">
              <caption className="sr-only">{t('admin.rights.people')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.rights.person')}</th>
                  <th scope="col">{t('admin.rights.extension')}</th>
                  <th scope="col">{t('admin.rights.profile')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.rights.apply')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const name = u.displayName ?? u.userId
                  const value = chosen[u.userId] ?? NONE
                  return (
                    <tr key={u.userId}>
                      <th scope="row">{name}</th>
                      <td>{u.extension}</td>
                      <td>
                        <select aria-label={t('admin.rights.profileOf', { name })} value={value} onChange={e => setChosen(c => ({ ...c, [u.userId]: e.target.value }))} disabled={busy}>
                          {options.map(o => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button type="button" className="btn" onClick={() => void assign(u)} disabled={busy || value === assigned(u.userId)} aria-label={t('admin.rights.applyFor', { name })}>
                          {t('admin.rights.apply')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{t('admin.rights.nobody')}</p>
        )}
        <NoteLine note={peopleNote} />
      </Section>
    </>
  )
}
