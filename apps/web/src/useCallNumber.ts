import { useNavigate } from 'react-router-dom'
import { toDialTarget } from '@twake/telephony-client'
import { describeCallError } from './components/callErrors.js'
import { useGateway } from './gateway.js'
import { useT } from './i18n/useT.js'
import { usePhone } from './softphone.js'

/**
 * Whether a number shown somewhere can be called from there: not a hidden caller, not text, not the person's own
 * conference room (its number is their own extension).
 */
export const canCallNumber = (number: string | undefined | null, ownExtension?: string) =>
  !!number && number !== 'anonymous' && number !== ownExtension && toDialTarget(number) !== null

/**
 * The one way the app calls a number shown on a screen (Récents, messagerie, annuaire, fiche): from the browser when
 * its softphone is registered and free (the call panel takes over), else from the keypad, filled in, which knows the
 * other ways (the Gateway calling for the person) and says why it cannot. `onError` gets what went wrong, or null as a
 * new try starts.
 */
export const useCallNumber = (onError: (text: string | null) => void = () => undefined) => {
  const { t } = useT()
  const { me } = useGateway()
  const phone = usePhone()
  const navigate = useNavigate()
  const call = async (number: string) => {
    const target = canCallNumber(number, me?.extension) ? toDialTarget(number) : null
    if (!target) return
    onError(null)
    if (phone.state !== 'registered' || phone.calls.length) {
      void navigate(`/?number=${encodeURIComponent(number)}`)
      return
    }
    try {
      await phone.call(target)
    } catch (err) {
      onError(t('dialer.failed', { reason: describeCallError(err, t) }))
    }
  }
  return { call, can: (number: string | undefined | null) => canCallNumber(number, me?.extension) }
}
