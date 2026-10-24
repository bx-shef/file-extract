// Настройки из окружения. Разбор чистый: env передаётся параметром → проверяется тестом.

export const EXTRACTOR_VERSION = '0.1.0-1'
// ⚠ Поднимать при ЛЮБОЙ смене логики разбора (исполнители, чистка, листы, потолки): версия
// входит в ключ кеша, и старый результат после правки иначе отдавался бы ещё сутки.

/** Срок кеша — ровно сутки и НЕ дольше: в разобранном тексте персональные данные. */
export const CACHE_TTL_SEC = 86_400

export interface Config {
  port: number
  host: string
  apiKey: string
  maxFileBytes: number
  maxTextChars: number
  maxConcurrency: number
  queueTimeoutMs: number
  extractTimeoutMs: number
  redisUrl: string | null
  cacheDir: string
}

export class ConfigError extends Error {}

function int(env: Record<string, string | undefined>, name: string, def: number, min: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name}: ожидается целое число не меньше ${min}`)
  return n
}

/** Минимальная длина общего ключа: короткий ключ перебирается. */
export const MIN_API_KEY_LENGTH = 16

/**
 * Прочитать настройки. Без EXTRACT_API_KEY сервис НЕ стартует (fail-closed): открытый
 * разборщик чужих файлов во внутренней сети — это кто угодно с доступом к сети.
 * Исключение — NODE_ENV=test.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.EXTRACT_API_KEY ?? ''
  if (env.NODE_ENV !== 'test') {
    if (!apiKey) throw new ConfigError('EXTRACT_API_KEY не задан: сервис без ключа не запускается')
    if (apiKey.length < MIN_API_KEY_LENGTH) throw new ConfigError(`EXTRACT_API_KEY короче ${MIN_API_KEY_LENGTH} знаков`)
  }
  return {
    port: int(env, 'PORT', 3000, 1),
    host: env.HOST || '0.0.0.0',
    apiKey,
    maxFileBytes: int(env, 'MAX_FILE_BYTES', 20 * 1024 * 1024, 1),
    maxTextChars: int(env, 'MAX_TEXT_CHARS', 2_000_000, 1),
    maxConcurrency: int(env, 'MAX_CONCURRENCY', 2, 1),
    queueTimeoutMs: int(env, 'QUEUE_TIMEOUT_MS', 60_000, 1),
    extractTimeoutMs: int(env, 'EXTRACT_TIMEOUT_MS', 120_000, 1),
    redisUrl: env.REDIS_URL || null,
    cacheDir: env.CACHE_DIR || '/tmp/file-extract-cache'
  }
}
