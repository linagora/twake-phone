import React from 'react'

import { avatarColors, initials } from '@/telephony/format'

/** Round initials badge; numbers that match no contact stay neutral. */
export const Avatar = ({ label, known, className = '' }) => {
  const [background, color] = avatarColors(label ?? '', known)
  return (
    <div
      className={`ph-avatar ${className}`}
      style={{ background, color }}
      aria-hidden="true"
    >
      {initials(label)}
    </div>
  )
}
