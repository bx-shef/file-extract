/**
 * Журнал — одна JSON-строка на событие в stdout.
 * ⚠ ТОЛЬКО эти поля. Имя файла и текст — персональные данные, в журнал не попадают никогда:
 * тип поля закрыт, поэтому положить их «заодно» не даст компилятор.
 */
export interface LogEntry {
  evt: 'extract' | 'start' | 'cache_sweep' | 'cache_sweep_failed' | 'error'
  kind?: string
  bytes?: number
  /** Время от приёма запроса до ответа. */
  ms?: number
  /** Сколько из него запрос ждал места в очереди разбора. */
  queueMs?: number
  /** Первые 12 знаков sha256 файла — для сопоставления, не для восстановления. */
  sha?: string
  cached?: boolean
  /** Машинный код ответа (unauthorized, timeout, client_aborted…). */
  error?: string
  /** Для 500 internal — класс системной ошибки (`ENOSPC`, `EACCES`…), без текста и путей. */
  errorClass?: string
  removed?: number
  version?: string
}

export type Logger = (e: LogEntry) => void

export const stdoutLogger: Logger = (e) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n')
}

export const shortSha = (sha: string): string => sha.slice(0, 12)

/**
 * Класс системной ошибки для журнала: только `code` вида `ENOSPC` (буквы, цифры, `_`), иначе
 * имя класса ошибки. Текст сообщения НЕ берём — в нём пути и имена файлов. Чистая.
 */
export function errorClassOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code
  const name = (e as { name?: unknown } | null)?.name
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'unknown'
}
