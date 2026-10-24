// Размеры картинки по заголовку — до OCR. Подготовленная картинка 100 000 × 100 000 весит
// килобайты (PNG сжимает одноцветное поле), а tesseract развернёт её в десятки гигабайт памяти.
// Поэтому размеры читаем сами, по байтам заголовка, и отказываем ДО запуска программы. Чистая.

/** Потолок числа пикселей картинки для OCR: 50 Мпикс (≈ A4 при 1200 dpi с запасом). */
export const MAX_IMAGE_PIXELS = 50_000_000

export interface ImageSize { width: number, height: number }

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u32be = (b: Uint8Array, o: number): number => u16be(b, o) * 0x10000 + u16be(b, o + 2)
const u32le = (b: Uint8Array, o: number): number => u16le(b, o) + u16le(b, o + 2) * 0x10000

function png(b: Uint8Array): ImageSize | null {
  // Сигнатура 8 байт, затем чанк IHDR: длина(4) тип(4) ширина(4) высота(4).
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let o = 2
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue }
    const m = b[o + 1] ?? 0
    if (m === 0xff) { o++; continue } // заполнитель
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue } // без длины
    const len = u16be(b, o + 2)
    // SOF0..SOF15, кроме DHT (C4), JPG (C8), DAC (CC): высота(2) ширина(2) после точности(1).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { width: u16be(b, o + 7), height: u16be(b, o + 5) }
    }
    if (len < 2) return null
    o += 2 + len
  }
  return null
}

function tiff(b: Uint8Array): ImageSize | null {
  if (b.length < 8) return null
  const le = b[0] === 0x49 && b[1] === 0x49
  const be = b[0] === 0x4d && b[1] === 0x4d
  if (!le && !be) return null
  const r16 = le ? u16le : u16be
  const r32 = le ? u32le : u32be
  if (r16(b, 2) !== 42) return null
  const ifd = r32(b, 4)
  if (ifd + 2 > b.length) return null
  const n = r16(b, ifd)
  let width = 0
  let height = 0
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > b.length) break
    const tag = r16(b, e)
    const type = r16(b, e + 2)
    const val = type === 3 ? r16(b, e + 8) : r32(b, e + 8)
    if (tag === 256) width = val
    if (tag === 257) height = val
  }
  return width && height ? { width, height } : null
}

function bmp(b: Uint8Array): ImageSize | null {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null
  // Высота со знаком: отрицательная — строки сверху вниз; пиксели считаем по модулю.
  const h = u32le(b, 22)
  return { width: u32le(b, 18), height: h > 0x7fffffff ? 0x100000000 - h : h }
}

/**
 * Размеры PNG, JPEG, TIFF (первая страница) или BMP по байтам файла. Не узнали формат —
 * `null`: решение оставляем программе OCR (WebP здесь не разбирается). Чистая.
 */
export function imageSize(b: Uint8Array): ImageSize | null {
  return png(b) ?? jpeg(b) ?? tiff(b) ?? bmp(b)
}
