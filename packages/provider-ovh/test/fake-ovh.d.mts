// Types of fake-ovh.mjs, for the specs that use it.

/** A record of a call as OVH lists it (telephony.ServiceVoiceConsumption). */
export interface FakeConsumption {
  consumptionId?: number
  calling: string
  called: string
  creationDatetime: string
  duration: number
  wayType: 'incoming' | 'outgoing' | 'transfer'
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

export interface FakeOvh {
  url: string
  credentials: { applicationKey: string; applicationSecret: string; consumerKey: string }
  requests: FakeRequest[]
  state: { accounts: Record<string, { lines: Record<string, FakeLine> }>; clockOffsetSec: number; rules: { method: string; path: string }[]; down: boolean }
  options(billingAccount: string, line: string): Record<string, unknown> | undefined
  addConsumption(billingAccount: string, line: string, c: FakeConsumption): number
  stop(): Promise<void>
}

export declare const defaultLineOptions: () => Record<string, unknown>
export declare const startFakeOvh: (options?: {
  applicationKey?: string
  applicationSecret?: string
  consumerKey?: string
  rules?: { method: string; path: string }[]
  accounts?: Record<string, { lines: Record<string, FakeLine> }>
  clockOffsetSec?: number
  windowSec?: number
}) => Promise<FakeOvh>
