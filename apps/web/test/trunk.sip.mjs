// The trunk to the operator as OpenSIPS's script runs it (step 6a, ADR 0016), without a browser: SIP phones of this
// process (sip-phone.mjs, over UDP and over a WebSocket) and simulated operators (sip-trunk.mjs, which send 100 Trying
// first as real ones do) against the SIP stack (docker/docker-compose.sip.yml, or OpenSIPS and rtpengine started by
// hand), with the trunks written by the OpenSIPS provider (TrunkTables). What each step proves is what the script
// does with the messages, not the text of the script. Fictional numbers only (ARCEP reserves 01 99 00 xx xx and
// 06 39 98 xx xx for fiction; Ofcom 020 7946 0xxx). Its accounts (115, 301 to 303) and trunks are removed at the end:
// the e2e of the browsers (sip.e2e.mjs) runs on the same stack afterwards.
//
//   SIP_UDP, SIP_WS      UDP and WS sockets of OpenSIPS (default 127.0.0.1:5060, ws://127.0.0.1:8088)
//   SIP_TRUNK            its trunk socket (default 127.0.0.1:5070); TRUNK_ADVERTISE what it announces there, if anything
//   SIP_DOMAIN           SIP domain and digest realm (default 127.0.0.1)
//   OPENSIPS_DB_URL      its database (default postgres://twake:twake@127.0.0.1:54320/twake)
//   OPENSIPS_MI_URL      its MI (default udp:127.0.0.1:8880)
//   CALL_PING_SEC        its CALL_PING_SEC (default 30): how long the steps on calls whose phone went wait
//   TRUNK_MAX_CALL_SEC   its TRUNK_MAX_CALL_SEC (default 14400)
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

const prov = new SubscriberProvisioner({ databaseUrl: DB_URL, realm: SIP_DOMAIN })
await prov.ensureSchema()
const secret = ext => `secret-${ext}-${randomBytes(4).toString('hex')}`
const secrets = Object.fromEntries(['115', '301', '302', '303'].map(e => [e, secret(e)]))
// 115 is the account of an extension kept from before step 6a: an emergency number (the SAMU social).
for (const [ext, s] of Object.entries(secrets)) await prov.setSipSecret(ext, s)
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
const main = { id: 'main', auth: 'register', domain: 'operator.example', proxies: [A.address, B.address], sources: ['127.0.0.3'], username: LOGIN, password: PASSWORD, codecs: ['PCMA', 'PCMU'], numberFormat: 'e164', defaultNumber: '+33199000300', allowed: ['fixed', 'mobile', 'freephone', 'standard-rate', 'international'], countries: ['44'] }
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
const pingWait = (PING_SEC * 2 + 12) * 1000

try {
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
    const bye = await X.request(at, 'BYE')
    expect('answer to the BYE', bye.status === 200, bye.first)
    await p301.callState(call, 'ended', 5_000)
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
    p301.st.asleep = true
    try {
      await A.callState(at, 'ended', pingWait)
    } finally {
      p301.st.asleep = false
      await other.close()
      phones.splice(phones.indexOf(other), 1)
    }
  })

  await step('n°5: a browser\'s window reloaded in a call (its WebSocket closed): OpenSIPS ends the call, a BYE to the operator', async () => {
    const call = await p302.dial('0199000011')
    expect('final answer', call.final.status === 200, call.final.first)
    const at = await atOperator(A, call)
    await p302.drop()
    await A.callState(at, 'ended', pingWait)
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
} finally {
  for (const p of phones) await p.close().catch(() => undefined)
  await tables.set([], []).catch(err => console.log(`trunks not removed: ${err.message}`))
  await reload().catch(() => undefined)
  for (const ext of Object.keys(secrets)) await prov.removeSipSecret(ext).catch(() => undefined)
  await prov.close()
  await db.end()
  for (const op of [A, B, C, S, X]) await op.close()
}
console.log(failed ? `${failed} step(s) failed` : 'all steps passed')
process.exit(failed ? 1 : 0)
