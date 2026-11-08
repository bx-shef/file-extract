// Байты картинок для тестов проверки HTML. Не тест (в имени нет .test), vitest его не запускает.
import { crc32, deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Чанк PNG: длина, тип, данные, CRC. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function ihdr(width: number, height: number): Buffer {
  const h = Buffer.alloc(13)
  h.writeUInt32BE(width, 0)
  h.writeUInt32BE(height, 4)
  h[8] = 8 // 8 бит на канал
  h[9] = 2 // RGB
  return pngChunk('IHDR', h)
}

/** Только заголовок PNG: сигнатура, IHDR с заданными размерами, IEND. Для огромных размеров. */
export function pngHeader(width: number, height: number): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height), pngChunk('IEND', Buffer.alloc(0))])
}

/** Настоящий PNG (его откроет LibreOffice); размеры — малые. */
export function png(width: number, height: number): Buffer {
  const row = Buffer.alloc(width * 3 + 1, 120)
  row[0] = 0 // фильтр строки «без фильтра»
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

/** Заголовок JPEG: SOI, APP0, SOF0 с размерами, EOI. Для проверки размеров, декодировать нечего. */
export function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9, 0, 0, 0, 0])])
}

/** Заголовок GIF с размерами экрана. */
export function gifHeader(width: number, height: number, version: '87a' | '89a' | '88a' = '89a'): Buffer {
  const b = Buffer.alloc(14)
  b.write('GIF' + version, 0, 'latin1')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  b[13] = 0x3b
  return b
}

/** Адрес data: с base64. */
export function dataUrl(mime: string, bytes: Uint8Array | string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}
