import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  composeImageText, createDescriber, MAX_DESCRIPTION_CHARS, parseDescription, VISION_MIME, VISION_PROMPT,
  VISION_PROMPT_VERSION, visionCacheKey, visionRequestBody, type VisionConfig
} from '../src/vision.ts'

const V: VisionConfig = { url: 'http://vision:8080/v1', apiKey: 'vision-key-0123456789', model: 'vision', timeoutMs: 2000, maxTokens: 400 }

function okResponse(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('composeImageText', () => {
  it('описание сверху, текст OCR под ним', () => {
    expect(composeImageText('Снимок карточки CRM: поставка на 5000 BYN.', 'Сумма 5000\nВалюта BYN'))
      .toBe('Описание картинки: Снимок карточки CRM: поставка на 5000 BYN.\n\nТекст с картинки:\nСумма 5000\nВалюта BYN')
  })
  it('без описания — текст OCR как есть', () => {
    expect(composeImageText(null, 'текст скана')).toBe('текст скана')
    expect(composeImageText('', 'текст скана')).toBe('текст скана')
  })
  it('описание есть, текста нет — так и сказано, а не пусто', () => {
    expect(composeImageText('Фото склада.', '  \n ')).toBe('Описание картинки: Фото склада.\n\nТекста на картинке не найдено.')
  })
})

describe('parseDescription', () => {
  it('берёт choices[0].message.content одной строкой', () => {
    expect(parseDescription({ choices: [{ message: { content: '  Снимок\nэкрана  CRM. ' } }] })).toBe('Снимок экрана CRM.')
  })
  it('пустое и не той формы — null', () => {
    for (const b of [null, {}, { choices: [] }, { choices: 'x' }, { choices: [{ message: { content: 5 } }] }, { choices: [{ message: { content: '   ' } }] }]) {
      expect(parseDescription(b)).toBeNull()
    }
  })
  it('длинное режется по MAX_DESCRIPTION_CHARS', () => {
    expect(parseDescription({ choices: [{ message: { content: 'я'.repeat(MAX_DESCRIPTION_CHARS + 50) } }] })).toHaveLength(MAX_DESCRIPTION_CHARS)
  })
})

describe('visionCacheKey', () => {
  it('без зрения — пусто; со зрением — модель, версия запроса, потолок', () => {
    expect(visionCacheKey(null)).toBe('')
    expect(visionCacheKey(V)).toBe(`vision:vision:${VISION_PROMPT_VERSION}:400`)
    expect(visionCacheKey({ ...V, model: 'other' })).not.toBe(visionCacheKey(V))
    expect(visionCacheKey({ ...V, maxTokens: 300 })).not.toBe(visionCacheKey(V))
  })
})

describe('visionRequestBody', () => {
  it('картинка — data:-адресом, запрос и выборка Qwen', () => {
    const b = JSON.parse(visionRequestBody(V, 'image/png', Buffer.from('PNGDATA')))
    expect(b).toMatchObject({ model: 'vision', max_tokens: 400, temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 })
    expect(b.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}` } })
    expect(b.messages[0].content[1]).toEqual({ type: 'text', text: VISION_PROMPT })
  })
})

describe('createDescriber', () => {
  let dir: string
  let png: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vision-test-'))
    png = join(dir, 'input.png')
    await writeFile(png, Buffer.from('PNGBYTES'))
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('POST на /chat/completions с ключом, без перенаправлений; ответ — описание', async () => {
    const fetchFn = vi.fn(async () => okResponse('Снимок экрана CRM.'))
    const d = createDescriber(V, fetchFn as unknown as typeof fetch)
    expect(await d(png, 'png', new AbortController().signal)).toBe('Снимок экрана CRM.')
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://vision:8080/v1/chat/completions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${V.apiKey}`)
    expect(JSON.parse(init.body as string).messages[0].content[0].image_url.url).toBe(`data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`)
  })
  it('формат не из VISION_MIME (tiff, bmp) — null без запроса', async () => {
    const fetchFn = vi.fn()
    const d = createDescriber(V, fetchFn as unknown as typeof fetch)
    for (const ext of ['tif', 'tiff', 'bmp']) expect(await d(png, ext, new AbortController().signal)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(Object.keys(VISION_MIME).sort()).toEqual(['jpeg', 'jpg', 'png', 'webp'])
  })
  it('HTTP-ошибка — null и причина http_<код>', async () => {
    const onFail = vi.fn()
    const d = createDescriber(V, (async () => new Response('x', { status: 503 })) as unknown as typeof fetch, onFail)
    expect(await d(png, 'png', new AbortController().signal)).toBeNull()
    expect(onFail).toHaveBeenCalledWith('http_503')
  })
  it('не JSON — bad_response; пустой ответ — empty', async () => {
    const onFail = vi.fn()
    const bad = createDescriber(V, (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch, onFail)
    expect(await bad(png, 'png', new AbortController().signal)).toBeNull()
    expect(onFail).toHaveBeenLastCalledWith('bad_response')
    const empty = createDescriber(V, (async () => okResponse('  ')) as unknown as typeof fetch, onFail)
    expect(await empty(png, 'png', new AbortController().signal)).toBeNull()
    expect(onFail).toHaveBeenLastCalledWith('empty')
  })
  it('свой таймаут — null и timeout, а не зависание', async () => {
    const onFail = vi.fn()
    // Как настоящий fetch: уже отменённый сигнал — отказ сразу, иначе — по событию abort.
    const hang = (async (_u: string, init: RequestInit) => new Promise((_, reject) => {
      if (init.signal!.aborted) reject(new Error('aborted'))
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    const d = createDescriber({ ...V, timeoutMs: 30 }, hang, onFail)
    expect(await d(png, 'png', new AbortController().signal)).toBeNull()
    expect(onFail).toHaveBeenCalledWith('timeout')
  })
  it('отмена разбора снаружи — null и aborted', async () => {
    const onFail = vi.fn()
    // Как настоящий fetch: уже отменённый сигнал — отказ сразу, иначе — по событию abort.
    const hang = (async (_u: string, init: RequestInit) => new Promise((_, reject) => {
      if (init.signal!.aborted) reject(new Error('aborted'))
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    const outer = new AbortController()
    const p = createDescriber(V, hang, onFail)(png, 'png', outer.signal)
    outer.abort()
    expect(await p).toBeNull()
    expect(onFail).toHaveBeenCalledWith('aborted')
  })
  it('сеть недоступна — null и network', async () => {
    const onFail = vi.fn()
    const d = createDescriber(V, (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch, onFail)
    expect(await d(png, 'png', new AbortController().signal)).toBeNull()
    expect(onFail).toHaveBeenCalledWith('network')
  })
})
