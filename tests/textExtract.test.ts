import { describe, expect, it, vi } from 'vitest'
import { ExtractError } from '../src/errors.ts'
import { planExtraction, SUPPORTED_EXT } from '../src/formats.ts'
import { extractText, MIN_PDF_TEXT, type ExtractRunners } from '../src/textExtract.ts'

describe('planExtraction', () => {
  it('выбирает способ по расширению без учёта регистра', () => {
    expect(planExtraction('a.PDF').kind).toBe('pdf')
    expect(planExtraction('invoice.xlsx').kind).toBe('office')
    expect(planExtraction('1c-export.xls').kind).toBe('office')
    expect(planExtraction('scan.JPEG').kind).toBe('image')
    expect(planExtraction('data.csv').kind).toBe('text')
    expect(planExtraction('archive.zip').kind).toBe('unsupported')
    expect(planExtraction('noext').kind).toBe('unsupported')
  })
  it('у каждого расширения из SUPPORTED_EXT есть способ разбора', () => {
    for (const e of SUPPORTED_EXT) expect(planExtraction(`f.${e}`).kind).not.toBe('unsupported')
    for (const e of ['txt', 'csv', 'tsv', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'odt', 'ods', 'rtf', 'png', 'jpg']) {
      expect(SUPPORTED_EXT).toContain(e)
    }
  })
})

// Заглушки нарочно длиннее порога читаемости, иначе тест падал бы на пороге, а не на маршруте.
function runners(over: Partial<ExtractRunners> = {}): ExtractRunners {
  return {
    readText: vi.fn(async () => 'TXT: накладная №5, позиций 3'),
    pdfToText: vi.fn(async () => 'PDFTEXT that is long enough to be real content here'),
    officeToText: vi.fn(async () => ({ text: 'OFFICE: прайс поставщика, 12 строк', sheets: [{ name: 'Лист1', csv: 'a\tb', rows: 1 }] })),
    ocr: vi.fn(async () => ({ text: 'OCR: скан счёта на 500 BYN', pages: 2 })),
    ...over
  }
}

describe('extractText', () => {
  it('текст → readText, без OCR', async () => {
    const r = await extractText('/f.txt', 'f.txt', runners())
    expect(r.text).toContain('TXT')
    expect(r).toMatchObject({ kind: 'text', ocr: false, sheets: [] })
  })
  it('office → officeToText с путём и настоящим именем файла, листы доезжают', async () => {
    const r = runners()
    const out = await extractText('/data/abc123.bin', 'Прайс.xls', r)
    expect(out.text).toContain('OFFICE')
    expect(out.sheets).toEqual([{ name: 'Лист1', csv: 'a\tb', rows: 1 }])
    expect(r.officeToText).toHaveBeenCalledWith('/data/abc123.bin', 'Прайс.xls', expect.anything())
  })
  it('картинка → ocr, признак ocr и число страниц', async () => {
    const out = await extractText('/f.png', 'f.png', runners())
    expect(out).toMatchObject({ kind: 'image', ocr: true, pages: 2 })
  })
  it('текстовый PDF → pdfToText, без OCR', async () => {
    const r = runners()
    const out = await extractText('/f.pdf', 'f.pdf', r)
    expect(out.text).toContain('PDFTEXT')
    expect(out.ocr).toBe(false)
    expect(r.ocr).not.toHaveBeenCalled()
  })
  it('скан PDF (почти без текста) → откат на OCR', async () => {
    const r = runners({ pdfToText: vi.fn(async () => '   \n  ') })
    const out = await extractText('/f.pdf', 'f.pdf', r)
    expect(out.text).toContain('OCR')
    expect(out.ocr).toBe(true)
  })
  it('текст PDF ровно на пороге остаётся (не OCR)', async () => {
    const r = runners({ pdfToText: vi.fn(async () => 'x'.repeat(MIN_PDF_TEXT)) })
    await extractText('/f.pdf', 'f.pdf', r)
    expect(r.ocr).not.toHaveBeenCalled()
  })
  it('на знак меньше порога — OCR', async () => {
    const r = runners({ pdfToText: vi.fn(async () => 'x'.repeat(MIN_PDF_TEXT - 1)) })
    await extractText('/f.pdf', 'f.pdf', r)
    expect(r.ocr).toHaveBeenCalled()
  })
  it('неподдерживаемый формат → ExtractError unsupported, без имени файла в тексте', async () => {
    const err = await extractText('/f.zip', 'секрет.zip', runners()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExtractError)
    expect((err as ExtractError).code).toBe('unsupported')
    expect((err as ExtractError).message).not.toContain('секрет')
  })
  it('мусор без читаемого текста → unreadable', async () => {
    const r = runners({ readText: vi.fn(async () => '\u0000\u0001 ab \u0002') })
    await expect(extractText('/f.txt', 'f.txt', r)).rejects.toMatchObject({ code: 'unreadable' })
  })
  it('чистит управляющие символы и в тексте, и в листах', async () => {
    const r = runners({ officeToText: vi.fn(async () => ({ text: 'цена\u0000 100 руб', sheets: [{ name: 'Л\u0007', csv: 'a\u0000\tb', rows: 1 }] })) })
    const out = await extractText('/f.xlsx', 'f.xlsx', r)
    expect(out.text).toBe('цена 100 руб')
    expect(out.sheets[0]).toEqual({ name: 'Л', csv: 'a\tb', rows: 1 })
  })
})
