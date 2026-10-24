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
