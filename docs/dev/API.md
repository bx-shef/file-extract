# HTTP API file-extract

> Last reviewed: 2026-11-04

Код — `src/server.ts` (маршруты), `src/errors.ts` (коды), `src/config.ts` (пределы). Подробные
пояснения к форматам и кешу — в [README](../../README.md).

## Эндпоинты

| метод и путь | ключ | что |
|---|---|---|
| `POST /v1/extract` | `Authorization: Bearer <EXTRACT_API_KEY>` | разбор файла |
| `GET /health` | нет | `200 {"ok": true, "version": "<EXTRACTOR_VERSION>"}` |

Другие пути — `404 not_found`, другой метод — `405 method_not_allowed`.

## POST /v1/extract

- Тело — сырые байты файла (не multipart).
- `X-File-Name` — обязателен, способ разбора — по расширению; нелатинское имя — через
  `encodeURIComponent`.
- Порядок проверок: ключ → имя и формат → объявленный размер → место для тела → тело → кеш →
  очередь → разбор.

Форматы: `txt csv tsv pdf doc docx odt rtf xls xlsx ods png jpg jpeg tif tiff bmp webp`.

Ответ `200`:

| поле | тип | что |
|---|---|---|
| `text` | string | текст файла, очищен от управляющих символов |
| `sheets` | `{name, csv, rows}[]` | листы таблицы (CSV через табуляцию, UTF-8); не таблица — `[]` |
| `ocr` | bool | текст получен распознаванием |
| `truncated` | bool | текст или листы обрезаны по `MAX_TEXT_CHARS` |
| `pages` | int | число распознанных страниц (только OCR) |
| `cached` | bool | ответ из кеша |
| `kind` | `text` \| `pdf` \| `office` \| `image` | способ разбора |
| `sha256` | string | sha256 файла |
| `extractorVersion` | string | версия разборщика (часть ключа кеша) |

## Ошибки

Тело — `{"error": "<код>", "message": "<текст без имени файла и содержимого>"}`.

| HTTP | код | когда | повтор |
|---|---|---|---|
| 400 | `bad_request` | нет `X-File-Name` или пустое тело | нет |
| 401 | `unauthorized` | нет или неверный ключ | нет |
| 413 | `too_large` | файл больше `MAX_FILE_BYTES` | нет |
| 415 | `unsupported` | формат не поддерживается | нет |
| 422 | `unreadable` | читаемого текста нет | нет |
| 422 | `too_complex` | больше 64 листов, лист CSV больше 50 МБ, больше 30 страниц скана, картинка больше 50 Мпикс, вывод программы больше 64 МБ | нет |
| 422 | `extract_failed` | программа разбора упала (обычно битый файл) | нет |
| 503 | `busy` | очередь полна или место не освободилось за `QUEUE_TIMEOUT_MS` | да, с паузой |
| 504 | `timeout` | разбор дольше `EXTRACT_TIMEOUT_MS` | да, с паузой |
| 500 | `internal` | сбой сервиса | осторожно |

На `401`, `413` и `503` сервис закрывает соединение, не дочитывая тело. Клиент, закрывший
соединение раньше ответа, прерывает свой разбор.

## Пределы (env, значения по умолчанию)

| переменная | значение |
|---|---|
| `MAX_FILE_BYTES` | 20 МБ |
| `MAX_TEXT_CHARS` | 2 000 000 |
| `MAX_CONCURRENCY` | 2 разбора одновременно |
| `MAX_QUEUE` | 8 ожидающих |
| `QUEUE_TIMEOUT_MS` | 60 000 |
| `EXTRACT_TIMEOUT_MS` | 300 000 (процесс разбора — до 90 с) |
| `CACHE_MAX_BYTES` | 256 МБ на диске; срок кеша — 24 часа, только успех |

PDF — до 500 страниц текстом; скан PDF — до 30 страниц OCR (rus+bel+kaz+eng).

## Пример

```bash
curl -s -X POST http://file-extract:3000/v1/extract \
  -H "Authorization: Bearer $EXTRACT_API_KEY" \
  -H "X-File-Name: $(node -p 'encodeURIComponent(process.argv[1])' 'Прайс.xlsx')" \
  --data-binary @Прайс.xlsx
```
