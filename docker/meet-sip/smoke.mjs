// Live check of Meet phone access against the dev stack (LiveKit + LiveKit SIP + the dev PBX).
//   node docker/meet-sip/smoke.mjs      (after `yarn build`)
// 1. dial-in setup: trunk + PIN-protected dispatch rule exist, the PBX reaches LiveKit SIP on 8000;
// 2. dial-out: LiveKit calls the PBX test extension 8888, which answers, and the phone shows up in the room.
import { spawnSync } from 'node:child_process'
import { LiveKitConferenceBridge } from '../../packages/conference-livekit/dist/index.js'

const fail = msg => {
  console.error('FAIL', msg)
  process.exit(1)
}
const room = `smoke-${Date.now().toString(36)}`
const bridge = new LiveKitConferenceBridge({
  url: process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880',
  apiKey: process.env.LIVEKIT_API_KEY ?? '9f3b2c7a8e6d4f1c',
  apiSecret: process.env.LIVEKIT_API_SECRET ?? '6a9d0a3f5e4b8c2f9a7d6e3c1b4f8a2e',
  dialInNumbers: [{ country: 'FR', e164: '8000' }],
  outboundAddress: 'pbx:5060'
})

const dialIn = await bridge.createDialIn({ id: room, tenantId: 'dev' })
if (!/^\d{6}$/.test(dialIn.pin ?? '')) fail(`no PIN: ${JSON.stringify(dialIn)}`)
console.log('dial-in ok: number', dialIn.numbers[0].e164, 'PIN', dialIn.pin)

// The PBX must be able to place the call towards LiveKit SIP (it answers and asks for the PIN).
const ari = `Basic ${Buffer.from(`${process.env.ARI_USER ?? 'twake'}:${process.env.ARI_PASSWORD ?? 'twake-dev'}`).toString('base64')}`
const originate = await fetch(`${process.env.ARI_URL ?? 'http://127.0.0.1:8088'}/ari/channels?endpoint=PJSIP/8000@livekit&app=smoke-meet&timeout=5`, { method: 'POST', headers: { authorization: ari } })
if (!originate.ok) fail(`ARI originate ${originate.status}: ${await originate.text()}`)
const channel = await originate.json()
await new Promise(r => setTimeout(r, 2500))
// The container logs go to stderr as well as stdout.
const logs = spawnSync('docker', ['logs', '--since', '30s', 'twake-dev-livekit-sip'], { encoding: 'utf8' })
const sip = `${logs.stdout}${logs.stderr}`
if (!/"sipTrunk": "ST_/.test(sip)) fail('LiveKit SIP did not accept a call from the PBX on the Twake trunk')
console.log('PBX -> LiveKit SIP ok')
await fetch(`${process.env.ARI_URL ?? 'http://127.0.0.1:8088'}/ari/channels/${channel.id}`, { method: 'DELETE', headers: { authorization: ari } }).catch(() => {})

const invited = await bridge.dialParticipant(room, '8888')
let found
for (let i = 0; i < 20 && !found; i++) {
  await new Promise(r => setTimeout(r, 500))
  found = (await bridge.listParticipants(room)).find(p => p.kind === 'phone')
}
if (!found) fail(`phone participant never joined room ${room} (invited ${invited.id})`)
console.log('dial-out ok: phone participant', found.id)

await bridge.disconnectParticipant(found.id)
await bridge.removeDialIn(room)
console.log('cleanup ok')
