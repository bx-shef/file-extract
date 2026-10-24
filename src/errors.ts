/**
 * Ошибки разбора с машинным кодом. Код решает HTTP-статус ответа, текст — для человека.
 * ⚠ В текст ошибки НЕ кладём имя файла и содержимое: сообщение уходит вызывающему сервису
 * и может оказаться в его логах, а имя файла — персональные данные.
 */
export type ExtractErrorCode =
  | 'unsupported' // формат не поддерживается
  | 'unreadable' // после разбора и чистки не осталось читаемого текста
  | 'too_complex' // слишком много листов или страниц скана
  | 'timeout' // разбор не уложился в отведённое время
  | 'failed' // программа разбора упала

export class ExtractError extends Error {
  readonly code: ExtractErrorCode
  constructor(code: ExtractErrorCode, message: string) {
    super(message)
    this.name = 'ExtractError'
    this.code = code
  }
}
