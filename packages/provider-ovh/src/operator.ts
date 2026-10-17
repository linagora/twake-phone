import type { OperatorCdr, OperatorFallback } from '@twake/telephony-types'
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

  constructor(options: OvhOperatorOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.billingAccount ?? '')) throw new Error('OVH billing account: letters, digits and . _ - (as the manager shows it, ab12345-ovh-1)')
    this.client = options.client ?? new OvhClient(options)
    this.account = segment(options.billingAccount)
  }

  private line(line: string) {
    return `/telephony/${this.account}/line/${segment(line)}`
  }

  async listLines(): Promise<string[]> {
    const lines = await this.client.request<unknown>('GET', `/telephony/${this.account}/line`)
    if (!Array.isArray(lines)) throw new OperatorError('unreachable', 'OVH GET /telephony/…/line: not a list')
    return lines.filter((l): l is string => typeof l === 'string')
  }

  async getFallback(line: string): Promise<OperatorFallback> {
    const o = (await this.client.request<OvhLineForwards | undefined>('GET', `${this.line(line)}/options`)) ?? {}
    const backup = o.forwardBackup && o.forwardBackupNature === 'number' && o.forwardBackupNumber ? fromOvhNumber(o.forwardBackupNumber) : undefined
    const noReply = o.forwardNoReply && o.forwardNoReplyNature === 'number' && o.forwardNoReplyNumber ? fromOvhNumber(o.forwardNoReplyNumber) : undefined
    // Two forwards to two numbers, or one elsewhere (a voicemail): no number of one fallback; told as it is.
    const number = backup && noReply && backup !== noReply ? undefined : (backup ?? noReply)
    return {
      ...(number ? { number } : {}),
      onUnavailable: !!o.forwardBackup,
      ...(o.forwardNoReply && typeof o.forwardNoReplyDelay === 'number' ? { noAnswerAfterSec: o.forwardNoReplyDelay } : {})
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

  async listCdrIds(line: string, from: string, to: string): Promise<string[]> {
    const ids = await this.client.request<unknown>('GET', `/telephony/${this.account}/service/${segment(line)}/voiceConsumption`, { query: { 'creationDatetime.from': from, 'creationDatetime.to': to } })
    if (!Array.isArray(ids)) throw new OperatorError('unreachable', 'OVH GET /telephony/…/voiceConsumption: not a list')
    return ids.filter(id => typeof id === 'number' || typeof id === 'string').map(String)
  }

  async getCdr(line: string, id: string): Promise<OperatorCdr | undefined> {
    let c: OvhVoiceConsumption | undefined
    try {
      c = await this.client.request<OvhVoiceConsumption>('GET', `/telephony/${this.account}/service/${segment(line)}/voiceConsumption/${segment(id)}`)
    } catch (err) {
      if (err instanceof OperatorError && err.code === 'not-found') return undefined
      throw err
    }
    const started = Date.parse(c?.creationDatetime ?? '')
    if (!c || Number.isNaN(started)) return undefined
    const way = c.wayType
    return {
      id: String(c.consumptionId ?? id),
      line,
      // A transfer is a forward OVH placed (to a fallback number): an incoming call the platform never had.
      direction: way === 'outgoing' ? 'outbound' : 'inbound',
      calling: fromOvhNumber(c.calling ?? ''),
      called: fromOvhNumber(c.called ?? ''),
      startedAt: new Date(started).toISOString(),
      durationSec: Math.max(0, Math.round(Number(c.duration) || 0)),
      ...(way === 'transfer' ? { forwarded: true as const } : {})
    }
  }
}
