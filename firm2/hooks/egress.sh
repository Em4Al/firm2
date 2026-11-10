#!/usr/bin/env bash
# Обёртка расписки об отправке наружу. Вызывается рантаймом на PreToolUse — для Bash
# (команды вроде `git push`, `curl`) и для WebFetch/WebSearch, которые отправляют запрос
# мимо и песочницы, и git.
#
# Расписка ничего не держит и падать не вправе: учёт, сломавший отправку, вреднее
# отсутствующего (ADR-0014). Поэтому выход здесь всегда нулевой.
#
# Откуда брать код движка — тот же порядок, что у stage-event.sh: engine_root из
# .firm/config (ИСХОДНИК, кэш плагина отстаёт), затем CLAUDE_PLUGIN_ROOT, затем каталог
# скрипта. Нет .firm/config с engine: firm2 — молча выходим, чужие проекты нас не касаются.
set -uo pipefail

payload="$(cat)"

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cfg="${project_dir}/.firm/config"
[ -f "$cfg" ] || exit 0

engine_root="$(sed -nE 's/^engine_root:[[:space:]]*"?([^"#]+)"?[[:space:]]*$/\1/p' "$cfg" | head -1)"
if [ -n "$engine_root" ] && [ -f "${engine_root}/scripts/egress.mjs" ]; then
  plugin_root="$engine_root"
else
  plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
fi

# Нет node — пропускаем. Защита, которая ломает работу там, где её просто не на чем
# запустить, вреднее отсутствующей: стадия встанет на ровном месте и без объяснения.
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$payload" | node "${plugin_root}/scripts/egress.mjs"
# Код расписки наружу не отдаём: она не гвард (ADR-0014).
exit 0
