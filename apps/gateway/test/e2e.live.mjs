// Live end-to-end test against the dev PBX (docker/docker-compose.dev.yml):
// Gateway REST/WS -> provider-asterisk -> ARI -> Asterisk -> two SIP/WSS test agents.
// Run: yarn build && NODE_TLS_REJECT_UNAUTHORIZED=0 node apps/gateway/test/e2e.live.mjs
import assert from 'node:assert/strict'
import { TestUa } from '../../../docker/minipbx-dev/test-ua.mjs'
import { buildApp } from '../dist/app.js'
import { ProviderRegistry } from '../dist/registry.js'

process.env.AUTH_MODE = 'dev'
process.env.DEV_USER_MAP = 'test1:104,test2:105'

const registry = new ProviderRegistry([
  {
    tenantId: 'dev',
    type: 'asterisk',
    config: {
      ari: { url: 'http://127.0.0.1:8088', user: 'twake', password: 'twake-dev', app: `twake-e2e-${process.pid}` },
      websocketUrl: 'wss://pbx.twake.local:8089/ws',
      originateContext: 'twake-ring',
      sipSecretFor: async () => 'dev-sip-secret'
    }
  }
])
const app = await buildApp(registry)
registry.startAll()
await app.listen({ port: 0 })
const port = app.server.address().port

const ua1 = new TestUa({ user: '104', secret: 'dev-sip-secret' })
const ua2 = new TestUa({ user: '105', secret: 'dev-sip-secret' })
await Promise.all([ua1.register(), ua2.register()])

const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = (user, method, path, body) =>
  fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { 'x-dev-user': user, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })

const listen = user =>
  new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?user=${user}`)
    const events = []
    ws.onmessage = e => events.push(JSON.parse(e.data))
    ws.onopen = () => resolve({ ws, events })
  })
const types = l => l.events.map(e => e.type)
const waitFor = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(100)
  }
  assert.fail(`timeout waiting for ${what}`)
}

await sleep(1500) // provider connects to ARI and seeds device states
// start from a clean state: a previous aborted run may have left DND set
for (const u of ['test1', 'test2']) await api(u, 'PUT', '/me/presence', { status: 'available' })
await sleep(500)
const l1 = await listen('test1')
const l2 = await listen('test2')

// capabilities and media session
const caps = await (await api('test1', 'GET', '/capabilities')).json()
assert.equal(caps.calling.transfer, false)
const session = await (await api('test1', 'GET', '/me/media-session')).json()
assert.equal(session.type, 'sip-webrtc')
assert.equal(session.username, '104')
console.log('capabilities + media session ok')

// test1 calls test2
const res = await api('test1', 'POST', '/calls', { target: '105' })
assert.equal(res.status, 201)
const call = await res.json()
await waitFor(() => types(l2).includes('call.connected') && types(l1).includes('call.connected'), 'both legs connected')
const inbound = l2.events.find(e => e.type === 'call.created').payload.call
assert.equal(inbound.direction, 'inbound')
assert.equal(inbound.remoteNumber, '104')
await waitFor(() => l1.events.some(e => e.type === 'presence.changed' && e.payload.presence.status === 'busy'), 'test1 busy')
await waitFor(() => l2.events.some(e => e.type === 'presence.changed' && e.payload.presence.status === 'busy'), 'test2 busy')
console.log('call connected, both BUSY (telephony)')

// hold / resume / hangup
assert.equal((await api('test1', 'POST', `/calls/${call.id}/hold`)).status, 204)
await waitFor(() => types(l1).includes('call.held'), 'call.held for the user who held')
assert.equal((await api('test1', 'POST', `/calls/${call.id}/resume`)).status, 204)
await waitFor(() => types(l1).includes('call.resumed'), 'call.resumed')
console.log('hold/resume ok')

assert.equal((await api('test1', 'POST', `/calls/${call.id}/hangup`)).status, 204)
await waitFor(() => types(l1).includes('call.ended') && types(l2).includes('call.ended'), 'call.ended both')
await waitFor(
  () => l1.events.filter(e => e.type === 'presence.changed').at(-1)?.payload.presence.status === 'available',
  'test1 available again'
)
console.log('hangup ok, presence back to AVAILABLE')

// DND is enforced by the PBX
assert.equal((await api('test2', 'PUT', '/me/presence', { status: 'dnd' })).status, 200)
await waitFor(() => l2.events.some(e => e.type === 'presence.changed' && e.payload.presence.status === 'dnd'), 'test2 dnd event')
const before = ua2.invites.length
const refused = await api('test1', 'POST', '/calls', { target: '105' })
assert.equal(refused.status, 486)
await sleep(1500)
assert.equal(ua2.invites.length, before, 'test2 phone must not ring while in DND')
await api('test2', 'PUT', '/me/presence', { status: 'available' })
await waitFor(() => l2.events.filter(e => e.type === 'presence.changed').at(-1)?.payload.presence.status === 'available', 'test2 available')
console.log('DND enforced ok')

// Idempotency: same key, same call
const k = { 'idempotency-key': 'abc' }
const r1 = await (await fetch(`http://127.0.0.1:${port}/api/v1/calls`, { method: 'POST', headers: { 'x-dev-user': 'test1', 'content-type': 'application/json', ...k }, body: JSON.stringify({ target: '105' }) })).json()
const r2 = await (await fetch(`http://127.0.0.1:${port}/api/v1/calls`, { method: 'POST', headers: { 'x-dev-user': 'test1', 'content-type': 'application/json', ...k }, body: JSON.stringify({ target: '105' }) })).json()
assert.equal(r1.id, r2.id)
await sleep(1500)
await api('test1', 'POST', `/calls/${r1.id}/hangup`)
console.log('idempotency ok')

l1.ws.close(); l2.ws.close(); ua1.close(); ua2.close()
await app.close()
console.log('E2E OK')
process.exit(0)
