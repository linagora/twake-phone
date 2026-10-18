import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTEXT, fakeWazo as fakeWazoOf, made } from '../test/fake-wazo.js'
import { MESSAGE_ID, WazoStopped, WazoVoicemail, holderKey as keyedWith, mailboxNumber, voicemailOf, type Fetch, type WebSocketLike } from './index.js'

/** The key of the prints of the holders, as the Gateway derives it from SECRETS_KEY (a fake one). */
const SECRET = Buffer.alloc(32, 7)
const holderKey = (userId: string) => keyedWith(SECRET, userId)
/** The number of a person's mailbox. */
const numberOf = (userId: string) => mailboxNumber(holderKey(userId))
const DAY = 86_400_000

/** Every fake Wazo made: none may have been asked for anything outside the rights. */
afterEach(() => {
  for (const state of made.splice(0)) expect(state.denied).toEqual([])
})
const fakeWazo = () => fakeWazoOf(numberOf)

/** wazo-websocketd as it spoke on the Docker stack: init, then the subscriptions and start, then the events. */
const fakeSockets = () => {
  const sockets: (WebSocketLike & { url: string; sent: unknown[]; event(name: string, data: unknown): void; drop(code?: number): void })[] = []
  const open = (url: string) => {
    const ws = {
      url,
      sent: [] as unknown[],
      onopen: null,
      onmessage: null as WebSocketLike['onmessage'],
      onclose: null as WebSocketLike['onclose'],
      onerror: null,
      send(data: string) {
        const msg = JSON.parse(data)
        ws.sent.push(msg)
        if (msg.op === 'start') queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ op: 'start', code: 0, data: { message: 'success' } }) }))
      },
      close() {
        ws.onclose?.({ code: 1000 })
      },
      event(name: string, data: unknown) {
        ws.onmessage?.({ data: JSON.stringify({ op: 'event', code: 0, data: { name, tenant_uuid: 'ignored', required_acl: 'events.users.x.voicemails', data } }) })
      },
      drop(code = 1006) {
        ws.onclose?.({ code })
      }
    }
    sockets.push(ws)
    queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ op: 'init', code: 0, data: { version: 2 } }) }))
    return ws
  }
  return { sockets, open }
}

const make = (over: Partial<ConstructorParameters<typeof WazoVoicemail>[0]> = {}) => {
  const wazo = fakeWazo()
  const ws = fakeSockets()
  const logs: string[] = []
  const vm = new WazoVoicemail({
    authUrl: 'http://wazo.test:9497/0.1',
    confdUrl: 'http://wazo.test:9486/1.1',
    calldUrl: 'http://wazo.test:9500/1.0',
    websocketdUrl: 'ws://wazo.test:9502/',
    username: 'twakephone',
    password: 'not-a-real-password',
    holderSecret: SECRET,
    fetch: wazo.fetch,
    webSocket: ws.open,
    reconnectMs: [5],
    logger: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
    ...over
  })
  return { vm, wazo, ws, logs }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
/** The bytes of a recording, read as the Gateway sends them on. */
const read = async (body: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = []
  for await (const part of body) parts.push(part)
  return new TextDecoder().decode(Buffer.concat(parts))
}
/** A clock the test moves. */
const clock = (start = Date.parse('2026-10-18T10:00:00.000Z')) => {
  const c = { at: start, now: () => c.at }
  return c
}
const until = async (fn: () => boolean, ms = 2_000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await tick(5)
  }
}
const jean = { extension: '102', userId: 'jean' }
const alice = { extension: '103', userId: 'alice' }

const writes = (wazo: ReturnType<typeof fakeWazo>) => wazo.state.requests.filter(r => !r.startsWith('GET') && r !== 'POST /0.1/token')

describe('WazoVoicemail, the mailboxes', () => {
  it("makes one mailbox per person, at a number of their own, in a context of its own, for a user that stands for them, reached at each extension they hold; and keeps it at the next sync", async () => {
    const { vm, wazo } = make()
    expect(vm.getStatus()).toBe('DISCONNECTED')
    const { boxes, failed } = await vm.syncMailboxes([
      { extension: '102', userId: 'jean', displayName: 'Jean Dupont' },
      { extension: '103', userId: 'alice' },
      { extension: '1103', userId: 'alice' },
      // Not a number Asterisk's mailboxes take: left out.
      { extension: 'alice.b', userId: 'bob' }
    ])
    expect(boxes).toEqual([
      { extension: '102', mailbox: `${numberOf('jean')}@${CONTEXT}` },
      { extension: '103', mailbox: `${numberOf('alice')}@${CONTEXT}` },
      { extension: '1103', mailbox: `${numberOf('alice')}@${CONTEXT}` }
    ])
    expect(failed).toBe(0)
    expect(vm.getStatus()).toBe('CONNECTED')
    expect(wazo.state.contexts).toMatchObject([{ label: 'TwakePhone', type: 'internal' }])
    // Their number: 0001 then 20 digits of their print, never an extension's (none starts with 0), never another's.
    expect(numberOf('jean')).toMatch(/^0001[0-9]{20}$/)
    expect(numberOf('jean')).not.toBe(numberOf('alice'))
    // Users and mailboxes carry nothing of the person but the print: no name, no extension.
    expect(wazo.state.users.map(u => [u.firstname, u.userfield])).toEqual([
      ['TwakePhone', holderKey('jean')],
      ['TwakePhone', holderKey('alice')]
    ])
    expect(wazo.state.voicemails.map(v => v.name)).toEqual(['TwakePhone', 'TwakePhone'])
    expect(JSON.stringify(wazo.state)).not.toContain('Dupont')
    // Nothing of the person's id in Wazo: a print of it keyed with a key Wazo never has, not the plain
    // hash that trying the directory's ids gives back.
    expect(holderKey('jean')).toMatch(/^twakephone:[0-9a-f]{40}$/)
    expect(holderKey('jean')).not.toBe(keyedWith(Buffer.alloc(32, 8), 'jean'))
    expect(holderKey('jean')).not.toContain(createHash('sha256').update('jean').digest('hex').slice(0, 40))
    expect(JSON.stringify(wazo.state)).not.toContain('"jean"')
    // Each mailbox has its bounds: 50 messages, 3 minutes each, 10 s of silence end one.
    expect(wazo.state.voicemails.map(v => [v.max_messages, v.options])).toEqual([
      [50, [['maxsecs', '180'], ['maxsilence', '10']]],
      [50, [['maxsecs', '180'], ['maxsilence', '10']]]
    ])
    expect(wazo.state.voicemails.map(v => [v.number, v.context, v.users.length])).toEqual([
      [numberOf('jean'), CONTEXT, 1],
      [numberOf('alice'), CONTEXT, 1]
    ])
    // Again: nothing written.
    const before = wazo.state.requests.length
    expect((await vm.syncMailboxes([{ extension: '1103', userId: 'alice' }, { extension: '103', userId: 'alice' }, { extension: '102', userId: 'jean', displayName: 'Jean Dupont' }])).boxes).toEqual(boxes)
    expect(wazo.state.requests.slice(before).filter(r => !r.startsWith('GET'))).toEqual([])
  })

  it('keeps a person their mailbox, messages and all, when they take another extension, and when two swap theirs: no mailbox ever changes number, Wazo moves nothing in its spool', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.boxOf('jean')!
    const alices = wazo.boxOf('alice')!
    wazo.state.messages.get(jeans.id)!.push(wazo.msg('1-1'))
    wazo.state.messages.get(alices.id)!.push(wazo.msg('2-2', { caller_id_num: '104' }))
    const before = writes(wazo).length
    // Jean takes 104: his mailbox is reached there, the same one, untouched.
    expect((await vm.syncMailboxes([{ extension: '104', userId: 'jean' }, alice])).boxes).toEqual([
      { extension: '103', mailbox: `${numberOf('alice')}@${CONTEXT}` },
      { extension: '104', mailbox: `${numberOf('jean')}@${CONTEXT}` }
    ])
    expect((await vm.listMessages({ extension: '104', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
    // Jean and Alice swap: each one's messages are theirs.
    await vm.syncMailboxes([
      { extension: '103', userId: 'jean' },
      { extension: '104', userId: 'alice' }
    ])
    expect((await vm.listMessages({ extension: '103', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
    expect((await vm.listMessages({ extension: '104', userId: 'alice' })).map(m => m.id)).toEqual(['2-2'])
    // The whole plan renumbered: everyone still holds an extension, nothing held back.
    const res = await vm.syncMailboxes([
      { extension: '203', userId: 'jean' },
      { extension: '204', userId: 'alice' }
    ])
    expect([res.heldBack, res.failed, res.boxes.map(b => b.extension)]).toEqual([undefined, 0, ['203', '204']])
    expect([wazo.boxOf('jean')!.id, wazo.boxOf('alice')!.id]).toEqual([jeans.id, alices.id])
    expect(wazo.state.voicemails).toHaveLength(2)
    expect(wazo.state.users).toHaveLength(2)
    expect(wazo.state.moves).toEqual([])
    // Not one write to Wazo for all of it: where a mailbox is reached is the SIP server's (wazo-confd reloads Asterisk
    // at each change of a user or a mailbox).
    expect(writes(wazo).slice(before)).toEqual([])
  })

  it("gives the new holder of an extension their own mailbox, never the previous holder's, whose mailbox is set aside with its messages: nobody hears another's", async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.boxOf('jean')!
    wazo.state.messages.get(jeans.id)!.push(wazo.msg('1792289524-00000004', { caller_id_name: 'Alice', timestamp: 1792289524, duration: 7 }))
    expect(await vm.listMessages(jean)).toHaveLength(1)
    // 102 goes to Marie: before the next sync her Gateway already says so; she has no mailbox yet, Jean's is not hers.
    const marie = { extension: '102', userId: 'marie' }
    expect(await vm.owns(marie)).toBe(false)
    expect(await vm.listMessages(marie)).toEqual([])
    expect(await vm.getRecording(marie, '1792289524-00000004')).toBeUndefined()
    expect(await vm.markRead(marie, '1792289524-00000004')).toBe(false)
    expect(await vm.deleteMessage(marie, '1792289524-00000004')).toBe(false)
    // Then the sync; Alice leaves too. Marie's own mailbox at 102; Jean's and Alice's set aside, their messages kept.
    expect((await vm.syncMailboxes([marie])).boxes).toEqual([{ extension: '102', mailbox: `${numberOf('marie')}@${CONTEXT}` }])
    expect(wazo.boxOf('marie')!.id).not.toBe(jeans.id)
    expect(await vm.listMessages(marie)).toEqual([])
    expect(await vm.owns(marie)).toBe(true)
    expect(wazo.state.messages.get(jeans.id)).toHaveLength(1)
    expect([wazo.nameOf('jean'), wazo.nameOf('alice')]).toEqual([`TwakePhone aside ${Math.floor(time.at / 1000)}`, `TwakePhone aside ${Math.floor(time.at / 1000)}`])
    expect(wazo.state.moves).toEqual([])
  })

  it('keeps a mailbox set aside with its messages until the retention period deleted them, past the grace period too, and gives it back to its holder who comes back, at whatever extension', async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.boxOf('jean')!
    wazo.state.messages.get(jeans.id)!.push(wazo.msg('1-1', { timestamp: Math.floor(time.at / 1000) }))
    await vm.syncMailboxes([alice])
    // He comes back within the grace period, at 106: his mailbox, messages and all.
    time.at += 3 * DAY
    expect(wazo.nameOf('jean')).toMatch(/^TwakePhone aside \d+$/)
    await vm.syncMailboxes([alice, { extension: '106', userId: 'jean', displayName: 'Jean Dupont' }])
    expect([wazo.boxOf('jean')!.id, wazo.nameOf('jean')]).toEqual([jeans.id, 'TwakePhone'])
    expect((await vm.listMessages({ extension: '106', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
    // He leaves again: past the grace period (7 days), his message (not 30 days old) keeps the mailbox.
    await vm.syncMailboxes([alice])
    time.at += 8 * DAY
    await vm.syncMailboxes([alice])
    expect(wazo.state.messages.get(jeans.id)).toHaveLength(1)
    // The retention period deletes it (30 days): the mailbox goes at the next synchronisation, with its user.
    time.at += 20 * DAY
    expect(await vm.purgeMessages(new Date(time.at - 30 * DAY))).toBe(1)
    await vm.syncMailboxes([alice])
    expect(wazo.state.voicemails.map(v => v.number)).toEqual([numberOf('alice')])
    expect(wazo.state.users.map(u => u.userfield)).toEqual([holderKey('alice')])
  })

  it('holds back the mailboxes of more than two people gone at once, more than half of those reached, until it is said to be meant', async () => {
    const time = clock()
    const { vm, wazo, logs } = make({ now: time.now })
    const four = ['102', '103', '104', '105'].map((extension, i) => ({ extension, userId: `u${i}` }))
    await vm.syncMailboxes(four)
    // A directory that came back empty: nothing set aside, each mailbox still reached at its extension; said once.
    const held = await vm.syncMailboxes([])
    expect(held).toEqual({ boxes: four.map(h => ({ extension: h.extension, mailbox: `${numberOf(h.userId)}@${CONTEXT}` })), failed: 0, heldBack: { park: 4, of: 4 } })
    expect(four.map(h => wazo.nameOf(h.userId))).toEqual(four.map(() => 'TwakePhone'))
    await vm.syncMailboxes([])
    expect(logs.filter(l => /held back/.test(l))).toHaveLength(1)
    expect(logs.find(l => /held back/.test(l))).toMatch(/4 of 4 of people who hold no extension now \(0 new holder\(s\) without a mailbox meanwhile\)/)
    // It came back: nothing held any more.
    expect((await vm.syncMailboxes(four)).heldBack).toBeUndefined()
    // An administrator says they left, having seen four of four: what they saw goes, nothing
    // else. A release of another mass (three of four, four of five) lets nothing go: held back again, said.
    for (const release of [{ park: 3, of: 4 }, { park: 4, of: 5 }, { remove: 4, of: 4 }]) {
      const again = await vm.syncMailboxes([], { release })
      expect([again.heldBack, again.released]).toEqual([{ park: 4, of: 4 }, undefined])
    }
    expect(logs.filter(l => /release of .* not applied/.test(l))).toHaveLength(3)
    const letGo = await vm.syncMailboxes([], { release: { park: 4, of: 4 } })
    expect([letGo.boxes, letGo.released, letGo.heldBack]).toEqual([[], true, undefined])
    expect(four.every(h => wazo.nameOf(h.userId)!.startsWith('TwakePhone aside '))).toBe(true)
    // Past the grace period, the four would go at once, none reached: kept until said again, for that.
    time.at += 8 * DAY
    expect((await vm.syncMailboxes([])).heldBack).toEqual({ remove: 4, of: 0 })
    expect(wazo.state.voicemails).toHaveLength(4)
    expect((await vm.syncMailboxes([], { release: { park: 4, of: 0 } })).heldBack).toEqual({ remove: 4, of: 0 })
    expect(wazo.state.voicemails).toHaveLength(4)
    expect((await vm.syncMailboxes([], { release: { remove: 4, of: 0 } })).released).toBe(true)
    expect(wazo.state.voicemails).toEqual([])
  })

  it('takes where each mailbox is reached from the SIP server when it is given: a new Gateway holds back a mass gone all the same', async () => {
    const { vm, wazo } = make()
    const four = ['102', '103', '104', '105'].map((extension, i) => ({ extension, userId: `u${i}` }))
    const { boxes } = await vm.syncMailboxes(four)
    // A row of the SIP server is a person's at their number only.
    expect([vm.mailboxIsOf(boxes[0]!.mailbox, 'u0'), vm.mailboxIsOf(boxes[0]!.mailbox, 'u1')]).toEqual([true, false])
    // Another Gateway, which never synchronised: the SIP server says the four are reached; a directory that came back
    // empty sets none aside.
    const other = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    const held = await other.syncMailboxes([], { reached: boxes })
    expect([held.heldBack, held.boxes]).toEqual([{ park: 4, of: 4 }, boxes])
    expect(four.map(h => wazo.nameOf(h.userId))).toEqual(four.map(() => 'TwakePhone'))
    // Reached nowhere any more (the SIP server's rows gone, withdrawn while the round failed): held back all the same,
    // counted on the mailboxes in use (eighth review 11a, n°7).
    const unreached = await other.syncMailboxes([], { reached: [] })
    expect([unreached.heldBack, unreached.boxes]).toEqual([{ park: 4, of: 4 }, []])
    expect(four.map(h => wazo.nameOf(h.userId))).toEqual(four.map(() => 'TwakePhone'))
  })

  it('holds back the same people under new ids (an id attribute switched): nobody new given a mailbox, nothing set aside, until it is said or they come back (eighth review 11a, n°2)', async () => {
    const { vm, wazo } = make()
    const four = ['102', '103', '104', '105'].map((extension, i) => ({ extension, userId: `u${i}` }))
    await vm.syncMailboxes(four)
    wazo.state.messages.set(wazo.boxOf('u2')!.id, [wazo.msg('m-u2')])
    // The ids switched (uid to entryUUID): each extension given to a new id. No row stays at the old mailboxes.
    const renamed = four.map(h => ({ ...h, userId: `uuid-${h.userId}` }))
    for (let round = 0; round < 3; round++) {
      const held = await vm.syncMailboxes(renamed, { reached: [] })
      expect([held.heldBack, held.boxes]).toEqual([{ park: 4, of: 4 }, []])
    }
    expect(wazo.state.voicemails.map(v => v.name)).toEqual(four.map(() => 'TwakePhone'))
    // Switched back: each one's own again, messages and all.
    const back = await vm.syncMailboxes(four)
    expect([back.heldBack, back.boxes.map(b => b.extension)]).toEqual([undefined, ['102', '103', '104', '105']])
    expect(wazo.state.messages.get(wazo.boxOf('u2')!.id)).toHaveLength(1)
    // Said to be meant: set aside (theirs again if they come back), a mailbox of their own for each new id.
    await vm.syncMailboxes(renamed, { reached: [] })
    const letGo = await vm.syncMailboxes(renamed, { reached: [], release: { park: 4, of: 4 } })
    expect([letGo.released, letGo.boxes.map(b => b.extension)]).toEqual([true, ['102', '103', '104', '105']])
    expect(four.every(h => wazo.nameOf(h.userId)!.startsWith('TwakePhone aside '))).toBe(true)
    expect(wazo.state.messages.get(wazo.boxOf('u2')!.id)).toHaveLength(1)
    expect(renamed.map(h => wazo.nameOf(h.userId))).toEqual(four.map(() => 'TwakePhone'))
  })

  it('holds back from three people gone, and more than half: two of four go, three of six go, three of five wait', async () => {
    const outcome = async (total: number, leaving: number) => {
      const { vm, wazo } = make()
      const all = Array.from({ length: total }, (_, i) => ({ extension: String(110 + i), userId: `p${i}` }))
      await vm.syncMailboxes(all)
      const { heldBack } = await vm.syncMailboxes(all.slice(leaving))
      return [heldBack?.park ?? 0, wazo.state.voicemails.filter(v => v.name.startsWith('TwakePhone aside ')).length]
    }
    expect(await outcome(4, 2)).toEqual([0, 2])
    expect(await outcome(6, 3)).toEqual([0, 3])
    expect(await outcome(5, 3)).toEqual([3, 0])
    expect(await outcome(3, 3)).toEqual([3, 0])
  })

  it('sets aside at once the mailboxes of a few people whose extension someone else holds now, each newcomer their own; a mass of them is held back', async () => {
    const { vm, wazo } = make()
    const five = ['102', '103', '104', '105', '106'].map((extension, i) => ({ extension, userId: `o${i}` }))
    await vm.syncMailboxes(five)
    // Two others hold two of those extensions now: not a mass, each has their own mailbox there.
    const next = five.map((h, i) => (i < 2 ? { extension: h.extension, userId: `n${i}` } : h))
    const res = await vm.syncMailboxes(next)
    expect([res.heldBack, res.boxes.filter(b => ['102', '103'].includes(b.extension)).map(b => b.mailbox)]).toEqual([undefined, ['n0', 'n1'].map(u => `${numberOf(u)}@${CONTEXT}`)])
    expect(five.map(h => wazo.nameOf(h.userId)!.startsWith('TwakePhone aside '))).toEqual([true, true, false, false, false])
    // Three of the five others at once, not reached any more: counted on the mailboxes, held back (eighth review 11a, n°2).
    const mass = await vm.syncMailboxes(next.map((h, i) => (i >= 2 ? { extension: h.extension, userId: `n${i}` } : h)), { reached: [] })
    expect(mass.heldBack).toEqual({ park: 3, of: 5 })
    expect(five.slice(2).map(h => wazo.nameOf(h.userId))).toEqual(['TwakePhone', 'TwakePhone', 'TwakePhone'])
  })

  it('stops before its next change once it may no longer write, asked again once the token is in hand, and purges nothing more', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([jean])
    // It may write once more: Marie's user made, then nothing (no mailbox for her). Asked before the change, and
    // before each request of it.
    let allowed = 2
    const before = writes(wazo).length
    await expect(vm.syncMailboxes([{ extension: '102', userId: 'marie' }], { mayWrite: () => allowed-- > 0 })).rejects.toBeInstanceOf(WazoStopped)
    expect(writes(wazo).slice(before)).toEqual(['POST /1.1/users'])
    expect(wazo.boxOf('marie')).toBeUndefined()
    // Not at all: nothing written, not even the context of a first start.
    const fresh = make()
    await expect(fresh.vm.syncMailboxes([jean], { mayWrite: () => false })).rejects.toBeInstanceOf(WazoStopped)
    expect(writes(fresh.wazo)).toEqual([])
    // The purge likewise.
    const box = wazo.boxOf('jean')!
    wazo.state.messages.get(box.id)!.push(wazo.msg('1-1'))
    await expect(vm.purgeMessages(new Date(), { mayWrite: () => false })).rejects.toBeInstanceOf(WazoStopped)
    expect(wazo.state.messages.get(box.id)).toHaveLength(1)
    // The lease lost while wazo-auth gives a new token (Wazo refused the one it had, 401): not sent again.
    wazo.state.expireOn = 'DELETE /1.0/voicemails'
    wazo.state.tokenMs = 20
    let lease = true
    setTimeout(() => (lease = false), 10)
    await expect(vm.purgeMessages(new Date(), { mayWrite: () => lease })).rejects.toBeInstanceOf(WazoStopped)
    expect(wazo.state.requests.filter(r => r.startsWith('DELETE'))).toHaveLength(1)
    expect(wazo.state.messages.get(box.id)).toHaveLength(1)
  })

  it('bounds a write whole, its token and its retry after a 401 included, below the margin of the lease', async () => {
    const { vm, wazo } = make({ writeTimeoutMs: 120, requestTimeoutMs: 1_000 })
    await vm.syncMailboxes([jean])
    // A request of wazo-confd that takes 50 ms and is refused (401: its token expired), a token that takes 50 ms, the
    // request once more: 150 ms, past 120. Stopped there, nothing made.
    wazo.state.expireOn = 'POST /1.1/users'
    wazo.state.tokenMs = 50
    wazo.state.confdMs = 50
    const start = Date.now()
    await expect(vm.syncMailboxes([jean, { extension: '103', userId: 'marie' }])).rejects.toThrow(/voicemail server not reached/)
    expect(Date.now() - start).toBeLessThan(600)
    expect(wazo.boxOf('marie')).toBeUndefined()
    // Reads are bounded each on its own: a round of them longer than 120 ms passes.
    wazo.state.confdMs = 70
    expect((await vm.syncMailboxes([jean])).boxes).toHaveLength(1)
    expect(() => make({ writeTimeoutMs: 0 })).toThrow(/writeTimeoutMs/)
  })

  it("bounds the reading of a write's answer too, not only its head", async () => {
    const { wazo } = make()
    // wazo-confd answers the making of a user at once, and never sends the rest of its answer.
    const fetch: Fetch = async (url, init) => {
      const res = await wazo.fetch(url, init)
      if (init.method !== 'POST' || !url.endsWith('/1.1/users')) return res
      return { ...res, json: () => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason instanceof Error ? init.signal!.reason : new Error('aborted')))) }
    }
    const vm = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch, writeTimeoutMs: 100, requestTimeoutMs: 1_000, logger: { info() {}, warn() {}, error() {} } })
    const start = Date.now()
    await expect(vm.syncMailboxes([jean])).rejects.toThrow(/answer not read \(TimeoutError\)/)
    expect(Date.now() - start).toBeLessThan(600)
    expect(vm.getStatus()).toBe('DISCONNECTED')
  })

  it('removes the mailboxes aside past their grace period, without a message left, one by one when few go at once, the bound counted on those reached', async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now })
    const six = ['102', '103', '104', '105', '106', '107'].map((extension, i) => ({ extension, userId: `u${i}` }))
    await vm.syncMailboxes(six)
    // Three leave (three of six: not more than half), set aside.
    await vm.syncMailboxes(six.slice(3))
    time.at += 8 * DAY
    // Past the grace period, three would go against three mailboxes reached: more than half of those, held back.
    expect((await vm.syncMailboxes(six.slice(3))).heldBack).toEqual({ remove: 3, of: 3 })
    expect(wazo.state.voicemails).toHaveLength(6)
    // Two only: they go.
    const { vm: other, wazo: w2 } = make({ now: time.now })
    await other.syncMailboxes(six)
    time.at -= 8 * DAY
    await other.syncMailboxes(six.slice(2))
    time.at += 8 * DAY
    expect((await other.syncMailboxes(six.slice(2))).heldBack).toBeUndefined()
    expect(w2.state.voicemails.map(v => v.number).sort()).toEqual(six.slice(2).map(h => numberOf(h.userId)).sort())
    // Three against six reached: half, not more than half: they go; one with a message stays.
    const nine = ['102', '103', '104', '105', '106', '107', '108', '109', '110'].map((extension, i) => ({ extension, userId: `n${i}` }))
    const { vm: third, wazo: w3 } = make({ now: time.now })
    time.at -= 8 * DAY
    await third.syncMailboxes(nine)
    w3.state.messages.get(w3.boxOf('n0')!.id)!.push(w3.msg('9-9', { timestamp: Math.floor(time.at / 1000) }))
    await third.syncMailboxes(nine.slice(3))
    time.at += 8 * DAY
    expect((await third.syncMailboxes(nine.slice(3))).heldBack).toBeUndefined()
    expect(w3.state.voicemails.map(v => v.number).sort()).toEqual(['n0', ...nine.slice(3).map(h => h.userId)].map(numberOf).sort())
  })

  it('tells the SIP side the mailboxes already their holder\'s before it changes anything, at the extension they hold now', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([jean, alice])
    let seen: { boxes: unknown; writes: number } | undefined
    // 102 passes to Marie, Jean takes 105: before Marie's mailbox is made, Jean's (his at 105 already) and Alice's.
    const before = writes(wazo).length
    await vm.syncMailboxes([{ extension: '102', userId: 'marie' }, alice, { extension: '105', userId: 'jean' }], { beforeChanges: async boxes => void (seen = { boxes, writes: writes(wazo).length }) })
    expect(seen).toEqual({
      boxes: [
        { extension: '103', mailbox: `${numberOf('alice')}@${CONTEXT}` },
        { extension: '105', mailbox: `${numberOf('jean')}@${CONTEXT}` }
      ],
      writes: before
    })
    expect(writes(wazo).length).toBeGreaterThan(before)
  })

  it('leaves out a mailbox Wazo refuses to make, does the others, and asks again after a wait that grows', async () => {
    const time = clock()
    const { vm, wazo, logs } = make({ now: time.now })
    await vm.syncMailboxes([jean])
    wazo.state.refuseNumbers.add(numberOf('bob'))
    const two = [jean, { extension: '104', userId: 'bob' }]
    const res = await vm.syncMailboxes(two)
    expect([res.boxes.map(b => b.extension), res.failed]).toEqual([['102'], 1])
    expect(logs.some(l => /the mailbox of 104 not done/.test(l))).toBe(true)
    const tries = () => wazo.state.requests.filter(r => r === 'POST /1.1/voicemails').length
    const n = tries()
    // Within the minute: not asked again (still counted as not done); then once; then not before two more minutes.
    time.at += 30_000
    expect((await vm.syncMailboxes(two)).failed).toBe(1)
    expect(tries()).toBe(n)
    time.at += 31_000
    await vm.syncMailboxes(two)
    expect(tries()).toBe(n + 1)
    time.at += 61_000
    await vm.syncMailboxes(two)
    expect(tries()).toBe(n + 1)
    time.at += 60_000
    // Wazo takes it now: Bob has his.
    wazo.state.refuseNumbers.clear()
    const ok = await vm.syncMailboxes(two)
    expect([ok.boxes.map(b => b.extension), ok.failed, tries()]).toEqual([['102', '104'], 0, n + 2])
    // Ten refusals in a row: never more than an hour between two tries.
    wazo.state.refuseNumbers.add(numberOf('bob'))
    wazo.state.refuseNumbers.add(numberOf('zoe'))
    const zoe = [jean, { extension: '106', userId: 'zoe' }]
    const zoeTries = () => wazo.state.requests.filter(r => r === 'POST /1.1/voicemails').length
    for (let i = 0; i < 10; i++) {
      time.at += 3_600_001
      const t = zoeTries()
      await vm.syncMailboxes(zoe)
      expect(zoeTries()).toBe(t + 1)
    }
    time.at += 3_599_000
    await vm.syncMailboxes(zoe)
    const z = zoeTries()
    time.at += 2_000
    await vm.syncMailboxes(zoe)
    expect(zoeTries()).toBe(z + 1)
    wazo.state.refuseNumbers.clear()
    // A refusal to change one (its bounds) is left out too, the mailbox still reached.
    wazo.state.refuse.add(wazo.boxOf('jean')!.id)
    wazo.boxOf('jean')!.max_messages = 1
    const changed = await vm.syncMailboxes(two)
    expect([changed.boxes.map(b => b.extension), changed.failed]).toEqual([['102', '104'], 1])
  })

  it('makes one context only when two Gateways start at once, and one mailbox per person', async () => {
    const a = make()
    const b = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: a.wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    await Promise.all([a.vm.syncMailboxes([jean]), b.syncMailboxes([jean])].map(p => p.catch(() => undefined)))
    expect(a.wazo.state.contexts.map(c => c.name)).toEqual([CONTEXT])
    expect((await b.syncMailboxes([jean])).boxes).toEqual([{ extension: '102', mailbox: `${numberOf('jean')}@${CONTEXT}` }])
    expect(a.wazo.state.voicemails.map(v => [v.number, v.context])).toEqual([[numberOf('jean'), CONTEXT]])
  })

  it('sets the bounds of a mailbox again when they changed in Wazo, and takes them from its configuration', async () => {
    const { vm, wazo } = make({ maxMessages: 20, maxMessageSec: 120, maxSilenceSec: 5 })
    await vm.syncMailboxes([jean])
    const box = wazo.state.voicemails[0]!
    expect([box.max_messages, box.options]).toEqual([20, [['maxsecs', '120'], ['maxsilence', '5']]])
    box.max_messages = null
    box.options = []
    await vm.syncMailboxes([jean])
    expect([box.max_messages, box.options, box.number]).toEqual([20, [['maxsecs', '120'], ['maxsilence', '5']], numberOf('jean')])
    expect(() => make({ maxMessages: 0 })).toThrow(/maxMessages/)
    // A message longer than a call to a mailbox lasts: refused at the start.
    expect(() => make({ maxMessageSec: 600, maxCallSec: 300 })).toThrow(/longer than a call to a mailbox lasts/)
    expect(() => make({ maxMessageSec: 600 })).not.toThrow()
    expect(() => make({ holderSecret: Buffer.alloc(8) })).toThrow(/holderSecret/)
  })

  it("leaves Wazo's own users and mailboxes alone, and never gives anyone a mailbox at their number that is someone else's", async () => {
    const { vm, wazo, logs } = make()
    await vm.syncMailboxes([])
    // A user made in Wazo by hand, with a mailbox in the context of the platform at an extension; another at Jean's
    // number (made by hand too).
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000001', firstname: 'Admin', userfield: null, voicemail: { id: 900 } })
    wazo.state.voicemails.push({ id: 900, number: '102', context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000001' }] })
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000002', firstname: 'Other', userfield: holderKey('other'), voicemail: { id: 901 } })
    wazo.state.voicemails.push({ id: 901, number: numberOf('jean'), context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' }] })
    wazo.state.messages.set(900, [wazo.msg('0-0')])
    wazo.state.messages.set(901, [wazo.msg('0-1')])
    const res = await vm.syncMailboxes([jean, alice])
    expect([res.boxes.map(b => b.extension), res.failed]).toEqual([['103'], 1])
    expect(logs.some(l => /is someone else's: none for them/.test(l))).toBe(true)
    expect(await vm.listMessages(jean)).toEqual([])
    expect(await vm.owns(jean)).toBe(false)
    // Nor that very mailbox, at his number, when an event names it: its user stands for someone else.
    expect(await vm.owns({ ...jean, mailbox: '901' })).toBe(false)
    expect(wazo.state.voicemails.map(v => [v.id, v.number]).filter(([id]) => id === 900)).toEqual([[900, '102']])
  })

  it('renews its token before it expires and once more when Wazo says it did (401)', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([{ extension: '102', userId: 'jean' }])
    expect(wazo.state.tokens).toBe(1)
    wazo.state.expired.add('tok-1')
    expect(await vm.listMessages(jean)).toEqual([])
    expect(wazo.state.tokens).toBe(2)
  })

  it('says it is disconnected, and why in a few words, when Wazo cannot be reached or refuses its account; asked, it asks Wazo now', async () => {
    const down = make()
    down.wazo.state.down = true
    await expect(down.vm.syncMailboxes([])).rejects.toThrow(/voicemail server not reached/)
    expect(down.vm.getStatus()).toBe('DISCONNECTED')
    expect(down.vm.getStatusReason()).toMatch(/not reached/)
    // Back: a probe says so without any synchronisation.
    down.wazo.state.down = false
    await down.vm.probe()
    expect(down.vm.getStatus()).toBe('CONNECTED')
    expect(down.wazo.state.requests.at(-1)).toBe('GET /1.1/contexts')
    down.wazo.state.down = true
    await expect(down.vm.probe()).rejects.toThrow(/not reached/)
    expect(down.vm.getStatus()).toBe('DISCONNECTED')
    const refused = make({ password: 'wrong-password' })
    await expect(refused.vm.listMessages(jean)).rejects.toThrow(/refused the Gateway account/)
    expect(refused.vm.getStatus()).toBe('DISCONNECTED')
  })
})

describe('WazoVoicemail, the messages', () => {
  const withMessages = async () => {
    const t = make()
    await t.vm.syncMailboxes([
      { extension: '102', userId: 'jean' },
      { extension: '103', userId: 'alice' }
    ])
    const box = t.wazo.boxOf('jean')!
    t.wazo.state.messages.get(box.id)!.push(
      { id: '1792289400-00000001', folder: 2, caller_id_num: '+33612345678', caller_id_name: 'unknown', timestamp: 1792289400, duration: 12 },
      { id: '1792289524-00000004', folder: 1, caller_id_num: '101', caller_id_name: 'Alice Martin', timestamp: 1792289524, duration: 7 },
      { id: '1792289000-00000000', folder: 3, caller_id_num: 'anonymous', caller_id_name: null, timestamp: 1792289000, duration: 0 }
    )
    return { ...t, box }
  }

  it('lists the messages of the mailbox of the person, newest first, unread those not listened to', async () => {
    const { vm } = await withMessages()
    expect(await vm.listMessages(jean)).toEqual([
      { id: '1792289524-00000004', from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true },
      { id: '1792289400-00000001', from: '+33612345678', receivedAt: '2026-10-18T02:10:00.000Z', durationSec: 12, unread: false },
      // A caller who hid their number: no number, no name.
      { id: '1792289000-00000000', receivedAt: '2026-10-18T02:03:20.000Z', durationSec: 0, unread: true }
    ])
    expect(await vm.listMessages(alice)).toEqual([])
    // Someone without a mailbox, or no extension at all.
    expect(await vm.listMessages({ extension: '104', userId: 'bob' })).toEqual([])
    expect(await vm.listMessages({ extension: '../1', userId: 'jean' })).toEqual([])
  })

  it('gives the recording of a message of the mailbox of the person only', async () => {
    const { vm } = await withMessages()
    const rec = await vm.getRecording(jean, '1792289524-00000004')
    expect(rec?.contentType).toBe('audio/wav')
    expect(rec?.size).toBe(23)
    expect(await read(rec!.body)).toBe('RIFF1792289524-00000004')
    // Another's mailbox does not have it; an id that is no message id never reaches a URL.
    expect(await vm.getRecording(alice, '1792289524-00000004')).toBeUndefined()
    expect(await vm.getRecording(jean, '../../voicemails/2')).toBeUndefined()
    expect(MESSAGE_ID.test('1792289524-00000004')).toBe(true)
    expect(MESSAGE_ID.test('a/b')).toBe(false)
  })

  it('marks a message as read by moving it to the folder of those listened to, and deletes one, in its own mailbox only', async () => {
    const { vm, wazo, box } = await withMessages()
    expect(await vm.markRead(alice, '1792289524-00000004')).toBe(false)
    expect(await vm.markRead(jean, '1792289524-00000004')).toBe(true)
    expect(wazo.state.messages.get(box.id)!.find(m => m.id === '1792289524-00000004')!.folder).toBe(2)
    expect(wazo.state.requests.filter(r => r.startsWith('PUT /1.0'))).toEqual([`PUT /1.0/voicemails/${box.id}/messages/1792289524-00000004`])
    // Already read: nothing to move.
    expect(await vm.markRead(jean, '1792289524-00000004')).toBe(true)
    expect(wazo.state.requests.filter(r => r.startsWith('PUT /1.0'))).toHaveLength(1)
    expect(await vm.markRead(jean, 'nope')).toBe(false)
    expect(await vm.deleteMessage(alice, '1792289524-00000004')).toBe(false)
    expect(await vm.deleteMessage(jean, '1792289524-00000004')).toBe(true)
    expect(await vm.deleteMessage(jean, '1792289524-00000004')).toBe(false)
    expect((await vm.listMessages(jean)).map(m => m.id)).toEqual(['1792289400-00000001', '1792289000-00000000'])
  })

  it('finds the mailbox of a person another Gateway made since its last sync, whatever extension they hold', async () => {
    const { vm, wazo } = make()
    await vm.syncMailboxes([])
    // The same Wazo, a sync from elsewhere.
    await new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: wazo.fetch, logger: { info() {}, warn() {}, error() {} } }).syncMailboxes([{ extension: '102', userId: 'jean' }])
    const box = wazo.boxOf('jean')!
    wazo.state.messages.get(box.id)!.push(wazo.msg('1-1'))
    expect((await vm.listMessages({ extension: '105', userId: 'jean' })).map(m => m.id)).toEqual(['1-1'])
    expect(await vm.listMessages({ extension: '102', userId: 'marie' })).toEqual([])
  })
})

describe('WazoVoicemail, the bounds and the erasure of the messages', () => {
  const withMessage = async (over: Partial<ConstructorParameters<typeof WazoVoicemail>[0]> = {}) => {
    const t = make(over)
    await t.vm.syncMailboxes([jean, alice])
    const box = t.wazo.boxOf('jean')!
    t.wazo.state.messages.get(box.id)!.push({ id: '1792289524-00000004', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1792289524, duration: 7 })
    return { ...t, box }
  }

  it('refuses a recording larger than its bound before reading it, and cuts one that says nothing of its length', async () => {
    const { vm, wazo } = await withMessage({ maxRecordingBytes: 10 })
    await expect(vm.getRecording(jean, '1792289524-00000004')).rejects.toMatchObject({ status: 502, message: /larger than 10 bytes/ })
    wazo.state.noLength = true
    const rec = await vm.getRecording(jean, '1792289524-00000004')
    expect(rec?.size).toBeUndefined()
    await expect(read(rec!.body)).rejects.toMatchObject({ status: 502 })
    // Within its bound, whole.
    const { vm: ok } = await withMessage({ maxRecordingBytes: 23 })
    expect(await read((await ok.getRecording(jean, '1792289524-00000004'))!.body)).toBe('RIFF1792289524-00000004')
  })

  it('bounds a recording on the longest call to a mailbox, not on the longest message now', async () => {
    // Messages of 60 s now; one of 5 minutes left before (the call's bound) is still read; past the call's bound and
    // its margin, refused.
    const { vm, wazo } = await withMessage({ maxMessageSec: 60 })
    wazo.state.lengthSaid = 300 * 16_000 + 44
    expect((await vm.getRecording(jean, '1792289524-00000004'))?.size).toBe(300 * 16_000 + 44)
    wazo.state.lengthSaid = Math.ceil(300 * 16_000 * 1.5) + 65_537
    await expect(vm.getRecording(jean, '1792289524-00000004')).rejects.toMatchObject({ status: 502 })
    const { vm: longer, wazo: w2 } = await withMessage({ maxMessageSec: 60, maxCallSec: 900 })
    w2.state.lengthSaid = 900 * 16_000 + 44
    expect((await longer.getRecording(jean, '1792289524-00000004'))?.size).toBe(900 * 16_000 + 44)
  })

  it("erases every message of a person, in their mailbox set aside too, half made at their number, or another their user has, nobody else's", async () => {
    const { vm, wazo, box } = await withMessage()
    // Jean leaves: his mailbox is set aside, with his message. A second user of his print (made by hand) has a mailbox
    // of the context at another number.
    await vm.syncMailboxes([alice])
    expect(wazo.nameOf('jean')).toMatch(/^TwakePhone aside /)
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000009', firstname: 'TwakePhone', userfield: holderKey('jean'), voicemail: { id: 950 } })
    wazo.state.voicemails.push({ id: 950, number: '0999', context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000009' }] })
    wazo.state.messages.set(950, [wazo.msg('5-5')])
    const alices = wazo.boxOf('alice')!
    wazo.state.messages.get(alices.id)!.push(wazo.msg('3-3', { caller_id_num: '102' }))
    expect(await vm.eraseMessages({ userId: 'jean' })).toBe(2)
    expect(wazo.state.messages.get(box.id)).toEqual([])
    expect(wazo.state.messages.get(950)).toEqual([])
    expect(wazo.state.messages.get(alices.id)).toHaveLength(1)
    // A mailbox half made at Marie's number (its user never linked): hers, erased.
    wazo.state.voicemails.push({ id: 960, number: numberOf('marie'), context: CONTEXT, name: 'TwakePhone', max_messages: null, options: [], users: [] })
    wazo.state.messages.set(960, [wazo.msg('6-6'), wazo.msg('6-7')])
    expect(await vm.eraseMessages({ userId: 'marie' })).toBe(2)
    expect(wazo.state.messages.get(960)).toEqual([])
    // One at Carole's number whose user stands for someone else: not hers, left, said.
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000010', firstname: 'TwakePhone', userfield: holderKey('other'), voicemail: { id: 970 } })
    wazo.state.voicemails.push({ id: 970, number: numberOf('carole'), context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000010' }] })
    wazo.state.messages.set(970, [wazo.msg('7-7')])
    expect(await vm.eraseMessages({ userId: 'carole' })).toBe(0)
    expect(wazo.state.messages.get(970)).toHaveLength(1)
  })

  it('erases without ever making or changing a mailbox, reads only what is the person\'s, and stops once it may no longer write', async () => {
    const { vm, wazo, box } = await withMessage()
    // Someone with no mailbox, ten times: not one write to Wazo, and no whole read of its users or mailboxes.
    const asked = wazo.state.urls.length
    for (let i = 0; i < 10; i++) expect(await vm.eraseMessages({ userId: 'nobody' })).toBe(0)
    const urls = wazo.state.urls.slice(asked)
    expect(urls.filter(r => !r.startsWith('GET'))).toEqual([])
    expect(urls.every(r => /^GET \/1\.1\/(voicemails|users)\?recurse=false&search=/.test(r))).toBe(true)
    expect(wazo.boxOf('nobody')).toBeUndefined()
    // The lease lost: nothing deleted.
    await expect(vm.eraseMessages({ userId: 'jean' }, { mayWrite: () => false })).rejects.toBeInstanceOf(WazoStopped)
    expect(wazo.state.messages.get(box.id)).toHaveLength(1)
    expect(await vm.eraseMessages({ userId: 'jean' }, { mayWrite: () => true })).toBe(1)
  })

  it('deletes the messages older than the retention period, in every mailbox, those set aside included', async () => {
    const { vm, wazo, box, logs } = await withMessage()
    wazo.state.messages.get(box.id)!.push({ id: '1792300000-00000005', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: 1792300000, duration: 2 })
    await vm.syncMailboxes([alice])
    expect(await vm.purgeMessages(new Date(1792290000 * 1000))).toBe(1)
    expect(wazo.state.messages.get(box.id)!.map(m => m.id)).toEqual(['1792300000-00000005'])
    expect(logs.some(l => /1 message\(s\) older than the retention period deleted/.test(l))).toBe(true)
    // One without a date: not one of 1970, it stays, and it is said.
    wazo.state.messages.get(box.id)!.push({ id: '0-0', folder: 1, caller_id_num: '101', caller_id_name: null, timestamp: undefined as unknown as number, duration: 2 })
    expect(await vm.purgeMessages(new Date(1792290000 * 1000))).toBe(0)
    expect(wazo.state.messages.get(box.id)!.map(m => m.id)).toEqual(['1792300000-00000005', '0-0'])
    expect(logs.some(l => /1 message\(s\) without a date left out/.test(l))).toBe(true)
    // Every mailbox of the context, whatever its number (one made by hand at an extension); none of another context.
    wazo.state.voicemails.push({ id: 980, number: '108', context: CONTEXT, name: 'x', max_messages: null, options: [], users: [] })
    wazo.state.voicemails.push({ id: 981, number: '109', context: 'default', name: 'x', max_messages: null, options: [], users: [] })
    wazo.state.messages.set(980, [wazo.msg('8-8', { timestamp: 1 })])
    wazo.state.messages.set(981, [wazo.msg('8-9', { timestamp: 1 })])
    expect(await vm.purgeMessages(new Date(1792290000 * 1000))).toBe(1)
    expect([wazo.state.messages.get(980), wazo.state.messages.get(981)!.map(m => m.id)]).toEqual([[], ['8-9']])
  })

  it('removes a mailbox aside past its grace period with its messages when no retention period deletes them, its messages first', async () => {
    const time = clock()
    const { vm, wazo, logs } = make({ now: time.now })
    await vm.syncMailboxes([jean, alice, { extension: '104', userId: 'bob' }])
    const jeans = wazo.boxOf('jean')!
    wazo.state.messages.get(jeans.id)!.push(wazo.msg('1-1', { timestamp: Math.floor(time.at / 1000) }))
    await vm.syncMailboxes([alice, { extension: '104', userId: 'bob' }], { removeAsideWithMessages: true })
    // Within the grace period: kept, messages and all.
    time.at += 6 * DAY
    await vm.syncMailboxes([alice, { extension: '104', userId: 'bob' }], { removeAsideWithMessages: true })
    expect(wazo.boxOf('jean')).toBeDefined()
    // Past it: its message deleted through wazo-calld, then the mailbox and its user.
    time.at += 2 * DAY
    const before = wazo.state.requests.length
    await vm.syncMailboxes([alice, { extension: '104', userId: 'bob' }], { removeAsideWithMessages: true })
    expect(wazo.boxOf('jean')).toBeUndefined()
    expect(wazo.state.users.map(u => u.userfield)).toEqual([holderKey('alice'), holderKey('bob')])
    const done = wazo.state.requests.slice(before).filter(r => r.startsWith('DELETE'))
    expect(done[0]).toBe(`DELETE /1.0/voicemails/${jeans.id}/messages/1-1`)
    expect(done.at(-1)).toBe(`DELETE /1.1/voicemails/${jeans.id}`)
    expect(logs.some(l => /1 removed \(aside past the grace period, 1 message\(s\) with them: no retention period\)/.test(l))).toBe(true)
  })

  it('never removes a mailbox with its messages in the round that set it aside, whatever its grace period', async () => {
    const time = clock()
    const { vm, wazo } = make({ now: time.now, graceMs: 0 })
    await vm.syncMailboxes([jean, alice])
    const jeans = wazo.boxOf('jean')!
    wazo.state.messages.get(jeans.id)!.push(wazo.msg('1-1', { timestamp: Math.floor(time.at / 1000) }))
    // Jean between two extensions a round: his mailbox aside, his message kept; back, it is his again.
    await vm.syncMailboxes([alice], { removeAsideWithMessages: true })
    expect(wazo.boxOf('jean')?.name).toMatch(/^TwakePhone aside /)
    expect(wazo.state.messages.get(jeans.id)!.map(m => m.id)).toEqual(['1-1'])
    await vm.syncMailboxes([{ extension: '105', userId: 'jean' }, alice], { removeAsideWithMessages: true })
    expect([wazo.boxOf('jean')?.name, wazo.state.messages.get(jeans.id)!.map(m => m.id)]).toEqual(['TwakePhone', ['1-1']])
  })
})

describe('WazoVoicemail, the events', () => {
  it('renews its token at four fifths of its life while it hears the events, even when no request needs one', async () => {
    const { vm, wazo, ws } = make({ tokenTtlSec: 0.05 })
    await vm.syncMailboxes([])
    vm.subscribe()
    await tick(5)
    expect(wazo.state.tokens).toBe(1)
    // Several cycles: each renewal arms the next one, the WebSocket hears each token.
    await tick(200)
    expect(wazo.state.tokens).toBeGreaterThanOrEqual(4)
    for (const token of ['tok-2', 'tok-3', 'tok-4']) expect(ws.sockets[0]!.sent).toContainEqual({ op: 'token', data: { token } })
    await vm.close()
    const after = wazo.state.tokens
    await tick(60)
    expect(wazo.state.tokens).toBe(after)
  })

  it('tells nothing of a mailbox set aside', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([jean])
    const box = wazo.boxOf('jean')!
    await vm.syncMailboxes([])
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-1', message: { id: '1-1' } })
    await tick(5)
    const next = events.next()
    await vm.close()
    expect((await next).done).toBe(true)
  })

  it('tells a message as the extension its holder holds, whatever Gateway synchronised, and owns says whose mailbox it is', async () => {
    const a = make()
    await a.vm.syncMailboxes([jean])
    const jeans = a.wazo.boxOf('jean')!
    // The Gateway's directory, read at each event.
    const directory = [jean]
    const events = a.vm.subscribe({ holders: async () => directory })[Symbol.asyncIterator]()
    await tick(1)
    // Another Gateway: Jean moves from 102 to 105, Marie takes 102. This one heard nothing of it.
    const b = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: a.wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    await b.syncMailboxes([{ extension: '105', userId: 'jean' }, { extension: '102', userId: 'marie' }])
    directory.splice(0, directory.length, { extension: '105', userId: 'jean' }, { extension: '1105', userId: 'jean' }, { extension: '102', userId: 'marie' })
    const message = { caller_id_name: 'Alice Martin', caller_id_num: '101', timestamp: 1792289524, folder: { type: 'new', name: 'inbox', id: 1 }, duration: 7, id: '1792289524-00000004' }
    a.ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: jeans.id, message_id: message.id, message })
    const got = (await events.next()).value as { extension: string; mailbox: string }
    expect([got.extension, got.mailbox]).toEqual(['105', String(jeans.id)])
    expect(await a.vm.owns({ extension: '105', userId: 'jean', mailbox: got.mailbox })).toBe(true)
    // Marie, who holds 102 now, never owns Jean's mailbox; nor someone a stale directory gives 105.
    expect(await a.vm.owns({ extension: '102', userId: 'marie', mailbox: got.mailbox })).toBe(false)
    expect(await a.vm.owns({ extension: '105', userId: 'marie', mailbox: got.mailbox })).toBe(false)
    expect(await a.vm.owns({ extension: '105', userId: 'jean', mailbox: 'x' })).toBe(false)
    // Marie's own mailbox is hers.
    expect(await a.vm.owns({ extension: '102', userId: 'marie' })).toBe(true)
    expect(await a.vm.owns({ extension: '102', userId: 'marie', mailbox: String(a.wazo.boxOf('marie')!.id) })).toBe(true)
    await a.vm.close()
  })

  it('tells nothing of a mailbox of nobody, and finds the holder among its users whatever their order', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([jean])
    const jeans = wazo.boxOf('jean')!
    // A user made in Wazo by hand, first of Jean's mailbox; and a mailbox of the context with no user of ours.
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000002', firstname: 'Admin', userfield: null, voicemail: { id: jeans.id } })
    jeans.users.unshift({ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' })
    wazo.state.voicemails.push({ id: 901, number: numberOf('nobody'), context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000002' }] })
    wazo.state.messages.set(901, [])
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: 901, message_id: '1-1', message: { id: '1-1' } })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: jeans.id, message_id: '1-2', message: { id: '1-2' } })
    const got = (await events.next()).value as { extension: string; mailbox: string }
    expect([got.extension, got.mailbox]).toEqual(['102', String(jeans.id)])
    // The routes too: a new Gateway (nothing known) finds Jean's mailbox his.
    const other = new WazoVoicemail({ authUrl: 'http://wazo.test:9497/0.1', confdUrl: 'http://wazo.test:9486/1.1', calldUrl: 'http://wazo.test:9500/1.0', websocketdUrl: 'ws://wazo.test:9502/', username: 'twakephone', password: 'not-a-real-password', holderSecret: SECRET, fetch: wazo.fetch, logger: { info() {}, warn() {}, error() {} } })
    expect(await other.owns(jean)).toBe(true)
    expect(await other.owns({ extension: '108', userId: 'nobody' })).toBe(false)
    await vm.close()
  })

  it("tells nothing of a mailbox of the context outside the mailboxes' numbers, nor owns it, its user Jean's", async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([jean])
    // A second user of Jean's print (made by hand), its mailbox at an extension's number.
    wazo.state.users.push({ uuid: 'aaaaaaaa-0000-4000-8000-000000000003', firstname: 'TwakePhone', userfield: holderKey('jean'), voicemail: { id: 990 } })
    wazo.state.voicemails.push({ id: 990, number: '0999', context: CONTEXT, name: 'x', max_messages: null, options: [], users: [{ uuid: 'aaaaaaaa-0000-4000-8000-000000000003' }] })
    wazo.state.messages.set(990, [])
    const events = vm.subscribe({ holders: async () => [jean] })[Symbol.asyncIterator]()
    await tick(1)
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: 990, message_id: '1-1', message: { id: '1-1' } })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: wazo.boxOf('jean')!.id, message_id: '1-2', message: { id: '1-2' } })
    expect(((await events.next()).value as { mailbox: string }).mailbox).toBe(String(wazo.boxOf('jean')!.id))
    expect(await vm.owns({ ...jean, mailbox: '990' })).toBe(false)
    expect(await vm.owns({ ...jean, mailbox: String(wazo.boxOf('jean')!.id) })).toBe(true)
    await vm.close()
  })

  it('tells nothing of a mailbox whose holder holds no extension now, as the Gateway says at the event', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([jean])
    const directory = [jean]
    const events = vm.subscribe({ holders: async () => directory })[Symbol.asyncIterator]()
    await tick(1)
    directory.splice(0)
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: wazo.boxOf('jean')!.id, message_id: '1-1', message: { id: '1-1' } })
    await tick(5)
    directory.push({ extension: '107', userId: 'jean' })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: wazo.boxOf('jean')!.id, message_id: '1-2', message: { id: '1-2' } })
    expect((await events.next()).value).toMatchObject({ extension: '107', event: { payload: { voicemail: { id: '1-2' } } } })
    await vm.close()
  })

  it("tells a mailbox's events in the order they came, its mailbox read once for the event and its owns, read again past that, and once more when Wazo did not answer", async () => {
    const time = clock()
    const { vm, wazo, ws, logs } = make({ now: time.now })
    await vm.syncMailboxes([jean])
    const box = wazo.boxOf('jean')!
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick(1)
    const reads = () => wazo.state.requests.filter(r => r === `GET /1.1/voicemails/${box.id}`).length
    // The first read waits: the second event, read at once, is told after it all the same.
    wazo.state.slowRead = 30
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-1', message: { id: '1-1' } })
    ws.sockets[0]!.event('user_voicemail_message_deleted', { voicemail_id: box.id, message_id: '1-1', message: { id: '1-1' } })
    const first = (await events.next()).value as { event: { type: string }; mailbox: string }
    const second = (await events.next()).value as { event: { type: string } }
    expect([first.event.type, second.event.type]).toEqual(['voicemail.created', 'voicemail.deleted'])
    // Each event read its mailbox (the same clock: never the read of another event).
    expect(reads()).toBe(2)
    // The Gateway's owns of the event: the mailbox as the event read it, not read again; past 2 s, read again.
    expect(await vm.owns({ ...jean, mailbox: first.mailbox })).toBe(true)
    expect(reads()).toBe(2)
    time.at += 2_001
    expect(await vm.owns({ ...jean, mailbox: first.mailbox })).toBe(true)
    expect(reads()).toBe(3)
    // Wazo does not answer the read of an event: read once more, a moment later, and told.
    wazo.state.failRead = 1
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-3', message: { id: '1-3' } })
    expect(((await events.next()).value as { event: { payload: { voicemail: { id: string } } } }).event.payload.voicemail.id).toBe('1-3')
    expect(reads()).toBe(5)
    expect(logs.some(l => /voicemail event not told/.test(l))).toBe(false)
    // Twice: given up, said.
    wazo.state.failRead = 2
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: '1-4', message: { id: '1-4' } })
    await until(() => logs.some(l => /voicemail event not told/.test(l)))
    await vm.close()
  })

  it('hears wazo-websocketd with its token, subscribes to the events of the messages, and tells each as the extension of its mailbox', async () => {
    const { vm, wazo, ws } = make()
    await vm.syncMailboxes([{ extension: '102', userId: 'jean' }])
    const box = wazo.boxOf('jean')!
    const events = vm.subscribe()[Symbol.asyncIterator]()
    await tick()
    expect(ws.sockets).toHaveLength(1)
    const url = new URL(ws.sockets[0]!.url)
    expect([url.host, url.searchParams.get('token'), url.searchParams.get('version')]).toEqual(['wazo.test:9502', 'tok-1', '2'])
    expect(ws.sockets[0]!.sent).toEqual([
      { op: 'subscribe', data: { event_name: 'user_voicemail_message_created' } },
      { op: 'subscribe', data: { event_name: 'user_voicemail_message_updated' } },
      { op: 'subscribe', data: { event_name: 'user_voicemail_message_deleted' } },
      { op: 'start' }
    ])
    await tick()
    expect(vm.getStatus()).toBe('CONNECTED')
    // As wazo-calld sent it on the Docker stack (user_voicemail_message_created).
    const message = { caller_id_name: 'Alice Martin', caller_id_num: '101', timestamp: 1792289524, empty: false, voicemail: { accesstype: 'personal', name: 'Jean', id: box.id }, transcription: null, folder: { type: 'new', name: 'inbox', id: 1 }, duration: 7, id: '1792289524-00000004' }
    ws.sockets[0]!.event('user_voicemail_message_created', { user_uuid: wazo.state.users[0]!.uuid, voicemail_id: box.id, message_id: message.id, message })
    expect((await events.next()).value).toEqual({ extension: '102', mailbox: String(box.id), event: { type: 'voicemail.created', timestamp: expect.any(String), payload: { voicemail: { id: message.id, from: '101', fromName: 'Alice Martin', receivedAt: '2026-10-18T02:12:04.000Z', durationSec: 7, unread: true } } } })
    ws.sockets[0]!.event('user_voicemail_message_updated', { voicemail_id: box.id, message_id: message.id, message: { ...message, folder: { type: 'old', name: 'old', id: 2 } } })
    expect((await events.next()).value).toMatchObject({ extension: '102', event: { type: 'voicemail.updated', payload: { voicemail: { id: message.id, unread: false } } } })
    ws.sockets[0]!.event('user_voicemail_message_deleted', { voicemail_id: box.id, message_id: message.id, message })
    expect((await events.next()).value).toMatchObject({ extension: '102', event: { type: 'voicemail.deleted', payload: { id: message.id } } })
    // Another event, a mailbox of nobody here, a message id that is none: nothing.
    ws.sockets[0]!.event('call_created', { voicemail_id: box.id, message_id: 'x' })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: 999, message_id: '1-2', message: {} })
    ws.sockets[0]!.event('user_voicemail_message_created', { voicemail_id: box.id, message_id: 'a/b', message: {} })
    await tick(5)
    await vm.close()
    expect((await events.next()).done).toBe(true)
  })

  it('says its events are lost while wazo-websocketd is gone, and hears it again', async () => {
    const { vm, ws, logs } = make()
    await vm.syncMailboxes([])
    vm.subscribe()
    await tick(1)
    expect(vm.getStatus()).toBe('CONNECTED')
    ws.sockets[0]!.drop()
    expect(vm.getStatus()).toBe('DEGRADED')
    expect(vm.getStatusReason()).toMatch(/events not heard/)
    expect(logs.some(l => /voicemail events lost/.test(l))).toBe(true)
    await tick(20)
    expect(ws.sockets).toHaveLength(2)
    expect(vm.getStatus()).toBe('CONNECTED')
    // A token it refused: a new one for the next try.
    ws.sockets[1]!.drop(4002)
    await tick(20)
    expect(new URL(ws.sockets[2]!.url).searchParams.get('token')).toBe('tok-2')
    await vm.close()
  })

  it('reads a message as Wazo gives it: no number that is none, no name that is a number or Asterisk saying it has none', () => {
    expect(voicemailOf({ id: '1-1', caller_id_num: '<unknown>', caller_id_name: '101', timestamp: 0, duration: -1 }, { type: 'old' })).toEqual({ id: '1-1', fromName: '101', receivedAt: '1970-01-01T00:00:00.000Z', durationSec: 0, unread: false })
    expect(voicemailOf({ id: '1-1', caller_id_num: '101', caller_id_name: '101' }, undefined)).toEqual({ id: '1-1', from: '101', receivedAt: '1970-01-01T00:00:00.000Z', durationSec: 0, unread: false })
  })
})
