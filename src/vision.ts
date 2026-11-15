// Зрение: описание картинки моделью сервиса зрения toolsai-light (сервис `vision`, Qwen3-VL-4B,
// OpenAI-совместимый POST /v1/chat/completions). Картинка уходит data:-адресом: по адресам сервис
// зрения не ходит (его исходящие запросы закрыты). Сбой зрения — не сбой разбора: картинка остаётся
// с текстом OCR, а в журнал уходит только машинная причина.
//
// Зрение начинается, когда картинка получила место разбора, идёт параллельно с OCR и своим местом (Limiter на 1:
// сервис зрения разбирает одну картинку за раз) — место разбора оно не держит: десятки секунд модели не
// задерживают чужие файлы.

import { imageFormat, imageSize, MAX_IMAGE_PIXELS, type ImageFormat } from './imageSize.ts'
import { Limiter } from './limiter.ts'
import { sanitizeExtractedText } from './textSanitize.ts'

/**
 * Форматы, которые сервис зрения принимает (проверено 15.11 на llama.cpp b12033): PNG, JPEG, WEBP.
 * Формат — по байтам файла, не по имени: «.png» с байтами BMP в зрение не уйдёт.
 */
export const VISION_FORMATS: Readonly<Partial<Record<ImageFormat, string>>> = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
})

/** Версия запроса к зрению. Входит в ключ кеша вместе с моделью: новый запрос не отдаёт старый ответ. */
export const VISION_PROMPT_VERSION = 'v1'

/** Запрос к модели: описание для помощника, который картинку не видит. Сменил текст — подними версию. */
export const VISION_PROMPT = 'Опиши картинку для помощника, который её не видит. Что это (снимок экрана, документ, фото, '
  + 'схема, график, таблица), о чём текст на ней и что в нём главное. Важные числа, суммы, даты, названия и имена '
  + 'перепиши точно. 2–5 предложений по-русски, без вступления.'

/** Потолок описания в знаках: модель с потолком токенов в него укладывается, это страховка от мусора. */
export const MAX_DESCRIPTION_CHARS = 2000

/** Потолок ответа сервиса зрения в байтах: описание — сотни знаков; больше — не наш ответ, дальше не читаем. */
export const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * Очередь зрения: одна картинка в работе, ждут не больше двух и не дольше половины VISION_TIMEOUT_MS — та, что
 * получила место, успевает ответить, а не работает впустую до таймаута. Лишние — сразу без описания (в кеш не идут).
 */
export const VISION_MAX_QUEUE = 2

export interface VisionConfig {
  /** База OpenAI-совместимого API без завершающего «/»: http://vision:8080/v1. */
  url: string
  apiKey: string
  model: string
  /** На всё: очередь зрения и ответ модели. */
  timeoutMs: number
  maxTokens: number
}

/** Причина, по которой описания нет, — для журнала, без текста и имён. */
export type VisionFailure =
  | 'unsupported' // формат по байтам не PNG/JPEG/WEBP или заголовок обрезан
  | 'too_large' // больше MAX_IMAGE_PIXELS
  | 'busy' // очередь зрения полна или не дождались места
  | 'timeout' | 'aborted' | 'network' | 'empty' | 'bad_response' | `http_${number}`

/** Итог зрения: описание или машинная причина, почему его нет. */
export type VisionOutcome = { description: string } | { failure: VisionFailure }

/** Описать картинку по её байтам; signal — уход клиента или конец запроса. Не бросает. */
export type DescribeImage = (bytes: Uint8Array, signal: AbortSignal) => Promise<VisionOutcome>

/** Часть ключа кеша: модель, версия запроса и потолок ответа; без зрения — пусто. Чистая. */
export function visionCacheKey(v: VisionConfig | null): string {
  return v ? ['vision', v.model, VISION_PROMPT_VERSION, String(v.maxTokens)].join(':') : ''
}

/**
 * Можно ли класть ответ в кеш на сутки. Описание есть или зрения не было — да. Отказ по формату и
 * размеру — да: те же байты дадут тот же отказ. Остальное (таймаут, сеть, занято, пустой ответ) — нет:
 * следующий запрос той же картинки снова спросит зрение, а не проживёт сутки без описания. Чистая.
 */
export function visionCacheable(o: VisionOutcome | null): boolean {
  return o === null || 'description' in o || o.failure === 'unsupported' || o.failure === 'too_large'
}

/** Текст картинки: описание сверху, под ним текст OCR. Без описания — текст OCR как есть. Чистая. */
export function composeImageText(description: string | null, ocrText: string): string {
  if (!description) return ocrText
  const ocr = ocrText.trim()
  return `Описание картинки: ${description}\n\n${ocr ? `Текст с картинки:\n${ocr}` : 'Текста на картинке не найдено.'}`
}

/**
 * Знаки направления текста (bidi) и BOM: в описании от модели они только прячут или переворачивают текст.
 * ⚠ Escape-последовательностями намеренно (как в textSanitize.ts): литералы невидимы, правка «на глаз» ломает диапазон.
 */
const BIDI_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/** Не длиннее max единиц UTF-16; суррогатная пара на границе не рвётся (иначе в конце «�»). Чистая. */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s
  const c = s.charCodeAt(max - 1)
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max)
}

/**
 * Ответ сервиса зрения → описание одной строкой: без управляющих символов C0/C1 и знаков направления,
 * пробелы схлопнуты, не длиннее MAX_DESCRIPTION_CHARS. Пустое и не той формы — null. Чистая.
 */
export function parseDescription(body: unknown): string | null {
  const choices = (body as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices)) return null
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content !== 'string') return null
  const d = sanitizeExtractedText(content).text.replace(BIDI_CHARS, '').replace(/\s+/g, ' ').trim()
  return d === '' ? null : cutText(d, MAX_DESCRIPTION_CHARS).trim()
}

/** Тело запроса к сервису зрения. Выборка — рекомендованная Qwen для Qwen3-VL (без неё модель повторяет строки). */
export function visionRequestBody(v: VisionConfig, mime: string, bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  return JSON.stringify({
    model: v.model,
    max_tokens: v.maxTokens,
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    presence_penalty: 1.5,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        { type: 'text', text: VISION_PROMPT }
      ]
    }]
  })
}

/** Тело ответа целиком, но не больше max байт; больше — ошибка, остаток не читаем. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => {})
    throw new Error('ответ больше потолка')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      throw new Error('ответ больше потолка')
    }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

export interface DescriberDeps {
  fetchFn?: typeof fetch
  /** Очередь зрения (по умолчанию — VISION_MAX_QUEUE): сервис разбирает одну картинку за раз (PARALLEL=1). */
  limiter?: Limiter
  onFail?: (reason: VisionFailure) => void
}

/**
 * Описатель картинок. До запроса — проверки по байтам: формат из VISION_FORMATS и не больше
 * MAX_IMAGE_PIXELS (как у OCR); иначе отказ без запроса. Таймаут (VISION_TIMEOUT_MS) — на очередь
 * зрения и ответ вместе. Перенаправления запрещены: ключ не уходит на чужой адрес. Ответ — не больше
 * MAX_RESPONSE_BYTES. Не бросает: любой сбой — `{ failure }`; onFail — только настоящие сбои зрения
 * (формат, размер и уход клиента — обычное дело, не тревога).
 */
export function createDescriber(v: VisionConfig, deps: DescriberDeps = {}): DescribeImage {
  const fetchFn = deps.fetchFn ?? fetch
  const limiter = deps.limiter ?? new Limiter(1, Math.floor(v.timeoutMs / 2), VISION_MAX_QUEUE)
  const onFail = deps.onFail ?? (() => {})
  const fail = (failure: VisionFailure): VisionOutcome => {
    if (failure !== 'unsupported' && failure !== 'too_large' && failure !== 'aborted') onFail(failure)
    return { failure }
  }
  return async (bytes, signal) => {
    if (signal.aborted) return fail('aborted')
    const format = imageFormat(bytes)
    const mime = format ? VISION_FORMATS[format] : undefined
    const size = mime ? imageSize(bytes) : null
    if (!mime || !size) return fail('unsupported')
    if (size.width * size.height > MAX_IMAGE_PIXELS) return fail('too_large')
    const ac = new AbortController()
    const onOuter = (): void => ac.abort()
    signal.addEventListener('abort', onOuter, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, v.timeoutMs)
    // Отмена снаружи и свой таймаут видны как отказ любой операции — назвать настоящую причину
    const why = (other: VisionFailure): VisionFailure => (timedOut ? 'timeout' : signal.aborted ? 'aborted' : other)
    let release: (() => void) | null = null
    try {
      try {
        release = await limiter.acquire(ac.signal)
      } catch {
        return fail(why('busy'))
      }
      let res: Response
      try {
        res = await fetchFn(`${v.url}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.apiKey}` },
          body: visionRequestBody(v, mime, bytes),
          signal: ac.signal,
          redirect: 'error'
        })
      } catch {
        return fail(why('network'))
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {})
        return fail(`http_${res.status}`)
      }
      let raw: string
      try {
        raw = await readCapped(res, MAX_RESPONSE_BYTES)
      } catch {
        return fail(why('bad_response'))
      }
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return fail('bad_response')
      }
      const description = parseDescription(body)
      return description === null ? fail('empty') : { description }
    } finally {
      release?.()
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuter)
    }
  }
}
