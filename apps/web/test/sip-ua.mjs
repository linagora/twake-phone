// A minimal SIP user agent (RFC 3261, no media), for what browsers cannot do in numbers, or on purpose, in the SIP
// e2e: many windows of one extension, each answering as it is told, and windows whose WebSocket dies and comes back.
// Over UDP, or over a WebSocket as a browser's window (RFC 7118: a Contact on a ".invalid" host, `transport=ws`).
// It registers with digest authentication (MD5, as auth_db challenges), places a call without SDP (which it can
// cancel) and reads its final answer, and as a window answers each INVITE with 180 then the final it was given.
// Nothing else: no dialog after a 2xx, no retransmissions of its own (the loopback loses no datagram). OpenSIPS must
// be on this host: the UDP agent binds to 127.0.0.1.
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

const md5 = text => createHash('md5').update(text).digest('hex')
const token = () => randomBytes(8).toString('hex')

/** A SIP message: its first line, its headers (lower-case names, each with its values in order). */
const parse = raw => {
  const [head] = raw.split('\r\n\r\n')
  const [first, ...lines] = head.split('\r\n')
  const headers = new Map()
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()])
  }
  const status = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(first)
  return { raw, first, headers, ...(status ? { status: Number(status[1]), reason: status[2] } : { method: first.split(' ')[0] }) }
}
const one = (msg, name) => msg.headers.get(name)?.[0] ?? ''
const callIdOf = msg => one(msg, 'call-id')
const cseqOf = msg => one(msg, 'cseq')
/** The branch of the top Via: one per transaction of the proxy, the same for a retransmission and its CANCEL. */
const branchOf = msg => /;branch=([^;,\s]+)/i.exec(one(msg, 'via'))?.[1] ?? ''

/** The Authorization (or Proxy-Authorization) value answering an MD5 challenge. */
const digest = (challenges, { user, password, method, uri }) => {
  const challenge = challenges.find(c => !/algorithm=/i.test(c) || /algorithm="?MD5"?(,|$|\s)/i.test(c))
  if (!challenge) throw new Error(`no MD5 challenge in ${JSON.stringify(challenges)}`)
  const param = name => new RegExp(`${name}="([^"]*)"`, 'i').exec(challenge)?.[1]
  const realm = param('realm')
  const nonce = param('nonce')
  const ha1 = md5(`${user}:${realm}:${password}`)
  const ha2 = md5(`${method}:${uri}`)
  if (/qop="?[^"]*auth/i.test(challenge)) {
    const nc = '00000001'
    const cnonce = token()
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}", algorithm=MD5`
  }
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${md5(`${ha1}:${nonce}:${ha2}`)}", algorithm=MD5`
}

/**
 * One user agent of `user` (an extension) with its SIP `password`, talking to OpenSIPS at `proxy` ("host:port") over
 * UDP, or at `ws` (a ws:// URL) over a WebSocket. `answer(final, delayMs)`: as a window, answers each INVITE with 180
 * then `final` ("603 Decline") after `delayMs`. Over a WebSocket, `drop()` closes it as a tab put to sleep loses it
 * (the registration stays, on a connection OpenSIPS can no longer reach) and `reconnect()` comes back on a new one
 * with the same Contact and registration (Call-ID, next CSeq), as JsSIP does.
 */
export const sipUa = async ({ proxy, ws, domain, user, password }) => {
  const responses = []
  const waiters = new Set()
  /**
   * The INVITEs this window received: one per branch the proxy sent (retransmissions left out), so that the same call
   * sent twice to this window counts twice.
   */
  const invites = []
  let behaviour
  const toTag = token()

  const onMessage = text => {
    const msg = parse(text)
    if (msg.status !== undefined) {
      responses.push(msg)
      for (const w of waiters) w()
      return
    }
    if (msg.method === 'INVITE') {
      if (invites.some(i => branchOf(i) === branchOf(msg))) return
      invites.push(msg)
      void reply(msg, '180 Ringing')
      if (behaviour) setTimeout(() => void reply(msg, behaviour.final), behaviour.delayMs)
    } else if (msg.method === 'CANCEL') {
      void reply(msg, '200 OK', { tag: false })
      const invite = invites.find(i => branchOf(i) === branchOf(msg))
      if (invite) void reply(invite, '487 Request Terminated')
    } else if (msg.method === 'BYE' || msg.method === 'OPTIONS') {
      void reply(msg, '200 OK')
    }
  }

  let send
  let via
  let contact
  let conn
  let reopen
  let udp
  if (ws) {
    // A browser's window: a host of its own that resolves nowhere (OpenSIPS answers on the connection it came on).
    const host = `${token()}.invalid`
    via = () => `SIP/2.0/WS ${host}`
    contact = `<sip:${user}@${host};transport=ws>`
    const open = async () => {
      // OpenSIPS answers only a handshake with an Origin, as a browser's (Node's WebSocket takes headers of its own).
      const c = new WebSocket(ws, { protocols: 'sip', headers: { Origin: new URL(ws).origin.replace(/^ws/, 'http') } })
      await new Promise((resolve, reject) => {
        c.onopen = resolve
        c.onerror = () => reject(new Error(`${user}: no WebSocket to ${ws}`))
      })
      c.onerror = () => undefined
      c.onmessage = e => onMessage(String(e.data))
      return c
    }
    conn = await open()
    send = async text => conn.send(text)
    reopen = open
  } else {
    const [proxyHost, proxyPort = '5060'] = proxy.split(':')
    udp = createSocket('udp4')
    await new Promise((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(0, '127.0.0.1', resolve)
    })
    const { address, port } = udp.address()
    via = () => `SIP/2.0/UDP ${address}:${port}`
    contact = `<sip:${user}@${address}:${port};transport=udp>`
    send = text => new Promise((resolve, reject) => udp.send(text, Number(proxyPort), proxyHost, err => (err ? reject(err) : resolve())))
    udp.on('message', buf => onMessage(buf.toString()))
  }

  const reply = (req, code, { tag = true } = {}) => {
    const lines = [`SIP/2.0 ${code}`]
    for (const v of req.headers.get('via') ?? []) lines.push(`Via: ${v}`)
    for (const rr of req.headers.get('record-route') ?? []) lines.push(`Record-Route: ${rr}`)
    const to = one(req, 'to')
    lines.push(`From: ${one(req, 'from')}`, `To: ${tag && !/;tag=/i.test(to) ? `${to};tag=${toTag}` : to}`, `Call-ID: ${callIdOf(req)}`, `CSeq: ${cseqOf(req)}`)
    lines.push(`Contact: ${contact}`, 'Content-Length: 0', '', '')
    return send(lines.join('\r\n'))
  }

  /** The first response of `callId` to CSeq `cseq` that `accept` takes, within `timeoutMs`. */
  const response = (callId, cseq, accept, timeoutMs) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const i = responses.findIndex(r => callIdOf(r) === callId && cseqOf(r) === cseq && accept(r))
        if (i < 0) return
        const [found] = responses.splice(i, 1)
        done()
        resolve(found)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`${user}: no answer to ${cseq} of ${callId} within ${timeoutMs} ms`))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })
  const final = r => r.status >= 200

  const request = (method, uri, { callId, cseq, fromTag, to, branch = `z9hG4bK${token()}`, extra = [] }) =>
    [
      `${method} ${uri} SIP/2.0`,
      `Via: ${via()};branch=${branch};rport`,
      'Max-Forwards: 70',
      `From: <sip:${user}@${domain}>;tag=${fromTag}`,
      `To: ${to}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: ${contact}`,
      ...extra,
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n')

  // One registration, refreshed as a browser's is: the same Call-ID, the next CSeq.
  const registration = { callId: `reg-${token()}`, fromTag: token(), cseq: 0 }
  const registerFor = async expires => {
    const uri = `sip:${domain}`
    const base = { callId: registration.callId, fromTag: registration.fromTag, to: `<sip:${user}@${domain}>` }
    const first = ++registration.cseq
    await send(request('REGISTER', uri, { ...base, cseq: first, extra: [`Expires: ${expires}`] }))
    const challenge = await response(registration.callId, `${first} REGISTER`, final, 5_000)
    if (challenge.status !== 401) return challenge.status
    const authorization = digest(challenge.headers.get('www-authenticate') ?? [], { user, password, method: 'REGISTER', uri })
    const second = ++registration.cseq
    await send(request('REGISTER', uri, { ...base, cseq: second, extra: [`Expires: ${expires}`, `Authorization: ${authorization}`] }))
    return (await response(registration.callId, `${second} REGISTER`, final, 5_000)).status
  }

  /**
   * Calls `target` (`extra`: more headers, a Replaces); `final` resolves with the final answer ("603 Decline"), after
   * the ACK of a refusal, `cancel()` gives up while it rings, `provisional` lists the 1xx that came.
   */
  const dial = async (target, { timeoutMs = 30_000, extra = [] } = {}) => {
    const uri = `sip:${target}@${domain}`
    const callId = `call-${token()}`
    const fromTag = token()
    const base = { callId, fromTag, to: `<sip:${target}@${domain}>` }
    const ack = async (cseq, branch, answer) => send(request('ACK', uri, { ...base, cseq, branch, to: one(answer, 'to') }))
    let branch = `z9hG4bK${token()}`
    await send(request('INVITE', uri, { ...base, cseq: 1, branch, extra }))
    const first = await response(callId, '1 INVITE', final, 5_000)
    let cseq = 1
    let answered = Promise.resolve(first)
    if (first.status === 407) {
      await ack(1, branch, first)
      const authorization = digest(first.headers.get('proxy-authenticate') ?? [], { user, password, method: 'INVITE', uri })
      branch = `z9hG4bK${token()}`
      cseq = 2
      await send(request('INVITE', uri, { ...base, cseq, branch, extra: [...extra, `Proxy-Authorization: ${authorization}`] }))
      answered = response(callId, '2 INVITE', final, timeoutMs)
    }
    const started = Date.now()
    const ended = answered.then(async answer => {
      if (answer.status >= 300) await ack(cseq, branch, answer)
      else throw new Error(`${user}: the call to ${target} was answered (${answer.first}): this UA keeps no dialog`)
      return { answer: `${answer.status} ${answer.reason}`, afterMs: Date.now() - started }
    })
    const finalAnswer = ended.then(e => e.answer)
    // A call without an answer fails the step that waits on `ended` or `final`, not the process with the other one.
    finalAnswer.catch(() => undefined)
    return {
      callId,
      /** The final answer ("487 Request Terminated"). */
      final: finalAnswer,
      /** The final answer as received, its headers with it. */
      message: answered,
      /** The final answer and how long after the (authenticated) INVITE it came. */
      ended,
      provisional: () => responses.filter(r => callIdOf(r) === callId && r.status < 200).map(r => r.status),
      /** Gives up: CANCEL with the INVITE's branch (RFC 3261 9.1). */
      cancel: () => send(request('CANCEL', uri, { ...base, cseq, branch }).replace(/^Contact: .*\r\n/m, ''))
    }
  }

  return {
    user,
    invites,
    /** Registers this window, or renews its registration (the same Call-ID): resolves with OpenSIPS's final status (200). */
    register: () => registerFor(300),
    answer(finalReply, delayMs = 300) {
      behaviour = { final: finalReply, delayMs }
    },
    dial,
    /** Calls `target` and resolves with the final answer ("603 Decline"), after the ACK of a refusal. */
    call: async (target, timeoutMs = 30_000) => (await dial(target, { timeoutMs })).final,
    /** Over a WebSocket: the connection goes, the registration stays (OpenSIPS cannot reach this window any more). */
    async drop() {
      if (!conn) throw new Error('drop() is for a window over a WebSocket')
      const closed = conn
      await new Promise(resolve => {
        closed.onclose = resolve
        closed.close()
      })
    },
    /** Over a WebSocket: back on a new connection, the same Contact registered again (E_UL_CONTACT_UPDATE). */
    async reconnect() {
      if (!conn) throw new Error('reconnect() is for a window over a WebSocket')
      conn = await reopen()
      return registerFor(300)
    },
    /** Unregisters (Expires 0) and closes; a window whose WebSocket was dropped comes back to do so. */
    async close() {
      if (conn) {
        if (conn.readyState !== WebSocket.OPEN) conn = await reopen()
        await registerFor(0).catch(() => undefined)
        conn.close()
        return
      }
      await registerFor(0).catch(() => undefined)
      await new Promise(resolve => udp.close(resolve))
    }
  }
}
