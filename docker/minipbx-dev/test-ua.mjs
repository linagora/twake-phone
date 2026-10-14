// Minimal SIP-over-WSS user agent for tests: registers, rings, auto-answers INVITEs.
// Signalling only: the SDP is syntactically valid but no DTLS/RTP media is exchanged.
import { createHash, randomUUID } from 'node:crypto'

const md5 = s => createHash('md5').update(s).digest('hex')
const rid = n => randomUUID().replaceAll('-', '').slice(0, n)
const parse = raw => {
  const [head, body = ''] = raw.split('\r\n\r\n')
  const lines = head.split('\r\n')
  const headers = {}
  const vias = []
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':')
    const k = l.slice(0, i).trim().toLowerCase()
    if (k === 'via' || k === 'v') vias.push(l.slice(i + 1).trim())
    else headers[k] = l.slice(i + 1).trim()
  }
  return { start: lines[0], headers, vias, body }
}

export class TestUa {
  constructor({ user, secret, url = 'wss://127.0.0.1:8089/ws', answerDelayMs = 200 }) {
    Object.assign(this, { user, secret, url, answerDelayMs })
    this.host = new URL(url).hostname
    this.contact = `sip:${rid(8)}@${rid(8)}.invalid;transport=ws`
    this.tag = rid(8)
    this.callId = randomUUID()
    this.cseq = 0
    this.invites = []
    this.byes = []
  }

  send(msg) { this.ws.send(msg) }

  register() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, 'sip')
      const timer = setTimeout(() => reject(new Error('register timeout')), 8000)
      this.ws.onerror = () => reject(new Error('ws error'))
      this.ws.onopen = () => this.sendRegister()
      this.ws.onmessage = ev => {
        const m = parse(String(ev.data))
        if (m.start.startsWith('SIP/2.0')) {
          const status = Number(m.start.split(' ')[1])
          if (status === 401 && !this.authed) {
            this.authed = true
            this.sendRegister(m.headers['www-authenticate'])
          } else if (status === 200) {
            clearTimeout(timer)
            this.ws.onmessage = e => this.onMessage(String(e.data))
            resolve()
          } else if (status >= 400) reject(new Error(`REGISTER ${status}`))
        }
      }
    })
  }

  sendRegister(challenge) {
    const uri = `sip:${this.host}`
    let auth = ''
    if (challenge) {
      const realm = /realm="([^"]+)"/.exec(challenge)[1]
      const nonce = /nonce="([^"]+)"/.exec(challenge)[1]
      const response = md5(`${md5(`${this.user}:${realm}:${this.secret}`)}:${nonce}:${md5(`REGISTER:${uri}`)}`)
      auth = `Authorization: Digest username="${this.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5\r\n`
    }
    this.send(
      `REGISTER ${uri} SIP/2.0\r\nVia: SIP/2.0/WSS ${rid(8)}.invalid;branch=z9hG4bK${rid(10)}\r\nMax-Forwards: 70\r\n` +
        `From: <sip:${this.user}@${this.host}>;tag=${this.tag}\r\nTo: <sip:${this.user}@${this.host}>\r\n` +
        `Call-ID: ${this.callId}\r\nCSeq: ${++this.cseq} REGISTER\r\nContact: <${this.contact}>;expires=300\r\n${auth}Content-Length: 0\r\n\r\n`
    )
  }

  reply(req, status, reason, { body = '', toTag } = {}) {
    const h = req.headers
    const to = toTag && !/tag=/.test(h.to) ? `${h.to};tag=${toTag}` : h.to
    this.send(
      `SIP/2.0 ${status} ${reason}\r\n${req.vias.map(v => `Via: ${v}`).join('\r\n')}\r\n` +
        `From: ${h.from}\r\nTo: ${to}\r\nCall-ID: ${h['call-id']}\r\nCSeq: ${h.cseq}\r\n` +
        (status === 200 && /INVITE/.test(h.cseq) ? `Contact: <${this.contact}>\r\n` : '') +
        (body ? `Content-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}` : 'Content-Length: 0\r\n\r\n')
    )
  }

  onMessage(raw) {
    const m = parse(raw)
    const method = m.start.split(' ')[0]
    if (method === 'INVITE') {
      this.invites.push(m)
      const toTag = rid(8)
      this.reply(m, 180, 'Ringing', { toTag })
      setTimeout(() => this.reply(m, 200, 'OK', { toTag, body: this.sdpAnswer(m.body) }), this.answerDelayMs)
    } else if (method === 'BYE' || method === 'CANCEL') {
      this.byes.push(m)
      this.reply(m, 200, 'OK')
    } else if (method === 'ACK' || m.start.startsWith('SIP/2.0')) {
      // nothing to do
    } else if (method === 'OPTIONS' || method === 'INFO' || method === 'NOTIFY') {
      this.reply(m, 200, 'OK')
    }
  }

  sdpAnswer(offer) {
    const ufrag = rid(4)
    const fp = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':')
    const mid = /a=mid:(\S+)/.exec(offer)?.[1] ?? '0'
    return [
      'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0',
      `a=group:BUNDLE ${mid}`,
      'm=audio 9 UDP/TLS/RTP/SAVPF 0', `a=mid:${mid}`, 'a=rtcp-mux', 'a=setup:active',
      `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${rid(24)}`, `a=fingerprint:sha-256 ${fp}`,
      'a=rtpmap:0 PCMU/8000', 'a=sendrecv', ''
    ].join('\r\n')
  }

  close() { this.ws?.close() }
}
