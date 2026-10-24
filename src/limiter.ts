/** Ожидание места превысило таймаут очереди. */
export class QueueTimeoutError extends Error {}

/** Очередь ожидания полна — отказ сразу, без ожидания. */
export class QueueFullError extends QueueTimeoutError {}

/** Ожидающий ушёл (клиент закрыл соединение) — место ему больше не нужно. */
export class QueueAbortedError extends Error {}

/**
 * Ограничение одновременных разборов: не больше `max`, остальные ждут в очереди по порядку,
 * но не дольше `waitMs` и не больше `maxQueue` ожидающих (иначе очередь копила бы тела
 * запросов в памяти без предела). Ожидание отменяется сигналом.
 */
export class Limiter {
  private active = 0
  private readonly waiters: Array<{ grant: () => void }> = []
  private readonly max: number
  private readonly waitMs: number
  private readonly maxQueue: number

  constructor(max: number, waitMs: number, maxQueue: number = Number.POSITIVE_INFINITY) {
    this.max = max
    this.waitMs = waitMs
    this.maxQueue = maxQueue
  }

  get running(): number { return this.active }
  get queued(): number { return this.waiters.length }

  /** Занять место. Возвращает функцию освобождения — звать ровно один раз, в finally. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new QueueAbortedError('ожидание отменено')
    if (this.active < this.max) {
      this.active++
      return this.releaser()
    }
    if (this.waiters.length >= this.maxQueue) throw new QueueFullError('очередь разбора переполнена')
    await new Promise<void>((resolve, reject) => {
      const drop = (): void => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) this.waiters.splice(i, 1)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => { drop(); reject(new QueueAbortedError('ожидание отменено')) }
      const timer = setTimeout(() => { drop(); reject(new QueueTimeoutError('очередь разбора переполнена')) }, this.waitMs)
      const w = { grant: () => { drop(); resolve() } }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(w)
    })
    // Место передано освобождающим: active уже учтён.
    return this.releaser()
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next.grant() // место переходит ожидающему, счётчик не меняется
      else this.active--
    }
  }
}
