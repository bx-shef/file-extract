import { diskCache, redisCache, type CacheStore } from './cache.ts'
import { ConfigError, EXTRACTOR_VERSION, loadConfig } from './config.ts'
import { liveExtractRunners } from './extractRunners.ts'
import { stdoutLogger } from './log.ts'
import { createApp } from './server.ts'

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
    cache = diskCache(config.cacheDir)
  }

  const sweep = (): void => {
    cache.sweep().then((removed) => {
      if (removed) stdoutLogger({ evt: 'cache_sweep', removed })
    }).catch(() => {})
  }
  sweep()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()

  const server = createApp({ config, runners: liveExtractRunners, cache, log: stdoutLogger })
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
