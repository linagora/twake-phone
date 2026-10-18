// A SIP operator for the trunk of the e2e (step 6, ADR 0016): what OVHcloud or any SIP trunk does, as far as the
// RFCs say, over UDP on this host. It is the registrar of the trunk (digest, 401) and challenges each call it is sent
// (407, or 401 with `challenge: 'www'`); it answers the OPTIONS of OpenSIPS's dispatcher; it answers the calls OpenSIPS
// sends it (100, 180, then 200 with G.711 A-law), or as the test asks for the next ones (`state.next`: refused at once,
// after ringing, never answered, challenged for ever), a 100 Trying first as a real one sends at once, before its
// challenge or its refusal too; it places calls to the trunk's direct numbers (with an offer,
// or none: a late offer), sends re-INVITEs without SDP in either kind of call, and records every request it gets in a
// dialog (REFER, re-INVITE, BYE...). Media both ways: an A-law tone over RTP out, the RTP received counted (sound,
// and RFC 4733 events), and digits typed in a call it placed (RFC 4733, step 8: a room's PIN). `dead` plays a server that answers nothing at all. Behind a NAT (`nat`): what OpenSIPS
// announces (TRUNK_ADVERTISE) is reached at its real address. No retransmissions of its own (the loopback loses no
// datagram).
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

const md5 = text => createHash('md5').update(text).digest('hex')
const token = () => randomBytes(8).toString('hex')

const parse = raw => {
  const sep = raw.indexOf('\r\n\r\n')
  const head = sep < 0 ? raw : raw.slice(0, sep)
  const body = sep < 0 ? '' : raw.slice(sep + 4)
  const [first, ...lines] = head.split('\r\n')
  const headers = new Map()
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()])
  }
  const status = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(first)
  const request = /^(\w+) (\S+) SIP\/2\.0$/.exec(first)
  return { raw, first, headers, body, ...(status ? { status: Number(status[1]), reason: status[2] } : { method: request?.[1], uri: request?.[2] }) }
}
const one = (msg, name) => msg.headers.get(name)?.[0] ?? ''
const tagOf = value => /;tag=([^;>\s]+)/.exec(value)?.[1]
const param = (header, name) => new RegExp(`${name}="([^"]*)"`, 'i').exec(header)?.[1]
/** The Record-Route of a message, one URI per entry, in order. */
const routeSet = msg => [...(msg.headers.get('record-route') ?? [])].flatMap(v => v.split(/,\s*(?=<)/))

/** G.711 A-law of a 16-bit sample. */
const alaw = sample => {
  let s = Math.max(-32768, Math.min(32767, sample))
  const sign = s >= 0 ? 0x80 : 0
  if (s < 0) s = -s - 1
  let exponent = 7
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--
  const mantissa = exponent === 0 ? (s >> 4) & 0x0f : (s >> (exponent + 3)) & 0x0f
  return (sign | (exponent << 4) | mantissa) ^ 0x55
}
/** 20 ms of a 440 Hz tone at 8 kHz, in A-law: what the operator's side says. */
const TONE = Buffer.from(Array.from({ length: 160 }, (_, i) => alaw(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)))))
/** 20 ms of silence in A-law. */
const SILENCE = Buffer.alloc(160, 0xd5)
/** The 16-bit samples of a WAV at 8 kHz, mono (as Asterisk's prompts): what a caller says (step 11b). */
export const wavSamples = buf => {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV')
  let at = 12
  let format
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'fmt ') format = { channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) }
    if (id === 'data') {
      if (!format || format.channels !== 1 || format.rate !== 8000 || format.bits !== 16) throw new Error('a WAV of 8 kHz, 16 bits, mono expected')
      const data = buf.subarray(at + 8, at + 8 + size)
      return Array.from({ length: data.length >> 1 }, (_, i) => data.readInt16LE(2 * i))
    }
    at += 8 + size + (size & 1)
  }
  throw new Error('a WAV without data')
}

/** Our SDP: A-law and DTMF events, on the payload type the offer gave them when we answer one (`events`). */
const sdpFor = (port, sessionId, version = 1, events = 101) =>
  ['v=0', `o=operator ${sessionId} ${version} IN IP4 127.0.0.1`, 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${port} RTP/AVP 8 ${events}`, 'a=rtpmap:8 PCMA/8000', `a=rtpmap:${events} telephone-event/8000`, `a=fmtp:${events} 0-16`, 'a=ptime:20', 'a=sendrecv', ''].join('\r\n')
/** The payload type of DTMF events (RFC 4733) in an offer. */
const eventsOf = sdp => Number(/^a=rtpmap:(\d+) telephone-event\/8000/m.exec(sdp ?? '')?.[1] ?? 101)

/** Where the far end wants its RTP, from its SDP; and the payload types it offers. */
const remoteMedia = sdp => {
  const host = /^c=IN IP4 (\S+)/m.exec(sdp)?.[1]
  const m = /^m=audio (\d+) (\S+) ([\d ]+)/m.exec(sdp)
  return host && m ? { host, port: Number(m[1]), proto: m[2], payloads: m[3].trim().split(' ').map(Number) } : undefined
}
/** Whether an SDP is plain RTP, as an operator takes it: RTP/AVP, no ICE, DTLS nor SDES. */
export const plainRtp = sdp => remoteMedia(sdp)?.proto === 'RTP/AVP' && !/^a=(candidate|fingerprint|crypto|ice-ufrag):/m.test(sdp)

/** One call's media: a socket of its own, a tone every 20 ms to the far end, the RTP received counted. */
const media = async () => {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  // events: RFC 4733 packets (a dynamic payload type, four bytes: the tone, end and volume, duration), the tones the
  // far end sent, whatever payload type its side gave them.
  const stats = { sent: 0, received: 0, voiced: 0, events: 0 }
  socket.on('message', buf => {
    if (buf.length < 12 || buf[0] >> 6 !== 2) return
    stats.received++
    const payload = buf.subarray(12)
    if ((buf[1] & 0x7f) >= 96 && payload.length === 4 && payload[0] <= 15) {
      stats.events++
      return
    }
    // A-law silence is 0xD5 (and 0x55): a packet with other values carries sound.
    if (payload.some(b => b !== 0xd5 && b !== 0x55)) stats.voiced++
  })
  let timer
  let target
  /** What is said instead of the tone (step 11b: a phrase), 20 ms at a time, then silence; until then, the tone. */
  const said = []
  let quiet = false
  const ssrc = randomBytes(4).readUInt32BE(0)
  let seq = Math.floor(Math.random() * 1000)
  let ts = Math.floor(Math.random() * 100000)
  return {
    port: socket.address().port,
    stats,
    /** Sends to `to` from now on (a new answer moves it). */
    start(to) {
      if (!to) return
      target = to
      if (timer) return
      timer = setInterval(() => {
        const header = Buffer.alloc(12)
        header[0] = 0x80
        header[1] = 8
        header.writeUInt16BE(seq++ & 0xffff, 2)
        header.writeUInt32BE(ts >>> 0, 4)
        header.writeUInt32BE(ssrc, 8)
        ts += 160
        socket.send(Buffer.concat([header, said.shift() ?? (quiet ? SILENCE : TONE)]), target.port, target.host)
        stats.sent++
      }, 20)
    },
    /**
     * Says `samples` (16-bit, 8 kHz: wavSamples) instead of the tone, then silence; resolves once it is all sent.
     */
    async say(samples) {
      for (let i = 0; i < samples.length; i += 160) said.push(Buffer.from(Array.from({ length: 160 }, (_, j) => alaw(samples[i + j] ?? 0))))
      quiet = true
      while (said.length) await new Promise(resolve => setTimeout(resolve, 20))
    },
    /**
     * Types `digits` (0-9, *, #) as RFC 4733 events on payload type `pt` (step 8: a room's PIN), between the tone's
     * packets: each digit 100 ms (its end sent three times, as the RFC asks), then 150 ms of nothing typed.
     */
    async dtmf(digits, pt = 101) {
      if (!target) throw new Error('no media to type into')
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      for (const digit of digits) {
        const event = '0123456789*#'.indexOf(digit)
        if (event < 0) throw new Error(`not a DTMF digit: ${digit}`)
        const start = ts >>> 0
        ts += 800
        for (let i = 1; i <= 8; i++) {
          const end = i >= 6
          const packet = Buffer.alloc(16)
          packet[0] = 0x80
          packet[1] = (i === 1 ? 0x80 : 0) | pt
          packet.writeUInt16BE(seq++ & 0xffff, 2)
          packet.writeUInt32BE(start, 4)
          packet.writeUInt32BE(ssrc, 8)
          packet[12] = event
          packet[13] = (end ? 0x80 : 0) | 10
          packet.writeUInt16BE(Math.min(i, 5) * 160, 14)
          socket.send(packet, target.port, target.host)
          stats.sent++
          await sleep(20)
        }
        await sleep(150)
      }
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      try {
        socket.close()
      } catch {
        // Closed already.
      }
    }
  }
}

/**
 * The operator, on 127.0.0.1 (a random port unless `port`): `opensips` is OpenSIPS's trunk socket ("host:port"),
 * `user` and `password` the trunk's credentials, `realm` the realm of its challenges, `challenge` how it challenges
 * the calls ('proxy': 407, 'www': 401). `bind` another loopback address plays someone who is not the operator. `nat`:
 * addresses OpenSIPS announces ("host:port") and where they really are, as a NAT in front of it would map them.
 */
export const startOperator = async ({ opensips, user, password, realm = 'operator.example', domain = 'operator.example', bind = '127.0.0.1', port = 0, answerDelayMs = 300, challenge = 'proxy', nat = {} }) => {
  const [osHost, osPort] = opensips.split(':')
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, bind, resolve)
  })
  const address = `${bind}:${socket.address().port}`
  const send = (text, host = osHost, p = Number(osPort)) => {
    const real = nat[`${host}:${p}`]
    const [h, rp] = real ? real.split(':') : [host, p]
    return new Promise((resolve, reject) => socket.send(text, Number(rp), h, err => (err ? reject(err) : resolve())))
  }
  const nonces = new Set()
  const challengeHeader = () => {
    const nonce = token()
    nonces.add(nonce)
    return `Digest realm="${realm}", nonce="${nonce}", algorithm=MD5, qop="auth"`
  }
  /** Whether `authorization` answers one of our challenges with the trunk's credentials. */
  const authorized = (authorization, method) => {
    if (!authorization) return false
    const nonce = param(authorization, 'nonce')
    if (!nonce || !nonces.has(nonce) || param(authorization, 'username') !== user || param(authorization, 'realm') !== realm) return false
    const uri = param(authorization, 'uri')
    const ha1 = md5(`${user}:${realm}:${password}`)
    const ha2 = md5(`${method}:${uri}`)
    const qop = /qop=("?)auth\1/i.test(authorization)
    const nc = /nc=([0-9a-f]+)/i.exec(authorization)?.[1]
    const cnonce = param(authorization, 'cnonce')
    const expected = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`)
    return param(authorization, 'response') === expected
  }

  // refuseWith: the final answer to the calls OpenSIPS sends ("486 Busy Here"), instead of answering them. next: how
  // to treat the next calls, one entry each: { reply, headers } (a final answer at once), { ringThen } (100 and 180,
  // then that final answer), { ringOnly: true } (100 and 180, nothing more), { silent: true } (no answer at all),
  // { rejectAuth: true } (challenged again whatever the credentials). dead: a server that answers nothing, OPTIONS
  // included. requests: every request received (method, Request-URI, headers, body), in order.
  const state = { options: 0, registrations: [], invites: [], attempts: [], challenged: 0, refuseWith: undefined, next: [], dead: false, requests: [] }
  const waiters = new Set()
  const changed = () => {
    for (const w of waiters) w()
  }
  const until = (what, test, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const v = test()
        if (!v) return
        done()
        resolve(v)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`operator: ${what} within ${timeoutMs} ms`))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })

  const reply = (req, code, { headers = [], body = '', toTag } = {}) => {
    const lines = [`SIP/2.0 ${code}`]
    for (const v of req.headers.get('via') ?? []) lines.push(`Via: ${v}`)
    for (const rr of req.headers.get('record-route') ?? []) lines.push(`Record-Route: ${rr}`)
    const to = one(req, 'to')
    lines.push(`From: ${one(req, 'from')}`, `To: ${toTag && !tagOf(to) ? `${to};tag=${toTag}` : to}`, `Call-ID: ${one(req, 'call-id')}`, `CSeq: ${one(req, 'cseq')}`)
    lines.push(`Contact: <sip:operator@${address}>`, ...headers)
    if (body) lines.push('Content-Type: application/sdp')
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body)
    const via = one(req, 'via')
    const rport = /;rport=(\d+)/.exec(via)?.[1]
    const received = /;received=([\d.]+)/.exec(via)?.[1]
    const sent = /^SIP\/2\.0\/UDP ([\w.-]+):?(\d+)?/.exec(via)
    return send(lines.join('\r\n'), received ?? sent?.[1] ?? osHost, Number(rport ?? sent?.[2] ?? 5060))
  }

  /** Calls OpenSIPS sent us, by Call-ID: the dialog's tag, our media, what we know of the far end. */
  const dialogs = new Map()
  /** Calls we placed, by Call-ID. */
  const placed = new Map()
  /** The branches of the INVITEs we leave unanswered: their retransmissions too. */
  const silenced = new Set()
  const responses = []
  const withBody = (lines, b = '') => [...lines, ...(b ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(b)}`, '', b].join('\r\n')
  const response = (callId, cseq, accept, what, timeoutMs = 15_000) =>
    until(what, () => {
      const i = responses.findIndex(r => one(r, 'call-id') === callId && one(r, 'cseq') === cseq && accept(r))
      return i < 0 ? undefined : responses.splice(i, 1)[0]
    }, timeoutMs)

  /**
   * A request of ours in the dialog of `call`, as its UAC (placed) or UAS (received) side: to the remote target,
   * through the route set; resolves with its final answer.
   */
  const inDialog = async (call, method, { body = '', extra = [] } = {}) => {
    const cseq = (call.cseq = (call.cseq ?? 1) + 1)
    const b = `z9hG4bK${token()}`
    const lines = [
      `${method} ${call.remoteTarget} SIP/2.0`,
      `Via: SIP/2.0/UDP ${address};branch=${b};rport`,
      'Max-Forwards: 70',
      `From: ${call.local}`,
      `To: ${call.remote}`,
      `Call-ID: ${call.callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <sip:operator@${address}>`,
      ...call.route.map(r => `Route: ${r}`),
      ...extra
    ]
    await send(withBody(lines, body))
    if (method === 'ACK') return undefined
    return response(call.callId, `${cseq} ${method}`, r => r.status >= 200, `the answer to our ${method}`)
  }
  /** A re-INVITE of ours without SDP (an operator refreshing its session): our answer in the ACK of its 2xx. */
  const reinvite = async call => {
    const answer = await inDialog(call, 'INVITE')
    call.offers = [...(call.offers ?? []), answer]
    if (answer.status >= 200 && answer.status < 300) {
      const far = remoteMedia(answer.body)
      call.version = (call.version ?? 1) + 1
      await send(
        withBody(
          [
            `ACK ${call.remoteTarget} SIP/2.0`,
            `Via: SIP/2.0/UDP ${address};branch=z9hG4bK${token()};rport`,
            'Max-Forwards: 70',
            `From: ${call.local}`,
            `To: ${call.remote}`,
            `Call-ID: ${call.callId}`,
            `CSeq: ${call.cseq} ACK`,
            `Contact: <sip:operator@${address}>`,
            ...call.route.map(r => `Route: ${r}`)
          ],
          sdpFor(call.media.port, call.sessionId, call.version, eventsOf(answer.body))
        )
      )
      call.media.start(far)
    }
    return answer
  }

  socket.on('message', async buf => {
    const msg = parse(buf.toString())
    if (state.dead) return
    if (msg.status !== undefined) {
      responses.push(msg)
      changed()
      return
    }
    state.requests.push({ method: msg.method, uri: msg.uri, headers: msg.headers, body: msg.body, callId: one(msg, 'call-id') })
    const callId = one(msg, 'call-id')
    switch (msg.method) {
      case 'OPTIONS':
        state.options++
        await reply(msg, '200 OK')
        changed()
        break
      case 'REGISTER': {
        if (!authorized(one(msg, 'authorization'), 'REGISTER')) {
          await reply(msg, '401 Unauthorized', { headers: [`WWW-Authenticate: ${challengeHeader()}`] })
          break
        }
        const expires = Number(/expires=(\d+)/i.exec(one(msg, 'contact'))?.[1] ?? one(msg, 'expires') ?? 3600)
        state.registrations.push({ aor: one(msg, 'to'), contact: one(msg, 'contact'), via: one(msg, 'via'), expires, from: `${msg.headers.get('via')?.[0]}` })
        await reply(msg, '200 OK', { headers: [`Expires: ${expires}`], toTag: token() })
        changed()
        break
      }
      case 'INVITE': {
        const known = dialogs.get(callId) ?? placed.get(callId)
        if (known && tagOf(one(msg, 'to'))) {
          // A re-INVITE (hold, resume, a late offer): our same media, a new version of our SDP.
          known.reinvites.push(msg)
          known.version = (known.version ?? 1) + 1
          const far = remoteMedia(msg.body)
          if (far) known.media.start(far)
          await reply(msg, '200 OK', { body: sdpFor(known.media.port, known.sessionId, known.version, known.events ?? (msg.body ? eventsOf(msg.body) : 101)), toTag: known.tag })
          changed()
          break
        }
        const branch = /;branch=([^;,\s]+)/.exec(one(msg, 'via'))?.[1]
        if (silenced.has(branch)) break
        state.attempts.push(msg)
        const behaviour = state.next[0]
        if (behaviour?.silent) {
          silenced.add(branch)
          state.next.shift()
          changed()
          break
        }
        // As a real operator: 100 Trying at once, whatever comes next (a challenge, a refusal, the ringing).
        await reply(msg, '100 Trying')
        const authHeader = challenge === 'www' ? one(msg, 'authorization') : one(msg, 'proxy-authorization')
        if (behaviour?.rejectAuth || !authorized(authHeader, 'INVITE')) {
          if (behaviour?.rejectAuth && authHeader) state.next.shift()
          state.challenged++
          await reply(msg, challenge === 'www' ? '401 Unauthorized' : '407 Proxy Authentication Required', { headers: [`${challenge === 'www' ? 'WWW' : 'Proxy'}-Authenticate: ${challengeHeader()}`], toTag: token() })
          changed()
          break
        }
        if (behaviour) state.next.shift()
        const tag = token()
        const call = { invite: msg, tag, sessionId: Date.now(), media: await media(), far: remoteMedia(msg.body), events: msg.body ? eventsOf(msg.body) : 101, state: 'ringing', reinvites: [], requests: [], acks: [] }
        // As the UAS of this dialog: our tag in the To, the route set as received, the far end at its Contact.
        Object.assign(call, { callId, local: `${one(msg, 'to')};tag=${tag}`, remote: one(msg, 'from'), route: routeSet(msg), remoteTarget: /<([^>]+)>/.exec(one(msg, 'contact'))?.[1] })
        dialogs.set(callId, call)
        state.invites.push(call)
        changed()
        if (behaviour?.reply) {
          call.state = 'refused'
          call.media.stop()
          await reply(msg, behaviour.reply, { headers: behaviour.headers ?? [], toTag: tag })
          changed()
          break
        }
        await reply(msg, '180 Ringing', { toTag: tag })
        if (behaviour?.ringOnly) break
        setTimeout(async () => {
          if (call.state !== 'ringing') return
          const refusal = behaviour?.ringThen ?? state.refuseWith
          if (refusal) {
            call.state = 'refused'
            call.media.stop()
            await reply(msg, refusal, { toTag: tag })
            changed()
            return
          }
          call.state = 'answered'
          await reply(msg, '200 OK', { body: sdpFor(call.media.port, call.sessionId, 1, call.events), toTag: tag })
          call.media.start(call.far)
          changed()
        }, behaviour?.ringThen ? (behaviour.afterMs ?? answerDelayMs) : answerDelayMs)
        break
      }
      case 'ACK': {
        // The answer to an offer we made in a 2xx (a call OpenSIPS sent us without SDP).
        const call = dialogs.get(callId)
        call?.acks.push(msg)
        const far = remoteMedia(msg.body)
        if (call && far) {
          call.far = far
          call.media.start(far)
        }
        changed()
        break
      }
      case 'CANCEL': {
        await reply(msg, '200 OK')
        const call = dialogs.get(callId)
        if (call && call.state === 'ringing') {
          call.state = 'cancelled'
          await reply(call.invite, '487 Request Terminated', { toTag: call.tag })
          call.media.stop()
        }
        changed()
        break
      }
      case 'BYE': {
        await reply(msg, '200 OK')
        const call = dialogs.get(callId) ?? placed.get(callId)
        if (call) {
          call.requests?.push(msg)
          call.state = 'ended'
          call.media.stop()
        }
        changed()
        break
      }
      default: {
        // REFER, INFO, NOTIFY... in a dialog: recorded, accepted as an operator executing it would.
        ;(dialogs.get(callId) ?? placed.get(callId))?.requests?.push(msg)
        await reply(msg, msg.method === 'REFER' ? '202 Accepted' : '200 OK')
        changed()
      }
    }
  })

  return {
    address,
    state,
    /** Resolves once OpenSIPS registered (`count` times). */
    registered: (count = 1, timeoutMs = 30_000) => until(`${count} registration(s) of the trunk`, () => state.registrations.length >= count && state.registrations, timeoutMs),
    /** Resolves once OpenSIPS's dispatcher probed us (`count` OPTIONS). */
    probed: (count = 1, timeoutMs = 40_000) => until(`${count} OPTIONS from the dispatcher`, () => state.options >= count, timeoutMs),
    /** The next call OpenSIPS sends us that `test` takes (its INVITE, after the challenge), with its media. */
    invited: (test = () => true, timeoutMs = 20_000) => until('a call from OpenSIPS', () => state.invites.find(c => !c.seen && test(c.invite)), timeoutMs).then(c => ((c.seen = true), c)),
    /** Waits for `call` (one we received or placed) to reach `wanted` ('answered', 'ended', 'cancelled', 'refused'). */
    callState: (call, wanted, timeoutMs = 20_000) => until(`the call in state ${wanted}`, () => call.state === wanted, timeoutMs),
    /** Resolves once `test` holds (re-checked at each message). */
    until,
    /** Sends a re-INVITE without SDP in `call` (received or placed): resolves with the 2xx and its offer, answered. */
    reinvite,
    /** Any request of ours in the dialog of `call` (a REFER, an INFO...): resolves with its final answer. */
    request: (call, method, { body, extra } = {}) => inDialog(call, method, { body, extra }),
    /** Ends a call OpenSIPS sent us (our BYE). */
    async hangupReceived(call) {
      const answer = await inDialog(call, 'BYE')
      call.state = 'ended'
      call.media.stop()
      return answer
    },
    /**
     * Calls `number` at OpenSIPS (`ruri`: the Request-URI's user, the number by default; `from`: the caller's number;
     * `headers`: more of them; `lateOffer`: no SDP, the offer comes in the 2xx and our answer in the ACK): resolves
     * with the call, whose `final` is its final answer; on a 200 it ACKs and sends its media.
     */
    async call(number, { from = '+33639980002', ruri = number, timeoutMs = 30_000, headers = [], lateOffer = false } = {}) {
      const callId = `op-${token()}`
      const fromTag = token()
      const m = await media()
      const sessionId = Date.now()
      const uri = `sip:${ruri}@${opensips}`
      const branch = `z9hG4bK${token()}`
      const body = lateOffer ? '' : sdpFor(m.port, sessionId)
      const call = { callId, media: m, sessionId, state: 'calling', provisional: [], reinvites: [], requests: [], local: `<sip:${from}@${domain}>;tag=${fromTag}`, remote: `<sip:${number}@${domain}>`, route: [] }
      placed.set(callId, call)
      // In the dialog (the ACK of a 2xx, the BYE), the Request-URI is the remote target (the answer's Contact), the
      // Route the route set: a Request-URI naming OpenSIPS itself would read as coming from a strict router.
      const head = (method, cseq, b, extra = [], target = uri) =>
        [
          `${method} ${target} SIP/2.0`,
          `Via: SIP/2.0/UDP ${address};branch=${b};rport`,
          'Max-Forwards: 70',
          `From: ${call.local}`,
          `To: ${call.remote}`,
          `Call-ID: ${callId}`,
          `CSeq: ${cseq} ${method}`,
          `Contact: <sip:operator@${address}>`,
          ...call.route.map(r => `Route: ${r}`),
          ...extra
        ]
      await send(withBody(head('INVITE', 1, branch, headers), body))
      call.final = response(callId, '1 INVITE', r => r.status >= 200, `the final answer to ${number}`, timeoutMs).then(async answer => {
        call.provisional = responses.filter(r => one(r, 'call-id') === callId && r.status < 200).map(r => r.status)
        if (answer.status >= 300) {
          await send(withBody(head('ACK', 1, branch)))
          call.state = 'failed'
          return answer
        }
        call.remote = one(answer, 'to')
        // The route set of the dialog: the Record-Route of the answer, reversed (we are the caller).
        call.route = routeSet(answer).reverse()
        call.remoteTarget = /<([^>]+)>/.exec(one(answer, 'contact'))?.[1] ?? uri
        call.state = 'answered'
        call.answer = answer
        // A late offer: the offer is in the 2xx, our answer goes in the ACK.
        await send(withBody(head('ACK', 1, `z9hG4bK${token()}`, [], call.remoteTarget), lateOffer ? sdpFor(m.port, sessionId, 1, eventsOf(answer.body)) : ''))
        m.start(remoteMedia(answer.body))
        changed()
        return answer
      })
      call.final.catch(() => undefined)
      call.cancel = () => send(withBody(head('CANCEL', 1, branch)))
      /** Types `digits` in the call (RFC 4733, on the payload type of the answer's DTMF events). */
      call.dtmf = digits => m.dtmf(digits, eventsOf(call.answer?.body))
      call.hangup = async () => {
        const answer = await inDialog(call, 'BYE')
        call.state = 'ended'
        m.stop()
        return answer
      }
      return call
    },
    /**
     * Sends any raw request to OpenSIPS's trunk socket and resolves with the final answer; `callId` and `toTag` make
     * it one that claims a dialog.
     */
    async raw(method, number, { callId = `raw-${token()}`, toTag } = {}) {
      const text = [
        `${method} sip:${number}@${opensips} SIP/2.0`,
        `Via: SIP/2.0/UDP ${address};branch=z9hG4bK${token()};rport`,
        'Max-Forwards: 70',
        `From: <sip:+33639980003@${domain}>;tag=${token()}`,
        `To: <sip:${number}@${domain}>${toTag ? `;tag=${toTag}` : ''}`,
        `Call-ID: ${callId}`,
        `CSeq: 1 ${method}`,
        `Contact: <sip:operator@${address}>`,
        'Content-Length: 0',
        '',
        ''
      ].join('\r\n')
      await send(text)
      return response(callId, `1 ${method}`, r => r.status >= 200, `the answer to ${method}`)
    },
    close() {
      for (const c of [...dialogs.values(), ...placed.values()]) c.media.stop()
      return new Promise(resolve => socket.close(resolve))
    }
  }
}
