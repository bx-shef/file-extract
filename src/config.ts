// Настройки из окружения. Разбор чистый: env передаётся параметром → проверяется тестом.

import { DEFAULT_CONSUMER, type Consumer } from './auth.ts'
import type { VisionConfig } from './vision.ts'

export const EXTRACTOR_VERSION = '0.2.0-2'
// ⚠ Поднимать при ЛЮБОЙ смене логики разбора (исполнители, чистка, листы, потолки): версия
// входит в ключ кеша, и старый результат после правки иначе отдавался бы ещё сутки.

/** Срок кеша — ровно сутки и НЕ дольше: в разобранном тексте персональные данные. */
export const CACHE_TTL_SEC = 86_400

export interface Config {
  port: number
  host: string
  /** Ключи потребителей: `EXTRACT_API_KEYS` (метка:ключ) и старый `EXTRACT_API_KEY` (метка `default`). */
  consumers: Consumer[]
  maxFileBytes: number
  maxTextChars: number
  maxConcurrency: number
  /** Сколько запросов может ждать места сверх идущих разборов. Сверх — сразу 503 busy. */
  maxQueue: number
  queueTimeoutMs: number
  extractTimeoutMs: number
  redisUrl: string | null
  cacheDir: string
  cacheMaxBytes: number
  /** Зрение — описание картинок сервисом toolsai-light `vision`; null — картинки только OCR. */
  vision: VisionConfig | null
}

export class ConfigError extends Error {}

function int(env: Record<string, string | undefined>, name: string, def: number, min: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name}: ожидается целое число не меньше ${min}`)
  return n
}

/**
 * База API зрения из VISION_URL: http(s), хост, порт и путь — без логина и пароля в адресе (ключ —
 * только VISION_API_KEY в заголовке), без запроса и якоря (к адресу дописывается /chat/completions).
 * Неверный адрес — null. Чистая.
 */
export function visionBaseUrl(raw: string): string | null {
  if (/[\s?#]/.test(raw)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '' || u.username !== '' || u.password !== '') return null
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
}

/**
 * Зрение: VISION_URL — база OpenAI-совместимого API (http://vision:8080/v1). Пусто — зрения нет.
 * Адрес без ключа — ошибка запуска, а не тихое «без зрения»: администратор хотел зрение.
 * Таймаут зрения меньше таймаута разбора: зрение начинается с получением места разбора и идёт параллельно с OCR, и тогда
 * худший случай запроса (очередь + разбор) из-за него не растёт.
 */
function visionConfig(env: Record<string, string | undefined>, extractTimeoutMs: number): VisionConfig | null {
  const raw = (env.VISION_URL ?? '').trim()
  if (raw === '') return null
  const url = visionBaseUrl(raw)
  if (url === null) {
    throw new ConfigError('VISION_URL: ожидается адрес http(s)://хост[:порт]/путь без логина, запроса и якоря, например http://vision:8080/v1')
  }
  const apiKey = env.VISION_API_KEY ?? ''
  if (apiKey === '') throw new ConfigError('VISION_API_KEY не задан: без ключа сервис зрения не ответит')
  const timeoutMs = int(env, 'VISION_TIMEOUT_MS', 150_000, 1)
  if (timeoutMs >= extractTimeoutMs) throw new ConfigError('VISION_TIMEOUT_MS должен быть меньше EXTRACT_TIMEOUT_MS')
  return {
    url,
    apiKey,
    model: (env.VISION_MODEL ?? '').trim() || 'vision',
    timeoutMs,
    maxTokens: int(env, 'VISION_MAX_TOKENS', 400, 16)
  }
}

/** Минимальная длина общего ключа: короткий ключ перебирается. */
export const MIN_API_KEY_LENGTH = 16

/** Метка потребителя: попадает в журнал и ключ кеша, поэтому — короткий закрытый алфавит. */
const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Ключи потребителей. `EXTRACT_API_KEYS` — «метка:ключ», через запятую или перевод строки, например
 * `mcp:AAAA…,price-import:BBBB…,bank:CCCC…`; ключ — всё после первого «:» (не короче `MIN_API_KEY_LENGTH`, без пробелов и
 * запятых). `EXTRACT_API_KEY` — старый общий ключ, метка `default`; оба вместе допустимы (переезд по одному потребителю).
 * Одна метка с двумя ключами — ротация без простоя; один ключ у двух меток — ошибка (потребителей было бы не различить).
 * Ни одного ключа — ошибка запуска (fail-closed), кроме NODE_ENV=test. В тексте ошибки — только метки и номера записей,
 * сами ключи не печатаются никогда.
 */
export function parseConsumers(env: Record<string, string | undefined>, allowNone: boolean): Consumer[] {
  const out: Consumer[] = []
  const legacy = env.EXTRACT_API_KEY ?? ''
  if (legacy !== '') {
    if (legacy.length < MIN_API_KEY_LENGTH) throw new ConfigError(`EXTRACT_API_KEY короче ${MIN_API_KEY_LENGTH} знаков`)
    out.push({ label: DEFAULT_CONSUMER, key: legacy })
  }
  const list = (env.EXTRACT_API_KEYS ?? '').split(/[,\r\n]+/).map(s => s.trim()).filter(s => s !== '')
  list.forEach((entry, i) => {
    const at = entry.indexOf(':')
    const label = at < 0 ? '' : entry.slice(0, at)
    const key = at < 0 ? '' : entry.slice(at + 1)
    if (!LABEL_RE.test(label)) throw new ConfigError(`EXTRACT_API_KEYS, запись ${i + 1}: ожидается метка:ключ, метка — a-z, 0-9, «_», «-», до 32 знаков`)
    if (key.length < MIN_API_KEY_LENGTH || /\s/.test(key)) throw new ConfigError(`EXTRACT_API_KEYS, запись ${i + 1} (${label}): ключ короче ${MIN_API_KEY_LENGTH} знаков или с пробелами`)
    out.push({ label, key })
  })
  const seen = new Map<string, string>()
  for (const c of out) {
    const prev = seen.get(c.key)
    if (prev !== undefined && prev !== c.label) throw new ConfigError(`один ключ у двух потребителей: ${prev} и ${c.label}`)
    seen.set(c.key, c.label)
  }
  if (out.length === 0 && !allowNone) throw new ConfigError('ни EXTRACT_API_KEY, ни EXTRACT_API_KEYS не заданы: сервис без ключа не запускается')
  return out
}

/**
 * Прочитать настройки. Без ключей (EXTRACT_API_KEY/EXTRACT_API_KEYS) сервис НЕ стартует (fail-closed): открытый
 * разборщик чужих файлов во внутренней сети — это кто угодно с доступом к сети.
 * Исключение — NODE_ENV=test.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const consumers = parseConsumers(env, env.NODE_ENV === 'test')
  // 5 минут: OCR скана в 30 страниц по очереди на одном ядре укладывается с запасом.
  const extractTimeoutMs = int(env, 'EXTRACT_TIMEOUT_MS', 300_000, 1)
  return {
    port: int(env, 'PORT', 3000, 1),
    // По умолчанию — только loopback: открыть сервис в сеть должно быть решением (в образе
    // Dockerfile задаёт HOST=0.0.0.0 явно, а сеть ограничивает compose).
    host: env.HOST || '127.0.0.1',
    consumers,
    maxFileBytes: int(env, 'MAX_FILE_BYTES', 20 * 1024 * 1024, 1),
    maxTextChars: int(env, 'MAX_TEXT_CHARS', 2_000_000, 1),
    maxConcurrency: int(env, 'MAX_CONCURRENCY', 2, 1),
    maxQueue: int(env, 'MAX_QUEUE', 8, 0),
    queueTimeoutMs: int(env, 'QUEUE_TIMEOUT_MS', 60_000, 1),
    extractTimeoutMs,
    redisUrl: env.REDIS_URL || null,
    cacheDir: env.CACHE_DIR || '/tmp/file-extract-cache',
    cacheMaxBytes: int(env, 'CACHE_MAX_BYTES', 256 * 1024 * 1024, 1),
    vision: visionConfig(env, extractTimeoutMs)
  }
}
