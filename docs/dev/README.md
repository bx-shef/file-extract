# file-extract для разработчиков

> Last reviewed: 2026-11-04

Сервис отдаёт соседям линейки одну операцию: файл → текст (а у таблиц — ещё листы CSV).
Разбор живёт в одном месте, а не копиями в каждом продукте.

**Кто зовёт:** сервисы линейки во внутренней сети Docker. Сейчас — toolsai-mcp (инструмент чтения
файлов shef.cowork, `server/lib/fileExtract.ts`). Модули портала (PHP) сервис напрямую не зовут:
у него нет учёта расхода и прав пользователя, ключ — общий секрет сервиса.

| Файл | О чём |
|---|---|
| [API.md](API.md) | HTTP-контракт: эндпоинт, заголовки, ответ, коды ошибок, повторы, пределы |
| [../../README.md](../../README.md) | форматы, кеш, изоляция, персональные данные, настройки env |
| [../../CLAUDE.md](../../CLAUDE.md) | карта кода (`src/`), версии и выпуск |

Карта всей линейки — [toolsai/docs/dev/llms.txt](https://github.com/bx-shef/toolsai/blob/main/docs/dev/llms.txt).

## Как подключить свой сервис

1. Контейнер file-extract — в той же compose-сети с `internal: true` (без выхода наружу), образ
   `ghcr.io/bx-shef/file-extract:<sha коммита>` — по примеру `docker-compose.example.yml`.
2. Свой сервис получает адрес и ключ из окружения. Образец — toolsai-mcp: `FILE_EXTRACT_URL`
   (`http://file-extract:3000`, только http(s), без логина, `?query` и `#`) и `FILE_EXTRACT_KEY`
   (= `EXTRACT_API_KEY` сервиса, не короче 16 знаков); заданы оба или ни одного.
3. Запрос — `POST /v1/extract` с телом-файлом, `X-File-Name` и `Authorization: Bearer` ([API.md](API.md)).
4. Таймаут клиента — меньше `EXTRACT_TIMEOUT_MS` сервиса (у toolsai-mcp `FILE_EXTRACT_TIMEOUT_MS`
   280 000 мс при 300 000 у сервиса); `503` и `504` — повторить позже, остальные отказы — нет.

## Системные требования

| | значение | где задано |
|---|---|---|
| CPU | 1 ядро на контейнер | `cpus: 1` в `docker-compose.example.yml` |
| память | 1,5 ГБ на контейнер (LibreOffice, Tesseract, тела в очереди) | `mem_limit: 1536m` |
| процессы | до 256; PID 1 — `tini`, подбирает осиротевшие процессы LibreOffice | `pids_limit`, `Dockerfile` |
| диск | `/tmp` — tmpfs (кеш на диске до `CACHE_MAX_BYTES`, 256 МБ) | compose |
| сеть | без выхода наружу (`internal: true`) | compose |

## Можно / нельзя

- Можно: передавать файлы до `MAX_FILE_BYTES` (20 МБ), полагаться на кеш 24 часа по sha256 файла.
- Нельзя: выставлять порт наружу или в общую сеть; подключать общий Redis с AOF (персональные
  данные на диске); писать имя файла и текст в свои журналы — сервис их тоже не пишет.

## Как проверить

```bash
curl -s http://file-extract:3000/health    # {"ok":true,"version":"0.2.0-1"}
```

`version` здесь — `EXTRACTOR_VERSION` (версия разборщика, часть ключа кеша), версия продукта —
`package.json` и `CHANGELOG.md`.
