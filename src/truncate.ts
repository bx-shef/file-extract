import type { Sheet } from './textExtract.ts'

/**
 * Первые `n` единиц UTF-16, но без разрезанной суррогатной пары: половина пары — это
 * неверная строка, и при кодировании в UTF-8 она превращается в U+FFFD. Чистая.
 */
export function sliceSafe(s: string, n: number): string {
  if (n <= 0) return ''
  if (n >= s.length) return s
  const c = s.charCodeAt(n - 1)
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n)
}

/**
 * Обрезать текст и листы по потолку знаков. Бюджет у текста и у листов СВОЙ: листы — это
 * тот же текст таблиц в другой форме, и общий бюджет урезал бы одно ради другого.
 * Листы сверх бюджета отбрасываются, лист на границе обрезается по целой строке. Чистая.
 */
export function applyTextLimit(text: string, sheets: Sheet[], max: number): { text: string, sheets: Sheet[], truncated: boolean } {
  let truncated = false
  let outText = text
  if (outText.length > max) {
    outText = sliceSafe(outText, max)
    truncated = true
  }
  const outSheets: Sheet[] = []
  let left = max
  for (const s of sheets) {
    if (left <= 0) { truncated = true; break }
    if (s.csv.length <= left) {
      outSheets.push(s)
      left -= s.csv.length
      continue
    }
    const cut = sliceSafe(s.csv, left)
    const nl = cut.lastIndexOf('\n')
    const csv = nl > 0 ? cut.slice(0, nl) : cut
    outSheets.push({ ...s, csv, rows: csv.split('\n').filter(l => l.trim() !== '').length })
    truncated = true
    left = 0
  }
  if (outSheets.length < sheets.length) truncated = true
  return { text: outText, sheets: outSheets, truncated }
}
