// Icons of the Twake Phone design (stroke icons on a 24px grid). Sizes and colours follow the text by default.
import React from 'react'

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
}

export const Keypad = ({ size = 20, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <circle cx="6" cy="5" r="1.2" />
    <circle cx="12" cy="5" r="1.2" />
    <circle cx="18" cy="5" r="1.2" />
    <circle cx="6" cy="11" r="1.2" />
    <circle cx="12" cy="11" r="1.2" />
    <circle cx="18" cy="11" r="1.2" />
    <circle cx="6" cy="17" r="1.2" />
    <circle cx="12" cy="17" r="1.2" />
    <circle cx="18" cy="17" r="1.2" />
  </svg>
)

export const Clock = ({ size = 20, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const Contacts = ({ size = 20, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.5 3.5 5.2" />
  </svg>
)

export const Backspace = ({ size = 22, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z" />
    <path d="M17 9l-5 6M12 9l5 6" />
  </svg>
)

export const Search = ({ size = 18, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
)

export const ArrowIn = ({ size = 14, ...props }) => (
  <svg
    {...base}
    {...{ stroke: '#1C7A4A', strokeWidth: '2.4' }}
    width={size}
    height={size}
    {...props}
  >
    <path d="M17 7L7 17M7 9v8h8" />
  </svg>
)

export const ArrowMissed = ({ size = 14, ...props }) => (
  <svg
    {...base}
    {...{ stroke: '#C4321C', strokeWidth: '2.4' }}
    width={size}
    height={size}
    {...props}
  >
    <path d="M4 7l8 8 8-8M14 7h6v6" />
  </svg>
)

export const ArrowOut = ({ size = 14, ...props }) => (
  <svg
    {...base}
    {...{ stroke: '#2448D8', strokeWidth: '2.4' }}
    width={size}
    height={size}
    {...props}
  >
    <path d="M7 17L17 7M9 7h8v8" />
  </svg>
)

export const ChevronLeft = ({ size = 18, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
)

export const MicOff = ({ size = 24, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
  </svg>
)

export const Pause = ({ size = 24, ...props }) => (
  <svg
    {...base}
    {...{ strokeWidth: '2.2' }}
    width={size}
    height={size}
    {...props}
  >
    <path d="M9 5v14M15 5v14" />
  </svg>
)

export const Transfer = ({ size = 24, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <path d="M4 8h14l-4-4M20 16H6l4 4" />
  </svg>
)

export const ChevronDown = ({ size = 14, ...props }) => (
  <svg
    {...base}
    {...{ strokeWidth: '2.4' }}
    width={size}
    height={size}
    {...props}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const KeypadFilled = ({ size = 24, ...props }) => (
  <svg
    {...base}
    {...{ fill: 'currentColor' }}
    width={size}
    height={size}
    {...props}
  >
    <circle cx="6" cy="5" r="1.8" />
    <circle cx="12" cy="5" r="1.8" />
    <circle cx="18" cy="5" r="1.8" />
    <circle cx="6" cy="11" r="1.8" />
    <circle cx="12" cy="11" r="1.8" />
    <circle cx="18" cy="11" r="1.8" />
    <circle cx="6" cy="17" r="1.8" />
    <circle cx="12" cy="17" r="1.8" />
    <circle cx="18" cy="17" r="1.8" />
  </svg>
)

const PHONE =
  'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z'

export const Phone = ({ size = 24, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    width={size}
    height={size}
    {...props}
  >
    <path d={PHONE} />
  </svg>
)

/** Same handset rotated, for hang up / decline. */
export const Hangup = ({ size = 24, style, ...props }) => (
  <Phone
    size={size}
    style={{ transform: 'rotate(135deg)', ...style }}
    {...props}
  />
)

export const Video = ({ size = 20, ...props }) => (
  <svg {...base} width={size} height={size} {...props}>
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="M15 10l6-3v10l-6-3z" />
  </svg>
)
