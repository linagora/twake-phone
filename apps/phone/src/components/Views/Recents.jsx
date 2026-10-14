import React, { useEffect } from 'react'

import { useI18n } from 'twake-i18n'

import { RecentsList } from '@/components/RecentsList'
import { usePhone } from '@/telephony/PhoneProvider'

export const Recents = () => {
  const { t } = useI18n()
  const { actions } = usePhone()
  const { markRecentsSeen, dial } = actions

  // Opening the list clears the missed-calls badge.
  useEffect(() => {
    markRecentsSeen()
  }, [markRecentsSeen])

  return (
    <section
      className="ph-panel ph-recents ph-recents-page"
      aria-label={t('recents.title')}
    >
      <RecentsList onRecall={dial} />
    </section>
  )
}
