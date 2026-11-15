// Зрение: описание картинки моделью сервиса зрения toolsai-light (сервис `vision`, Qwen3-VL-4B,
// OpenAI-совместимый POST /v1/chat/completions). Картинка уходит data:-адресом: по адресам сервис
// зрения не ходит (его исходящие запросы закрыты). Сбой зрения — не сбой разбора: картинка остаётся
// с текстом OCR, а в журнал уходит только машинная причина.

import { readFile } from 'node:fs/promises'

/** Форматы, которые сервис зрения принимает (проверено 15.11 на llama.cpp b12033): PNG, JPEG, WEBP. */
export const VISION_MIME: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
})

/** Версия запроса к зрению. Входит в ключ кеша вместе с моделью: новый запрос не отдаёт старый ответ. */
export const VISION_PROMPT_VERSION = 'v1'

/** Запрос к модели: описание для помощника, который картинку не видит. */
export const VISION_PROMPT = 'Опиши картинку для помощника, который её не видит. Что это (снимок экрана, документ, фото, '
  + 'схема, график, таблица), о чём текст на ней и что в нём главное. Важные числа, суммы, даты, названия и имена '
  + 'перепиши точно. 2–5 предложений по-русски, без вступления.'

/** Потолок описания в знаках: модель с потолком токенов в него укладывается, это страховка от мусора. */
export const MAX_DESCRIPTION_CHARS = 2000

export interface VisionConfig {
  /** База OpenAI-совместимого API без завершающего «/»: http://vision:8080/v1. */
  url: string
  apiKey: string
  model: string
  timeoutMs: number
  maxTokens: number
}

/** Описание картинки по пути к файлу; null — описания нет (формат, сбой, пустой ответ). */
export type DescribeFile = (path: string, ext: string, signal: AbortSignal) => Promise<string | null>

/** Причина, по которой описания нет, — для журнала, без текста и имён. */
export type VisionFailure = 'timeout' | 'aborted' | 'network' | 'empty' | 'bad_response' | `http_${number}`

/** Часть ключа кеша: модель, версия запроса и потолок ответа; без зрения — пусто. Чистая. */
export function visionCacheKey(v: VisionConfig | null): string {
  return v ? ['vision', v.model, VISION_PROMPT_VERSION, String(v.maxTokens)].join(':') : ''
}

/** Текст картинки: описание сверху, под ним текст OCR. Без описания — текст OCR как есть. Чистая. */
export function composeImageText(description: string | null, ocrText: string): string {
  if (!description) return ocrText
  const ocr = ocrText.trim()
  return `Описание картинки: ${description}\n\n${ocr ? `Текст с картинки:\n${ocr}` : 'Текста на картинке не найдено.'}`
}

/** Ответ сервиса зрения → описание одной строкой; пустое и не той формы — null. Чистая. */
export function parseDescription(body: unknown): string | null {
  const choices = (body as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices)) return null
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content !== 'string') return null
  const d = content.replace(/\s+/g, ' ').trim()
  return d === '' ? null : d.slice(0, MAX_DESCRIPTION_CHARS)
}

/** Тело запроса к сервису зрения. Выборка — рекомендованная Qwen для Qwen3-VL (без неё модель повторяет строки). */
export function visionRequestBody(v: VisionConfig, mime: string, bytes: Buffer): string {
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
        { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
        { type: 'text', text: VISION_PROMPT }
      ]
    }]
  })
}

/**
 * Описатель картинок для исполнителей разбора. Формат не из VISION_MIME — сразу null, без запроса.
 * Таймаут свой (VISION_TIMEOUT_MS, меньше таймаута разбора): долгий ответ зрения не губит текст OCR.
 * Перенаправления запрещены: ключ не уходит на чужой адрес.
 */
export function createDescriber(
  v: VisionConfig,
  fetchFn: typeof fetch = fetch,
  onFail: (reason: VisionFailure) => void = () => {}
): DescribeFile {
  return async (path, ext, signal) => {
    const mime = VISION_MIME[ext]
    if (!mime) return null
    const ac = new AbortController()
    const onOuter = (): void => ac.abort()
    signal.addEventListener('abort', onOuter, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, v.timeoutMs)
    try {
      const bytes = await readFile(path)
      // Разбор отменили, пока читался файл, — запрос к зрению уже не нужен.
      if (ac.signal.aborted) throw new Error('aborted')
      const res = await fetchFn(`${v.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.apiKey}` },
        body: visionRequestBody(v, mime, bytes),
        signal: ac.signal,
        redirect: 'error'
      })
      if (!res.ok) {
        onFail(`http_${res.status}`)
        return null
      }
      let body: unknown
      try {
        body = await res.json()
      } catch {
        onFail('bad_response')
        return null
      }
      const d = parseDescription(body)
      if (d === null) onFail('empty')
      return d
    } catch {
      onFail(timedOut ? 'timeout' : signal.aborted ? 'aborted' : 'network')
      return null
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuter)
    }
  }
}
