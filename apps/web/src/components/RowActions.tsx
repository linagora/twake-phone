import { Copy, InfoOutlined, Telephone } from '@linagora/twake-icons'
import { IconButton, SvgIcon, Tooltip, useAlert } from '@linagora/twake-mui'
import type { ElementType } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { formatNumber } from '@twake/telephony-client'
import { useT } from '../i18n/useT.js'
import { useCallNumber } from '../useCallNumber.js'

type IconProps = { label: string; icon: typeof Telephone }

/** An action of a row: an icon, named by its label (aria-label and tooltip, the same text). */
const RowAction = ({ label, icon, ...rest }: IconProps & ({ onClick: () => void } | { to: string })) => (
  <Tooltip title={label}>
    {'to' in rest ? (
      <IconButton component={RouterLink as ElementType} to={rest.to} aria-label={label}>
        <SvgIcon component={icon} inheritViewBox />
      </IconButton>
    ) : (
      <IconButton onClick={rest.onClick} aria-label={label} color={icon === Telephone ? 'primary' : 'default'}>
        <SvgIcon component={icon} inheritViewBox />
      </IconButton>
    )}
  </Tooltip>
)

/** Calls the number (the shared way, `useCallNumber`); nothing for a number that cannot be called. */
export const CallAction = ({ number, label }: { number: string; label: string }) => {
  const { showAlert } = useAlert()
  const { call, can } = useCallNumber(text => text && showAlert({ message: text, severity: 'error' }))
  return can(number) ? <RowAction label={label} icon={Telephone} onClick={() => void call(number)} /> : null
}

/** Copies the number, and says so (or that the browser refused). */
export const CopyAction = ({ number, label }: { number: string; label: string }) => {
  const { t } = useT()
  const { showAlert } = useAlert()
  const copy = () =>
    navigator.clipboard
      .writeText(number)
      .then(() => showAlert({ message: t('actions.copied', { number: formatNumber(number) }), severity: 'success', role: 'status', duration: 3_000 }))
      .catch(() => showAlert({ message: t('actions.copyFailed'), severity: 'error' }))
  return number && number !== 'anonymous' ? <RowAction label={label} icon={Copy} onClick={() => void copy()} /> : null
}

/** Opens the person's card of the directory. */
export const OpenCardAction = ({ id, label }: { id: string; label: string }) => <RowAction label={label} icon={InfoOutlined} to={`/directory/${encodeURIComponent(id)}`} />
