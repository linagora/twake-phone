declare module '*.css'

/** Read-only view of the page's phone for end-to-end tests: states and counters, never actions. */
interface Window {
  twakephone?: {
    state: string
    calls: { id: string; sipCallId: string; direction: string; state: string; remoteNumber: string; remoteHold: boolean; muted: boolean; renegotiating: boolean; transferring: boolean; conferencing: boolean; replacedCallId?: string; consultationOf?: string; room?: string; conferenceOf?: string; conferenceRoom?: string }[]
    /** The last call that ended, kept a few seconds: why and, when the far end said so, the SIP status. */
    lastEnded: { id: string; remoteNumber: string; endReason?: string; endStatus?: number; endMessage?: string; endRefusal?: string } | null
    tones: Record<string, string>
    devices: { microphoneId?: string; outputId?: string; ringerId?: string }
    soundBlocked: boolean
    stats: () => Promise<{ packetsReceived: number; packetsSent: number; microphoneId?: string; outputId?: string }[]>
  }
}
