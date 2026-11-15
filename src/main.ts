import { diskCache, redisCache, type CacheStore } from './cache.ts'
import { ConfigError, EXTRACTOR_VERSION, loadConfig } from './config.ts'
import { liveExtractRunners } from './extractRunners.ts'
import { stdoutLogger } from './log.ts'
import { createApp } from './server.ts'
import { createDescriber } from './vision.ts'

const SWEEP_INTERVAL_MS = 3_600_000

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`file-extract: ${e.message}\n`)
      process.exit(1)
    }
    throw e
  }

  let cache: CacheStore
  if (config.redisUrl) {
    const { Redis } = await import('ioredis')
    cache = redisCache(new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false }))
  } else {
    cache = diskCache(config.cacheDir, { maxBytes: config.cacheMaxBytes })
  }

  const sweep = (): void => {
    cache.sweep().then((removed) => {
      if (removed) stdoutLogger({ evt: 'cache_sweep', removed })
    }).catch(() => { stdoutLogger({ evt: 'cache_sweep_failed' }) })
  }
  sweep()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()

  // Зрение — только когда задан VISION_URL. Своя очередь (VISION_MAX_QUEUE): одна картинка в работе, ждут не больше
  // двух и не дольше половины VISION_TIMEOUT_MS. Сбой — в журнал без текста и имён.
  const describe = config.vision
    ? createDescriber(config.vision, { onFail: (error) => stdoutLogger({ evt: 'vision_failed', error }) })
    : null
  const server = createApp({ config, runners: liveExtractRunners, cache, log: stdoutLogger, ...(describe ? { describe } : {}) })
  // Запрос живёт не дольше ожидания в очереди + разбора + запаса на приём тела и ответ.
  server.requestTimeout = config.extractTimeoutMs + config.queueTimeoutMs + 30_000
  server.listen(config.port, config.host, () => {
    stdoutLogger({ evt: 'start', version: EXTRACTOR_VERSION })
  })
  const stop = (): void => {
    server.close(() => { void cache.close?.().finally(() => process.exit(0)) })
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

void main()
