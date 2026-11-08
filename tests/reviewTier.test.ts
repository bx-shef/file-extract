import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Уровни ревью PR (решение владельца 2026-11-07, bx-shef/toolsai-stand#42): правила
// tools/review-tier.rules сходятся с таблицей случаев, движок tools/review-tier.sh в порядке.
// Таблица случаев с неверным уровнем обязана краснеть — иначе проверка ничего не держит.
const selfTest = (rules?: string) =>
  spawnSync('bash', ['tools/review-tier.sh', '--self-test'], {
    encoding: 'utf8',
    env: { ...process.env, ...(rules ? { REVIEW_TIER_RULES: rules } : {}) },
  })

describe('уровни ревью PR', () => {
  it('правила сходятся с таблицей случаев', () => {
    const r = selfTest()
    expect(r.status, r.stderr).toBe(0)
  })

  it('таблица случаев с неверным уровнем краснеет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-tier-'))
    try {
      const src = readFileSync('tools/review-tier.rules', 'utf8')
      const broken = src.replace(/^case 2 /m, 'case 0 ')
      expect(broken).not.toBe(src)
      const file = join(dir, 'broken.rules')
      writeFileSync(file, broken)
      expect(selfTest(file).status).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
