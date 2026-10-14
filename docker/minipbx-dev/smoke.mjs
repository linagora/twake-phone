// Smoke test of the dev PBX: ARI reachable, and a SIP REGISTER over WSS (digest) succeeds.
// Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 node smoke.mjs   (self-signed dev cert)
import { createHash, randomUUID } from 'node:crypto'

const ARI = process.env.ARI_URL ?? 'http://127.0.0.1:8088'
const WSS = process.env.PBX_WSS ?? 'wss://127.0.0.1:8089/ws'
const user = process.env.SIP_USER ?? '101'
const secret = process.env.DEV_SIP_SECRET ?? 'dev-sip-secret'
const ariAuth = 'Basic ' + Buffer.from(`${process.env.ARI_USER ?? 'twake'}:${process.env.ARI_PASSWORD ?? 'twake-dev'}`).toString('base64')

const md5 = s => createHash('md5').update(s).digest('hex')
const fail = msg => { console.error('FAIL', msg); process.exit(1) }

const info = await fetch(`${ARI}/ari/asterisk/info`, { headers: { authorization: ariAuth } })
if (!info.ok) fail(`ARI ${info.status}`)
console.log('ARI ok')

const host = new URL(WSS).hostname
const callId = randomUUID()
const tag = randomUUID().slice(0, 8)
const register = (cseq, authHeader) => [
  `REGISTER sip:${host} SIP/2.0`,
  `Via: SIP/2.0/WSS ${randomUUID().slice(0, 8)}.invalid;branch=z9hG4bK${randomUUID().slice(0, 10)}`,
  'Max-Forwards: 70',
  `From: <sip:${user}@${host}>;tag=${tag}`,
  `To: <sip:${user}@${host}>`,
  `Call-ID: ${callId}`,
  `CSeq: ${cseq} REGISTER`,
  `Contact: <sip:${tag}@${randomUUID().slice(0, 8)}.invalid;transport=ws>;expires=60`,
  ...(authHeader ? [authHeader] : []),
  'Content-Length: 0', '', ''
].join('\r\n')

const ws = new WebSocket(WSS, 'sip')
const timer = setTimeout(() => fail('timeout'), 8000)
let step = 0
ws.onopen = () => ws.send(register(1))
ws.onmessage = ev => {
  const msg = String(ev.data)
  const status = msg.split(' ')[1]
  if (step === 0 && status === '401') {
    step = 1
    const realm = /realm="([^"]+)"/.exec(msg)[1]
    const nonce = /nonce="([^"]+)"/.exec(msg)[1]
    const uri = `sip:${host}`
    const response = md5(`${md5(`${user}:${realm}:${secret}`)}:${nonce}:${md5(`REGISTER:${uri}`)}`)
    ws.send(register(2, `Authorization: Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`))
  } else if (step === 1 && status === '200') {
    console.log(`REGISTER ${user} over WSS ok`)
    clearTimeout(timer); ws.close(); process.exit(0)
  } else if (step === 1) {
    fail(`unexpected SIP status ${status}`)
  }
}
ws.onerror = () => fail('websocket error')
