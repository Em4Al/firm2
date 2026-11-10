#!/usr/bin/env bash
# Хук переходов firm2 (ADR-0002 в редакции после проверки окружения).
#
# Вызывается РАНТАЙМОМ Claude Code на SubagentStart/SubagentStop. Модель в этой точке
# хода не имеет, поэтому «закончил, но не записал событие» невозможно: либо субагент
# завершился и хук отработал, либо не завершился вовсе.
#
# Всё решение принимает код в firm-event.mjs:
#   стадия  = agent_type (firm-developer → dev, firm-tester → test, firm-reviewer-qa → review);
#   тикет   = маркер FIRM2-TICKET из промпта, который написал workflow-скрипт;
#   вердикт = structured output роли (машинный JSON), а не пересказ транскрипта.
#
# Нет .firm/config с engine: firm2 → молча выходим: чужие проекты нас не касаются.
set -uo pipefail

# Откуда брать код движка, по убыванию приоритета:
#   1. engine_root из .firm/config проекта — ИСХОДНИК. Плагин при установке копируется
#      в ~/.claude/plugins/cache, и кэш отстаёт: проверенные грабли, а не предположение.
#      Пока firm2 обкатывается, править исходник и гонять кэш — верный способ
#      потратить час на отладку уже исправленного дефекта;
#   2. CLAUDE_PLUGIN_ROOT от рантайма;
#   3. каталог самого скрипта — хук обязан работать даже при ручном вызове.
payload="$(cat)"

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cfg="${project_dir}/.firm/config"
engine_root=""
if [ -f "$cfg" ]; then
  engine_root="$(sed -nE 's/^engine_root:[[:space:]]*"?([^"#]+)"?[[:space:]]*$/\1/p' "$cfg" | head -1)"
fi
if [ -n "$engine_root" ] && [ -f "${engine_root}/scripts/firm-event.mjs" ]; then
  plugin_root="$engine_root"
else
  plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[firm2] node не найден — событие перехода не записано" >&2
  exit 1
fi

printf '%s' "$payload" | node "${plugin_root}/scripts/firm-event.mjs" hook
code=$?

# exit 2 из firm-event.mjs — «событие записано, но БЕЗ тикета». Дыра в статистике
# должна быть громкой: незамеченная делает недостоверной всю метрику.
exit $code
