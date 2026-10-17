// Types of fake-ovh.mjs, for the specs that use it.

/** A record of a call as OVH lists it (telephony.ServiceVoiceConsumption). */
export interface FakeConsumption {
  consumptionId?: number
  calling: string
  called: string
  creationDatetime: string
  duration: number
  wayType: string
  [key: string]: unknown
}

export interface FakeLine {
  options?: Record<string, unknown>
  consumptions?: FakeConsumption[]
}

export interface FakeRequest {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  status: number
  signed: boolean
}

export interface FakeRule {
  method: string
  path: string
}

export interface FakeState {
  accounts: Record<string, { lines: Record<string, FakeLine> }>
  clockOffsetSec: number
  rules: FakeRule[]
  down: boolean
  /** The records created before it are in the previous billing period (ms). */
  monthStart: number | undefined
  /** Whether OVH takes a delay of no answer (400 INVALID_PARAMETER otherwise). */
  acceptDelay: ((sec: number) => boolean) | undefined
  /** What OVH keeps of a PUT of the options of a line. */
  normalize: ((changes: Record<string, unknown>) => Record<string, unknown>) | undefined
  /** A 302 to this URL to every signed call. */
  redirect: string | undefined
  /** A 200 with this body (no JSON) to every signed call. */
  garbage: string | undefined
}

export interface FakeOvh {
  url: string
  credentials: { applicationKey: string; applicationSecret: string; consumerKey: string }
  requests: FakeRequest[]
  state: FakeState
  options(billingAccount: string, line: string): Record<string, unknown> | undefined
  addConsumption(billingAccount: string, line: string, c: FakeConsumption): number
  stop(): Promise<void>
}

export declare const pilotRules: (billingAccount: string) => FakeRule[]
export declare const defaultLineOptions: () => Record<string, unknown>
export declare const startFakeOvh: (options?: {
  applicationKey?: string
  applicationSecret?: string
  consumerKey?: string
  rules?: FakeRule[]
  accounts?: Record<string, { lines: Record<string, FakeLine> }>
  clockOffsetSec?: number
  windowSec?: number
}) => Promise<FakeOvh>
