import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheKey, diskCache, redisCache, type RedisLike } from '../src/cache.ts'
import { CACHE_TTL_SEC, EXTRACTOR_VERSION } from '../src/config.ts'

const SHA = 'a'.repeat(64)

const base = { sha: SHA, kind: 'pdf', ext: 'pdf', maxTextChars: 100, version: '1' }
describe('cacheKey', () => {
  it('стабилен при тех же входах и меняется с каждым входом', () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }))
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/)
    const variants = [
      { version: '2' }, { kind: 'image' }, { sha: 'b'.repeat(64) }, { ext: 'doc' }, { maxTextChars: 101 }
    ]
    for (const v of variants) expect(cacheKey({ ...base, ...v })).not.toBe(cacheKey(base))
  })
  it('одни байты под .xls и .doc — разные ключи', () => {
    expect(cacheKey({ ...base, kind: 'office', ext: 'xls' })).not.toBe(cacheKey({ ...base, kind: 'office', ext: 'doc' }))
  })
  it('срок — ровно сутки', () => {
    expect(CACHE_TTL_SEC).toBe(86_400)
  })
})

describe('diskCache с подставным временем', () => {
  let dir: string
  let t: number
  const now = (): number => t
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fe-cache-test-'))
    t = 1_800_000_000_000
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('отдаёт запись до истечения и не отдаёт после', async () => {
    const c = diskCache(dir, { now })
    const k = cacheKey(base)
    await c.set(k, '{"x":1}', CACHE_TTL_SEC)
    t += (CACHE_TTL_SEC - 1) * 1000
    expect(await c.get(k)).toBe('{"x":1}')
    t += 1000
    expect(await c.get(k)).toBeNull()
    expect(await readdir(dir)).toEqual([]) // просроченное удалено при чтении
  })
  it('срок дольше суток срезается до суток', async () => {
    const c = diskCache(dir, { now })
    const k = cacheKey(base)
    await c.set(k, 'v', CACHE_TTL_SEC * 10)
    t += CACHE_TTL_SEC * 1000
    expect(await c.get(k)).toBeNull()
  })
  it('sweep удаляет только просроченное и брошенные временные файлы', async () => {
    const c = diskCache(dir, { now })
    const old = cacheKey(base)
    const fresh = cacheKey({ ...base, version: '2' })
    await c.set(old, 'old', 10)
    await c.set(fresh, 'fresh', CACHE_TTL_SEC)
    const tmpLive = join(dir, 'x.json.1.a.tmp')
    const tmpDead = join(dir, 'y.json.1.b.tmp')
    await writeFile(tmpLive, '')
    await writeFile(tmpDead, '')
    await utimes(tmpLive, t / 1000, t / 1000)
    await utimes(tmpDead, (t - 7_200_000) / 1000, (t - 7_200_000) / 1000)
    t += 11_000
    expect(await c.sweep()).toBe(2)
    expect((await readdir(dir)).sort()).toEqual([`${fresh}.json`, 'x.json.1.a.tmp'].sort())
  })
  it('потолок размера: вытесняются записи, истекающие раньше', async () => {
    const c = diskCache(dir, { now, maxBytes: 25 })
    const k1 = cacheKey(base)
    const k2 = cacheKey({ ...base, version: '2' })
    const k3 = cacheKey({ ...base, version: '3' })
    await c.set(k1, 'a'.repeat(10), 100)
    await c.set(k2, 'b'.repeat(10), 200)
    await c.set(k3, 'c'.repeat(10), 300)
    expect(await c.get(k1)).toBeNull()
    expect(await c.get(k2)).toBe('b'.repeat(10))
    expect(await c.get(k3)).toBe('c'.repeat(10))
  })
  it('запись больше всего потолка не пишется', async () => {
    const c = diskCache(dir, { now, maxBytes: 5 })
    await c.set(cacheKey(base), 'abc', 100)
    await c.set(cacheKey({ ...base, version: '2' }), 'x'.repeat(6), 200)
    expect(await c.get(cacheKey(base))).toBe('abc') // большая запись не вытеснила малую
    expect(await c.get(cacheKey({ ...base, version: '2' }))).toBeNull()
  })
  it('сбой создания каталога не закрывает кеш навсегда', async () => {
    const sub = join(dir, 'blocker', 'cache')
    await writeFile(join(dir, 'blocker'), '') // файл на месте каталога → mkdir падает
    const c = diskCache(sub, { now })
    await expect(c.set(cacheKey(base), 'v', 100)).rejects.toThrow()
    await rm(join(dir, 'blocker'))
    await c.set(cacheKey(base), 'v', 100)
    expect(await c.get(cacheKey(base))).toBe('v')
  })
  it('отвергает ключ, похожий на путь', async () => {
    const c = diskCache(dir, { now })
    await expect(c.set('../evil', 'v', 1)).rejects.toThrow()
  })
})

describe('redisCache', () => {
  it('пишет с EX не дольше суток и с префиксом', async () => {
    const set = vi.fn(async () => 'OK')
    const client: RedisLike = { get: vi.fn(async () => 'v'), set, quit: vi.fn(async () => 'OK') }
    const c = redisCache(client)
    await c.set('k', 'v', CACHE_TTL_SEC * 5)
    expect(set).toHaveBeenCalledWith('file-extract:k', 'v', 'EX', CACHE_TTL_SEC)
    expect(await c.get('k')).toBe('v')
    expect(client.get).toHaveBeenCalledWith('file-extract:k')
  })
})
