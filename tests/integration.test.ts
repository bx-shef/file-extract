// Интеграционный тест на НАСТОЯЩИХ программах (libreoffice, pdftotext). В CI их нет — тест
// пропускается; локально и в образе — гоняется. Файлы делает сам LibreOffice во временном каталоге.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { liveExtractRunners } from '../src/extractRunners.ts'
import { extractText } from '../src/textExtract.ts'

const has = (bin: string): boolean => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0
const ready = has('soffice') && has('pdftotext')

const FODS = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:body><office:spreadsheet>
<table:table table:name="Товары"><table:table-row><table:table-cell office:value-type="string"><text:p>Гвоздь</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="12.5"><text:p>12.5</text:p></table:table-cell></table:table-row></table:table>
<table:table table:name="Приложение"><table:table-row><table:table-cell office:value-type="string"><text:p>Шуруп</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document>`

const TEXT = 'Счёт №17 от ООО «Ромашка», поставка гвоздей и шурупов на сумму 1500 рублей.'

describe.skipIf(!ready)('настоящие программы разбора', () => {
  let dir: string
  const signal = new AbortController().signal
  const convert = (src: string, to: string): void => {
    execFileSync('soffice', ['-env:UserInstallation=file://' + join(dir, 'prof'), '--headless', '--convert-to', to, '--outdir', dir, src],
      { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: dir, LANG: 'C.UTF-8' } })
  }
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fe-int-'))
    await writeFile(join(dir, 'src.txt'), TEXT)
    await writeFile(join(dir, 'book.fods'), FODS)
    convert(join(dir, 'src.txt'), 'docx:MS Word 2007 XML')
    convert(join(dir, 'src.txt'), 'pdf')
    convert(join(dir, 'book.fods'), 'xlsx')
  }, 180_000)
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  const sofficeLeft = (): number => Number(spawnSync('sh', ['-c', 'pgrep -c soffice.bin || true']).stdout.toString().trim() || 0)

  it('txt в windows-1251', async () => {
    const p = join(dir, 'cp.txt')
    await writeFile(p, Buffer.from([...TEXT].map((c) => {
      const code = c.charCodeAt(0)
      if (code < 128) return code
      if (c === 'ё') return 0xb8
      if (c === '№') return 0xb9
      if (c === '«') return 0xab
      if (c === '»') return 0xbb
      return code - 0x350 // А-Я и а-я (U+0410…U+044F) → 0xC0…0xFF в windows-1251
    })))
    const r = await extractText(p, 'счёт.txt', liveExtractRunners, signal)
    expect(r.text).toBe(TEXT)
  })
  it('docx', async () => {
    const r = await extractText(join(dir, 'src.docx'), 'счёт.docx', liveExtractRunners, signal)
    expect(r.text).toContain('Ромашка')
    expect(sofficeLeft()).toBe(0)
  }, 120_000)
  it('xlsx с двумя листами с кириллицей в именах — по порядку книги', async () => {
    const r = await extractText(join(dir, 'book.xlsx'), 'прайс.xlsx', liveExtractRunners, signal)
    expect(r.sheets.map(s => s.name)).toEqual(['Товары', 'Приложение'])
    expect(r.sheets[0]!.csv).toContain('Гвоздь')
    expect(r.sheets[0]!.csv).toContain('12.5')
    expect(r.sheets[1]!.csv).toContain('Шуруп')
    expect(sofficeLeft()).toBe(0)
  }, 120_000)
  it('pdf с текстом', async () => {
    expect((await readFile(join(dir, 'src.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
    const r = await extractText(join(dir, 'src.pdf'), 'счёт.pdf', liveExtractRunners, signal)
    expect(r.ocr).toBe(false)
    expect(r.text).toContain('Ромашка')
  }, 60_000)
})
