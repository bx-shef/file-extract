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
    expect(loadConfig({ NODE_ENV: 'test' }).consumers).toEqual([])
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
    // ревью #30: логин и пароль в адресе, пустой запрос и якорь, неверный порт — тоже отказ запуска
    for (const url of ['vision:8080', 'ftp://vision/v1', 'http://', 'http://vi sion/v1', 'http://vision/v1?x=1', 'http://vision/v1?', 'http://vision/v1#x',
      'http://user:pass@vision:8080/v1', 'http://user@vision/v1', 'http://vision:99999/v1', 'file:///etc/passwd']) {
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

describe('EXTRACT_API_KEYS: ключи потребителей', () => {
  const A = 'a'.repeat(16)
  const B = 'b'.repeat(16)
  it('список метка:ключ через запятую и перевод строки; старый ключ — метка default', () => {
    const c = loadConfig({ EXTRACT_API_KEYS: `mcp:${A},price-import:${B}\nbank:${'c'.repeat(16)}`, EXTRACT_API_KEY: 'd'.repeat(16) })
    expect(c.consumers.map(x => x.label)).toEqual(['default', 'mcp', 'price-import', 'bank'])
  })
  it('только старый ключ работает как раньше', () => {
    expect(loadConfig({ EXTRACT_API_KEY: A }).consumers).toEqual([{ label: 'default', key: A }])
  })
  it('ключ — всё после первого «:»', () => {
    expect(loadConfig({ EXTRACT_API_KEYS: `mcp:ab:cd${'x'.repeat(14)}` }).consumers[0]!.key).toBe(`ab:cd${'x'.repeat(14)}`)
  })
  it('без ключей (оба пусты) — не стартует; в тестах можно', () => {
    expect(() => loadConfig({ EXTRACT_API_KEYS: '  ' })).toThrow(/не заданы/)
    expect(loadConfig({ NODE_ENV: 'test', EXTRACT_API_KEYS: '' }).consumers).toEqual([])
  })
  it('плохая метка, короткий ключ, один ключ у двух меток — ошибки, а текст без самих ключей', () => {
    expect(() => loadConfig({ EXTRACT_API_KEYS: `Bad Label:${A}` })).toThrow(ConfigError)
    expect(() => loadConfig({ EXTRACT_API_KEYS: `${A}` })).toThrow(ConfigError)
    expect(() => loadConfig({ EXTRACT_API_KEYS: 'mcp:short' })).toThrow(/запись 1 \(mcp\)/)
    const secret = 'SeCrEt-0123456789'
    expect(() => loadConfig({ EXTRACT_API_KEYS: `mcp:${secret},bank:${secret}` })).toThrow(/mcp и bank/)
    try { loadConfig({ EXTRACT_API_KEYS: `mcp:${secret},bank:${secret}` }) } catch (e) { expect(String(e)).not.toContain(secret) }
    try { loadConfig({ EXTRACT_API_KEYS: 'mcp:sh ort-key-with-space-1234' }) } catch (e) { expect(String(e)).not.toContain('ort-key') }
  })
  it('одна метка с двумя ключами — ротация; метка default и EXTRACT_API_KEY с тем же ключом — не ошибка', () => {
    expect(loadConfig({ EXTRACT_API_KEYS: `mcp:${A},mcp:${B}` }).consumers).toHaveLength(2)
    expect(() => loadConfig({ EXTRACT_API_KEY: A, EXTRACT_API_KEYS: `default:${A}` })).not.toThrow()
    expect(() => loadConfig({ EXTRACT_API_KEY: A, EXTRACT_API_KEYS: `mcp:${A}` })).toThrow(ConfigError)
  })
})
