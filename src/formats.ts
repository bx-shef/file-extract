// Список принимаемых форматов и выбор способа разбора по расширению.
// Перенесено из ai-price-import (`app/config/uploadFormats.ts` + `planExtraction`).

export type ExtractKind = 'text' | 'pdf' | 'office' | 'image' | 'unsupported'

export interface ExtractPlan { kind: ExtractKind, ext: string }

const EXT_KIND: Record<string, ExtractKind> = {
  txt: 'text', csv: 'text', tsv: 'text',
  pdf: 'pdf',
  doc: 'office', docx: 'office', xls: 'office', xlsx: 'office', odt: 'office', ods: 'office', rtf: 'office',
  png: 'image', jpg: 'image', jpeg: 'image', tif: 'image', tiff: 'image', bmp: 'image', webp: 'image'
}

/**
 * Все расширения, которые сервис разбирает. Совпадает с ключами EXT_KIND — это держит тест:
 * список для людей и маршрутизация не должны разойтись.
 */
export const SUPPORTED_EXT = Object.keys(EXT_KIND) as readonly string[]

/** Выбрать способ разбора по расширению имени файла (без учёта регистра). */
export function planExtraction(fileName: string): ExtractPlan {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase().trim()
  return { kind: EXT_KIND[ext] ?? 'unsupported', ext }
}
