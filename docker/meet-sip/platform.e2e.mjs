// Integration test on the running Twake platform (no mocks): real Cozy tokens, the Telephony Gateway, Meet's
// backend (external API, native dial-in), LiveKit, LiveKit SIP and the dev PBX.
//   MEET_TELEPHONY_NUMBER=<number set in the stack's .env, default 8000> node docker/meet-sip/platform.e2e.mjs
// Needs the stack up, the docker/meet-sip compose applied and `yarn build` done.
import { spawnSync } from 'node:child_process'

const DOMAIN = process.env.BASE_DOMAIN ?? 'twake.local'
const GATEWAY = process.env.GATEWAY_URL ?? `https://telephony.${DOMAIN}`
if (DOMAIN.endsWith('.local')) process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0' // the stack's own CA, not trusted by Node

let failures = 0
const step = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}
const check = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, what, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${what}`)
}

// A real Cozy token of the user, like the one the Phone app sends (the Gateway asks that instance who it is).
const cozyToken = user => {
  const r = spawnSync('docker', ['exec', 'cozyt', 'cozy-stack', 'instances', 'token-cli', `${user}.${DOMAIN}`, 'io.cozy.settings'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`no token for ${user}: ${r.stderr}`)
  return r.stdout.trim()
}
const api = (user, token) => async (method, path, body) => {
  const res = await fetch(`${GATEWAY}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-cozy-instance': `https://${user}.${DOMAIN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : undefined }
}

const livekit = async (service, method, body) => {
  // Same signing as the Gateway, through the built package.
  const { LiveKitApi } = await import('../../packages/conference-livekit/dist/index.js')
  const lk = new LiveKitApi(process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY ?? '9f3b2c7a8e6d4f1c', process.env.LIVEKIT_API_SECRET ?? '6a9d0a3f5e4b8c2f9a7d6e3c1b4f8a2e')
  return lk.call(service, method, body)
}

const user1 = api('user1', cozyToken('user1'))
const user2 = api('user2', cozyToken('user2'))
let room
const events = []
let ws

console.log('Meet phone access, on the Twake platform')

await step('capabilities announce the conference bridge', async () => {
  const { status, json } = await user1('GET', '/capabilities')
  check(status === 200 && json.conference.dialIn && json.conference.dialOut, `got ${status} ${JSON.stringify(json?.conference)}`)
})

await step('user1 listens to the event stream', async () => {
  const { json } = await user1('POST', '/ws-ticket')
  ws = new WebSocket(`${GATEWAY.replace('https', 'wss')}/api/v1/ws?ticket=${json.ticket}`)
  ws.onmessage = e => events.push(JSON.parse(String(e.data)))
  await until(() => ws.readyState === 1, 'websocket open', 20)
})

await step('user1 creates a Meet room through the Gateway (Meet gives the PIN)', async () => {
  const { status, json } = await user1('POST', '/conferences', { create: true })
  check(status === 201, `status ${status} ${JSON.stringify(json)}`)
  room = json
  check(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(room.slug), `slug ${room.slug}`)
  check(room.url === `https://meet.${DOMAIN}/${room.slug}`, `url ${room.url}`)
  check(room.dialIn.numbers[0]?.e164 === (process.env.MEET_TELEPHONY_NUMBER ?? '8000') && /^\d{10}$/.test(room.dialIn.pin), `dialIn ${JSON.stringify(room.dialIn)}`)
})

await step('the same user reopens the room by its link and gets the same PIN', async () => {
  const { status, json } = await user1('POST', '/conferences', { slug: room.slug })
  check(status === 201 && json.meetingId === room.meetingId && json.dialIn.pin === room.dialIn.pin, `status ${status}`)
})

await step('another Twake user cannot see or take the room (Meet decides)', async () => {
  const adopt = await user2('POST', '/conferences', { slug: room.slug })
  check(adopt.status === 404, `adopt: ${adopt.status}`)
  const read = await user2('GET', `/conferences/${room.meetingId}`)
  check(read.status === 404, `read: ${read.status}`)
  const dial = await user2('POST', `/conferences/${room.meetingId}/participants`, { number: '8888' })
  check(dial.status === 404, `dial: ${dial.status}`)
})

let phone
await step('dial-out: the PBX test line answers and joins the room as a phone participant', async () => {
  const { status, json } = await user1('POST', `/conferences/${room.meetingId}/participants`, { number: '8888' })
  check(status === 202 && json.kind === 'phone', `status ${status} ${JSON.stringify(json)}`)
  phone = await until(async () => {
    const r = await user1('GET', `/conferences/${room.meetingId}`)
    return r.json.participants?.find(p => p.kind === 'phone')
  }, 'the phone participant in the room')
})

await step('the room is live, so Meet created its dial-in rule in LiveKit, with that PIN', async () => {
  // Meet creates the rule when LiveKit reports room_started (first participant) and removes it at room_finished.
  const rule = await until(async () => (await livekit('livekit.SIP', 'ListSIPDispatchRule', {})).items?.find(r => r.name === `SIP_${room.meetingId}`), 'Meet’s dispatch rule SIP_<room id>')
  const direct = rule.rule.dispatch_rule_direct
  check(direct.room_name === room.meetingId && direct.pin === room.dialIn.pin, `rule ${JSON.stringify(direct)}`)
})

await step('user1 receives the participant-joined event from LiveKit via the Gateway', async () => {
  await until(() => events.find(e => e.type === 'conference.participant.joined' && e.payload.participant.kind === 'phone'), 'conference.participant.joined')
})

await step('dial-in: the PBX reaches LiveKit SIP on the dial-in number and the call is accepted', async () => {
  const ari = `Basic ${Buffer.from('twake:twake-dev').toString('base64')}`
  const res = await fetch('http://127.0.0.1:8088/ari/channels?endpoint=PJSIP/8000@livekit&app=platform-e2e&timeout=5', { method: 'POST', headers: { authorization: ari } })
  check(res.ok, `ARI originate ${res.status}`)
  const channel = await res.json()
  await sleep(2500)
  const logs = spawnSync('docker', ['logs', '--since', '20s', 'twake-dev-livekit-sip'], { encoding: 'utf8' })
  check(/"toUser": "8000"/.test(`${logs.stdout}${logs.stderr}`) && /Accepting the call/.test(`${logs.stdout}${logs.stderr}`), 'LiveKit SIP did not accept the call')
  await fetch(`http://127.0.0.1:8088/ari/channels/${channel.id}`, { method: 'DELETE', headers: { authorization: ari } }).catch(() => {})
})

await step('an outside call on the line’s number (inbound route) reaches the PIN prompt of LiveKit SIP', async () => {
  const ari = `Basic ${Buffer.from('twake:twake-dev').toString('base64')}`
  const since = new Date().toISOString()
  const res = await fetch('http://127.0.0.1:8088/ari/channels?endpoint=Local/s@minipbx-inbound/n&app=platform-e2e&timeout=5', { method: 'POST', headers: { authorization: ari } })
  check(res.ok, `ARI originate ${res.status}`)
  const channel = await res.json()
  await sleep(3000)
  const logs = spawnSync('docker', ['logs', '--since', '10s', 'twake-dev-livekit-sip'], { encoding: 'utf8' })
  check(/"toUser": "8000"/.test(`${logs.stdout}${logs.stderr}`), `LiveKit SIP saw no call after ${since}`)
  await fetch(`http://127.0.0.1:8088/ari/channels/${channel.id}`, { method: 'DELETE', headers: { authorization: ari } }).catch(() => {})
})

await step('closing the panel keeps Meet’s dial-in rule, and the room can be reopened', async () => {
  const del = await user1('DELETE', `/conferences/${room.meetingId}`)
  check(del.status === 204, `delete ${del.status}`)
  const rules = await livekit('livekit.SIP', 'ListSIPDispatchRule', {})
  check(rules.items?.some(r => r.name === `SIP_${room.meetingId}`), 'Meet’s rule was removed')
  const again = await user1('POST', '/conferences', { slug: room.slug })
  check(again.status === 201 && again.json.dialIn.pin === room.dialIn.pin, `reopen ${again.status}`)
})

await step('user1 mutes, then removes the phone participant', async () => {
  const mute = await user1('POST', `/conferences/${room.meetingId}/participants/${encodeURIComponent(phone.id)}/mute`)
  check(mute.status === 204, `mute ${mute.status}`)
  const remove = await user1('DELETE', `/conferences/${room.meetingId}/participants/${encodeURIComponent(phone.id)}`)
  check(remove.status === 204, `remove ${remove.status}`)
  await until(async () => !(await user1('GET', `/conferences/${room.meetingId}`)).json.participants.some(p => p.kind === 'phone'), 'participant gone')
})

await step('user1 receives the participant-left event', async () => {
  await until(() => events.find(e => e.type === 'conference.participant.left'), 'conference.participant.left')
})

ws?.close()
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed')
process.exit(failures ? 1 : 0)
