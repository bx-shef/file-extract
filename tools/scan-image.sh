#!/usr/bin/env bash
# Сканирование образа на уязвимости (Trivy) и SBOM (CycloneDX). Одна реализация для CI и для рук:
#   tools/scan-image.sh <образ> [каталог-результата]
# Образ — локальный (docker build -t file-extract .) или уже скачанный (ghcr.io/bx-shef/file-extract:<sha>).
# Результат в каталоге (по умолчанию ./scan-out): report.txt (таблица), sbom.cdx.json (CycloneDX), image.tar (временный, удаляется).
#
# Выход 0 — нет уязвимостей выше порога, у которых уже есть исправление; 1 — есть (SCAN_EXIT=0 — только отчёт);
# 2 — сам запуск не удался. Порог — SCAN_SEVERITY (по умолчанию HIGH,CRITICAL); без исправления (unfixed) не считаем:
# у базового образа их всегда много, и они не повод стопорить выпуск. Исключения — .trivyignore (причина и срок в комментарии).
#
# Trivy — контейнером, образ закреплён по digest (TRIVY_IMAGE). Образ сохраняется в tar и сканируется оттуда: сокет
# Docker внутрь не отдаём. Сеть нужна только за базой уязвимостей (кеш — том file-extract-trivy-cache).
# На машине разработки запуск — через обёртку лимитов: PW_RUN=../stand/tools/pw-run.sh tools/scan-image.sh <образ>
# (CLAUDE.md, «Разовые контейнеры проверок»). В CI PW_RUN не задан — обычный docker run с теми же лимитами.
set -euo pipefail

image="${1:-}"
[ -n "$image" ] || { sed -n '2,5p' "$0" >&2; exit 2; }
out="${2:-scan-out}"
severity="${SCAN_SEVERITY:-HIGH,CRITICAL}"
exit_code="${SCAN_EXIT:-1}"
# Trivy 0.76.2 (2026-11-05). Обновлять осознанно: новый digest — в этот файл, строка ниже.
trivy_image="${TRIVY_IMAGE:-ghcr.io/aquasecurity/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb}"

command -v docker >/dev/null || { echo 'scan-image: нужен docker' >&2; exit 2; }
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null || { echo "scan-image: образа нет: $image" >&2; exit 2; }

mkdir -p "$out"
# Путь для -v: в Git Bash на Windows нужен вид D:/…, иначе docker его не поймёт.
abs() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
out_abs="$(abs "$out")"
rm -f "$out/report.txt" "$out/sbom.cdx.json"
echo "scan-image: сохраняю образ в tar…" >&2
docker save "$image" -o "$out/image.tar"
trap 'rm -f "$out/image.tar"' EXIT

mounts=(-v "$out_abs:/out" -v file-extract-trivy-cache:/root/.cache)
ignore=()
if [ -f .trivyignore ]; then
  mounts+=(-v "$(abs .):/src:ro")
  ignore=(--ignorefile /src/.trivyignore)
fi

script='
trivy image --input /out/image.tar --severity "$SEV" --ignore-unfixed --exit-code "$EXIT" --format table --output /out/report.txt "$@"
rc=$?
trivy image --input /out/image.tar --skip-db-update --format cyclonedx --output /out/sbom.cdx.json >/dev/null
cat /out/report.txt
exit $rc
'
export MSYS_NO_PATHCONV=1
set +e
if [ -n "${PW_RUN:-}" ]; then
  PW_IMAGE="$trivy_image" "$PW_RUN" file-extract scan --entrypoint "" "${mounts[@]}" -e SEV="$severity" -e EXIT="$exit_code" -- \
    sh -c "$script" trivy "${ignore[@]}"
else
  docker run --rm --init --memory=2g --cpus=2 --label project=file-extract --label task=scan \
    "${mounts[@]}" -e SEV="$severity" -e EXIT="$exit_code" --entrypoint sh "$trivy_image" \
    -c "$script" trivy "${ignore[@]}"
fi
rc=$?
set -e
if [ ! -s "$out/sbom.cdx.json" ]; then echo 'scan-image: SBOM не получен' >&2; exit 2; fi
echo "scan-image: отчёт $out/report.txt, SBOM $out/sbom.cdx.json (код $rc)" >&2
exit "$rc"
