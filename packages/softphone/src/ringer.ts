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

/** An audio element in a browser that lets a page choose its output device. */
export type Sinkable = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }

const PERIOD_MS = 4_000
/** Seconds within each period during which the tone sounds. */
const BURSTS: [number, number][] = [
  [0, 0.5],
  [0.8, 1.3]
]
const TONES_HZ = [440, 480]
const LEVEL = 0.2
/**
 * How long `resume()` waits for the AudioContext: when the browser blocks sound until a gesture, Chromium and
 * Firefox leave `AudioContext.resume()` pending (it settles after the gesture) rather than rejecting it.
 */
export const RESUME_WAIT_MS = 500

/** The pieces of the Web Audio API the ringer uses, so that a test can stand in for a browser. */
export interface AudioContextLike {
  readonly state: AudioContextState
  readonly currentTime: number
  resume(): Promise<void>
  suspend(): Promise<void>
  close(): Promise<void>
  createMediaStreamDestination(): { stream: MediaStream }
  createGain(): GainNode
  createOscillator(): OscillatorNode
}

export class WebAudioRinger implements RingerLike {
  private ctx?: AudioContextLike
  private gain?: GainNode
  private audio?: Sinkable
  private timer?: ReturnType<typeof setInterval>
  private ringing = false
  /** The browser let the context run at least once: it will again without a gesture. */
  private allowed = false

  constructor(
    private readonly container: HTMLElement,
    private readonly createContext: () => AudioContextLike = () => new AudioContext()
  ) {}

  private ensure() {
    if (this.ctx && this.gain && this.audio) return { ctx: this.ctx, gain: this.gain, audio: this.audio }
    const ctx = this.createContext()
    const destination = ctx.createMediaStreamDestination()
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(destination as unknown as AudioNode)
    for (const hz of TONES_HZ) {
      const oscillator = ctx.createOscillator()
      oscillator.frequency.value = hz
      oscillator.connect(gain)
      oscillator.start()
    }
    const audio: Sinkable = document.createElement('audio')
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

  /**
   * Resolves false only when the browser wants a gesture first: a context that would not run, or a `play()`
   * refused for that reason. A `play()` cut short by `stop()` is not a blocked sound, and neither is a context
   * `stop()` suspended after it had run.
   */
  async resume() {
    if (!this.ctx || !this.audio) return true
    const { ctx, audio } = this
    const running = await Promise.race([
      ctx.resume().then(
        () => true,
        () => ctx.state === 'running'
      ),
      new Promise<boolean>(resolve => setTimeout(() => resolve(ctx.state === 'running'), RESUME_WAIT_MS))
    ])
    if (running) this.allowed = true
    if (!this.ringing) return this.allowed
    if (!running) return false
    return audio.play().then(
      () => true,
      (err: unknown) => !this.ringing || (err as { name?: string } | null)?.name !== 'NotAllowedError'
    )
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
    // Nothing to render until the next ring: the audio thread is let go (once allowed, it comes back without a gesture).
    void this.ctx?.suspend().catch(() => undefined)
  }

  async setSink(deviceId: string) {
    const { audio } = this.ensure()
    if (audio.setSinkId) await audio.setSinkId(deviceId).catch(() => undefined)
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
