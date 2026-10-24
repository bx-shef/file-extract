import { describe, expect, it } from 'vitest'
import { MIN_READABLE_CHARS, sanitizeExtractedText } from '../src/textSanitize.ts'

describe('sanitizeExtractedText', () => {
  it('вычищает нулевой байт и прочие C0/C1, считает удалённое', () => {
    const r = sanitizeExtractedText('a\u0000b\u0007c\u009Fd')
    expect(r).toEqual({ text: 'abcd', removed: 3, readable: true })
  })
  it('сохраняет перевод строки, возврат каретки и табуляцию — на них держится таблица', () => {
    expect(sanitizeExtractedText('a\tb\r\nc\td').text).toBe('a\tb\r\nc\td')
  })
  it('порог читаемости — по непробельным знакам', () => {
    expect(sanitizeExtractedText('x'.repeat(MIN_READABLE_CHARS)).readable).toBe(true)
    expect(sanitizeExtractedText(' x x x ').readable).toBe(false)
  })
  it('null/undefined → пустая нечитаемая строка', () => {
    expect(sanitizeExtractedText(null)).toEqual({ text: '', removed: 0, readable: false })
    expect(sanitizeExtractedText(undefined).readable).toBe(false)
  })
})
