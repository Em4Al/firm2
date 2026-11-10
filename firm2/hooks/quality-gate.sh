#!/usr/bin/env bash
# Quality-gate hook движка (перенесён из agent-dev-firm без изменений по смыслу).
# Сам stack-agnostic: делегирует в ПРОЕКТНЫЙ скрипт, потому что линт/тесты зависят
# от стека — это граница движок↔проект. Проект кладёт проверки в .firm/hooks/<event>.sh.
#
# Контракт: проектный скрипт вернул != 0 → блокируем (exit 2); нет скрипта → no-op.
set -euo pipefail
event="${1:-unknown}"
project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
hook="${project_dir}/.firm/hooks/${event}.sh"

if [[ -x "$hook" ]]; then
  if "$hook"; then
    exit 0
  else
    code=$?
    echo "[firm2-quality-gate] проектная проверка ${event} провалилась (код ${code}) — блокирую" >&2
    exit 2
  fi
fi
exit 0
