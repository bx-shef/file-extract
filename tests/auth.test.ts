import * as crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { checkBearer } from '../src/auth.ts'

const KEY = 'k'.repeat(32)

describe('checkBearer', () => {
  it('пускает верный ключ', () => {
    expect(checkBearer(`Bearer ${KEY}`, KEY)).toBe(true)
  })
  it('не пускает неверный, пустой, без схемы и при незаданном ключе', () => {
    expect(checkBearer(`Bearer ${KEY}x`, KEY)).toBe(false)
    expect(checkBearer('Bearer ', KEY)).toBe(false)
    expect(checkBearer(undefined, KEY)).toBe(false)
    expect(checkBearer(KEY, KEY)).toBe(false)
    expect(checkBearer('Bearer ', '')).toBe(false)
    expect(checkBearer('Bearer x', '')).toBe(false)
  })
})

vi.mock('node:crypto', async (orig) => {
  const m = await orig<typeof import('node:crypto')>()
  return { ...m, timingSafeEqual: vi.fn(m.timingSafeEqual) }
})

describe('сравнение за постоянное время', () => {
  it('идёт через timingSafeEqual на буферах равной длины, даже при разной длине ключей', () => {
    const spy = vi.mocked(crypto.timingSafeEqual)
    spy.mockClear()
    checkBearer('Bearer short', KEY)
    expect(spy).toHaveBeenCalledTimes(1)
    const [a, b] = spy.mock.calls[0] as [Buffer, Buffer]
    expect(a.length).toBe(b.length)
  })
})
