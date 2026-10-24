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

export interface CacheKeyInput {
  /** sha256 файла. */
  sha: string
  /** Способ разбора (text/pdf/office/image). */
  kind: string
  /** Расширение: одни и те же байты под `.xls` и `.doc` LibreOffice выгружает разными
   *  фильтрами (CSV против текста) — результат разный. */
  ext: string
  /** Потолок текста: обрезка идёт ДО кеширования, и запись при другом потолке была бы чужой. */
  maxTextChars: number
  /** Версия разборщика — чтобы после правки разбора старый результат не отдавался. */
  version: string
}

/** Версия формы ключа: поднимается, когда меняется набор полей ниже. */
const KEY_FORMAT = 'k2'

/**
 * Ключ кеша: sha256 от всех входов, от которых зависит ответ (см. CacheKeyInput).
 * Способ — потому что одни и те же байты под `.txt` и `.pdf` разбираются по-разному.
 */
export function cacheKey(k: CacheKeyInput): string {
  return createHash('sha256')
    .update([KEY_FORMAT, k.version, k.kind, k.ext, String(k.maxTextChars), k.sha].join('\n'))
    .digest('hex')
}

/** Срок в секундах не длиннее суток — защита от опечатки в вызывающем. */
function clampTtl(ttlSec: number): number {
  return Math.min(Math.max(1, Math.floor(ttlSec)), CACHE_TTL_SEC)
}

/** Потолок дискового кеша по умолчанию: tmpfs под кеш в compose того же размера. */
export const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024

export interface DiskCacheOptions {
  now?: () => number
  /** Потолок суммарного размера записей. Сверх него вытесняются записи, истекающие раньше. */
  maxBytes?: number
}

/**
 * Кеш на диске: файл на ключ, срок — по mtime. Просроченное удаляется при чтении и при
 * `sweep()` (раз в час). После записи суммарный размер сверяется с `maxBytes`: без потолка
 * кеш на tmpfs съел бы память контейнера (tmpfs — это память), а Redis держит свой maxmemory.
 */
export function diskCache(dir: string, opts: DiskCacheOptions = {}): CacheStore {
  const now = opts.now ?? Date.now
  const maxBytes = opts.maxBytes ?? DEFAULT_CACHE_MAX_BYTES
  let ready: Promise<unknown> | null = null
  // При ошибке mkdir обещание сбрасывается: иначе один сбой (каталог ещё не смонтирован)
  // навсегда закрыл бы запись в кеш до перезапуска.
  const ensure = (): Promise<unknown> => (ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).catch((e: unknown) => {
    ready = null
    throw e
  }))
  const file = (key: string): string => {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('неверный ключ кеша')
    return join(dir, `${key}.json`)
  }
  // Срок записи хранится в mtime как «момент истечения»: так sweep не нужно знать TTL.
  const expired = (mtimeMs: number): boolean => mtimeMs <= now()

  /** Вытеснить записи, истекающие раньше всех, пока сумма не уложится в потолок. */
  async function enforceCap(): Promise<void> {
    let names: string[]
    try { names = await readdir(dir) } catch { return }
    const entries: Array<{ f: string, size: number, exp: number }> = []
    let total = 0
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      const f = join(dir, n)
      try {
        const st = await stat(f)
        entries.push({ f, size: st.size, exp: st.mtimeMs })
        total += st.size
      } catch { /* исчез */ }
    }
    if (total <= maxBytes) return
    entries.sort((a, b) => a.exp - b.exp)
    for (const e of entries) {
      if (total <= maxBytes) break
      await rm(e.f, { force: true }).catch(() => {})
      total -= e.size
    }
  }

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
      // Запись больше всего потолка не кешируем вовсе: она вытеснила бы всё и себя.
      if (Buffer.byteLength(value) > maxBytes) return
      await ensure()
      const f = file(key)
      const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, value, { mode: 0o600 })
      const exp = (now() + clampTtl(ttlSec) * 1000) / 1000
      await utimes(tmp, exp, exp)
      await rename(tmp, f)
      await enforceCap()
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
