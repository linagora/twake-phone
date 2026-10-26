import { useNavigate } from 'react-router-dom'
import { toDialTarget } from '@twake/telephony-client'
import { describeCallError } from './components/callErrors.js'
import { useT } from './i18n/useT.js'
import { usePhone } from './softphone.js'

/**
 * Calls a number back: from the browser when its softphone can (the call panel takes over), else from the dialer,
 * filled in. `setNotice` gets the failure, or null when a new try starts.
 */
export const useCallBack = (setNotice: (notice: string | null) => void) => {
  const { t } = useT()
  const phone = usePhone()
  const navigate = useNavigate()
  return async (number: string) => {
    const target = toDialTarget(number)
    if (!target) return
    setNotice(null)
    if (phone.state !== 'registered' || phone.calls.length) {
      void navigate(`/?number=${encodeURIComponent(number)}`)
      return
    }
    try {
      await phone.call(target)
    } catch (err) {
      setNotice(t('dialer.failed', { reason: describeCallError(err, t) }))
    }
  }
}
