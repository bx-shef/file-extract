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
  it('зрение: без VISION_URL — выключено', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).vision).toBeNull()
    expect(loadConfig({ NODE_ENV: 'test', VISION_URL: '  ', VISION_API_KEY: 'k' }).vision).toBeNull()
  })
  it('зрение: адрес и ключ, умолчания, «/» в конце снимается', () => {
    expect(loadConfig({ NODE_ENV: 'test', VISION_URL: 'http://vision:8080/v1/', VISION_API_KEY: 'secret' }).vision)
      .toEqual({ url: 'http://vision:8080/v1', apiKey: 'secret', model: 'vision', timeoutMs: 150_000, maxTokens: 400 })
    expect(loadConfig({ NODE_ENV: 'test', VISION_URL: 'https://v.example/api', VISION_API_KEY: 'k', VISION_MODEL: 'vl', VISION_TIMEOUT_MS: '60000', VISION_MAX_TOKENS: '200' }).vision)
      .toMatchObject({ model: 'vl', timeoutMs: 60_000, maxTokens: 200 })
  })
  it('зрение: адрес без ключа и кривой адрес — ошибка запуска', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', VISION_URL: 'http://vision:8080/v1' })).toThrow(/VISION_API_KEY/)
    for (const url of ['vision:8080', 'ftp://vision/v1', 'http://', 'http://vi sion/v1', 'http://vision/v1?x=1']) {
      expect(() => loadConfig({ NODE_ENV: 'test', VISION_URL: url, VISION_API_KEY: 'k' })).toThrow(/VISION_URL/)
    }
  })
  it('зрение: таймаут — меньше таймаута разбора', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', VISION_URL: 'http://vision:8080/v1', VISION_API_KEY: 'k', VISION_TIMEOUT_MS: '300000' })).toThrow(/VISION_TIMEOUT_MS/)
    expect(() => loadConfig({ NODE_ENV: 'test', VISION_URL: 'http://vision:8080/v1', VISION_API_KEY: 'k', EXTRACT_TIMEOUT_MS: '100000' })).toThrow(/VISION_TIMEOUT_MS/)
  })
  it('кривое число — ошибка, а не молчаливое умолчание', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_CONCURRENCY: '0' })).toThrow(ConfigError)
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_FILE_BYTES: '1e5x' })).toThrow(ConfigError)
  })
})
