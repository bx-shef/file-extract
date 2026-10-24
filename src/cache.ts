import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CACHE_TTL_SEC } from './config.ts'

/**
 * Хранилище кеша. Значение — сериализованный успешный результат.
 * ⚠ Срок задаёт вызывающий, и он всегда CACHE_TTL_SEC: хранилище не продлевает запись при
 * чтении — иначе часто читаемый файл жил бы в кеше бесконечно.
 */
export interface CacheStore {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ttlSec: number) => Promise<void>
  /** Удалить просроченное; вернуть число удалённых. Redis делает это сам → 0. */
  sweep: () => Promise<number>
  close?: () => Promise<void>
}

/**
 * Ключ кеша: sha256(версия разборщика + способ разбора + sha256 файла).
 * Версия — чтобы после правки разбора старый результат не отдавался. Способ — потому что одни
 * и те же байты под именем `.txt` и `.csv` разбираются одинаково, а под `.pdf` и `.png` — нет.
 */
export function cacheKey(fileSha: string, kind: string, version: string): string {
  return createHash('sha256').update(`${version}\n${kind}\n${fileSha}`).digest('hex')
}

/** Срок в секундах не длиннее суток — защита от опечатки в вызывающем. */
function clampTtl(ttlSec: number): number {
  return Math.min(Math.max(1, Math.floor(ttlSec)), CACHE_TTL_SEC)
}

/**
 * Кеш на диске: файл на ключ, срок — по mtime. Просроченное удаляется при чтении и при
 * `sweep()` (раз в час). `now` внедряется ради тестов.
 */
export function diskCache(dir: string, now: () => number = Date.now): CacheStore {
  let ready: Promise<unknown> | null = null
  const ensure = (): Promise<unknown> => (ready ??= mkdir(dir, { recursive: true, mode: 0o700 }))
  const file = (key: string): string => {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('неверный ключ кеша')
    return join(dir, `${key}.json`)
  }
  // Срок записи хранится в mtime как «момент истечения»: так sweep не нужно знать TTL.
  const expired = (mtimeMs: number): boolean => mtimeMs <= now()

  return {
    async get(key) {
      const f = file(key)
      try {
        const st = await stat(f)
        if (expired(st.mtimeMs)) {
          await rm(f, { force: true })
          return null
        }
        return await readFile(f, 'utf8')
      } catch {
        return null
      }
    },
    async set(key, value, ttlSec) {
      await ensure()
      const f = file(key)
      const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, value, { mode: 0o600 })
      const exp = (now() + clampTtl(ttlSec) * 1000) / 1000
      await utimes(tmp, exp, exp)
      await rename(tmp, f)
    },
    async sweep() {
      let removed = 0
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return 0
      }
      for (const n of names) {
        const f = join(dir, n)
        try {
          const st = await stat(f)
          // Временный файл (запись идёт прямо сейчас) не трогаем, брошенный — старше часа — удаляем.
          const dead = n.endsWith('.tmp') ? st.mtimeMs < now() - 3_600_000 : expired(st.mtimeMs)
          if (dead) {
            await rm(f, { force: true })
            removed++
          }
        } catch { /* файл исчез — не наша забота */ }
      }
      return removed
    }
  }
}

/** Минимальный интерфейс Redis-клиента, который нужен кешу (подходит ioredis). */
export interface RedisLike {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, mode: 'EX', ttl: number) => Promise<unknown>
  quit: () => Promise<unknown>
}

/** Кеш в Redis: срок держит сам Redis (`SET … EX`). */
export function redisCache(client: RedisLike, prefix = 'file-extract:'): CacheStore {
  return {
    get: key => client.get(prefix + key),
    async set(key, value, ttlSec) {
      await client.set(prefix + key, value, 'EX', clampTtl(ttlSec))
    },
    sweep: async () => 0,
    close: async () => { await client.quit() }
  }
}
