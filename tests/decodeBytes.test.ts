import { describe, expect, it } from 'vitest'
import { decodeBytes } from '../src/extractRunners.ts'

// windows-1251 bytes for "Товар" (Т=0xD2 о=0xEE в=0xE2 а=0xE0 р=0xF0)
const CP1251_TOVAR = new Uint8Array([0xD2, 0xEE, 0xE2, 0xE0, 0xF0])

describe('decodeBytes', () => {
  it('decodes valid UTF-8 Cyrillic intact', () => {
    const utf8 = new TextEncoder().encode('Счёт №5 — ООО «Ромашка»')
    expect(decodeBytes(utf8)).toBe('Счёт №5 — ООО «Ромашка»')
  })
  it('falls back to windows-1251 for non-UTF-8 bytes', () => {
    expect(decodeBytes(CP1251_TOVAR)).toBe('Товар')
  })
  it('does NOT flip a valid UTF-8 string that contains a literal U+FFFD', () => {
    const withReplacement = new TextEncoder().encode('цена�100')
    // valid UTF-8 → must stay UTF-8 (the old includes("�") heuristic would corrupt this)
    expect(decodeBytes(withReplacement)).toBe('цена�100')
  })
  it('empty input → empty string', () => {
    expect(decodeBytes(new Uint8Array([]))).toBe('')
  })
})
