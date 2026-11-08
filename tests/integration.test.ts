// Интеграционный тест на НАСТОЯЩИХ программах (libreoffice, pdftotext). В CI их нет — тест
// пропускается; локально и в образе — гоняется. Файлы делает сам LibreOffice во временном каталоге.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { liveExtractRunners } from '../src/extractRunners.ts'
import { checkHtml } from '../src/htmlGuard.ts'
import { extractText } from '../src/textExtract.ts'
import { dataUrl, png } from './imageFixtures.ts'

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
  it('HTML → PDF и DOCX: кириллица и таблица доходят до файла', async () => {
    const html = join(dir, 'kp.html')
    await writeFile(html, '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Коммерческое предложение</h1><table><tr><td>Гвоздь</td><td>12,50</td></tr></table></body></html>')
    const pdf = await liveExtractRunners.htmlConvert!(html, 'pdf', signal)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    await writeFile(join(dir, 'kp-out.pdf'), pdf)
    expect((await extractText(join(dir, 'kp-out.pdf'), 'kp.pdf', liveExtractRunners, signal)).text).toContain('Гвоздь')
    const docx = await liveExtractRunners.htmlConvert!(html, 'docx', signal)
    expect(docx.subarray(0, 2).toString('latin1')).toBe('PK')
    await writeFile(join(dir, 'kp-out.docx'), docx)
    expect((await extractText(join(dir, 'kp-out.docx'), 'kp.docx', liveExtractRunners, signal)).text).toContain('Коммерческое предложение')
  }, 120_000)

  it('пересборка HTML не меняет документ: текст PDF из исходного и из пересобранного совпадает', async () => {
    const raw = `<!DOCTYPE html>
<HTML lang=ru>
<HEAD><META charset=utf-8><TITLE>КП</TITLE>
<STYLE><!-- body { font-family: "DejaVu Sans", Arial; } th { background: #1e3a8a; color: #fff } --></STYLE>
</HEAD>
<BODY>
<!-- служебный комментарий -->
<H1>Коммерческое предложение № 17</H1>
<P class=lead>Уважаемый клиент!&nbsp;Направляем «предложение»&nbsp;&mdash; всё по <A HREF="https://ex.by/offer" target=_blank>ссылке</A>.<BR/>Вторая строка &amp; конец.</P>
<TABLE border=1 cellpadding=4 width="100%">
<TR><TH>№</TH><TH colspan=2>Наименование</TH><TH>Сумма</TH></TR>
<TR><TD>1</TD><TD bgcolor=#eeeeee colspan=2>Гвоздь 4×100</TD><TD align=right>12,50</TD></TR>
</TABLE>
</BODY></HTML>`
    const checked = checkHtml(raw)
    if (!checked.ok) throw new Error(checked.reason)
    expect(checked.html).not.toContain('служебный')
    expect(checked.html).not.toContain('href')
    const textOf = async (name: string, source: string): Promise<string> => {
      await writeFile(join(dir, `${name}.html`), source)
      await writeFile(join(dir, `${name}.pdf`), await liveExtractRunners.htmlConvert!(join(dir, `${name}.html`), 'pdf', signal))
      return (await extractText(join(dir, `${name}.pdf`), `${name}.pdf`, liveExtractRunners, signal)).text
    }
    const before = await textOf('kp-raw', raw)
    const after = await textOf('kp-clean', checked.html)
    expect(after).toBe(before)
    expect(after).toContain('Гвоздь 4×100')
    expect(after).toContain('ссылке')
    await writeFile(join(dir, 'kp-clean.docx'), await liveExtractRunners.htmlConvert!(join(dir, 'kp-clean.html'), 'docx', signal))
    expect((await extractText(join(dir, 'kp-clean.docx'), 'kp-clean.docx', liveExtractRunners, signal)).text).toContain('Гвоздь 4×100')
    expect(sofficeLeft()).toBe(0)
  }, 180_000)
  it('картинка data:image/png доходит до PDF; svg под меткой png и огромный PNG отклоняются до LibreOffice', async () => {
    const good = checkHtml(`<p>КП</p><img src="${dataUrl('image/png', png(13, 7))}">`)
    if (!good.ok) throw new Error(good.reason)
    await writeFile(join(dir, 'img.html'), good.html)
    await writeFile(join(dir, 'img.pdf'), await liveExtractRunners.htmlConvert!(join(dir, 'img.html'), 'pdf', signal))
    const listed = execFileSync('pdfimages', ['-list', join(dir, 'img.pdf')]).toString().split('\n').slice(2).filter(Boolean)
    expect(listed.map(l => l.trim().split(/\s+/).slice(3, 5).join('x'))).toContain('13x7')

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><image href="file:///etc/passwd" width="9" height="9"/></svg>'
    expect(checkHtml(`<img src="${dataUrl('image/png', svg)}">`)).toMatchObject({ ok: false })
    expect(checkHtml(`<img src="${dataUrl('image/png', png(2, 2).fill(0xff, 16, 24))}">`)).toMatchObject({ ok: false }) // размеры 4 294 967 295 × 4 294 967 295
  }, 120_000)

  it('pdf с текстом', async () => {
    expect((await readFile(join(dir, 'src.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
    const r = await extractText(join(dir, 'src.pdf'), 'счёт.pdf', liveExtractRunners, signal)
    expect(r.ocr).toBe(false)
    expect(r.text).toContain('Ромашка')
  }, 60_000)
})
