// One generator thread of the bench (started by bench.mjs): it plays its share of the phones and tells how it fared
// itself (event-loop utilisation and lag, retransmissions, send errors), so that a step the generator could not keep up
// with is never taken for one the stack could not.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { parentPort, workerData } from 'node:worker_threads'
import { account, callee, endpoint } from './sip.mjs'

const { proxy, ws, domain, password } = workerData
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
let mark = performance.eventLoopUtilization()
/** The health of this thread since the last call. */
const health = () => {
  const busy = performance.eventLoopUtilization(mark).utilization
  const h = { elu: Number(busy.toFixed(2)), lagP99Ms: Number((lag.percentile(99) / 1e6).toFixed(1)), lagMaxMs: Number((lag.max / 1e6).toFixed(1)) }
  lag.reset()
  mark = performance.eventLoopUtilization()
  return h
}
const bump = (counts, key) => (counts[key] = (counts[key] ?? 0) + 1)

/** Runs `fn(0..count-1)` at `perSec` a second (the ones that are late come together); resolves when all are done. */
const paced = (count, perSec, fn) =>
  new Promise(resolve => {
    const t0 = performance.now()
    const running = []
    let i = 0
    const tick = () => {
      const due = Math.min(count, Math.floor(((performance.now() - t0) * perSec) / 1000) + 1)
      while (i < due) running.push(fn(i++))
      if (i < count) setTimeout(tick, 5)
      else void Promise.all(running).then(resolve)
    }
    tick()
  })

let phones = []
let stopped = false
let rec
let calls

const handlers = {
  /** Registers `users` (one endpoint each: a UDP socket or a WebSocket) and keeps them registered, refreshing every `refreshSec`. */
  async regStart({ users, transport, expires, refreshSec, perSec }) {
    stopped = false
    phones = []
    rec = { initial: [], refresh: [], fail: {}, connectFail: 0 }
    health()
    const register = async (phone, kind) => {
      const { status, ms } = await phone.acct.register(expires)
      if (status === 200) rec[kind].push(ms)
      else bump(rec.fail, status || 'timeout')
    }
    const refresh = phone => {
      phone.timer = setTimeout(async () => {
        if (stopped) return
        await register(phone, 'refresh')
        refresh(phone)
      }, refreshSec * 1000 * (0.9 + Math.random() * 0.2))
    }
    await paced(users.length, perSec, async i => {
      let ep
      try {
        ep = await endpoint({ proxy, ws: transport === 'ws' ? ws : undefined })
      } catch {
        rec.connectFail++
        return
      }
      const phone = { ep, acct: account(ep, { user: users[i], password, domain }) }
      phones.push(phone)
      await register(phone, 'initial')
      refresh(phone)
    })
    return { phones: phones.length, connectFail: rec.connectFail }
  },
  /** The latencies and counts since regStart, then every phone unregisters and goes. */
  async regStop({ perSec }) {
    stopped = true
    for (const p of phones) clearTimeout(p.timer)
    const result = {
      ...rec,
      retrans: phones.reduce((n, p) => n + p.ep.stats.retrans, 0),
      sendErrors: phones.reduce((n, p) => n + p.ep.stats.sendErrors, 0),
      health: health()
    }
    await paced(phones.length, perSec, async i => {
      await phones[i].acct.register(0)
      phones[i].ep.close()
    })
    phones = []
    return result
  },
  /** One UDP endpoint for all the pairs of this thread: the callees register (an hour) and answer, the callers wait. */
  async callPrep({ pairs, perSec }) {
    const ep = await endpoint({ proxy, onRequest: callee() })
    const mine = pairs.map(p => ({ caller: account(ep, { user: p.caller, password, domain }), callee: account(ep, { user: p.callee, password, domain }), calleeUser: p.callee }))
    let failed = 0
    await paced(mine.length, perSec, async i => {
      if ((await mine[i].callee.register(3600)).status !== 200) failed++
    })
    calls = { ep, pairs: mine, free: [...mine.keys()] }
    return { registered: mine.length - failed, failed }
  },
  /** Calls at `perSec` for `seconds`, each held `holdMs` then hung up, on pairs that are free. */
  async callRun({ perSec, seconds, holdMs }) {
    const out = { attempted: Math.round(perSec * seconds), ok: 0, fail: {}, lat: [], peakInFlight: 0 }
    let inFlight = 0
    const before = { ...calls.ep.stats }
    health()
    await paced(out.attempted, perSec, async () => {
      const index = calls.free.pop()
      if (index === undefined) return bump(out.fail, 'no-free-pair')
      const pair = calls.pairs[index]
      out.peakInFlight = Math.max(out.peakInFlight, ++inFlight)
      const r = await pair.caller.call(pair.calleeUser, holdMs)
      inFlight--
      calls.free.push(index)
      if (r.status === 200 && r.bye === 200) {
        out.ok++
        out.lat.push(r.ms)
      } else bump(out.fail, r.status === 200 ? `bye-${r.bye || 'timeout'}` : r.status || 'timeout')
    })
    return { ...out, retrans: calls.ep.stats.retrans - before.retrans, sendErrors: calls.ep.stats.sendErrors - before.sendErrors, health: health() }
  },
  async callClose({ perSec }) {
    await paced(calls.pairs.length, perSec, i => calls.pairs[i].callee.register(0))
    calls.ep.close()
    calls = undefined
    return {}
  }
}

parentPort.on('message', async ({ id, cmd, args }) => {
  try {
    parentPort.postMessage({ id, result: await handlers[cmd](args) })
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.stack ?? err) })
  }
})
