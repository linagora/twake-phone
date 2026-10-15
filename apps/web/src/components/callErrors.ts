import { CallError, type EndReason } from '@twake/softphone'
import type { Key } from '../i18n/index.js'

type T = (key: Key, params?: Record<string, string | number>) => string

/** What became of a transfer's new call, in the person's words. */
const TRANSFER_REASON_KEY: Record<EndReason, Key> = {
  unavailable: 'call.errorTransferUnavailable',
  busy: 'call.errorTransferBusy',
  rejected: 'call.errorTransferRejected',
  'no-answer': 'call.errorTransferNoAnswer',
  cancelled: 'call.errorTransferCancelled',
  failed: 'call.errorTransferFailed',
  hangup: 'call.errorTransferFailed',
  transferred: 'call.errorTransferFailed',
  dnd: 'call.errorTransferDnd'
}

const CODE_KEY: Partial<Record<CallError['code'], Key>> = {
  'not-started': 'call.errorNotStarted',
  'invalid-target': 'call.errorInvalidTarget',
  'too-many-calls': 'call.errorTooManyCalls',
  'call-in-progress': 'call.errorCallInProgress',
  'not-established': 'call.errorNotEstablished',
  'not-inbound': 'call.errorNotInbound',
  'invalid-tone': 'call.errorInvalidTone',
  'call-ended': 'call.errorCallEnded',
  'offer-pending': 'call.errorOfferPending',
  'offer-refused': 'call.errorOfferRefused',
  'transfer-in-progress': 'call.errorTransferInProgress',
  'transfer-self': 'call.errorTransferSelf',
  'transfer-refused': 'call.errorTransferRefused'
}

/** A softphone error in the person's language (the SIP status stays, for whoever reports it); anything else as it came. */
export const describeCallError = (err: unknown, t: T): string => {
  if (!(err instanceof CallError)) return err instanceof Error ? err.message : String(err)
  const status = err.status === undefined ? '' : ` (${err.status})`
  if (err.code === 'transfer-failed' || err.code === 'transfer-no-answer') return t(TRANSFER_REASON_KEY[err.reason ?? 'failed'], { status })
  const key = CODE_KEY[err.code]
  return key ? t(key, { status }) : err.message
}
