import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LintoError, LintoTranscription } from './index.js'

/** What LinTO STT's HTTP server was sent, and how it answers (its own way by default: the JSON once more in a string). */
interface Seen {
  method: string
  path: string
  accept?: string
  contentType?: string
  file?: { name?: string; type?: string; bytes: number }
}
type Answer = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

/** A LinTO STT of this process, as its HTTP mode answers: `/healthcheck`, and `/transcribe` with a multipart `file`. */
const linto = async (answer?: Answer) => {
  const seen: Seen[] = []
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const s: Seen = { method: req.method ?? '', path: req.url ?? '', ...(req.headers.accept ? { accept: req.headers.accept } : {}), ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}) }
      const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1]
      if (boundary) {
        const text = body.toString('latin1')
        const part = text.split(`--${boundary}`).find(p => /name="file"/.test(p))
        if (part) {
          const head = part.slice(0, part.indexOf('\r\n\r\n'))
          const content = part.slice(part.indexOf('\r\n\r\n') + 4, -2)
          s.file = { bytes: Buffer.byteLength(content, 'latin1'), ...(/filename="([^"]*)"/.exec(head) ? { name: /filename="([^"]*)"/.exec(head)![1] } : {}), ...(/Content-Type: (\S+)/i.exec(head) ? { type: /Content-Type: (\S+)/i.exec(head)![1] } : {}) }
        }
      }
      seen.push(s)
      if (answer) return answer(req, res, s)
      if (s.path === '/healthcheck') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      if (s.accept !== 'application/json') return res.writeHead(400).end('Server Error: Not accepted header')
      if (!s.file?.name) return res.writeHead(400).end('Server Error: No audio file was uploaded')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(JSON.stringify({ text: ' bonjour  jean\nrappelez-moi ', 'confidence-score': 0.8, words: [] })))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const wav = (bytes = 3200) => new Uint8Array(bytes).fill(7)

describe('LintoTranscription (LinTO STT, step 11b)', () => {
  it('sends the recording as the file of a multipart form, asks for JSON, and reads the text of its answer, encoded once more as a string by its HTTP server', async () => {
    const { url, seen } = await linto()
    const out = await new LintoTranscription({ url: `${url}/` }).transcribe(wav())
    expect(out).toEqual({ text: 'bonjour jean rappelez-moi' })
    expect(seen).toEqual([{ method: 'POST', path: '/transcribe', accept: 'application/json', contentType: expect.stringMatching(/^multipart\/form-data; boundary=/), file: { name: 'message.wav', type: 'audio/wav', bytes: 3200 } }])
  })

  it('reads an answer that is the JSON object itself too, and an empty text (nothing heard)', async () => {
    const { url } = await linto((_req, res) => res.writeHead(200).end('{"text":""}'))
    expect(await new LintoTranscription({ url }).transcribe(wav())).toEqual({ text: '' })
  })

  it('asks for a language only when given one (the Kaldi engine refuses any)', async () => {
    const { url, seen } = await linto()
    await new LintoTranscription({ url, language: 'fr-FR' }).transcribe(wav())
    expect(seen[0]!.path).toBe('/transcribe?language=fr-FR')
  })

  it('says how it failed in a few words, never what LinTO answered, with its status', async () => {
    const { url } = await linto((_req, res) => res.writeHead(500).end('Server Error: Traceback ... the words of the caller'))
    const err = await new LintoTranscription({ url }).transcribe(wav()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LintoError)
    expect(err).toMatchObject({ message: 'answered 500', status: 500 })
  })

  it('gives up past its bound, unread', async () => {
    const { url } = await linto(() => undefined)
    const err = await new LintoTranscription({ url, timeoutMs: 150 }).transcribe(wav()).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'no answer within 0.15 s' })
  })

  it('refuses a recording larger than its bound, or empty, before sending anything', async () => {
    const { url, seen } = await linto()
    const t = new LintoTranscription({ url, maxBytes: 1000 })
    await expect(t.transcribe(wav(1001))).rejects.toThrow('recording larger than 1000 bytes')
    await expect(t.transcribe(new Uint8Array())).rejects.toThrow('empty recording')
    expect(seen).toEqual([])
  })

  it('refuses an answer larger than its bound, or without a text', async () => {
    const big = await linto((_req, res) => res.writeHead(200).end(JSON.stringify({ text: 'x'.repeat(5000) })))
    await expect(new LintoTranscription({ url: big.url, maxAnswerBytes: 1000 }).transcribe(wav())).rejects.toThrow('answer larger than 1000 bytes')
    await new Promise<void>(resolve => server!.close(() => resolve()))
    const none = await linto((_req, res) => res.writeHead(200).end('{"words":[]}'))
    await expect(new LintoTranscription({ url: none.url }).transcribe(wav())).rejects.toThrow('answer without a text')
  })

  it('follows no redirect: the recording goes nowhere else', async () => {
    const { url, seen } = await linto((_req, res) => res.writeHead(307, { location: 'http://127.0.0.1:9/elsewhere' }).end())
    await expect(new LintoTranscription({ url }).transcribe(wav())).rejects.toThrow(/^not reached/)
    expect(seen).toHaveLength(1)
  })

  it('probes its health check', async () => {
    const { url, seen } = await linto()
    await new LintoTranscription({ url }).probe()
    expect(seen.map(s => s.path)).toEqual(['/healthcheck'])
    await new Promise<void>(resolve => server!.close(() => resolve()))
    const down = await linto((_req, res) => res.writeHead(503).end())
    await expect(new LintoTranscription({ url: down.url }).probe()).rejects.toThrow('healthcheck answered 503')
    await expect(new LintoTranscription({ url: 'http://127.0.0.1:9' }).probe()).rejects.toThrow('not reached')
  })

  it('takes an http or https URL without credentials, query or fragment only', () => {
    expect(() => new LintoTranscription({ url: 'ftp://linto.example.test' })).toThrow('http: or https:')
    expect(() => new LintoTranscription({ url: 'https://u:p@linto.example.test' })).toThrow('credentials')
    expect(() => new LintoTranscription({ url: 'https://linto.example.test/?a=1' })).toThrow('no query')
    expect(() => new LintoTranscription({ url: 'not a url' })).toThrow()
  })
})
