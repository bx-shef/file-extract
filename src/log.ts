/**
 * Журнал — одна JSON-строка на событие в stdout.
 * ⚠ ТОЛЬКО эти поля. Имя файла и текст — персональные данные, в журнал не попадают никогда:
 * тип поля закрыт, поэтому положить их «заодно» не даст компилятор.
 */
export interface LogEntry {
  evt: 'extract' | 'start' | 'cache_sweep' | 'error'
  kind?: string
  bytes?: number
  ms?: number
  /** Первые 12 знаков sha256 файла — для сопоставления, не для восстановления. */
  sha?: string
  cached?: boolean
  error?: string
  removed?: number
  version?: string
}

export type Logger = (e: LogEntry) => void

export const stdoutLogger: Logger = (e) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n')
}

export const shortSha = (sha: string): string => sha.slice(0, 12)
