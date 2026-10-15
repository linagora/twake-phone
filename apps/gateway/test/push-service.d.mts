// Types of push-service.mjs, for the specs that use it (push.spec.ts).
import type { ECDH } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { Agent } from 'node:https'

/** What a push carried, once decrypted: the Gateway's message to the service worker. */
export interface PushData {
  type: string
  callId: string
  until?: number
  [key: string]: unknown
}

export interface VapidCheck {
  publicKey: string
  claims: Record<string, unknown>
}

/** A message the service took: its VAPID signature checked and its body decrypted, or why not (`error`). */
export interface PushMessage {
  id: string
  receivedAt: number
  headers: IncomingHttpHeaders
  body: Buffer
  vapid?: VapidCheck
  text?: string
  data?: PushData
  error?: string
  taken?: boolean
}

/** What PushSubscription.toJSON() gives in a browser. */
export interface BrowserSubscription {
  id: string
  endpoint: string
  expirationTime: null
  keys: { p256dh: string; auth: string }
}

export interface PushService {
  origin: string
  agent: Agent
  messages: PushMessage[]
  subscribe(): BrowserSubscription
  gone(id: string): void
  next(id: string, match?: (m: PushMessage) => boolean, timeout?: number): Promise<PushMessage>
  stop(): Promise<void>
}

export declare const decryptPush: (body: Buffer, keys: { ecdh: ECDH; auth: Buffer }) => string
export declare const verifyVapid: (authorization: string | undefined, audience: string) => VapidCheck
export declare const startPushService: () => Promise<PushService>
