/**
 * Метрики сервиса (#38): счётчики в памяти и текст в формате Prometheus.
 * ⚠ Только числа и закрытый набор меток: имя файла, текст, ключ кеша и потребитель в метки не попадают
 * (как и в журнал). Адрес `GET /metrics` закрыт тем же ключом, что и разбор: числа несекретны, но по ним видна
 * нагрузка (в частности, попадания в кеш = «такой файл уже присылали»), поэтому открытым его не делаем.
 */

export type Route = 'extract' | 'convert'

export interface Gauges {
  running: number
  queued: number
  inflight: number
  /** Разборов в работе (разные файлы). */
  flights: number
}

export interface Metrics {
  /** Итог запроса: HTTP-статус (200, 401, 503, 504, 499 — ушёл клиент…). */
  request: (route: Route, status: number) => void
  cacheHit: () => void
  cacheMiss: () => void
  /** Запрос присоединился к чужому разбору того же файла (single-flight). */
  shared: () => void
  /** Текст для Prometheus. */
  render: (g: Gauges, mem?: { rssBytes: number, peakRssBytes: number }) => string
}

/** Память процесса: текущая и пиковая (`maxRSS` — килобайты). */
export function processMemory(): { rssBytes: number, peakRssBytes: number } {
  const rss = process.memoryUsage().rss
  return { rssBytes: rss, peakRssBytes: Math.max(rss, process.resourceUsage().maxRSS * 1024) }
}

export function createMetrics(): Metrics {
  const requests = new Map<string, number>()
  let hits = 0
  let misses = 0
  let sharedCount = 0
  return {
    request(route, status) {
      // Метка статуса — только трёхзначное число: набор конечен, лишнего в метку не попадёт.
      const k = `${route}\n${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0}`
      requests.set(k, (requests.get(k) ?? 0) + 1)
    },
    cacheHit() { hits++ },
    cacheMiss() { misses++ },
    shared() { sharedCount++ },
    render(g, mem = processMemory()) {
      const out: string[] = []
      const metric = (name: string, type: 'counter' | 'gauge', help: string, rows: Array<[string, number]>): void => {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
        for (const [labels, v] of rows) out.push(`${name}${labels} ${v}`)
      }
      const rows = [...requests.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]): [string, number] => {
        const [route, status] = k.split('\n')
        return [`{route="${route}",status="${status}"}`, v]
      })
      metric('file_extract_requests_total', 'counter', 'Requests by route and HTTP status (503 busy, 504 timeout, 499 client gone).', rows)
      metric('file_extract_cache_hits_total', 'counter', 'Extract requests answered from the cache.', [['', hits]])
      metric('file_extract_cache_misses_total', 'counter', 'Extract requests that missed the cache.', [['', misses]])
      metric('file_extract_shared_total', 'counter', 'Extract requests that joined a running identical extraction (single-flight).', [['', sharedCount]])
      metric('file_extract_flights', 'gauge', 'Distinct extractions in progress.', [['', g.flights]])
      metric('file_extract_slots_running', 'gauge', 'Extractions running now.', [['', g.running]])
      metric('file_extract_queue_depth', 'gauge', 'Requests waiting for an extraction slot.', [['', g.queued]])
      metric('file_extract_bodies_inflight', 'gauge', 'Request bodies held in memory (reading, queued or extracting).', [['', g.inflight]])
      metric('file_extract_memory_rss_bytes', 'gauge', 'Resident memory of the service process.', [['', mem.rssBytes]])
      metric('file_extract_memory_peak_rss_bytes', 'gauge', 'Peak resident memory of the service process since start.', [['', mem.peakRssBytes]])
      return out.join('\n') + '\n'
    }
  }
}
