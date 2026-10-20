import type { SupervisionProvider } from '@twake/telephony-provider-sdk'
import type { SupervisedCall, SupervisionMode } from '@twake/telephony-types'
import { amiAction, AmiError, type AmiConfig, type AmiMessage } from './ami.js'

// What a supervisor can do with the calls that have a channel at Wazo (step 11d, ADR 0029): the AMI of its Asterisk for
// the calls (CoreShowChannels), the recording (MixMonitor) and the supervision (ChanSpy), a recordings server for the
// files. Wazo's own words (channels, Asterisk's options, contexts) stay in this package.

export interface WazoSupervisionConfig {
  /**
   * The Gateway's account in the AMI of Asterisk for the calls in progress and MixMonitor: `system` and `reporting` (nothing
   * else, and no `originate`: with both, an Originate may run any application, System included).
   */
  ami: AmiConfig
  /** Its other account, for Originate only (the recording notice, a supervisor's call): `originate`, read `call`; no `system`. */
  originate: AmiConfig
  /** The recordings server (`http://127.0.0.1:8670`): GET, HEAD and DELETE `/<tenant>/<name>`, with the bearer token. */
  recordingsUrl: string
  recordingsToken: string
  /**
   * The announcement of a recording, a sound of Asterisk as Playback names it (no language: it is looked for in the sounds
   * directory itself too). Default: custom/twake-recording-notice.
   */
  noticeSound?: string
  /** Where Asterisk keeps the recordings (the folder Wazo's call-logd reads). Default: /var/lib/wazo/sounds/tenants. */
  monitorDir?: string
  /** The largest recording handed out, in bytes. Default: 512 MiB. */
  maxRecordingBytes?: number
  /** How long the recordings server may take to answer, in milliseconds. Default: 10 s. */
  requestTimeoutMs?: number
  fetch?: typeof fetch
  id?: string
}

/** Why an operation did not happen: the call is gone, Asterisk refused it, or nothing answered. */
export class SupervisionError extends Error {
  constructor(message: string, readonly code: 'gone' | 'refused' | 'unavailable' | 'notice') {
    super(message)
    this.name = 'SupervisionError'
  }
}

/** The number a supervisor's call comes from: not an extension, and never a call to supervise. */
export const SUPERVISION_CALLER = '0199'
/** An Asterisk unique id, which is what a call is for the Gateway. */
export const CALL_ID = /^[0-9]{1,12}\.[0-9]{1,12}$/
const LINE_CHANNEL = /^PJSIP\/([0-9]{1,40})-[0-9a-f]+$/i
const TENANT_FOLDER = /^[A-Za-z0-9_-]{1,64}$/
const RECORDING_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SOUND = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/
const EXTENSION = /^[0-9]{1,40}$/
/** The options of ChanSpy: by unique id (u), quiet (q), until the call ends (E); then whisper (w) or barge (B). */
const SPY_OPTIONS: Record<SupervisionMode, string> = { listen: 'uqE', whisper: 'uqEw', barge: 'uqEB' }

const known = (v: string | undefined) => (v && v !== '<unknown>' ? v : undefined)
const clock = (v: string | undefined) => {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(v ?? '')
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}

export class WazoSupervision implements SupervisionProvider {
  readonly id: string
  private readonly notice: string
  private readonly monitorDir: string
  private readonly maxBytes: number

  constructor(private readonly config: WazoSupervisionConfig) {
    this.id = config.id ?? 'wazo'
    this.notice = config.noticeSound ?? 'custom/twake-recording-notice'
    if (!SOUND.test(this.notice)) throw new Error('Wazo: the sound of the recording notice must be a name of Asterisk sound, such as custom/twake-recording-notice')
    this.monitorDir = (config.monitorDir ?? '/var/lib/wazo/sounds/tenants').replace(/\/+$/, '')
    this.maxBytes = config.maxRecordingBytes ?? 512 * 1024 * 1024
  }

  private async ami(action: Record<string, string | string[]>, options?: Parameters<typeof amiAction>[2], account: AmiConfig = this.config.ami) {
    try {
      return await amiAction(account, action, options)
    } catch (err) {
      if (err instanceof AmiError) throw new SupervisionError(err.message, err.reason === 'refused' ? 'refused' : 'unavailable')
      throw err
    }
  }

  async listCalls(): Promise<SupervisedCall[]> {
    const { events } = await this.ami({ Action: 'CoreShowChannels' }, { wait: 'list' })
    const now = Date.now()
    const calls: SupervisedCall[] = []
    for (const e of events) {
      if (e.Event !== 'CoreShowChannel') continue
      const line = LINE_CHANNEL.exec(e.Channel ?? '')
      // The call of a supervisor is no call to supervise: it runs ChanSpy once answered, and before that it is the line ringing with its number.
      if (!line || !CALL_ID.test(e.Uniqueid ?? '') || e.Application === 'ChanSpy' || known(e.CallerIDNum) === SUPERVISION_CALLER) continue
      const extension = line[1] as string
      // The number of the other party: the caller of a call Wazo placed (its caller id), else who the line is connected to.
      const peer = [known(e.CallerIDNum), known(e.ConnectedLineNum)].find(n => n && n !== extension)
      const peerName = known(peer === known(e.CallerIDNum) ? e.CallerIDName : e.ConnectedLineName)
      calls.push({
        id: e.Uniqueid as string,
        extension,
        ...(peer ? { peer } : {}),
        ...(peerName && peerName !== peer ? { peerName } : {}),
        state: e.ChannelStateDesc === 'Up' ? 'up' : 'ringing',
        startedAt: new Date(now - clock(e.Duration) * 1000).toISOString()
      })
    }
    return calls
  }

  /** Whether Asterisk still has this call (a channel with this unique id on a line). */
  private async has(id: string) {
    if (!CALL_ID.test(id)) return false
    return (await this.listCalls()).some(c => c.id === id)
  }

  /** An Originate that answers by its OriginateResponse: resolves when the called channel answered. */
  private async originate(fields: Record<string, string | string[]>, timeoutMs: number) {
    const { events } = await this.ami({ Action: 'Originate', Async: 'true', ...fields }, { events: 'call', wait: 'event', timeoutMs }, this.config.originate)
    const done: AmiMessage | undefined = events[0]
    if (done?.Response !== 'Success') throw new SupervisionError('the call did not come up', 'refused')
  }

  async startRecording(call: { id: string }, file: { tenant: string; name: string }): Promise<void> {
    this.checkFile(file)
    // The notice must be a sound the telephony server has: Playback of one it has not fails without a word, and the recording
    // would start in silence. The recordings server, on the host of Asterisk, says whether it is there.
    if (!(await this.noticeAvailable())) throw new SupervisionError('the recording notice is not on the telephony server', 'notice')
    if (!(await this.has(call.id))) throw new SupervisionError('the call is over', 'gone')
    // The announcement first, to both parties (Wazo's context for its recording beep: ChanSpy in barge mode on the
    // channel, whose peer hears it as well). No announcement, no recording: its failure ends here.
    await this.originate({ Channel: 'Local/s@wazo-play-beep', Application: 'Playback', Data: this.notice, Variable: `WAZO_PLAYBACK_CHANNEL=${call.id}`, Timeout: '15000' }, 25_000)
    await this.ami({ Action: 'MixMonitor', Channel: call.id, File: `${this.monitorDir}/${file.tenant}/monitor/${file.name}.wav` })
  }

  async stopRecording(call: { id: string }): Promise<void> {
    if (!CALL_ID.test(call.id)) return
    try {
      await this.ami({ Action: 'StopMixMonitor', Channel: call.id })
    } catch (err) {
      // A call that ended already took its recording with it.
      if (err instanceof SupervisionError && err.code === 'refused') return
      throw err
    }
  }

  async spy(call: { id: string }, supervisor: { extension: string }, mode: SupervisionMode): Promise<void> {
    if (!EXTENSION.test(supervisor.extension)) throw new SupervisionError('not a line', 'refused')
    if (!(await this.has(call.id))) throw new SupervisionError('the call is over', 'gone')
    await this.originate(
      {
        Channel: `PJSIP/${supervisor.extension}`,
        Application: 'ChanSpy',
        Data: `${call.id},${SPY_OPTIONS[mode]}`,
        // Not an extension (the screen would give it the name of the person who holds it): the supervisor reads who calls.
        CallerID: `"Supervision" <${SUPERVISION_CALLER}>`,
        Timeout: '30000'
      },
      40_000
    )
  }

  private checkFile(file: { tenant: string; name: string }) {
    if (!TENANT_FOLDER.test(file.tenant) || !RECORDING_NAME.test(file.name)) throw new SupervisionError('not a recording', 'refused')
  }

  private async server(method: 'GET' | 'HEAD' | 'DELETE', file: { tenant: string; name: string }) {
    this.checkFile(file)
    try {
      return await (this.config.fetch ?? fetch)(`${this.config.recordingsUrl.replace(/\/+$/, '')}/${file.tenant}/${file.name}`, {
        method,
        headers: { authorization: `Bearer ${this.config.recordingsToken}` },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 10_000),
        redirect: 'error'
      })
    } catch (err) {
      throw new SupervisionError(`the recordings server did not answer: ${(err as Error).message}`, 'unavailable')
    }
  }

  /** Whether the sound of the recording notice is on the host of Asterisk (its sounds directories, no language). */
  async noticeAvailable(): Promise<boolean> {
    let res: Response
    try {
      res = await (this.config.fetch ?? fetch)(`${this.config.recordingsUrl.replace(/\/+$/, '')}/sound/${this.notice}`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${this.config.recordingsToken}` },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 10_000),
        redirect: 'error'
      })
    } catch (err) {
      throw new SupervisionError(`the recordings server did not answer: ${(err as Error).message}`, 'unavailable')
    }
    if (res.status === 404) return false
    if (!res.ok) throw new SupervisionError(`the recordings server answered ${res.status}`, 'unavailable')
    return true
  }

  async statRecording(file: { tenant: string; name: string }): Promise<{ size: number } | undefined> {
    const res = await this.server('HEAD', file)
    if (res.status === 404) return undefined
    if (!res.ok) throw new SupervisionError(`the recordings server answered ${res.status}`, 'unavailable')
    return { size: Number(res.headers.get('content-length') ?? 0) }
  }

  async getRecording(file: { tenant: string; name: string }) {
    const res = await this.server('GET', file)
    if (res.status === 404) return undefined
    if (!res.ok || !res.body) throw new SupervisionError(`the recordings server answered ${res.status}`, 'unavailable')
    const size = res.headers.get('content-length') !== null ? Number(res.headers.get('content-length')) : undefined
    if (size !== undefined && size > this.maxBytes) throw new SupervisionError('the recording is larger than the bound', 'unavailable')
    const maxBytes = this.maxBytes
    const source = res.body
    return {
      contentType: 'audio/wav',
      ...(size !== undefined ? { size } : {}),
      body: (async function* () {
        let total = 0
        for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.length
          if (total > maxBytes) throw new SupervisionError('the recording is larger than the bound', 'unavailable')
          yield chunk
        }
      })()
    }
  }

  async deleteRecording(file: { tenant: string; name: string }): Promise<boolean> {
    const res = await this.server('DELETE', file)
    if (res.status === 404) return false
    if (!res.ok) throw new SupervisionError(`the recordings server answered ${res.status}`, 'unavailable')
    return true
  }

  async close(): Promise<void> {
    // Nothing is held open: one connection per operation.
  }
}
