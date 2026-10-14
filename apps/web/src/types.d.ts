declare module '*.css'

/** Read-only view of the page's phone for end-to-end tests: states and counters, never actions. */
interface Window {
  twakephone?: {
    state: string
    calls: { id: string; direction: string; state: string; remoteNumber: string; remoteHold: boolean; muted: boolean }[]
    tones: Record<string, string>
    stats: () => Promise<{ packetsReceived: number; packetsSent: number }[]>
  }
}
