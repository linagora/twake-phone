import { Alert, Button, List, ListItem, Stack, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AdminUser, EmergencySite, Trunk } from '@twake/telephony-client'
import { CheckGroup, ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { SITE_FIELDS, checkSite, emptySite, refusalStatus, siteForm, siteRefusal, type Problems, type SiteField, type SiteForm } from '../../admin/validate.js'
import { formatNumber } from '../../format.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The sites (step 6c, ADR 0024): where the organisation's people are for the emergency services. A site has an address,
 * a trunk and the number of that trunk its people present when they call an emergency number, and those people (one
 * site each).
 */
export const Sites = () => {
  const { t, lang } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const [sites, setSites] = useState<EmergencySite[] | null>(null)
  const [trunks, setTrunks] = useState<Trunk[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<SiteForm>(() => emptySite())
  const [editing, setEditing] = useState<EmergencySite | null>(null)
  const [problems, setProblems] = useState<Problems<SiteField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(() => {
    Promise.all([client.listSites(), client.listTrunks(), client.listAdminUsers()]).then(
      ([s, tr, u]) => {
        setSites(s.items)
        setTrunks(tr.items)
        setUsers(u.items)
        // A new site is on the first trunk, unless another one is chosen.
        setForm(f => (f.trunkId || !tr.items[0] ? f : { ...f, trunkId: tr.items[0].id }))
      },
      (err: unknown) => {
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.loadError') })
      }
    )
  }, [client, t])
  useEffect(load, [load])

  const set =
    <K extends keyof SiteForm>(key: K) =>
    (value: SiteForm[K]) =>
      setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptySite(trunks[0]?.id ?? ''))
    setSearch('')
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkSite(form, {
      isNew: !editing,
      trunks,
      others: sites ?? []
    })
    setProblems(checked.problems)
    if (!checked.site) {
      focusLater(SITE_FIELDS, checked.problems, 'site')
      return
    }
    setBusy(true)
    try {
      const saved = await client.setSite(checked.site)
      setNote({ kind: 'ok', text: t('admin.site.saved', { id: saved.id }) })
      reset()
      load()
    } catch (err) {
      const refusal = siteRefusal(err)
      // Gone meanwhile (another administrator removed it): the list shown is read again.
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(SITE_FIELDS, next, 'site')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (site: EmergencySite) => {
    setNote(null)
    setProblems({})
    setEditing(site)
    setSearch('')
    // Whoever left the directory is no longer shown, and goes from the site when it is saved.
    setForm({
      ...siteForm(site),
      members: site.members.filter(m => users.some(u => u.userId === m))
    })
    setTimeout(() => document.getElementById('site-name')?.focus(), 0)
  }

  const remove = async (site: EmergencySite) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteSite(site.id)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({
        kind: 'ok',
        text: t('admin.site.deleted', { id: site.id }),
        focus: true
      })
      if (editing?.id === site.id) reset()
    } catch (err) {
      setNote({
        kind: 'error',
        text: say(siteRefusal(err).problem)!,
        focus: true
      })
    } finally {
      setBusy(false)
      load()
    }
  }

  if (unavailable)
    return (
      <Section id="sites" title={t('admin.nav.sites')}>
        <Alert severity="info">{t('admin.trunk.unavailable')}</Alert>
      </Section>
    )

  const field = (key: SiteField) => say(problems[key])
  const count = Object.keys(problems).length
  const trunkName = (id: string) => {
    const trunk = trunks.find(x => x.id === id)
    return trunk?.name ? `${trunk.name} (${id})` : id
  }
  const plural = new Intl.PluralRules(lang)
  const needle = search.trim().toLowerCase()
  const visible = users.filter(u => !needle || `${u.displayName ?? ''} ${u.userId} ${u.extension}`.toLowerCase().includes(needle)).map(u => u.userId)
  const person = (userId: string) => {
    const u = users.find(x => x.userId === userId)
    return u
      ? t('admin.site.person', {
          name: u.displayName ?? u.userId,
          extension: u.extension
        })
      : userId
  }
  return (
    <>
      <Section id="sites" title={t('admin.nav.sites')}>
        <Typography component="p" gutterBottom>
          {t('admin.site.help')}
        </Typography>
        {sites === null ? null : sites.length ? (
          <List aria-label={t('admin.site.list')}>
            {sites.map(site => (
              <ListItem key={site.id} divider>
                <div className="u-flex-grow-1">
                  <Typography variant="h6" component="h3">
                    {site.name}
                  </Typography>
                  <Typography component="dl" className="u-m-0">
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.site.id')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {site.id}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.site.address')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {site.address}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.site.trunkId')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {trunkName(site.trunkId)}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.site.number')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {formatNumber(site.number)}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.site.members')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {t(plural.select(site.members.length) === 'one' ? 'admin.site.membersOne' : 'admin.site.membersMany', { count: site.members.length })}
                      </Typography>
                    </Stack>
                  </Typography>
                </div>
                <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
                  <Button variant="outlined" onClick={() => edit(site)} disabled={busy} aria-label={t('admin.site.edit', { id: site.id })}>
                    {t('admin.edit')}
                  </Button>
                  <ConfirmDelete label={t('admin.site.delete', { id: site.id })} question={t('admin.site.deleteConfirm', { id: site.id })} onConfirm={() => void remove(site)} disabled={busy} />
                </Stack>
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography component="p" variant="body2" color="textSecondary">
            {t('admin.site.none')}
          </Typography>
        )}
      </Section>
      <Section id="site-form" title={editing ? t('admin.site.edit', { id: editing.id }) : t('admin.site.new')}>
        {sites !== null && !trunks.length ? (
          <Alert severity="info">{t('admin.site.noTrunk')}</Alert>
        ) : (
          <form onSubmit={e => void save(e)} noValidate aria-labelledby="site-form">
            <ProblemSummary count={count} />
            <TextField
              id="site-id"
              label={t('admin.site.id')}
              hint={t('admin.slugHint')}
              value={form.id}
              onChange={set('id')}
              error={field('id')}
              required
              disabled={busy || !!editing}
              maxLength={32}
            />
            <TextField id="site-name" label={t('admin.site.name')} value={form.name} onChange={set('name')} error={field('name')} required disabled={busy} maxLength={64} />
            <TextField
              id="site-address"
              label={t('admin.site.address')}
              hint={t('admin.site.addressHint')}
              autoComplete="street-address"
              value={form.address}
              onChange={set('address')}
              error={field('address')}
              required
              disabled={busy}
              maxLength={200}
            />
            <SelectField
              id="site-trunkId"
              label={t('admin.site.trunkId')}
              value={form.trunkId}
              onChange={set('trunkId')}
              options={trunks.map(x => ({
                value: x.id,
                label: trunkName(x.id)
              }))}
              error={field('trunkId')}
              disabled={busy}
            />
            <TextField
              id="site-number"
              label={t('admin.site.number')}
              hint={`${t('admin.site.numberHint')} ${t('admin.site.numberRings')}`}
              type="tel"
              inputMode="tel"
              value={form.number}
              onChange={set('number')}
              error={field('number')}
              required
              disabled={busy}
              maxLength={24}
            />
            {users.length ? (
              <>
                {/* Enter in the search is no save of the form. */}
                <div onKeyDown={e => e.key === 'Enter' && e.preventDefault()}>
                  <TextField id="site-search" label={t('admin.site.search')} value={search} onChange={setSearch} disabled={busy} maxLength={64} />
                </div>
                {visible.length ? (
                  <CheckGroup
                    id="site-members"
                    legend={t('admin.site.members')}
                    hint={t('admin.site.membersHint')}
                    values={visible}
                    chosen={form.members}
                    label={person}
                    // Those the search hides stay as they are.
                    onChange={next => set('members')([...form.members.filter(m => !visible.includes(m)), ...next])}
                    error={field('members')}
                    disabled={busy}
                  />
                ) : (
                  <Typography component="p" variant="body2" color="textSecondary" role="status">
                    {t('admin.site.searchNone')}
                  </Typography>
                )}
              </>
            ) : (
              <Typography component="p" variant="body2" color="textSecondary">
                {t('admin.site.noUsers')}
              </Typography>
            )}
            <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
              <Button type="submit" disabled={busy} aria-busy={busy}>
                {t('admin.site.save')}
              </Button>
              {editing ? (
                <Button variant="outlined" onClick={reset} disabled={busy}>
                  {t('admin.cancel')}
                </Button>
              ) : null}
            </Stack>
          </form>
        )}
        <NoteLine note={note} />
      </Section>
    </>
  )
}
