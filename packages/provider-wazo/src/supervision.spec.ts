import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AmiError, SupervisionError, WazoSupervision } from './index.js'
import { amiAction } from './ami.js'

type Frame = Record<string, string>

/** Asterisk's AMI as it speaks: a banner, a login, an answer to each action (and the events of a list or of an Originate). */
const fakeAmi = (behave: (action: Frame, reply: (...blocks: Frame[]) => void, socket: Socket) => void = () => undefined) => {
  const state = { actions: [] as Frame[], logins: 0, logoffs: 0, refuseLogin: false }
  const sockets = new Set<Socket>()
  const text = (b: Frame) => `${Object.entries(b).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.write('Asterisk Call Manager/10.0.0\r\n')
    let buf = ''
    socket.on('data', d => {
      buf += d.toString()
      for (;;) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const frame: Frame = {}
        for (const line of buf.slice(0, end).split('\r\n')) frame[line.slice(0, line.indexOf(': '))] = line.slice(line.indexOf(': ') + 2)
        buf = buf.slice(end + 4)
        const reply = (...blocks: Frame[]) => blocks.forEach(b => socket.write(text(b)))
        if (frame.Action === 'Login') {
          state.logins++
          if (frame.Secret !== 'ami-secret' || frame.Username !== 'twake' || state.refuseLogin) reply({ Response: 'Error', ActionID: frame.ActionID!, Message: 'Authentication failed' })
          else reply({ Response: 'Success', ActionID: frame.ActionID!, Message: 'Authentication accepted' })
        } else if (frame.Action === 'Logoff') {
          state.logoffs++
          socket.end()
        } else {
          state.actions.push(frame)
          behave(frame, reply, socket)
        }
      }
    })
  })
  return new Promise<{ port: number; state: typeof state; close(): void }>(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        state,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        }
      })
    )
  )
}

const channel = (e: Frame): Frame => ({ Event: 'CoreShowChannel', Channel: 'PJSIP/103-0000000a', ChannelStateDesc: 'Up', CallerIDNum: '0100', CallerIDName: 'Standard', ConnectedLineNum: '103', ConnectedLineName: '<unknown>', Application: 'Echo', Duration: '00:01:05', Uniqueid: '1792479546.12', ...e })
const channelsOf = (channels: Frame[]) => (a: Frame, reply: (...b: Frame[]) => void) => {
  if (a.Action === 'CoreShowChannels') reply({ Response: 'Success', ActionID: a.ActionID!, EventList: 'start', Message: 'Channels will follow' }, ...channels.map(c => ({ ...c, ActionID: a.ActionID! })), { Event: 'CoreShowChannelsComplete', EventList: 'Complete', ListItems: String(channels.length), ActionID: a.ActionID! })
}

const TENANT = 'acme'
const NAME = '3f2b8c0e-4d1a-4b7e-9c55-0a1b2c3d4e5f'
const opened: { close(): void }[] = []
afterEach(() => {
  for (const o of opened.splice(0)) o.close()
})

const supervision = async (behave: Parameters<typeof fakeAmi>[0], extra: { fetch?: typeof fetch } = {}) => {
  const ami = await fakeAmi(behave)
  opened.push(ami)
  const account = { host: '127.0.0.1', port: ami.port, username: 'twake', password: 'ami-secret', timeoutMs: 2000 }
  const sup = new WazoSupervision({ ami: account, originate: account, recordingsUrl: 'http://recordings.test:8670', recordingsToken: 't'.repeat(40), fetch: () => Promise.resolve(new Response(null, { status: 200 })), ...extra })
  return { ami, sup }
}

describe('the AMI client', () => {
  it('logs in, sends the action with its own ActionID and logs off', async () => {
    const ami = await fakeAmi((a, reply) => reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'done' }))
    opened.push(ami)
    const r = await amiAction({ host: '127.0.0.1', port: ami.port, username: 'twake', password: 'ami-secret' }, { Action: 'Ping' })
    expect(r.response.Message).toBe('done')
    expect(ami.state.actions.map(a => a.Action)).toEqual(['Ping'])
    expect(ami.state.actions[0]!.ActionID).toMatch(/^twake-/)
  })

  it('rejects, never crashes the process, on a user name or a password with a line break', async () => {
    const ami = await fakeAmi((a, reply) => reply({ Response: 'Success', ActionID: a.ActionID! }))
    opened.push(ami)
    const cfg = { host: '127.0.0.1', port: ami.port, username: 'twake', password: 'ami-secret' }
    await expect(amiAction({ ...cfg, username: 'twake\r\nAction: Hangup' }, { Action: 'Ping' })).rejects.toBeInstanceOf(AmiError)
    await expect(amiAction({ ...cfg, password: 'a\nb' }, { Action: 'Ping' })).rejects.toBeInstanceOf(AmiError)
    expect(ami.state.logins).toBe(0)
  })

  it('says refused for a login or an action Asterisk refuses, unreachable when nothing listens, and rejects a line break in a header', async () => {
    const ami = await fakeAmi((a, reply) => reply({ Response: 'Error', ActionID: a.ActionID!, Message: 'Permission denied' }))
    opened.push(ami)
    const cfg = { host: '127.0.0.1', port: ami.port, username: 'twake', password: 'ami-secret' }
    await expect(amiAction({ ...cfg, password: 'wrong' }, { Action: 'Ping' })).rejects.toMatchObject({ reason: 'refused' })
    await expect(amiAction(cfg, { Action: 'Ping' })).rejects.toMatchObject({ reason: 'refused', message: 'AMI: Permission denied' })
    await expect(amiAction(cfg, { Action: 'Ping', File: 'a\r\nAction: Hangup' })).rejects.toBeInstanceOf(AmiError)
    ami.close()
    await expect(amiAction({ ...cfg, timeoutMs: 500 }, { Action: 'Ping' })).rejects.toMatchObject({ reason: 'unreachable' })
  })

  it('times out when the action is never answered', async () => {
    const ami = await fakeAmi()
    opened.push(ami)
    await expect(amiAction({ host: '127.0.0.1', port: ami.port, username: 'twake', password: 'ami-secret', timeoutMs: 150 }, { Action: 'Ping' })).rejects.toMatchObject({ reason: 'timeout' })
  })
})

describe('listCalls', () => {
  it('lists the calls on the lines, with their other party and age, and leaves out what is not a line call', async () => {
    const { sup } = await supervision(
      channelsOf([
        channel({}),
        channel({ Channel: 'PJSIP/104-0000000b', Uniqueid: '1792479546.13', ChannelStateDesc: 'Ring', CallerIDNum: '104', ConnectedLineNum: '0102', ConnectedLineName: 'Jean', Duration: '00:00:03', Application: 'Dial' }),
        channel({ Channel: 'PJSIP/opensips-00000001', Uniqueid: '1792479546.14' }),
        channel({ Channel: 'Local/s@wazo-play-beep-00000001;1', Uniqueid: '1792479546.15' }),
        channel({ Channel: 'PJSIP/101-0000000c', Uniqueid: '1792479546.16', Application: 'ChanSpy' }),
        // A supervisor's line still ringing: no application yet, but the number of the supervision.
        channel({ Channel: 'PJSIP/102-0000000e', Uniqueid: '1792479546.17', ChannelStateDesc: 'Ring', CallerIDNum: '0199', CallerIDName: 'Supervision', Application: '' }),
        // A click-to-call still ringing the person's line (ADR 0033): no call yet.
        channel({ Channel: 'PJSIP/106-0000000f', Uniqueid: '1792479546.18', ChannelStateDesc: 'Ring', CallerIDNum: '+33612345678', CallerIDName: 'Twake Phone', Application: '' }),
        channel({ Channel: 'PJSIP/105-0000000d', Uniqueid: 'not-an-id' })
      ])
    )
    const before = Date.now()
    const calls = await sup.listCalls()
    expect(calls.map(c => [c.id, c.extension, c.peer, c.peerName, c.state])).toEqual([
      ['1792479546.12', '103', '0100', 'Standard', 'up'],
      ['1792479546.13', '104', '0102', 'Jean', 'ringing']
    ])
    expect(Date.parse(calls[0]!.startedAt)).toBeLessThanOrEqual(before - 64_000)
  })

  it('says unavailable when the AMI does not answer and refused when the account lacks the right', async () => {
    const down = await supervision(() => undefined)
    down.ami.close()
    await expect(down.sup.listCalls()).rejects.toMatchObject({ code: 'unavailable' })
    const denied = await supervision((a, reply) => reply({ Response: 'Error', ActionID: a.ActionID!, Message: 'Permission denied' }))
    await expect(denied.sup.listCalls()).rejects.toMatchObject({ code: 'refused' })
  })
})

describe('startRecording', () => {
  const answering =
    (originate: Frame | 'never' = { Event: 'OriginateResponse', Response: 'Success', Reason: '4' }, monitor: Frame = { Response: 'Success' }) =>
    (a: Frame, reply: (...b: Frame[]) => void) => {
      if (a.Action === 'CoreShowChannels') return channelsOf([channel({})])(a, reply)
      if (a.Action === 'Originate') {
        reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'Originate successfully queued' })
        if (originate !== 'never') reply({ ...originate, ActionID: a.ActionID! })
        // As Asterisk does: the notice's ChanSpy is on the channel after the Originate was answered.
        if (originate !== 'never' && originate.Response === 'Success') reply({ Event: 'ChanSpyStart', SpyerChannel: 'Local/s@wazo-play-beep-00000001;2', SpyeeChannel: 'PJSIP/103-0000000a', SpyeeUniqueid: a.Data === 'custom/twake-recording-notice' ? ((a.Variable ?? '').split('=')[1] ?? '') : '' })
      } else reply({ ...monitor, ActionID: a.ActionID! })
    }

  it('announces to the channel with the context of Wazo, then records both ways into the folder of Wazo', async () => {
    const { sup, ami } = await supervision(answering())
    await sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })
    const [, notice, record] = ami.state.actions
    expect(notice).toMatchObject({ Action: 'Originate', Channel: 'Local/s@wazo-play-beep', Application: 'Playback', Data: 'custom/twake-recording-notice', Variable: 'WAZO_PLAYBACK_CHANNEL=1792479546.12', Async: 'true' })
    expect(record).toMatchObject({ Action: 'MixMonitor', Channel: '1792479546.12', File: `/var/lib/wazo/sounds/tenants/${TENANT}/monitor/${NAME}.wav` })
  })

  it('records nothing, and touches nothing, when the notice is not a sound of the telephony server', async () => {
    const sounds: string[] = []
    const missing = (async (url: string, init: RequestInit) => {
      sounds.push(`${init.method} ${url} ${new Headers(init.headers).get('authorization')}`)
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    const { sup, ami } = await supervision(answering(), { fetch: missing })
    await expect(sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })).rejects.toMatchObject({ code: 'notice' })
    expect(sounds).toEqual([`HEAD http://recordings.test:8670/sound/custom/twake-recording-notice Bearer ${'t'.repeat(40)}`])
    expect(ami.state.actions).toEqual([])
    const down = await supervision(answering(), { fetch: () => Promise.reject(new Error('ECONNREFUSED')) })
    await expect(down.sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })).rejects.toMatchObject({ code: 'unavailable' })
    expect(down.ami.state.actions).toEqual([])
    const odd = await supervision(answering(), { fetch: () => Promise.resolve(new Response(null, { status: 500 })) })
    await expect(odd.sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('records nothing when the announcement does not go, or when the call is over', async () => {
    const failing = await supervision(answering({ Event: 'OriginateResponse', Response: 'Failure', Reason: '1' }))
    await expect(failing.sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })).rejects.toMatchObject({ code: 'refused' })
    expect(failing.ami.state.actions.map(a => a.Action)).not.toContain('MixMonitor')
    const over = await supervision(channelsOf([]))
    await expect(over.sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })).rejects.toMatchObject({ code: 'gone' })
    expect(over.ami.state.actions.map(a => a.Action)).toEqual(['CoreShowChannels'])
  })

  it('refuses a call id, a tenant folder or a file name that is not one before any action', async () => {
    const { sup, ami } = await supervision(answering())
    await expect(sup.startRecording({ id: '1792479546.12; Action: Hangup' }, { tenant: TENANT, name: NAME })).rejects.toBeInstanceOf(SupervisionError)
    await expect(sup.startRecording({ id: '1792479546.12' }, { tenant: '../etc', name: NAME })).rejects.toBeInstanceOf(SupervisionError)
    await expect(sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: '../../passwd' })).rejects.toBeInstanceOf(SupervisionError)
    expect(ami.state.actions).toEqual([])
  })

  it('waits for the spy of the notice on this call before it records, not for the answer of the Originate alone, and not for another call\'s spy', async () => {
    const order: string[] = []
    const behave = (a: Frame, reply: (...b: Frame[]) => void) => {
      order.push(a.Action!)
      if (a.Action === 'CoreShowChannels') return channelsOf([channel({})])(a, reply)
      if (a.Action === 'Originate') {
        reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'queued' }, { Event: 'OriginateResponse', Response: 'Success', ActionID: a.ActionID!, Reason: '4' })
        // The spy of another call first, then another spy of this call (a supervisor's, not the notice's), then the notice's, a moment later.
        reply({ Event: 'ChanSpyStart', SpyerChannel: 'Local/s@wazo-play-beep-00000009;2', SpyeeUniqueid: '1792479546.99' })
        reply({ Event: 'ChanSpyStart', SpyerChannel: 'PJSIP/101-0000000f', SpyeeUniqueid: a.Variable!.split('=')[1]! })
        setTimeout(() => reply({ Event: 'ChanSpyStart', SpyerChannel: 'Local/s@wazo-play-beep-00000001;2', SpyeeUniqueid: a.Variable!.split('=')[1]! }), 200)
        return
      }
      order.push('record')
      reply({ Response: 'Success', ActionID: a.ActionID! })
    }
    const { sup } = await supervision(behave)
    const started = Date.now()
    await sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(order).toEqual(['CoreShowChannels', 'Originate', 'MixMonitor', 'record'])
  })

  it('rejects an announcement that nobody answers in time', async () => {
    const { sup } = await supervision(answering('never'))
    const started = sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })
    await expect(started).rejects.toBeInstanceOf(SupervisionError)
  }, 30_000)

  it('stops a recording, and a call already gone is no error', async () => {
    const { sup, ami } = await supervision((a, reply) => reply({ Response: 'Error', ActionID: a.ActionID!, Message: 'No such channel' }))
    await expect(sup.stopRecording({ id: '1792479546.12' })).resolves.toBeUndefined()
    expect(ami.state.actions[0]).toMatchObject({ Action: 'StopMixMonitor', Channel: '1792479546.12' })
    await expect(sup.stopRecording({ id: 'nope' })).resolves.toBeUndefined()
    // A refusal that is not "the call is gone" is not "stopped": the call would go on being recorded.
    const denied = await supervision((a, reply) => reply({ Response: 'Error', ActionID: a.ActionID!, Message: 'Permission denied' }))
    await expect(denied.sup.stopRecording({ id: '1792479546.12' })).rejects.toMatchObject({ code: 'refused' })
    const down = await supervision(() => undefined)
    down.ami.close()
    await expect(down.sup.stopRecording({ id: '1792479546.12' })).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('the two accounts', () => {
  it('sends Originate by the account that holds originate and everything else by the one that holds system', async () => {
    const answer = (a: Frame, reply: (...b: Frame[]) => void) => {
      if (a.Action === 'CoreShowChannels') return channelsOf([channel({})])(a, reply)
      if (a.Action === 'Originate') return reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'queued' }, { Event: 'OriginateResponse', Response: 'Success', ActionID: a.ActionID!, Reason: '4' }, { Event: 'ChanSpyStart', SpyerChannel: 'Local/s@wazo-play-beep-00000001;2', SpyeeUniqueid: '1792479546.12' })
      reply({ Response: 'Success', ActionID: a.ActionID! })
    }
    const system = await fakeAmi(answer)
    const originate = await fakeAmi(answer)
    opened.push(system, originate)
    const sup = new WazoSupervision({
      ami: { host: '127.0.0.1', port: system.port, username: 'twake', password: 'ami-secret' },
      originate: { host: '127.0.0.1', port: originate.port, username: 'twake', password: 'ami-secret' },
      recordingsUrl: 'http://x',
      recordingsToken: 't',
      fetch: () => Promise.resolve(new Response(null, { status: 200 }))
    })
    await sup.startRecording({ id: '1792479546.12' }, { tenant: TENANT, name: NAME })
    await sup.spy({ id: '1792479546.12' }, { extension: '101' }, 'listen')
    await sup.stopRecording({ id: '1792479546.12' })
    expect(system.state.actions.map(a => a.Action)).toEqual(['CoreShowChannels', 'MixMonitor', 'CoreShowChannels', 'StopMixMonitor'])
    expect(originate.state.actions.map(a => a.Action)).toEqual(['Originate', 'Originate'])
  })
})

describe('spy', () => {
  const calls = (a: Frame, reply: (...b: Frame[]) => void) => {
    if (a.Action === 'CoreShowChannels') return channelsOf([channel({})])(a, reply)
    reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'queued' }, { Event: 'OriginateResponse', Response: 'Success', ActionID: a.ActionID!, Reason: '4' })
  }

  it.each([
    ['listen', 'uqE'],
    ['whisper', 'uqEw'],
    ['barge', 'uqEB']
  ] as const)('calls the supervisor\'s line and puts them in the call by ChanSpy (%s: %s)', async (mode, options) => {
    const { sup, ami } = await supervision(calls)
    await sup.spy({ id: '1792479546.12' }, { extension: '101' }, mode)
    expect(ami.state.actions[1]).toMatchObject({ Action: 'Originate', Channel: 'PJSIP/101', Application: 'ChanSpy', Data: `1792479546.12,${options}`, CallerID: '"Supervision" <0199>', Async: 'true' })
  })

  it('rejects a supervisor who does not answer, a line that is not one and a call that is over', async () => {
    const unanswered = await supervision((a, reply) => (a.Action === 'CoreShowChannels' ? channelsOf([channel({})])(a, reply) : reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'queued' }, { Event: 'OriginateResponse', Response: 'Failure', ActionID: a.ActionID!, Reason: '3' })))
    await expect(unanswered.sup.spy({ id: '1792479546.12' }, { extension: '101' }, 'listen')).rejects.toMatchObject({ code: 'refused' })
    const { sup, ami } = await supervision(calls)
    await expect(sup.spy({ id: '1792479546.12' }, { extension: '101,Hangup' }, 'listen')).rejects.toBeInstanceOf(SupervisionError)
    await expect(sup.spy({ id: '1792479546.99' }, { extension: '101' }, 'listen')).rejects.toMatchObject({ code: 'gone' })
    expect(ami.state.actions.filter(a => a.Action === 'Originate')).toEqual([])
  })
})

describe('clickToCall', () => {
  it('rings the line with the number it will call, and hands the answered call to that number at our domain (ADR 0033), by the Originate account', async () => {
    const { sup, ami } = await supervision((a, reply) => reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'Originate successfully queued' }))
    await sup.clickToCall({ extension: '103' }, '+33612345678', 'twake.local')
    expect(ami.state.actions).toEqual([
      expect.objectContaining({ Action: 'Originate', Async: 'true', Channel: 'PJSIP/103', Application: 'Transfer', Data: 'PJSIP/sip:+33612345678@twake.local', CallerID: '"Twake Phone" <+33612345678>', Timeout: '30000', Variable: 'TIMEOUT(absolute)=45' })
    ])
  })

  it('refuses a line, a number or a domain that would say more than one (no Asterisk argument, header or URI can be slipped in)', async () => {
    const { sup, ami } = await supervision((a, reply) => reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'queued' }))
    for (const [line, target, domain] of [['103,Hangup', '102', 'twake.local'], ['103', '102,Hangup', 'twake.local'], ['103', 'sip:102', 'twake.local'], ['103', '+3361234567890123456789', 'twake.local'], ['103', '102', 'twake.local;transport=tcp'], ['103', '102', 'twake.local:5060'], ['103', '102', 'evil.test>\r\nX: y']] as const)
      await expect(sup.clickToCall({ extension: line }, target, domain)).rejects.toMatchObject({ code: 'refused' })
    expect(ami.state.actions).toEqual([])
  })

  it('hangs up the line\'s channel once it runs Transfer to the target, not another line\'s nor another target\'s', async () => {
    let polls = 0
    const ami = await fakeAmi((a, reply) => {
      if (a.Action === 'CoreShowChannels') {
        polls++
        const transfer = (e: Frame) => channel({ Application: 'Transfer', ...e })
        const list = polls < 2 ? [] : [transfer({ Channel: 'PJSIP/104-00000001', ApplicationData: 'PJSIP/sip:102@twake.local' }), transfer({ Channel: 'PJSIP/103-00000002', ApplicationData: 'PJSIP/sip:105@twake.local' }), transfer({ Channel: 'PJSIP/103-00000003', ApplicationData: 'PJSIP/sip:102@twake.local' })]
        return channelsOf(list)(a, reply)
      }
      reply({ Response: 'Success', ActionID: a.ActionID!, Message: 'ok' })
    })
    opened.push(ami)
    const account = { host: '127.0.0.1', port: ami.port, username: 'twake', password: 'ami-secret', timeoutMs: 2000 }
    const sup = new WazoSupervision({ ami: account, originate: account, recordingsUrl: 'http://x', recordingsToken: 't', clickToCallPollMs: 10, clickToCallGraceMs: 10, clickToCallWatchMs: 2000 })
    await sup.clickToCall({ extension: '103' }, '102', 'twake.local')
    for (let i = 0; i < 100 && !ami.state.actions.some(a => a.Action === 'Hangup'); i++) await new Promise(r => setTimeout(r, 20))
    expect(ami.state.actions.filter(a => a.Action === 'Hangup')).toEqual([expect.objectContaining({ Channel: 'PJSIP/103-00000003', Cause: '16' })])
  })

  it('says it when Asterisk refuses the call', async () => {
    const { sup } = await supervision((a, reply) => reply({ Response: 'Error', ActionID: a.ActionID!, Message: 'Permission denied' }))
    await expect(sup.clickToCall({ extension: '103' }, '102', 'twake.local')).rejects.toBeInstanceOf(SupervisionError)
  })
})

describe('the recordings server', () => {
  const file = { tenant: TENANT, name: NAME }
  const server = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const seen: { url: string; method: string; auth: string | null }[] = []
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, method: String(init.method), auth: new Headers(init.headers).get('authorization') })
      return handler(url, init)
    }) as typeof fetch
    return { seen, fetcher }
  }

  it('streams the file with the token, says it has none on a 404, and stats it', async () => {
    const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
    const s = server((_, init) => (init.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-length': '8' } }) : new Response(wav, { status: 200, headers: { 'content-length': '8' } })))
    const { sup } = await supervision(() => undefined, { fetch: s.fetcher })
    const audio = await sup.getRecording(file)
    const bytes: number[] = []
    for await (const c of audio!.body) bytes.push(...c)
    expect(bytes).toEqual([...wav])
    expect(audio).toMatchObject({ contentType: 'audio/wav', size: 8 })
    expect(await sup.statRecording(file)).toEqual({ size: 8 })
    expect(s.seen.map(r => [r.method, r.url, r.auth])).toEqual([
      ['GET', `http://recordings.test:8670/${TENANT}/${NAME}`, `Bearer ${'t'.repeat(40)}`],
      ['HEAD', `http://recordings.test:8670/${TENANT}/${NAME}`, `Bearer ${'t'.repeat(40)}`]
    ])
    const none = server(() => new Response('', { status: 404 }))
    const other = await supervision(() => undefined, { fetch: none.fetcher })
    expect(await other.sup.getRecording(file)).toBeUndefined()
    expect(await other.sup.statRecording(file)).toBeUndefined()
    expect(await other.sup.deleteRecording(file)).toBe(false)
  })

  it('deletes the file, and says unavailable when the server fails or does not answer', async () => {
    const ok = server(() => new Response(null, { status: 204 }))
    expect(await (await supervision(() => undefined, { fetch: ok.fetcher })).sup.deleteRecording(file)).toBe(true)
    const failing = await supervision(() => undefined, { fetch: server(() => new Response('', { status: 500 })).fetcher })
    await expect(failing.sup.deleteRecording(file)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(failing.sup.getRecording(file)).rejects.toMatchObject({ code: 'unavailable' })
    const gone = await supervision(() => undefined, { fetch: () => Promise.reject(new Error('ECONNREFUSED')) })
    await expect(gone.sup.statRecording(file)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('cuts a file past its bound, and refuses names that are not a recording', async () => {
    const big = server(() => new Response(new Uint8Array(100), { status: 200 }))
    const { sup } = await supervision(() => undefined, { fetch: big.fetcher })
    const small = new WazoSupervision({ ami: { host: '127.0.0.1', port: 1, username: 'a', password: 'b' }, originate: { host: '127.0.0.1', port: 1, username: 'c', password: 'd' }, recordingsUrl: 'http://x', recordingsToken: 't', maxRecordingBytes: 50, fetch: big.fetcher })
    const audio = await small.getRecording(file)
    await expect((async () => { for await (const _ of audio!.body) void _ })()).rejects.toBeInstanceOf(SupervisionError)
    await expect(sup.getRecording({ tenant: '..', name: NAME })).rejects.toBeInstanceOf(SupervisionError)
    await expect(sup.deleteRecording({ tenant: TENANT, name: 'x/../../y' })).rejects.toBeInstanceOf(SupervisionError)
    expect(big.seen).toHaveLength(1)
  })
})
