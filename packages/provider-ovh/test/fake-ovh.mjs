// A fake of the OVHcloud API (`/1.0`, the telephony calls of step 10b), written from its public documentation only,
// not from the client's code: what the tests and the e2e talk to, no real OVH being reachable from CI.
//
// - `GET /auth/time`: its clock, in seconds (unsigned), `clockOffsetSec` away from this host's.
// - Every other call is signed: X-Ovh-Application, X-Ovh-Consumer, X-Ovh-Timestamp and X-Ovh-Signature, `$1$` + the
//   SHA-1 (hex) of "secret+consumer+METHOD+URL+body+timestamp", the URL as the client sent it, query string included.
//   An unknown application or consumer key: 403 (errorCode INVALID_KEY / INVALID_CREDENTIAL); a timestamp more than
//   `windowSec` away from its clock: 400 QUERY_TIME_OUT "Query out of time"; a wrong signature: 400 INVALID_SIGNATURE.
// - The consumer key has access rules (method + path, `*` for any characters): a call outside them is 403
//   NOT_GRANTED_CALL "This call has not been granted". By default, the rules the pilot kit asks for (pilotRules): the
//   options of the lines of the billing accounts given, and their records of calls, nothing else.
// - Telephony: GET and PUT /telephony/{ba}/line/{sn}/options (telephony.LineOptions; a PUT changes the properties it
//   names, after checking them: known, of their type, numbers in the 00 format, a delay of no answer OVH takes),
//   GET /telephony/{ba}/service/{sn}/voiceConsumption (ids, filtered by creationDatetime.from/.to) and GET
//   …/voiceConsumption/{id} (telephony.ServiceVoiceConsumption), the current billing period; the same under
//   previousVoiceConsumption for the period before `state.monthStart` (the records move there at the turn of the
//   month). Also GET /telephony and GET /telephony/{ba}/line, which the platform does not use. Unknown objects: 404
//   "The requested object (…) does not exist".
// - `state` changes it while it runs: `down` (503), `clockOffsetSec`, `rules`, `monthStart` (ms), `acceptDelay`
//   (whether OVH takes a delay of no answer: 400 INVALID_PARAMETER otherwise), `normalize` (what OVH keeps of a PUT:
//   it may change the values it is sent), `redirect` (a 302 to that URL), `garbage` (a 200 that is no JSON).
//
// The documentation names numbers in the international format with 00 (0033…); dates are ISO 8601 with an offset.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

/** What the rights of a consumer key are, as /auth/credential takes them (`accessRules`). */
const allowedBy = (rules, method, path) =>
  rules.some(r => r.method === method && new RegExp(`^${r.path.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path))

/** The access rules the pilot kit asks for a billing account (docker/pilot/README.md): no more than the platform uses. */
export const pilotRules = billingAccount => [
  { method: 'GET', path: `/telephony/${billingAccount}/line/*/options` },
  { method: 'PUT', path: `/telephony/${billingAccount}/line/*/options` },
  { method: 'GET', path: `/telephony/${billingAccount}/service/*/voiceConsumption` },
  { method: 'GET', path: `/telephony/${billingAccount}/service/*/voiceConsumption/*` },
  { method: 'GET', path: `/telephony/${billingAccount}/service/*/previousVoiceConsumption` },
  { method: 'GET', path: `/telephony/${billingAccount}/service/*/previousVoiceConsumption/*` }
]

/** The options of a line as OVH has them (telephony.LineOptions), a selection: the forwards and a few others. */
export const defaultLineOptions = () => ({
  forwardBackup: false,
  forwardBackupNature: 'number',
  forwardBackupNumber: '',
  forwardBusy: false,
  forwardBusyNature: 'number',
  forwardBusyNumber: '',
  forwardNoReply: false,
  forwardNoReplyDelay: 20,
  forwardNoReplyNature: 'number',
  forwardNoReplyNumber: '',
  forwardUnconditional: false,
  forwardUnconditionalNature: 'number',
  forwardUnconditionalNumber: '',
  anonymousRejection: false,
  displayNumber: '',
  identificationRestriction: false,
  intercom: 'no',
  lockOutCall: false,
  toneOnHold: 'default',
  voicemailExternalNumber: ''
})

const TYPES = {
  forwardBackup: 'boolean',
  forwardBusy: 'boolean',
  forwardNoReply: 'boolean',
  forwardUnconditional: 'boolean',
  forwardNoReplyDelay: 'number',
  forwardBackupNumber: 'string',
  forwardBusyNumber: 'string',
  forwardNoReplyNumber: 'string',
  forwardUnconditionalNumber: 'string',
  forwardBackupNature: 'nature',
  forwardBusyNature: 'nature',
  forwardNoReplyNature: 'nature',
  forwardUnconditionalNature: 'nature',
  anonymousRejection: 'boolean',
  displayNumber: 'string',
  identificationRestriction: 'boolean',
  intercom: 'string',
  lockOutCall: 'boolean',
  toneOnHold: 'string',
  voicemailExternalNumber: 'string'
}
const NATURES = ['fax', 'number', 'voicemail']
/** A date as the documentation writes them: ISO 8601 with an offset. */
const DATED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Starts the fake on 127.0.0.1. `accounts`: { [billingAccount]: { lines: { [serviceName]: { options?, consumptions? } } } }
 * where a consumption is a telephony.ServiceVoiceConsumption (consumptionId, calling, called, creationDatetime,
 * duration, wayType…). `credentials`: the application key, its secret, the consumer key and its access rules.
 * Every request is kept in `requests` ({ method, path, query, body, status, signed }).
 */
export const startFakeOvh = async ({
  applicationKey = 'fake-application-key',
  applicationSecret = 'fake-application-secret',
  consumerKey = 'fake-consumer-key',
  accounts = {},
  rules = Object.keys(accounts).flatMap(pilotRules),
  clockOffsetSec = 0,
  windowSec = 30
} = {}) => {
  const requests = []
  const state = { accounts, clockOffsetSec, rules, down: false, monthStart: undefined, acceptDelay: undefined, normalize: undefined, redirect: undefined, garbage: undefined }
  for (const account of Object.values(accounts)) for (const line of Object.values(account.lines ?? {})) {
    line.options = { ...defaultLineOptions(), ...(line.options ?? {}) }
    line.consumptions ??= []
  }
  const clock = () => Math.floor(Date.now() / 1000) + state.clockOffsetSec
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url, 'http://fake')
      const path = url.pathname.replace(/^\/1\.0/, '')
      let parsed
      try {
        parsed = body ? JSON.parse(body) : undefined
      } catch {
        parsed = body
      }
      const entry = { method: req.method, path, query: Object.fromEntries(url.searchParams), body: parsed, status: 0, signed: false }
      requests.push(entry)
      const send = (status, json) => {
        entry.status = status
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(json === undefined ? 'null' : JSON.stringify(json))
      }
      const refuse = (status, errorCode, message) => send(status, { errorCode, httpCode: `${status}`, message })
      if (state.down) return refuse(503, 'SERVICE_UNAVAILABLE', 'Service unavailable')
      if (req.method === 'GET' && path === '/auth/time') return send(200, clock())
      // Signed: the keys, the clock, then the signature over the URL as it was sent.
      const h = name => req.headers[name.toLowerCase()]
      if (h('X-Ovh-Application') !== applicationKey) return refuse(403, 'INVALID_KEY', 'Invalid application key')
      if (h('X-Ovh-Consumer') !== consumerKey) return refuse(403, 'INVALID_CREDENTIAL', 'This credential does not exist')
      const ts = Number(h('X-Ovh-Timestamp'))
      if (!Number.isInteger(ts) || Math.abs(ts - clock()) > windowSec) return refuse(400, 'QUERY_TIME_OUT', 'Query out of time')
      const fullUrl = `http://${req.headers.host}${req.url}`
      const expected = `$1$${createHash('sha1').update(`${applicationSecret}+${consumerKey}+${req.method}+${fullUrl}+${body}+${ts}`).digest('hex')}`
      if (h('X-Ovh-Signature') !== expected) return refuse(400, 'INVALID_SIGNATURE', 'Invalid signature')
      entry.signed = true
      if (!allowedBy(state.rules, req.method, path)) return refuse(403, 'NOT_GRANTED_CALL', 'This call has not been granted')
      if (state.redirect) {
        entry.status = 302
        res.writeHead(302, { location: state.redirect })
        return res.end()
      }
      if (state.garbage !== undefined) {
        entry.status = 200
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end(state.garbage)
      }
      const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
      const missing = () => refuse(404, 'NOT_FOUND', `The requested object (${parts.slice(1).join('/')}) does not exist`)
      if (parts[0] !== 'telephony') return missing()
      if (parts.length === 1 && req.method === 'GET') return send(200, Object.keys(state.accounts))
      const account = state.accounts[parts[1]]
      if (!account) return missing()
      if (parts[2] === 'line') {
        if (parts.length === 3 && req.method === 'GET') return send(200, Object.keys(account.lines))
        const line = account.lines[parts[3]]
        if (!line || parts[4] !== 'options' || parts.length !== 5) return missing()
        if (req.method === 'GET') return send(200, line.options)
        if (req.method === 'PUT') {
          const changes = parsed
          if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return refuse(400, 'INVALID_PARAMETER', 'Invalid body')
          for (const [k, v] of Object.entries(changes)) {
            const type = TYPES[k]
            if (!type) return refuse(400, 'INVALID_PARAMETER', `Invalid parameter ${k}`)
            if (type === 'nature' ? !NATURES.includes(v) : typeof v !== type) return refuse(400, 'INVALID_PARAMETER', `Invalid value for ${k}`)
            if (/^forward.*Number$/.test(k) && v !== '' && !/^00[1-9][0-9]{6,14}$/.test(v)) return refuse(400, 'INVALID_PARAMETER', `Invalid value for ${k}`)
            if (k === 'forwardNoReplyDelay' && (!Number.isInteger(v) || v < 0 || (state.acceptDelay && !state.acceptDelay(v)))) return refuse(400, 'INVALID_PARAMETER', `Invalid value for ${k}`)
          }
          Object.assign(line.options, state.normalize ? state.normalize({ ...changes }) : changes)
          return send(200)
        }
        return missing()
      }
      if (parts[2] === 'service' && (parts[4] === 'voiceConsumption' || parts[4] === 'previousVoiceConsumption')) {
        const line = account.lines[parts[3]]
        if (!line || req.method !== 'GET') return missing()
        // The current billing period, or the one before `monthStart` (none: everything is current).
        const previous = parts[4] === 'previousVoiceConsumption'
        const inPeriod = c => (state.monthStart === undefined ? !previous : previous === Date.parse(c.creationDatetime) < state.monthStart)
        const listed = line.consumptions.filter(inPeriod)
        if (parts.length === 5) {
          const from = url.searchParams.get('creationDatetime.from')
          const to = url.searchParams.get('creationDatetime.to')
          for (const d of [from, to]) if (d !== null && !DATED.test(d)) return refuse(400, 'INVALID_PARAMETER', 'Invalid value for creationDatetime')
          const at = c => Date.parse(c.creationDatetime)
          return send(200, listed.filter(c => (!from || at(c) >= Date.parse(from)) && (!to || at(c) <= Date.parse(to))).map(c => c.consumptionId))
        }
        const found = listed.find(c => String(c.consumptionId) === parts[5])
        return found && parts.length === 6 ? send(200, found) : missing()
      }
      return missing()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  let nextId = 7_000_000_000
  return {
    url: `http://127.0.0.1:${port}/1.0`,
    credentials: { applicationKey, applicationSecret, consumerKey },
    requests,
    state,
    /** The options of a line now (what the manager would show). */
    options: (billingAccount, line) => state.accounts[billingAccount]?.lines[line]?.options,
    /** A record of a call on a line, as OVH would list it; its id. */
    addConsumption: (billingAccount, line, c) => {
      const consumptionId = c.consumptionId ?? nextId++
      state.accounts[billingAccount].lines[line].consumptions.push({ designation: 'Appel', destinationType: 'landline', dialed: c.called, planType: 'priceplan', priceWithoutTax: { currencyCode: 'EUR', text: '0.00 €', value: 0 }, ...c, consumptionId })
      return consumptionId
    },
    stop: () => new Promise(resolve => server.close(() => resolve()))
  }
}
