// The trunk to the operator as OpenSIPS's script runs it (step 6a, ADR 0016), and the rules of the calls to the public
// network (step 6b, ADR 0017: rights profiles, caps, volume thresholds, fallback number), without a browser: SIP
// phones of this process (sip-phone.mjs, over UDP and over a WebSocket) and simulated operators (sip-trunk.mjs, which
// send 100 Trying first as real ones do) against the SIP stack (docker/docker-compose.sip.yml, or OpenSIPS and
// rtpengine started by hand), with the trunks and the outbound rules written by the OpenSIPS provider (TrunkTables,
// OutboundTables). What each step proves is what the script does with the messages, not the text of the script.
// Fictional numbers only (ARCEP reserves 01 99 00 xx xx and 06 39 98 xx xx for fiction; Ofcom 020 7946 0xxx). Its
// accounts (115, 301 to 303), trunks and outbound rules are removed at the end, the default thresholds put back: the
// e2e of the browsers (sip.e2e.mjs) runs on the same stack afterwards.
//
//   SIP_UDP, SIP_WS      UDP and WS sockets of OpenSIPS (default 127.0.0.1:5060, ws://127.0.0.1:8088)
//   SIP_TRUNK            its trunk socket (default 127.0.0.1:5070); TRUNK_ADVERTISE what it announces there, if anything
//   SIP_DOMAIN           SIP domain and digest realm (default 127.0.0.1)
//   OPENSIPS_DB_URL      its database (default postgres://twake:twake@127.0.0.1:54320/twake)
//   OPENSIPS_MI_URL      its MI (default udp:127.0.0.1:8880)
//   CALL_PING_SEC        its CALL_PING_SEC (default 30): how long the steps on calls whose phone went wait
//   CALL_PING_TIMEOUT_SEC its CALL_PING_TIMEOUT_SEC (default 15): how long a phone may be silent and keep its call
//   TRUNK_MAX_CALL_SEC   its TRUNK_MAX_CALL_SEC (default 14400)
//   RTPENGINE_NG         rtpengine's control socket (default 127.0.0.1:22222): whether a call's media is freed
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import pg from 'pg'
import { SubscriberProvisioner } from '../../../packages/provider-opensips/dist/subscriber.js'
import { sipPhone } from './sip-phone.mjs'
import { plainRtp, startOperator } from './sip-trunk.mjs'

const SIP_UDP = process.env.SIP_UDP ?? '127.0.0.1:5060'
const SIP_WS = process.env.SIP_WS ?? 'ws://127.0.0.1:8088'
const SIP_TRUNK = process.env.SIP_TRUNK ?? '127.0.0.1:5070'
const SIP_DOMAIN = process.env.SIP_DOMAIN ?? '127.0.0.1'
const TRUNK_ADVERTISE = process.env.TRUNK_ADVERTISE ?? ''
const DB_URL = process.env.OPENSIPS_DB_URL ?? 'postgres://twake:twake@127.0.0.1:54320/twake'
const MI_URL = process.env.OPENSIPS_MI_URL ?? 'udp:127.0.0.1:8880'
const PING_SEC = Number(process.env.CALL_PING_SEC ?? 30)
const PING_TIMEOUT_SEC = Number(process.env.CALL_PING_TIMEOUT_SEC ?? 15)
const RTPENGINE_NG = process.env.RTPENGINE_NG ?? '127.0.0.1:22222'
const MAX_CALL_SEC = Number(process.env.TRUNK_MAX_CALL_SEC ?? 14400)
const TENANT = 'trunk-sip'
const LOGIN = '0033199000300'
const PASSWORD = 'not-a-real-password'

const header = (msg, name) => msg?.headers.get(name)?.[0] ?? ''
let failed = 0
const step = async (name, fn) => {
  // What an earlier step left for the operators to do (a call that never reached them) is not this step's.
  for (const op of operators) op.state.next.length = 0
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`)
  }
}
const expect = (what, ok, detail = '') => {
  if (!ok) throw new Error(`${what}${detail ? `: ${detail}` : ''}`)
}
const [miHost, miPort] = MI_URL.replace(/^udp:/, '').split(':')
const mi = (method, params) =>
  new Promise((resolve, reject) => {
    const s = createSocket('udp4')
    const t = setTimeout(() => (s.close(), reject(new Error(`MI ${method}: no answer`))), 3000)
    s.on('message', m => (clearTimeout(t), s.close(), resolve(JSON.parse(m.toString()))))
    s.send(JSON.stringify({ jsonrpc: '2.0', method, id: 1, ...(params ? { params } : {}) }), Number(miPort), miHost)
  })
const reload = async () => {
  for (const m of ['ds_reload', 'reg_reload', 'dp_reload']) await mi(m)
}
// rtpengine's NG protocol (bencode over UDP): `query` of a call, 'ok' while rtpengine holds its media, 'error' once
// freed.
const bencode = v => (typeof v === 'string' ? `${Buffer.byteLength(v)}:${v}` : `d${Object.entries(v).map(([k, x]) => bencode(k) + bencode(x)).join('')}e`)
const rtpQuery = callId =>
  new Promise((resolve, reject) => {
    const [host, port] = RTPENGINE_NG.split(':')
    const s = createSocket('udp4')
    const cookie = randomBytes(4).toString('hex')
    const t = setTimeout(() => (s.close(), reject(new Error('rtpengine: no answer'))), 3000)
    s.on('message', m => {
      const text = m.toString()
      if (!text.startsWith(cookie)) return
      clearTimeout(t)
      s.close()
      resolve(/6:result\d+:(ok|error)/.exec(text)?.[1] ?? text)
    })
    s.send(`${cookie} ${bencode({ command: 'query', 'call-id': callId })}`, Number(port), host)
  })

const prov = new SubscriberProvisioner({ databaseUrl: DB_URL, realm: SIP_DOMAIN })
await prov.ensureSchema()
const secret = ext => `secret-${ext}-${randomBytes(4).toString('hex')}`
const secrets = Object.fromEntries(['115', '301', '302', '303'].map(e => [e, secret(e)]))
// 115 is the account of an extension kept from before step 6a: an emergency number (the SAMU social). Each account's
// holder is the user `u-<ext>`: whom a rights profile is given to (step 6b).
for (const [ext, s] of Object.entries(secrets)) await prov.setSipSecret(ext, s, `u-${ext}`)
const nat = TRUNK_ADVERTISE ? { [TRUNK_ADVERTISE.includes(':') ? TRUNK_ADVERTISE : `${TRUNK_ADVERTISE}:${SIP_TRUNK.split(':')[1]}`]: SIP_TRUNK } : {}
const A = await startOperator({ opensips: SIP_TRUNK, user: LOGIN, password: PASSWORD, nat })
const B = await startOperator({ opensips: SIP_TRUNK, user: LOGIN, password: PASSWORD, nat, challenge: 'www' })
const operators = []
const C = await startOperator({ opensips: SIP_TRUNK, user: 'backup', password: PASSWORD, nat, realm: 'backup.example', domain: 'backup.example' })
// An address the trunk declares for its calls only (`sources`): nothing may ever be sent to it.
const S = await startOperator({ opensips: SIP_TRUNK, user: LOGIN, password: PASSWORD, nat, bind: '127.0.0.3', port: 5060 })
// An address of the operator the trunk does not declare at all (its media gateway, an SBC).
const X = await startOperator({ opensips: SIP_TRUNK, user: LOGIN, password: PASSWORD, nat, bind: '127.0.0.4' })
operators.push(A, B, C)
const tables = prov.trunkTables({ tenantId: TENANT, socket: `udp:${SIP_TRUNK}`, ...(TRUNK_ADVERTISE ? { advertise: TRUNK_ADVERTISE } : {}) })
const main = { id: 'main', auth: 'register', domain: 'operator.example', proxies: [A.address, B.address], sources: ['127.0.0.3'], username: LOGIN, password: PASSWORD, codecs: ['PCMA', 'PCMU'], numberFormat: 'e164', defaultNumber: '+33199000300', allowed: ['fixed', 'mobile', 'freephone', 'standard-rate', 'international'], countries: ['44', '1', '1876'] }
const backup = { id: 'backup', auth: 'ip', domain: 'backup.example', proxies: [C.address], username: 'backup', password: PASSWORD, codecs: ['PCMA'], numberFormat: 'e164', defaultNumber: '+33199000310' }
const dids = [
  { id: 'staff', trunkId: 'main', first: '+33199000300', last: '+33199000302', suffixDigits: 3 },
  { id: 'desk', trunkId: 'backup', first: '+33199000303', last: '+33199000303', target: '303' }
]
const phones = []
const phone = async (ext, { ws = false } = {}) => {
  const p = await sipPhone({ ...(ws ? { ws: SIP_WS } : { proxy: SIP_UDP }), domain: SIP_DOMAIN, user: ext, password: secrets[ext] })
  phones.push(p)
  expect(`registration of ${ext}`, (await p.register()) === 200)
  return p
}
const db = new pg.Client({ connectionString: DB_URL })
await db.connect()
/** The call `phone` placed, as the operator `op` got it (same Call-ID). */
const atOperator = (op, call) => op.until('the call at the operator', () => op.state.invites.find(c => c.callId === call.callId), 10_000)
const busy = op => op.state.next.push({ reply: '486 Busy Here' })
// A phone gone is noticed within CALL_PING_SEC + CALL_PING_TIMEOUT_SEC (and the dialog's timer, every second).
const pingWait = (PING_SEC * 2 + PING_TIMEOUT_SEC + 12) * 1000
/** A silence shorter than CALL_PING_TIMEOUT_SEC, longer than the 5 s that ended a call before. */
const shortSilenceMs = 6_500
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Step 6b. The outbound rules of the tenant; until its steps, volume thresholds that never trip (every one 0, none),
// so that the steps of 6a, which call the operator often, are not refused for it.
const outbound = prov.outboundTables({ tenantId: TENANT })
const FRAUD_PARAMS = ['callsPerMinute', 'dailyCalls', 'concurrentCalls', 'sequentialCalls', 'callSeconds']
const NO_THRESHOLD = Object.fromEntries(FRAUD_PARAMS.map(p => [p, {}]))
const RELAXED = { national: NO_THRESHOLD, international: NO_THRESHOLD }
const setOutbound = async (policy, profiles = [], assignments = []) => {
  const { fraud } = await outbound.set({ fraud: RELAXED, ...policy }, profiles, assignments)
  if (fraud) expect('fraud_reload', (await mi('fraud_reload')).result === 'OK')
}
const PROFILES = [
  { id: 'internal', allowed: [] },
  { id: 'france', allowed: ['fixed', 'mobile', 'freephone'] },
  { id: 'world', allowed: ['fixed', 'mobile', 'freephone', 'standard-rate', 'international'] }
]
const withCaps = caps => PROFILES.map(p => (p.id === 'world' ? { ...p, caps } : p))
// What OpenSIPS raises for the administrators (E_FRD_WARNING, E_FRD_CRITICAL, E_TWAKEPHONE_LIMIT), as the Gateway hears it.
const ALERT_EVENTS = ['E_FRD_WARNING', 'E_FRD_CRITICAL', 'E_TWAKEPHONE_LIMIT']
const alerts = []
const listener = createSocket('udp4')
listener.on('message', m => {
  try {
    alerts.push(JSON.parse(m.toString()))
  } catch {
    // not an event
  }
})
await new Promise(resolve => listener.bind(0, '127.0.0.1', resolve))
const alertAddress = `udp:127.0.0.1:${listener.address().port}`
const untilAlert = async (what, test, timeoutMs = 5_000) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const found = alerts.find(a => test(a.method, a.params ?? {}))
    if (found) return found.params
    if (Date.now() > end) throw new Error(`no ${what}: ${JSON.stringify(alerts.map(a => [a.method, a.params]))}`)
    await sleep(100)
  }
}
/** A call refused for `word` (Twake-Call-Refused), 403. */
const refused = (what, call, word) => expect(what, call.final.status === 403 && header(call.final, 'twake-call-refused') === word, `${call.final.first} ${header(call.final, 'twake-call-refused')}`)
const sentToOperators = () => [A, B, C].reduce((n, op) => n + op.state.attempts.length, 0)
/** Today's CDRs of an extension's calls to the public network (acc.external 'out'), and their seconds. */
const usedToday = async ext => (await db.query("SELECT count(*)::int AS calls, coalesce(sum(duration), 0)::int AS seconds FROM acc WHERE external = 'out' AND caller = $1 AND time >= date_trunc('day', localtimestamp)", [ext])).rows[0]
const until = async (what, fn, timeoutMs) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`no ${what}`)
    await sleep(100)
  }
}
const cdrOf = callId => until('the CDR', async () => (await db.query('SELECT external, duration FROM acc WHERE callid = $1', [callId])).rows[0], 5_000)
/** The calls to the public network in progress (dialog profile trunk_out). */
const outCalls = async () => Number((await mi('profile_get_size', { profile: 'trunk_out' })).result?.Profile?.count ?? 0)

try {
  await setOutbound({})
  for (const e of ALERT_EVENTS) await mi('event_subscribe', [e, alertAddress, 900])
  await tables.set([main, backup], dids)
  await reload()
  await A.registered(1, 30_000)
  const p301 = await phone('301')
  const p302 = await phone('302', { ws: true })
  const p303 = await phone('303')
  const p115 = await phone('115')

  await step('n°1: 115 is an emergency number: dialled, it reaches the operator as dialled, never the account 115 that exists and is registered', async () => {
    busy(A)
    const call = await p301.dial('115')
    const at = await atOperator(A, call)
    expect('Request-URI at the operator', at.invite.uri === 'sip:115@operator.example', at.invite.uri)
    expect('INVITEs to the account 115', ![...p115.calls.values()].some(c => c.invite), `${p115.calls.size}`)
  })

  await step('n°3: the first server sends 100 Trying then 503: the second one is tried and answers', async () => {
    A.state.next.push({ reply: '503 Service Unavailable' })
    const call = await p301.dial('0199000004')
    expect('final answer', call.final.status === 200, call.final.first)
    expect('the call at the second server', B.state.invites.some(c => c.callId === call.callId))
    await p301.hangup(call)
  })

  await step('n°3: the first server rings (180) then answers 503: no second server, the person is not called twice', async () => {
    A.state.next.push({ ringThen: '503 Service Unavailable', afterMs: 300 })
    const attempts = B.state.attempts.length
    const call = await p301.dial('0199000004')
    // A proxy relays no 503 (RFC 3261 16.7): 500.
    expect('final answer', call.final.status === 500, call.final.first)
    expect('calls to the second server', B.state.attempts.length === attempts, `${B.state.attempts.length - attempts}`)
  })

  await step('n°4: what the phone says of identity, billing and routing never reaches the operator; the From is its direct number', async () => {
    busy(A)
    const extra = ['Diversion: <sip:+33199000999@operator.example>;reason=unconditional', 'P-Charge-Info: <sip:+33199000999@operator.example>', 'Privacy: id', 'History-Info: <sip:+33199000999@operator.example>;index=1', 'P-Called-Party-ID: <sip:+33199000999@operator.example>', 'P-Preferred-Service: urn:urn-7:3gpp-service.ims.icsi.mmtel', 'Remote-Party-ID: <sip:+33199000999@operator.example>;party=calling', 'P-Preferred-Identity: <sip:+33199000999@operator.example>', 'Referred-By: <sip:+33199000999@operator.example>', 'X-Billing-Account: 42', 'User-Agent: Desk phone 1.0', 'Call-Info: <http://192.0.2.99/photo.jpg>;purpose=icon', 'Alert-Info: <http://192.0.2.99/ring.wav>', 'Subject: hello', 'Organization: Fiction', 'Geolocation: <cid:x@192.0.2.99>']
    const call = await p301.dial('0199000005', { extra })
    const at = (await atOperator(A, call)).invite
    const leaked = extra.map(h => h.split(':')[0].toLowerCase()).filter(h => at.headers.has(h))
    expect('headers of the phone at the operator', leaked.length === 0, leaked.join(', '))
    expect('From', header(at, 'from').includes('<sip:+33199000301@operator.example>'), header(at, 'from'))
    expect('the offer', at.headers.has('content-type') && plainRtp(at.body), at.body)
    // Review 3, n°8: the phone's Contact without its extension, once.
    expect('one Contact, without the extension', at.headers.get('contact')?.length === 1 && !/sip:301@|\+sip\.instance/.test(header(at, 'contact')) && header(at, 'contact').includes(p301.contactUri.replace('301@', '')), (at.headers.get('contact') ?? []).join(' | '))
  })

  await step('review 3, n°3: to the operator, a request says once what it is (a second From or To, compact forms too: 400) and carries SDP only (multipart with ISUP: 415)', async () => {
    const attempts = A.state.attempts.length + B.state.attempts.length
    const from = await p301.dial('0199000015', { extra: ['From: "+33612345678" <sip:301@127.0.0.1>;tag=second'] })
    expect('a second From', from.final.status === 400, from.final.first)
    const to = await p301.dial('0199000015', { extra: ['t: <sip:+33899999999@127.0.0.1>'] })
    expect('a second To (compact form)', to.final.status === 400, to.final.first)
    const sdp = p301.sdp()
    const isup = Buffer.from([0x01, 0x00, 0x49, 0x00, 0x00, 0x03, 0x02, 0x00, 0x07, 0x04, 0x10, 0x00, 0x33, 0x63, 0x21, 0x43, 0x00]).toString('latin1')
    const body = ['--b1', 'Content-Type: application/sdp', '', sdp, '--b1', 'Content-Type: application/isup;version=itu-t92+', 'Content-Disposition: signal;handling=optional', '', isup, '--b1--', ''].join('\r\n')
    const multipart = await p301.dial('0199000015', { body, type: 'multipart/mixed;boundary=b1' })
    expect('a multipart body', multipart.final.status === 415, multipart.final.first)
    const sos = await p301.dial('112', { extra: ['f: <sip:301@127.0.0.1>;tag=second'] })
    expect('112 with a second From', sos.final.status === 400 && header(sos.final, 'twake-call-refused') === 'emergency', `${sos.final.first} ${header(sos.final, 'twake-call-refused')}`)
    expect('calls the operator was sent', A.state.attempts.length + B.state.attempts.length === attempts, `${A.state.attempts.length + B.state.attempts.length - attempts}`)
  })

  await step('n°6: international numbers go to the countries the trunk lists only (44), never satellites or international premium rate', async () => {
    busy(A)
    const call = await p301.dial('+442079460123')
    expect('Request-URI at the operator', (await atOperator(A, call)).invite.uri === 'sip:+442079460123@operator.example')
    const attempts = A.state.attempts.length + B.state.attempts.length
    for (const [number, refusal] of [
      ['+4900000000', 'international'],
      ['+8700000000000', 'premium'],
      ['+8810000000', 'premium'],
      ['+8820000000', 'premium'],
      ['+8830000000', 'premium'],
      ['+979000000000', 'premium']
    ]) {
      const refused = await p301.dial(number)
      expect(`${number}`, refused.final.status === 403 && header(refused.final, 'twake-call-refused') === refusal, `${refused.final.first} ${header(refused.final, 'twake-call-refused')}`)
    }
    expect('calls the operator was sent', A.state.attempts.length + B.state.attempts.length === attempts)
  })

  await step('review 3, n°4: a country code opens its geographic and mobile numbers, never its premium ranges; the North American plan is listed per area (1: the United States and Canada; 1876: Jamaica)', async () => {
    for (const number of ['+12125550123', '+18765550123']) {
      busy(A)
      const call = await p301.dial(number)
      expect(`${number} at the operator`, (await atOperator(A, call)).invite.uri === `sip:${number}@operator.example`)
    }
    const attempts = A.state.attempts.length + B.state.attempts.length
    for (const [number, refusal] of [
      ['+18095550123', 'international'],
      ['+19005550123', 'premium'],
      ['+12129760123', 'premium'],
      ['+15005550123', 'premium'],
      ['+449098790000', 'premium'],
      ['+447000000000', 'premium'],
      ['+448450000000', 'premium'],
      ['+499000000000', 'premium'],
      ['+491370000000', 'premium']
    ]) {
      const refused = await p301.dial(number)
      expect(`${number}`, refused.final.status === 403 && header(refused.final, 'twake-call-refused') === refusal, `${refused.final.first} ${header(refused.final, 'twake-call-refused')}`)
    }
    expect('calls the operator was sent', A.state.attempts.length + B.state.attempts.length === attempts)
  })

  await step('n°9: a phone that calls without SDP (late offer) gets the operator\'s offer through rtpengine, and its answer reaches the operator in the ACK, plain RTP', async () => {
    const call = await p301.dial('0199000006', { offer: false })
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(A, call)
    const port = Number(/^m=audio (\d+)/m.exec(call.final.body)?.[1])
    expect('offer of rtpengine, not the operator\'s own', port > 0 && port !== at.media.port, call.final.body)
    await A.until('the ACK at the operator', () => at.acks.length > 0, 5_000)
    expect('answer in the ACK, plain RTP', plainRtp(at.acks[0].body), at.acks[0].body)
    await p301.hangup(call)
  })

  await step('n°10: a BYE from an address of the operator the trunk does not declare, in a call under way, ends it; out of a call, it is refused', async () => {
    const call = await p301.dial('0199000007')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(A, call)
    // Review 3, n°5: from that address, only what a media gateway sends in a call (BYE, re-INVITE, ACK, UPDATE,
    // PRACK), and to the phone of the call only, whatever its Request-URI names.
    expect('OPTIONS from that address in the call', (await X.request(at, 'OPTIONS')).status === 403)
    const elsewhere = createSocket('udp4')
    let leaked = 0
    elsewhere.on('message', () => leaked++)
    await new Promise(resolve => elsewhere.bind(5099, '127.0.0.6', resolve))
    try {
      const target = at.remoteTarget
      at.remoteTarget = 'sip:evil@127.0.0.6:5099'
      const reinvite = await X.reinvite(at)
      at.remoteTarget = target
      expect('re-INVITE from that address', reinvite.status === 200, reinvite.first)
      const got = call.reinvites.at(-1)
      expect('at the phone, at its own Contact', got?.uri === p301.contactUri, got?.uri)
      await sleep(500)
      expect('requests sent elsewhere', leaked === 0, `${leaked}`)
    } finally {
      elsewhere.close()
    }
    const bye = await X.request(at, 'BYE')
    expect('answer to the BYE', bye.status === 200, bye.first)
    await p301.callState(call, 'ended', 5_000)
    expect('the BYE at the phone, at its own Contact', call.requests.at(-1)?.uri === p301.contactUri, call.requests.at(-1)?.uri)
    expect('INVITE from that address', (await X.raw('INVITE', '+33199000301')).status === 403)
    expect('BYE in no call from that address', (await X.raw('BYE', '+33199000301', { toTag: 'forged' })).status === 403)
  })

  await step('n°11: the operator\'s caller is hidden under Privacy: user, and under Privacy: id in a second Privacy header', async () => {
    p301.st.answerWith = '486 Busy Here'
    try {
      for (const [headers, hidden] of [[['Privacy: none'], false], [['Privacy: user'], true], [['Privacy: none', 'Privacy: id'], true]]) {
        const placed = await A.call('+33199000301', { from: '+33639980002', headers })
        await placed.final
        const got = await p301.incoming(i => header(i, 'call-id') === placed.callId)
        const from = header(got.invite, 'from')
        expect(`From with ${headers.join(', ')}`, hidden ? /anonymous/.test(from) && !/639980002/.test(from) : /\+33639980002/.test(from), from)
      }
    } finally {
      p301.st.answerWith = '200 OK'
    }
  })

  await step('n°12: the European harmonised numbers (116006) reach the operator as dialled; the directory enquiries (118xxx) are refused as premium', async () => {
    busy(A)
    const call = await p301.dial('116006')
    expect('Request-URI at the operator', (await atOperator(A, call)).invite.uri === 'sip:116006@operator.example')
    const refused = await p301.dial('118000')
    expect('118000', refused.final.status === 403 && header(refused.final, 'twake-call-refused') === 'premium', refused.final.first)
  })

  await step('n°13: a redirection of the operator is not relayed: 480, nothing of its Contact', async () => {
    A.state.next.push({ reply: '302 Moved Temporarily', headers: ['Contact: <sip:+33199000999@192.0.2.99>'] })
    const call = await p301.dial('0199000008')
    expect('final answer', call.final.status === 480, call.final.first)
    expect('the operator\'s Contact', !/192\.0\.2\.99|\+33199000999/.test(call.final.raw), call.final.raw)
  })

  await step('n°7: an emergency call the operator refuses tells the caller to call from another phone (503, emergency)', async () => {
    busy(A)
    const call = await p301.dial('112')
    expect('final answer', call.final.status === 503 && header(call.final, 'twake-call-refused') === 'emergency', `${call.final.first} ${header(call.final, 'twake-call-refused')}`)
  })

  await step('n°5: OpenSIPS asks the phone in a call with the operator whether it is still there (OPTIONS in the dialog); a desk phone that answers keeps its call, without anything else (no app, no Gateway)', async () => {
    const call = await p303.dial('0199000009')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(C, call)
    await p303.until('two OPTIONS in the dialog', () => call.requests.filter(r => r.method === 'OPTIONS').length >= 2, pingWait)
    expect('the call at the operator', at.state === 'answered', at.state)
    await p303.hangup(call)
  })

  await step('n°5: a phone put to sleep in a call (no answer any more): OpenSIPS ends the call, a BYE to the operator; its other window, still there, changes nothing', async () => {
    const other = await phone('301')
    const call = await p301.dial('0199000010')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(A, call)
    expect('the media in rtpengine', (await rtpQuery(call.callId)) === 'ok')
    p301.st.asleep = true
    try {
      await A.callState(at, 'ended', pingWait)
    } finally {
      p301.st.asleep = false
      await other.close()
      phones.splice(phones.indexOf(other), 1)
    }
    // Review 3, n°8: the BYE OpenSIPS sent carries the operator's URIs, as the INVITE did (uac's auto restore),
    // never the extension nor the internal domain.
    const bye = at.requests.find(r => r.method === 'BYE')
    expect('From and To of the BYE OpenSIPS sent', header(bye, 'from').includes('<sip:+33199000301@operator.example>') && header(bye, 'to').includes('<sip:+33199000010@operator.example>'), `${header(bye, 'from')} | ${header(bye, 'to')}`)
    // Review 3, n°7: the BYEs OpenSIPS sent free the media at once.
    await sleep(500)
    expect('the media in rtpengine once ended', (await rtpQuery(call.callId)) === 'error')
  })

  await step(`review 3, n°1: a phone silent for less than CALL_PING_TIMEOUT_SEC (${shortSilenceMs} ms, an OPTIONS waiting) keeps its call with the operator`, async () => {
    const call = await p303.dial('0199000016')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(C, call)
    await p303.until('an OPTIONS in the dialog', () => call.requests.some(r => r.method === 'OPTIONS'), pingWait)
    p303.st.asleep = true
    await sleep(shortSilenceMs)
    p303.st.asleep = false
    const answered = call.requests.filter(r => r.method === 'OPTIONS').length
    await p303.until('another OPTIONS in the dialog', () => call.requests.filter(r => r.method === 'OPTIONS').length > answered, pingWait)
    expect('the call at the operator', at.state === 'answered', at.state)
    await p303.hangup(call)
  })

  await step(`review 3, n°1: an emergency call is never asked whether its phone is there: no OPTIONS, a phone silent ${shortSilenceMs} ms and more keeps it`, async () => {
    const call = await p301.dial('112')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(A, call)
    p301.st.asleep = true
    await sleep(shortSilenceMs)
    p301.st.asleep = false
    await sleep((PING_SEC + PING_TIMEOUT_SEC + 2) * 1000)
    expect('the call at the operator', at.state === 'answered', at.state)
    expect('OPTIONS in the dialog', !p301.st.received.some(r => r.method === 'OPTIONS' && header(r, 'call-id') === call.callId))
    await p301.hangup(call)
  })

  await step('review 3, n°6: one of our own direct numbers dialled stays an internal call: its phones are not asked whether they are there (no OPTIONS)', async () => {
    const call = await p303.dial('0199000301')
    expect('final answer', call.final.status === 200, call.final.first)
    const got = await p301.incoming(i => header(i, 'call-id') === call.callId)
    await sleep((PING_SEC * 2 + 2) * 1000)
    expect('OPTIONS to the caller', !call.requests.some(r => r.method === 'OPTIONS'), call.requests.map(r => r.method).join(', '))
    expect('OPTIONS to the callee', !got.requests.some(r => r.method === 'OPTIONS'), got.requests.map(r => r.method).join(', '))
    await p303.hangup(call)
  })

  await step('n°5: a browser\'s window reloaded in a call (its WebSocket closed): OpenSIPS ends the call, a BYE to the operator', async () => {
    const call = await p302.dial('0199000011')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(A, call)
    await p302.drop()
    await A.callState(at, 'ended', pingWait)
  })

  await step('review 3, n°8: the answer of a desk phone to a call from the operator carries no extension in its Contact; the operator\'s BYE reaches the phone at its own', async () => {
    const placed = await A.call('+33199000301', { from: '+33639980002' })
    const answer = await placed.final
    expect('final answer', answer.status === 200, answer.first)
    expect('one Contact, without the extension', answer.headers.get('contact')?.length === 1 && !/sip:301@/.test(header(answer, 'contact')), (answer.headers.get('contact') ?? []).join(' | '))
    const got = await p301.incoming(i => header(i, 'call-id') === placed.callId)
    expect('BYE', (await placed.hangup()).status === 200)
    await p301.callState(got, 'ended', 5_000)
    expect('the BYE at the phone, at its own Contact', got.requests.at(-1)?.uri === p301.contactUri, got.requests.at(-1)?.uri)
  })

  await step('n°5: a call from the operator whose phone went: ended, a BYE to the operator', async () => {
    const placed = await A.call('+33199000301', { from: '+33639980002' })
    expect('final answer', (await placed.final).status === 200)
    p301.st.asleep = true
    try {
      await A.callState(placed, 'ended', pingWait)
    } finally {
      p301.st.asleep = false
    }
  })

  // The default trunk is read again every 15 s for the emergency calls (timer_route[default_trunk]): it has been since.
  await step('n°7: the database does not answer (the trunks locked): an emergency call still reaches the operator, through the default trunk as last read', async () => {
    busy(A)
    const locker = new pg.Client({ connectionString: DB_URL })
    await locker.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE trunks IN ACCESS EXCLUSIVE MODE')
      const call = await p301.dial('112')
      const at = await atOperator(A, call)
      expect('Request-URI at the operator', at.invite.uri === 'sip:112@operator.example', at.invite.uri)
      expect('From', header(at.invite, 'from').includes('<sip:+33199000300@operator.example>'), header(at.invite, 'from'))
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined)
      await locker.end()
    }
  })

  await step(`n°7: an emergency call is never cut at TRUNK_MAX_CALL_SEC (${MAX_CALL_SEC} s); another call is`, async () => {
    const sos = await p301.dial('112')
    expect('final answer', sos.final.status === 200, sos.final.first)
    const other = await p301.dial('0199000012')
    expect('final answer', other.final.status === 200, other.final.first)
    const dialogs = (await mi('dlg_list')).result?.Dialogs ?? []
    const left = id => {
      const d = dialogs.find(x => x.callid === id)
      return Number(d?.timeout) - Math.floor(Date.now() / 1000)
    }
    expect('the emergency call', left(sos.callId) > MAX_CALL_SEC + 3600, `${left(sos.callId)} s left`)
    expect('the other call', left(other.callId) <= MAX_CALL_SEC, `${left(other.callId)} s left`)
    await p301.hangup(sos)
    await p301.hangup(other)
  })

  await step('review 3, n°2: the trunk of the caller\'s direct number refuses an emergency call (403): it goes through the default trunk', async () => {
    C.state.next.push({ reply: '403 Forbidden' })
    const call = await p303.dial('112')
    expect('the refusal at the first trunk', C.state.invites.some(c => c.callId === call.callId && c.state === 'refused'))
    const at = await atOperator(A, call)
    expect('Request-URI at the default trunk', at.invite.uri === 'sip:112@operator.example', at.invite.uri)
    expect('From', header(at.invite, 'from').includes('<sip:+33199000300@operator.example>'), header(at.invite, 'from'))
    expect('final answer', call.final.status === 200, call.final.first)
    await p303.hangup(call)
  })

  await step('n°7: none of the servers of the trunk of the caller\'s direct number is up: an emergency call goes through the default trunk', async () => {
    busy(A)
    await mi('ds_set_state', { state: 'i', group: 2, address: `sip:${C.address}` })
    try {
      const call = await p303.dial('112')
      const at = await atOperator(A, call)
      expect('Request-URI at the operator', at.invite.uri === 'sip:112@operator.example', at.invite.uri)
      expect('From', header(at.invite, 'from').includes('<sip:+33199000300@operator.example>'), header(at.invite, 'from'))
    } finally {
      await mi('ds_set_state', { state: 'a', group: 2, address: `sip:${C.address}` })
    }
  })

  await step('n°2: none of the operator\'s servers up: 112 is answered at once (503, emergency) and any other number too (503, no-trunk); nothing is ever sent to the addresses its calls come from (sources)', async () => {
    for (const op of [A, B]) await mi('ds_set_state', { state: 'i', group: 1, address: `sip:${op.address}` })
    try {
      let started = Date.now()
      const sos = await p301.dial('112')
      expect('112', sos.final.status === 503 && header(sos.final, 'twake-call-refused') === 'emergency', `${sos.final.first} ${header(sos.final, 'twake-call-refused')}`)
      expect('112 answered at once', Date.now() - started < 2_000, `${Date.now() - started} ms`)
      started = Date.now()
      const call = await p301.dial('0199000013')
      expect('01 99 00 00 13', call.final.status === 503 && header(call.final, 'twake-call-refused') === 'no-trunk', `${call.final.first} ${header(call.final, 'twake-call-refused')}`)
      expect('answered at once', Date.now() - started < 2_000, `${Date.now() - started} ms`)
      expect('requests to the source', S.state.requests.length === 0, S.state.requests.map(r => r.method).join(', '))
    } finally {
      for (const op of [A, B]) await mi('ds_set_state', { state: 'a', group: 1, address: `sip:${op.address}` })
    }
  })

  // Step 6b (ADR 0017): rights, caps, volume thresholds, fallback number.
  await step('6b, FR-H3: a rights profile "internal calls only" refuses every external call (403, rights), nothing sent; an emergency call still goes; someone without a profile has the trunk\'s rights', async () => {
    await setOutbound({}, PROFILES, [{ userId: 'u-301', profileId: 'internal' }])
    const sent = sentToOperators()
    for (const number of ['0199000020', '0805980020', '+442079460123']) refused(`${number}`, await p301.dial(number), 'rights')
    expect('calls the operators were sent', sentToOperators() === sent, `${sentToOperators() - sent}`)
    busy(A)
    const sos = await p301.dial('112')
    expect('112 at the operator', (await atOperator(A, sos)).invite.uri === 'sip:112@operator.example')
    busy(C)
    expect('303 (no profile) at the operator', (await atOperator(C, await p303.dial('0199000021'))).invite.uri === 'sip:+33199000021@backup.example')
  })

  await step('6b, FR-H3: a profile "France" calls numbers in France, not abroad though the trunk may (rights); "world" calls abroad; a default profile applies to whoever has none', async () => {
    await setOutbound({}, PROFILES, [{ userId: 'u-301', profileId: 'france' }])
    busy(A)
    await atOperator(A, await p301.dial('0199000023'))
    refused('+442079460123 with "France"', await p301.dial('+442079460123'), 'rights')
    await setOutbound({}, PROFILES, [{ userId: 'u-301', profileId: 'world' }])
    busy(A)
    expect('+442079460123 with "world"', (await atOperator(A, await p301.dial('+442079460123'))).invite.uri === 'sip:+442079460123@operator.example')
    await setOutbound({ defaultProfile: 'internal' }, PROFILES, [{ userId: 'u-301', profileId: 'world' }])
    refused('303 under the default profile', await p303.dial('0199000022'), 'rights')
    busy(A)
    await atOperator(A, await p301.dial('0199000022'))
  })

  await step('6b, FR-D7: a cap of one external call at a time for a person: a second one is refused (403, limit) and the administrators hear it; 112 still goes; released once the first ends', async () => {
    await setOutbound({}, withCaps({ concurrent: 1 }), [{ userId: 'u-301', profileId: 'world' }])
    alerts.length = 0
    const first = await p301.dial('0199000030')
    expect('the first call', first.final.status === 200, first.final.first)
    const sent = sentToOperators()
    refused('a second call', await p301.dial('0199000031'), 'limit')
    expect('calls the operators were sent', sentToOperators() === sent)
    const alert = await untilAlert('limit alert', (m, p) => m === 'E_TWAKEPHONE_LIMIT' && p.caller === '301')
    expect('the alert', alert.param === 'concurrent' && alert.scope === 'user' && alert.number === '+33199000031', JSON.stringify(alert))
    const sos = await p301.dial('112')
    expect('112 during the call', sos.final.status === 200, sos.final.first)
    await p301.hangup(sos)
    await p301.hangup(first)
    const again = await p301.dial('0199000032')
    expect('a call once the first ended', again.final.status === 200, again.final.first)
    await p301.hangup(again)
  })

  await step('6b, FR-D7: a cap of external calls at a time for the organisation: 303 is refused while 301 is in one (scope tenant), and calls once it ended', async () => {
    await setOutbound({ caps: { concurrent: (await outCalls()) + 1 } }, PROFILES, [{ userId: 'u-301', profileId: 'world' }])
    alerts.length = 0
    const first = await p301.dial('0199000033')
    expect('the first call', first.final.status === 200, first.final.first)
    refused('303 meanwhile', await p303.dial('0199000034'), 'limit')
    const alert = await untilAlert('limit alert', (m, p) => m === 'E_TWAKEPHONE_LIMIT' && p.caller === '303')
    expect('the alert', alert.param === 'concurrent' && alert.scope === 'tenant', JSON.stringify(alert))
    await p301.hangup(first)
    busy(C)
    await atOperator(C, await p303.dial('0199000034'))
  })

  await step('6b, FR-D7: a cap of external calls a day: the answered calls of the day count (their CDR), an emergency call never; reached, refused (limit, dailyCalls); raised, released', async () => {
    const used = (await usedToday('301')).calls
    await setOutbound({}, withCaps({ dailyCalls: used + 1 }), [{ userId: 'u-301', profileId: 'world' }])
    alerts.length = 0
    const sos = await p301.dial('112')
    expect('112', sos.final.status === 200, sos.final.first)
    await p301.hangup(sos)
    expect('the CDR of 112', (await cdrOf(sos.callId)).external === 'emergency')
    const call = await p301.dial('0199000040')
    expect('the last call of the day', call.final.status === 200, call.final.first)
    await p301.hangup(call)
    expect('its CDR', (await cdrOf(call.callId)).external === 'out')
    refused('the next one', await p301.dial('0199000041'), 'limit')
    const alert = await untilAlert('limit alert', (m, p) => m === 'E_TWAKEPHONE_LIMIT' && p.caller === '301')
    expect('the alert', alert.param === 'dailyCalls' && alert.scope === 'user', JSON.stringify(alert))
    busy(A)
    await atOperator(A, await p301.dial('112'))
    await setOutbound({}, withCaps({ dailyCalls: used + 2 }), [{ userId: 'u-301', profileId: 'world' }])
    busy(A)
    await atOperator(A, await p301.dial('0199000042'))
  })

  await step('6b, FR-D7: a cap of external minutes a day: a call ends when it is reached (8 s left: cut at 8 s), the next one is refused (limit, dailyMinutes)', async () => {
    const used = (await usedToday('301')).seconds
    const minutes = Math.ceil((used + 8) / 60) + 1
    const filler = `filler-${randomBytes(4).toString('hex')}`
    await db.query("INSERT INTO acc (method, callid, sip_code, sip_reason, time, duration, caller, callee, external) VALUES ('INVITE', $1, '200', 'OK', localtimestamp, $2, '301', '+33199000049', 'out')", [filler, minutes * 60 - used - 8])
    try {
      await setOutbound({}, withCaps({ dailyMinutes: minutes }), [{ userId: 'u-301', profileId: 'world' }])
      alerts.length = 0
      const call = await p301.dial('0199000050')
      expect('the call', call.final.status === 200, call.final.first)
      const started = Date.now()
      await p301.callState(call, 'ended', 20_000)
      const lasted = (Date.now() - started) / 1000
      expect('cut when the minutes are reached', lasted > 6 && lasted < 12, `${lasted} s`)
      await A.callState(await atOperator(A, call), 'ended', 5_000)
      // Its CDR written (at the end of the dialog, just after the BYEs): the seconds it used count from then on.
      expect('its CDR', (await cdrOf(call.callId)).duration >= 8)
      const next = await p301.dial('0199000051')
      if (next.final.status === 200) await p301.hangup(next)
      refused('the next one', next, 'limit')
      const alert = await untilAlert('limit alert', (m, p) => m === 'E_TWAKEPHONE_LIMIT' && p.caller === '301')
      expect('the alert', alert.param === 'dailyMinutes' && alert.scope === 'user', JSON.stringify(alert))
    } finally {
      await db.query('DELETE FROM acc WHERE callid = $1', [filler])
    }
  })

  await step('6b, FR-D7: the volume thresholds (fraud_detection): the second call in a row to one number raises a warning and goes, the third is refused (403, fraud) with a critical alert; 112 still goes', async () => {
    await setOutbound({ fraud: { national: { ...NO_THRESHOLD, sequentialCalls: { warning: 2, critical: 3 } }, international: NO_THRESHOLD } }, PROFILES, [{ userId: 'u-301', profileId: 'world' }])
    alerts.length = 0
    for (let i = 1; i <= 2; i++) {
      busy(C)
      await atOperator(C, await p303.dial('0199000060'))
    }
    const warning = await untilAlert('warning', (m, p) => m === 'E_FRD_WARNING' && p.user === '303')
    expect('the warning', warning.param === 'sequential-calls' && Number(warning.value) === 2 && Number(warning.threshold) === 2 && warning.called_number === '33199000060', JSON.stringify(warning))
    const sent = sentToOperators()
    refused('the third call', await p303.dial('0199000060'), 'fraud')
    expect('calls the operators were sent', sentToOperators() === sent)
    const critical = await untilAlert('critical alert', (m, p) => m === 'E_FRD_CRITICAL' && p.user === '303')
    expect('the critical alert', critical.param === 'sequential-calls' && Number(critical.value) === 3, JSON.stringify(critical))
    // Refused by its trunk (486), an emergency call goes again through the default one (route[emergency_fallback]).
    busy(C)
    busy(A)
    const sos = await p303.dial('112')
    expect('112', (await atOperator(C, sos)).invite.uri === 'sip:112@backup.example')
    await atOperator(A, sos)
    await setOutbound({}, PROFILES, [])
  })

  await step('6b, FR-C8: a call from the operator nobody can take is sent back to it, to the fallback number (302): the direct number\'s own, else its trunk\'s; none, refused as before', async () => {
    await tables.set([{ ...main, fallbackNumber: '+33199000399' }, backup], [dids[0], { ...dids[1], fallbackNumber: '+33199000398' }])
    // No account 300: 404 without a fallback number.
    const nobody = await (await A.call('+33199000300')).final
    expect('a number of nobody', nobody.status === 302 && header(nobody, 'contact') === '<sip:+33199000399@operator.example>', `${nobody.first} ${header(nobody, 'contact')}`)
    // 302's window went (its WebSocket closed, above): unreachable.
    const away = await (await A.call('+33199000302')).final
    expect('a phone not there', away.status === 302 && header(away, 'contact') === '<sip:+33199000399@operator.example>', `${away.first} ${header(away, 'contact')}`)
    p303.st.answerWith = '486 Busy Here'
    try {
      const placed = await C.call('+33199000303')
      const busyDesk = await placed.final
      expect('the desk busy', busyDesk.status === 302 && header(busyDesk, 'contact') === '<sip:+33199000398@backup.example>', `${busyDesk.first} ${header(busyDesk, 'contact')}`)
      expect('the desk rung first', !!(await p303.incoming(i => header(i, 'call-id') === placed.callId)))
    } finally {
      p303.st.answerWith = '200 OK'
    }
    await tables.set([main, backup], dids)
    const none = await (await A.call('+33199000300')).final
    expect('without a fallback number', none.status === 404, none.first)
  })
} finally {
  for (const p of phones) await p.close().catch(() => undefined)
  for (const e of ALERT_EVENTS) await mi('event_subscribe', [e, alertAddress, 0]).catch(() => undefined)
  listener.close()
  // The default thresholds back, the tenant's rules removed: the Gateway of the browsers' e2e (another tenant) writes its own.
  await outbound
    .set({}, [], [])
    .then(() => db.query('DELETE FROM outbound_users WHERE tenant_id = $1', [TENANT]))
    .then(() => db.query('DELETE FROM outbound_profiles WHERE tenant_id = $1', [TENANT]))
    .then(() => db.query('DELETE FROM outbound_settings WHERE tenant_id = $1', [TENANT]))
    .then(() => mi('fraud_reload'))
    .catch(err => console.log(`outbound rules not removed: ${err.message}`))
  await tables.set([], []).catch(err => console.log(`trunks not removed: ${err.message}`))
  await reload().catch(() => undefined)
  for (const ext of Object.keys(secrets)) await prov.removeSipSecret(ext).catch(() => undefined)
  await prov.close()
  await db.end()
  for (const op of [A, B, C, S, X]) await op.close()
}
console.log(failed ? `${failed} step(s) failed` : 'all steps passed')
process.exit(failed ? 1 : 0)
