import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheStore } from '../src/cache.ts'
import { EXTRACTOR_VERSION, loadConfig, type Config } from '../src/config.ts'
import { ExtractError } from '../src/errors.ts'
import type { LogEntry } from '../src/log.ts'
import { createApp } from '../src/server.ts'
import type { ExtractRunners } from '../src/textExtract.ts'

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
    ...over
  }
}

let server: Server | null = null
afterEach(async () => {
  if (server) await new Promise(r => server!.close(r))
  server = null
})

async function start(opts: { runners?: ExtractRunners, cache?: CacheStore, config?: Partial<Config>, logs?: LogEntry[] } = {}) {
  const config = { ...loadConfig({ NODE_ENV: 'test', EXTRACT_API_KEY: KEY }), ...opts.config }
  const logs = opts.logs ?? []
  server = createApp({ config, runners: opts.runners ?? fakeRunners(), cache: opts.cache ?? memCache(), log: e => logs.push(e) })
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
  const ALLOWED = new Set(['evt', 'kind', 'bytes', 'ms', 'queueMs', 'sha', 'cached', 'error', 'errorClass'])
  it('в записи разбора — ровно разрешённые ключи, имени файла нет', async () => {
    const logs: LogEntry[] = []
    const { extract } = await start({ logs })
    await extract('x', 'Иванов.txt')
    expect(new Set(Object.keys(logs[0]!))).toEqual(new Set(['evt', 'kind', 'bytes', 'ms', 'queueMs', 'sha', 'cached']))
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
