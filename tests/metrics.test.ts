import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diskCache, redisCache } from '../src/cache.ts'
import { programsAvailable } from '../src/extractRunners.ts'
import { createMetrics } from '../src/metrics.ts'

const MEM = { rssBytes: 100, peakRssBytes: 300 }

describe('метрики: текст Prometheus', () => {
  it('счётчики по маршруту и статусу, кеш, очередь, память', () => {
    const m = createMetrics()
    m.request('extract', 200); m.request('extract', 200); m.request('extract', 503); m.request('extract', 504); m.request('convert', 200)
    m.cacheHit(); m.cacheMiss(); m.cacheMiss(); m.shared()
    const t = m.render({ running: 2, queued: 5, inflight: 7, flights: 1 }, MEM)
    expect(t).toContain('file_extract_requests_total{route="extract",status="200"} 2')
    expect(t).toContain('file_extract_requests_total{route="extract",status="503"} 1')
    expect(t).toContain('file_extract_requests_total{route="extract",status="504"} 1')
    expect(t).toContain('file_extract_requests_total{route="convert",status="200"} 1')
    expect(t).toContain('file_extract_cache_hits_total 1')
    expect(t).toContain('file_extract_cache_misses_total 2')
    expect(t).toContain('file_extract_shared_total 1')
    expect(t).toContain('file_extract_flights 1')
    expect(t).toContain('file_extract_queue_depth 5')
    expect(t).toContain('file_extract_slots_running 2')
    expect(t).toContain('file_extract_memory_peak_rss_bytes 300')
    expect(t.endsWith('\n')).toBe(true)
  })
  it('метка статуса — только число 100–599, лишнее — 0', () => {
    const m = createMetrics()
    m.request('extract', Number.NaN)
    m.request('extract', 99999)
    expect(m.render({ running: 0, queued: 0, inflight: 0, flights: 0 }, MEM)).toContain('status="0"} 2')
  })
  it('без запросов — валидный текст с нулями', () => {
    expect(createMetrics().render({ running: 0, queued: 0, inflight: 0, flights: 0 }, MEM)).toContain('file_extract_cache_hits_total 0')
  })
})

describe('готовность: программы и кеш', () => {
  it('программа вне PATH — не готово; пустой PATH — не готово', async () => {
    expect(await programsAvailable({ PATH: '' })).toBe(false)
    expect(await programsAvailable({ PATH: '/nonexistent-dir' })).toBe(false)
  })
  it('диск: каталог доступен — ping true; недоступный — false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fe-ping-'))
    try {
      expect(await diskCache(join(dir, 'c')).ping!()).toBe(true)
      // каталог внутри файла создать нельзя
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'f'), 'x')
      expect(await diskCache(join(dir, 'f', 'c')).ping!()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('Redis: ответил — true, ошибка — false', async () => {
    const ok = { get: async () => null, set: async () => 'OK', quit: async () => 'OK' }
    expect(await redisCache(ok).ping!()).toBe(true)
    expect(await redisCache({ ...ok, get: async () => { throw new Error('down') } }).ping!()).toBe(false)
  })
})
