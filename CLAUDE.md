# CLAUDE.md — file-extract

> Last reviewed: 2026-10-24

Внутренний сервис разбора файлов: файл → текст и листы таблиц. Голый `node:http`, Node 22,
TypeScript запускается через `node --experimental-strip-types` (сборки нет), тесты — vitest.
Задача — bx-shef/file-extract#1. Разбор перенесён из `bx-shef/ai-price-import`
(`server/utils/textExtract.ts`, `extractRunners.ts`, `textSanitize.ts`) без смены смысла.

## Команды

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm start       # node --experimental-strip-types src/main.ts (нужен EXTRACT_API_KEY)
docker build -t file-extract .
```

## Карта

| Где | Что |
|---|---|
| `src/formats.ts` | расширения и выбор способа разбора (`planExtraction`, `SUPPORTED_EXT`) |
| `src/textExtract.ts` | маршрутизация разбора, `MIN_PDF_TEXT`, откат на OCR, единая точка очистки `finishText`; исполнители внедряются |
| `src/extractRunners.ts` | живые исполнители: spawn с группой процессов (cwd/HOME/XDG — рабочий каталог), `subprocessEnv`, `isolatedHome`, профиль LibreOffice `LO_REGISTRY`, потолки `MAX_PDF_TEXT_PAGES`/`MAX_SHEET_CSV_BYTES`, `checkImagePixels`, `decodeBytes`, `officeConvertTarget`, `parseOfficeCsvSheets`, `MAX_SHEET_CSVS`, `MAX_OCR_PDF_PAGES`, `orderPdfPageImages`, `hasPdfMagic` |
| `src/imageSize.ts` | размеры картинки по заголовку (PNG/JPEG/TIFF/BMP), `MAX_IMAGE_PIXELS` |
| `src/textSanitize.ts` | `sanitizeExtractedText` |
| `src/server.ts` | HTTP `POST /v1/extract`: авторизация, лимит размера, место для тела, кеш, очередь, таймаут, уход клиента, временный каталог, коды ошибок |
| `src/cache.ts` | ключ кеша (версия, способ, расширение, потолок текста, sha), хранилища на диске (с потолком размера) и в Redis (порт `CacheStore`) |
| `src/limiter.ts`, `src/truncate.ts`, `src/auth.ts`, `src/config.ts`, `src/log.ts`, `src/errors.ts` | очередь, потолок текста, ключ, настройки и `EXTRACTOR_VERSION`, журнал, коды ошибок |
| `src/main.ts` | запуск: настройки, выбор кеша, чистка раз в час |
| `tests/` | чистая логика + `server.test.ts` (HTTP на подставных исполнителях, без программ) + `integration.test.ts` (настоящие программы, пропускается без `soffice`) |

## Конвенции

- **Имя файла и текст в журнал — никогда.** Поля журнала закрыты типом `LogEntry`; новое поле —
  только несекретное. Текст ошибки наружу — без имени файла.
- **Сменил логику разбора — подними `EXTRACTOR_VERSION`**, иначе сутки отдаётся старый кеш.
- **Срок кеша — ровно 86400 с, не дольше**; чтение срок не продлевает; кешируется только успех.
- **Fail-closed:** без `EXTRACT_API_KEY` сервис не стартует (кроме `NODE_ENV=test`).
- **Только стираемый синтаксис TypeScript** (`erasableSyntaxOnly`): без `enum`, `namespace` и
  параметр-свойств конструктора — `--experimental-strip-types` их не исполнит. Импорты — с `.ts`.
- **Процессы разбора — только через `run()`**: окружение без секретов, свой рабочий каталог
  (cwd/HOME/XDG), таймаут, убийство группы (и после обычного завершения).
- **LibreOffice — без `--safe-mode`**: он отбрасывает профиль с `LO_REGISTRY` (проверено вживую).
- **Новый вход, от которого зависит ответ, — в ключ кеша** (`CacheKeyInput`).
- **Тест краснеет при мутации кода**; откат мутации — из копии, не `git checkout --`.
- Код и имена — по-английски; комментарии, документация, коммиты — по-русски.
- Штамп `> Last reviewed: YYYY-MM-DD` под заголовком каждого `.md`.
- Сторонние actions в CI — запинены на SHA.
