import { connect, type Socket } from 'node:net'

// The AMI of Asterisk (step 11d, ADR 0029), as little as supervision needs: one connection for one action, login, the
// answer (and the events of a list), logoff. Values never carry a line break (a request cannot add a header).

export type AmiMessage = Record<string, string>

export interface AmiConfig {
  host: string
  port: number
  username: string
  password: string
  /** How long one operation may take, in milliseconds (connection and login included). Default: 10 s. */
  timeoutMs?: number
  /** Opens the connection (the tests give theirs). */
  connect?: (port: number, host: string) => Socket
}

export class AmiError extends Error {
  constructor(message: string, readonly reason: 'unreachable' | 'refused' | 'timeout' | 'protocol') {
    super(message)
    this.name = 'AmiError'
  }
}

/** The headers of a message, from its lines (the first line of a connection is the banner: no `: `). */
const parse = (block: string): AmiMessage => {
  const message: AmiMessage = {}
  for (const line of block.split('\r\n')) {
    const at = line.indexOf(': ')
    if (at > 0) message[line.slice(0, at)] = line.slice(at + 2)
  }
  return message
}

const header = (value: string) => {
  if (/[\r\n]/.test(value)) throw new AmiError('a line break in an AMI header', 'protocol')
  return value
}

const frame = (fields: Record<string, string | string[]>) =>
  `${Object.entries(fields)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(one => `${header(k)}: ${header(one)}`))
    .join('\r\n')}\r\n\r\n`

export interface AmiOptions {
  /** The events of the connection after login (`Events`, `off` by default): `call` for an Originate that answers by an event. */
  events?: 'call'
  /**
   * What ends the wait for the action: its answer (default), the end of its list (`list`: the events up to
   * `EventList: Complete`), or the event that answers it (`event`: an OriginateResponse of its ActionID).
   */
  wait?: 'response' | 'list' | 'event'
  /**
   * With `wait: 'event'`: an event (of the connection, whichever action it answers) that ends the wait by itself, such as the
   * ChanSpyStart of an Originate's ChanSpy, which comes after its OriginateResponse. An OriginateResponse that says it did not
   * come up still ends it, as a failure.
   */
  until?: (event: AmiMessage) => boolean
  /** Overrides the timeout of the operation. */
  timeoutMs?: number
}

export interface AmiResult {
  response: AmiMessage
  /** The events of a list (CoreShowChannels…) or the event that answered (`wait: event`). */
  events: AmiMessage[]
}

/** One action of the AMI, on a connection of its own. Rejects with an AmiError (`refused`: Asterisk said no). */
export const amiAction = (config: AmiConfig, action: Record<string, string | string[]>, options: AmiOptions = {}): Promise<AmiResult> =>
  new Promise((resolve, reject) => {
    const wait = options.wait ?? 'response'
    const actionId = `twake-${Math.random().toString(36).slice(2, 10)}`
    let socket: Socket
    let request: string
    let login: string
    try {
      // Built first: a header that is not one fails here, never inside an event handler.
      request = frame({ ...action, ActionID: actionId })
      login = frame({ Action: 'Login', Username: config.username, Secret: config.password, Events: options.events ?? 'off', ActionID: 'login' })
      socket = (config.connect ?? ((port, host) => connect(port, host)))(config.port, config.host)
    } catch (err) {
      reject(err instanceof AmiError ? err : new AmiError(`AMI: ${(err as Error).message}`, 'unreachable'))
      return
    }
    let buffer = ''
    let banner = false
    let stage: 'login' | 'action' | 'done' = 'login'
    let answer: AmiMessage | undefined
    const events: AmiMessage[] = []
    const finish = (err: AmiError | undefined, result?: AmiResult) => {
      if (stage === 'done') return
      stage = 'done'
      clearTimeout(timer)
      if (!err) {
        try {
          socket.write(frame({ Action: 'Logoff' }))
        } catch {
          // The result is known.
        }
      }
      socket.destroy()
      if (err) reject(err)
      else resolve(result as AmiResult)
    }
    const timer = setTimeout(() => finish(new AmiError('AMI: no answer in time', 'timeout')), options.timeoutMs ?? config.timeoutMs ?? 10_000)
    socket.setEncoding('utf8')
    socket.on('error', err => finish(new AmiError(`AMI: ${err.message}`, 'unreachable')))
    socket.on('close', () => finish(new AmiError('AMI: connection closed', 'unreachable')))
    socket.on('connect', () => undefined)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!banner) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        banner = true
        buffer = buffer.slice(end + 2)
        socket.write(login)
      }
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const message = parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 4)
        if (stage === 'login') {
          if (message.Response === undefined) continue
          if (message.Response !== 'Success') return finish(new AmiError('AMI: login refused', 'refused'))
          stage = 'action'
          socket.write(request)
        } else if (stage === 'action') {
          if (message.ActionID !== actionId) {
            // An event nobody asked for (the connection's own): it counts only when it is the one waited for.
            if (wait === 'event' && message.Event !== undefined && options.until?.(message)) return finish(undefined, { response: answer ?? message, events: [message] })
            continue
          }
          if (message.Response !== undefined && !answer) {
            answer = message
            if (message.Response !== 'Success') return finish(new AmiError(`AMI: ${message.Message ?? message.Response}`, 'refused'))
            if (wait === 'response') return finish(undefined, { response: message, events })
          } else if (message.Event !== undefined) {
            if (wait === 'event' && message.Event === 'OriginateResponse' && (!options.until || message.Response !== 'Success')) return finish(undefined, { response: answer ?? message, events: [message] })
            if (message.EventList === 'Complete') return finish(undefined, { response: answer ?? message, events })
            events.push(message)
          }
        }
      }
    })
  })
