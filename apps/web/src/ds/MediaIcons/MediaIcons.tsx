// Upstream candidate: twake-icons has no play or pause icon (it has Stop, Next, Previous).
import { SvgIcon, type SvgIconProps } from '@linagora/twake-mui'

export const PlayIcon = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M8 5v14l11-7z" />
  </SvgIcon>
)

export const PauseIcon = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M6 19h4V5H6zm8-14v14h4V5z" />
  </SvgIcon>
)

// twake-icons has no microphone or hang-up icon either (it has Telephone).
export const MicIcon = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3m5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72z" />
  </SvgIcon>
)

export const MicOffIcon = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28m-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73z" />
  </SvgIcon>
)

export const CallEndIcon = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7s.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71s-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9" />
  </SvgIcon>
)
