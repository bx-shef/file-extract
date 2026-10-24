import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBearer } from './auth.ts'
import { cacheKey, type CacheStore } from './cache.ts'
import { CACHE_TTL_SEC, EXTRACTOR_VERSION, type Config } from './config.ts'
import { ExtractError } from './errors.ts'
import { planExtraction } from './formats.ts'
import { Limiter, QueueTimeoutError } from './limiter.ts'
import { shortSha, type Logger } from './log.ts'
import { extractText, type ExtractRunners, type Sheet } from './textExtract.ts'
import { applyTextLimit } from './truncate.ts'

export interface ExtractResponse {
  text: string
  sheets: Sheet[]
  ocr: boolean
  truncated: boolean
  pages?: number
  cached: boolean
  kind: string
  sha256: string
}

export interface AppDeps {
  config: Config
  runners: ExtractRunners
  cache: CacheStore
  log: Logger
  limiter?: Limiter
  now?: () => number
}

/** Ошибка ответа: код для программы, текст для человека. */
class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const EXTRACT_STATUS: Record<ExtractError['code'], [number, string]> = {
  unsupported: [415, 'unsupported'],
  unreadable: [422, 'unreadable'],
  too_complex: [422, 'too_complex'],
  failed: [422, 'extract_failed'],
  timeout: [504, 'timeout']
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store'
  })
  res.end(data)
}

/** Прочитать тело с потолком: превышение — 413 сразу, не дочитывая. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let len = 0
    let failed = false
    req.on('data', (c: Buffer) => {
      if (failed) return
      len += c.length
      if (len > max) {
        failed = true
        reject(new HttpError(413, 'too_large', `файл больше ${max} байт`))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    req.on('error', e => { if (!failed) { failed = true; reject(e) } })
  })
}

/** Имя файла из заголовка. Нелатинские имена приходят закодированными (encodeURIComponent). */
function fileNameFrom(req: IncomingMessage): string {
  const raw = req.headers['x-file-name']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) throw new HttpError(400, 'bad_request', 'нет заголовка X-File-Name')
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

export function createApp(deps: AppDeps): Server {
  const { config, runners, cache, log } = deps
  const limiter = deps.limiter ?? new Limiter(config.maxConcurrency, config.queueTimeoutMs)
  const now = deps.now ?? Date.now

  async function handleExtract(req: IncomingMessage): Promise<ExtractResponse> {
    if (!checkBearer(req.headers.authorization, config.apiKey)) {
      throw new HttpError(401, 'unauthorized', 'неверный или отсутствующий ключ')
    }
    const fileName = fileNameFrom(req)
    const plan = planExtraction(fileName)
    if (plan.kind === 'unsupported') throw new HttpError(415, 'unsupported', 'неподдерживаемый формат файла')
    const declared = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > config.maxFileBytes) {
      throw new HttpError(413, 'too_large', `файл больше ${config.maxFileBytes} байт`)
    }
    const body = await readBody(req, config.maxFileBytes)
    if (body.length === 0) throw new HttpError(400, 'bad_request', 'пустое тело запроса')
    const sha = createHash('sha256').update(body).digest('hex')
    const key = cacheKey(sha, plan.kind, EXTRACTOR_VERSION)

    const hit = await cache.get(key).catch(() => null) // недоступный кеш — не повод отказать
    // испорченная запись кеша (обрыв записи на диск, чужое значение в Redis) — как промах, а не 500 на сутки
    const parsed = hit ? safeParse(hit) : null
    if (parsed) return { ...parsed, cached: true }

    let release: () => void
    try {
      release = await limiter.acquire()
    } catch (e) {
      if (e instanceof QueueTimeoutError) throw new HttpError(503, 'busy', 'сервис занят, повторите позже')
      throw e
    }
    // место в очереди отдаём в finally — и если не создался даже временный каталог
    let dir: string | undefined
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), config.extractTimeoutMs)
    try {
      dir = await mkdtemp(join(tmpdir(), 'file-extract-in-'))
      const input = join(dir, `input.${plan.ext}`)
      await writeFile(input, body, { mode: 0o600 })
      const r = await Promise.race([
        extractText(input, fileName, runners, ac.signal),
        new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new ExtractError('timeout', 'разбор не уложился во время')), { once: true })
        })
      ])
      const lim = applyTextLimit(r.text, r.sheets, config.maxTextChars)
      const out: Omit<ExtractResponse, 'cached'> = {
        text: lim.text,
        sheets: lim.sheets,
        ocr: r.ocr,
        truncated: lim.truncated,
        ...(r.pages !== undefined ? { pages: r.pages } : {}),
        kind: r.kind,
        sha256: sha
      }
      // Кешируется только успех; сбой записи кеша ответ не портит.
      await cache.set(key, JSON.stringify(out), CACHE_TTL_SEC).catch(() => {})
      return { ...out, cached: false }
    } finally {
      clearTimeout(timer)
      ac.abort() // добить дочерние процессы, если разбор ещё что-то держит
      release()
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  function safeParse(raw: string): Omit<ExtractResponse, 'cached'> | null {
    try {
      const v = JSON.parse(raw)
      return v && typeof v.text === 'string' && Array.isArray(v.sheets) ? v : null
    } catch { return null }
  }

  return createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && url === '/health') {
      sendJson(res, 200, { ok: true, version: EXTRACTOR_VERSION })
      return
    }
    if (url !== '/extract') {
      sendJson(res, 404, { error: 'not_found', message: 'нет такого адреса' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'нужен POST' })
      return
    }
    const started = now()
    const kind = planExtraction(String(req.headers['x-file-name'] ?? '')).kind
    handleExtract(req).then((out) => {
      log({ evt: 'extract', kind: out.kind, bytes: Number(req.headers['content-length'] ?? 0), ms: now() - started, sha: shortSha(out.sha256), cached: out.cached })
      sendJson(res, 200, out)
    }).catch((e: unknown) => {
      let status = 500
      let code = 'internal'
      let message = 'внутренняя ошибка'
      if (e instanceof HttpError) {
        status = e.status; code = e.code; message = e.message
      } else if (e instanceof ExtractError) {
        const m = EXTRACT_STATUS[e.code]
        status = m[0]; code = m[1]; message = e.message
      }
      log({ evt: 'extract', kind, ms: now() - started, error: code })
      // На 401/413 тело могло остаться недочитанным: закрываем соединение, а не ждём его.
      if (status === 401 || status === 413) res.setHeader('connection', 'close')
      sendJson(res, status, { error: code, message })
    })
  })
}
