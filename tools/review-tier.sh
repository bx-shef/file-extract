#!/usr/bin/env bash
# Уровень ревью PR по путям изменённых файлов (решение владельца 2026-11-07, bx-shef/toolsai-stand#42).
#
# Уровни (легенда — `--levels`, ниже она же):
#   0 — без ревью, только основная проверка репозитория;
#   1 — мелкое поведение: /code-review medium --max-findings 5, уровень max запрещён;
#   2 — деньги, лицензия, безопасность, установщик, сборка, CI, Dockerfile и образы, публичный API,
#       схема таблиц: панель из пяти параллельно (навык review-panel), /code-review при панели не зовём.
#
# Уровень PR — наибольший из уровней его файлов. Правила — рядом, tools/review-tier.rules:
#   <0|1|2> <шаблон>              первое подходящее правило выигрывает, нет подходящего — уровень 1.
#                                 Шаблон — как в case оболочки: «*» покрывает и «/», пробелов нет;
#                                 несколько шаблонов одного уровня — через «|»
#   <0|1|2> <шаблон> only:<ERE>   правило действует, только если ВСЕ изменённые строки файла подходят
#                                 под ERE (правка одной строки «version»); без git (--files) не действует
#   hold <шаблон>                 путь «только по слову владельца»: уровень 2 и пометка в выводе
#   case <0|1|2> <путь>           таблица случаев: --self-test сверяет её с правилами
#
# Ручной уровень главнее автоматического: --level 0|1|2 или переменная REVIEW_TIER. Вывод показывает
# оба: «вручную 2, по путям 1». Поднять уровень можно, понизить — только владелец (ручной уровень
# ниже автоматического печатает предупреждение).
#
# Эталон — bx-shef/toolsai (tools/review-tier.sh); в остальных репозиториях — побайтная копия,
# правки только в эталоне. Своё у репозитория — tools/review-tier.rules.
# Работает на macOS (bash 3.2), в Windows (Git Bash, WSL) и в облачной сессии (Linux, мелкий клон):
# только POSIX-утилиты (git, awk, grep, sed, sort, mktemp) и подмножество bash 3.2 — без sed -i,
# grep -P, date -d, realpath, mapfile и ассоциативных массивов. CRLF в правилах и путях терпит.
#
#   tools/review-tier.sh [--base <ссылка>]   уровень ветки одной цифрой; база — merge-base с origin/main
#                                            (нет — main, затем origin/HEAD)
#   tools/review-tier.sh --level N           ручной уровень (или REVIEW_TIER=N); вместе с --action/--explain
#   tools/review-tier.sh --explain           по файлам: уровень и сработавшее правило
#   tools/review-tier.sh --action            уровень и что делать — одной строкой
#   tools/review-tier.sh --files             пути со стандартного ввода вместо git diff
#   tools/review-tier.sh --levels            легенда уровней: что значит, какое ревью, примеры
#   tools/review-tier.sh --self-test         сверка движка и таблицы случаев (её зовёт основная проверка)
#
# Код возврата: 0 — готово; 1 — самопроверка не сошлась; 2 — ошибка запуска или правил; 3 — нет базы.

set -u
set -f

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RULES_FILE="${REVIEW_TIER_RULES:-$ROOT/tools/review-tier.rules}"
CR=$'\r'

RL=(); RP=(); RO=(); RH=()   # правила: уровень, шаблон, only-регулярка, пометка hold
CL=(); CP=()                 # таблица случаев: ожидаемый уровень и путь
BASE_COMMIT=''
APPROX=0
LEVEL=1
HELD=0
RULE_TEXT=''
EFFECTIVE=1
LOWERED=0

err() { echo "  ✗ уровень ревью: $*" >&2; }

is_level() { case "$1" in 0|1|2) return 0 ;; *) return 1 ;; esac; }

levels_text()
{
	cat <<'LEGEND'
Уровни ревью PR (решение владельца 2026-11-07). Уровень PR — наибольший из уровней его файлов.

  0  Без ревью — только основная проверка репозитория.
     Что: документы, ленты («Что нового»), версии, карта проекта, тесты без кода модуля,
          .gitattributes, стенд без изменения модуля.
     Например: правка главы справки, строка в CHANGELOG, подъём версии, новый тест.

  1  Мелкое поведение — /code-review medium --max-findings 5 (уровень max запрещён).
     Что: всё, что не 0 и не 2.
     Например: исправление в одном классе, текст интерфейса, новая настройка без денег и прав.

  2  Панель из пяти параллельно (навык review-panel); /code-review при панели не зовём.
     Что: деньги, лицензия, безопасность, установщик, сборка, CI, Dockerfile и образы,
          публичный API, схема таблиц.
     Например: расчёт квоты или цены, проверка лицензии, токен и права, install/index.php,
          build.sh, Dockerfile, публичный сервис для соседей, новая таблица.

Вручную: --level N или REVIEW_TIER=N; поднять уровень можно, понизить — только владелец.
LEGEND
}

# Правило с альтернативами «a|b|c» — по записи на каждую.
add_rule()
{
	local lvl="$1" alts="$2" only="$3" hold="$4" one
	while [ -n "$alts" ]
	do
		one="${alts%%|*}"
		if [ "$one" = "$alts" ]; then alts=''; else alts="${alts#*|}"; fi
		[ -n "$one" ] || continue
		RL[${#RL[@]}]="$lvl"; RP[${#RP[@]}]="$one"; RO[${#RO[@]}]="$only"; RH[${#RH[@]}]="$hold"
	done
}

# Разбор файла правил в RL/RP/RO/RH и CL/CP. Ошибка в строке — отказ с номером строки.
# Концы строк CRLF и метка BOM в начале файла (редактор Windows) терпятся.
load_rules()
{
	local file="$1" raw line n=0 bad=0 only
	RL=(); RP=(); RO=(); RH=(); CL=(); CP=()
	if [ ! -f "$file" ]
	then
		err "нет файла правил: $file"
		return 1
	fi
	while IFS= read -r raw || [ -n "$raw" ]
	do
		n=$((n + 1))
		raw="${raw%$CR}"
		[ $n -ne 1 ] || raw="${raw#$'\xEF\xBB\xBF'}"
		line="${raw%%[[:space:]]#*}"
		set -- $line
		[ $# -gt 0 ] || continue
		case "$1" in '#'*) continue ;; esac
		if [ "$1" = case ]
		then
			if [ $# -ne 3 ] || ! is_level "$2"
			then
				err "$file:$n: ожидается «case <0|1|2> <путь>»"; bad=1; continue
			fi
			CL[${#CL[@]}]="$2"; CP[${#CP[@]}]="$3"
			continue
		fi
		if [ "$1" = hold ]
		then
			[ $# -eq 2 ] || { err "$file:$n: ожидается «hold <шаблон>»"; bad=1; continue; }
			add_rule 2 "$2" '' 1
			continue
		fi
		if [ $# -lt 2 ] || [ $# -gt 3 ] || ! is_level "$1"
		then
			err "$file:$n: ожидается «<0|1|2> <шаблон> [only:<ERE>]»"; bad=1; continue
		fi
		only=''
		if [ $# -eq 3 ]
		then
			case "$3" in
				only:?*) only="${3#only:}" ;;
				*) err "$file:$n: третье слово — только only:<ERE>"; bad=1; continue ;;
			esac
		fi
		add_rule "$1" "$2" "$only" 0
	done < "$file"
	[ $bad -eq 0 ]
}

# Все изменённые строки файла (без знака +/-) подходят под ERE? Нужны BASE_COMMIT и git.
only_matches()
{
	local f="$1" re="$2" lines
	[ -n "$BASE_COMMIT" ] || return 1
	lines="$(git -c core.quotepath=false diff -U0 --no-color --no-renames "$BASE_COMMIT" -- "$f" 2>/dev/null \
		| awk '/^@@/ { h = 1; next } h && /^[+-]/ { print substr($0, 2) }')"
	[ -n "$lines" ] || return 1
	if printf '%s\n' "$lines" | grep -vqE -- "$re"
	then
		return 1
	fi
	return 0
}

# Уровень одного файла: LEVEL, HELD и RULE_TEXT. Нет подходящего правила — уровень 1.
classify()
{
	local f="${1%$CR}" i=0 n=${#RL[@]}
	LEVEL=1
	HELD=0
	RULE_TEXT='нет правила'
	while [ $i -lt $n ]
	do
		case "$f" in
			${RP[$i]})
				if [ -z "${RO[$i]}" ] || only_matches "$f" "${RO[$i]}"
				then
					LEVEL="${RL[$i]}"
					HELD="${RH[$i]}"
					RULE_TEXT="${RP[$i]}"
					[ -z "${RO[$i]}" ] || RULE_TEXT="$RULE_TEXT only:${RO[$i]}"
					[ "$HELD" = 0 ] || RULE_TEXT="$RULE_TEXT · слово владельца"
					return 0
				fi
				;;
		esac
		i=$((i + 1))
	done
	return 0
}

action_text()
{
	case "$1" in
		0) echo 'без ревью — только основная проверка репозитория' ;;
		1) echo '/code-review medium --max-findings 5 (уровень max запрещён)' ;;
		2) echo 'панель из пяти параллельно (навык review-panel), /code-review не звать' ;;
	esac
}

# Итоговый уровень: ручной главнее автоматического. LOWERED=1, если ручной ниже.
combine_levels()
{
	local auto="$1" manual="$2"
	EFFECTIVE="$auto"
	LOWERED=0
	if [ -n "$manual" ]
	then
		EFFECTIVE="$manual"
		[ "$manual" -ge "$auto" ] || LOWERED=1
	fi
}

# База сравнения: BASE_COMMIT. Порядок: заданная --base, затем origin/main, main, origin/HEAD.
# Нет общей базы (мелкий клон) — вершина базы целиком, APPROX=1: уровень ориентировочный.
# Вызывать в основной оболочке, не в $(…): иначе значения не дойдут до only:.
setup_base()
{
	local want="$1" b
	if ! command -v git >/dev/null 2>&1
	then
		echo '  ! уровень ревью: git не найден — передайте пути через --files' >&2
		return 3
	fi
	if ! git rev-parse --git-dir >/dev/null 2>&1
	then
		echo '  ! уровень ревью: это не git-репозиторий — передайте пути через --files' >&2
		return 3
	fi
	if [ -n "$want" ]
	then
		git rev-parse -q --verify "$want^{commit}" >/dev/null 2>&1 || {
			echo "  ! уровень ревью: нет ссылки $want — «git fetch origin main» или другая --base" >&2
			return 3
		}
		b="$want"
	else
		b=''
		for want in origin/main main origin/HEAD
		do
			if git rev-parse -q --verify "$want^{commit}" >/dev/null 2>&1
			then
				b="$want"
				break
			fi
		done
		if [ -z "$b" ]
		then
			echo '  ! уровень ревью: нет origin/main, main и origin/HEAD — выполните «git fetch origin main», задайте --base <ссылка> или передайте пути через --files' >&2
			return 3
		fi
	fi
	BASE_COMMIT="$(git merge-base "$b" HEAD 2>/dev/null)" || BASE_COMMIT=''
	if [ -z "$BASE_COMMIT" ]
	then
		BASE_COMMIT="$(git rev-parse "$b^{commit}" 2>/dev/null)" || return 3
		APPROX=1
		echo "  ! уровень ревью: нет общей базы с $b (мелкий клон?) — уровень ориентировочный; «git fetch --unshallow» или «git fetch origin main» даст точный" >&2
	fi
	return 0
}

# Изменённые файлы ветки от BASE_COMMIT: правки рабочего дерева и новые файлы тоже.
# Переименование — удаление и добавление: считаются оба пути.
changed_files()
{
	{
		git -c core.quotepath=false diff --name-only --no-renames "$BASE_COMMIT"
		git -c core.quotepath=false ls-files --others --exclude-standard
	} | sort -u
}

# --self-test ----------------------------------------------------------------------------------

st_bad=0

st_expect()
{
	local want="$1" path="$2" what="$3"
	classify "$path"
	if [ "$LEVEL" != "$want" ]
	then
		err "$what: $path — получен уровень $LEVEL ($RULE_TEXT), ждали $want"
		st_bad=1
	fi
}

st_expect_held()
{
	local want="$1" path="$2" what="$3"
	classify "$path"
	if [ "$HELD" != "$want" ]
	then
		err "$what: $path — пометка «слово владельца» = $HELD, ждали $want"
		st_bad=1
	fi
}

st_eq()
{
	local want="$1" got="$2" what="$3"
	if [ "$got" != "$want" ]
	then
		err "$what: получено «${got}», ждали «${want}»"
		st_bad=1
	fi
}

# Движок на своих правилах: порядок, умолчание, альтернативы, hold, ручной уровень, CRLF и,
# если есть git, only: и выбор базы на временном репозитории.
self_test_engine()
{
	local rules crlf tmp out
	# Подтесты не должны видеть чужие настройки: ни подмену правил, ни ручной уровень из окружения.
	unset REVIEW_TIER REVIEW_TIER_RULES
	rules="$(mktemp)" || { st_bad=1; return 1; }
	cat > "$rules" <<'RULES'
0 held/feed/*
hold held/*
0 docs/*
0 pkg.json only:^[[:space:]]*"version":
2 pkg.json
2 lib/license/*|lib/quota/*
1 lib/license/readme.txt
0 *.md
RULES
	if ! load_rules "$rules"
	then
		rm -f "$rules"; st_bad=1; return 1
	fi

	BASE_COMMIT=''
	st_expect 0 docs/a/b.md 'движок: шаблон покрывает «/»'
	st_expect 2 lib/license/x.php 'движок: каталог'
	st_expect 2 lib/quota/x.php 'движок: альтернатива после «|»'
	st_expect 2 lib/license/readme.txt 'движок: первое правило выигрывает'
	st_expect 1 lib/other.php 'движок: нет правила — уровень 1'
	st_expect 0 README.md 'движок: файл в корне по *.md'
	st_expect 2 pkg.json 'движок: only: без git не действует'
	st_expect 2 held/page.html 'движок: hold — уровень 2'
	st_expect_held 1 held/page.html 'движок: hold помечает путь'
	st_expect_held 0 held/feed/a.json 'движок: исключение выше hold не помечается'
	st_expect_held 0 docs/a.md 'движок: обычный путь не помечается'
	st_expect 0 "README.md$CR" 'движок: CR в конце пути срезается'
	st_expect 0 'docs/Лента.md' 'движок: кириллица в пути'

	combine_levels 1 ''
	st_eq '1 0' "$EFFECTIVE $LOWERED" 'ручной уровень не задан'
	combine_levels 1 2
	st_eq '2 0' "$EFFECTIVE $LOWERED" 'ручной выше автоматического'
	combine_levels 2 0
	st_eq '0 1' "$EFFECTIVE $LOWERED" 'ручной ниже автоматического — предупреждение'
	st_eq 'yes' "$(levels_text | grep -q '^  0  ' && levels_text | grep -q '^  1  ' && levels_text | grep -q '^  2  ' && echo yes)" 'легенда: три уровня'

	# CRLF в файле правил, пустые строки и метка BOM; ручной уровень в самом скрипте.
	crlf="$(mktemp)" || { rm -f "$rules"; st_bad=1; return 1; }
	{ printf '\357\273\277# правила\r\n\r\n0 docs/*\r\n2 lib/quota/*\r\ncase 0 docs/a.md\r\ncase 2 lib/quota/x.php\r\n'; } > "$crlf"
	out="$(printf 'docs/a.md\r\n' | REVIEW_TIER_RULES="$crlf" bash "$SELF" --files 2>&1)"
	st_eq '0' "$out" 'CLI: правила и пути с CRLF'
	out="$(printf 'docs/a.md\n' | REVIEW_TIER_RULES="$crlf" bash "$SELF" --files --level 2 --action 2>&1)"
	case "$out" in
		"уровень 2 (вручную 2, по путям 0): "*) ;;
		*) err "CLI: --level 2 при уровне по путям 0 — получено «${out}»"; st_bad=1 ;;
	esac
	out="$(printf 'lib/quota/x.php\n' | REVIEW_TIER_RULES="$crlf" REVIEW_TIER=0 bash "$SELF" --files --action 2>&1)"
	case "$out" in
		*"понижает только владелец"*"вручную 0, по путям 2"*) ;;
		*) err "CLI: REVIEW_TIER=0 при уровне по путям 2 — получено «${out}»"; st_bad=1 ;;
	esac
	# Сообщения с «${переменная}» и кириллицей — под локалями, где байты ≥ 0x80 путают разбор имени переменной;
	# предупреждение bash о несуществующей локали (setlocale) не в счёт.
	for loc in C C.UTF-8 en_US.ISO-8859-1; do
		out="$(printf 'docs/a.md\n' | LC_ALL="$loc" REVIEW_TIER_RULES="$crlf" bash "$SELF" --files --level 7 2>&1 | grep -v 'setlocale')"
		case "$out" in
			*"ожидается 0, 1 или 2"*) ;;
			*) err "CLI: --level 7 под локалью ${loc} должен отказывать — получено «${out}»"; st_bad=1 ;;
		esac
		out="$(printf 'docs/a.md\r\n' | LC_ALL="$loc" REVIEW_TIER_RULES="$crlf" bash "$SELF" --files --level 2 --action 2>&1 | grep -v 'setlocale')"
		case "$out" in
			"уровень 2 (вручную 2, по путям 0): "*) ;;
			*) err "CLI: --level 2 под локалью ${loc} — получено «${out}»"; st_bad=1 ;;
		esac
	done
	rm -f "$rules" "$crlf"

	if ! command -v git >/dev/null 2>&1
	then
		echo '  ! уровень ревью: git не найден — проверки only: и выбора базы пропущены' >&2
		return 0
	fi
	tmp="$(mktemp -d)" || { st_bad=1; return 1; }
	if ! (
		cd "$tmp" || exit 1
		HOME="$tmp"; XDG_CONFIG_HOME="$tmp/.xdg"
		export HOME XDG_CONFIG_HOME GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
		git init -q . && git symbolic-ref HEAD refs/heads/main \
			&& git config user.email t@t && git config user.name t && git config core.autocrlf false \
			&& mkdir tools docs \
			&& cp "$SELF" tools/review-tier.sh \
			&& printf '{\n  "version": "1.0.0",\n  "name": "x"\n}\n' > pkg.json \
			&& printf '# a\n' > docs/a.md \
			&& printf '0 docs/*\n0 pkg.json only:^[[:space:]]*"version":\n2 pkg.json\ncase 0 docs/a.md\ncase 1 x.y\ncase 2 pkg.json\n' > tools/review-tier.rules \
			&& git add . && git -c commit.gpgsign=false commit -q --no-verify -m base \
			&& git checkout -q -b feature
	) >/dev/null 2>&1
	then
		echo '  ! уровень ревью: не удалось собрать временный git-репозиторий — проверки only: и выбора базы пропущены' >&2
		rm -rf "$tmp"
		return 0
	fi
	(
		cd "$tmp" || exit 1
		HOME="$tmp"; XDG_CONFIG_HOME="$tmp/.xdg"
		export HOME XDG_CONFIG_HOME GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
		bad=0
		out="$(bash tools/review-tier.sh 2>&1)"
		[ "$out" = 0 ] || { err "git: ветка без изменений — получено «${out}», ждали 0"; bad=1; }
		sed 's/1\.0\.0/1.0.1/' pkg.json > pkg.new && mv pkg.new pkg.json
		out="$(bash tools/review-tier.sh 2>&1)"
		[ "$out" = 0 ] || { err "git: правка одной строки version — получено «${out}», ждали 0"; bad=1; }
		sed 's/"name": "x"/"name": "y"/' pkg.json > pkg.new && mv pkg.new pkg.json
		out="$(bash tools/review-tier.sh 2>&1)"
		[ "$out" = 2 ] || { err "git: правка не только version — получено «${out}», ждали 2"; bad=1; }
		printf 'new\n' > docs/b.md
		out="$(bash tools/review-tier.sh --explain 2>&1)"
		case "$out" in
			*"0  docs/b.md"*) ;;
			*) err 'git: новый неотслеживаемый файл должен попасть в список'; bad=1 ;;
		esac
		out="$(bash tools/review-tier.sh --base nope 2>&1)"
		case "$out" in
			*"нет ссылки nope"*) ;;
			*) err "git: неизвестная --base должна отказывать — получено «${out}»"; bad=1 ;;
		esac
		exit $bad
	) || st_bad=1
	rm -rf "$tmp"
}

# Правило, которому не соответствует ни один файл репозитория: путь переименован или удалён,
# и правило молча перестало работать. Только предупреждение.
warn_dead_rules()
{
	local files i=0 n=${#RL[@]} f hit
	command -v git >/dev/null 2>&1 || return 0
	files="$(git -C "$ROOT" -c core.quotepath=false ls-files 2>/dev/null)" || return 0
	[ -n "$files" ] || return 0
	while [ $i -lt $n ]
	do
		hit=0
		while IFS= read -r f
		do
			f="${f%$CR}"
			case "$f" in
				${RP[$i]}) hit=1; break ;;
			esac
		done <<< "$files"
		[ $hit -eq 1 ] || echo "  ! уровень ревью: правилу «${RP[$i]}» не соответствует ни один файл репозитория" >&2
		i=$((i + 1))
	done
}

self_test()
{
	local i n lv found

	self_test_engine

	load_rules "$RULES_FILE" || return 1
	BASE_COMMIT=''
	n=${#CL[@]}
	if [ "$n" -eq 0 ]
	then
		err "в $RULES_FILE нет строк «case» — таблицы случаев"
		return 1
	fi
	for lv in 0 1 2
	do
		i=0; found=0
		while [ $i -lt "$n" ]
		do
			[ "${CL[$i]}" = "$lv" ] && found=1
			i=$((i + 1))
		done
		if [ $found -eq 0 ]
		then
			err "в таблице случаев нет ни одного пути уровня $lv"
			st_bad=1
		fi
	done
	i=0
	while [ $i -lt "$n" ]
	do
		st_expect "${CL[$i]}" "${CP[$i]}" 'таблица случаев'
		i=$((i + 1))
	done

	if [ $st_bad -ne 0 ]
	then
		return 1
	fi
	warn_dead_rules
	echo "  ✓ уровень ревью: движок и таблица случаев в порядке (случаев — $n, правил — ${#RL[@]})"
	return 0
}

# main -----------------------------------------------------------------------------------------

mode=level
from_stdin=0
base_ref=''
manual="${REVIEW_TIER:-}"
manual="${manual%$CR}"

while [ $# -gt 0 ]
do
	case "$1" in
		--explain) mode=explain ;;
		--action) mode=action ;;
		--self-test) mode=selftest ;;
		--levels) levels_text; exit 0 ;;
		--files) from_stdin=1 ;;
		--base) shift; base_ref="${1:-}"; [ -n "$base_ref" ] || { err '--base требует ссылку'; exit 2; } ;;
		--level) shift; manual="${1:-}"; [ -n "$manual" ] || { err '--level требует 0, 1 или 2'; exit 2; } ;;
		-h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; echo; levels_text; exit 0 ;;
		*) err "неизвестный ключ: $1"; exit 2 ;;
	esac
	shift
done

if [ -n "$manual" ] && ! is_level "$manual"
then
	err "ручной уровень «${manual}»: ожидается 0, 1 или 2 (--level, REVIEW_TIER)"
	exit 2
fi

if [ "$mode" = selftest ]
then
	self_test
	exit $?
fi

load_rules "$RULES_FILE" || exit 2

if [ $from_stdin -eq 1 ]
then
	files="$(cat)"
else
	cd "$ROOT" || exit 2
	setup_base "$base_ref" || exit 3
	files="$(changed_files)"
fi

max=0
count=0
held=0
OLDIFS="$IFS"
IFS='
'
for f in $files
do
	f="${f%$CR}"
	[ -n "$f" ] || continue
	count=$((count + 1))
	classify "$f"
	[ "$LEVEL" -gt "$max" ] && max="$LEVEL"
	[ "$HELD" = 0 ] || held=$((held + 1))
	[ "$mode" = explain ] && echo "$LEVEL  $f  ($RULE_TEXT)"
done
IFS="$OLDIFS"

combine_levels "$max" "$manual"
approx=''
[ "$APPROX" -eq 0 ] || approx=' · ориентировочно (мелкий клон)'
if [ "$LOWERED" -eq 1 ]
then
	echo "  ! уровень ревью: вручную $manual ниже, чем по путям $max — понижает только владелец" >&2
fi

case "$mode" in
	explain)
		[ "$count" -gt 0 ] || echo '  нет изменённых файлов'
		echo "по путям: $max$approx"
		[ -z "$manual" ] || echo "вручную: $manual"
		echo "итого: $EFFECTIVE"
		;;
	action)
		note=''
		[ "$held" -eq 0 ] || note=" · файлов только по слову владельца: $held"
		head="уровень $EFFECTIVE"
		[ -z "$manual" ] || head="$head (вручную $manual, по путям $max)"
		echo "$head: $(action_text "$EFFECTIVE")$note$approx"
		;;
	*)
		echo "$EFFECTIVE"
		;;
esac
exit 0
