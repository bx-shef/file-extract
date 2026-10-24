import { describe, expect, it } from 'vitest'
import { checkImagePixels, countRows, hasPdfMagic, isolatedHome, LO_REGISTRY, MAX_PDF_TEXT_PAGES, MAX_SHEET_CSV_BYTES, MAX_OCR_PDF_PAGES, MAX_SHEET_CSVS, officeConvertTarget, orderPdfPageImages, parseOfficeCsvOutputs, parseOfficeCsvSheets, subprocessEnv } from '../src/extractRunners.ts'

describe('officeConvertTarget', () => {
  it('exports spreadsheets as CSV with PINNED tab/UTF-8 options so the grid + prices survive', () => {
    for (const p of ['/tmp/x.xls', '/tmp/x.xlsx', '/tmp/x.ods', '/tmp/x.xlsm', '/tmp/x.fods']) {
      const t = officeConvertTarget(p)
      expect(t.outExt).toBe('csv')
      // TAB field separator (9) — never collides with a decimal comma; UTF-8 (76).
      expect(t.filter).toBe('csv:Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1')
    }
  })

  it('exports text documents with the plain-text filter', () => {
    for (const p of ['/tmp/x.doc', '/tmp/x.docx', '/tmp/x.odt', '/tmp/x.rtf']) {
      expect(officeConvertTarget(p)).toEqual({ filter: 'txt:Text', outExt: 'txt' })
    }
  })

  it('is case-insensitive on the extension', () => {
    expect(officeConvertTarget('/tmp/EXPORT.XLS').outExt).toBe('csv')
  })

  it('picks the filter from the fileName, so a spreadsheet works even from a .bin path', () => {
    // officeToText passes the real fileName (not the extension-less <jobId>.bin on disk).
    expect(officeConvertTarget('Прайс.xls')).toEqual({ filter: 'csv:Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1', outExt: 'csv' })
  })

  it('falls back to the text filter for a name without an extension', () => {
    expect(officeConvertTarget('noext')).toEqual({ filter: 'txt:Text', outExt: 'txt' })
  })
})

describe('parseOfficeCsvOutputs (workbook sheet order)', () => {
  it('keeps multi-sheet paths in the order libreoffice printed (NOT alphabetical)', () => {
    // libreoffice prints sheets in workbook index order; the header sheet «ТТН» must stay
    // first even though it sorts LAST alphabetically.
    const stdout = [
      'convert /tmp/x/f.xls as a Calc document using filter : Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1',
      'Writing sheet ТТН -> /tmp/x/f-ТТН.csv',
      'Writing sheet Приложение -> /tmp/x/f-Приложение.csv',
      'Writing sheet ИнформационныйЛист -> /tmp/x/f-ИнформационныйЛист.csv'
    ].join('\n')
    expect(parseOfficeCsvOutputs(stdout, '/tmp/x')).toEqual([
      '/tmp/x/f-ТТН.csv', '/tmp/x/f-Приложение.csv', '/tmp/x/f-ИнформационныйЛист.csv'
    ])
  })

  it('parses the single-sheet "convert … -> …csv using filter :…" line shape', () => {
    const stdout = 'convert /tmp/x/f.xls -> /tmp/x/f.csv using filter : Text - txt - csv (StarCalc):9,34,76'
    expect(parseOfficeCsvOutputs(stdout, '/tmp/x')).toEqual(['/tmp/x/f.csv'])
  })

  it('handles a sheet name with spaces and ignores non-csv / noise lines', () => {
    const stdout = [
      'Warning: failed to launch javaldx',
      'Writing sheet Лист 1 -> /tmp/x/f-Лист 1.csv',
      'some unrelated -> /tmp/x/thing.txt'
    ].join('\n')
    expect(parseOfficeCsvOutputs(stdout, '/tmp/x')).toEqual(['/tmp/x/f-Лист 1.csv'])
  })

  it('returns [] when nothing matches (caller falls back to readdir/base file)', () => {
    expect(parseOfficeCsvOutputs('nothing here\njust logs', '/tmp/x')).toEqual([])
  })
})

describe('orderPdfPageImages (scanned-PDF OCR page order)', () => {
  it('sorts by NUMERIC page index, not lexicographically (p-2 before p-10)', () => {
    expect(orderPdfPageImages(['p-10.png', 'p-2.png', 'p-1.png', 'p-11.png']))
      .toEqual(['p-1.png', 'p-2.png', 'p-10.png', 'p-11.png'])
  })
  it('drops non-png and unnumbered names', () => {
    expect(orderPdfPageImages(['p-1.png', 'notes.txt', 'cover.png', 'p-2.png']))
      .toEqual(['p-1.png', 'p-2.png'])
  })
  it('handles zero-padded pdftoppm names', () => {
    expect(orderPdfPageImages(['p-03.png', 'p-01.png', 'p-02.png']))
      .toEqual(['p-01.png', 'p-02.png', 'p-03.png'])
  })
})

describe('hasPdfMagic (scanned-PDF sniff)', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  it('detects %PDF- at offset 0', () => {
    expect(hasPdfMagic(enc('%PDF-1.7\n...'))).toBe(true)
  })
  it('detects %PDF- after leading junk (spec allows up to ~1KiB)', () => {
    expect(hasPdfMagic(enc('﻿   garbage bytes here %PDF-1.4'))).toBe(true)
  })
  it('rejects a PNG header and short buffers', () => {
    expect(hasPdfMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
    expect(hasPdfMagic(enc('JVBER'))).toBe(false) // base64-of-PDF is NOT a raw PDF
  })
})

describe('subprocessEnv (secret-free env for extraction binaries)', () => {
  it('passes only the allow-list, dropping backend secrets', () => {
    const out = subprocessEnv({
      PATH: '/usr/bin', HOME: '/root', LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '2',
      EXTRACT_API_KEY: 'secret-key', REDIS_URL: 'redis://secret', RANDOM: 'x'
    })
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/root', LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '2' })
    expect(out.EXTRACT_API_KEY).toBeUndefined()
    expect(out.REDIS_URL).toBeUndefined()
  })
  it('skips empty/undefined values and applies extra overrides', () => {
    const out = subprocessEnv({ PATH: '/bin', LANG: '' }, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    expect(out).toEqual({ PATH: '/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
  })
  it('drops an empty OMP_THREAD_LIMIT (no accidental empty thread cap)', () => {
    const out = subprocessEnv({ PATH: '/bin', OMP_THREAD_LIMIT: '', OMP_NUM_THREADS: '2' })
    expect('OMP_THREAD_LIMIT' in out).toBe(false)
    expect(out.OMP_NUM_THREADS).toBe('2')
  })
})

describe('parseOfficeCsvSheets (имена листов)', () => {
  it('берёт имя из «Writing sheet», а для одного листа — из имени файла', () => {
    expect(parseOfficeCsvSheets('Writing sheet Лист 1 -> /tmp/x/f-Лист 1.csv', '/tmp/x')).toEqual([{ name: 'Лист 1', path: '/tmp/x/f-Лист 1.csv' }])
    expect(parseOfficeCsvSheets('convert /tmp/x/f.xls -> /tmp/x/f.csv using filter : x', '/tmp/x')).toEqual([{ name: 'f', path: '/tmp/x/f.csv' }])
  })
  it('путь вне своего каталога отбрасывается', () => {
    const stdout = [
      'Writing sheet a -> /etc/x.csv',
      'Writing sheet b -> /tmp/x/../y/f.csv',
      'Writing sheet c -> /tmp/xx/f.csv',
      'Writing sheet d -> /tmp/x/ok.csv'
    ].join('\n')
    expect(parseOfficeCsvSheets(stdout, '/tmp/x')).toEqual([{ name: 'd', path: '/tmp/x/ok.csv' }])
  })
  it('«-> » внутри имени листа: путь — по последней стрелке', () => {
    expect(parseOfficeCsvSheets('Writing sheet a -> /etc/x.csv -> /tmp/x/f-a.csv', '/tmp/x'))
      .toEqual([{ name: 'a -> /etc/x.csv', path: '/tmp/x/f-a.csv' }])
  })
})

describe('countRows', () => {
  it('считает только непустые строки', () => {
    expect(countRows('a\tb\n\n  \nc\td\n')).toBe(2)
  })
})

describe('потолки перенесены без смены значений', () => {
  it('64 листа и 30 страниц скана', () => {
    expect(MAX_SHEET_CSVS).toBe(64)
    expect(MAX_OCR_PDF_PAGES).toBe(30)
  })
})

describe('изоляция и бомбы', () => {
  it('HOME, XDG и TMPDIR процесса — рабочий каталог', () => {
    expect(isolatedHome('/w')).toEqual({ HOME: '/w', XDG_CONFIG_HOME: '/w/.config', XDG_CACHE_HOME: '/w/.cache', XDG_DATA_HOME: '/w/.local/share', XDG_RUNTIME_DIR: '/w', TMPDIR: '/w' })
    const env = subprocessEnv({ HOME: '/root', PATH: '/bin' }, isolatedHome('/w'))
    expect(env.HOME).toBe('/w')
  })
  it('профиль LibreOffice: макросы выключены, ссылки и внешние картинки не грузятся', () => {
    expect(LO_REGISTRY).toContain('<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value>')
    expect(LO_REGISTRY).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value>')
    expect(LO_REGISTRY).toContain('<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value>')
    expect(LO_REGISTRY).toMatch(/Office\.Calc\/Content\/Update"><prop oor:name="Link" oor:op="fuse"><value>1</)
    expect(LO_REGISTRY).toMatch(/Office\.Writer\/Content\/Update"><prop oor:name="Link" oor:op="fuse"><value>0</)
  })
  it('картинка больше 50 Мпикс — too_complex до OCR, меньше — проходит', () => {
    const png = (w: number, h: number) => {
      const b = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
      b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
      return b
    }
    expect(() => checkImagePixels(png(10_000, 5_001))).toThrow(expect.objectContaining({ code: 'too_complex' }))
    expect(() => checkImagePixels(png(10_000, 5_000))).not.toThrow()
    expect(() => checkImagePixels(Buffer.from('не картинка'))).not.toThrow()
  })
  it('потолки: страницы pdftotext и размер CSV листа', () => {
    expect(MAX_PDF_TEXT_PAGES).toBe(500)
    expect(MAX_SHEET_CSV_BYTES).toBe(50 * 1024 * 1024)
  })
})
