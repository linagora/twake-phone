// A minimal SIP user agent over UDP (RFC 3261, no media), for what browsers cannot do in numbers in the SIP e2e:
// many windows of one extension, each answering as it is told. It registers with digest authentication (MD5, as
// auth_db challenges), places a call without SDP and reads its final answer, and as a window answers each INVITE
// with 180 then the final it was given. Nothing else: no dialog after a 2xx, no TCP, no retransmissions of its own
// (the loopback loses no datagram). OpenSIPS must be on this host: the UA binds to 127.0.0.1.
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
 * One user agent of `user` (an extension) with its SIP `password`, talking to OpenSIPS at `proxy` ("host:port").
 * `answer(final, delayMs)`: as a window, answers each INVITE with 180 then `final` ("603 Decline") after `delayMs`.
 */
export const sipUa = async ({ proxy, domain, user, password }) => {
  const [proxyHost, proxyPort = '5060'] = proxy.split(':')
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  const { address, port } = socket.address()
  const responses = []
  const waiters = new Set()
  /** The INVITEs this window received (one per call, retransmissions left out). */
  const invites = []
  let behaviour
  const send = text => new Promise((resolve, reject) => socket.send(text, Number(proxyPort), proxyHost, err => (err ? reject(err) : resolve())))
  const toTag = token()

  const reply = (req, code, { tag = true } = {}) => {
    const lines = [`SIP/2.0 ${code}`]
    for (const via of req.headers.get('via') ?? []) lines.push(`Via: ${via}`)
    for (const rr of req.headers.get('record-route') ?? []) lines.push(`Record-Route: ${rr}`)
    const to = one(req, 'to')
    lines.push(`From: ${one(req, 'from')}`, `To: ${tag && !/;tag=/i.test(to) ? `${to};tag=${toTag}` : to}`, `Call-ID: ${callIdOf(req)}`, `CSeq: ${cseqOf(req)}`)
    lines.push(`Contact: <sip:${user}@${address}:${port};transport=udp>`, 'Content-Length: 0', '', '')
    return send(lines.join('\r\n'))
  }

  socket.on('message', buf => {
    const msg = parse(buf.toString())
    if (msg.status !== undefined) {
      responses.push(msg)
      for (const w of waiters) w()
      return
    }
    if (msg.method === 'INVITE') {
      if (invites.some(i => callIdOf(i) === callIdOf(msg) && cseqOf(i) === cseqOf(msg))) return
      invites.push(msg)
      void reply(msg, '180 Ringing')
      if (behaviour) setTimeout(() => void reply(msg, behaviour.final), behaviour.delayMs)
    } else if (msg.method === 'CANCEL') {
      void reply(msg, '200 OK', { tag: false })
      const invite = invites.find(i => callIdOf(i) === callIdOf(msg))
      if (invite) void reply(invite, '487 Request Terminated')
    } else if (msg.method === 'BYE' || msg.method === 'OPTIONS') {
      void reply(msg, '200 OK')
    }
  })

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
      `Via: SIP/2.0/UDP ${address}:${port};branch=${branch};rport`,
      'Max-Forwards: 70',
      `From: <sip:${user}@${domain}>;tag=${fromTag}`,
      `To: ${to}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <sip:${user}@${address}:${port};transport=udp>`,
      ...extra,
      'Content-Length: 0',
      '',
      ''
    ].join('\r\n')

  const registerFor = async expires => {
    const uri = `sip:${domain}`
    const callId = `reg-${token()}`
    const fromTag = token()
    const base = { callId, fromTag, to: `<sip:${user}@${domain}>` }
    await send(request('REGISTER', uri, { ...base, cseq: 1, extra: [`Expires: ${expires}`] }))
    const challenge = await response(callId, '1 REGISTER', final, 5_000)
    if (challenge.status !== 401) return challenge.status
    const authorization = digest(challenge.headers.get('www-authenticate') ?? [], { user, password, method: 'REGISTER', uri })
    await send(request('REGISTER', uri, { ...base, cseq: 2, extra: [`Expires: ${expires}`, `Authorization: ${authorization}`] }))
    return (await response(callId, '2 REGISTER', final, 5_000)).status
  }

  return {
    user,
    invites,
    /** Registers this window: resolves with OpenSIPS's final status (200). */
    register: () => registerFor(300),
    answer(finalReply, delayMs = 300) {
      behaviour = { final: finalReply, delayMs }
    },
    /** Calls `target` and resolves with the final answer ("603 Decline"), after the ACK of a refusal. */
    async call(target, timeoutMs = 30_000) {
      const uri = `sip:${target}@${domain}`
      const callId = `call-${token()}`
      const fromTag = token()
      const base = { callId, fromTag, to: `<sip:${target}@${domain}>` }
      const ack = async (cseq, branch, answer) => send(request('ACK', uri, { ...base, cseq, branch, to: one(answer, 'to') }))
      let branch = `z9hG4bK${token()}`
      await send(request('INVITE', uri, { ...base, cseq: 1, branch }))
      let answer = await response(callId, '1 INVITE', final, 5_000)
      let cseq = 1
      if (answer.status === 407) {
        await ack(1, branch, answer)
        const authorization = digest(answer.headers.get('proxy-authenticate') ?? [], { user, password, method: 'INVITE', uri })
        branch = `z9hG4bK${token()}`
        cseq = 2
        await send(request('INVITE', uri, { ...base, cseq, branch, extra: [`Proxy-Authorization: ${authorization}`] }))
        answer = await response(callId, '2 INVITE', final, timeoutMs)
      }
      if (answer.status >= 300) await ack(cseq, branch, answer)
      else throw new Error(`${user}: the call to ${target} was answered (${answer.first}): this UA keeps no dialog`)
      return `${answer.status} ${answer.reason}`
    },
    /** Unregisters (Expires 0) and closes the socket. */
    async close() {
      await registerFor(0).catch(() => undefined)
      await new Promise(resolve => socket.close(resolve))
    }
  }
}
