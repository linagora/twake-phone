/**
 * The ringtone: two short bursts every four seconds, made with WebAudio (nothing to fetch, nothing to allow in the
 * CSP), played through an audio element so the person can send it to a speaker while the voice goes to a headset.
 */
export interface RingerLike {
  /** Starts ringing. Resolves false when the browser keeps sound blocked until the person clicks somewhere. */
  start(): Promise<boolean>
  stop(): void
  /** Output device (`setSinkId`); the browser's default for an empty id. Ignored where the browser cannot choose. */
  setSink(deviceId: string): Promise<void>
  /** After a user gesture: plays what the browser blocked. Resolves whether sound now plays. */
  resume(): Promise<boolean>
  dispose(): void
}

const PERIOD_MS = 4_000
/** Seconds within each period during which the tone sounds. */
const BURSTS: [number, number][] = [
  [0, 0.5],
  [0.8, 1.3]
]
const TONES_HZ = [440, 480]
const LEVEL = 0.2

export class WebAudioRinger implements RingerLike {
  private ctx?: AudioContext
  private gain?: GainNode
  private audio?: HTMLAudioElement
  private timer?: ReturnType<typeof setInterval>
  private ringing = false

  constructor(private readonly container: HTMLElement) {}

  private ensure() {
    if (this.ctx && this.gain && this.audio) return { ctx: this.ctx, gain: this.gain, audio: this.audio }
    const ctx = new AudioContext()
    const destination = ctx.createMediaStreamDestination()
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(destination)
    for (const hz of TONES_HZ) {
      const oscillator = ctx.createOscillator()
      oscillator.frequency.value = hz
      oscillator.connect(gain)
      oscillator.start()
    }
    const audio = document.createElement('audio')
    audio.srcObject = destination.stream
    audio.dataset['testid'] = 'ringer'
    this.container.appendChild(audio)
    this.ctx = ctx
    this.gain = gain
    this.audio = audio
    return { ctx, gain, audio }
  }

  async start() {
    const { ctx, gain } = this.ensure()
    this.ringing = true
    const burst = () => {
      const now = ctx.currentTime
      for (const [on, off] of BURSTS) {
        gain.gain.setValueAtTime(LEVEL, now + on)
        gain.gain.setValueAtTime(0, now + off)
      }
    }
    burst()
    clearInterval(this.timer)
    this.timer = setInterval(burst, PERIOD_MS)
    return this.resume()
  }

  async resume() {
    if (!this.ctx || !this.audio) return true
    await this.ctx.resume().catch(() => undefined)
    const played = await this.audio.play().then(
      () => true,
      () => false
    )
    return played && this.ctx.state === 'running'
  }

  stop() {
    this.ringing = false
    clearInterval(this.timer)
    this.timer = undefined
    if (this.gain) {
      this.gain.gain.cancelScheduledValues(0)
      this.gain.gain.value = 0
    }
    this.audio?.pause()
  }

  async setSink(deviceId: string) {
    const { audio } = this.ensure()
    const sinkable = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    if (sinkable.setSinkId) await sinkable.setSinkId(deviceId).catch(() => undefined)
  }

  dispose() {
    this.stop()
    this.audio?.remove()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = undefined
    this.gain = undefined
    this.audio = undefined
  }
}
