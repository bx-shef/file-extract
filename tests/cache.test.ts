import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheKey, diskCache, redisCache, type RedisLike } from '../src/cache.ts'
import { CACHE_TTL_SEC, EXTRACTOR_VERSION } from '../src/config.ts'

const SHA = 'a'.repeat(64)

describe('cacheKey', () => {
  it('меняется с версией разборщика — старый кеш после правки не отдаётся', () => {
    expect(cacheKey(SHA, 'pdf', '1')).not.toBe(cacheKey(SHA, 'pdf', '2'))
  })
  it('меняется со способом разбора и с файлом, стабилен при тех же входах', () => {
    expect(cacheKey(SHA, 'pdf', EXTRACTOR_VERSION)).not.toBe(cacheKey(SHA, 'image', EXTRACTOR_VERSION))
    expect(cacheKey(SHA, 'pdf', EXTRACTOR_VERSION)).not.toBe(cacheKey('b'.repeat(64), 'pdf', EXTRACTOR_VERSION))
    expect(cacheKey(SHA, 'pdf', '1')).toBe(cacheKey(SHA, 'pdf', '1'))
    expect(cacheKey(SHA, 'pdf', '1')).toMatch(/^[0-9a-f]{64}$/)
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
    const c = diskCache(dir, now)
    const k = cacheKey(SHA, 'pdf', '1')
    await c.set(k, '{"x":1}', CACHE_TTL_SEC)
    t += (CACHE_TTL_SEC - 1) * 1000
    expect(await c.get(k)).toBe('{"x":1}')
    t += 1000
    expect(await c.get(k)).toBeNull()
    expect(await readdir(dir)).toEqual([]) // просроченное удалено при чтении
  })
  it('срок дольше суток срезается до суток', async () => {
    const c = diskCache(dir, now)
    const k = cacheKey(SHA, 'pdf', '1')
    await c.set(k, 'v', CACHE_TTL_SEC * 10)
    t += CACHE_TTL_SEC * 1000
    expect(await c.get(k)).toBeNull()
  })
  it('sweep удаляет только просроченное и брошенные временные файлы', async () => {
    const c = diskCache(dir, now)
    const old = cacheKey(SHA, 'pdf', '1')
    const fresh = cacheKey(SHA, 'pdf', '2')
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
  it('отвергает ключ, похожий на путь', async () => {
    const c = diskCache(dir, now)
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
