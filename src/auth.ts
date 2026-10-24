import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Проверить `Authorization: Bearer <ключ>` за постоянное время.
 * Обе стороны сначала хешируются: `timingSafeEqual` требует равной длины, а сравнение длин
 * в открытую выдавало бы длину ключа по времени ответа.
 * Пустой ожидаемый ключ не пускает никого (в тестах ключ задаётся явно).
 */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!expected) return false
  const m = /^Bearer (.+)$/.exec(header ?? '')
  const got = m?.[1] ?? ''
  const a = createHash('sha256').update(got).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b) && got.length > 0
}
