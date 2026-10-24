# syntax=docker/dockerfile:1
# Сервис разбора файлов. Две стадии: зависимости (только prod) и финальный образ с программами
# разбора. Код запускается напрямую через `node --experimental-strip-types` — сборки нет.

FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-slim AS runtime
WORKDIR /app
# Программы разбора (перенесено из ai-price-import): текст PDF, Office → текст/CSV, OCR с языками
# rus+bel+kaz+eng. fonts-dejavu-core — чтобы LibreOffice было чем рисовать кириллицу.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      libreoffice-calc libreoffice-writer \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus tesseract-ocr-bel tesseract-ocr-kaz \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
# Сборка падает СРАЗУ, если программа разбора сломана: переименованный пакет или неполная
# установка иначе прошли бы `docker build` и всплыли бы только на первом файле.
# poppler (`pdftotext -v`, `pdftoppm -v`) выходит с ненулевым кодом даже исправный, поэтому
# ищем строку версии через конвейер — решает код grep (без pipefail). Ищем «<программа> <цифра>»,
# а не голое имя: неисправная программа печатает «<программа>: error while loading shared
# libraries…», где имя есть, а версии нет. libreoffice --version — под `timeout` на случай
# зависания при создании профиля.
RUN set -eu; \
    pdftotext -v 2>&1 | grep -qiE 'pdftotext version [0-9]'; \
    pdftoppm -v 2>&1 | grep -qiE 'pdftoppm version [0-9]'; \
    HOME=/tmp timeout 60 libreoffice --version 2>&1 | grep -qiE 'libreoffice [0-9]'; \
    tesseract --version 2>&1 | grep -qiE 'tesseract [0-9]'; \
    langs="$(tesseract --list-langs 2>&1)"; \
    for l in rus bel kaz eng; do echo "$langs" | grep -qx "$l" || { echo "missing tesseract lang: $l" >&2; exit 1; }; done; \
    rm -rf /tmp/.config /tmp/*

ENV NODE_ENV=production \
    HOME=/tmp \
    CACHE_DIR=/tmp/file-extract-cache \
    OMP_THREAD_LIMIT=1 \
    PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Не root: пользователь `node` из базового образа.
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
