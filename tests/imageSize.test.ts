import { describe, expect, it } from 'vitest'
import { imageFormat, imageSize, MAX_IMAGE_PIXELS } from '../src/imageSize.ts'

function pngHead(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}

function jpegHead(w: number, h: number): Uint8Array {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)])
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]) // DHT — не SOF, пропускается
  const sof = Buffer.alloc(19)
  sof[0] = 0xff; sof[1] = 0xc2; sof.writeUInt16BE(17, 2); sof[4] = 8
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof])
}

function tiffHead(w: number, h: number, le: boolean, ifdAt = 8): Uint8Array {
  const b = Buffer.alloc(ifdAt + 2 + 2 * 12 + 4)
  const w16 = (v: number, o: number) => le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o)
  const w32 = (v: number, o: number) => le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o)
  b.write(le ? 'II' : 'MM', 0, 'latin1'); w16(42, 2); w32(ifdAt, 4)
  w16(2, ifdAt)
  w16(256, ifdAt + 2); w16(4, ifdAt + 4); w32(1, ifdAt + 6); w32(w, ifdAt + 10)
  w16(257, ifdAt + 14); w16(3, ifdAt + 16); w32(1, ifdAt + 18); w16(h, ifdAt + 22)
  return b
}

function bmpHead(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(26)
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(w, 18); b.writeInt32LE(h, 22)
  return b
}

/** Заголовок WEBP: RIFF, WEBP и первый чанк — VP8 (с потерями), VP8L (без потерь) или VP8X (расширенный). */
function webpHead(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Uint8Array {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'latin1'); b.write(kind, 12, 'latin1'); b.writeUInt32LE(10, 16)
  if (kind === 'VP8 ') { b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28) }
  if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0, 21) }
  if (kind === 'VP8X') { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3) }
  return b
}

describe('imageSize', () => {
  it('PNG', () => expect(imageSize(pngHead(100_000, 70_000))).toEqual({ width: 100_000, height: 70_000 }))
  it('JPEG: пропускает сегменты до SOF', () => expect(imageSize(jpegHead(4000, 3000))).toEqual({ width: 4000, height: 3000 }))
  it('TIFF LE и BE, IFD не сразу за заголовком', () => {
    expect(imageSize(tiffHead(9000, 8000, true))).toEqual({ width: 9000, height: 8000 })
    expect(imageSize(tiffHead(9000, 8000, false, 100))).toEqual({ width: 9000, height: 8000 })
  })
  it('BMP с отрицательной высотой', () => expect(imageSize(bmpHead(20, -30))).toEqual({ width: 20, height: 30 }))
  it('неизвестное и обрезанное — null', () => {
    expect(imageSize(Buffer.from('RIFF....WEBP'))).toBeNull()
    expect(imageSize(pngHead(1, 1).subarray(0, 20))).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
  })
  it('WEBP (ревью file-extract#30): VP8, VP8L, VP8X — размеры до OCR и зрения', () => {
    expect(imageSize(webpHead('VP8 ', 1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(imageSize(webpHead('VP8L', 16384, 16384))).toEqual({ width: 16384, height: 16384 })
    expect(imageSize(webpHead('VP8X', 10_000, 10_000))).toEqual({ width: 10_000, height: 10_000 })
    const broken = Buffer.from(webpHead('VP8 ', 10, 10)); broken[23] = 0
    expect(imageSize(broken)).toBeNull()
  })
  it('потолок — 50 Мпикс', () => expect(MAX_IMAGE_PIXELS).toBe(50_000_000))
})

describe('imageFormat', () => {
  it('по сигнатуре, не по имени', () => {
    expect([pngHead(1, 1), jpegHead(1, 1), webpHead('VP8 ', 1, 1), tiffHead(1, 1, true), tiffHead(1, 1, false), bmpHead(1, 1)].map(imageFormat))
      .toEqual(['png', 'jpeg', 'webp', 'tiff', 'tiff', 'bmp'])
  })
  it('GIF, текст, пусто, обрезанная сигнатура — null', () => {
    for (const b of [Buffer.from('GIF89a......'), Buffer.from('hello'), Buffer.alloc(0), Buffer.from([0x89, 0x50, 0x4e, 0x47])]) expect(imageFormat(b)).toBeNull()
  })
})
