// The load bench of the SIP stack (docker/docker-compose.sip.yml), phase 1: how many phones OpenSIPS holds registered
// (over a WebSocket as browsers do, and over UDP), and how many calls a second it sets up. See README.md.
// It measures; it does not judge: each step says what it saw, and the first step that fails says what the stack showed
// at that moment. A step the generator itself could not keep up with is said so ("generator-bound"), never taken for
// the stack's limit. Output: one JSON file (BENCH_JSON) and a Markdown summary (stdout, $GITHUB_STEP_SUMMARY).
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import pg from 'pg'
import { SubscriberProvisioner } from '../../packages/provider-opensips/dist/subscriber.js'

const env = (name, fallback) => process.env[name] ?? fallback
const list = text => text.split(',').map(Number)
const SIP_UDP = env('SIP_UDP', '127.0.0.1:5060')
const SIP_WS = env('SIP_WS', 'ws://127.0.0.1:8088')
const DOMAIN = env('SIP_DOMAIN', '127.0.0.1')
const DB_URL = env('OPENSIPS_DB_URL', 'postgres://twake:twake@127.0.0.1:54320/twake')
const [MI_HOST, MI_PORT] = env('OPENSIPS_MI_URL', 'udp:127.0.0.1:8880').replace(/^udp:/, '').split(':')
const [NG_HOST, NG_PORT] = env('RTPENGINE_NG', '127.0.0.1:22222').split(':')
const COMPOSE = env('BENCH_COMPOSE', 'docker compose -f docker/docker-compose.sip.yml -f docker/bench/docker-compose.bench.yml')
const OUT = env('BENCH_JSON', 'bench-result.json')
const REPEATS = Number(env('BENCH_REPEATS', 3))
const WORKERS = Number(env('BENCH_WORKERS', 2))
const SCENARIOS = env('BENCH_SCENARIOS', 'reg-ws,reg-udp,calls').split(',')
const REG_STEPS = list(env('BENCH_REG_STEPS', '250,500,1000,2000,4000,8000'))
const REG_EXPIRES = 60 // seconds: short, so that the refreshes happen inside each step
const REG_REFRESH = 30 // seconds between a phone's refreshes (half the Expires: a browser renews a little before it ends)
const REG_HOLD = Number(env('BENCH_REG_HOLD_SEC', 75)) // seconds held after the last phone registered: two refreshes at least
const REG_RATE = Number(env('BENCH_REG_RATE', 400)) // phones started a second, all threads together
const CALL_RATES = list(env('BENCH_CALL_RATES', '5,10,20,40,80,160'))
const CALL_SECONDS = Number(env('BENCH_CALL_SECONDS', 30))
const CALL_HOLD_MS = 2000
const PASSWORD = 'bench-secret'
const ext = i => String(700000 + i) // 7xxxxx: no seeded numbering-plan rule, no access number, no emergency number
const sh = cmd => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim()
const trySh = cmd => {
  try {
    return sh(cmd)
  } catch (err) {
    return `(failed: ${String(err.message).split('\n')[0]})`
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = (n, digits = 0) => Number(n.toFixed(digits))
const percentile = (values, p) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)], 1)
}
const sum = values => values.reduce((a, b) => a + b, 0)
const merge = parts => parts.reduce((all, part) => {
  for (const [k, v] of Object.entries(part)) all[k] = (all[k] ?? 0) + v
  return all
}, {})

// ---- What OpenSIPS and rtpengine say -------------------------------------------------------------------------------

const datagram = (host, port, payload, accept) =>
  new Promise(resolve => {
    const s = createSocket('udp4')
    const t = setTimeout(() => (s.close(), resolve(undefined)), 5000)
    s.on('message', (buf, from) => {
      const value = accept(buf, from)
      if (value === undefined) return
      clearTimeout(t)
      s.close()
      resolve(value)
    })
    s.send(payload, Number(port), host)
  })
const mi = (method, params) =>
  datagram(MI_HOST, MI_PORT, JSON.stringify({ jsonrpc: '2.0', method, id: 1, ...(params ? { params } : {}) }), (buf, from) => {
    if (from.port !== Number(MI_PORT)) return undefined
    try {
      return JSON.parse(buf.toString())
    } catch {
      return undefined
    }
  })
/** The contacts OpenSIPS holds (usrloc's statistic), not the 200s that were sent. */
const contacts = async () => {
  for (const statistics of [['usrloc:'], ['location-contacts'], ['all']]) {
    const result = (await mi('get_statistics', { statistics }))?.result ?? {}
    const key = Object.keys(result).find(k => /location-contacts$/.test(k))
    if (key) return Number(result[key])
  }
  return undefined
}

const bencode = v => (typeof v === 'string' ? `${Buffer.byteLength(v)}:${v}` : typeof v === 'number' ? `i${v}e` : `d${Object.entries(v).map(([k, x]) => bencode(k) + bencode(x)).join('')}e`)
const bdecode = (buf, pos = { i: 0 }) => {
  const c = String.fromCharCode(buf[pos.i])
  if (c === 'i') {
    const end = buf.indexOf(0x65, pos.i)
    const n = Number(buf.toString('latin1', pos.i + 1, end))
    pos.i = end + 1
    return n
  }
  if (c === 'l' || c === 'd') {
    pos.i++
    const out = c === 'l' ? [] : {}
    while (buf[pos.i] !== 0x65) {
      if (c === 'l') out.push(bdecode(buf, pos))
      else out[bdecode(buf, pos)] = bdecode(buf, pos)
    }
    pos.i++
    return out
  }
  const colon = buf.indexOf(0x3a, pos.i)
  const len = Number(buf.toString('latin1', pos.i, colon))
  const text = buf.toString('latin1', colon + 1, colon + 1 + len)
  pos.i = colon + 1 + len
  return text
}
const findKey = (tree, test) => {
  for (const [k, v] of Object.entries(tree ?? {})) {
    if (test(k) && typeof v === 'number') return v
    const inner = typeof v === 'object' ? findKey(v, test) : undefined
    if (inner !== undefined) return inner
  }
  return undefined
}
/** The sessions rtpengine holds now (NG `statistics`; the CLI's `list numsessions` when that says nothing). */
const rtpSessions = async () => {
  const cookie = randomBytes(4).toString('hex')
  const reply = await datagram(NG_HOST, NG_PORT, `${cookie} ${bencode({ command: 'statistics' })}`, buf => (buf.toString('latin1').startsWith(cookie) ? bdecode(buf.subarray(cookie.length + 1)) : undefined))
  const n = findKey(reply, k => /^(sessionsown|ownsessions)$/.test(k)) ?? findKey(reply, k => k === 'sessionstotal')
  if (n !== undefined) return n
  const cli = trySh(`${COMPOSE} exec -T rtpengine rtpengine-ctl -ip 127.0.0.1 -port 9900 list numsessions`)
  return Number(/(\d+)\s*$/.exec(cli)?.[1] ?? NaN)
}

// ---- What the machine says -----------------------------------------------------------------------------------------

const TICKS = Number(trySh('getconf CLK_TCK')) || 100
/** CPU time (s) and resident memory (bytes) per process family, from /proc (the containers share the host's). */
const procs = () => {
  const out = Object.fromEntries(['opensips', 'rtpengine', 'postgres', 'node'].map(n => [n, { cpu: 0, rss: 0 }]))
  for (const pid of readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      const family = out[stat.slice(stat.indexOf('(') + 1, close)]
      if (!family) continue
      family.cpu += (Number(fields[11]) + Number(fields[12])) / TICKS
      family.rss += Number(fields[21]) * 4096
    } catch {
      // the process went away
    }
  }
  return out
}
const udpCounters = () => {
  try {
    const [names, values] = readFileSync('/proc/net/snmp', 'utf8').split('\n').filter(l => l.startsWith('Udp:'))
    const keys = names.split(' ').slice(1)
    const nums = values.split(' ').slice(1).map(Number)
    return Object.fromEntries(keys.map((k, i) => [k, nums[i]]))
  } catch {
    return {}
  }
}
/** Starts a measure of the machine; `stop()` gives, over that time, the CPU in cores and the memory per process, the UDP drops. */
const measure = () => {
  const t0 = performance.now()
  const p0 = procs()
  const u0 = udpCounters()
  const since = new Date().toISOString()
  return () => {
    const seconds = (performance.now() - t0) / 1000
    const p1 = procs()
    const u1 = udpCounters()
    const cores = Object.fromEntries(Object.keys(p1).map(n => [n, { cores: round((p1[n].cpu - p0[n].cpu) / seconds, 2), rssMb: round(p1[n].rss / 1048576) }]))
    const udp = Object.fromEntries(['InErrors', 'RcvbufErrors', 'SndbufErrors'].map(k => [k, (u1[k] ?? 0) - (u0[k] ?? 0)]))
    return { seconds: round(seconds), process: cores, udpDrops: udp, logErrors: logErrors(since) }
  }
}
/** The three most frequent error lines of the stack's logs since `since` (numbers blanked, so that like lines add up). */
const logErrors = since =>
  trySh(`${COMPOSE} logs --no-color --no-log-prefix --since ${since} opensips rtpengine postgres 2>&1 | grep -E 'ERROR|CRITICAL' | sed -E 's/[0-9]+/N/g' | cut -c1-150 | sort | uniq -c | sort -rn | head -3`)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

// ---- The generator -------------------------------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: DB_URL, max: 4 })
const provisioner = new SubscriberProvisioner({ databaseUrl: DB_URL, realm: DOMAIN })
let provisioned = 0
/** Accounts 0..count-1 exist in `subscriber`. */
const ensureAccounts = async count => {
  for (let i = provisioned; i < count; i += 50) await Promise.all(Array.from({ length: Math.min(50, count - i) }, (_, k) => provisioner.setSipSecret(ext(i + k), PASSWORD)))
  provisioned = Math.max(provisioned, count)
}

const threads = Array.from({ length: WORKERS }, () => new Worker(new URL('./load.mjs', import.meta.url), { workerData: { proxy: SIP_UDP, ws: SIP_WS, domain: DOMAIN, password: PASSWORD } }))
const waiting = new Map()
let nextId = 0
for (const thread of threads) {
  thread.on('message', ({ id, result, error }) => {
    const { resolve, reject } = waiting.get(id)
    waiting.delete(id)
    if (error) reject(new Error(error))
    else resolve(result)
  })
  thread.on('error', err => {
    for (const { reject } of waiting.values()) reject(err)
  })
}
const ask = (thread, cmd, args) => new Promise((resolve, reject) => (waiting.set(++nextId, { resolve, reject }), thread.postMessage({ id: nextId, cmd, args })))
/** The same command to every thread, each with its share (`args(k)`). */
const askAll = (cmd, args) => Promise.all(threads.map((t, k) => ask(t, cmd, args(k))))
const share = (items, k) => items.filter((_, i) => i % WORKERS === k)

/** What the threads said of themselves: a step they could not keep up with proves nothing about the stack. */
const generator = results => {
  const healths = results.map(r => r.health)
  const elu = Math.max(...healths.map(h => h.elu))
  const lagP99Ms = Math.max(...healths.map(h => h.lagP99Ms))
  return { elu, lagP99Ms, lagMaxMs: Math.max(...healths.map(h => h.lagMaxMs)), retrans: sum(results.map(r => r.retrans)), sendErrors: sum(results.map(r => r.sendErrors)), bound: elu > 0.85 || lagP99Ms > 100 }
}

// ---- The scenarios -------------------------------------------------------------------------------------------------

const PASS_RATE = 0.99
const PASS_P95_MS = 1000

/** One step of the registrations: `n` phones, over `transport`, held `REG_HOLD` seconds. */
const registrationStep = async (n, transport) => {
  await ensureAccounts(n)
  const users = Array.from({ length: n }, (_, i) => ext(i))
  const baseline = (await contacts()) ?? 0
  await askAll('regStart', k => ({ users: share(users, k), transport, expires: REG_EXPIRES, refreshSec: REG_REFRESH, perSec: REG_RATE / WORKERS }))
  const stopMeasure = measure()
  const held = []
  for (let waited = 0; waited < REG_HOLD; waited += 5) {
    await sleep(5000)
    held.push(((await contacts()) ?? NaN) - baseline)
  }
  const stack = stopMeasure()
  const results = await askAll('regStop', () => ({ perSec: (REG_RATE * 2) / WORKERS }))
  for (let waited = 0; waited < 90 && ((await contacts()) ?? 0) - baseline > Math.max(5, n / 200); waited += 5) await sleep(5000)
  const latencies = results.flatMap(r => [...r.initial, ...r.refresh])
  const failures = merge(results.map(r => r.fail))
  const heldMin = Math.min(...held)
  const heldRate = heldMin / n
  const p95 = percentile(latencies, 95)
  const gen = generator(results)
  return {
    n,
    heldMin,
    heldRate: round(heldRate, 4),
    registrations: { ok: latencies.length, initial: sum(results.map(r => r.initial.length)), refresh: sum(results.map(r => r.refresh.length)), failed: failures, connectFailed: sum(results.map(r => r.connectFail)) },
    p50Ms: percentile(latencies, 50),
    p95Ms: p95,
    p95InitialMs: percentile(results.flatMap(r => r.initial), 95),
    p95RefreshMs: percentile(results.flatMap(r => r.refresh), 95),
    generator: gen,
    stack,
    pass: heldRate >= PASS_RATE && p95 !== undefined && p95 < PASS_P95_MS
  }
}

/** One step of the calls: `rate` calls a second for `CALL_SECONDS`, on the pairs of `pairs` (one call at a time on each). */
const callStep = async rate => {
  const stopMeasure = measure()
  const results = await askAll('callRun', () => ({ perSec: rate / WORKERS, seconds: CALL_SECONDS, holdMs: CALL_HOLD_MS }))
  const stack = stopMeasure()
  await sleep(5000)
  const sessionsAfter5s = await rtpSessions()
  await sleep(35_000)
  const sessionsAfter40s = await rtpSessions()
  const latencies = results.flatMap(r => r.lat)
  const attempted = sum(results.map(r => r.attempted))
  const ok = sum(results.map(r => r.ok))
  const p95 = percentile(latencies, 95)
  const gen = generator(results)
  return {
    rate,
    attempted,
    ok,
    successRate: round(ok / attempted, 4),
    failures: merge(results.map(r => r.fail)),
    p50Ms: percentile(latencies, 50),
    p95Ms: p95,
    peakInFlight: sum(results.map(r => r.peakInFlight)),
    rtpSessionsLeft: { after5s: sessionsAfter5s, after40s: sessionsAfter40s },
    generator: gen,
    stack,
    pass: ok / attempted >= PASS_RATE && p95 !== undefined && p95 < PASS_P95_MS
  }
}

/** What the failing step showed, in a line: the numbers, the busiest process, the stack's first error line. */
const gaveOut = (step, kind) => {
  const what = kind === 'calls' ? `${step.rate} calls/s: ${round(step.successRate * 100, 1)} % set up, p95 ${step.p95Ms ?? 'n/a'} ms, failures ${JSON.stringify(step.failures)}` : `${step.n} phones: ${round(step.heldRate * 100, 1)} % held (${step.heldMin} of ${step.n}), p95 ${step.p95Ms ?? 'n/a'} ms, failures ${JSON.stringify(step.registrations.failed)}`
  const [name, busiest] = Object.entries(step.stack.process).sort((a, b) => b[1].cores - a[1].cores)[0]
  const drops = step.stack.udpDrops.InErrors + step.stack.udpDrops.RcvbufErrors
  const bound = step.generator.bound ? ` GENERATOR-BOUND (event loop ${step.generator.elu * 100} % busy, lag p99 ${step.generator.lagP99Ms} ms): the stack's limit is not shown, at least the step before.` : ''
  return `${what}; busiest process ${name} (${busiest.cores} cores); UDP drops on this host ${drops}; first log error: ${step.stack.logErrors[0] ?? 'none'}.${bound}`
}

/** Runs the steps of `name` into `result` (saved after each). */
const runScenario = async (name, result, save) => {
  const kind = name === 'calls' ? 'calls' : 'registrations'
  const steps = result.steps
  let prepared
  if (kind === 'calls') {
    const pairsCount = Math.max(...CALL_RATES) * 12 // calls last about 2 s: a pair is free again long before its turn
    await ensureAccounts(pairsCount * 2)
    const pairs = Array.from({ length: pairsCount }, (_, i) => ({ caller: ext(i), callee: ext(pairsCount + i) }))
    prepared = await askAll('callPrep', k => ({ pairs: share(pairs, k), perSec: 200 }))
    console.log(`  callees registered: ${sum(prepared.map(r => r.registered))} of ${pairsCount}`)
  }
  for (const size of kind === 'calls' ? CALL_RATES : REG_STEPS) {
    const step = kind === 'calls' ? await callStep(size) : await registrationStep(size, name === 'reg-ws' ? 'ws' : 'udp')
    steps.push(step)
    save()
    console.log(`  ${name} ${size}: ${step.pass ? 'pass' : 'FAIL'} p95 ${step.p95Ms} ms${step.generator.bound ? ' (generator-bound)' : ''}`)
    if (!step.pass) break
  }
  if (kind === 'calls') await askAll('callClose', () => ({ perSec: 200 }))
  const failed = steps.find(s => !s.pass)
  Object.assign(result, { passes: steps.filter(s => s.pass).length, fails: steps.filter(s => !s.pass).length, gaveOutFirst: failed ? gaveOut(failed, kind) : `nothing: all ${steps.length} steps passed, the stack was not taken to its limit (add larger steps)` })
}

// ---- The report ----------------------------------------------------------------------------------------------------

const sizeOf = (step, kind) => (kind === 'calls' ? step.rate : step.n)
const stepRow = (step, kind) => {
  const cpu = Object.entries(step.stack.process).map(([n, p]) => `${n} ${p.cores}`).join(', ')
  const rss = Object.entries(step.stack.process).map(([n, p]) => `${n} ${p.rssMb}`).join(', ')
  const left = kind === 'calls' ? [`${round(step.successRate * 100, 1)} %`, JSON.stringify(step.failures), `${step.rtpSessionsLeft.after5s} / ${step.rtpSessionsLeft.after40s}`] : [`${round(step.heldRate * 100, 1)} % (${step.heldMin})`, JSON.stringify(step.registrations.failed), '']
  const drops = step.stack.udpDrops
  const gen = `${step.generator.elu * 100} % / ${step.generator.lagP99Ms} ms${step.generator.bound ? ' BOUND' : ''}`
  return `| ${sizeOf(step, kind)} | ${left[0]} | ${left[1]} | ${step.p50Ms ?? '-'} / ${step.p95Ms ?? '-'} | ${step.generator.retrans} | ${drops.InErrors} / ${drops.RcvbufErrors} | ${cpu} | ${rss} | ${gen} | ${kind === 'calls' ? `${left[2]} | ` : ''}${step.pass ? 'pass' : '**FAIL**'} |`
}
const markdown = report => {
  const h = report.header
  const lines = [
    '# SIP load bench, phase 1',
    '',
    `- Commit \`${h.commit}\`, ${h.date}, runner ${h.runner}`,
    `- Machine: ${h.nproc} vCPU, ${h.ramGb} GB RAM, kernel ${h.kernel}, Node ${h.node}`,
    `- Services that ran: ${h.services.join(', ')} (the Gateway, Wazo, LiveKit, Meet and the rest of the stack were not started)`,
    `- Generator: ${h.workers} threads, ${h.repeats} runs per scenario; pass = held (or set up) >= 99 % and p95 < 1 s`,
    '',
    '## Effective settings',
    '',
    '```json',
    JSON.stringify(report.settings, null, 2),
    '```'
  ]
  for (const [name, runs] of Object.entries(report.scenarios)) {
    const kind = name === 'calls' ? 'calls' : 'registrations'
    lines.push('', `## ${{ 'reg-ws': 'Registrations held, WebSocket (primary)', 'reg-udp': 'Registrations held, UDP', calls: 'Calls per second (extension to extension, 2 s held, plain RTP to a silent port)' }[name]}`, '')
    const sizes = [...new Set(runs.flatMap(r => r.steps.map(s => sizeOf(s, kind))))].sort((a, b) => a - b)
    lines.push(`Spread over ${runs.length} runs (steps never reached are not counted):`, '', `| ${kind === 'calls' ? 'calls/s' : 'phones'} | runs passed | p95 ms (min-max) | ${kind === 'calls' ? 'set up' : 'held'} % (min-max) |`, '|---|---|---|---|')
    for (const size of sizes) {
      const at = runs.flatMap(r => r.steps.filter(s => sizeOf(s, kind) === size))
      const p95s = at.map(s => s.p95Ms).filter(v => v !== undefined)
      const rates = at.map(s => (kind === 'calls' ? s.successRate : s.heldRate) * 100)
      lines.push(`| ${size} | ${at.filter(s => s.pass).length} of ${at.length} | ${p95s.length ? `${Math.min(...p95s)}-${Math.max(...p95s)}` : '-'} | ${round(Math.min(...rates), 1)}-${round(Math.max(...rates), 1)} |`)
    }
    runs.forEach((run, i) => {
      lines.push('', `### Run ${i + 1}: passes ${run.passes}, fails ${run.fails}, gave out first: ${run.gaveOutFirst}`, '')
      lines.push(`| ${kind === 'calls' ? 'calls/s' : 'phones'} | ${kind === 'calls' ? 'set up' : 'held (min of samples)'} | failures | p50 / p95 ms | retransmissions | UDP InErrors / RcvbufErrors | CPU cores | RSS MB | generator busy / lag p99 |${kind === 'calls' ? ' rtpengine sessions left (5 s / 40 s) |' : ''} result |`)
      lines.push(`|---|---|---|---|---|---|---|---|---|${kind === 'calls' ? '---|' : ''}---|`)
      for (const step of run.steps) lines.push(stepRow(step, kind))
      const errors = run.steps.flatMap(s => s.stack.logErrors.map(l => `${sizeOf(s, kind)}: ${l}`))
      if (errors.length) lines.push('', 'Error lines of the stack (count, line):', ...errors.map(e => `- \`${e}\``))
    })
  }
  return lines.join('\n')
}

const settings = () => {
  const config = JSON.parse(sh(`${COMPOSE} config --format json`)).services
  const pick = (service, keys) => Object.fromEntries(keys.map(k => [k, config[service].environment?.[k]]))
  const container = (service, cmd) => trySh(`${COMPOSE} exec -T ${service} sh -c '${cmd}'`)
  return {
    compose: COMPOSE,
    opensips: {
      env: pick('opensips', ['SIP_DOMAIN', 'LISTEN_IP', 'DB_MAX_ASYNC_CONNECTIONS', 'PUSH_WAIT_SEC', 'CALL_PING_SEC', 'WAZO_SIP', 'WAZO_LINES', 'MEET_SIP', 'MEET_CALLS_ALL', 'TRUNK_MIN_CALL_SEC', 'RTPENGINE_INTERFACE_INTERNAL', 'RTPENGINE_INTERFACE_EXTERNAL', 'OPENSIPS_LOG_LEVEL']),
      rendered: container('opensips', 'grep -E "^(udp_workers|tcp_workers|tcp_max_connections|tcp_connection_lifetime|db_max_async_connections)" /etc/opensips/opensips.cfg').split('\n'),
      tcpMaxConnections: 'not set in the script: the default of OpenSIPS (2048 by its documentation), not read from the process',
      registrar: 'default_expires 300, max_expires 3600, max_contacts 10 (opensips.cfg.tpl), min_expires the default (60)',
      ulimitNofile: container('opensips', 'ulimit -n')
    },
    rtpengine: { portRange: `${config.rtpengine.environment.RTPENGINE_PORT_MIN}-${config.rtpengine.environment.RTPENGINE_PORT_MAX}`, ulimitNofile: container('rtpengine', 'ulimit -n') },
    postgres: { command: config.postgres.command.join(' '), ulimitNofile: container('postgres', 'ulimit -n') },
    generator: { ulimitNofile: trySh('ulimit -n'), phaseSettings: { regExpiresSec: REG_EXPIRES, regRefreshSec: REG_REFRESH, regHoldSec: REG_HOLD, regStartsPerSec: REG_RATE, callSeconds: CALL_SECONDS, callHoldMs: CALL_HOLD_MS } }
  }
}
// A bench started without Docker at hand (the stack is elsewhere) still runs: the settings then say they were not read.
const settingsOrError = () => {
  try {
    return settings()
  } catch (err) {
    return { unread: String(err.message).split('\n')[0] }
  }
}
const header = async () => {
  const { rows } = await pool.query('SHOW max_connections')
  return {
    header: {
      commit: trySh('git rev-parse --short=12 HEAD'),
      date: new Date().toISOString(),
      runner: `${env('RUNNER_NAME', os.hostname())} (${env('ImageOS', 'n/a')} ${env('ImageVersion', '')})`.trim(),
      nproc: os.availableParallelism(),
      ramGb: round(os.totalmem() / 2 ** 30, 1),
      kernel: os.release(),
      node: process.version,
      workers: WORKERS,
      repeats: REPEATS,
      services: trySh(`${COMPOSE} ps --services --filter status=running`).split('\n').sort()
    },
    maxConnections: rows[0].max_connections
  }
}

const main = async () => {
  await provisioner.ensureSchema()
  if ((await contacts()) === undefined) throw new Error(`MI at ${MI_HOST}:${MI_PORT} gives no location-contacts statistic: ${JSON.stringify(await mi('get_statistics', { statistics: ['usrloc:'] }))}`)
  const { header: head, maxConnections } = await header()
  const report = { header: head, settings: { ...settingsOrError(), postgresMaxConnections: maxConnections }, scenarios: {} }
  console.log(JSON.stringify(report.header))
  for (const name of SCENARIOS) {
    report.scenarios[name] = []
    for (let run = 1; run <= REPEATS; run++) {
      console.log(`${name}, run ${run}`)
      const result = { steps: [], passes: 0, fails: 0, gaveOutFirst: 'unfinished' }
      report.scenarios[name].push(result)
      const save = () => writeFileSync(OUT, JSON.stringify(report, null, 2))
      await runScenario(name, result, save)
      save()
    }
  }
  const text = markdown(report)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  writeFileSync(OUT.replace(/\.json$/, '.md'), text)
}

try {
  await main()
} finally {
  await pool.query("DELETE FROM subscriber WHERE username ~ '^7[0-9]{5}$'").catch(() => undefined)
  await Promise.all(threads.map(t => t.terminate()))
  await provisioner.close()
  await pool.end()
}
