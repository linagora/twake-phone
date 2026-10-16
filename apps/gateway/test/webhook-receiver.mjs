// A subscriber of TwakePhone's webhooks for the end-to-end tests (step 10a): it receives the deliveries on the loopback
// and checks each signature as an integrator would, from the documentation only (not with the Gateway's code):
// X-TwakePhone-Signature is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the secret>`, with a
// second `v1` for a day after a new secret (the one before): one of them matching is enough.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

/** Whether `header` signs `body` with `secret`, at most `toleranceSec` ago (a replayed old delivery is refused). */
export const verifySignature = (secret, header, body, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) => {
  if (typeof header !== 'string') return false
  const parts = header.split(',').map(kv => kv.trim().split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest()
  return parts.some(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? '') && timingSafeEqual(expected, Buffer.from(v, 'hex')))
}

/**
 * Listens on 127.0.0.1 (a free port unless given). `answer(n, delivery)`: the status of the n-th request (204 by
 * default). Each request is kept: its headers, raw body, parsed event, and whether its signature checks with
 * `receiver.secret` (set once the subscription shows it).
 */
export const startWebhookReceiver = async ({ port = 0, answer = () => 204 } = {}) => {
  const received = []
  const receiver = {
    secret: undefined,
    received,
    answer,
    url: '',
    /** The first delivery that `match` takes (event, delivery), waited for. */
    waitFor: async (match, what, timeoutMs = 15_000) => {
      const end = Date.now() + timeoutMs
      for (;;) {
        const found = received.find(d => match(d.event, d))
        if (found) return found
        if (Date.now() > end) throw new Error(`webhook receiver: no ${what} within ${timeoutMs} ms (got ${received.map(d => d.event?.type).join(', ') || 'nothing'})`)
        await new Promise(r => setTimeout(r, 50))
      }
    },
    stop: () => new Promise(resolve => server.close(() => resolve()))
  }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let event
      try {
        event = JSON.parse(body)
      } catch {
        event = undefined
      }
      const delivery = { at: Date.now(), method: req.method, path: req.url, headers: req.headers, body, event, verified: receiver.secret ? verifySignature(receiver.secret, req.headers['x-twakephone-signature'], body) : false }
      received.push(delivery)
      res.writeHead(receiver.answer(received.length, delivery)).end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  receiver.url = `http://127.0.0.1:${server.address().port}`
  return receiver
}
