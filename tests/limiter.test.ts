import { describe, expect, it } from 'vitest'
import { Limiter, QueueAbortedError, QueueFullError, QueueTimeoutError } from '../src/limiter.ts'

describe('Limiter', () => {
  it('не больше max одновременно, остальные ждут по порядку', async () => {
    const l = new Limiter(2, 1000)
    const r1 = await l.acquire()
    const r2 = await l.acquire()
    const order: number[] = []
    const p3 = l.acquire().then((r) => { order.push(3); return r })
    const p4 = l.acquire().then((r) => { order.push(4); return r })
    expect(l.running).toBe(2)
    expect(l.queued).toBe(2)
    r1()
    const r3 = await p3
    expect(l.running).toBe(2)
    r2()
    const r4 = await p4
    expect(order).toEqual([3, 4])
    r3(); r4()
    expect(l.running).toBe(0)
  })
  it('ожидание дольше таймаута — QueueTimeoutError, место не теряется', async () => {
    const l = new Limiter(1, 20)
    const r1 = await l.acquire()
    await expect(l.acquire()).rejects.toBeInstanceOf(QueueTimeoutError)
    expect(l.queued).toBe(0)
    r1()
    r1() // повторное освобождение ничего не ломает
    expect(l.running).toBe(0)
    const r = await l.acquire()
    expect(l.running).toBe(1)
    r()
  })
})

describe('Limiter: глубина очереди и отмена', () => {
  it('сверх maxQueue — QueueFullError сразу', async () => {
    const l = new Limiter(1, 1000, 1)
    const r1 = await l.acquire()
    const p2 = l.acquire()
    await expect(l.acquire()).rejects.toBeInstanceOf(QueueFullError)
    expect(l.queued).toBe(1)
    r1()
    const r2 = await p2
    r2()
    expect(l.running).toBe(0)
  })
  it('maxQueue 0 — ждать нельзя вовсе', async () => {
    const l = new Limiter(1, 1000, 0)
    const r = await l.acquire()
    await expect(l.acquire()).rejects.toBeInstanceOf(QueueFullError)
    r()
  })
  it('отмена сигналом убирает ожидающего, место не теряется', async () => {
    const l = new Limiter(1, 1000)
    const r1 = await l.acquire()
    const ac = new AbortController()
    const p = l.acquire(ac.signal)
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(QueueAbortedError)
    expect(l.queued).toBe(0)
    r1()
    expect(l.running).toBe(0)
  })
})
