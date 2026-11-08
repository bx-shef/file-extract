// Проверка и пересборка HTML перед LibreOffice (POST /v1/convert). Чистые функции.
//
// Проверка по регулярным выражениям видит не тот текст, что LibreOffice: `>` внутри значения в
// кавычках, `<img/src=…>`, повтор атрибута, комментарий `--!>` разбираются по-разному, и любое
// расхождение — обход проверки. Поэтому HTML разбирается один раз линейным сканером (теги с
// кавычками, комментарии, `<style>`), проверяется и собирается заново: LibreOffice получает только
// то, что проверено, в одной записи — имена в нижнем регистре, значения в двойных кавычках, `<` в
// тексте как `&lt;`; комментарии, `<?…>`, `<![CDATA[` и повторы атрибута (действует первый, как в
// HTML5 и в LibreOffice) отбрасываются. Сущности в тексте и значениях остаются как написаны.
// Ссылок-кликов в документе нет (решение владельца 2026-11-08): `<a>` собирается обычным текстом —
// содержимое остаётся, тег и `href` выбрасываются, для любых схем; `href` на других тегах — тоже.
// Картинки: LibreOffice определяет формат по байтам, а не по метке MIME (svg под меткой png он
// читает как вектор, а тот ссылается на локальные файлы), поэтому data: проверяется по содержимому.

import { imageSize, MAX_IMAGE_PIXELS } from './imageSize.ts'

/** Чистый HTML для LibreOffice или причина отказа (для модели, без содержимого документа). */
export type HtmlCheck = { ok: true, html: string } | { ok: false, reason: string }

/** Отказ внутри разбора; текст — причина, которую увидит вызывающий. */
class Unsafe extends Error {}

const UNCLOSED = 'не закрыт тег, комментарий или кавычка'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g
const stripControls = (s: string): string => s.replace(CONTROL, '')

const NAMED = new Map<string, string>([
  ['colon', ':'], ['sol', '/'], ['bsol', '\\'], ['lpar', '('], ['rpar', ')'], ['period', '.'],
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['tab', '\t'],
  ['newline', '\n'], ['num', '#'], ['commat', '@']
])

/**
 * Привести HTML к виду для проверки: раскодировать сущности (`&#x66;`, `&#102;`, `&colon;`…) и
 * CSS-экранирование (`\66 `, `\/`), убрать переносы внутри экранов. Раскодирование с запасом —
 * глубже и шире, чем у LibreOffice: проверка видит не меньше него. Чистая.
 */
export function normalizeHtml(html: string): string {
  let s = html
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/&#(\d{1,7});?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
      .replace(/&([a-z]+);/gi, (m, n: string) => NAMED.get(n.toLowerCase()) ?? m)
      .replace(/\\\r?\n/g, '')
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/\\(.)/g, '$1')
    if (s === before) break
  }
  return stripControls(s)
}

/** Атрибуты-адреса: значение — только data:image (см. `imageProblem`). */
const URL_ATTRS = new Set(['src', 'lowsrc', 'dynsrc', 'background', 'poster', 'data', 'codebase', 'longdesc', 'usemap', 'action', 'formaction', 'xlink:href'])

const DENY_TAGS = /<\s*(iframe|object|embed|frame|frameset|applet|link|base|script|svg|math|form|input|isindex|xml|import)\b/i
const URL_TOKEN = /url\s*\(\s*["']?\s*([^"')\s]*)/gi
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif);base64,([A-Za-z0-9+/]+={0,2})$/i
const TAG_NAME = /^[A-Za-z][A-Za-z0-9:_-]*$/
const ATTR_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/
const COMMENT_END = /--!?>/g
const STYLE_END = /<\/style(?=[\s/>])/gi
const CSS_BAD_LT = /<(?!!--)/

/** Картинки документа в сумме: пикселей уже учтено. */
interface Budget { pixels: number }

/** Размеры PNG (первый чанк IHDR), JPEG (SOF) или GIF (экран) по заголовку; другой формат — null. */
function rasterSize(b: Buffer): { width: number, height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return b.readUInt32BE(8) === 13 && b.readUInt32BE(12) === 0x49484452
      ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
      : null
  }
  if (b.length >= 3 && b.readUIntBE(0, 3) === 0xffd8ff) return imageSize(b)
  const gif = b.length >= 10 ? b.toString('latin1', 0, 6) : ''
  if (gif === 'GIF87a' || gif === 'GIF89a') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  return null
}

/**
 * Адрес картинки: только `data:image/png|jpeg|gif;base64,` и чистый base64. LibreOffice берёт формат
 * из байтов и терпит мусор в base64, поэтому проверяется сама запись: без пробелов и параметров,
 * сигнатура PNG/JPEG/GIF, размеры из заголовка; на весь документ — не больше `MAX_IMAGE_PIXELS`
 * (потолок разбора OCR). Возвращает причину отказа или null.
 */
function imageProblem(url: string, budget: Budget): string | null {
  const m = DATA_IMAGE.exec(url)
  if (!m) return 'нужен адрес data:image/png, jpeg или gif в base64 без пробелов (путь к файлу, svg и прочее нельзя)'
  const payload = m[1] as string
  if (payload.length % 4 !== 0) return 'base64 картинки повреждён'
  const size = rasterSize(Buffer.from(payload, 'base64'))
  if (!size || size.width < 1 || size.height < 1) return 'это не PNG, JPEG или GIF (формат определяется по содержимому, а не по метке)'
  budget.pixels += size.width * size.height
  if (budget.pixels > MAX_IMAGE_PIXELS) return `картинки в документе больше ${MAX_IMAGE_PIXELS} пикселей`
  return null
}

/**
 * `url(…)` в стилях — только картинки data:, записанные как есть. Каждый адрес из сырого текста
 * проверен; в раскодированном их столько же — иначе какой-то записан сущностями или CSS-экранами,
 * и LibreOffice прочёл бы его иначе, чем проверка (он терпит мусор в base64 и не знает части сущностей).
 */
function checkCssUrls(s: string, norm: string, budget: Budget): void {
  let raw = 0
  for (const m of s.matchAll(URL_TOKEN)) {
    const problem = imageProblem(m[1] ?? '', budget)
    if (problem) throw new Unsafe(`url() в стиле: ${problem}`)
    raw++
  }
  const decoded = Array.from(norm.matchAll(URL_TOKEN)).length
  if (decoded !== raw) throw new Unsafe('url() в стиле записан сущностями или CSS-экранами (пишите адрес как есть)')
}

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const isNameEnd = (c: number): boolean => isWs(c) || c === 0x2f || c === 0x3e
const isAttrEnd = (c: number): boolean => isNameEnd(c) || c === 0x3d
const GT = 0x3e
const SLASH = 0x2f
const BANG = 0x21
const QUESTION = 0x3f

interface Tag { name: string, attrs: Array<[string, string | null]>, end: number }

/**
 * Прочитать тег, начиная с первого знака имени. Как в HTML5: `/` между атрибутами — пробел, `>` в
 * кавычках — часть значения, значение без кавычек — до пробела или `>`. Имя тега и атрибута —
 * только простые знаки (иначе отказ): разбор LibreOffice с необычными именами может отличаться.
 * Время линейное: каждый знак читается один раз. Возвращает позицию после `>`.
 */
function readTag(s: string, from: number): Tag {
  const n = s.length
  let q = from
  while (q < n && !isNameEnd(s.charCodeAt(q))) q++
  const name = s.slice(from, q)
  if (!TAG_NAME.test(name)) throw new Unsafe('недопустимое имя тега')
  const attrs: Array<[string, string | null]> = []
  for (;;) {
    while (q < n && (isWs(s.charCodeAt(q)) || s.charCodeAt(q) === SLASH)) q++
    if (q >= n) throw new Unsafe(UNCLOSED)
    if (s.charCodeAt(q) === GT) { q++; break }
    const a = q
    while (q < n && !isAttrEnd(s.charCodeAt(q))) q++
    const attr = s.slice(a, q)
    if (!ATTR_NAME.test(attr)) throw new Unsafe('недопустимое имя атрибута')
    let r = q
    while (r < n && isWs(s.charCodeAt(r))) r++
    if (s.charCodeAt(r) !== 0x3d) { attrs.push([attr.toLowerCase(), null]); continue }
    r++
    while (r < n && isWs(s.charCodeAt(r))) r++
    const quote = s[r]
    if (quote === '"' || quote === "'") {
      const close = s.indexOf(quote, r + 1)
      if (close < 0) throw new Unsafe(UNCLOSED)
      attrs.push([attr.toLowerCase(), s.slice(r + 1, close)])
      q = close + 1
    } else {
      let e = r
      while (e < n && !isWs(s.charCodeAt(e)) && s.charCodeAt(e) !== GT) e++
      attrs.push([attr.toLowerCase(), s.slice(r, e)])
      q = e
    }
  }
  return { name: name.toLowerCase(), attrs, end: q }
}

const ESCAPES: Record<string, string> = { '"': '&quot;', '<': '&lt;', '>': '&gt;' }

/** Проверить атрибуты начального тега и собрать его заново. */
function startTag(t: Tag, budget: Budget): string {
  if (t.name === 'meta') {
    const only = t.attrs.length === 1 ? t.attrs[0] : undefined
    if (!only || only[0] !== 'charset' || only[1] === null || normalizeHtml(only[1]).toLowerCase() !== 'utf-8') {
      throw new Unsafe('тег meta (кроме charset="utf-8")')
    }
    return '<meta charset="utf-8">'
  }
  const seen = new Set<string>()
  let out = '<' + t.name
  for (const [name, value] of t.attrs) {
    if (seen.has(name)) continue
    seen.add(name)
    if (name === 'href') continue // ссылок-кликов нет
    // Фон картинкой LibreOffice мостит на всю страницу: PNG 1×1 в <body background> — миллионы вставок и
    // десятки секунд сборки на страницу (замер 08.11). Фона в документе нет: картинки — только <img src>.
    if (name === 'background') throw new Unsafe('background: фон картинкой не поддерживается, картинка — только <img src>')
    if (value === null) { out += ' ' + name; continue }
    if (URL_ATTRS.has(name)) {
      const problem = imageProblem(value, budget)
      if (problem) throw new Unsafe(`${name}: ${problem}`)
    }
    out += ` ${name}="${value.replace(/["<>]/g, c => ESCAPES[c] as string)}"`
  }
  return out + '>'
}

/** Позиция после ближайшего `>`; нет `>` — отказ. */
function closeOf(s: string, from: number): number {
  const gt = s.indexOf('>', from)
  if (gt < 0) throw new Unsafe(UNCLOSED)
  return gt + 1
}

/** Один проход: проверить теги и собрать HTML заново. */
function scan(s: string, budget: Budget): string {
  const n = s.length
  let out = ''
  let i = 0
  let text = 0 // начало текста, ещё не вынесенного в out
  const flush = (to: number): void => {
    if (to > text) out += s.slice(text, to).replaceAll('<', '&lt;')
  }
  const skipTo = (to: number): void => { i = text = to }
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) break
    const c = s.charCodeAt(lt + 1)
    if (isAlpha(c)) {
      flush(lt)
      const t = readTag(s, lt + 1)
      skipTo(t.end)
      if (t.name !== 'a') out += startTag(t, budget) // `<a>` — текстом: тега нет, содержимое остаётся
      if (t.name === 'style') {
        // Содержимое — сырой текст до `</style`; `<` в нём (кроме `<!--`) — отказ: так LibreOffice
        // не увидит тег там, где его не увидела проверка.
        STYLE_END.lastIndex = i
        const end = STYLE_END.exec(s)
        const css = s.slice(i, end ? end.index : n)
        if (CSS_BAD_LT.test(css)) throw new Unsafe('в <style> нельзя "<" (кроме <!--)')
        out += css + '</style>'
        skipTo(end ? readTag(s, end.index + 2).end : n)
      }
    } else if (c === SLASH) {
      const c2 = s.charCodeAt(lt + 2)
      if (isAlpha(c2)) {
        flush(lt)
        const t = readTag(s, lt + 2)
        skipTo(t.end)
        if (t.name !== 'a') out += `</${t.name}>`
      } else if (Number.isNaN(c2)) {
        i = lt + 1 // `</` в конце — обычный текст
      } else {
        flush(lt)
        skipTo(closeOf(s, lt + 2)) // `</>`, `</ x>` — до первого `>`
      }
    } else if (c === BANG) {
      flush(lt)
      if (s.startsWith('<!--', lt)) {
        // HTML5: `<!-->` и `<!--->` — пустые комментарии, иначе до `-->` или `--!>`
        if (s.charCodeAt(lt + 4) === GT) skipTo(lt + 5)
        else if (s.startsWith('->', lt + 4)) skipTo(lt + 6)
        else {
          COMMENT_END.lastIndex = lt + 4
          const end = COMMENT_END.exec(s)
          if (!end) throw new Unsafe(UNCLOSED)
          skipTo(end.index + end[0].length)
        }
      } else if (s.slice(lt + 2, lt + 9).toLowerCase() === 'doctype') {
        skipTo(closeOf(s, lt + 9))
        out += '<!DOCTYPE html>'
      } else {
        skipTo(closeOf(s, lt + 2)) // `<![CDATA[`, `<!ELEMENT` — до первого `>`
      }
    } else if (c === QUESTION) {
      flush(lt)
      skipTo(closeOf(s, lt + 2))
    } else {
      i = lt + 1 // `<` не начинает тег — обычный текст
    }
  }
  flush(n)
  return out
}

/**
 * Проверить HTML и собрать его заново для LibreOffice. Разрешено: текст, таблицы, стили в
 * `<style>`/`style=`, картинки `data:image/png|jpeg|gif` (по сигнатуре и размерам). Ссылки —
 * текстом: `<a>` и `href` в результат не попадают, при любой схеме. Отказ (с причиной): вложенные
 * документы и активное (iframe/object/embed/frame/applet/link/base/script/svg/math/form…),
 * `<meta>` кроме `charset="utf-8"`, `@import`, адрес не data:image в src и подобных атрибутах,
 * `url()` не с картинкой data:, необычные имена тегов и атрибутов, незакрытые теги и кавычки.
 * Сущности и CSS-экраны для решения раскодируются с запасом (normalizeHtml). Кодировку проверяет
 * вызывающий (только UTF-8 без BOM). Чистая.
 */
export function checkHtml(html: string): HtmlCheck {
  try {
    const s = stripControls(html)
    const norm = normalizeHtml(s)
    if (DENY_TAGS.test(norm)) throw new Unsafe('вложенный документ, форма или скрипт')
    if (/@import/i.test(norm)) throw new Unsafe('внешний стиль (@import)')
    const budget: Budget = { pixels: 0 }
    checkCssUrls(s, norm, budget)
    return { ok: true, html: scan(s, budget) }
  } catch (e) {
    if (e instanceof Unsafe) return { ok: false, reason: e.message }
    throw e
  }
}

/** Причина отказа или null, если HTML можно собирать. Чистая. */
export function unsafeHtml(html: string): string | null {
  const r = checkHtml(html)
  return r.ok ? null : r.reason
}
