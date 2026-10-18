import type { Store } from './store/types.js'

// Which Gateway writes the mailboxes of a tenant (step 11a, ADR 0022; third review 11a, n°2, n°3 and n°11): the one that
// holds the lease `voicemail:<tenant>` of the store (takeWebhookLease, the lease of step 10a), within its write
// window only. Only a Gateway with a voicemail server for the tenant takes it: one without never writes
// `voicemail_boxes`. One whose voicemail server answers and whose events are heard takes it at once from one that has
// one it does not reach: the mailboxes never wait behind a Gateway that cannot do them.

/** The role of the lease of the mailboxes of `tenantId`. */
export const voicemailRole = (tenantId: string) => `voicemail:${tenantId}`

/**
 * What a Gateway can do for the mailboxes of a tenant: 2 its voicemail server answers and its events are heard, 1 it
 * has one it does not reach; undefined it has none (it never takes the lease).
 */
export type VoicemailWeight = 2 | 1 | undefined

export interface VoicemailLeaseOptions {
  store: Pick<Store, 'takeWebhookLease' | 'clock'>
  /** Who this Gateway is for the lease. */
  holder: string
  /** How long the lease is taken for: 45 s by default (renewed every third; a write may take 10 s, a third is 15 s). */
  ms?: number
  /** The tenants this Gateway may write the mailboxes of, and what it can do for each. */
  tenants: () => Iterable<readonly [tenantId: string, weight: VoicemailWeight]>
  /** Called when this Gateway may write the mailboxes of `tenantId` from now on (its write window opened). */
  onLead: (tenantId: string) => void
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void }
  now?: () => number
}

/** The leases of the mailboxes, one per tenant, held by this Gateway or not. */
export class VoicemailLeases {
  private readonly ms: number
  private readonly now: () => number
  /** The write window of each lease held: this clock reckoned on the store's (skew). */
  private readonly held = new Map<string, { writeFrom: number; writeUntil: number }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private skew = 0
  private skewError = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private renewal: Promise<void> | undefined
  private closed = false

  constructor(private readonly options: VoicemailLeaseOptions) {
    this.ms = options.ms ?? 45_000
    this.now = options.now ?? Date.now
  }

  /** The store's clock as this Gateway reckons it. */
  private clock() {
    return this.now() + this.skew
  }

  /**
   * Whether this Gateway may write the mailboxes of `tenantId` now (in Wazo, in `voicemail_boxes`, the release of the
   * guard): it holds the lease, its window opened and has not closed, whatever its reckoning of the store's clock is
   * off by. Asked before each write (third review 11a, n°2): a Gateway that lost the lease mid-round stops there.
   */
  mayWrite(tenantId: string) {
    const lease = this.held.get(tenantId)
    if (!lease || this.closed) return false
    const at = this.clock()
    return at - this.skewError >= lease.writeFrom && at + this.skewError < lease.writeUntil
  }

  start() {
    void this.renew()
    this.timer = setInterval(() => void this.renew(), Math.max(50, Math.floor(this.ms / 3)))
    this.timer.unref()
  }

  /** Takes or renews the leases (one renewal at a time), reading the store's clock again. */
  renew(): Promise<void> {
    this.renewal ??= this.renewAll().finally(() => (this.renewal = undefined))
    return this.renewal
  }

  private async renewAll() {
    if (this.closed) return
    try {
      const before = this.now()
      const db = Date.parse(await this.options.store.clock())
      const after = this.now()
      this.skew = db - (before + after) / 2
      this.skewError = (after - before) / 2
    } catch (err) {
      this.options.logger.error({ err }, 'mailboxes: the clock of the store not read, the leases of the mailboxes not renewed')
      this.held.clear()
      return
    }
    const seen = new Set<string>()
    for (const [tenantId, weight] of this.options.tenants()) {
      if (weight === undefined || this.closed) continue
      seen.add(tenantId)
      try {
        const lease = await this.options.store.takeWebhookLease(voicemailRole(tenantId), this.options.holder, this.ms, weight)
        const had = this.held.has(tenantId)
        // Stopped meanwhile: a lease taken is kept for stop() to give back, nothing more.
        if (this.closed) {
          if (lease) this.held.set(tenantId, { writeFrom: Date.parse(lease.writeFrom), writeUntil: Date.parse(lease.writeUntil) })
          return
        }
        if (!lease) {
          if (had) this.options.logger.warn({ tenantId }, 'mailboxes: another Gateway writes them now')
          this.held.delete(tenantId)
          continue
        }
        this.held.set(tenantId, { writeFrom: Date.parse(lease.writeFrom), writeUntil: Date.parse(lease.writeUntil) })
        if (!had) {
          this.options.logger.info({ tenantId, from: lease.writeFrom, weight }, 'mailboxes: written by this Gateway')
          this.whenWritable(tenantId)
        }
      } catch (err) {
        this.held.delete(tenantId)
        this.options.logger.error({ err, tenantId }, 'mailboxes: their lease not renewed')
      }
    }
    // A tenant no longer this Gateway's to write (its voicemail server gone): its lease is not renewed, it lapses.
    for (const tenantId of [...this.held.keys()]) if (!seen.has(tenantId)) this.held.delete(tenantId)
  }

  /** onLead once the window of the lease taken opens (what the holder before could still write is done). */
  private whenWritable(tenantId: string) {
    clearTimeout(this.timers.get(tenantId))
    const lease = this.held.get(tenantId)
    if (!lease || this.closed) return
    const wait = lease.writeFrom + this.skewError - this.clock()
    if (wait <= 0) {
      this.timers.delete(tenantId)
      this.options.onLead(tenantId)
      return
    }
    const t = setTimeout(() => this.whenWritable(tenantId), Math.ceil(wait) + 1)
    t.unref()
    this.timers.set(tenantId, t)
  }

  /** Stops renewing, and gives back the leases held: another Gateway writes from a third of the lease later. */
  async stop() {
    this.closed = true
    clearInterval(this.timer)
    for (const t of this.timers.values()) clearTimeout(t)
    await this.renewal?.catch(() => undefined)
    for (const tenantId of [...this.held.keys()]) await this.options.store.takeWebhookLease(voicemailRole(tenantId), this.options.holder, 0).catch(() => undefined)
    this.held.clear()
  }
}
