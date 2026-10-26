import { Alert, Button, List, ListItem, NativeSelect, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { OUTBOUND_CAPS, TRUNK_OUTBOUND_CLASSES, type AdminUser, type OutboundProfile, type OutboundSettings } from '@twake/telephony-client'
import { CapFields } from '../../admin/CapFields.js'
import { CheckGroup, ConfirmDelete, NoteLine, useLatest, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { PROFILE_FIELDS, checkProfile, emptyProfile, profileForm, profileRefusal, refusalCode, refusalOf, sameValue, type ProfileField, type ProfileForm, type Problems } from '../../admin/validate.js'
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
  const words = useLatest(t)
  const [settings, setSettings] = useState<OutboundSettings | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<ProfileForm>(emptyProfile)
  const [editing, setEditing] = useState<OutboundProfile | null>(null)
  // Something typed in the profile form since it was opened (said if it goes).
  const [dirty, setDirty] = useState(false)
  const [problems, setProblems] = useState<Problems<ProfileField>>({})
  const [defaultProfile, setDefaultProfile] = useState(NONE)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [peopleNote, setPeopleNote] = useState<Note>(null)

  /**
   * Shows a setting the Gateway gave (read, written, read again after a refusal): the default profile and everyone's
   * profile as it says, and the profile being changed too when it is no longer the one the form was opened on (said
   * when something typed goes). Nothing typed is ever sent with the version of a setting it was not made on (review 7
   * ter, n°1). `deleting`: the profile this page is deleting itself.
   */
  const show = (s: OutboundSettings, deleting?: string) => {
    setSettings(s)
    setDefaultProfile(s.policy.defaultProfile ?? NONE)
    setChosen(Object.fromEntries(s.assignments.map(a => [a.userId, a.profileId])))
    if (!editing) return
    const now = s.profiles.find(x => x.id === editing.id)
    if (now && sameValue(now, editing)) return
    setProblems({})
    setDirty(false)
    if (!now) {
      setEditing(null)
      setForm(emptyProfile())
      // Deleted by another administrator: said, never "saved" (review 7 ter, n°6).
      if (editing.id !== deleting)
        setNote({
          kind: 'error',
          text: t('admin.rights.editedGone', { id: editing.id })
        })
      return
    }
    setEditing(now)
    setForm(profileForm(now))
    if (dirty)
      setNote({
        kind: 'error',
        text: t('admin.rights.editReread', { id: now.id })
      })
  }
  const latestShow = useLatest(show)
  const load = useCallback(() => {
    client.getOutbound().then(
      s => latestShow.current(s),
      (err: unknown) => {
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: words.current('admin.loadError') })
      }
    )
    client.listAdminUsers().then(
      r => setUsers(r.items),
      () => setUsers([])
    )
  }, [client, latestShow, words])
  useEffect(load, [load])

  const reset = () => {
    setEditing(null)
    setForm(emptyProfile())
    setProblems({})
    setDirty(false)
  }
  /** What is typed in the profile form: it goes with the profile the form was opened on, or is lost with it. */
  const change = (next: (f: ProfileForm) => ProfileForm) => {
    setDirty(true)
    setForm(next)
  }

  /**
   * Sends the whole setting with `change` made to it, with the version read: refused (OUTBOUND_STALE) when another
   * administrator changed it since, never undoing what they did (review 7 n°1).
   */
  const send = async (change: (s: OutboundSettings) => Pick<OutboundSettings, 'policy' | 'profiles' | 'assignments'>, deleting?: string) => {
    const { policy, profiles, assignments } = change(settings!)
    const next = await client.setOutbound({
      policy,
      profiles,
      assignments,
      version: settings!.version
    })
    show(next, deleting)
    return next
  }
  /** After a refusal for a setting changed meanwhile: read again what it is now (the page says so). */
  const stale = (err: unknown) => {
    if (refusalCode(err) === 'OUTBOUND_STALE') load()
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    if (!settings) return
    if (editing && !settings.profiles.some(x => x.id === editing.id)) {
      reset()
      setNote({
        kind: 'error',
        text: t('admin.rights.editedGone', { id: editing.id })
      })
      return
    }
    const checked = checkProfile(form, {
      isNew: !editing,
      ids: settings.profiles.map(x => x.id)
    })
    setProblems(checked.problems)
    if (!checked.profile) {
      // One profile too many is no field's problem: said for the form.
      if (checked.problems.form) setNote({ kind: 'error', text: say(checked.problems.form)! })
      focusLater(PROFILE_FIELDS, checked.problems, 'profile')
      return
    }
    const profile = checked.profile
    setBusy(true)
    try {
      await send(s => ({
        ...s,
        profiles: editing ? s.profiles.map(x => (x.id === profile.id ? profile : x)) : [...s.profiles, profile]
      }))
      setNote({
        kind: 'ok',
        text: t('admin.rights.saved', { id: profile.id })
      })
      reset()
    } catch (err) {
      stale(err)
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
    setDirty(false)
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
        return {
          policy: def === profile.id ? policy : s.policy,
          profiles: s.profiles.filter(x => x.id !== profile.id),
          assignments: s.assignments.filter(a => a.profileId !== profile.id)
        }
      }, profile.id)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({
        kind: 'ok',
        text: t('admin.rights.deleted', { id: profile.id }),
        focus: true
      })
    } catch (err) {
      stale(err)
      setNote({
        kind: 'error',
        text: say(refusalOf(err, () => undefined).problem)!,
        focus: true
      })
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
        return {
          ...s,
          policy: defaultProfile ? { ...policy, defaultProfile } : policy
        }
      })
      setNote({ kind: 'ok', text: t('admin.rights.defaultSaved') })
    } catch (err) {
      stale(err)
      setNote({
        kind: 'error',
        text: say(refusalOf(err, () => undefined).problem)!
      })
    } finally {
      setBusy(false)
    }
  }

  // One person's profile, from the version shown: refused when the setting changed since, this person's included
  // (review 7 ter, n°3); the answer, the whole setting it made, is shown as any other.
  const assign = async (user: AdminUser) => {
    if (!settings) return
    setPeopleNote(null)
    setBusy(true)
    const profileId = chosen[user.userId] || null
    try {
      const { userId: _user, profileId: _profile, ...now } = await client.setUserProfile(user.userId, profileId, settings.version)
      show(now)
      setPeopleNote({
        kind: 'ok',
        text: t('admin.rights.assigned', {
          name: user.displayName ?? user.userId
        })
      })
    } catch (err) {
      stale(err)
      setPeopleNote({
        kind: 'error',
        text: say(refusalOf(err, () => undefined).problem)!
      })
    } finally {
      setBusy(false)
    }
  }

  if (unavailable)
    return (
      <Section id="rights" title={t('admin.nav.rights')}>
        <Alert severity="info" role="status">{t('admin.rights.unavailable')}</Alert>
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
  const profileOptions = settings.profiles.map(pr => ({
    value: pr.id,
    label: profileName(pr)
  }))
  // A person without a profile has the default one; the default one, when none, is what the trunks allow.
  const options = [{ value: NONE, label: t('admin.rights.noProfile') }, ...profileOptions]
  const defaultOptions = [{ value: NONE, label: t('admin.rights.defaultNone') }, ...profileOptions]
  const assigned = (userId: string) => settings.assignments.find(a => a.userId === userId)?.profileId ?? NONE
  const capsText = (pr: OutboundProfile) =>
    OUTBOUND_CAPS.filter(k => pr.caps?.[k] !== undefined)
      .map(k => `${t(`admin.cap.${k}` as Key)} : ${pr.caps![k] === null ? t('admin.cap.none') : pr.caps![k]}`)
      .join(' · ')
  const count = Object.keys(problems).filter(k => k !== 'form').length
  return (
    <>
      <Section id="rights" title={t('admin.nav.rights')}>
        <Typography component="p" gutterBottom>
          {t('admin.rights.help')}
        </Typography>
        {settings.profiles.length ? (
          <List aria-label={t('admin.rights.list')}>
            {settings.profiles.map(pr => (
              <ListItem key={pr.id} divider>
                <div className="u-flex-grow-1">
                  <Typography variant="h6" component="h3">
                    {profileName(pr)}
                    {settings.policy.defaultProfile === pr.id ? (
                      <Typography component="span" variant="body2" color="textSecondary">
                        {' '}
                        · {t('admin.rights.isDefault')}
                      </Typography>
                    ) : null}
                  </Typography>
                  <Typography component="dl" className="u-m-0">
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.rights.allowed')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {pr.allowed.length ? pr.allowed.map(classLabel).join(', ') : t('admin.rights.internalOnly')}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.rights.caps')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {capsText(pr) || t('admin.rights.capsDefault')}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.rights.holders')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {settings.assignments.filter(a => a.profileId === pr.id).length}
                      </Typography>
                    </Stack>
                  </Typography>
                </div>
                <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
                  <Button variant="outlined" onClick={() => edit(pr)} disabled={busy} aria-label={t('admin.rights.edit', { id: pr.id })}>
                    {t('admin.edit')}
                  </Button>
                  <ConfirmDelete label={t('admin.rights.delete', { id: pr.id })} question={t('admin.rights.deleteConfirm', { id: pr.id })} onConfirm={() => void remove(pr)} disabled={busy} />
                </Stack>
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography component="p" variant="body2" color="textSecondary">
            {t('admin.rights.none')}
          </Typography>
        )}
        <form onSubmit={e => void saveDefault(e)}>
          <SelectField
            id="rights-default"
            label={t('admin.rights.default')}
            hint={t('admin.rights.defaultHint')}
            value={defaultProfile}
            onChange={setDefaultProfile}
            options={defaultOptions}
            disabled={busy}
          />
          <Button type="submit" variant="outlined" disabled={busy}>
            {t('admin.rights.defaultSave')}
          </Button>
        </form>
      </Section>
      <Section id="profile-form" title={editing ? t('admin.rights.edit', { id: editing.id }) : t('admin.rights.new')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="profile-form">
          <ProblemSummary count={count} />
          <TextField
            id="profile-id"
            label={t('admin.rights.id')}
            hint={t('admin.slugHint')}
            value={form.id}
            onChange={v => change(f => ({ ...f, id: v }))}
            error={say(problems.id)}
            required
            disabled={busy || !!editing}
            maxLength={32}
          />
          <TextField id="profile-name" label={t('admin.rights.name')} value={form.name} onChange={v => change(f => ({ ...f, name: v }))} error={say(problems.name)} disabled={busy} maxLength={64} />
          <CheckGroup
            id="profile-allowed"
            legend={t('admin.rights.allowed')}
            hint={t('admin.rights.allowedHint')}
            values={TRUNK_OUTBOUND_CLASSES}
            chosen={form.allowed}
            label={classLabel}
            onChange={v => change(f => ({ ...f, allowed: v }))}
            error={say(problems.allowed)}
            disabled={busy}
          />
          <CapFields
            prefix="profile"
            legend={t('admin.rights.caps')}
            hint={t('admin.rights.capsHint')}
            caps={form.caps}
            defaults={settings.defaults.caps.user}
            problems={problems}
            onChange={caps => change(f => ({ ...f, caps }))}
            disabled={busy}
          />
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {t('admin.rights.save')}
            </Button>
            {editing ? (
              <Button variant="outlined" onClick={reset} disabled={busy}>
                {t('admin.cancel')}
              </Button>
            ) : null}
          </Stack>
        </form>
        <NoteLine note={note} />
      </Section>
      <Section id="rights-people" title={t('admin.rights.people')}>
        <Typography component="p" gutterBottom>
          {t('admin.rights.peopleHelp')}
        </Typography>
        {users.length ? (
          <TableContainer role="region" tabIndex={0} aria-label={t('admin.rights.people')}>
            <Table size="small">
              <caption className="u-visuallyhidden">{t('admin.rights.people')}</caption>
              <TableHead>
                <TableRow>
                  <TableCell component="th" scope="col">
                    {t('admin.rights.person')}
                  </TableCell>
                  <TableCell component="th" scope="col">
                    {t('admin.rights.extension')}
                  </TableCell>
                  <TableCell component="th" scope="col">
                    {t('admin.rights.profile')}
                  </TableCell>
                  <TableCell component="th" scope="col">
                    <span className="u-visuallyhidden">{t('admin.rights.apply')}</span>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map(u => {
                  const name = u.displayName ?? u.userId
                  const value = chosen[u.userId] ?? NONE
                  return (
                    <TableRow key={u.userId}>
                      <TableCell component="th" scope="row">
                        {name}
                      </TableCell>
                      <TableCell>{u.extension}</TableCell>
                      <TableCell>
                        <NativeSelect
                          inputProps={{
                            'aria-label': t('admin.rights.profileOf', { name })
                          }}
                          value={value}
                          onChange={e =>
                            setChosen(c => ({
                              ...c,
                              [u.userId]: e.target.value
                            }))
                          }
                          disabled={busy}
                        >
                          {options.map(o => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </NativeSelect>
                      </TableCell>
                      <TableCell>
                        <Button variant="outlined" onClick={() => void assign(u)} disabled={busy || value === assigned(u.userId)} aria-label={t('admin.rights.applyFor', { name })}>
                          {t('admin.rights.apply')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Typography component="p" variant="body2" color="textSecondary">
            {t('admin.rights.nobody')}
          </Typography>
        )}
        <NoteLine note={peopleNote} />
      </Section>
    </>
  )
}
