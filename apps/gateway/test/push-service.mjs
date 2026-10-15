// A push service for tests (RFC 8030), in place of those of the browsers (FCM, Mozilla, WNS, Apple): it takes the
// messages the Gateway sends over HTTPS (its own certificate, made here with the openssl command), checks their VAPID
// signature (RFC 8292) and decrypts them (aes128gcm, RFC 8291) as the browser would, with the keys of the
// subscriptions it hands out. A subscription marked gone answers 410, as a real service does for one the browser
// dropped.
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Agent, createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/** Decrypts an aes128gcm body (RFC 8188 with the keys of RFC 8291) for the browser of `ecdh` and `auth`. */
export const decryptPush = (body, { ecdh, auth }) => {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body[20]
  const serverKey = body.subarray(21, 21 + idlen)
  const records = body.subarray(21 + idlen)
  if (records.length > rs) throw new Error('more than one record')
  const shared = ecdh.computeSecret(serverKey)
  const prkKey = hmac(auth, shared)
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(records.subarray(records.length - 16))
  const padded = Buffer.concat([decipher.update(records.subarray(0, records.length - 16)), decipher.final()])
  // The last record ends with 0x02, then any padding of zeros.
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  if (padded[end] !== 2) throw new Error('not the last record')
  return padded.subarray(0, end).toString('utf8')
}

/**
 * Checks the `Authorization: vapid t=<JWT>, k=<key>` of a message for `audience` (the push service's origin): an
 * ES256 signature by `k`, the audience, an expiry within 24 hours, a subject. Returns the key and the claims.
 */
export const verifyVapid = (authorization, audience) => {
  const m = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? '')
  if (!m) throw new Error(`not a VAPID authorization: ${authorization}`)
  const [header, claims, signature] = m[1].split('.')
  const raw = Buffer.from(m[2], 'base64url')
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url') }, format: 'jwk' })
  if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'ES256') throw new Error('VAPID: not ES256')
  if (!verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) throw new Error('VAPID: bad signature')
  const c = JSON.parse(Buffer.from(claims, 'base64url').toString())
  const now = Date.now() / 1000
  if (c.aud !== audience) throw new Error(`VAPID: audience ${c.aud}, expected ${audience}`)
  if (!(c.exp > now && c.exp <= now + 24 * 3600 + 60)) throw new Error(`VAPID: expiry ${c.exp}`)
  if (!/^(mailto:|https:)/.test(c.sub ?? '')) throw new Error(`VAPID: subject ${c.sub}`)
  return { publicKey: m[2], claims: c }
}

/** Starts the service on the loopback. `agent`: an HTTPS agent that trusts its certificate (for the Gateway). */
export const startPushService = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'twakephone-push-'))
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' })
  if (made.status !== 0) throw new Error(`openssl could not make the push service's certificate: ${made.stderr}`)
  const cert = readFileSync(join(dir, 'cert.pem'))
  const key = readFileSync(join(dir, 'key.pem'))
  rmSync(dir, { recursive: true, force: true })
  const browsers = new Map()
  const messages = []
  const waiting = new Set()
  const server = createServer({ cert, key }, (req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const id = /^\/push\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')?.[1]
      const browser = id && browsers.get(id)
      if (req.method !== 'POST' || !browser) return void res.writeHead(404).end()
      if (browser.gone) return void res.writeHead(410).end()
      const message = { id, receivedAt: Date.now(), headers: req.headers, body: Buffer.concat(chunks) }
      try {
        message.vapid = verifyVapid(req.headers.authorization, origin)
        if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error(`content-encoding ${req.headers['content-encoding']}`)
        message.text = decryptPush(message.body, browser)
        message.data = JSON.parse(message.text)
      } catch (err) {
        message.error = err.message
      }
      messages.push(message)
      for (const w of waiting) w()
      res.writeHead(message.error ? 400 : 201).end()
    })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  return {
    origin,
    agent: new Agent({ ca: cert }),
    messages,
    /** A browser's subscription (what PushSubscription.toJSON() gives), and its keys, kept here to decrypt. */
    subscribe: () => {
      const id = randomBytes(12).toString('base64url')
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      const auth = randomBytes(16)
      browsers.set(id, { ecdh, auth, gone: false })
      return { id, endpoint: `${origin}/push/${id}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
    },
    /** The browser dropped this subscription: its service answers 410 from now on. */
    gone: id => void (browsers.get(id).gone = true),
    /** The first message for `id` that `match` accepts, once it came (`timeout` ms at most). */
    next: (id, match = () => true, timeout = 10_000) =>
      new Promise((resolve, reject) => {
        const look = () => {
          const m = messages.find(x => x.id === id && !x.taken && match(x))
          if (!m) return false
          m.taken = true
          waiting.delete(look)
          clearTimeout(timer)
          resolve(m)
          return true
        }
        const timer = setTimeout(() => {
          waiting.delete(look)
          reject(new Error(`no push for ${id} within ${timeout} ms (got ${JSON.stringify(messages.filter(x => x.id === id).map(x => x.data ?? x.error))})`))
        }, timeout)
        if (!look()) waiting.add(look)
      }),
    stop: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    })
  }
}
