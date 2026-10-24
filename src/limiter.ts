/** Ожидание места превысило таймаут очереди. */
export class QueueTimeoutError extends Error {}

/**
 * Ограничение одновременных разборов: не больше `max`, остальные ждут в очереди по порядку,
 * но не дольше `waitMs`. Таймеры внедряются ради тестов.
 */
export class Limiter {
  private active = 0
  private readonly waiters: Array<{ grant: () => void, timer: ReturnType<typeof setTimeout> }> = []
  private readonly max: number
  private readonly waitMs: number

  constructor(max: number, waitMs: number) {
    this.max = max
    this.waitMs = waitMs
  }

  get running(): number { return this.active }
  get queued(): number { return this.waiters.length }

  /** Занять место. Возвращает функцию освобождения — звать ровно один раз, в finally. */
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
      return this.releaser()
    }
    await new Promise<void>((resolve, reject) => {
      const w = {
        grant: () => { clearTimeout(w.timer); resolve() },
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new QueueTimeoutError('очередь разбора переполнена'))
        }, this.waitMs)
      }
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
