import { describe, expect, it } from 'vitest'
import { applyTextLimit } from '../src/truncate.ts'

describe('applyTextLimit', () => {
  it('в пределах потолка — без изменений', () => {
    const s = [{ name: 'a', csv: 'x\ty', rows: 1 }]
    expect(applyTextLimit('hello', s, 10)).toEqual({ text: 'hello', sheets: s, truncated: false })
  })
  it('длинный текст обрезается и помечается', () => {
    const r = applyTextLimit('x'.repeat(11), [], 10)
    expect(r.text).toHaveLength(10)
    expect(r.truncated).toBe(true)
  })
  it('ровно на потолке — не обрезан', () => {
    expect(applyTextLimit('x'.repeat(10), [], 10).truncated).toBe(false)
  })
  it('лист на границе режется по строке, следующие отбрасываются', () => {
    const r = applyTextLimit('', [
      { name: 'a', csv: '1234', rows: 1 },
      { name: 'b', csv: 'ab\ncd\nef', rows: 3 },
      { name: 'c', csv: 'zz', rows: 1 }
    ], 10)
    expect(r.sheets).toEqual([{ name: 'a', csv: '1234', rows: 1 }, { name: 'b', csv: 'ab\ncd', rows: 2 }])
    expect(r.truncated).toBe(true)
  })
})
