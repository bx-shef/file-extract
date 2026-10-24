import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('без ключа не стартует (fail-closed)', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/EXTRACT_API_KEY/)
  })
  it('короткий ключ отвергается', () => {
    expect(() => loadConfig({ EXTRACT_API_KEY: 'short' })).toThrow(ConfigError)
  })
  it('в тестах ключ необязателен', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).apiKey).toBe('')
  })
  it('умолчания', () => {
    const c = loadConfig({ EXTRACT_API_KEY: 'x'.repeat(16) })
    expect(c).toMatchObject({ maxFileBytes: 20 * 1024 * 1024, maxTextChars: 2_000_000, maxConcurrency: 2, maxQueue: 8, extractTimeoutMs: 300_000, redisUrl: null, host: '127.0.0.1', cacheMaxBytes: 256 * 1024 * 1024 })
    expect(loadConfig({ NODE_ENV: 'test', HOST: '0.0.0.0', MAX_QUEUE: '0' })).toMatchObject({ host: '0.0.0.0', maxQueue: 0 })
  })
  it('кривое число — ошибка, а не молчаливое умолчание', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_CONCURRENCY: '0' })).toThrow(ConfigError)
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_FILE_BYTES: '1e5x' })).toThrow(ConfigError)
  })
})
