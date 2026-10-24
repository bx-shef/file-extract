import { describe, expect, it } from 'vitest'
import { applyTextLimit, sliceSafe } from '../src/truncate.ts'

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

describe('суррогатные пары и раздельный бюджет', () => {
  it('не режет суррогатную пару', () => {
    expect(sliceSafe('ab😀c', 3)).toBe('ab')
    expect(sliceSafe('ab😀c', 4)).toBe('ab😀')
    const r = applyTextLimit('a😀', [{ name: 's', csv: 'x😀', rows: 1 }], 2)
    expect(r.text).toBe('a')
    expect(r.sheets[0]!.csv).toBe('x')
    expect(r.truncated).toBe(true)
  })
  it('у текста и листов бюджет свой: оба ровно на потолке — ничего не обрезано', () => {
    const sheets = [{ name: 'a', csv: '12345', rows: 1 }, { name: 'b', csv: '67890', rows: 1 }]
    const r = applyTextLimit('x'.repeat(10), sheets, 10)
    expect(r).toEqual({ text: 'x'.repeat(10), sheets, truncated: false })
  })
})
