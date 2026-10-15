// A SIP operator for the trunk of the e2e (step 6, ADR 0016): what OVHcloud or any SIP trunk does, as far as the
// RFCs say, over UDP on this host. It is the registrar of the trunk (digest, 401) and challenges each call it is sent
// (407); it answers the OPTIONS of OpenSIPS's dispatcher; it answers the calls OpenSIPS sends it (180, then 200 with
// G.711 A-law) and places calls to the trunk's direct numbers, with media both ways: it sends an A-law tone over RTP
// and counts the RTP it receives. No retransmissions of its own (the loopback loses no datagram), one SDP per call.
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
const userOf = value => /sips?:([^@;>]+)@/.exec(value)?.[1] ?? ''
const tagOf = value => /;tag=([^;>\s]+)/.exec(value)?.[1]
const param = (header, name) => new RegExp(`${name}="([^"]*)"`, 'i').exec(header)?.[1]

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

const sdpFor = (port, sessionId) =>
  ['v=0', `o=operator ${sessionId} 1 IN IP4 127.0.0.1`, 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${port} RTP/AVP 8 101`, 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=ptime:20', 'a=sendrecv', ''].join('\r\n')

/** Where the far end wants its RTP, from its SDP; and the payload types it offers. */
const remoteMedia = sdp => {
  const host = /^c=IN IP4 (\S+)/m.exec(sdp)?.[1]
  const m = /^m=audio (\d+) (\S+) ([\d ]+)/m.exec(sdp)
  return host && m ? { host, port: Number(m[1]), proto: m[2], payloads: m[3].trim().split(' ').map(Number) } : undefined
}

/** One call's media: a socket of its own, a tone every 20 ms to the far end, the RTP received counted. */
const media = async () => {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  const stats = { sent: 0, received: 0, voiced: 0 }
  socket.on('message', buf => {
    if (buf.length < 12 || buf[0] >> 6 !== 2) return
    stats.received++
    // A-law silence is 0xD5 (and 0x55): a packet with other values carries sound.
    const payload = buf.subarray(12)
    if (payload.some(b => b !== 0xd5 && b !== 0x55)) stats.voiced++
  })
  let timer
  const ssrc = randomBytes(4).readUInt32BE(0)
  let seq = Math.floor(Math.random() * 1000)
  let ts = Math.floor(Math.random() * 100000)
  return {
    port: socket.address().port,
    stats,
    start(to) {
      if (timer || !to) return
      timer = setInterval(() => {
        const header = Buffer.alloc(12)
        header[0] = 0x80
        header[1] = 8
        header.writeUInt16BE(seq++ & 0xffff, 2)
        header.writeUInt32BE(ts >>> 0, 4)
        header.writeUInt32BE(ssrc, 8)
        ts += 160
        socket.send(Buffer.concat([header, TONE]), to.port, to.host)
        stats.sent++
      }, 20)
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      try {
        socket.close()
      } catch {}
    }
  }
}

/**
 * The operator, on 127.0.0.1 (a random port unless `port`): `opensips` is OpenSIPS's trunk socket ("host:port"),
 * `user` and `password` the trunk's credentials, `realm` the realm of its challenges. `bind` another loopback
 * address plays someone who is not the operator.
 */
export const startOperator = async ({ opensips, user, password, realm = 'operator.example', domain = 'operator.example', bind = '127.0.0.1', port = 0, answerDelayMs = 300 }) => {
  const [osHost, osPort] = opensips.split(':')
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, bind, resolve)
  })
  const address = `${bind}:${socket.address().port}`
  const send = (text, host = osHost, p = Number(osPort)) => new Promise((resolve, reject) => socket.send(text, p, host, err => (err ? reject(err) : resolve())))
  const nonces = new Set()
  const challenge = () => {
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

  const state = { options: 0, registrations: [], invites: [], challenged: 0, refused: [] }
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
    const sent = /^SIP\/2\.0\/UDP ([\d.]+):?(\d+)?/.exec(via)
    return send(lines.join('\r\n'), received ?? sent?.[1] ?? osHost, Number(rport ?? sent?.[2] ?? 5060))
  }

  /** Calls OpenSIPS sent us, by Call-ID: the dialog's tag, our media, what we know of the far end. */
  const dialogs = new Map()
  /** Calls we placed, by Call-ID. */
  const placed = new Map()
  const responses = []

  socket.on('message', async (buf, rinfo) => {
    const msg = parse(buf.toString())
    if (msg.status !== undefined) {
      responses.push(msg)
      changed()
      return
    }
    const callId = one(msg, 'call-id')
    switch (msg.method) {
      case 'OPTIONS':
        state.options++
        await reply(msg, '200 OK')
        break
      case 'REGISTER': {
        if (!authorized(one(msg, 'authorization'), 'REGISTER')) {
          await reply(msg, '401 Unauthorized', { headers: [`WWW-Authenticate: ${challenge()}`] })
          break
        }
        const expires = Number(/expires=(\d+)/i.exec(one(msg, 'contact'))?.[1] ?? one(msg, 'expires') ?? 3600)
        state.registrations.push({ aor: one(msg, 'to'), contact: one(msg, 'contact'), expires, from: `${rinfo.address}:${rinfo.port}` })
        await reply(msg, '200 OK', { headers: [`Expires: ${expires}`], toTag: token() })
        changed()
        break
      }
      case 'INVITE': {
        const known = dialogs.get(callId)
        if (known) {
          // A re-INVITE (hold): our same SDP.
          await reply(msg, '200 OK', { body: sdpFor(known.media.port, known.sessionId), toTag: known.tag })
          break
        }
        if (!authorized(one(msg, 'proxy-authorization'), 'INVITE')) {
          state.challenged++
          await reply(msg, '407 Proxy Authentication Required', { headers: [`Proxy-Authenticate: ${challenge()}`], toTag: token() })
          break
        }
        const call = { invite: msg, tag: token(), sessionId: Date.now(), media: await media(), far: remoteMedia(msg.body), state: 'ringing' }
        dialogs.set(callId, call)
        state.invites.push(call)
        changed()
        await reply(msg, '100 Trying')
        await reply(msg, '180 Ringing', { toTag: call.tag })
        setTimeout(async () => {
          if (call.state !== 'ringing') return
          call.state = 'answered'
          await reply(msg, '200 OK', { body: sdpFor(call.media.port, call.sessionId), toTag: call.tag })
          call.media.start(call.far)
          changed()
        }, answerDelayMs)
        break
      }
      case 'ACK':
        break
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
          call.state = 'ended'
          call.media.stop()
        }
        changed()
        break
      }
      default:
        await reply(msg, '200 OK')
    }
  })

  const response = (callId, cseq, accept, what, timeoutMs = 15_000) =>
    until(what, () => {
      const i = responses.findIndex(r => one(r, 'call-id') === callId && one(r, 'cseq') === cseq && accept(r))
      return i < 0 ? undefined : responses.splice(i, 1)[0]
    }, timeoutMs)

  return {
    address,
    state,
    /** Resolves once OpenSIPS registered (`count` times). */
    registered: (count = 1, timeoutMs = 30_000) => until(`${count} registration(s) of the trunk`, () => state.registrations.length >= count && state.registrations, timeoutMs),
    /** Resolves once OpenSIPS's dispatcher probed us (`count` OPTIONS). */
    probed: (count = 1, timeoutMs = 40_000) => until(`${count} OPTIONS from the dispatcher`, () => state.options >= count, timeoutMs),
    /** The next call OpenSIPS sends us that `test` takes (its INVITE, after the challenge), with its media. */
    invited: (test = () => true, timeoutMs = 20_000) => until('a call from OpenSIPS', () => state.invites.find(c => !c.seen && test(c.invite)), timeoutMs).then(c => ((c.seen = true), c)),
    /** Waits for `call` (one we received or placed) to reach `wanted` ('answered', 'ended', 'cancelled'). */
    callState: (call, wanted, timeoutMs = 20_000) => until(`the call in state ${wanted}`, () => call.state === wanted, timeoutMs),
    /**
     * Calls `number` at OpenSIPS (`ruri`: the Request-URI's user, the number by default; `from`: the caller's number):
     * resolves with the call, whose `final` is its final answer; on a 200 it ACKs and sends its media.
     */
    async call(number, { from = '+33639980002', ruri = number, timeoutMs = 30_000 } = {}) {
      const callId = `op-${token()}`
      const fromTag = token()
      const m = await media()
      const sessionId = Date.now()
      const uri = `sip:${ruri}@${opensips}`
      const branch = `z9hG4bK${token()}`
      const body = sdpFor(m.port, sessionId)
      const call = { callId, media: m, state: 'calling', provisional: [] }
      placed.set(callId, call)
      const head = (method, cseq, b, extra = []) =>
        [
          `${method} ${uri} SIP/2.0`,
          `Via: SIP/2.0/UDP ${address};branch=${b};rport`,
          'Max-Forwards: 70',
          `From: <sip:${from}@${domain}>;tag=${fromTag}`,
          `To: ${call.to ?? `<sip:${number}@${domain}>`}`,
          `Call-ID: ${callId}`,
          `CSeq: ${cseq} ${method}`,
          `Contact: <sip:operator@${address}>`,
          ...(call.route ?? []).map(r => `Route: ${r}`),
          ...extra
        ]
      const withBody = (lines, b = '') => [...lines, ...(b ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(b)}`, '', b].join('\r\n')
      await send(withBody(head('INVITE', 1, branch), body))
      call.final = response(callId, '1 INVITE', r => r.status >= 200, `the final answer to ${number}`, timeoutMs).then(async answer => {
        call.provisional = responses.filter(r => one(r, 'call-id') === callId && r.status < 200).map(r => r.status)
        if (answer.status >= 300) {
          await send(withBody(head('ACK', 1, branch)))
          call.state = 'failed'
          return answer
        }
        call.to = one(answer, 'to')
        // The route set of the dialog: the Record-Route of the answer, reversed (we are the caller).
        call.route = [...(answer.headers.get('record-route') ?? [])].flatMap(v => v.split(/,\s*(?=<)/)).reverse()
        call.remoteTarget = /<([^>]+)>/.exec(one(answer, 'contact'))?.[1]
        call.state = 'answered'
        await send(withBody(head('ACK', 1, `z9hG4bK${token()}`)))
        m.start(remoteMedia(answer.body))
        changed()
        return answer
      })
      call.final.catch(() => undefined)
      call.cancel = () => send(withBody(head('CANCEL', 1, branch)))
      call.hangup = async () => {
        const b = `z9hG4bK${token()}`
        await send(withBody(head('BYE', 2, b)))
        call.state = 'ended'
        m.stop()
        return response(callId, '2 BYE', r => r.status >= 200, 'the answer to our BYE')
      }
      return call
    },
    /** Sends any raw request to OpenSIPS's trunk socket and resolves with the final answer. */
    async raw(method, number) {
      const callId = `raw-${token()}`
      const text = [
        `${method} sip:${number}@${opensips} SIP/2.0`,
        `Via: SIP/2.0/UDP ${address};branch=z9hG4bK${token()};rport`,
        'Max-Forwards: 70',
        `From: <sip:+33639980003@${domain}>;tag=${token()}`,
        `To: <sip:${number}@${domain}>`,
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
