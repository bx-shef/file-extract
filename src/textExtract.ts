// Маршрутизация разбора: выбрать способ по расширению и вызвать нужного исполнителя
// (pdftotext / LibreOffice / OCR). Сами процессы и чтение файлов ВНЕДРЯЮТСЯ (ExtractRunners),
// поэтому ядро проверяется тестами на подставных исполнителях.
// Перенесено из ai-price-import без смены смысла; добавлены листы таблиц и число страниц.

import { ExtractError } from './errors.ts'
import { planExtraction, type ExtractKind } from './formats.ts'
import { sanitizeExtractedText } from './textSanitize.ts'

/**
 * Меньше стольких непробельных знаков — PDF считается сканом, и его разбирает OCR.
 * ОГРАНИЧЕНИЕ: решение принимается по всему документу. Смешанный PDF (часть страниц — текст,
 * часть — скан), у которого текстовых страниц уже хватает на порог, считается текстовым, и
 * сканированные страницы молча пропадают. Для типичных документов (целиком текст или целиком
 * скан) этого достаточно; постраничный выбор — если смешанные PDF станут реальной нуждой.
 */
export const MIN_PDF_TEXT = 32

export interface Sheet {
  /** Название листа, как его напечатал LibreOffice. */
  name: string
  /** Содержимое листа: CSV с табуляцией в качестве разделителя, UTF-8. */
  csv: string
  /** Число непустых строк. */
  rows: number
}

export interface OfficeOutput { text: string, sheets: Sheet[] }
export interface OcrOutput { text: string, pages?: number }

export interface ExtractRunners {
  /** Прочитать текстовый файл (windows-1251 или UTF-8). */
  readText: (path: string, signal: AbortSignal) => Promise<string>
  /** pdftotext → текст с сохранением раскладки. */
  pdfToText: (path: string, signal: AbortSignal) => Promise<string>
  /** Office → текст (и листы для таблиц) через LibreOffice. `fileName` с настоящим
   *  расширением выбирает фильтр выгрузки — `path` может быть временным файлом без расширения. */
  officeToText: (path: string, fileName: string, signal: AbortSignal) => Promise<OfficeOutput>
  /** OCR картинки или скана PDF (tesseract rus+bel+kaz+eng). */
  ocr: (path: string, signal: AbortSignal) => Promise<OcrOutput>
  /** HTML → PDF или DOCX через LibreOffice Writer (сборка документов: КП помощника). */
  htmlConvert?: (path: string, to: ConvertTo, signal: AbortSignal) => Promise<Buffer>
}

export type ConvertTo = 'pdf' | 'docx'

/**
 * Привести HTML к виду для проверки: раскодировать сущности (`&#x66;`, `&#102;`, `&colon;`…) и
 * CSS-экранирование (`\66 `, `\/`), убрать переносы внутри экранов. LibreOffice понимает и то и
 * другое, поэтому проверка смотрит на то, что увидит он, а не на сырой текст. Чистая.
 */
export function normalizeHtml(html: string): string {
  const named: Record<string, string> = { colon: ':', sol: '/', bsol: '\\', lpar: '(', rpar: ')', period: '.', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", tab: '\t', newline: '\n', num: '#', commat: '@' }
  let s = html
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/&#(\d{1,7});?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
      .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m)
      .replace(/\\\r?\n/g, '')
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/\\(.)/g, '$1')
    if (s === before) break
  }
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/**
 * HTML, который LibreOffice не должен открывать. Сборке нужны текст, таблицы, стили внутри
 * `<style>`/`style=` и картинки `data:image/…`; всё прочее со ссылками — отказ:
 *  - `src` — только `data:image/(png|jpeg|gif)`; `href` — только `https:`, `mailto:`, `#`;
 *  - `url(` в стилях — только `data:image/…`; `@import` — нет;
 *  - вложенные документы и активное (iframe/object/embed/frame/applet/link/base/script/svg/math/form), любые `<meta>`, кроме
 *    `charset="utf-8"`; команды LibreOffice (`vnd.sun.star`, `macro:`, `.uno:`).
 * Проверяется раскодированный текст (normalizeHtml). Кодировку проверяет вызывающий (только UTF-8 без BOM). Чистая.
 */
export function unsafeHtml(html: string): string | null {
  const s = normalizeHtml(html)
  if (/<\s*(iframe|object|embed|frame|frameset|applet|link|base|script|svg|math|form|input|isindex|xml|import)\b/i.test(s)) return 'вложенный документ, форма или скрипт'
  for (const m of s.matchAll(/<\s*meta\b[^>]*>/gi)) {
    if (!/^<\s*meta\s+charset\s*=\s*["']?utf-8["']?\s*\/?\s*>$/i.test(m[0])) return 'тег meta (кроме charset="utf-8")'
  }
  if (/@import/i.test(s)) return 'внешний стиль (@import)'
  for (const m of s.matchAll(/url\s*\(\s*["']?\s*([^"')\s]*)/gi)) {
    if (!/^data:image\/(png|jpe?g|gif);/i.test(m[1] ?? '')) return 'url() в стиле (кроме картинки data:)'
  }
  const tags = (s.match(/<[^>]*>/g) ?? []).join(' ')
  for (const m of tags.matchAll(/\b(src|lowsrc|dynsrc|background|poster|data|codebase|longdesc|usemap|action|formaction|xlink:href)\s*=\s*(["']?)\s*([^"'\s>]*)/gi)) {
    if (!/^data:image\/(png|jpe?g|gif);/i.test(m[3] ?? '')) return 'путь к файлу в src (картинки — только data:image)'
  }
  for (const m of tags.matchAll(/\bhref\s*=\s*(["']?)\s*([^"'\s>]*)/gi)) {
    if (!/^(https:|mailto:|#)/i.test(m[2] ?? '')) return 'ссылка href (только https:, mailto:, #)'
  }
  return null
}

/** Цель выгрузки HTML: фильтр LibreOffice и тип ответа. Чистая. */
export function convertTarget(to: string): { to: ConvertTo, filter: string, mime: string } | null {
  if (to === 'pdf') return { to, filter: 'pdf:writer_pdf_Export', mime: 'application/pdf' }
  if (to === 'docx') return { to, filter: 'docx:MS Word 2007 XML', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  return null
}

export interface ExtractResult {
  kind: Exclude<ExtractKind, 'unsupported'>
  text: string
  sheets: Sheet[]
  ocr: boolean
  pages?: number
}

/**
 * Разобрать файл. PDF почти без текста считается сканом и уходит в OCR.
 * Неподдерживаемый формат и файл без читаемого текста — ExtractError.
 */
export async function extractText(
  path: string,
  fileName: string,
  runners: ExtractRunners,
  signal: AbortSignal = new AbortController().signal
): Promise<ExtractResult> {
  const raw = await extractRaw(path, fileName, runners, signal)
  return finishText(raw)
}

/**
 * Единая точка очистки. Мусор из чужого файла чистим ЗДЕСЬ, сразу после извлечения, —
 * защита у каждого приёмника означала бы копии правила.
 * ⚠ Файл, от которого после чистки не осталось читаемого, — битый файл, и об этом говорим
 * своими словами, а не отдаём пустой текст.
 */
function finishText(raw: ExtractResult): ExtractResult {
  const { text, readable } = sanitizeExtractedText(raw.text)
  if (!readable) throw new ExtractError('unreadable', 'не удалось прочитать документ: в файле нет читаемого текста')
  const sheets = raw.sheets.map(s => ({ ...s, name: sanitizeExtractedText(s.name).text, csv: sanitizeExtractedText(s.csv).text }))
  return { ...raw, text, sheets }
}

async function extractRaw(path: string, fileName: string, runners: ExtractRunners, signal: AbortSignal): Promise<ExtractResult> {
  const { kind } = planExtraction(fileName)
  switch (kind) {
    case 'text':
      return { kind, text: await runners.readText(path, signal), sheets: [], ocr: false }
    case 'pdf': {
      const text = await runners.pdfToText(path, signal)
      if (text.replace(/\s/g, '').length >= MIN_PDF_TEXT) return { kind, text, sheets: [], ocr: false }
      const o = await runners.ocr(path, signal)
      return withPages({ kind, text: o.text, sheets: [], ocr: true }, o.pages)
    }
    case 'office': {
      const o = await runners.officeToText(path, fileName, signal)
      return { kind, text: o.text, sheets: o.sheets, ocr: false }
    }
    case 'image': {
      const o = await runners.ocr(path, signal)
      return withPages({ kind, text: o.text, sheets: [], ocr: true }, o.pages)
    }
    default:
      throw new ExtractError('unsupported', 'неподдерживаемый формат файла')
  }
}

function withPages(r: ExtractResult, pages: number | undefined): ExtractResult {
  return pages === undefined ? r : { ...r, pages }
}
