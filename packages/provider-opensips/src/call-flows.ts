import type { CallFlowRoute } from '@twake/telephony-provider-sdk'
import type { Queryable } from './subscriber.js'

// Everything about the `call_flows` table lives here (step 11c-2, ADR 0028): the Gateway writes the numbers of the
// sequential groups, queues and voice menus once Wazo runs them, with how Wazo's Asterisk reaches each; opensips.cfg.tpl
// reads the row of the number dialled with the rules of the extension (one query, asynchronous) and sends the call to
// Wazo with that route in `X-Twake-Flow`. The route is opaque here: provider-wazo made it, Asterisk's dialplan reads it.
// Nothing is fenced: a write that comes late leaves a row the next round puts right.

export const CALL_FLOWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_flows (
    number VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    route TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);
`

/** The numbers OpenSIPS routes: digits (its query reads nothing else). */
const NUMBER = /^[0-9]{1,40}$/
/**
 * What a route may hold: the characters the script lets through to a SIP header and Asterisk's dialplan reads as
 * words (no comma, parenthesis, quote, space or semicolon).
 */
// (A menu of ten queues is some 700 characters: wazo-confd names a group `grp-<tenant>-<uuid>`.)
export const ROUTE = /^[A-Za-z0-9_.:=/~|-]{1,2000}$/

export interface CallFlowsOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider (the table may not exist yet on a fresh database). */
  ready?: () => Promise<void>
  /** The tenant whose flows these are (one per database for OpenSIPS: it does not read it). */
  tenantId?: string
}

type Rows<T> = { rows?: T[] } | undefined

/** Reads and writes the tenant's rows of `call_flows`. */
export class CallFlows {
  private readonly tenantId: string

  constructor(private readonly opts: CallFlowsOptions) {
    this.tenantId = opts.tenantId ?? 'default'
  }

  private async query<T>(text: string, values: unknown[]): Promise<T[]> {
    await this.opts.ready?.()
    const res = (await this.opts.pool.query(text, values)) as Rows<T>
    return res?.rows ?? []
  }

  /** The flows of the tenant, by number. */
  async list(): Promise<CallFlowRoute[]> {
    return this.query<CallFlowRoute>('SELECT number, route FROM call_flows WHERE tenant_id = $1 ORDER BY number', [this.tenantId])
  }

  /**
   * Exactly these flows for the tenant: the others go. One OpenSIPS would not read (a number that is not digits, a route
   * with other characters than a route has) is left out (`skipped`), as is a number that is the account of an extension
   * or the flow of another tenant. One statement, so OpenSIPS never reads half of it.
   */
  async set(routes: CallFlowRoute[]): Promise<{ skipped: string[] }> {
    const ok = routes.filter(r => NUMBER.test(r.number) && ROUTE.test(r.route))
    const wanted = new Map(ok.map(r => [r.number, r.route]))
    const skipped = [...new Set(routes.filter(r => !ok.includes(r)).map(r => r.number))]
    await this.query(
      `WITH gone AS (DELETE FROM call_flows WHERE tenant_id = $1 AND NOT (number = ANY($2::text[])))
       INSERT INTO call_flows (number, tenant_id, route) SELECT n, $1, r FROM unnest($2::text[], $3::text[]) AS w(n, r)
       ON CONFLICT (number) DO UPDATE SET route = EXCLUDED.route, updated_at = now()
       WHERE call_flows.tenant_id = EXCLUDED.tenant_id AND call_flows.route IS DISTINCT FROM EXCLUDED.route`,
      [this.tenantId, [...wanted.keys()], [...wanted.values()]]
    )
    return { skipped }
  }
}
