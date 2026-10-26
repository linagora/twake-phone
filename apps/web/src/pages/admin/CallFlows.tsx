import { Alert, Button, List, ListItem, ListItemText, Stack, Typography } from '@linagora/twake-mui'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { CallFlow } from '@twake/telephony-client'
import { ConfirmDelete, NoteLine, ProblemSummary, SelectField, Section, TextField, useFocusLater, useProblem, type Note } from '../../admin/ui.js'
import { FLOW_FIELDS, FLOW_KINDS, checkFlow, emptyFlow, flowRefusal, refusalStatus, type FlowField, type FlowForm, type Problems } from '../../admin/validate.js'
import { useGateway } from '../../gateway.js'
import type { Key } from '../../i18n/index.js'
import { useT } from '../../i18n/useT.js'

const statusOf = (err: unknown) => (err as { status?: unknown } | null)?.status

/**
 * The organisation's call flows (step 11c-2, ADR 0028): sequential groups, queues and voice menus (SVI), each with a
 * number of its own. Administrators only; checked here as the Gateway checks it (each problem next to its field, the
 * focus on the first one); the Gateway checks every field again and says whether the number is free. A flow the telephony
 * platform does not run yet says so, a deletion is confirmed first, and a member nobody holds now is shown as vacant.
 */
export const CallFlows = () => {
  const { t } = useT()
  const say = useProblem()
  const focusLater = useFocusLater()
  const { client } = useGateway()
  const [flows, setFlows] = useState<CallFlow[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [form, setForm] = useState<FlowForm>(emptyFlow)
  // The number of the flow being changed: its number is then not editable (another number is another flow).
  const [editing, setEditing] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problems<FlowField>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)

  const load = useCallback(() => {
    client
      .listFlows()
      .then(r => setFlows(r.items))
      .catch((err: unknown) => {
        // 501: the platform has none; 404: the organisation has no telephony platform at all.
        if (statusOf(err) === 501 || statusOf(err) === 404) setUnavailable(true)
        else setNote({ kind: 'error', text: t('admin.flowsLoadError') })
      })
  }, [client, t])
  useEffect(load, [load])

  const set = (key: keyof FlowForm) => (value: string) => setForm(f => ({ ...f, [key]: value }))
  const reset = () => {
    setEditing(null)
    setForm(emptyFlow())
    setProblems({})
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setNote(null)
    const checked = checkFlow(editing ? { ...form, number: editing } : form)
    setProblems(checked.problems)
    if (!checked.flow) {
      focusLater(FLOW_FIELDS, checked.problems, 'flow')
      return
    }
    setBusy(true)
    try {
      const saved = editing ? await client.setFlow(checked.flow) : await client.createFlow(checked.flow)
      setNote({ kind: 'ok', text: t('admin.flowSaved', { number: saved.number }) })
      reset()
      load()
    } catch (err) {
      const refusal = flowRefusal(err)
      // Gone meanwhile (another administrator removed it): the list shown is read again.
      if (refusalStatus(err) === 404) load()
      if (refusal.field === 'form') setNote({ kind: 'error', text: say(refusal.problem)! })
      else {
        const next = { [refusal.field]: refusal.problem }
        setProblems(next)
        focusLater(FLOW_FIELDS, next, 'flow')
      }
    } finally {
      setBusy(false)
    }
  }

  const edit = (f: CallFlow) => {
    setNote(null)
    setProblems({})
    setEditing(f.number)
    setForm({
      kind: f.kind,
      number: f.number,
      name: f.name,
      members: (f.members ?? []).join(', '),
      ringSec: f.ringSec !== undefined ? String(f.ringSec) : '',
      waitSec: f.waitSec !== undefined ? String(f.waitSec) : '',
      choices: Object.entries(f.choices ?? {}).map(([k, v]) => `${k}=${v}`).join(', '),
      greeting: f.greeting ?? ''
    })
    setTimeout(() => document.getElementById('flow-name')?.focus(), 0)
  }

  const remove = async (f: CallFlow) => {
    setNote(null)
    setBusy(true)
    try {
      await client.deleteFlow(f.number)
      // The row goes, its buttons with it: the focus goes to what is said.
      setNote({ kind: 'ok', text: t('admin.flowDeleted', { number: f.number }), focus: true })
      if (editing === f.number) reset()
    } catch (err) {
      setNote({ kind: 'error', text: say(flowRefusal(err).problem)!, focus: true })
    } finally {
      setBusy(false)
      load()
    }
  }

  const summary = (f: CallFlow) => {
    if (f.kind === 'menu') return t('admin.flowSummary.menu', { choices: Object.entries(f.choices ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') })
    const members = (f.members ?? []).map(m => `${m}${f.vacant?.includes(m) ? ` ${t('admin.groupMemberVacant')}` : ''}`).join(', ')
    return f.kind === 'queue' ? t('admin.flowSummary.queue', { members, sec: f.ringSec ?? '', wait: f.waitSec ?? '' }) : t('admin.flowSummary.group', { members, sec: f.ringSec ?? '' })
  }

  if (unavailable)
    return (
      <Section id="flows" title={t('admin.flows')}>
        <Alert severity="info">{t('admin.flowsUnavailable')}</Alert>
      </Section>
    )
  const count = Object.keys(problems).length
  const kind = form.kind
  return (
    <>
      <Section id="flows" title={t('admin.flows')}>
        <Typography component="p" gutterBottom>
          {t('admin.flowsHelp')}
        </Typography>
        {flows === null ? null : flows.length ? (
          <List aria-label={t('admin.flowsList')}>
            {flows.map(f => (
              <ListItem key={f.number} divider>
                <ListItemText
                  primary={
                    <>
                      <strong>{f.number}</strong> {f.name} ({t(`admin.flowKind.${f.kind}` as Key)}) : {summary(f)}
                      {f.ready === undefined ? '' : ` — ${f.ready ? t('admin.flowReady') : t('admin.flowPending')}`}
                    </>
                  }
                />
                <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
                  <Button variant="outlined" onClick={() => edit(f)} disabled={busy} aria-label={t('admin.flowEdit', { number: f.number })}>
                    {t('admin.flowEditShort')}
                  </Button>
                  <ConfirmDelete label={t('admin.flowDelete', { number: f.number })} question={t('admin.flowDeleteConfirm', { number: f.number })} onConfirm={() => void remove(f)} disabled={busy} />
                </Stack>
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography component="p" variant="body2" color="textSecondary">
            {t('admin.flowsNone')}
          </Typography>
        )}
      </Section>
      <Section id="flow-form" title={editing ? t('admin.flowEdit', { number: editing }) : t('admin.flowNew')}>
        <form onSubmit={e => void save(e)} noValidate aria-labelledby="flow-form">
          <ProblemSummary count={count} />
          <SelectField id="flow-kind" label={t('admin.flowKind')} value={form.kind} onChange={set('kind')} options={FLOW_KINDS.map(k => ({ value: k, label: t(`admin.flowKind.${k}` as Key) }))} error={say(problems.kind)} disabled={busy} />
          <TextField id="flow-number" label={t('admin.flowNumber')} inputMode="numeric" value={editing ?? form.number} onChange={set('number')} error={say(problems.number)} required disabled={busy || editing !== null} maxLength={6} />
          <TextField id="flow-name" label={t('admin.flowName')} value={form.name} onChange={set('name')} error={say(problems.name)} required disabled={busy} maxLength={64} />
          {kind === 'menu' ? (
            <>
              <TextField id="flow-choices" label={t('admin.flowChoices')} hint={t('admin.flowChoicesHint')} value={form.choices} onChange={set('choices')} error={say(problems.choices)} required disabled={busy} />
              <TextField id="flow-greeting" label={t('admin.flowGreeting')} hint={t('admin.flowGreetingHint')} value={form.greeting} onChange={set('greeting')} error={say(problems.greeting)} disabled={busy} maxLength={64} />
            </>
          ) : (
            <>
              <TextField id="flow-members" label={t('admin.flowMembers')} hint={t('admin.flowMembersHint')} value={form.members} onChange={set('members')} error={say(problems.members)} required disabled={busy} />
              <TextField id="flow-ringSec" label={t('admin.flowRingSec')} hint={t('admin.flowRingSecHint')} inputMode="numeric" value={form.ringSec} onChange={set('ringSec')} error={say(problems.ringSec)} disabled={busy} maxLength={3} />
              {kind === 'queue' ? <TextField id="flow-waitSec" label={t('admin.flowWaitSec')} hint={t('admin.flowWaitSecHint')} inputMode="numeric" value={form.waitSec} onChange={set('waitSec')} error={say(problems.waitSec)} disabled={busy} maxLength={3} /> : null}
            </>
          )}
          <Stack direction="row" spacing={1} useFlexGap className="u-flex-wrap">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {t('admin.flowSave')}
            </Button>
            {editing ? (
              <Button variant="outlined" onClick={reset} disabled={busy}>
                {t('admin.flowCancel')}
              </Button>
            ) : null}
          </Stack>
        </form>
        <NoteLine note={note} />
      </Section>
    </>
  )
}
