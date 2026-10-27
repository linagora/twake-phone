import { Alert, Button, FormControl, FormControlLabel, FormLabel, List, ListItem, Radio, RadioGroup, Stack, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { DidRange, Trunk } from '@twake/telephony-client'
import { TargetList } from '../../admin/TargetList.js'
import { targetLabel, useTargets } from '../../admin/targets.js'
import { ConfirmDelete, NoteLine, ProblemSummary, Section, SelectField, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { DID_FIELDS, checkDid, didForm, didRefusal, emptyDid, refusalStatus, type DidField, type DidForm, type Problems } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The direct numbers (step 7, FR-D2): one number or a range of them, the trunk they come in by, and where their calls
 * ring (an extension or a group, or the extension the last digits name), with a fallback of their own if wanted.
 */
export const Numbers = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const targets = useTargets(client)
  const [dids, setDids] = useState<DidRange[] | null>(null)
  const [trunks, setTrunks] = useState<Trunk[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<DidForm>(() => emptyDid())
  const [editing, setEditing] = useState<DidRange | null>(null)
  const [problems, setProblems] = useState<Problems<DidField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)

  const load = useCallback(() => {
    Promise.all([client.listDids(), client.listTrunks()]).then(
      ([d, tr]) => {
        setDids(d.items)
        setTrunks(tr.items)
        // A new range comes in by the first trunk, unless another one is chosen.
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
    <K extends keyof DidForm>(key: K) =>
    (value: DidForm[K]) =>
      setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptyDid(trunks[0]?.id ?? ''))
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkDid(form, {
      isNew: !editing,
      trunks,
      others: dids ?? []
    })
    setProblems(checked.problems)
    if (!checked.range) {
      focusLater(DID_FIELDS, checked.problems, 'did')
      return
    }
    setBusy(true)
    try {
      const saved = await client.setDid(checked.range)
      setNote({ kind: 'ok', text: t('admin.did.saved', { id: saved.id }) })
      reset()
      load()
    } catch (err) {
      const refusal = didRefusal(err)
      // Gone meanwhile (another administrator removed it): the list shown is read again.
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(DID_FIELDS, next, 'did')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (range: DidRange) => {
    setNote(null)
    setProblems({})
    setEditing(range)
    setForm(didForm(range))
    setTimeout(() => document.getElementById('did-trunkId')?.focus(), 0)
  }

  const remove = async (range: DidRange) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteDid(range.id)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({
        kind: 'ok',
        text: t('admin.did.deleted', { id: range.id }),
        focus: true
      })
      if (editing?.id === range.id) reset()
    } catch (err) {
      setNote({
        kind: 'error',
        text: say(didRefusal(err).problem)!,
        focus: true
      })
    } finally {
      setBusy(false)
      load()
    }
  }

  if (unavailable)
    return (
      <Section id="numbers" title={t('admin.nav.numbers')}>
        <Alert severity="info" role="status">{t('admin.trunk.unavailable')}</Alert>
      </Section>
    )

  const field = (key: DidField) => say(problems[key])
  const count = Object.keys(problems).length
  const numbers = (r: DidRange) => (r.first === r.last ? r.first : t('admin.did.range', { first: r.first, last: r.last }))
  const trunkName = (id: string) => {
    const trunk = trunks.find(x => x.id === id)
    return trunk?.name ? `${trunk.name} (${id})` : id
  }
  return (
    <>
      <Section id="numbers" title={t('admin.nav.numbers')}>
        <Typography component="p" gutterBottom>
          {t('admin.did.help')}
        </Typography>
        {dids === null ? null : dids.length ? (
          <List aria-label={t('admin.did.list')}>
            {dids.map(range => (
              <ListItem key={range.id} divider>
                <div className="u-flex-grow-1">
                  <Typography variant="h6" component="h3">
                    {numbers(range)}
                  </Typography>
                  <Typography component="dl" className="u-m-0">
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.did.id')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {range.id}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.did.trunkId')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {trunkName(range.trunkId)}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} useFlexGap>
                      <Typography component="dt" color="textSecondary">
                        {t('admin.did.rings')}
                      </Typography>
                      <Typography component="dd" className="u-m-0">
                        {range.suffixDigits
                          ? t('admin.did.ringsSuffix', {
                              digits: range.suffixDigits
                            })
                          : targetLabel(targets, range.target ?? '')}
                      </Typography>
                    </Stack>
                    {range.fallbackTarget ? (
                      <Stack direction="row" spacing={1} useFlexGap>
                        <Typography component="dt" color="textSecondary">
                          {t('admin.did.fallbackTarget')}
                        </Typography>
                        <Typography component="dd" className="u-m-0">
                          {targetLabel(targets, range.fallbackTarget)}
                        </Typography>
                      </Stack>
                    ) : null}
                  </Typography>
                </div>
                <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
                  <Button variant="outlined" onClick={() => edit(range)} disabled={busy} aria-label={t('admin.did.edit', { id: range.id })}>
                    {t('admin.edit')}
                  </Button>
                  <ConfirmDelete label={t('admin.did.delete', { id: range.id })} question={t('admin.did.deleteConfirm', { id: range.id })} onConfirm={() => void remove(range)} disabled={busy} />
                </Stack>
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography component="p" variant="body2" color="textSecondary">
            {t('admin.did.none')}
          </Typography>
        )}
      </Section>
      <Section id="did-form" title={editing ? t('admin.did.edit', { id: editing.id }) : t('admin.did.new')}>
        {dids !== null && !trunks.length ? (
          <Alert severity="info" role="status">{t('admin.did.noTrunk')}</Alert>
        ) : (
          <form onSubmit={e => void save(e)} noValidate aria-labelledby="did-form">
            <ProblemSummary count={count} />
            <TextField id="did-id" label={t('admin.did.id')} hint={t('admin.slugHint')} value={form.id} onChange={set('id')} error={field('id')} required disabled={busy || !!editing} maxLength={32} />
            <SelectField
              id="did-trunkId"
              label={t('admin.did.trunkId')}
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
              id="did-first"
              label={t('admin.did.first')}
              hint={t('admin.did.firstHint')}
              type="tel"
              inputMode="tel"
              value={form.first}
              onChange={set('first')}
              error={field('first')}
              required
              disabled={busy}
              maxLength={24}
            />
            <TextField
              id="did-last"
              label={t('admin.did.last')}
              hint={t('admin.did.lastHint')}
              type="tel"
              inputMode="tel"
              value={form.last}
              onChange={set('last')}
              error={field('last')}
              disabled={busy}
              maxLength={24}
            />
            <FormControl component="fieldset" className="u-mb-1">
              <FormLabel component="legend">{t('admin.did.rings')}</FormLabel>
              <RadioGroup row name="did-mode" value={form.mode} onChange={(_, v) => set('mode')(v as DidForm['mode'])}>
                {(['target', 'suffix'] as const).map(m => (
                  <FormControlLabel key={m} value={m} control={<Radio disabled={busy} />} label={t(m === 'target' ? 'admin.did.modeTarget' : 'admin.did.modeSuffix')} />
                ))}
              </RadioGroup>
            </FormControl>
            {form.mode === 'target' ? (
              <TextField
                id="did-target"
                label={t('admin.did.target')}
                hint={t('admin.did.targetHint')}
                inputMode="numeric"
                value={form.target}
                onChange={set('target')}
                error={field('target')}
                required
                disabled={busy}
                maxLength={6}
                list="did-targets"
              />
            ) : (
              <TextField
                id="did-suffixDigits"
                label={t('admin.did.suffixDigits')}
                hint={t('admin.did.suffixDigitsHint')}
                inputMode="numeric"
                value={form.suffixDigits}
                onChange={set('suffixDigits')}
                error={field('suffixDigits')}
                required
                disabled={busy}
                maxLength={1}
              />
            )}
            <TextField
              id="did-fallbackTarget"
              label={t('admin.did.fallbackTarget')}
              hint={t('admin.did.fallbackTargetHint')}
              inputMode="numeric"
              value={form.fallbackTarget}
              onChange={set('fallbackTarget')}
              error={field('fallbackTarget')}
              disabled={busy}
              maxLength={6}
              list="did-targets"
            />
            <TargetList id="did-targets" targets={targets} />
            <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
              <Button type="submit" disabled={busy} aria-busy={busy}>
                {t('admin.did.save')}
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
