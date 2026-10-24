import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { ExtractError } from './errors.ts'
import { imageSize, MAX_IMAGE_PIXELS } from './imageSize.ts'
import type { ExtractRunners, OcrOutput, OfficeOutput, Sheet } from './textExtract.ts'

// Живые исполнители разбора (дочерние процессы). Программы ставятся в образ:
// pdftotext и pdftoppm (poppler-utils), libreoffice, tesseract с языками rus+bel+kaz+eng.
// Перенесено из ai-price-import без смены смысла; добавлены прерывание по сигналу
// (таймаут на файл) и убийство всей группы процессов.
//
// ЗАМЕЧАНИЕ О РАЗВЁРТЫВАНИИ: таймаут ограничивает время, но НЕ пиковую память. Подготовленный
// файл (zip/XML-бомба, картинка огромного размера) может съесть всю память. Контейнер ОБЯЗАН
// запускаться с лимитом памяти (`mem_limit` в compose) — это и есть граница, а не этот код.

/** Потолок на один дочерний процесс (внутри общего таймаута на файл). */
const RUN_TIMEOUT_MS = 90_000

/** Потолок вывода одного процесса: дальше — убиваем, а не копим в памяти. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024

// Минимальное окружение для программ разбора. Они открывают ЧУЖИЕ документы (макросы Office,
// подготовленные PDF), поэтому не должны видеть секретов сервиса — EXTRACT_API_KEY, REDIS_URL.
// Пропускаем только то, что нужно программам для запуска и верного вывода текста.
// Программы поставлены из apt (rpath вкомпилирован) → LD_LIBRARY_PATH не нужен; libreoffice
// без Xvfb → DISPLAY намеренно не передаём.
const SUBPROCESS_ENV_ALLOW = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', // основное + временный каталог
  'LANG', 'LC_ALL', 'LANGUAGE', 'TZ', // локаль (имена файлов в UTF-8, формат чисел)
  'OMP_THREAD_LIMIT', 'OMP_NUM_THREADS', // ограничить потоки tesseract/OpenMP
  'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'TESSDATA_PREFIX' // шрифты libreoffice + данные tesseract
] as const

/** Окружение без секретов: белый список из `full`, затем `extra`.
 *  `extra` НЕ фильтруется — передавать туда только несекретное (локаль, потоки). Чистая. */
export function subprocessEnv(
  full: Record<string, string | undefined>,
  extra?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SUBPROCESS_ENV_ALLOW) {
    const v = full[k]
    if (v != null && v !== '') out[k] = String(v)
  }
  return { ...out, ...extra }
}

/**
 * Окружение «дома» процесса: HOME и каталоги XDG — рабочий каталог разбора. Иначе LibreOffice
 * и fontconfig писали бы кеши и профиль в общий $HOME (у пользователя образа его нет, а на
 * машине разработчика это чужой профиль). Чистая.
 */
export function isolatedHome(dir: string): Record<string, string> {
  return {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_CACHE_HOME: join(dir, '.cache'),
    XDG_DATA_HOME: join(dir, '.local', 'share'),
    XDG_RUNTIME_DIR: dir,
    TMPDIR: dir
  }
}

interface RunOptions {
  /** Рабочий каталог разбора: cwd процесса и его HOME/XDG/TMPDIR. */
  dir: string
  /** Дополнительные несекретные переменные (локаль). */
  env?: Record<string, string>
}

/**
 * Запустить программу и вернуть её stdout. По таймауту процесса или по сигналу прерывания
 * (таймаут на файл, ушедший клиент) убиваем ВСЮ группу процессов: libreoffice порождает
 * soffice.bin, и убийство одного родителя оставило бы ребёнка жить. Группа добивается и при
 * обычном завершении — на случай потомка, пережившего родителя.
 */
function run(bin: string, args: string[], signal: AbortSignal, opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ExtractError('timeout', 'разбор прерван по таймауту'))
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.dir,
      env: subprocessEnv(process.env, { ...isolatedHome(opts.dir), ...opts.env }),
      detached: true
    })
    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let done = false
    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* уже нет */ }
      }
    }
    const finish = (e: Error | null, v?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      killGroup()
      if (e) reject(e)
      else resolve(v ?? '')
    }
    const onAbort = (): void => {
      finish(new ExtractError('timeout', 'разбор прерван по таймауту'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      finish(new ExtractError('timeout', `${bin}: превышено время работы`))
    }, RUN_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      if (done) return // после отказа вывод больше не копим
      outLen += d.length
      if (outLen > MAX_STDOUT_BYTES) {
        finish(new ExtractError('too_complex', `${bin}: слишком большой вывод`))
        return
      }
      out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4096) err += String(d)
    })
    child.on('error', e => finish(new ExtractError('failed', `${bin}: не запустился (${e.message})`)))
    child.on('close', (code) => {
      if (code === 0) finish(null, Buffer.concat(out).toString('utf8'))
      else finish(new ExtractError('failed', `${bin}: завершился с кодом ${code}`))
    })
  })
}

/**
 * Декодировать байты как UTF-8, а в windows-1251 — только если байты НЕ являются корректным
 * UTF-8. Строгий декодер (бросает на неверной последовательности), а не поиск U+FFFD:
 * корректный UTF-8 может законно содержать U+FFFD и не должен переворачиваться в 1251. Чистая.
 */
export function decodeBytes(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-1251').decode(buf)
  }
}

async function decodeText(path: string): Promise<string> {
  return decodeBytes(await readFile(path))
}

/** Потолок одного CSV листа на диске: больше — отказ до чтения в память. */
export const MAX_SHEET_CSV_BYTES = 50 * 1024 * 1024

async function readSheetCsv(path: string): Promise<string> {
  const st = await stat(path)
  if (st.size > MAX_SHEET_CSV_BYTES) {
    throw new ExtractError('too_complex', `слишком большой лист таблицы (> ${MAX_SHEET_CSV_BYTES} байт)`)
  }
  return decodeText(path)
}

/**
 * Настройки свежего профиля LibreOffice (`registrymodifications.xcu`). Ключи сверены по схеме
 * установленного LibreOffice 24.2 (`share/registry/main.xcd`):
 * - Common/Security/Scripting: MacroSecurityLevel=3 (очень высокий), DisableMacrosExecution —
 *   макросы чужого документа не выполняются;
 * - Common/Security/Scripting/BlockUntrustedRefererLinks — не загружать ссылки из документа
 *   (внешние картинки). ПРОВЕРЕНО ВЖИВУЮ: документ с картинкой по http://127.0.0.1 при выгрузке
 *   в PDF без ключа запрашивает её, с ключом — нет;
 * - Calc/Content/Update/Link=1 (никогда) и Writer/Content/Update/Link=0 (никогда) — не обновлять
 *   внешние связи при загрузке (значения перечислений у Calc и Writer разные).
 * ⚠ `--safe-mode` НЕ используем: он запускает LibreOffice с временным профилем и ОТБРАСЫВАЕТ эти
 * настройки (проверено: с ним внешняя картинка снова запрашивается). Свежий профиль на каждый
 * разбор и так без макросов, расширений и настроек пользователя.
 * Сеть этим не закрыта полностью — граница сети — контейнер без выхода наружу (см. README).
 */
export const LO_REGISTRY = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`

/** Табличные форматы Office — выгружаем CSV (сетка ячеек), а не текстовым фильтром Writer. */
const SPREADSHEET_EXT = new Set(['xls', 'xlsx', 'xlsm', 'ods', 'fods'])

// CSV с ЗАКРЕПЛЁННЫМИ FilterOptions, чтобы вывод не зависел от локали контейнера (десятичная
// запятая по умолчанию испортила бы цены). 9 = табуляция как разделитель (не сталкивается с
// десятичной запятой), 34 = '"' ограничитель текста, 76 = UTF-8.
// Хвост `,,,,,,,,,-1` — «какой лист выгружать» = -1 → КАЖДЫЙ лист отдельным CSV, а не только
// первый: иначе товары на листе «Приложение» терялись бы.
const CSV_FILTER = 'csv:Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1'

/**
 * Цель `--convert-to` для файла Office. Таблицы — в CSV (табуляция, UTF-8), текстовые
 * документы (doc/docx/odt/rtf) — в простой текст. Чистая. `outExt` — расширение результата.
 */
export function officeConvertTarget(path: string): { filter: string, outExt: string } {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return SPREADSHEET_EXT.has(ext)
    ? { filter: CSV_FILTER, outExt: 'csv' }
    : { filter: 'txt:Text', outExt: 'txt' }
}

/**
 * Потолок числа листов. Подготовленная книга может нести тысячи крошечных листов → по CSV на
 * каждый; без потолка мы прочли бы их все в память. Громкий отказ, а не тихое усечение.
 */
export const MAX_SHEET_CSVS = 64

export interface OfficeCsvOutput { name: string, path: string }

/**
 * Разобрать stdout `libreoffice --convert-to csv` в пути CSV В ПОРЯДКЕ ЛИСТОВ КНИГИ.
 * LibreOffice печатает строку на лист в порядке листов: `Writing sheet <имя> -> <путь>.csv`
 * (несколько листов) или `convert <вход> -> <путь>.csv using filter :…` (один лист).
 * Порядок держит первым лист-шапку; сортировка по имени его сломала бы («Лист10» раньше
 * «Лист2»).
 * ⚠ Путь берётся по ПОСЛЕДНЕМУ `-> `: имя листа пишет автор документа, и `-> ` внутри имени
 * иначе сдвинуло бы разбор. И путь принимается, ТОЛЬКО если он внутри `dir` (своего рабочего
 * каталога): строка stdout — производная чужого документа, и без проверки подставленный путь
 * `-> /etc/x.csv` заставил бы нас прочитать и вернуть чужой файл. Чистая.
 */
export function parseOfficeCsvSheets(stdout: string, dir: string): OfficeCsvOutput[] {
  const root = resolve(dir) + sep
  const out: OfficeCsvOutput[] = []
  for (const line of stdout.split('\n')) {
    const arrow = line.lastIndexOf('-> ')
    if (arrow < 0) continue
    let rest = line.slice(arrow + 3)
    const uf = rest.indexOf(' using filter')
    if (uf >= 0) rest = rest.slice(0, uf)
    rest = rest.trim()
    if (!rest.toLowerCase().endsWith('.csv')) continue
    const full = resolve(rest)
    if (!full.startsWith(root)) continue
    const m = line.slice(0, arrow).match(/Writing sheet (.*?)\s*$/)
    const name = m?.[1] ?? basename(full).replace(/\.csv$/i, '')
    out.push({ name, path: full })
  }
  return out
}

/** Только пути — форма, в которой функция жила в ai-price-import. Чистая. */
export function parseOfficeCsvOutputs(stdout: string, dir: string): string[] {
  return parseOfficeCsvSheets(stdout, dir).map(s => s.path)
}

/** Число непустых строк CSV. Чистая. */
export function countRows(csv: string): number {
  return csv.split('\n').filter(l => l.trim() !== '').length
}

/**
 * Документ Office → текст через LibreOffice (во временный каталог). Фильтр выбирается по
 * `fileName`; `path` — то, что читает LibreOffice, формат он узнаёт по содержимому.
 * Таблицы выгружают КАЖДЫЙ лист; текст — все листы в порядке книги, пустые отбрасываются.
 */
async function officeToText(path: string, fileName: string, signal: AbortSignal): Promise<OfficeOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'file-extract-office-'))
  try {
    const { filter, outExt } = officeConvertTarget(fileName)
    // Свой профиль на каждый разбор во временном каталоге (-env:UserInstallation): параллельные
    // разборы не дерутся за общий профиль, а настройки безопасности (LO_REGISTRY) — свои.
    // LANG=C.UTF-8: иначе LibreOffice не сможет записать CSV листа с кириллицей в имени.
    const profile = join(dir, 'loprofile')
    await mkdir(join(profile, 'user'), { recursive: true })
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), LO_REGISTRY)
    const outDir = join(dir, 'out')
    await mkdir(outDir)
    const stdout = await run('libreoffice', [
      '-env:UserInstallation=file://' + profile,
      '--headless', '--convert-to', filter, '--outdir', outDir, path
    ], signal, { dir, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
    if (outExt === 'csv') {
      // Основной путь — порядок листов из stdout. Запасной — содержимое каталога (порядок не
      // гарантирован → сортировка), только если stdout ничего не дал.
      let outs = parseOfficeCsvSheets(stdout, outDir)
      if (!outs.length) {
        outs = (await readdir(outDir)).filter(f => f.toLowerCase().endsWith('.csv')).sort()
          .map(f => ({ name: f.replace(/\.csv$/i, ''), path: join(outDir, f) }))
      }
      if (outs.length) {
        if (outs.length > MAX_SHEET_CSVS) {
          throw new ExtractError('too_complex', `слишком много листов в книге (${outs.length} > ${MAX_SHEET_CSVS})`)
        }
        const parts = await Promise.all(outs.map(async o => ({ name: o.name, csv: (await readSheetCsv(o.path)).trim() })))
        const sheets: Sheet[] = parts.filter(p => p.csv !== '').map(p => ({ ...p, rows: countRows(p.csv) }))
        return { text: sheets.map(s => s.csv).join('\n'), sheets }
      }
      // CSV нет вовсе: читаем файл с базовым именем.
    }
    const base = (path.split('/').pop() ?? 'out').replace(/\.[^.]+$/, '')
    return { text: await readSheetCsv(join(outDir, `${base}.${outExt}`)), sheets: [] }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Потолок страниц скана PDF, которые растеризуются и проходят OCR. */
export const MAX_OCR_PDF_PAGES = 30

const OCR_LANGS = 'rus+bel+kaz+eng'

/**
 * Упорядочить PNG страниц от pdftoppm по ЧИСЛОВОМУ номеру (`p-2.png` раньше `p-10.png`) —
 * обычная `.sort()` лексикографическая. Не PNG и без номера — отбрасываются. Чистая.
 */
export function orderPdfPageImages(names: string[]): string[] {
  return names
    .filter(n => n.toLowerCase().endsWith('.png'))
    .map(n => ({ n, i: Number((n.match(/-(\d+)\.png$/i) ?? [])[1] ?? NaN) }))
    .filter(x => Number.isFinite(x.i))
    .sort((a, b) => a.i - b.i)
    .map(x => x.n)
}

/** Есть ли в начале буфера сигнатура `%PDF-`. Спецификация допускает до ~1024 байт мусора
 *  ПЕРЕД заголовком, поэтому ищем по окну, а не только с нулевой позиции. Чистая. */
export function hasPdfMagic(head: Uint8Array): boolean {
  return Buffer.from(head).toString('latin1').includes('%PDF-')
}

async function isPdfFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    return hasPdfMagic(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

/**
 * OCR скана PDF: каждая страница → PNG (pdftoppm), затем tesseract по странице, ПО ОЧЕРЕДИ
 * (память и процессор остаются ограниченными). tesseract не читает PDF сам.
 * Ограничения действуют ВНУТРИ pdftoppm: `-l` — сколько страниц растеризовать (тысячестраничный
 * скан не заполнит диск), `-scale-to` — длинная сторона PNG в пикселях (огромная страница не
 * съест память tesseract).
 */
async function ocrPdf(path: string, signal: AbortSignal, maxPages: number = MAX_OCR_PDF_PAGES): Promise<OcrOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'file-extract-ocrpdf-'))
  try {
    // `-l maxPages+1` — на одну страницу сверх потолка, чтобы проверка ниже увидела «слишком
    // много», не растеризуя весь документ.
    await run('pdftoppm', ['-png', '-scale-to', '3000', '-f', '1', '-l', String(maxPages + 1),
      path, join(dir, 'p')], signal, { dir })
    const pages = orderPdfPageImages(await readdir(dir))
    if (!pages.length) throw new ExtractError('failed', 'pdftoppm: страницы не получены')
    if (pages.length > maxPages) {
      throw new ExtractError('too_complex', `слишком много страниц для OCR (> ${maxPages})`)
    }
    const texts: string[] = []
    for (const p of pages) {
      texts.push(await run('tesseract', [join(dir, p), 'stdout', '-l', OCR_LANGS], signal, { dir }))
    }
    return { text: texts.map(t => t.trim()).filter(Boolean).join('\n'), pages: pages.length }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Потолок страниц, которые читает pdftotext: дальше — не читаем (документ в тысячи страниц
 *  иначе держал бы процессор до таймаута). Текст сверх потолка всё равно срезал бы MAX_TEXT_CHARS. */
export const MAX_PDF_TEXT_PAGES = 500

/** Отказ до OCR, если картинка развернётся больше потолка пикселей. */
export function checkImagePixels(bytes: Uint8Array): void {
  const size = imageSize(bytes)
  if (size && size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new ExtractError('too_complex', `картинка слишком большая для OCR (> ${MAX_IMAGE_PIXELS} пикселей)`)
  }
}

async function ocrImage(path: string, signal: AbortSignal): Promise<OcrOutput> {
  checkImagePixels(await readFile(path)) // файл уже в пределах MAX_FILE_BYTES
  return { text: await run('tesseract', [path, 'stdout', '-l', OCR_LANGS], signal, { dir: dirname(path) }), pages: 1 }
}

export const liveExtractRunners: ExtractRunners = {
  readText: decodeText,
  pdfToText: (path, signal) => run('pdftotext', ['-layout', '-enc', 'UTF-8', '-l', String(MAX_PDF_TEXT_PAGES), path, '-'], signal, { dir: dirname(path) }),
  officeToText,
  // OCR и для картинок, и для СКАНОВ PDF: PDF (сигнатура `%PDF-`) сначала растеризуется,
  // потому что tesseract PDF не читает. Путь выбирает проверка содержимого, а не вызывающий.
  // У страниц PDF размер держит `-scale-to` pdftoppm, поэтому проверка пикселей — для картинок.
  ocr: async (path, signal) => (await isPdfFile(path)) ? ocrPdf(path, signal) : ocrImage(path, signal)
}
