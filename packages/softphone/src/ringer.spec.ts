import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESUME_WAIT_MS, WebAudioRinger, type AudioContextLike } from './ringer.js'

/** The Web Audio API as the ringer uses it; `blocked` keeps `resume()` pending, as browsers do until a gesture. */
const fakeContext = (blocked = false) => {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() })
  const ctx = {
    state: (blocked ? 'suspended' : 'running') as AudioContextState,
    currentTime: 0,
    resume: vi.fn(() => (blocked ? new Promise<void>(() => undefined) : Promise.resolve(void (ctx.state = 'running')))),
    suspend: vi.fn(async () => void (ctx.state = 'suspended')),
    close: vi.fn(async () => void (ctx.state = 'closed')),
    createMediaStreamDestination: () => ({ stream: {} as MediaStream }),
    createGain: () => ({ gain: param(), connect: vi.fn() }) as unknown as GainNode,
    createOscillator: () => ({ frequency: param(), connect: vi.fn(), start: vi.fn() }) as unknown as OscillatorNode,
    unblock: () => void (ctx.state = 'running')
  }
  return ctx satisfies AudioContextLike
}

const fakeAudio = () => ({
  srcObject: null as unknown,
  dataset: {} as Record<string, string>,
  paused: true,
  sinkId: '',
  play: vi.fn(async () => void (audio.paused = false)),
  pause: vi.fn(() => void (audio.paused = true)),
  remove: vi.fn(),
  setSinkId: vi.fn(async (id: string) => void (audio.sinkId = id))
})
let audio = fakeAudio()
const container = { appendChild: vi.fn() } as unknown as HTMLElement

describe('WebAudioRinger', () => {
  beforeEach(() => {
    audio = fakeAudio()
    vi.stubGlobal('document', { createElement: () => audio })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rings through an audio element the page can route, and lets the audio thread go when it stops', async () => {
    const ctx = fakeContext()
    const ringer = new WebAudioRinger(container, () => ctx)
    await ringer.setSink('bell')
    expect(audio.setSinkId).toHaveBeenCalledWith('bell')
    expect(audio.dataset['testid']).toBe('ringer')
    expect(container.appendChild).toHaveBeenCalledWith(audio)
    expect(await ringer.start()).toBe(true)
    expect(audio.paused).toBe(false)
    ringer.stop()
    expect(audio.paused).toBe(true)
    expect(ctx.suspend).toHaveBeenCalled()
    // Once allowed, the context comes back for the next ring without a gesture.
    expect(await ringer.start()).toBe(true)
    expect(ctx.resume).toHaveBeenCalledTimes(2)
    ringer.dispose()
    expect(audio.remove).toHaveBeenCalled()
    expect(ctx.close).toHaveBeenCalled()
  })

  it('reports the browser blocking sound without waiting on a resume() that never settles, then plays after the gesture', async () => {
    const ctx = fakeContext(true)
    const ringer = new WebAudioRinger(container, () => ctx)
    const started = ringer.start()
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS + 1)
    expect(await started).toBe(false)
    expect(audio.play).not.toHaveBeenCalled()
    // The person clicked: the browser lets the context run, the ringtone plays.
    ctx.unblock()
    const resumed = ringer.resume()
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS + 1)
    expect(await resumed).toBe(true)
    expect(audio.play).toHaveBeenCalledTimes(1)
  })

  it('does not take a playback cut short by stop() for a blocked sound, but a refused one is', async () => {
    const ctx = fakeContext()
    const ringer = new WebAudioRinger(container, () => ctx)
    let settle: (err: Error) => void = () => undefined
    audio.play.mockImplementationOnce(() => new Promise((_, reject) => void (settle = reject)))
    const started = ringer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(audio.play).toHaveBeenCalledTimes(1)
    // Answered elsewhere before the element got going: the browser aborts the play() in flight.
    ringer.stop()
    settle(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    expect(await started).toBe(true)
    audio.play.mockRejectedValueOnce(Object.assign(new Error('gesture'), { name: 'NotAllowedError' }))
    expect(await ringer.start()).toBe(false)
  })

  it('only wakes the context, without playing, when asked to resume while not ringing', async () => {
    const ctx = fakeContext()
    const ringer = new WebAudioRinger(container, () => ctx)
    await ringer.setSink('')
    expect(await ringer.resume()).toBe(true)
    expect(ctx.resume).toHaveBeenCalled()
    expect(audio.play).not.toHaveBeenCalled()
  })
})
