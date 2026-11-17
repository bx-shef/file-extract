import { createHash, timingSafeEqual } from 'node:crypto'

/** Потребитель сервиса: метка (идёт в журнал и ключ кеша) и его ключ (не идёт никуда). */
export interface Consumer {
  label: string
  key: string
}

/** Метка потребителя старого общего ключа `EXTRACT_API_KEY`. */
export const DEFAULT_CONSUMER = 'default'

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()

/**
 * Узнать потребителя по `Authorization: Bearer <ключ>`: метка или null. Сравнение за постоянное время, и ПО ВСЕМ
 * ключам без раннего выхода: по времени ответа не видно ни длины ключа, ни места ключа в списке.
 * Обе стороны сначала хешируются: `timingSafeEqual` требует равной длины.
 * Пустой список (и пустой ключ) не пускает никого.
 */
export function authenticate(header: string | undefined, consumers: readonly Consumer[]): string | null {
  const m = /^Bearer (.+)$/.exec(header ?? '')
  const got = m?.[1] ?? ''
  const a = sha(got)
  let label: string | null = null
  for (const c of consumers) {
    if (c.key && timingSafeEqual(a, sha(c.key)) && got.length > 0 && label === null) label = c.label
  }
  return label
}

/** Проверить ключ одного потребителя (общий ключ, как раньше). Пустой ожидаемый ключ не пускает никого. */
export function checkBearer(header: string | undefined, expected: string): boolean {
  return authenticate(header, [{ label: DEFAULT_CONSUMER, key: expected }]) !== null
}
