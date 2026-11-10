// Две защиты поверх хуков (разбор Д-16/Д-17 05.10.2026):
//
//   1. bash-guard.mjs (PreToolUse/Bash) — стадия не отключает песочницу молча.
//   2. SubagentStart в firm-event.mjs держит ПАУЗУ кодом, а не словом в промпте.
//
// Плюс pauseState/pauseFilePath, переехавшие в lib/firm.mjs — у них теперь два читателя
// (команда `paused` и этот самый хук), и оба должны видеть одно и то же.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { listEvents, writeEvent, pauseState, pauseFilePath, worktreesDir } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

// ── pauseState / pauseFilePath ────────────────────────────────────────────────

test('pauseState: файла нет — paused: false', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  assert.deepEqual(pauseState(p.root), { paused: false })
})

test('pauseState: файл есть — paused: true, и его поля доезжают до результата', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(dirname(pauseFilePath(p.root)), { recursive: true })
  writeFileSync(pauseFilePath(p.root), JSON.stringify({ ts: '2026-10-05T10:00:00.000Z', reason: 'демо' }))
  assert.deepEqual(pauseState(p.root), { paused: true, ts: '2026-10-05T10:00:00.000Z', reason: 'демо' })
})

test('pauseState: битый JSON всё равно значит paused: true — неизвестность останавливает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(dirname(pauseFilePath(p.root)), { recursive: true })
  writeFileSync(pauseFilePath(p.root), '{ не json')
  assert.equal(pauseState(p.root).paused, true)
})

// ── bash-guard.mjs (PreToolUse/Bash) ──────────────────────────────────────────

function bashGuard(p, cwd, toolInput) {
  return p.cli('bash-guard.mjs', [], { input: JSON.stringify({ cwd, tool_input: toolInput }) })
}

// Рабочее дерево через КОНВЕНЦИЮ (`worktreesDir` без ключа в конфиге — ровно тот путь,
// который движок считает «своим» по умолчанию): <родитель корня>/<имя корня>.worktrees/<id>.
function conventionWorktree(p, ticket, branch = `task/${ticket}`) {
  const wt = join(worktreesDir(p.root, null), ticket)
  p.git('worktree', 'add', '-q', '-B', branch, wt, `feature/${p.change}`)
  return wt
}

// Рабочее дерево ВНЕ конвенции и вне конфига — его найти может только запасной способ,
// `git worktree list`, и только если ветка похожа на `task/T-XXX` (иначе и запасной
// способ дерево не признает).
function siblingWorktree(p, ticket, branch = `task/${ticket}`) {
  const wt = p.sibling(ticket)
  p.git('worktree', 'add', '-q', '-B', branch, wt, `feature/${p.change}`)
  return wt
}

// ── Долгое ожидание в стадии (разбор 30.10.2026) ──────────────────────────────
//
// Стадия, запустившая прогон на полчаса, дождаться его не может: вызов обрывается
// примерно на десяти минутах, и она входит в цикл `sleep`. Замер волны проект-В: 7.3 часа
// из 15.1 часа стадий — внутри таких циклов, у стадии теста T-199 — 140 минут из 155.
// Это признак, что прогон стадии не по размеру, и чинится он не терпением.

test('bash-guard: цикл опроса с видимой границей дольше пяти минут — exit 2 с рецептом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'for i in $(seq 1 29); do [ -f $TMPDIR/done ] && break; sleep 20; done' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /ДОЛГОЕ ОЖИДАНИЕ В СТАДИИ/)
  assert.match(r.stderr, /около 10 мин/, 'сказано, сколько именно команда намерена спать')
  assert.match(r.stderr, /ТОЧКА ВЕТВЛЕНИЯ/, 'рецепт назван: обе половины сравнения снимает движок')
  assert.match(r.stderr, /адресно/i, 'и чем проверять своё')
})

test('bash-guard: цикл без видимой границы — тоже отказ, и назван именно так', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'until [ -f $TMPDIR/done ]; do sleep 30; done; echo ok' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /цикл без видимой границы/,
    'неизвестное число оборотов — это не ноль: именно так и спали часами')
})

test('bash-guard: короткая пауза и короткий цикл проходят молча', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  for (const cmd of ['sleep 5; curl localhost:8080', 'for i in $(seq 1 3); do sleep 20; done', 'pytest -q']) {
    const r = bashGuard(p, wt, { command: cmd })
    assert.equal(r.status, 0, `«${cmd}» не должна была упереться: ${r.stderr}`)
    assert.equal(r.stderr, '')
  }
})

test('bash-guard: в дереве ДВИЖКА ожидание законно — там и живут долгие прогоны', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = join(worktreesDir(p.root, null), '_base')
  mkdirSync(wt, { recursive: true })
  p.git('worktree', 'add', '-q', '--detach', wt, 'main')
  const r = bashGuard(p, wt, { command: 'until [ -f $TMPDIR/done ]; do sleep 30; done' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '', 'основание сверки снимается именно долгим прогоном — это его работа')
})

test('bash-guard: проект разрешил ожидания — вызов проходит, но пишется событием', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'guard:\n  long_wait: allow\n' })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'until [ -f x ]; do sleep 30; done' })
  assert.equal(r.status, 0, r.stderr)
  const ev = listEvents(p.root, {}).filter((e) => e.event === 'long-wait')
  assert.equal(ev.length, 1, 'разрешение не делает ожидание невидимым — иначе это снятая молча защита')
  assert.match(ev[0].notes, /long_wait: allow/)
})

test('bash-guard: флага нет вовсе — exit 0, молча, даже из рабочего дерева', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'ls' })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '', 'нечего объяснять — защита не сработала')
})

test('bash-guard: флаг false — exit 0, молча', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'ls', dangerouslyDisableSandbox: false })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
})

test('bash-guard: флаг true, cwd в рабочем дереве по КОНВЕНЦИИ worktreesDir — exit 2', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Ветка нарочно НЕ похожа на task/T-XXX: запасной способ (git worktree list) эту
  // задачу не нашёл бы, так что отказ здесь доказывает именно путь через worktreesDir.
  const wt = conventionWorktree(p, 'T-001', 'scratch/mine')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'rm -rf /' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /снятие песочницы стадией ЗАПРЕЩЕНО/)
  assert.match(r.stderr, /rm -rf/)
})

test('bash-guard: флаг "true" строкой, cwd в рабочем дереве ЧЕРЕЗ ЗАПАСНОЙ способ (git worktree list) — exit 2', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Вне конвенции worktreesDir — найти это дерево может только обход `git worktree list`.
  const wt = siblingWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: 'true', command: 'rm -rf /' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /снятие песочницы стадией ЗАПРЕЩЕНО/)
})

test('bash-guard: флаг true, cwd в ГЛАВНОМ дереве — exit 0, но с предупреждением (ADR-0009)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conventionWorktree(p, 'T-001') // живое дерево задачи есть, но cwd вызова — не оно
  const r = bashGuard(p, p.root, { dangerouslyDisableSandbox: true, command: 'curl localhost' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /главное дерево.*решение твоё/s)
})

test('bash-guard: guard.sandbox_off: allow снимает запрет и пишет событие guard/sandbox-off', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'guard:\n  sandbox_off: allow\n',
  })
  const wt = siblingWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'серверный процесс' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /guard\.sandbox_off: allow/)

  const evs = listEvents(p.root, { change: p.change })
  const guardEvents = evs.filter((e) => e.stage === 'guard' && e.event === 'sandbox-off')
  assert.equal(guardEvents.length, 1, 'разрешённое снятие обязано быть видно в журнале')
  assert.equal(guardEvents[0].ticket, 'T-001', 'привязка — через то же дерево, что и у запрета')
  assert.equal(guardEvents[0].actor, 'bash-guard')
  assert.match(guardEvents[0].notes, /серверный процесс/)
})

test('bash-guard: проект не под firm2 — молчит даже при флаге true из рабочего дерева', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  writeFileSync(join(p.root, '.firm', 'config'), 'engine: agent-dev-firm\n')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'rm -rf /' })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '', 'хук видим во всех проектах, но вмешивается только в firm2')
})

test('bash-guard: нагрузка не-JSON — exit 0, молча', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conventionWorktree(p, 'T-001')
  const r = p.cli('bash-guard.mjs', [], { input: 'это не json {' })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
})

// ── Хирургия по .git (Д-39 проект-В, 01.11.2026) ────────────────────────────────
//
// Стадия не смогла снять дерево задачи и вычистила реестр руками: `rm -rf
// .git/worktrees/<задача>`. Запрет здесь общий — и стадиям, и человеку: признак стадии в
// `PreToolUse` ненадёжен (тот самый вызов шёл с cwd главного дерева), а рецепт у git ровно
// один и он безопасен.

function bashGuardRaw(p, payload) {
  return p.cli('bash-guard.mjs', [], { input: JSON.stringify(payload) })
}

test('bash-guard: rm -rf по .git/worktrees из стадии — exit 2 с рецептом git worktree prune', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'rm -rf .git/worktrees/T-001' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /РАЗРУШАЮЩАЯ КОМАНДА ПО \.git ЗАПРЕЩЕНА/)
  assert.match(r.stderr, /\.git\/worktrees\/T-001/, 'назван путь, на который сторож сработал')
  assert.match(r.stderr, /git worktree prune/, 'рецепт назван: ровно та операция, ради которой тянулись в .git')
  assert.match(r.stderr, /git worktree remove/)
})

test('bash-guard: та же команда из ГЛАВНОГО дерева — тоже отказ: признак стадии тут ненадёжен', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = bashGuard(p, p.root, { command: 'rm -rf "$(git rev-parse --git-dir)/worktrees/T-001"' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /РАЗРУШАЮЩАЯ КОМАНДА ПО \.git ЗАПРЕЩЕНА/)
  assert.match(r.stderr, /обычный терминал вне сессии/, 'у человека назван выход, которого хук не видит')
})

test('bash-guard: соседи по имени (.gitignore, .github) и сам prune проходят молча', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  for (const cmd of [
    'rm -f .gitignore',
    'rm -rf .github/workflows/ci.yml',
    'rm -f .gitmodules',
    'git worktree prune',
    'git worktree remove ../repo.worktrees/T-001 --force',
    'rm -rf node_modules',
  ]) {
    const r = bashGuard(p, wt, { command: cmd })
    assert.equal(r.status, 0, `«${cmd}» не должна была упереться: ${r.stderr}`)
    assert.equal(r.stderr, '')
  }
})

test('bash-guard: чтение .git не трогая — не хирургия', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'cat .git/HEAD; ls .git/worktrees' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '')
})

test('bash-guard: guard.git_surgery: allow снимает запрет и пишет событие guard/git-surgery', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'guard:\n  git_surgery: allow\n' })
  const wt = siblingWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'rm -rf .git/worktrees/T-001' })
  assert.equal(r.status, 0, r.stderr)
  const evs = listEvents(p.root, {}).filter((e) => e.stage === 'guard' && e.event === 'git-surgery')
  assert.equal(evs.length, 1, 'разрешение не делает разрушение невидимым')
  assert.equal(evs[0].ticket, 'T-001')
  assert.match(evs[0].notes, /git_surgery: allow/)
})

test('bash-guard: снятие песочницы из ГЛАВНОГО дерева, но вызов от ПОДАГЕНТА — exit 2 (дыра Д-39)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conventionWorktree(p, 'T-001')
  // Ровно тот случай, который прошёл на проект-В: стадия работает из главного дерева, и
  // признак по дереву её не видит. Второй признак — поля про агента в самой нагрузке.
  const r = bashGuardRaw(p, {
    cwd: p.root,
    agent_id: 'ag-1',
    agent_type: 'firm2:firm-developer',
    tool_input: { dangerouslyDisableSandbox: true, command: 'pgrep -fl chrome' },
  })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /снятие песочницы стадией ЗАПРЕЩЕНО/)
  assert.match(r.stderr, /стадия опознана по нагрузке вызова/, 'сказано, чем именно опознана')
})

test('bash-guard: та же нагрузка без полей про агента — прежнее поведение человека (exit 0)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conventionWorktree(p, 'T-001')
  const r = bashGuardRaw(p, {
    cwd: p.root,
    tool_input: { dangerouslyDisableSandbox: true, command: 'pgrep -fl chrome' },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /решение твоё/, 'в главном дереве работает человек (ADR-0009)')
})

test('bash-guard: отказ по .git говорит, что prune в песочнице тоже падает, и не оставляет обхода', (t) => {
  // Замер проект-В 02.11.2026: стадия получила отказ, пошла по его рецепту — и `git worktree
  // prune` упал «Operation not permitted», потому что пишет внутрь `.git` ровно так же.
  // Рецепт, который не работает, толкает стадию искать обход — то есть `rm -rf`, с которого
  // дефект и начался. Поэтому отказ обязан назвать и этот исход, и честный выход из него.
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = bashGuardRaw(p, {
    cwd: p.root,
    tool_input: { command: 'rm -rf .git/worktrees/T-001' },
  })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /может упасть «Operation not permitted»/, 'исход назван, а не оставлен на догадку')
  assert.match(r.stderr, /рабочего рецепта в сессии НЕТ НИ ОДНОГО/, 'сказано прямо, иначе обход ищут сами')
  assert.match(r.stderr, /не обходи его rm -rf/)
  assert.match(r.stderr, /status: "fail"/, 'назван штатный выход стадии')
  assert.match(r.stderr, /Остаток реестра не ломает прогон/, 'цена остатка названа — иначе он кажется срочным')
})

// ── Потолок на полный прогон набора в стадии (Д-30, решение человека 02.11.2026) ──
//
// Правило долгого ожидания бьёт по следствию; причина у следствия одна и частая — полный
// набор там, где проект уже оплатил задачный. Потолок привязан к сужению, а не ко времени:
// без `stack.task_test_cmd` замены полному прогону у стадии нет, и запрет был бы запретом
// без выхода. Волна проект-В 02.11.2026: 484 полных прогона набора при 784 стадиях.

const NARROWED = 'stack:\n  test_cmd: npm test\n  task_test_cmd: npm test -- --ignore meta\n'

test('bash-guard: полный набор в стадии — exit 2, обе команды названы, место полного указано', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROWED })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'npm test' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /ПОЛНЫЙ ПРОГОН НАБОРА В СТАДИИ ЗАПРЕЩЁН/)
  assert.match(r.stderr, /Полный набор проекта: npm test/, 'названа команда, на которую сторож сработал')
  assert.match(r.stderr, /npm test -- --ignore meta/, 'и команда, которую надо гнать вместо неё')
  assert.match(r.stderr, /ворот(ах|а|ам) поставки/i, 'сказано, ГДЕ полный набор гоняется')
  assert.match(r.stderr, /status: "fail"/, 'назван штатный выход, если критерий узким набором не закрыть')
})

test('bash-guard: задачная команда проходит, хотя начинается с полной', (t) => {
  // Главная ловушка этой проверки: `npm test -- --ignore meta` СОДЕРЖИТ `npm test`.
  // Сработай сторож на подстроке — он отменил бы ровно то, что сам велит гнать.
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROWED })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'npm test -- --ignore meta' })
  assert.equal(r.status, 0, r.stderr)
})

test('bash-guard: сужения в проекте нет — полный прогон не отменяется (запрет без выхода)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'stack:\n  test_cmd: npm test\n' })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'npm test' })
  assert.equal(r.status, 0, r.stderr)
})

test('bash-guard: полный прогон человека в главном дереве не отменяется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROWED })
  const r = bashGuard(p, p.root, { command: 'npm test' })
  assert.equal(r.status, 0, r.stderr)
})

test('bash-guard: guard.full_suite allow пропускает прогон и пишет событие', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROWED + 'guard:\n  full_suite: allow\n' })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'npm test' })
  assert.equal(r.status, 0, r.stderr)
  const evs = listEvents(p.root, {}).filter((e) => e.stage === 'guard' && e.event === 'full-suite')
  assert.equal(evs.length, 1, 'разрешение не делает полный прогон невидимым — его цена остаётся замеримой')
  assert.equal(evs[0].ticket, 'T-001')
  assert.match(evs[0].notes, /full_suite: allow/)
})

// ── Поправка потолка по отчёту проект-В 02.11.2026 (Д-44а/б и две находки) ─────
//
// Конфиг, на котором ломалась первая редакция: полная команда — ГОЛЫЙ ПРЕФИКС запускателя
// (`uv run pytest`), узкая — та же команда плюс три `--ignore`. По подстроке выходило, что
// адресный прогон «содержит полную команду».

const BARE = 'stack:\n  test_cmd: uv run pytest\n  task_test_cmd: uv run pytest --ignore=tests/a.py --ignore=tests/b.py\n'

test('Д-44а: адресный прогон при голом префиксе проходит — сужение названо в вызове', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: BARE })
  const wt = conventionWorktree(p, 'T-001')
  for (const cmd of [
    'uv run pytest tests/test_t082_page_ceiling.py',
    'uv run pytest tests/x.py::test_y',
    'uv run pytest -k ceiling',
    'uv run pytest -m slow',
    'uv run pytest --deselect tests/x.py::t',
  ]) {
    const r = bashGuard(p, wt, { command: cmd })
    assert.equal(r.status, 0, `${cmd} отклонён: ${r.stderr}`)
  }
})

test('Д-44а: голый прогон при том же конфиге отклоняется — сужения в вызове нет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: BARE })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'uv run pytest' })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /НЕТ СУЖЕНИЯ/, 'в отказе названо, что именно считается сужением')
})

test('Д-44а: узкая команда проекта проходит, хотя её --ignore и есть её сужение', (t) => {
  // Хвост считается от самого длинного совпадения — иначе `--ignore` из самой узкой
  // команды сошёл бы за сужение, добавленное ролью, и потолок не сработал бы никогда.
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: BARE })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'uv run pytest --ignore=tests/a.py --ignore=tests/b.py' })
  assert.equal(r.status, 0, r.stderr)
})

// Ворота поставки: стадия уровня поставки несёт маркер `FIRM2-TICKET: MR`, и правила
// стадии задачи к ней не применяются. Тикет сторож берёт из транскрипта подагента — того
// же источника, что и привязка событий.
function gateAgent(p, { session, agent, ticket = 'MR' }) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), session, 'subagents',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `agent-${agent}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: `FIRM2-TICKET: ${ticket}\nУпаковка.` } }) + '\n',
  )
}

test('Д-44б: на воротах поставки полный прогон проходит — потолка там нет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: BARE })
  gateAgent(p, { session: 'sess-gate', agent: 'g1' })
  const r = p.cli('bash-guard.mjs', [], {
    input: JSON.stringify({
      cwd: p.root, agent_id: 'g1', agent_type: 'firm2:firm-devops', session_id: 'sess-gate',
      tool_input: { command: 'uv run pytest' },
    }),
  })
  assert.equal(r.status, 0, r.stderr)
})

test('Д-44б: на воротах поставки долгое ожидание тоже проходит', (t) => {
  // Живой браузерный гейт короче 62 минут не бывает, и место ему тот же шаг 3б.
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: BARE })
  gateAgent(p, { session: 'sess-gate2', agent: 'g2' })
  const r = p.cli('bash-guard.mjs', [], {
    input: JSON.stringify({
      cwd: p.root, agent_id: 'g2', agent_type: 'firm2:firm-devops', session_id: 'sess-gate2',
      tool_input: { command: 'sleep 600; cat log' },
    }),
  })
  assert.equal(r.status, 0, r.stderr)
})

test('находка 1: событие потолка несёт тикет стадии, а не unknown', (t) => {
  // Полный прогон по замыслу идёт из ГЛАВНОГО дерева, где дерева задачи нет: тикет по cwd
  // не достать никогда, и `doctor` краснел от санкционированного обхода.
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: BARE + 'guard:\n  full_suite: allow\n' })
  gateAgent(p, { session: 'sess-ev', agent: 'e1', ticket: 'T-001' })
  const r = p.cli('bash-guard.mjs', [], {
    input: JSON.stringify({
      cwd: p.root, agent_id: 'e1', agent_type: 'firm2:firm-developer', session_id: 'sess-ev',
      tool_input: { command: 'uv run pytest' },
    }),
  })
  assert.equal(r.status, 0, r.stderr)
  const evs = listEvents(p.root, {}).filter((e) => e.stage === 'guard' && e.event === 'full-suite')
  assert.equal(evs.length, 1)
  assert.equal(evs[0].ticket, 'T-001', 'тикет взят из транскрипта стадии — doctor больше не краснеет от обхода')
})

test('находка 2: отказ по долгому ожиданию пишется событием, а не только в stderr', (t) => {
  // Прежде событие писала только ветка allow: сколько раз правило сработало, по журналу
  // было не узнать, и судить о его пороге было нечем.
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { command: 'sleep 900; tail -5 log' })
  assert.equal(r.status, 2, r.stderr)
  const evs = listEvents(p.root, {}).filter((e) => e.stage === 'guard' && e.event === 'long-wait')
  assert.equal(evs.length, 1, 'укус правила обязан быть замеримым — иначе его порог это вкус')
  assert.equal(evs[0].blocked, true)
  assert.equal(evs[0].ticket, 'T-001')
})

test('сторож без привязки пишет MR, а не unknown: иначе doctor краснеет навсегда', (t) => {
  // Отчёт проект-В 05.11.2026, дефект 1. Ожидание сработало в сессии-ОРКЕСТРАТОРЕ сборки:
  // тикета у неё нет по устройству (оркестратор задачу не держит), и событие легло с
  // `ticket: unknown`. Это дыра привязки (И-7), она краснит `doctor` навсегда — журнал
  // неизменяем, — а снять её можно только исправляющим событием, то есть УГАДАВ тикет.
  // 48 часов красноты на одном событии.
  //
  // Решение не новое: расписки об отправке (0.4.84) и сверка секретов (21.10.2026) уже
  // отвечают `MR`. Третий случай одного решения — это место, а не забывчивость: теперь
  // подстановка стоит в `writeEvent`, один раз на все сторожа движка.
  const p = makeProject(t, { tasks: ['T-001'] })
  // Стадия идёт из ГЛАВНОГО дерева (признак — подагент в нагрузке, Д-39), а ветка главного
  // дерева тикета не несёт: ровно случай оркестратора сборки, у которого задачи нет.
  const r = bashGuardRaw(p, {
    cwd: p.root,
    agent_id: 'a-orchestrator',
    tool_input: { command: 'until [ -f x ]; do sleep 30; done' },
  })
  assert.equal(r.status, 2, r.stderr)
  const evs = listEvents(p.root, {}).filter((e) => e.stage === 'guard' && e.event === 'long-wait')
  assert.equal(evs.length, 1, 'замер правила остаётся: молчать тут нельзя, порог без замера есть вкус')
  assert.equal(evs[0].ticket, 'MR', `событие ушло с ticket: ${evs[0].ticket}`)
  const d = p.evJson('doctor').json
  assert.deepEqual(d.unknown, [], 'и дыры привязки в журнале не появилось')
})

test('подстановка MR касается только сторожей: у стадии работы unknown остаётся находкой', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, { change: p.change, ticket: 'unknown', stage: 'dev', event: 'finished', actor: 'x' })
  const d = p.evJson('doctor').json
  assert.equal(d.unknown.length, 1,
    'у стадии работы отсутствие привязки и ЕСТЬ находка: там событие принадлежит задаче, просто её не назвали')
})

// ── SubagentStart держит паузу (firm-event.mjs, Д-17) ─────────────────────────

function startStage(p, agentType, { agentId = 'a1', prompt = null, cwd = p.root } = {}) {
  const payload = { agent_type: agentType, hook_event_name: 'SubagentStart', agent_id: agentId, cwd }
  if (prompt) payload.prompt = prompt
  return p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })
}

const startDev = (p, ticket, opts = {}) =>
  startStage(p, 'firm2:firm-developer', {
    ...opts,
    prompt: `FIRM2-TICKET: ${ticket}\nFIRM2-CHANGE: ${p.change}\nFIRM2-ATTEMPT: ${opts.attempt || 1}`,
  })

const pauseGuardEvents = (p, ticket) =>
  listEvents(p.root, { change: p.change }).filter((e) => e.ticket === ticket && e.stage === 'guard' && e.event === 'pause-held')

const devStartedEvents = (p, ticket) =>
  listEvents(p.root, { change: p.change }).filter((e) => e.ticket === ticket && e.stage === 'dev' && e.event === 'started')

test('пауза: новая задача (нет прежних dev-событий) — exit 2, dev/started не пишется, pause-held пишется один раз', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json'])

  const r = startDev(p, 'T-001')
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /стоит ПАУЗА/)
  assert.equal(devStartedEvents(p, 'T-001').length, 0, 'новая задача не начинается во время паузы')
  assert.equal(pauseGuardEvents(p, 'T-001').length, 1, 'отказ обязан быть виден в журнале')
})

test('пауза: повторная попытка старта того же тикета — второго pause-held не добавляется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json'])

  startDev(p, 'T-001', { agentId: 'a1' })
  const r2 = startDev(p, 'T-001', { agentId: 'a2' }) // рантайм пробует снова, другой agent_id
  assert.equal(r2.status, 2, r2.stderr)
  assert.equal(pauseGuardEvents(p, 'T-001').length, 1,
    'журнал — история поставки, а не лог попыток: один отказ отвечает на вопрос полностью')
})

test('пауза: у тикета уже есть dev-события (доработка) — старт проходит, dev/started пишется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, {
    ts: '2026-10-05T08:00:00.000Z', change: p.change, ticket: 'T-001', stage: 'dev', event: 'started', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-10-05T08:30:00.000Z', change: p.change, ticket: 'T-001', stage: 'review', event: 'rejected', actor: 'test',
  })
  p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json'])

  const r = startDev(p, 'T-001', { attempt: 2 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(devStartedEvents(p, 'T-001').length, 2, 'доработка — второй dev/started тому же тикету')
  assert.equal(pauseGuardEvents(p, 'T-001').length, 0,
    'пауза останавливает НОВЫЕ задачи, а не доведение начатого до конца')
})

test('пауза: паузы нет — старт проходит как обычно', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = startDev(p, 'T-001')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(devStartedEvents(p, 'T-001').length, 1)
})

test('пауза: pause.json нечитаем (битый JSON) — считается паузой, новая задача не начинается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(dirname(pauseFilePath(p.root)), { recursive: true })
  writeFileSync(pauseFilePath(p.root), '{ битый json')

  const r = startDev(p, 'T-001')
  assert.equal(r.status, 2, r.stderr)
  assert.equal(devStartedEvents(p, 'T-001').length, 0)
  assert.equal(pauseGuardEvents(p, 'T-001').length, 1)
})

test('пауза: старт НЕ dev (test) при стоящей паузе проходит без задержки', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json'])

  const r = startStage(p, 'firm2:firm-tester', {
    prompt: `FIRM2-TICKET: T-001\nFIRM2-CHANGE: ${p.change}\nFIRM2-ATTEMPT: 1`,
  })
  assert.equal(r.status, 0, r.stderr)
  const testStarted = listEvents(p.root, { change: p.change })
    .filter((e) => e.ticket === 'T-001' && e.stage === 'test' && e.event === 'started')
  assert.equal(testStarted.length, 1, 'пауза держит только набор НОВЫХ задач на dev')
  assert.equal(pauseGuardEvents(p, 'T-001').length, 0)
})

test('пауза: ticket === unknown проходит, даже когда пауза стоит и стадия dev', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json'])

  // Без маркера в промпте и без привязанной ветки рабочего каталога тикет не достать:
  // на старте запасной путь через ветку запрещён по устройству момента (см. firm-event.mjs).
  const r = startStage(p, 'firm2:firm-developer', { agentId: 'z1', cwd: p.root })
  assert.equal(r.status, 0, r.stderr)
  const unknownStarted = listEvents(p.root, { change: p.change })
    .filter((e) => e.ticket === 'unknown' && e.stage === 'dev' && e.event === 'started')
  assert.equal(unknownStarted.length, 1, 'непривязанный старт — штатный путь, не повод отказывать')
  assert.equal(
    listEvents(p.root, { change: p.change }).filter((e) => e.stage === 'guard' && e.event === 'pause-held').length,
    0,
    'отказывать тикету, которого не знаем, нечем — проверка рассчитана на ИЗВЕСТНЫЙ тикет',
  )
})

// ── Д-60: служебное дерево движка — место человека, а не стадии ───────────────
//
// Отчёт проект-В 08.11.2026. Шаг 6 маршрута (вливание и выпуск) обязан идти там, где выгружена
// ветка-цель, а это `<репо>.worktrees/_trunk` — раскладка, которую движок сам называет
// штатной. Оркестратор пришёл туда по устройству маршрута, попробовал `git push` и получил
// «снятие песочницы стадией ЗАПРЕЩЕНО»: признак «cwd внутри worktrees_dir» опознал стадией
// того, кого маршрут туда и послал. Решение, которое по тексту отказа принимает человек,
// стало недоступно и человеку. Та же дыра, что Д-39, только в другую сторону.
function serviceWorktree(p, name, branch) {
  const wt = join(worktreesDir(p.root, null), name)
  p.git('worktree', 'add', '-q', '-B', branch, wt, `feature/${p.change}`)
  return wt
}

test('bash-guard: дерево темы разведки (ветка backlog/F-XXX) — тоже не стадия по каталогу', (t) => {
  // Замер проект-В 08.11.2026: в живом каталоге рабочих деревьев рядом с `_trunk` и `_base`
  // лежит `backlog-F-032` на ветке `backlog/F-032` — дерево темы, где по долгу работают и
  // роли, и человек, и Оркестратор. Ключ один и он по ВЕТКЕ, а не по имени каталога: иначе
  // два ключа дают на это дерево разные ответы.
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = serviceWorktree(p, 'backlog-F-032', 'backlog/F-032')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'git push origin main' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /ветка не задачная/)
})

test('bash-guard: Оркестратор в служебном дереве на ветке-цели — предупреждение, а не отказ (Д-60)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = serviceWorktree(p, '_trunk', 'main')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'git push origin main' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /решение твоё/, 'ADR-0009: движок не распоряжается чужим временем')
  assert.match(r.stderr, /ветка не задачная/, 'сказано, почему каталог не сделал его стадией')
})

test('bash-guard: стадия в служебном дереве опознаётся агентскими полями — отказ остаётся', (t) => {
  // Слабый признак снят, сильный остался: ровно тот, которым закрыли Д-39.
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = serviceWorktree(p, '_trunk', 'main')
  const r = p.cli('bash-guard.mjs', [], {
    input: JSON.stringify({
      cwd: wt,
      agent_id: 'ag-1',
      agent_type: 'firm2:firm-devops',
      tool_input: { dangerouslyDisableSandbox: true, command: 'git push origin main' },
    }),
  })
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /снятие песочницы стадией ЗАПРЕЩЕНО/)
})

test('bash-guard: дерево задачи остаётся деревом задачи, даже если лежит рядом со служебными', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'git push origin main' })
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /ЭТОТ КАТАЛОГ/, 'назван решающий признак')
  assert.match(r.stderr, /`cd` ВНУТРИ команды его не меняет/, 'сказано, почему вторая попытка кончится так же')
})

test('bash-guard: отказ на пуше называет закрытый конфиг gh и выход через человека', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = conventionWorktree(p, 'T-001')
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'git push origin main' })
  assert.match(r.stderr, /gh\/hosts\.yml/, 'названа настоящая причина, а не «песочница вообще»')
  assert.match(r.stderr, /префиксом `!`/, 'дан исполнимый выход')
  assert.match(r.stderr, /ни credential\.helper store/, 'закрыты оба тупика, замеренные 23.10.2026')
})

test('bash-guard: дерево основания сверки (_base, detached) остаётся стадией', (t) => {
  // Там работает зонд точки ветвления — настоящая стадия, и ослаблять признак для неё
  // нельзя: ветки у дерева нет вовсе, значит сильного признака может не быть тоже.
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = join(worktreesDir(p.root, null), '_base')
  p.git('worktree', 'add', '-q', '--detach', wt, `feature/${p.change}`)
  const r = bashGuard(p, wt, { dangerouslyDisableSandbox: true, command: 'npm test' })
  assert.equal(r.status, 2, r.stdout)
})
