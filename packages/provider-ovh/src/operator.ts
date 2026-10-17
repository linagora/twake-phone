import type { OperatorCdr, OperatorFallback, OperatorForward, OperatorForwardNature, OperatorLineForwards } from '@twake/telephony-types'
import { OperatorError, type OperatorProvider } from '@twake/telephony-provider-sdk'
import { OvhClient, type OvhClientOptions } from './client.js'
import { fromOvhNumber, toOvhNumber } from './numbers.js'

/**
 * The part of a line's options (`telephony.LineOptions`) that holds its forwards on unavailability (`forwardBackup`,
 * the line cannot be reached) and on no answer (`forwardNoReply`, after `forwardNoReplyDelay` seconds), to a number
 * (`…Nature` `number`) or elsewhere (`voicemail`, `fax`). The other options of the line are never written.
 */
interface OvhLineForwards {
  forwardBackup?: boolean
  forwardBackupNature?: string
  forwardBackupNumber?: string
  forwardNoReply?: boolean
  forwardNoReplyDelay?: number
  forwardNoReplyNature?: string
  forwardNoReplyNumber?: string
}

/** A record of a call (`telephony.ServiceVoiceConsumption`): its way (`incoming`, `outgoing`, `transfer`), the two numbers, when and how long. */
interface OvhVoiceConsumption {
  consumptionId: number
  calling?: string
  called?: string
  creationDatetime: string
  duration?: number
  wayType?: string
}

export interface OvhOperatorOptions extends OvhClientOptions {
  /** The billing account (`ab12345-ovh-1`) whose lines carry the trunks. */
  billingAccount: string
  /** Test seam: the client, built from the options otherwise. */
  client?: OvhClient
}

/** A billing account or a service name as it goes into a path. */
const segment = (v: string) => encodeURIComponent(v)

/**
 * OVHcloud as the operator of the trunks (step 10b, ADR 0021), through its API (`/telephony`): the lines of a billing
 * account, their forwards on unavailability and on no answer, and their records of calls (`voiceConsumption`).
 */
export class OvhOperator implements OperatorProvider {
  readonly id = 'ovh'
  private readonly client: OvhClient
  private readonly account: string
  private readonly now: () => number

  constructor(options: OvhOperatorOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.billingAccount ?? '')) throw new Error('OVH billing account: letters, digits and . _ - (as the manager shows it, ab12345-ovh-1)')
    this.client = options.client ?? new OvhClient(options)
    this.account = segment(options.billingAccount)
    this.now = options.now ?? Date.now
  }

  private line(line: string) {
    return `/telephony/${this.account}/line/${segment(line)}`
  }

  /** Each forward of a line as it is: to a number, the voicemail, a fax, or elsewhere (review 10b, n°4). */
  async getForwards(line: string): Promise<OperatorLineForwards> {
    const o = (await this.client.request<OvhLineForwards | undefined>('GET', `${this.line(line)}/options`)) ?? {}
    if (typeof o !== 'object') throw new OperatorError('unreachable', 'OVH GET /telephony/…/options: not an object')
    const forward = (nature: unknown, number: unknown): OperatorForward => {
      const n: OperatorForwardNature = nature === 'number' || nature === 'voicemail' || nature === 'fax' ? nature : 'other'
      return n === 'number' && typeof number === 'string' && number ? { nature: n, number: fromOvhNumber(number) } : { nature: n }
    }
    return {
      ...(o.forwardBackup ? { onUnavailable: forward(o.forwardBackupNature, o.forwardBackupNumber) } : {}),
      ...(o.forwardNoReply ? { onNoAnswer: { ...forward(o.forwardNoReplyNature, o.forwardNoReplyNumber), afterSec: typeof o.forwardNoReplyDelay === 'number' ? o.forwardNoReplyDelay : 0 } } : {})
    }
  }

  async setFallback(line: string, fallback: OperatorFallback): Promise<void> {
    const on = fallback.onUnavailable || fallback.noAnswerAfterSec !== undefined
    if (on && !fallback.number) throw new Error('a fallback forward needs its number')
    const number = fallback.number ? toOvhNumber(fallback.number) : undefined
    const body: OvhLineForwards = {
      forwardBackup: fallback.onUnavailable,
      ...(fallback.onUnavailable ? { forwardBackupNature: 'number', forwardBackupNumber: number } : {}),
      forwardNoReply: fallback.noAnswerAfterSec !== undefined,
      ...(fallback.noAnswerAfterSec !== undefined ? { forwardNoReplyDelay: fallback.noAnswerAfterSec, forwardNoReplyNature: 'number', forwardNoReplyNumber: number } : {})
    }
    await this.client.request('PUT', `${this.line(line)}/options`, { body })
  }

  private consumption(line: string, previous: boolean) {
    return `/telephony/${this.account}/service/${segment(line)}/${previous ? 'previousVoiceConsumption' : 'voiceConsumption'}`
  }

  /**
   * The ids of the records dated from `from` to `to`: those of the current billing period (`voiceConsumption`), and,
   * when the window starts within a day of the first of the month or before, those of the previous one
   * (`previousVoiceConsumption`, review 10b, n°9: a record moves there at the turn of the month), each once.
   */
  async listCdrIds(line: string, from: string, to: string): Promise<string[]> {
    const query = { 'creationDatetime.from': from, 'creationDatetime.to': to }
    const end = new Date(to)
    const monthStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)
    const lists = [this.client.request<unknown>('GET', this.consumption(line, false), { query })]
    if (Date.parse(from) < monthStart + 86_400_000)
      lists.push(
        this.client.request<unknown>('GET', this.consumption(line, true), { query }).catch((err: unknown) => {
          // No previous period yet (a line taken this month).
          if (err instanceof OperatorError && err.code === 'not-found') return []
          throw err
        })
      )
    const ids = new Set<string>()
    for (const list of await Promise.all(lists)) {
      if (!Array.isArray(list)) throw new OperatorError('unreachable', 'OVH GET /telephony/…/voiceConsumption: not a list')
      for (const id of list) if (typeof id === 'number' || typeof id === 'string') ids.add(String(id))
    }
    return [...ids]
  }

  async getCdr(line: string, id: string): Promise<OperatorCdr | undefined> {
    let c: OvhVoiceConsumption | undefined
    for (const previous of [false, true]) {
      try {
        c = await this.client.request<OvhVoiceConsumption>('GET', `${this.consumption(line, previous)}/${segment(id)}`)
        break
      } catch (err) {
        // Not in this period: in the previous one, or gone.
        if (!(err instanceof OperatorError && err.code === 'not-found')) throw err
      }
    }
    if (!c || typeof c !== 'object') return undefined
    const kept = String(c.consumptionId ?? id)
    const invalid = (why: string): OperatorCdr => ({ id: kept, line, direction: 'inbound', calling: '', called: '', startedAt: new Date(this.now()).toISOString(), durationSec: 0, invalid: why })
    // A date without its offset would be read at this host's hour (review 10b, n°19): one or two hours off.
    const at = typeof c.creationDatetime === 'string' ? c.creationDatetime : ''
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at) || Number.isNaN(Date.parse(at))) return invalid('creationDatetime without its offset')
    // The ways OVH documents, nothing else taken for a call (review 10b, n°20); a transfer is a forward OVH placed
    // (to a fallback number): an incoming call the platform never had.
    const way = c.wayType
    if (way !== 'incoming' && way !== 'outgoing' && way !== 'transfer') return invalid(`wayType ${String(way).slice(0, 32)}`)
    return {
      id: kept,
      line,
      direction: way === 'outgoing' ? 'outbound' : 'inbound',
      calling: fromOvhNumber(c.calling ?? ''),
      called: fromOvhNumber(c.called ?? ''),
      startedAt: new Date(Date.parse(at)).toISOString(),
      durationSec: Math.max(0, Math.round(Number(c.duration) || 0)),
      ...(way === 'transfer' ? { forwarded: true as const } : {})
    }
  }
}
