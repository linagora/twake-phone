// A SIP phone of our own for the tests that need whole calls without a browser (apps/web/test/trunk.sip.mjs): an
// account of the platform over UDP (a desk phone, Linphone) or over a WebSocket (a browser's window: a ".invalid" host,
// RFC 7118), that registers, places calls (with an offer in the INVITE, or none: a late offer, RFC 3264) and answers
// them, keeps their dialogs (route set, remote target, CSeq), sends requests in them (BYE, re-INVITE, REFER...) and
// answers the ones it gets (BYE, OPTIONS, INFO, re-INVITE). Its SDP is plain RTP (G.711 A-law and DTMF events) on a
// port nothing listens to: the tests look at the signalling. `asleep` plays a phone put to sleep or gone without a
// word: it neither answers nor sends anything any more. No retransmissions of its own (the loopback loses nothing).
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

const md5 = text => createHash('md5').update(text).digest('hex')
const token = () => randomBytes(6).toString('hex')

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
const one = (msg, name) => msg?.headers.get(name)?.[0] ?? ''
const tagOf = value => /;tag=([^;>\s]+)/.exec(value)?.[1]
const routeSet = msg => [...(msg.headers.get('record-route') ?? [])].flatMap(v => v.split(/,\s*(?=<)/))
const targetOf = msg => /<([^>]+)>/.exec(one(msg, 'contact'))?.[1]
const sdpOf = (port, version = 1) =>
  ['v=0', `o=phone 1 ${version} IN IP4 127.0.0.1`, 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${port} RTP/AVP 8 101`, 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n')

const digest = (challenge, { user, password, method, uri }) => {
  const p = name => new RegExp(`${name}="([^"]*)"`, 'i').exec(challenge)?.[1]
  const ha1 = md5(`${user}:${p('realm')}:${password}`)
  const ha2 = md5(`${method}:${uri}`)
  const cnonce = token()
  const response = md5(`${ha1}:${p('nonce')}:00000001:${cnonce}:auth:${ha2}`)
  return `Digest username="${user}", realm="${p('realm')}", nonce="${p('nonce')}", uri="${uri}", response="${response}", qop=auth, nc=00000001, cnonce="${cnonce}", algorithm=MD5`
}

/**
 * The phone of account `user`: over UDP to `proxy` ("host:port"), or over the WebSocket `ws` (ws://...). `domain` is
 * the SIP domain and digest realm. To play LiveKit SIP (step 8): `from`, the user its calls name in the From (`user`
 * answers the challenge), and over UDP `bind` (the address it sends from, 127.0.0.1 by default) and `port`.
 */
export const sipPhone = async ({ proxy, ws, domain, user, password, from = user, bind = '127.0.0.1', port: bindPort = 0 }) => {
  const responses = []
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
        reject(new Error(`${user}: ${what} within ${timeoutMs} ms`))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })

  let send
  let via
  let contact
  let conn
  let udp
  if (ws) {
    const host = `${token()}.invalid`
    via = () => `SIP/2.0/WS ${host}`
    contact = `<sip:${user}@${host};transport=ws>`
    conn = new WebSocket(ws, { protocols: 'sip', headers: { Origin: new URL(ws).origin.replace(/^ws/, 'http') } })
    await new Promise((resolve, reject) => {
      conn.onopen = resolve
      conn.onerror = () => reject(new Error(`${user}: no WebSocket to ${ws}`))
    })
    conn.onerror = () => undefined
    conn.onmessage = e => onMessage(String(e.data))
    send = async text => {
      if (conn.readyState === WebSocket.OPEN) conn.send(text)
    }
  } else {
    const [proxyHost, proxyPort = '5060'] = proxy.split(':')
    udp = createSocket('udp4')
    await new Promise((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(bindPort, bind, resolve)
    })
    const { address, port } = udp.address()
    via = () => `SIP/2.0/UDP ${address}:${port}`
    contact = `<sip:${user}@${address}:${port}>`
    send = text => new Promise(resolve => udp.send(text, Number(proxyPort), proxyHost, () => resolve()))
    udp.on('message', buf => onMessage(buf.toString()))
  }
  const withBody = (lines, body = '', type = 'application/sdp') => [...lines, ...(body ? [`Content-Type: ${type}`] : []), `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n')

  // asleep: answers and sends nothing (a phone put to sleep, a window gone without a word). answerWith: how the calls
  // it gets are answered ("200 OK", "486 Busy Here"...), after a 180 and `answerDelayMs`. received: every request.
  const st = { asleep: false, answerWith: '200 OK', answerDelayMs: 200, received: [] }
  /** The calls of this phone, placed or received, by Call-ID: their dialog once answered. */
  const calls = new Map()
  const rtpPort = () => 40000 + Math.floor(Math.random() * 20000)

  const reply = (req, code, { tag, body = '', headers = [] } = {}) => {
    const lines = [`SIP/2.0 ${code}`]
    for (const v of req.headers.get('via') ?? []) lines.push(`Via: ${v}`)
    for (const rr of req.headers.get('record-route') ?? []) lines.push(`Record-Route: ${rr}`)
    const to = one(req, 'to')
    lines.push(`From: ${one(req, 'from')}`, `To: ${tag && !tagOf(to) ? `${to};tag=${tag}` : to}`, `Call-ID: ${one(req, 'call-id')}`, `CSeq: ${one(req, 'cseq')}`, `Contact: ${contact}`, ...headers)
    return send(withBody(lines, body))
  }

  const onMessage = text => {
    if (st.asleep) return
    const msg = parse(text)
    if (msg.status !== undefined) {
      responses.push(msg)
      changed()
      return
    }
    st.received.push(msg)
    const call = calls.get(one(msg, 'call-id'))
    if (msg.method === 'INVITE' && call && tagOf(one(msg, 'to'))) {
      // A re-INVITE: our same media, a new version; an offer of ours when it came without one (its answer in the ACK).
      call.reinvites.push(msg)
      call.version++
      void reply(msg, '200 OK', { body: sdpOf(call.rtpPort, call.version) })
    } else if (msg.method === 'INVITE' && !call) {
      const tag = token()
      const c = { callId: one(msg, 'call-id'), invite: msg, tag, state: 'ringing', rtpPort: rtpPort(), version: 1, reinvites: [], requests: [], acks: [], cseq: 100 }
      // As the UAS of this dialog: our tag in the To, the route set as received, the far end at its Contact.
      Object.assign(c, { local: `${one(msg, 'to')};tag=${tag}`, remote: one(msg, 'from'), route: routeSet(msg), target: targetOf(msg) })
      calls.set(c.callId, c)
      void reply(msg, '180 Ringing', { tag })
      setTimeout(() => {
        if (c.state !== 'ringing' || st.asleep) return
        const answer = st.answerWith
        c.state = answer.startsWith('200') ? 'answered' : 'refused'
        void reply(msg, answer, { tag, body: answer.startsWith('200') ? sdpOf(c.rtpPort) : '' })
        changed()
      }, st.answerDelayMs)
    } else if (msg.method === 'ACK') {
      call?.acks.push(msg)
    } else if (msg.method === 'CANCEL') {
      void reply(msg, '200 OK')
      if (call?.state === 'ringing') {
        call.state = 'cancelled'
        void reply(call.invite, '487 Request Terminated', { tag: call.tag })
      }
    } else if (msg.method === 'BYE') {
      void reply(msg, '200 OK')
      if (call) {
        call.requests.push(msg)
        call.state = 'ended'
      }
    } else {
      // OPTIONS (in a dialog: the proxy checking we are still there), INFO, NOTIFY...
      call?.requests.push(msg)
      void reply(msg, '200 OK')
    }
    changed()
  }

  const response = (callId, cseq, accept, what, timeoutMs = 15_000) =>
    until(what, () => {
      const i = responses.findIndex(r => one(r, 'call-id') === callId && one(r, 'cseq') === cseq && accept(r))
      return i < 0 ? undefined : responses.splice(i, 1)[0]
    }, timeoutMs)
  const final = r => r.status >= 200

  const registration = { callId: `reg-${token()}`, tag: token(), cseq: 0 }
  const registerFor = async expires => {
    const uri = `sip:${domain}`
    const head = (cseq, extra = []) => [`REGISTER ${uri} SIP/2.0`, `Via: ${via()};branch=z9hG4bK${token()};rport`, 'Max-Forwards: 70', `From: <sip:${user}@${domain}>;tag=${registration.tag}`, `To: <sip:${user}@${domain}>`, `Call-ID: ${registration.callId}`, `CSeq: ${cseq} REGISTER`, `Contact: ${contact}`, `Expires: ${expires}`, ...extra]
    let cseq = ++registration.cseq
    await send(withBody(head(cseq)))
    const challenge = await response(registration.callId, `${cseq} REGISTER`, final, 'the answer to REGISTER', 5_000)
    if (challenge.status !== 401) return challenge.status
    cseq = ++registration.cseq
    await send(withBody(head(cseq, [`Authorization: ${digest(one(challenge, 'www-authenticate'), { user, password, method: 'REGISTER', uri })}`])))
    return (await response(registration.callId, `${cseq} REGISTER`, final, 'the answer to REGISTER', 5_000)).status
  }

  /** A request of ours in the dialog of `call`: to its remote target, through its route set; resolves with the answer. */
  const inDialog = async (call, method, { body = '', extra = [], cseq } = {}) => {
    const n = cseq ?? ++call.cseq
    const lines = [`${method} ${call.target} SIP/2.0`, `Via: ${via()};branch=z9hG4bK${token()};rport`, 'Max-Forwards: 70', `From: ${call.local}`, `To: ${call.remote}`, `Call-ID: ${call.callId}`, `CSeq: ${n} ${method}`, `Contact: ${contact}`, ...call.route.map(r => `Route: ${r}`), ...extra]
    await send(withBody(lines, body))
    if (method === 'ACK') return undefined
    return response(call.callId, `${n} ${method}`, final, `the answer to our ${method}`)
  }

  /**
   * Calls `target` (`offer: false`: no SDP, a late offer whose answer goes in the ACK; `extra`: more headers; `body`
   * and `type`: another body than our SDP): resolves with the call once the final answer came (`call.final`), ACKed;
   * `call.provisional` lists the 1xx. `giveUpMs`: no final answer by then, the call is cancelled (CANCEL) and resolves
   * with `state` 'cancelled' and no `final` (its final answer, when it comes, is ACKed).
   */
  const dial = async (target, { offer = true, extra = [], timeoutMs = 30_000, body: otherBody, type, giveUpMs } = {}) => {
    const uri = `sip:${target}@${domain}`
    const callId = `phone-${token()}`
    const tag = token()
    const call = { callId, state: 'calling', rtpPort: rtpPort(), version: 1, reinvites: [], requests: [], acks: [], cseq: 1, local: `<sip:${from}@${domain}>;tag=${tag}`, remote: `<sip:${target}@${domain}>`, route: [], target: uri }
    calls.set(callId, call)
    const body = otherBody ?? (offer ? sdpOf(call.rtpPort) : '')
    const invite = (cseq, branch, more = []) => withBody([`INVITE ${uri} SIP/2.0`, `Via: ${via()};branch=${branch};rport`, 'Max-Forwards: 70', `From: ${call.local}`, `To: ${call.remote}`, `Call-ID: ${callId}`, `CSeq: ${cseq} INVITE`, `Contact: ${contact}`, ...extra, ...more], body, type)
    const ackFailure = (cseq, branch, answer) => send(withBody([`ACK ${uri} SIP/2.0`, `Via: ${via()};branch=${branch};rport`, 'Max-Forwards: 70', `From: ${call.local}`, `To: ${one(answer, 'to')}`, `Call-ID: ${callId}`, `CSeq: ${cseq} ACK`]))
    let branch = `z9hG4bK${token()}`
    /** The final answer to the INVITE of `cseq`, or undefined once `giveUpMs` passed (then cancelled). */
    const finalOf = async cseq => {
      const what = `the answer to the call to ${target}`
      if (giveUpMs === undefined) return response(callId, `${cseq} INVITE`, final, what, timeoutMs)
      const answer = await response(callId, `${cseq} INVITE`, final, what, giveUpMs).catch(() => undefined)
      if (answer) return answer
      const sent = branch
      await send(withBody([`CANCEL ${uri} SIP/2.0`, `Via: ${via()};branch=${sent};rport`, 'Max-Forwards: 70', `From: ${call.local}`, `To: ${call.remote}`, `Call-ID: ${callId}`, `CSeq: ${cseq} CANCEL`]))
      void response(callId, `${cseq} INVITE`, final, what, 90_000).then(late => ackFailure(cseq, sent, late), () => undefined)
      return undefined
    }
    await send(invite(1, branch))
    let answer = await finalOf(1)
    if (answer?.status === 407) {
      await ackFailure(1, branch, answer)
      branch = `z9hG4bK${token()}`
      call.cseq = 2
      await send(invite(2, branch, [`Proxy-Authorization: ${digest(one(answer, 'proxy-authenticate'), { user, password, method: 'INVITE', uri })}`]))
      answer = await finalOf(2)
    }
    call.provisional = responses.filter(r => one(r, 'call-id') === callId && r.status < 200).map(r => r.status)
    if (!answer) {
      call.state = 'cancelled'
      return call
    }
    call.final = answer
    if (answer.status >= 300) {
      await ackFailure(call.cseq, branch, answer)
      call.state = 'failed'
      return call
    }
    // As the UAC: the route set is the answer's Record-Route reversed, the far end its Contact.
    Object.assign(call, { state: 'answered', remote: one(answer, 'to'), route: routeSet(answer).reverse(), target: targetOf(answer) ?? uri })
    await inDialog(call, 'ACK', { cseq: call.cseq, body: offer ? '' : sdpOf(call.rtpPort) })
    changed()
    return call
  }

  return {
    user,
    st,
    /** The URI of our Contact: where requests in our dialogs must arrive. */
    contactUri: /<([^>]+)>/.exec(contact)[1],
    /** An offer of ours (plain RTP), for a body built by hand. */
    sdp: () => sdpOf(rtpPort()),
    calls,
    until,
    register: () => registerFor(300),
    dial,
    /** A request of ours in the dialog of `call` (BYE, INVITE with `body`, REFER with `extra`...): its final answer. */
    request: (call, method, options) => inDialog(call, method, options),
    /** Hangs up `call` (our BYE). */
    async hangup(call) {
      const answer = await inDialog(call, 'BYE')
      call.state = 'ended'
      return answer
    },
    /** The call whose INVITE `test` takes, once it came. */
    incoming: (test = () => true, timeoutMs = 15_000) => until('a call', () => [...calls.values()].find(c => c.invite && test(c.invite)), timeoutMs),
    /** Waits for `call` to reach `state` ('answered', 'ended'...). */
    callState: (call, state, timeoutMs = 15_000) => until(`the call in state ${state}`, () => call.state === state, timeoutMs),
    /** Over a WebSocket: the connection closes, as when the page reloads (the registration stays). */
    async drop() {
      await new Promise(resolve => {
        conn.onclose = resolve
        conn.close()
      })
    },
    /** Unregisters (unless asleep or dropped) and closes. */
    async close() {
      if (!st.asleep && (!conn || conn.readyState === WebSocket.OPEN)) await registerFor(0).catch(() => undefined)
      if (conn) conn.close()
      else await new Promise(resolve => udp.close(resolve))
    }
  }
}
