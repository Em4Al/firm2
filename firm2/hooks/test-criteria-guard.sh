#!/usr/bin/env bash
# Обёртка защиты от теста, проверяющего момент. PreToolUse(Write|Edit).
#
# Порядок поиска движка — тот же, что у write-guard.sh и stage-event.sh: engine_root из
# .firm/config (ИСХОДНИК, кэш плагина отстаёт), затем CLAUDE_PLUGIN_ROOT, затем каталог
# скрипта. Нет .firm/config — молча выходим: чужие проекты нас не касаются.
set -uo pipefail

payload="$(cat)"

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cfg="${project_dir}/.firm/config"
[ -f "$cfg" ] || exit 0

engine_root="$(sed -nE 's/^engine_root:[[:space:]]*"?([^"#]+)"?[[:space:]]*$/\1/p' "$cfg" | head -1)"
if [ -n "$engine_root" ] && [ -f "${engine_root}/scripts/test-criteria-guard.mjs" ]; then
  plugin_root="$engine_root"
else
  plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
fi

# Нет node — пропускаем: защита, которая ломает работу там, где её не на чем запустить,
# вреднее отсутствующей.
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$payload" | node "${plugin_root}/scripts/test-criteria-guard.mjs"
exit $?
