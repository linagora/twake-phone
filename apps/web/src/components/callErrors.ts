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
  dnd: 'call.errorTransferDnd',
  'answered-elsewhere': 'call.errorTransferFailed',
  refused: 'call.errorTransferNotAllowed',
  conference: 'call.errorTransferFailed'
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
  'transfer-refused': 'call.errorTransferRefused',
  'transfer-external': 'call.errorTransferExternal',
  'room-call': 'call.errorRoomCall',
  'call-held': 'conference.errorHeld',
  'conference-pending': 'conference.errorInProgress'
}

/**
 * Why a conference did not begin (`making`: the call was to become one) or a room did not call someone (step 8b), in
 * the person's words: the Gateway's `code`, else a softphone error, else as it came. An error that came once the
 * conference was made (`conferenceMade`: the call to the third participant) is that call's, never the conference's.
 */
export const describeConferenceError = (err: unknown, t: T, { making = false, who = '' }: { making?: boolean; who?: string } = {}): string => {
  const failed = err as { code?: unknown; status?: unknown; conferenceMade?: unknown } | null
  if (failed?.conferenceMade === true) making = false
  switch (failed?.code) {
    case 'CONFERENCE_EXTERNAL':
      return t('conference.errorExternal')
    case 'CALL_NOT_ANSWERED':
      return t('conference.errorNotAnswered')
    case 'DIAL_FAILED':
      return making ? t('conference.errorNotStarted') : t('conference.errorDialFailed', { who })
    case 'CONFERENCE_LIMIT':
    case 'DIAL_OUT_LIMIT':
      return t('conference.errorLimit')
    case 'CONFERENCE_UNAVAILABLE':
    case 'CALL_DIVERTED':
    case 'SIP_SERVER_UNAVAILABLE':
      return t('conference.errorUnavailable')
    case 'CONFERENCE_IN_PROGRESS':
      return t('conference.errorInProgress')
    case 'CONFERENCE_ABANDONED':
      return t('conference.errorAbandoned')
    case 'CONFERENCE_UNSUPPORTED':
      return t('conference.errorUnsupported')
  }
  if (failed?.status === 501) return t('conference.errorUnavailable')
  if (err instanceof CallError) return describeCallError(err, t)
  return t('conference.errorAction', { reason: err instanceof Error ? err.message : String(err) })
}

/** A softphone error in the person's language (the SIP status stays, for whoever reports it); anything else as it came. */
export const describeCallError = (err: unknown, t: T): string => {
  if (!(err instanceof CallError)) return err instanceof Error ? err.message : String(err)
  const status = err.status === undefined ? '' : ` (${err.status})`
  if (err.code === 'transfer-failed' || err.code === 'transfer-no-answer') return t(TRANSFER_REASON_KEY[err.reason ?? 'failed'], { status })
  const key = CODE_KEY[err.code]
  return key ? t(key, { status }) : err.message
}
