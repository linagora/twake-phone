/** "4 min 12", "1 min 03", "38 s" */
export const formatDuration = sec => {
  if (!sec) return ''
  if (sec < 60) return `${sec} s`
  return `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')}`
}

/** Running call timer: "04:14" or "1:02:03". */
export const formatTimer = ms => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${m}:${s}` : `${m}:${s}`
}

const sameDay = (a, b) => a.toDateString() === b.toDateString()

/** Time of day today, then "yesterday" (via the callback), then the short weekday. */
export const formatWhen = (
  ts,
  { now = Date.now(), lang = 'en', yesterday = 'Yesterday' } = {}
) => {
  const d = new Date(ts)
  const today = new Date(now)
  if (sameDay(d, today))
    return new Intl.DateTimeFormat(lang, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(d)
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return yesterday
  return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(d)
}

export const initials = value => {
  const words = (value ?? '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '#'
  // International numbers show their country code; extensions and other numbers a neutral mark.
  if (words[0].startsWith('+'))
    return '+' + (words[0].replace(/\D/g, '').slice(0, 2) || '')
  if (/^[\d*#]/.test(words[0])) return '#'
  return words
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase()
}

const PALETTE = [
  ['#FCE3D6', '#8A3412'],
  ['#DCE4FF', '#1A36A8'],
  ['#DDF3E4', '#14663A'],
  ['#EADFF8', '#5B2A9E'],
  ['#FBE0DC', '#8E2414']
]
const NEUTRAL = ['#EEF0F6', '#4F566B']

/** Stable colours per person; numbers that match no contact stay neutral. */
export const avatarColors = (key, known) => {
  if (!known) return NEUTRAL
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
