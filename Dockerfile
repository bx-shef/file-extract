# syntax=docker/dockerfile:1
# Сервис разбора файлов. Две стадии: зависимости (только prod) и финальный образ с программами
# разбора. Код запускается напрямую через `node --experimental-strip-types` — сборки нет.
# Базовый образ закреплён по digest (node:22-slim на 2026-10-24): тег двигается, digest — нет.
# Обновляет digest Dependabot (.github/dependabot.yml, экосистема docker).
#
# СЕТЬ: программы разбора открывают чужие документы, и LibreOffice умеет ходить по ссылкам из
# них. Настройки профиля это закрывают (src/extractRunners.ts, LO_REGISTRY), но граница — сеть:
# контейнер ОБЯЗАН жить в сети без выхода наружу (`internal: true` в compose или
# `--network none`). `unshare -n` внутри контейнера не используем: без CAP_SYS_ADMIN (а мы
# сбрасываем все права) и при стандартном seccomp Docker он не работает.

FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
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

# HOST=0.0.0.0 — явно: по умолчанию сервис слушает только 127.0.0.1, а в контейнере его должны
# видеть соседи по внутренней сети.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    HOME=/tmp \
    CACHE_DIR=/tmp/file-extract-cache \
    OMP_THREAD_LIMIT=1 \
    PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Не root: пользователь `node` из базового образа — числом, чтобы проверка «не root»
# (runAsNonRoot и т. п.) видела UID без чтения /etc/passwd.
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
