import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Limiter } from '../src/limiter.ts'
import {
  composeImageText, createDescriber, cutText, MAX_DESCRIPTION_CHARS, MAX_RESPONSE_BYTES, parseDescription, VISION_FORMATS,
  VISION_MAX_QUEUE, VISION_PROMPT, VISION_PROMPT_VERSION, visionCacheable, visionCacheKey, visionRequestBody, type VisionConfig
} from '../src/vision.ts'
import { gifHeader, pngHeader } from './imageFixtures.ts'

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
  it('без управляющих символов C0/C1 и знаков направления текста (ревью #30)', () => {
    const content = 'Счёт\u0000 №5\u202E лицевой\u2066 счёт\u200F\u0085 на\uFEFF 100 BYN'
    expect(parseDescription({ choices: [{ message: { content } }] })).toBe('Счёт №5 лицевой счёт на 100 BYN')
  })
})

describe('cutText', () => {
  it('эмодзи на границе не рвётся: без половины суррогатной пары', () => {
    expect(cutText('ab😀', 3)).toBe('ab')
    expect(cutText('ab😀', 4)).toBe('ab😀')
    expect(cutText('abc', 2)).toBe('ab')
  })
})

describe('VISION_FORMATS и запрос', () => {
  it('ровно PNG, JPEG, WEBP — с их MIME', () => {
    expect(VISION_FORMATS).toEqual({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' })
  })
  it('запрос привязан к версии: сменил VISION_PROMPT или выборку (temperature, top_p…) — подними VISION_PROMPT_VERSION (она в ключе кеша) и обнови хеш', () => {
    expect([VISION_PROMPT_VERSION, createHash('sha256').update(visionRequestBody(V, 'image/png', Buffer.alloc(0))).digest('hex').slice(0, 16)]).toEqual(['v1', 'd9b415532ed1f7f4'])
  })
})

describe('visionCacheable', () => {
  it('описание, без зрения, отказ по формату и размеру — в кеш; таймаут, сеть, занято, пусто — нет', () => {
    expect([null, { description: 'x' }, { failure: 'unsupported' }, { failure: 'too_large' }].map(o => visionCacheable(o as never))).toEqual([true, true, true, true])
    expect(['timeout', 'aborted', 'network', 'busy', 'empty', 'bad_response', 'http_503'].map(f => visionCacheable({ failure: f } as never))).toEqual(Array(7).fill(false))
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
  const png = pngHeader(10, 10)
  const signal = (): AbortSignal => new AbortController().signal
  /** Как настоящий fetch: уже отменённый сигнал — отказ сразу, иначе — по событию abort. */
  const hang = (async (_u: string, init: RequestInit) => new Promise((_, reject) => {
    if (init.signal!.aborted) reject(new Error('aborted'))
    init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
  })) as unknown as typeof fetch
  const fetchOf = (f: (...a: never[]) => unknown): typeof fetch => f as unknown as typeof fetch

  it('POST на /chat/completions с ключом, без перенаправлений; ответ — описание', async () => {
    const fetchFn = vi.fn(async () => okResponse('Снимок экрана CRM.'))
    const d = createDescriber(V, { fetchFn: fetchOf(fetchFn) })
    expect(await d(png, signal())).toEqual({ description: 'Снимок экрана CRM.' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://vision:8080/v1/chat/completions')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${V.apiKey}`)
    expect(JSON.parse(init.body as string).messages[0].content[0].image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`)
  })
  it('формат по байтам: GIF, BMP и мусор под именем .png — unsupported без запроса; больше 50 Мпикс — too_large без запроса', async () => {
    const fetchFn = vi.fn()
    const onFail = vi.fn()
    const d = createDescriber(V, { fetchFn: fetchOf(fetchFn), onFail })
    const bmp = Buffer.alloc(26); bmp.write('BM', 0, 'latin1'); bmp.writeUInt32LE(10, 18); bmp.writeInt32LE(10, 22)
    for (const b of [gifHeader(10, 10), bmp, Buffer.from('не картинка'), png.subarray(0, 12)]) expect(await d(b, signal())).toEqual({ failure: 'unsupported' })
    expect(await d(pngHeader(10_000, 10_000), signal())).toEqual({ failure: 'too_large' })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(onFail).not.toHaveBeenCalled() // формат и размер — не тревога для журнала
  })
  it('разбор уже отменён — aborted без запроса', async () => {
    const fetchFn = vi.fn()
    const ac = new AbortController(); ac.abort()
    expect(await createDescriber(V, { fetchFn: fetchOf(fetchFn) })(png, ac.signal)).toEqual({ failure: 'aborted' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('очередь зрения занята дольше её ожидания — busy без запроса', async () => {
    const limiter = new Limiter(1, 30)
    await limiter.acquire()
    const fetchFn = vi.fn()
    expect(await createDescriber(V, { fetchFn: fetchOf(fetchFn), limiter })(png, signal())).toEqual({ failure: 'busy' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('HTTP-ошибка — http_<код>', async () => {
    const d = createDescriber(V, { fetchFn: fetchOf(async () => new Response('x', { status: 503 })) })
    expect(await d(png, signal())).toEqual({ failure: 'http_503' })
  })
  it('не JSON — bad_response; пустой ответ — empty', async () => {
    expect(await createDescriber(V, { fetchFn: fetchOf(async () => new Response('not json', { status: 200 })) })(png, signal())).toEqual({ failure: 'bad_response' })
    expect(await createDescriber(V, { fetchFn: fetchOf(async () => okResponse('  ')) })(png, signal())).toEqual({ failure: 'empty' })
  })
  it('ответ больше MAX_RESPONSE_BYTES — bad_response, дальше не читаем', async () => {
    const big = JSON.stringify({ choices: [{ message: { content: 'я'.repeat(MAX_RESPONSE_BYTES) } }] })
    expect(await createDescriber(V, { fetchFn: fetchOf(async () => new Response(big, { status: 200 })) })(png, signal())).toEqual({ failure: 'bad_response' })
    const declared = new Response('{}', { status: 200, headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) } })
    expect(await createDescriber(V, { fetchFn: fetchOf(async () => declared) })(png, signal())).toEqual({ failure: 'bad_response' })
  })
  it('свой таймаут — timeout, а не зависание; и когда модель молчит посреди ответа', async () => {
    expect(await createDescriber({ ...V, timeoutMs: 30 }, { fetchFn: hang })(png, signal())).toEqual({ failure: 'timeout' })
    // Заголовки пришли, тело — нет: как у настоящего fetch, отмена рвёт поток тела
    const stalled = fetchOf(async (_u: string, init: RequestInit) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"choi'))
        init.signal!.addEventListener('abort', () => c.error(new Error('aborted')))
      }
    }), { status: 200 }))
    expect(await createDescriber({ ...V, timeoutMs: 30 }, { fetchFn: stalled })(png, signal())).toEqual({ failure: 'timeout' })
  })
  it('отмена разбора снаружи — aborted', async () => {
    const onFail = vi.fn()
    const outer = new AbortController()
    const p = createDescriber(V, { fetchFn: hang, onFail })(png, outer.signal)
    outer.abort()
    expect(await p).toEqual({ failure: 'aborted' })
    expect(onFail).not.toHaveBeenCalled() // уход клиента — не сбой зрения
  })
  it('сеть недоступна — network', async () => {
    const d = createDescriber(V, { fetchFn: fetchOf(async () => { throw new TypeError('fetch failed') }) })
    expect(await d(png, signal())).toEqual({ failure: 'network' })
  })
  it('очередь по умолчанию: одна картинка в работе, две ждут, четвёртая — сразу busy без запроса', async () => {
    const outer = new AbortController()
    const fetchFn = vi.fn(hang)
    const d = createDescriber({ ...V, timeoutMs: 5000 }, { fetchFn: fetchFn as unknown as typeof fetch })
    const ps = [1, 2, 3, 4].map(() => d(png, outer.signal))
    expect([VISION_MAX_QUEUE, await ps[3]]).toEqual([2, { failure: 'busy' }])
    outer.abort()
    expect(await Promise.all(ps.slice(0, 3))).toEqual(Array(3).fill({ failure: 'aborted' }))
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('место в очереди зрения отдаётся и после сбоя: следующая картинка идёт сразу', async () => {
    const limiter = new Limiter(1, 30)
    const failing = createDescriber(V, { fetchFn: fetchOf(async () => { throw new TypeError('fetch failed') }), limiter })
    await failing(png, signal())
    expect(limiter.running).toBe(0)
  })
})
