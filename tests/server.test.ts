import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheStore } from '../src/cache.ts'
import { EXTRACTOR_VERSION, loadConfig, type Config } from '../src/config.ts'
import { ExtractError } from '../src/errors.ts'
import type { LogEntry } from '../src/log.ts'
import { createApp } from '../src/server.ts'
import type { ExtractRunners } from '../src/textExtract.ts'
import type { DescribeImage, VisionOutcome } from '../src/vision.ts'
import { dataUrl, pngHeader } from './imageFixtures.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
const KEY = 'test-key-0123456789abcdef'

function memCache(): CacheStore & { map: Map<string, string>, ttls: number[] } {
  const map = new Map<string, string>()
  const ttls: number[] = []
  return {
    map,
    ttls,
    get: async k => map.get(k) ?? null,
    set: async (k, v, ttl) => { map.set(k, v); ttls.push(ttl) },
    sweep: async () => 0
  }
}

function fakeRunners(over: Partial<ExtractRunners> = {}): ExtractRunners {
  return {
    readText: vi.fn(async () => 'Счёт №5 от ООО «Ромашка», сумма 100'),
    pdfToText: vi.fn(async () => 'текст PDF достаточной длины, чтобы не уходить в OCR'),
    officeToText: vi.fn(async () => ({ text: 'a\tb\nc\td', sheets: [{ name: 'Лист1', csv: 'a\tb\nc\td', rows: 2 }] })),
    ocr: vi.fn(async () => ({ text: 'распознанный текст скана', pages: 3 })),
    htmlConvert: vi.fn(async (_p: string, to: string) => Buffer.from(to === 'pdf' ? '%PDF-1.7 x' : 'PK x')),
    ...over
  }
}

let server: Server | null = null
afterEach(async () => {
  if (server) await new Promise(r => server!.close(r))
  server = null
})

async function start(opts: { runners?: ExtractRunners, cache?: CacheStore, config?: Partial<Config>, logs?: LogEntry[], describe?: DescribeImage } = {}) {
  const config = { ...loadConfig({ NODE_ENV: 'test', EXTRACT_API_KEY: KEY }), ...opts.config }
  const logs = opts.logs ?? []
  server = createApp({ config, runners: opts.runners ?? fakeRunners(), cache: opts.cache ?? memCache(), log: e => logs.push(e), ...(opts.describe ? { describe: opts.describe } : {}) })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  const extract = (body: Uint8Array | string, name: string | null, auth: string | null = `Bearer ${KEY}`) => {
    const headers: Record<string, string> = {}
    if (name !== null) headers['x-file-name'] = encodeURIComponent(name)
    if (auth !== null) headers.authorization = auth
    return fetch(`${base}/v1/extract`, { method: 'POST', headers, body })
  }
  return { base, port, extract, logs }
}

describe('HTTP: /health', () => {
  it('200 и версия, без ключа', async () => {
    const { base } = await start()
    const r = await fetch(`${base}/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, version: expect.any(String) })
  })
})

describe('HTTP: POST /extract', () => {
  it('разбирает текстовый файл, считает sha256, второй раз отдаёт из кеша', async () => {
    const runners = fakeRunners()
    const { extract } = await start({ runners })
    const r1 = await extract('содержимое', 'Счёт клиента.txt')
    expect(r1.status).toBe(200)
    const j1 = (await r1.json()) as any
    expect(j1).toMatchObject({ kind: 'text', ocr: false, truncated: false, cached: false, sheets: [] })
    expect(j1.text).toContain('Ромашка')
    expect(j1.sha256).toMatch(/^[0-9a-f]{64}$/)
    const j2 = await (await extract('содержимое', 'другое имя.txt')).json()
    expect(j2).toMatchObject({ cached: true, sha256: j1.sha256, text: j1.text })
    expect(runners.readText).toHaveBeenCalledTimes(1)
  })
  it('таблица — листы с name/csv/rows', async () => {
    const { extract } = await start()
    const j = await (await extract('x', 'прайс.xlsx')).json() as any
    expect(j.sheets).toEqual([{ name: 'Лист1', csv: 'a\tb\nc\td', rows: 2 }])
  })
  it('скан — ocr и pages', async () => {
    const { extract } = await start()
    expect(await (await extract('x', 'scan.png')).json()).toMatchObject({ ocr: true, pages: 3, kind: 'image' })
  })
  const VISION = { url: 'http://vision:8080/v1', apiKey: 'k', model: 'vision', timeoutMs: 1000, maxTokens: 400 }
  const outcome = (o: VisionOutcome) => vi.fn(async (_b: Uint8Array, _s: AbortSignal) => o)
  it('картинка со зрением: description в ответе, описание — в начале text, OCR — под ним', async () => {
    const see = outcome({ description: 'Снимок экрана CRM.' })
    const { extract } = await start({ describe: see, config: { vision: VISION } })
    const body = await (await extract('x', 'scan.png')).json() as any
    expect(body).toMatchObject({ kind: 'image', description: 'Снимок экрана CRM.', text: 'Описание картинки: Снимок экрана CRM.\n\nТекст с картинки:\nраспознанный текст скана' })
    expect(Buffer.from(see.mock.calls[0]![0]).toString()).toBe('x')
  })
  it('зрение только у картинок: PDF и TXT его не зовут', async () => {
    const see = outcome({ description: 'x' })
    const { extract } = await start({ describe: see, config: { vision: VISION } })
    await extract('x', 'doc.pdf')
    await extract('x', 'a.txt')
    expect(see).not.toHaveBeenCalled()
  })
  it('зрение не держит место разбора (ревью #30): пока модель думает, следующий файл разбирается', async () => {
    let finish: (o: VisionOutcome) => void = () => {}
    const see = vi.fn(() => new Promise<VisionOutcome>(r => { finish = r }))
    const { extract } = await start({ describe: see, config: { vision: VISION, maxConcurrency: 1, queueTimeoutMs: 300 } })
    const shot = extract('x', 'shot.png')
    await vi.waitFor(() => expect(see).toHaveBeenCalled())
    const next = await extract('y', 'a.txt')
    expect(next.status).toBe(200)
    finish({ description: 'Снимок.' })
    expect(await (await shot).json()).toMatchObject({ description: 'Снимок.' })
  })
  it('зрение начинается вместе с OCR, а не после него', async () => {
    let ocrDone: () => void = () => {}
    const runners = fakeRunners({ ocr: vi.fn(() => new Promise<{ text: string, pages?: number }>(r => { ocrDone = () => r({ text: 'распознанный текст скана', pages: 1 }) })) })
    const see = outcome({ description: 'Снимок.' })
    const { extract } = await start({ runners, describe: see, config: { vision: VISION } })
    const p = extract('x', 'shot.png')
    await vi.waitFor(() => expect(runners.ocr).toHaveBeenCalled())
    expect(see).toHaveBeenCalled()
    ocrDone()
    expect(await (await p).json()).toMatchObject({ description: 'Снимок.' })
  })
  it('места разбора не дали (503) — зрение не начиналось (ревью #30)', async () => {
    let release: () => void = () => {}
    const runners = fakeRunners({ readText: vi.fn(() => new Promise<string>(r => { release = () => r('Счёт №5 от ООО «Ромашка», сумма 100') })) })
    const see = outcome({ description: 'x' })
    const { extract } = await start({ runners, describe: see, config: { vision: VISION, maxConcurrency: 1, queueTimeoutMs: 100 } })
    const slow = extract('x', 'a.txt')
    await vi.waitFor(() => expect(runners.readText).toHaveBeenCalled())
    expect((await extract('img', 'shot.png')).status).toBe(503)
    expect(see).not.toHaveBeenCalled()
    release()
    expect((await slow).status).toBe(200)
  })
  it('картинка, которой осталось только зрение, не держит место тела: следующий файл — 200, а не 503 (ревью #30)', async () => {
    let finish: (o: VisionOutcome) => void = () => {}
    const see = vi.fn(() => new Promise<VisionOutcome>(r => { finish = r }))
    const { extract } = await start({ describe: see, config: { vision: VISION, maxConcurrency: 1, maxQueue: 0 } })
    const shot = extract('x', 'shot.png')
    await vi.waitFor(() => expect(see).toHaveBeenCalled())
    await vi.waitFor(async () => expect((await extract('y', 'a.txt')).status).toBe(200))
    finish({ description: 'Снимок.' })
    expect(await (await shot).json()).toMatchObject({ description: 'Снимок.' })
  })
  it('разбор упал — зрение отменяется', async () => {
    const got: { s?: AbortSignal } = {}
    const see = vi.fn((_b: Uint8Array, s: AbortSignal) => {
      got.s = s
      return new Promise<VisionOutcome>(r => s.addEventListener('abort', () => r({ failure: 'aborted' })))
    })
    const runners = fakeRunners({ ocr: vi.fn(async () => { throw new ExtractError('failed', 'программа OCR упала') }) })
    const { extract } = await start({ runners, describe: see, config: { vision: VISION } })
    expect((await extract('x', 'shot.png')).status).toBe(422)
    expect(got.s?.aborted).toBe(true)
  })
  it('зрение не ответило (таймаут) — картинка с текстом OCR, но не в кеш: следующий запрос снова спросит зрение', async () => {
    const cache = memCache()
    const see = vi.fn(async (_b: Uint8Array, _s: AbortSignal): Promise<VisionOutcome> => ({ failure: 'timeout' }))
    const { extract } = await start({ cache, describe: see, config: { vision: VISION } })
    const first = await (await extract('same', 'scan.png')).json() as any
    expect(first).toMatchObject({ cached: false, text: 'распознанный текст скана' })
    expect(first.description).toBeUndefined()
    expect(cache.map.size).toBe(0)
    see.mockResolvedValueOnce({ description: 'Снимок.' })
    expect(await (await extract('same', 'scan.png')).json()).toMatchObject({ cached: false, description: 'Снимок.' })
    expect(await (await extract('same', 'scan.png')).json()).toMatchObject({ cached: true, description: 'Снимок.' })
    expect(see).toHaveBeenCalledTimes(2)
  })
  it('на картинке нет текста, зрение описало — 200: описание и «Текста на картинке не найдено.»', async () => {
    const runners = fakeRunners({ ocr: vi.fn(async () => ({ text: ' \n ', pages: 1 })) })
    const { extract } = await start({ runners, describe: outcome({ description: 'Фото склада.' }), config: { vision: VISION } })
    const r = await extract('x', 'photo.jpg')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ description: 'Фото склада.', text: 'Описание картинки: Фото склада.\n\nТекста на картинке не найдено.' })
  })
  it('нет текста, зрение временно не ответило — 503 busy (повторить), а не «нет текста»; пустой ответ модели — 422 unreadable', async () => {
    const runners = fakeRunners({ ocr: vi.fn(async () => ({ text: ' ', pages: 1 })) })
    const { extract } = await start({ runners, describe: outcome({ failure: 'busy' }), config: { vision: VISION } })
    const busy = await extract('x', 'photo.jpg')
    expect([busy.status, ((await busy.json()) as any).error]).toEqual([503, 'busy'])
    await new Promise(r => server!.close(r))
    server = null
    const second = await start({ runners, describe: outcome({ failure: 'empty' }), config: { vision: VISION } })
    const r = await second.extract('x', 'photo.jpg')
    expect([r.status, ((await r.json()) as any).error]).toEqual([422, 'unreadable'])
  })
  it('описатель бросил синхронно — картинка с текстом OCR, место разбора не потеряно', async () => {
    const see = vi.fn((): Promise<VisionOutcome> => { throw new Error('сбой описателя') })
    const { extract } = await start({ describe: see, config: { vision: VISION, maxConcurrency: 1, queueTimeoutMs: 300 } })
    const r = await extract('x', 'shot.png')
    expect(await r.json()).toMatchObject({ text: 'распознанный текст скана', cached: false })
    expect((await extract('y', 'a.txt')).status).toBe(200)
  })
  it('включили зрение — картинка не берётся из кеша без описания; PDF — берётся', async () => {
    const cache = memCache()
    const first = await start({ cache })
    await first.extract('same', 'scan.png')
    await first.extract('same-pdf', 'doc.pdf')
    await new Promise(r => server!.close(r))
    server = null
    const second = await start({ cache, describe: outcome({ description: 'Описание.' }), config: { vision: VISION } })
    expect(await (await second.extract('same', 'scan.png')).json()).toMatchObject({ cached: false, description: 'Описание.' })
    expect(await (await second.extract('same-pdf', 'doc.pdf')).json()).toMatchObject({ cached: true })
  })
  it('401 без ключа и с неверным ключом; разбор не запускается', async () => {
    const runners = fakeRunners()
    const { extract } = await start({ runners })
    for (const auth of [null, 'Bearer wrong', KEY]) {
      const r = await extract('x', 'a.txt', auth)
      expect(r.status).toBe(401)
      expect(((await r.json()) as any).error).toBe('unauthorized')
    }
    expect(runners.readText).not.toHaveBeenCalled()
  })
  it('400 без X-File-Name', async () => {
    const { extract } = await start()
    const r = await extract('x', null)
    expect(r.status).toBe(400)
  })
  it('415 на неподдерживаемый формат', async () => {
    const { extract } = await start()
    const r = await extract('x', 'a.zip')
    expect(r.status).toBe(415)
    expect(((await r.json()) as any).error).toBe('unsupported')
  })
  it('413 на файл больше MAX_FILE_BYTES, ровно на лимите — проходит', async () => {
    const { extract } = await start({ config: { maxFileBytes: 10 } })
    const big = await extract('x'.repeat(11), 'a.txt')
    expect(big.status).toBe(413)
    expect(((await big.json()) as any).error).toBe('too_large')
    expect((await extract('x'.repeat(10), 'a.txt')).status).toBe(200)
  })
  it('truncated: true, если текст длиннее MAX_TEXT_CHARS', async () => {
    const { extract } = await start({ config: { maxTextChars: 10 } })
    const j = await (await extract('x', 'a.txt')).json() as any
    expect(j.truncated).toBe(true)
    expect(j.text).toHaveLength(10)
  })
  it('504 по таймауту на файл, сигнал доходит до исполнителя, ошибка не кешируется', async () => {
    let aborted = false
    const cache = memCache()
    const runners = fakeRunners({
      readText: (_p, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new ExtractError('timeout', 't')) })
      })
    })
    const { extract } = await start({ runners, cache, config: { extractTimeoutMs: 50 } })
    const r = await extract('x', 'a.txt')
    expect(r.status).toBe(504)
    expect(((await r.json()) as any).error).toBe('timeout')
    expect(aborted).toBe(true)
    expect(cache.map.size).toBe(0)
  })
  it('422 на файл без читаемого текста, ошибка не кешируется', async () => {
    const cache = memCache()
    const { extract } = await start({ cache, runners: fakeRunners({ readText: async () => '\u0000' }) })
    const r = await extract('x', 'a.txt')
    expect(r.status).toBe(422)
    expect(((await r.json()) as any).error).toBe('unreadable')
    expect(cache.map.size).toBe(0)
  })
  it('500 internal на неожиданную ошибку, без её текста наружу', async () => {
    const { extract } = await start({ runners: fakeRunners({ readText: async () => { throw new Error('секрет /tmp/x') } }) })
    const r = await extract('x', 'a.txt')
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: 'internal', message: 'внутренняя ошибка' })
  })
  it('сломанный кеш не мешает разбору', async () => {
    const broken: CacheStore = { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') }, sweep: async () => 0 }
    const { extract } = await start({ cache: broken })
    expect((await extract('x', 'a.txt')).status).toBe(200)
  })
  it('испорченная запись кеша — промах и новый разбор, а не 500', async () => {
    const cache = memCache()
    const { extract } = await start({ cache })
    expect((await extract('abc', 'a.txt')).status).toBe(200)
    for (const bad of ['{"text":', '{"other":1}', '{"text":"x"}', 'null']) {
      for (const k of cache.map.keys()) cache.map.set(k, bad)
      const r = await extract('abc', 'a.txt')
      expect(r.status).toBe(200)
      expect(((await r.json()) as any).cached).toBe(false)
    }
  })
  it('не создался временный каталог — место в очереди освобождается', async () => {
    const { extract } = await start({ config: { maxConcurrency: 1, queueTimeoutMs: 200 } })
    const old = process.env.TMPDIR
    process.env.TMPDIR = '/nonexistent-file-extract-tmp'
    try {
      expect((await extract('один', 'a.txt')).status).toBe(500)
      expect((await extract('два', 'a.txt')).status).toBe(500) // не 503 busy: слот не утёк
    } finally {
      if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old
    }
    expect((await extract('три', 'a.txt')).status).toBe(200)
  })
  it('в журнал не попадают ни имя файла, ни текст', async () => {
    const logs: LogEntry[] = []
    const { extract } = await start({ logs })
    await extract('x', 'Иванов_паспорт.txt')
    await extract('x', 'Иванов_паспорт.zip')
    const dump = JSON.stringify(logs)
    expect(logs).toHaveLength(2)
    expect(dump).not.toContain('Иванов')
    expect(dump).not.toContain('Ромашка')
    expect(logs[0]).toMatchObject({ evt: 'extract', kind: 'text', cached: false, sha: expect.stringMatching(/^[0-9a-f]{12}$/) })
    expect(logs[1]).toMatchObject({ error: 'unsupported' })
  })
  it('не больше MAX_CONCURRENCY разборов одновременно', async () => {
    let active = 0
    let peak = 0
    const runners = fakeRunners({
      readText: async () => {
        active++; peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 30))
        active--
        return 'достаточно длинный текст'
      }
    })
    const { extract } = await start({ runners, config: { maxConcurrency: 2 } })
    const rs = await Promise.all([1, 2, 3, 4, 5].map(i => extract(`файл ${i}`, 'a.txt')))
    expect(rs.every(r => r.status === 200)).toBe(true)
    expect(peak).toBe(2)
  })
})

/** Сырой запрос: свой Content-Length/chunked и тело частями. Ответ и признак закрытия сокета. */
function raw(port: number, opts: { headers: Record<string, string | number>, chunks: Buffer[], endBody?: boolean }) {
  return new Promise<{ status: number, body: string, closed: boolean }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/extract', method: 'POST', headers: opts.headers, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d: string) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, closed: res.headers.connection === 'close' }))
    })
    req.on('error', reject)
    for (const c of opts.chunks) req.write(c)
    if (opts.endBody !== false) req.end()
  })
}

describe('HTTP: адреса и версия', () => {
  it('старый /extract — 404, /health не-GET — 405, ответ несёт extractorVersion', async () => {
    const { base, extract } = await start()
    expect((await fetch(`${base}/extract`, { method: 'POST', body: 'x' })).status).toBe(404)
    expect((await fetch(`${base}/health`, { method: 'POST', body: 'x' })).status).toBe(405)
    expect((await fetch(`${base}/v1/extract`)).status).toBe(405)
    const j = await (await extract('x', 'a.txt')).json() as any
    expect(j.extractorVersion).toBe(EXTRACTOR_VERSION)
  })
})

describe('HTTP: журнал', () => {
  const ALLOWED = new Set(['evt', 'kind', 'consumer', 'bytes', 'ms', 'queueMs', 'sha', 'cached', 'error', 'errorClass'])
  it('в записи разбора — ровно разрешённые ключи, имени файла нет', async () => {
    const logs: LogEntry[] = []
    const { extract } = await start({ logs })
    await extract('x', 'Иванов.txt')
    expect(new Set(Object.keys(logs[0]!))).toEqual(new Set(['evt', 'kind', 'consumer', 'bytes', 'ms', 'queueMs', 'sha', 'cached']))
    expect(logs[0]!.bytes).toBe(1)
    for (const l of logs) for (const k of Object.keys(l)) expect(ALLOWED.has(k)).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('Иванов')
  })
  it('500 internal — класс системной ошибки без текста', async () => {
    const logs: LogEntry[] = []
    const { extract } = await start({ logs, runners: fakeRunners({ readText: async () => { throw Object.assign(new Error('/tmp/Иванов: нет места'), { code: 'ENOSPC' }) } }) })
    expect((await extract('x', 'a.txt')).status).toBe(500)
    expect(logs[0]).toMatchObject({ error: 'internal', errorClass: 'ENOSPC' })
    expect(JSON.stringify(logs)).not.toContain('Иванов')
  })
})

describe('HTTP: 413 и закрытие соединения', () => {
  it('413 по Content-Length при маленьком теле, соединение закрывается', async () => {
    const { port } = await start({ config: { maxFileBytes: 10 } })
    const r = await raw(port, { headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}`, 'content-length': 1000 }, chunks: [Buffer.from('abc')], endBody: false })
    expect(r.status).toBe(413)
    expect(r.closed).toBe(true)
  })
  it('413 по телу без Content-Length (chunked)', async () => {
    const { port } = await start({ config: { maxFileBytes: 10 } })
    const r = await raw(port, { headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}`, 'transfer-encoding': 'chunked' }, chunks: [Buffer.alloc(8, 1), Buffer.alloc(8, 1)] })
    expect(r.status).toBe(413)
    expect(r.closed).toBe(true)
  })
  for (const variant of ['content-length', 'chunked'] as const) {
    it(`после 413 (${variant}) сокет закрывается сразу, недочитанное тело не дочитывается`, async () => {
      const { port } = await start({ config: { maxFileBytes: 10 } })
      const headers: Record<string, string | number> = { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}` }
      if (variant === 'content-length') headers['content-length'] = 100_000
      else headers['transfer-encoding'] = 'chunked'
      const closed = await new Promise<boolean>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/v1/extract', method: 'POST', agent: false, headers })
        req.on('error', () => {})
        req.on('response', (res) => {
          expect(res.statusCode).toBe(413)
          res.resume()
          res.socket.on('close', () => resolve(true))
          setTimeout(() => resolve(false), 500)
        })
        req.write(Buffer.alloc(20, 1)) // больше потолка, но тело не закончено
      })
      expect(closed).toBe(true)
    })
  }
  it('401 закрывает соединение', async () => {
    const { port } = await start()
    const r = await raw(port, { headers: { 'x-file-name': 'a.txt', 'content-length': 3 }, chunks: [Buffer.from('abc')] })
    expect(r.status).toBe(401)
    expect(r.closed).toBe(true)
  })
})

describe('HTTP: кеш и временные файлы', () => {
  it('сервер передаёт кешу срок ровно 86400', async () => {
    const cache = memCache()
    const { extract } = await start({ cache })
    await extract('x', 'a.txt')
    expect(cache.ttls).toEqual([86_400])
  })
  it('ключ кеша зависит от расширения и потолка текста', async () => {
    const cache = memCache()
    const runners = fakeRunners()
    const { extract } = await start({ cache, runners })
    await extract('одно', 'a.xls')
    await extract('одно', 'a.doc')
    expect(runners.officeToText).toHaveBeenCalledTimes(2)
  })
  it('после ответа (успех и ошибка) во временном каталоге нет file-extract-in-*', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fe-srv-'))
    const old = process.env.TMPDIR
    process.env.TMPDIR = tmp
    try {
      let n = 0
      const runners = fakeRunners({ readText: async () => { if (n++ % 2) throw new ExtractError('failed', 'x'); return 'достаточно длинный текст' } })
      const { extract } = await start({ runners })
      expect((await extract('1', 'a.txt')).status).toBe(200)
      expect((await extract('2', 'a.txt')).status).toBe(422)
      expect((await readdir(tmp)).filter(f => f.startsWith('file-extract-in-'))).toEqual([])
    } finally {
      if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('HTTP: занятость и уход клиента', () => {
  const slow = (ms: number, hits?: { n: number }) => fakeRunners({
    readText: (_p, signal) => new Promise((resolve, reject) => {
      if (hits) hits.n++
      const t = setTimeout(() => resolve('достаточно длинный текст'), ms)
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new ExtractError('timeout', 't')) })
    })
  })
  it('503 busy, когда тела читают уже столько запросов, сколько разборов + очередь', async () => {
    const { port, extract } = await start({ config: { maxConcurrency: 1, maxQueue: 0 } })
    const slowUpload = request({ host: '127.0.0.1', port, path: '/v1/extract', method: 'POST', agent: false, headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}`, 'content-length': 10 } })
    slowUpload.on('error', () => {})
    slowUpload.write('abc') // тело не дописано: запрос держит место чтения
    await new Promise(r => setTimeout(r, 30))
    const r = await extract('x', 'a.txt')
    expect(r.status).toBe(503)
    slowUpload.destroy()
  })
  it('503 busy по таймауту ожидания места', async () => {
    const { extract } = await start({ runners: slow(200), config: { maxConcurrency: 1, queueTimeoutMs: 20 } })
    const [a, b] = await Promise.all([extract('1', 'a.txt'), new Promise(r => setTimeout(r, 10)).then(() => extract('2', 'a.txt'))])
    expect(a.status).toBe(200)
    expect(b.status).toBe(503)
    expect(((await b.json()) as any).error).toBe('busy')
  })
  it('503 busy сразу при полной очереди (MAX_QUEUE)', async () => {
    const { extract } = await start({ runners: slow(150), config: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 5000 } })
    const started = Date.now()
    const rs = await Promise.all([1, 2, 3].map((i) => new Promise(r => setTimeout(r, i * 10)).then(() => extract(String(i), 'a.txt'))))
    expect(rs.map(r => r.status).sort()).toEqual([200, 200, 503])
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('клиент ушёл во время разбора — разбор прерывается, в журнале client_aborted, не 500', async () => {
    const logs: LogEntry[] = []
    let aborted = false
    const runners = fakeRunners({
      readText: (_p, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new ExtractError('timeout', 't')) })
      })
    })
    const { port } = await start({ runners, logs, config: { extractTimeoutMs: 10_000 } })
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/extract', method: 'POST', agent: false, headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}`, 'content-length': 1 } })
      req.on('error', () => {})
      req.end('x')
      setTimeout(() => { req.destroy(); resolve() }, 50)
    })
    await vi.waitFor(() => expect(logs).toHaveLength(1), { timeout: 1000 })
    expect(aborted).toBe(true)
    expect(logs[0]).toMatchObject({ error: 'client_aborted' })
  })
  it('клиент оборвал тело — client_aborted, не 500', async () => {
    const logs: LogEntry[] = []
    const { port } = await start({ logs })
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/extract', method: 'POST', agent: false, headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}`, 'content-length': 100 } })
      req.on('error', () => {})
      req.write('abc')
      setTimeout(() => { req.destroy(); resolve() }, 50)
    })
    await vi.waitFor(() => expect(logs).toHaveLength(1), { timeout: 1000 })
    expect(logs[0]).toMatchObject({ error: 'client_aborted' })
  })
  it('клиент ушёл, пока ждал места, — ожидающий снимается с очереди', async () => {
    const logs: LogEntry[] = []
    const hits = { n: 0 }
    const { port, extract } = await start({ logs, runners: slow(150, hits), config: { maxConcurrency: 1, queueTimeoutMs: 5000 } })
    const first = extract('1', 'a.txt')
    await new Promise(r => setTimeout(r, 20))
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/extract', method: 'POST', agent: false, headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}`, 'content-length': 1 } })
      req.on('error', () => {})
      req.end('2')
      setTimeout(() => { req.destroy(); resolve() }, 30)
    })
    expect((await first).status).toBe(200)
    await vi.waitFor(() => expect(logs.some(l => l.error === 'client_aborted')).toBe(true), { timeout: 1000 })
    expect(hits.n).toBe(1) // второй до разбора не дошёл
  })
})

describe('HTTP: POST /v1/convert', () => {
  const conv = (base: string, to: string, body: string, auth: string | null = `Bearer ${KEY}`) =>
    fetch(`${base}/v1/convert?to=${to}`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body })

  it('PDF: байты файла и тип application/pdf, HTML доходит до исполнителя', async () => {
    const runners = fakeRunners()
    const { base, logs } = await start({ runners })
    const r = await conv(base, 'pdf', '<p>КП</p>')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await r.arrayBuffer()).toString('latin1').startsWith('%PDF-')).toBe(true)
    expect(runners.htmlConvert).toHaveBeenCalledWith(expect.stringMatching(/document\.html$/), 'pdf', expect.anything())
    expect(logs.find(l => l.evt === 'convert')).toMatchObject({ kind: 'pdf', bytes: Buffer.byteLength('<p>КП</p>') })
  })

  it('DOCX: тип Word', async () => {
    const { base } = await start()
    const r = await conv(base, 'docx', '<p>КП</p>')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('wordprocessingml')
  })

  it('без ключа — 401, исполнитель не зовётся', async () => {
    const runners = fakeRunners()
    const { base } = await start({ runners })
    expect((await conv(base, 'pdf', '<p>x</p>', null)).status).toBe(401)
    expect(runners.htmlConvert).not.toHaveBeenCalled()
  })

  it('неизвестный формат и пустое тело — 400', async () => {
    const { base } = await start()
    expect((await conv(base, 'exe', '<p>x</p>')).status).toBe(400)
    expect((await conv(base, 'pdf', '')).status).toBe(400)
  })

  it('HTML больше 5 МБ — 413', async () => {
    const { base } = await start()
    const r = await conv(base, 'pdf', 'a'.repeat(5 * 1024 * 1024 + 1))
    expect(r.status).toBe(413)
  })

  it('сбой LibreOffice — 422 без подробностей пути', async () => {
    const { base } = await start({ runners: fakeRunners({ htmlConvert: async () => { throw new ExtractError('failed', 'libreoffice: документ не получен') } }) })
    const r = await conv(base, 'pdf', '<p>x</p>')
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ error: 'extract_failed' })
  })

  it('HTML с file: — 400 unsafe_html, LibreOffice не зовётся', async () => {
    const runners = fakeRunners()
    const { base } = await start({ runners })
    const r = await conv(base, 'pdf', '<img src="file:///etc/passwd">')
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'unsafe_html' })
    expect(runners.htmlConvert).not.toHaveBeenCalled()
  })

  it('не UTF-8 и UTF-16 с BOM — 400 unsafe_html', async () => {
    const runners = fakeRunners()
    const { base } = await start({ runners })
    for (const body of [Buffer.from([0x3c, 0x70, 0x3e, 0xc0, 0xaf]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>КП</p>')])]) {
      const r = await fetch(`${base}/v1/convert?to=pdf`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body })
      expect(r.status).toBe(400)
    }
    expect(runners.htmlConvert).not.toHaveBeenCalled()
  })

  it('ранний отказ (нет to) закрывает соединение — недочитанное тело не станет следующим запросом', async () => {
    const { base } = await start()
    const r = await fetch(`${base}/v1/convert?to=xls`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: '<p>x</p>'.repeat(20000) })
    expect(r.status).toBe(400)
    expect(r.headers.get('connection')).toBe('close')
  })

  it('GET — 405', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/v1/convert?to=pdf`)).status).toBe(405)
  })

  it('сборка не подключена — 501 not_implemented, LibreOffice не зовётся', async () => {
    const { base } = await start({ runners: fakeRunners({ htmlConvert: undefined }) })
    const r = await conv(base, 'pdf', '<p>x</p>')
    expect(r.status).toBe(501)
    expect(await r.json()).toMatchObject({ error: 'not_implemented' })
  })

  it('обходы проверки из ревью — 400 unsafe_html с причиной, LibreOffice не зовётся', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'
    const runners = fakeRunners()
    const { base } = await start({ runners })
    for (const bad of [
      '<img alt=">" src="file:///etc/passwd">',
      '<td title=">" background="file:///etc/passwd">',
      `<img src="${dataUrl('image/png', svg)}">`,
      `<img src="${dataUrl('image/png', pngHeader(100_000, 100_000))}">`,
      '<p style="background:url(file:///etc/passwd)">x</p>'
    ]) {
      const r = await conv(base, 'pdf', bad)
      expect(r.status, bad.slice(0, 60)).toBe(400)
      const j = (await r.json()) as any
      expect(j.error).toBe('unsafe_html')
      expect(j.message).toMatch(/^HTML не собирается: .{10,}/)
    }
    expect(runners.htmlConvert).not.toHaveBeenCalled()
  })

  it('200 000 знаков «<» — отвечает быстро, главный поток не замирает (/health жив)', async () => {
    const { base } = await start()
    const started = Date.now()
    const r = await conv(base, 'pdf', '<'.repeat(200_000))
    expect(r.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })

  it('в LibreOffice уходит пересобранный HTML: без комментариев, в канонической записи', async () => {
    let seen = ''
    const runners = fakeRunners({ htmlConvert: async (p) => { seen = await readFile(p, 'utf8'); return Buffer.from('%PDF-1.7 x') } })
    const { base } = await start({ runners })
    const r = await conv(base, 'pdf', "<!-- c --><P Class=a title='x\">y'>КП<br/></P>")
    expect(r.status).toBe(200)
    expect(seen).toBe('<p class="a" title="x&quot;&gt;y">КП<br></p>')
  })

  it('ссылки — текстом: в HTML для LibreOffice нет <a> и href, текст остаётся', async () => {
    let seen = ''
    const runners = fakeRunners({ htmlConvert: async (p) => { seen = await readFile(p, 'utf8'); return Buffer.from('%PDF-1.7 x') } })
    const { base } = await start({ runners })
    const r = await conv(base, 'pdf', '<p>Счёт: <a href="https://evil.example/">оплатить</a></p>')
    expect(r.status).toBe(200)
    expect(seen).toBe('<p>Счёт: оплатить</p>')
    expect(seen).not.toContain('href')
    expect(seen).not.toContain('<a')
  })

  it('временный каталог file-extract-html-* убран после успеха, сбоя LibreOffice и отказа проверки', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fe-conv-'))
    const old = process.env.TMPDIR
    process.env.TMPDIR = tmp
    try {
      let n = 0
      const runners = fakeRunners({ htmlConvert: async () => { if (n++) throw new ExtractError('failed', 'x'); return Buffer.from('%PDF-1.7 x') } })
      const { base } = await start({ runners })
      expect((await conv(base, 'pdf', '<p>1</p>')).status).toBe(200)
      expect((await conv(base, 'pdf', '<p>2</p>')).status).toBe(422)
      expect((await conv(base, 'pdf', '<img src="file:///etc/passwd">')).status).toBe(400)
      expect((await readdir(tmp)).filter(f => f.startsWith('file-extract-html-'))).toEqual([])
    } finally {
      if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old
      await rm(tmp, { recursive: true, force: true })
    }
  })

  describe('занятость, очередь и таймаут', () => {
    /** Сборка, которая занимает место на `ms` и слушает сигнал (как LibreOffice под run()). */
    const slow = (ms: number, hits?: { n: number }) => fakeRunners({
      htmlConvert: (_p, _to, signal) => new Promise((resolve, reject) => {
        if (hits) hits.n++
        const t = setTimeout(() => resolve(Buffer.from('%PDF-1.7 x')), ms)
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new ExtractError('timeout', 't')) })
      })
    })

    it('503 busy, когда тела читают уже столько запросов, сколько сборок + очередь; соединение закрывается', async () => {
      const { port, base } = await start({ config: { maxConcurrency: 1, maxQueue: 0 } })
      const hold = request({ host: '127.0.0.1', port, path: '/v1/convert?to=pdf', method: 'POST', agent: false, headers: { authorization: `Bearer ${KEY}`, 'content-length': 10 } })
      hold.on('error', () => {})
      hold.write('<p>') // тело не дописано: запрос держит место чтения
      await new Promise(r => setTimeout(r, 30))
      const r = await conv(base, 'pdf', '<p>x</p>')
      expect(r.status).toBe(503)
      expect(await r.json()).toMatchObject({ error: 'busy' })
      expect(r.headers.get('connection')).toBe('close')
      hold.destroy()
    })

    it('503 busy по таймауту ожидания места в очереди', async () => {
      const { base } = await start({ runners: slow(200), config: { maxConcurrency: 1, queueTimeoutMs: 20 } })
      const [a, b] = await Promise.all([conv(base, 'pdf', '<p>1</p>'), new Promise(r => setTimeout(r, 10)).then(() => conv(base, 'pdf', '<p>2</p>'))])
      expect(a.status).toBe(200)
      expect(b.status).toBe(503)
      expect(((await b.json()) as any).error).toBe('busy')
    })

    it('очередь: сверх MAX_QUEUE — 503 сразу, остальные дожидаются и получают файл', async () => {
      const { base } = await start({ runners: slow(150), config: { maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 5000 } })
      const started = Date.now()
      const rs = await Promise.all([1, 2, 3].map((i) => new Promise(r => setTimeout(r, i * 10)).then(() => conv(base, 'pdf', `<p>${i}</p>`))))
      expect(rs.map(r => r.status).sort()).toEqual([200, 200, 503])
      expect(Date.now() - started).toBeLessThan(1000)
    })

    it('не больше MAX_CONCURRENCY сборок одновременно', async () => {
      let active = 0
      let peak = 0
      const runners = fakeRunners({
        htmlConvert: async () => {
          active++; peak = Math.max(peak, active)
          await new Promise(r => setTimeout(r, 30))
          active--
          return Buffer.from('%PDF-1.7 x')
        }
      })
      const { base } = await start({ runners, config: { maxConcurrency: 2 } })
      const rs = await Promise.all([1, 2, 3, 4, 5].map(i => conv(base, 'pdf', `<p>${i}</p>`)))
      expect(rs.every(r => r.status === 200)).toBe(true)
      expect(peak).toBe(2)
    })

    it('клиент ушёл, пока ждал места, — ожидающий снимается с очереди, в журнале client_aborted', async () => {
      const logs: LogEntry[] = []
      const hits = { n: 0 }
      const { port, base } = await start({ logs, runners: slow(150, hits), config: { maxConcurrency: 1, queueTimeoutMs: 5000 } })
      const first = conv(base, 'pdf', '<p>1</p>')
      await new Promise(r => setTimeout(r, 20))
      await new Promise<void>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/v1/convert?to=pdf', method: 'POST', agent: false, headers: { authorization: `Bearer ${KEY}`, 'content-length': 8 } })
        req.on('error', () => {})
        req.end('<p>2</p>')
        setTimeout(() => { req.destroy(); resolve() }, 30)
      })
      expect((await first).status).toBe(200)
      await vi.waitFor(() => expect(logs.some(l => l.evt === 'convert' && l.error === 'client_aborted')).toBe(true), { timeout: 1000 })
      expect(hits.n).toBe(1) // вторая до LibreOffice не дошла
    })

    it('клиент ушёл во время сборки — LibreOffice прерывается, в журнале client_aborted, не 500', async () => {
      const logs: LogEntry[] = []
      let aborted = false
      // как настоящая сборка: после сигнала сначала прибирает за собой (rm каталога), потом отказывает
      const runners = fakeRunners({
        htmlConvert: async (_p, _to, signal) => {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          aborted = true
          await new Promise(r => setTimeout(r, 5))
          throw new ExtractError('timeout', 't')
        }
      })
      const { port } = await start({ runners, logs, config: { extractTimeoutMs: 10_000 } })
      await new Promise<void>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/v1/convert?to=pdf', method: 'POST', agent: false, headers: { authorization: `Bearer ${KEY}`, 'content-length': 8 } })
        req.on('error', () => {})
        req.end('<p>1</p>')
        setTimeout(() => { req.destroy(); resolve() }, 50)
      })
      await vi.waitFor(() => expect(logs.some(l => l.evt === 'convert' && l.error === 'client_aborted')).toBe(true), { timeout: 1000 })
      expect(aborted).toBe(true)
    })

    it('504 по таймауту, сигнал доходит до LibreOffice, временный каталог убран', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'fe-conv-'))
      const old = process.env.TMPDIR
      process.env.TMPDIR = tmp
      try {
        let aborted = false
        const runners = fakeRunners({
          htmlConvert: (_p, _to, signal) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => { aborted = true; reject(new ExtractError('timeout', 't')) })
          })
        })
        const { base } = await start({ runners, config: { extractTimeoutMs: 50 } })
        const r = await conv(base, 'pdf', '<p>x</p>')
        expect(r.status).toBe(504)
        expect(((await r.json()) as any).error).toBe('timeout')
        expect(aborted).toBe(true)
        expect((await readdir(tmp)).filter(f => f.startsWith('file-extract-html-'))).toEqual([])
      } finally {
        if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old
        await rm(tmp, { recursive: true, force: true })
      }
    })

    it('504 вовремя, даже если сборка сигнал не слушает', async () => {
      const runners = fakeRunners({ htmlConvert: () => new Promise(resolve => setTimeout(() => resolve(Buffer.from('%PDF-1.7 x')), 400)) })
      const { base } = await start({ runners, config: { extractTimeoutMs: 50 } })
      const started = Date.now()
      const r = await conv(base, 'pdf', '<p>x</p>')
      expect(r.status).toBe(504)
      expect(Date.now() - started).toBeLessThan(300)
    })

    it('после таймаута место возвращается: следующая сборка проходит', async () => {
      let n = 0
      const runners = fakeRunners({
        htmlConvert: (_p, _to, signal) => new Promise((resolve, reject) => {
          if (n++ === 0) signal.addEventListener('abort', () => reject(new ExtractError('timeout', 't')))
          else resolve(Buffer.from('%PDF-1.7 x'))
        })
      })
      const { base } = await start({ runners, config: { maxConcurrency: 1, maxQueue: 0, extractTimeoutMs: 50 } })
      expect((await conv(base, 'pdf', '<p>1</p>')).status).toBe(504)
      expect((await conv(base, 'pdf', '<p>2</p>')).status).toBe(200)
    })
  })
})

describe('HTTP: одинаковые одновременные запросы (single-flight, #35)', () => {
  /** Разбор, который держится, пока не позовут open(): так видно, что второй запрос не запустил свой. */
  function gated() {
    const opens: Array<(v: string) => void> = []
    const fails: Array<(e: Error) => void> = []
    let aborted = 0
    const readText = vi.fn((_p: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      opens.push(resolve)
      fails.push(reject)
      signal.addEventListener('abort', () => { aborted++; reject(new ExtractError('timeout', 't')) })
    }))
    return { readText, open: (v: string) => opens.forEach(o => o(v)), fail: (e: Error) => fails.forEach(f => f(e)), aborted: () => aborted }
  }
  const start2 = (g: ReturnType<typeof gated>, config: Partial<Config> = {}, logs: LogEntry[] = []) =>
    start({ runners: fakeRunners({ readText: g.readText as any }), config, logs })

  it('второй запрос с тем же файлом ждёт первого: разбор один, оба получают текст', async () => {
    const g = gated()
    const logs: LogEntry[] = []
    const { extract } = await start2(g, {}, logs)
    const a = extract('тот же файл', 'a.txt')
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(1))
    const b = extract('тот же файл', 'другое.txt')
    await new Promise(r => setTimeout(r, 50))
    expect(g.readText).toHaveBeenCalledTimes(1)
    g.open('результат')
    const [ja, jb] = await Promise.all([a.then(r => r.json()), b.then(r => r.json())]) as any[]
    expect(ja.text).toBe('результат')
    expect(jb).toMatchObject({ text: 'результат', cached: false, sha256: ja.sha256 })
    expect(g.readText).toHaveBeenCalledTimes(1)
    expect(logs.filter(l => l.evt === 'extract' && l.shared)).toHaveLength(1)
  })

  it('разные файлы не склеиваются: у каждого свой разбор', async () => {
    const g = gated()
    const { extract } = await start2(g)
    const a = extract('один', 'a.txt')
    const b = extract('два', 'b.txt')
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(2))
    g.open('достаточно длинный читаемый текст')
    await Promise.all([a, b])
  })

  it('отказ первого — тот же отказ ждущему (не повторный OCR), следующий запрос начинает заново', async () => {
    const g = gated()
    const { extract } = await start2(g)
    const a = extract('f', 'a.txt')
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(1))
    const b = extract('f', 'a.txt')
    await new Promise(r => setTimeout(r, 50))
    g.fail(new ExtractError('unreadable', 'нет текста'))
    expect((await a).status).toBe(422)
    expect((await b).status).toBe(422)
    expect(g.readText).toHaveBeenCalledTimes(1)
    const c = extract('f', 'a.txt') // неудача не кешируется и не залипает в таблице
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(2))
    g.open('достаточно длинный читаемый текст')
    expect((await c).status).toBe(200)
  })

  it('первый клиент ушёл, а ждущий остался — разбор не прерывается, ждущий получает ответ', async () => {
    const g = gated()
    const { extract, base } = await start2(g)
    const ac = new AbortController()
    const a = fetch(`${base}/v1/extract`, { method: 'POST', headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}` }, body: 'f', signal: ac.signal }).catch(() => null)
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(1))
    const b = extract('f', 'a.txt')
    await new Promise(r => setTimeout(r, 50))
    ac.abort()
    await a
    await new Promise(r => setTimeout(r, 50))
    expect(g.aborted()).toBe(0)
    g.open('для второго')
    expect(await (await b).json()).toMatchObject({ text: 'для второго' })
  })

  it('ушёл ждущий, а начавший остался — разбор идёт, начавший получает ответ', async () => {
    const g = gated()
    const { extract, base } = await start2(g)
    const a = extract('f', 'a.txt')
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(1))
    const ac = new AbortController()
    const b = fetch(`${base}/v1/extract`, { method: 'POST', headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}` }, body: 'f', signal: ac.signal }).catch(() => null)
    await new Promise(r => setTimeout(r, 50))
    ac.abort()
    await b
    await new Promise(r => setTimeout(r, 50))
    expect(g.aborted()).toBe(0)
    g.open('достаточно длинный читаемый текст')
    expect((await a).status).toBe(200)
  })

  it('ушли все — разбор прерывается, и новый запрос начинает свежий', async () => {
    const g = gated()
    const { base, extract } = await start2(g)
    const ac = new AbortController()
    const a = fetch(`${base}/v1/extract`, { method: 'POST', headers: { 'x-file-name': 'a.txt', authorization: `Bearer ${KEY}` }, body: 'f', signal: ac.signal }).catch(() => null)
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(1))
    ac.abort()
    await a
    await vi.waitFor(() => expect(g.aborted()).toBe(1))
    const c = extract('f', 'a.txt')
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(2))
    g.open('свежий')
    expect(await (await c).json()).toMatchObject({ text: 'свежий' })
  })

  it('ждущие не обходят потолок тел в памяти: сверх maxConcurrency+MAX_QUEUE — 503', async () => {
    const g = gated()
    const { extract } = await start2(g, { maxConcurrency: 1, maxQueue: 1 })
    const a = extract('f', 'a.txt')
    await vi.waitFor(() => expect(g.readText).toHaveBeenCalledTimes(1))
    const b = extract('f', 'a.txt')
    await new Promise(r => setTimeout(r, 50))
    expect((await extract('f', 'a.txt')).status).toBe(503)
    g.open('достаточно длинный читаемый текст')
    expect((await a).status).toBe(200)
    expect((await b).status).toBe(200)
  })
})


describe('HTTP: готовность и метрики (#38)', () => {
  it('/health: 200, version как прежде, плюс ready и checks; без ключа', async () => {
    const { base } = await start()
    const j = await (await fetch(`${base}/health`)).json() as any
    expect(j).toEqual({ ok: true, version: EXTRACTOR_VERSION, ready: true, checks: { programs: true, cache: true } })
  })
  it('нет программ: /health всё равно 200 (живость), ready=false; ?ready=1 — 503', async () => {
    const { base } = await start({ runners: fakeRunners({ programs: async () => false }) })
    const r = await fetch(`${base}/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ready: false, checks: { programs: false, cache: true } })
    expect((await fetch(`${base}/health?ready=1`)).status).toBe(503)
  })
  it('кеш недоступен — ready=false, но разбор работает (без кеша)', async () => {
    const cache = { ...memCache(), ping: async () => false }
    const { base, extract } = await start({ cache })
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ready: false, checks: { cache: false } })
    expect((await extract('x', 'a.txt')).status).toBe(200)
  })
  it('зависшая проверка не вешает /health: через потолок — false', async () => {
    const cache = { ...memCache(), ping: () => new Promise<boolean>(() => {}) }
    const { base } = await start({ cache })
    const started = Date.now()
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ checks: { cache: false } })
    expect(Date.now() - started).toBeLessThan(4000)
  }, 8000)
  it('/health делит проверку между запросами: поток запросов — одна проверка', async () => {
    const ping = vi.fn(async () => true)
    const { base } = await start({ cache: { ...memCache(), ping } })
    await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/health`).then(r => r.json())))
    expect(ping).toHaveBeenCalledTimes(1)
  })
  it('/metrics: одинаковые одновременные запросы — shared_total и flights', async () => {
    const { base, extract } = await start({ runners: fakeRunners({ readText: () => new Promise(r => setTimeout(() => r('достаточно длинный читаемый текст'), 150)) }) })
    const a = extract('один и тот же', 'a.txt')
    await new Promise(r => setTimeout(r, 40))
    const t1 = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${KEY}` } })).text()
    expect(t1).toContain('file_extract_flights 1')
    const b = extract('один и тот же', 'a.txt')
    await Promise.all([a, b])
    const t2 = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${KEY}` } })).text()
    expect(t2).toContain('file_extract_shared_total 1')
    expect(t2).toContain('file_extract_flights 0')
  })
  it('/metrics без ключа — 401, с неверным — 401; только GET', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/metrics`)).status).toBe(401)
    expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong-wrong-wrong-1' } })).status).toBe(401)
    expect((await fetch(`${base}/metrics`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` } })).status).toBe(405)
  })
  it('/metrics: статусы, попадания и промахи кеша, 503; имён файлов и ключей в тексте нет', async () => {
    const { base, extract } = await start({ config: { maxConcurrency: 1, maxQueue: 0 }, runners: fakeRunners({ readText: () => new Promise(r => setTimeout(() => r('достаточно длинный читаемый текст'), 150)) }) })
    await extract('секрет', 'Паспорт Иванова.txt') // промах
    await extract('секрет', 'Паспорт Иванова.txt') // попадание
    await extract('x', 'a.exe') // 415
    const slow = extract('другое', 'b.txt')
    await new Promise(r => setTimeout(r, 40))
    expect((await extract('третье', 'c.txt')).status).toBe(503)
    await slow
    const t = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${KEY}` } })).text()
    expect(t).toContain('file_extract_requests_total{route="extract",status="200"} 3')
    expect(t).toContain('file_extract_requests_total{route="extract",status="415"} 1')
    expect(t).toContain('file_extract_requests_total{route="extract",status="503"} 1')
    expect(t).toContain('file_extract_cache_hits_total 1')
    expect(t).toMatch(/file_extract_cache_misses_total [2-9]/)
    expect(t).not.toContain('Иванов')
    expect(t).not.toContain(KEY)
  })
})

describe('HTTP: ключи потребителей (#36)', () => {
  const KA = 'mcp-key-0123456789abcdef'
  const KB = 'bank-key-0123456789abcdef'
  const consumers = [{ label: 'mcp', key: KA }, { label: 'bank', key: KB }]
  const post = (base: string, key: string, body: string, name = 'a.txt') =>
    fetch(`${base}/v1/extract`, { method: 'POST', headers: { 'x-file-name': name, authorization: `Bearer ${key}` }, body })

  it('любой ключ из списка пускает, чужой — 401; метка — в журнале, ключа в журнале нет', async () => {
    const logs: LogEntry[] = []
    const { base } = await start({ config: { consumers }, logs })
    expect((await post(base, KA, 'x')).status).toBe(200)
    expect((await post(base, KB, 'y')).status).toBe(200)
    expect((await post(base, 'wrong-key-0123456789abcdef', 'z')).status).toBe(401)
    expect(logs.filter(l => l.evt === 'extract' && !l.error).map(l => l.consumer)).toEqual(['mcp', 'bank'])
    expect(logs.find(l => l.error === 'unauthorized')!.consumer).toBeUndefined()
    expect(JSON.stringify(logs)).not.toContain(KA)
    expect(JSON.stringify(logs)).not.toContain(KB)
  })
  it('старый EXTRACT_API_KEY работает: метка default', async () => {
    const logs: LogEntry[] = []
    const { extract } = await start({ logs })
    expect((await extract('x', 'a.txt')).status).toBe(200)
    expect(logs[0]).toMatchObject({ consumer: 'default' })
  })
  it('кеш по потребителю: тот же файл у другого потребителя — не из кеша (нет оракула наличия)', async () => {
    const runners = fakeRunners()
    const { base } = await start({ config: { consumers }, runners })
    const first = await (await post(base, KA, 'тот же файл')).json() as any
    const again = await (await post(base, KA, 'тот же файл')).json() as any
    const other = await (await post(base, KB, 'тот же файл')).json() as any
    expect([first.cached, again.cached, other.cached]).toEqual([false, true, false])
    expect(runners.readText).toHaveBeenCalledTimes(2)
  })
  it('/metrics: ключ любого потребителя пускает, чужой — 401', async () => {
    const { base } = await start({ config: { consumers } })
    expect((await fetch(base + '/metrics', { headers: { authorization: 'Bearer ' + KB } })).status).toBe(200)
    expect((await fetch(base + '/metrics', { headers: { authorization: 'Bearer nope-nope-nope-nope-1' } })).status).toBe(401)
  })
  it('сборка документа: метка потребителя в журнале, чужой ключ — 401', async () => {
    const logs: LogEntry[] = []
    const { base } = await start({ config: { consumers }, logs })
    const conv = (key: string) => fetch(`${base}/v1/convert?to=pdf`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '<p>x</p>' })
    expect((await conv(KB)).status).toBe(200)
    expect((await conv('nope-nope-nope-nope-1')).status).toBe(401)
    expect(logs.find(l => l.evt === 'convert' && !l.error)).toMatchObject({ consumer: 'bank' })
  })
})
