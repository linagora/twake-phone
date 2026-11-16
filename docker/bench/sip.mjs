// The SIP of the load bench: just what REGISTER and a call need, with the retransmissions of RFC 3261 over UDP
// (Timer A for an INVITE, Timer E for the rest: T1 500 ms, doubling), which apps/web/test/sip-ua.mjs leaves out because
// the loopback of a test loses nothing. Under load it does lose datagrams, and a bench that does not resend measures
// its own losses. The retransmissions are counted (`endpoint.stats.retrans`): they are a symptom, not a result.
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

const md5 = text => createHash('md5').update(text).digest('hex')
const tok = () => randomBytes(6).toString('hex')
const T1 = 500
const T2 = 4000

export const parse = raw => {
  const sep = raw.indexOf('\r\n\r\n')
  const [first, ...lines] = (sep < 0 ? raw : raw.slice(0, sep)).split('\r\n')
  const headers = new Map()
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()])
  }
  const status = /^SIP\/2\.0 (\d{3})/.exec(first)
  const request = /^(\w+) (\S+) SIP\/2\.0$/.exec(first)
  return { first, headers, status: status ? Number(status[1]) : undefined, method: request?.[1], uri: request?.[2] }
}
export const one = (msg, name) => msg.headers.get(name)?.[0] ?? ''
const branchOf = msg => /;branch=([^;,\s]+)/i.exec(one(msg, 'via'))?.[1] ?? ''

/** The Authorization value that answers a digest (MD5, qop=auth) challenge. */
const digest = (challenge, { user, password, method, uri }) => {
  const p = name => new RegExp(`${name}="([^"]*)"`, 'i').exec(challenge)?.[1]
  const [realm, nonce] = [p('realm'), p('nonce')]
  const cnonce = tok()
  const response = md5(`${md5(`${user}:${realm}:${password}`)}:${nonce}:00000001:${cnonce}:auth:${md5(`${method}:${uri}`)}`)
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", qop=auth, nc=00000001, cnonce="${cnonce}", algorithm=MD5`
}

/**
 * A way to talk to OpenSIPS, over UDP (a socket of its own) or over a WebSocket as a browser's (RFC 7118: a ".invalid"
 * host, `transport=ws`, an Origin). `onRequest(msg, endpoint)` gets the requests that come (a callee's INVITE).
 */
export const endpoint = async ({ proxy, ws, onRequest }) => {
  const pending = new Map()
  const stats = { retrans: 0, sendErrors: 0 }
  // acks: the ACK of each call this endpoint placed, to send again when its 200 comes again (a lost ACK).
  const ep = { stats, acks: new Map() }
  const dispatch = text => {
    const msg = parse(text)
    if (msg.status === undefined) return onRequest?.(msg, ep)
    const wait = pending.get(branchOf(msg))
    if (wait) wait(msg)
    else if (msg.status === 200 && ep.acks.has(one(msg, 'call-id'))) ep.send(ep.acks.get(one(msg, 'call-id')))
  }
  if (ws) {
    const host = `${tok()}.invalid`
    const conn = new WebSocket(ws, { protocols: 'sip', headers: { Origin: new URL(ws).origin.replace(/^ws/, 'http') } })
    await new Promise((resolve, reject) => {
      conn.onopen = resolve
      conn.onerror = () => reject(new Error('no WebSocket'))
    })
    conn.onerror = () => undefined
    conn.onmessage = e => dispatch(String(e.data))
    Object.assign(ep, {
      reliable: true,
      via: `SIP/2.0/WS ${host}`,
      contactOf: user => `<sip:${user}@${host};transport=ws>`,
      send: text => conn.readyState === WebSocket.OPEN && conn.send(text),
      close: () => conn.close()
    })
  } else {
    const [host, port = '5060'] = proxy.split(':')
    const udp = createSocket('udp4')
    await new Promise((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(0, '127.0.0.1', resolve)
    })
    udp.on('error', () => stats.sendErrors++)
    udp.on('message', buf => dispatch(buf.toString()))
    const { address, port: own } = udp.address()
    Object.assign(ep, {
      reliable: false,
      via: `SIP/2.0/UDP ${address}:${own}`,
      contactOf: user => `<sip:${user}@${address}:${own}>`,
      send: text => udp.send(text, Number(port), host, err => err && stats.sendErrors++),
      close: () => udp.close()
    })
  }
  /**
   * Sends `text` (its top Via branch is `branch`) and resolves with its final answer, or undefined after `timeoutMs`.
   * Over UDP it is sent again at 500 ms, 1.5 s, 3.5 s... (Timer A, doubling; Timer E stops doubling at 4 s) until any
   * answer comes.
   */
  ep.tx = (text, branch, { invite = false, timeoutMs = 8000 } = {}) =>
    new Promise(resolve => {
      let delay = T1
      let resend
      const finish = answer => {
        clearTimeout(resend)
        clearTimeout(giveUp)
        pending.delete(branch)
        resolve(answer)
      }
      const giveUp = setTimeout(() => finish(undefined), timeoutMs)
      const again = () => {
        stats.retrans++
        ep.send(text)
        delay = invite ? delay * 2 : Math.min(delay * 2, T2)
        resend = setTimeout(again, delay)
      }
      pending.set(branch, msg => {
        if (msg.status >= 200) finish(msg)
        else clearTimeout(resend)
      })
      ep.send(text)
      if (!ep.reliable) resend = setTimeout(again, delay)
    })
  return ep
}

const request = (ep, method, uri, { callId, from, to, cseq, branch, contact, extra = [], body = '', route = [] }) =>
  [
    `${method} ${uri} SIP/2.0`,
    `Via: ${ep.via};branch=${branch};rport`,
    'Max-Forwards: 70',
    ...route.map(r => `Route: ${r}`),
    `From: ${from}`,
    `To: ${to}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
    ...(contact ? [`Contact: ${contact}`] : []),
    ...extra,
    ...(body ? ['Content-Type: application/sdp'] : []),
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n')
const newBranch = () => `z9hG4bK${tok()}`
const sdp = port => ['v=0', 'o=bench 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${port} RTP/AVP 8 101`, 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n')
const silentPort = () => 40000 + Math.floor(Math.random() * 20000)

/** The account `user` on `ep`: REGISTER (with the 401 round) and calls (with the 407 round). */
export const account = (ep, { user, password, domain }) => {
  const reg = { callId: `reg-${tok()}`, tag: tok(), cseq: 0 }
  const aor = `<sip:${user}@${domain}>`
  /** One REGISTER with its challenge: {status, ms} (status 0: no answer). `ms` counts from the first datagram. */
  const register = async expires => {
    const t0 = performance.now()
    const uri = `sip:${domain}`
    const send = async extra => {
      const cseq = ++reg.cseq
      const branch = newBranch()
      const text = request(ep, 'REGISTER', uri, { callId: reg.callId, from: `${aor};tag=${reg.tag}`, to: aor, cseq, branch, contact: ep.contactOf(user), extra: [`Expires: ${expires}`, ...extra] })
      return ep.tx(text, branch)
    }
    let answer = await send([])
    if (answer?.status === 401) answer = await send([`Authorization: ${digest(one(answer, 'www-authenticate'), { user, password, method: 'REGISTER', uri })}`])
    return { status: answer?.status ?? 0, ms: performance.now() - t0 }
  }

  /**
   * Calls `target` with an SDP offer, hangs up after `holdMs`. {status, ms} is the final answer to the INVITE and the
   * time to it (from the first INVITE, 407 round included); `bye` the status of the BYE's answer.
   */
  const call = async (target, holdMs) => {
    const uri = `sip:${target}@${domain}`
    const callId = `call-${tok()}`
    const from = `${aor};tag=${tok()}`
    const base = { callId, from, to: `<sip:${target}@${domain}>`, contact: ep.contactOf(user) }
    const body = sdp(silentPort())
    const t0 = performance.now()
    const invite = async (cseq, extra) => {
      const branch = newBranch()
      return { branch, answer: await ep.tx(request(ep, 'INVITE', uri, { ...base, cseq, branch, extra, body }), branch, { invite: true, timeoutMs: 10_000 }) }
    }
    let { branch, answer } = await invite(1, [])
    let cseq = 1
    if (answer?.status === 407) {
      ep.send(request(ep, 'ACK', uri, { ...base, to: one(answer, 'to'), cseq: 1, branch }))
      cseq = 2
      ;({ branch, answer } = await invite(2, [`Proxy-Authorization: ${digest(one(answer, 'proxy-authenticate'), { user, password, method: 'INVITE', uri })}`]))
    }
    const status = answer?.status ?? 0
    const ms = performance.now() - t0
    if (status >= 300 || status === 0) {
      if (status) ep.send(request(ep, 'ACK', uri, { ...base, to: one(answer, 'to'), cseq, branch }))
      return { status, ms }
    }
    // In the dialog: the route set is the Record-Route reversed, the far end its Contact.
    const route = (answer.headers.get('record-route') ?? []).flatMap(v => v.split(/,\s*(?=<)/)).reverse()
    const target2 = /<([^>]+)>/.exec(one(answer, 'contact'))?.[1] ?? uri
    const dialog = { ...base, to: one(answer, 'to'), route }
    const ack = request(ep, 'ACK', target2, { ...dialog, cseq, branch: newBranch(), contact: undefined })
    ep.send(ack)
    ep.acks.set(callId, ack)
    await new Promise(resolve => setTimeout(resolve, holdMs))
    const byeBranch = newBranch()
    const bye = await ep.tx(request(ep, 'BYE', target2, { ...dialog, cseq: cseq + 1, branch: byeBranch, contact: undefined }), byeBranch)
    ep.acks.delete(callId)
    return { status, ms, bye: bye?.status ?? 0 }
  }

  return { register, call }
}

/** What a callee does on `ep` for the requests of its calls: answers each INVITE at once, with its own tag, plain RTP. */
export const callee = () => {
  const replied = new Map()
  const acked = new Set()
  const reply = (req, code, { tag, body = '', contact } = {}) => {
    const to = one(req, 'to')
    const lines = [`SIP/2.0 ${code}`, ...(req.headers.get('via') ?? []).map(v => `Via: ${v}`), ...(req.headers.get('record-route') ?? []).map(v => `Record-Route: ${v}`)]
    lines.push(`From: ${one(req, 'from')}`, `To: ${tag && !/;tag=/.test(to) ? `${to};tag=${tag}` : to}`, `Call-ID: ${one(req, 'call-id')}`, `CSeq: ${one(req, 'cseq')}`)
    if (contact) lines.push(`Contact: ${contact}`)
    if (body) lines.push('Content-Type: application/sdp')
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body)
    return lines.join('\r\n')
  }
  return (req, ep) => {
    const key = `${branchOf(req)}${req.method}`
    if (req.method === 'ACK') return void acked.add(one(req, 'call-id'))
    // A request that comes again (a retransmission): the same answer again.
    if (replied.has(key)) return ep.send(replied.get(key))
    const user = /^sips?:([^@;]+)@/.exec(req.uri)?.[1] ?? ''
    const text = req.method === 'INVITE' ? reply(req, '200 OK', { tag: tok(), body: sdp(silentPort()), contact: ep.contactOf(user) }) : reply(req, '200 OK')
    replied.set(key, text)
    setTimeout(() => replied.delete(key), 40_000).unref()
    ep.send(text)
    // The 200 of an INVITE is resent until the ACK (RFC 3261 13.3.1.4), over UDP.
    if (req.method === 'INVITE' && !ep.reliable) {
      const callId = one(req, 'call-id')
      let delay = T1
      const again = () => {
        if (acked.delete(callId) || delay > T2) return
        ep.stats.retrans++
        ep.send(text)
        delay *= 2
        setTimeout(again, delay)
      }
      setTimeout(again, delay)
    }
  }
}
