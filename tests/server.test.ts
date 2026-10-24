import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheStore } from '../src/cache.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { ExtractError } from '../src/errors.ts'
import type { LogEntry } from '../src/log.ts'
import { createApp } from '../src/server.ts'
import type { ExtractRunners } from '../src/textExtract.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
const KEY = 'test-key-0123456789abcdef'

function memCache(): CacheStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: async k => map.get(k) ?? null,
    set: async (k, v) => { map.set(k, v) },
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
    return fetch(`${base}/extract`, { method: 'POST', headers, body })
  }
  return { base, extract, logs }
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
