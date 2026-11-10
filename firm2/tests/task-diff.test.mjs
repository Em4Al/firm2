// Состав работы называет машина, а не роль (Д-37), и кэш статуса догоняет журнал даже у
// задачи, которой слияния не будет (Д-33).
//
// Повод — проект-В 31.10–01.11.2026.
//
// Д-37: маршрут просил Разработчика объявить файлы диффа в протоколе, а после него по
// тому же дереву шёл Тестировщик и дописывал файлы проверок. Дифф рос, объявление — нет,
// и Ревьюер сверял объявление с КОНЕЧНЫМ состоянием ветки: три захода отклонены за
// расхождение, ни один не был виной исполнителя (`T-242` — восемь объявленных при десяти,
// дописал Тестировщик коммитом b0ce342e; у `T-224` на этом кончились попытки, и задачу
// пришлось заменять при целой работе). Объявление о состоянии, которое меняется после
// тебя, — утверждение о будущем, и повторение критерия словами его не лечит.
//
// Д-33: `sync` откладывал правку кэша, пока живо рабочее дерево задачи («патч ОТЛОЖЕН до
// слияния»). У задачи, снятой человеком, слияния не будет НИКОГДА — отсрочка вечная, и
// `T-212` стояла `ready` при записанном `lifecycle/superseded`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'
import { writeEvent } from '../scripts/lib/firm.mjs'

const read = (p, id) => readFileSync(join(p.tasksPath, `${id}.md`), 'utf8')
const statusOf = (p, id) => (read(p, id).match(/^status:\s*(\S+)$/m) || [])[1]

// ── Д-37: дифф задачи, снятый машиной ───────────────────────────────────────────────

function withBranch(p, id, files) {
  p.git('checkout', '-q', '-b', `task/${id}`)
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(p.root, name), body)
  }
  p.git('add', '-A')
  p.git('commit', '-qm', `work ${id}`)
  p.git('checkout', '-q', `feature/${p.change}`)
}

test('дифф задачи снимается машиной: файлы, числа строк и точка ветвления', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withBranch(p, 'T-001', { 'a.ts': 'один\nдва\n', 'b.ts': 'три\n' })

  const r = p.cli('firm-state.mjs', ['task-diff', '--ticket', 'T-001', '--json', '--root', p.root])
  const d = JSON.parse(r.stdout)
  assert.equal(d.ticket, 'T-001')
  assert.match(d.base, /^[0-9a-f]{40}$/, 'точка ветвления названа sha, а не словами')
  assert.deepEqual(d.files.map((f) => f.path).sort(), ['a.ts', 'b.ts'])
  assert.equal(d.added, 3, 'строки считает git, а не исполнитель')
  assert.equal(d.deleted, 0)
  assert.equal(d.why, null)
})

test('файл, дописанный ПОСЛЕ первой стадии, в машинном списке есть', (t) => {
  // Это и есть Д-37 в одной проверке: объявление устарело бы, а список — нет.
  const p = makeProject(t, { tasks: ['T-001'] })
  withBranch(p, 'T-001', { 'a.ts': 'один\n' })
  p.git('checkout', '-q', 'task/T-001')
  writeFileSync(join(p.root, 'test_a.py'), 'проверка\n')
  p.git('add', '-A')
  p.git('commit', '-qm', 'тестировщик дописал свой файл')
  p.git('checkout', '-q', `feature/${p.change}`)

  const d = JSON.parse(p.cli('firm-state.mjs', ['task-diff', '--ticket', 'T-001', '--json', '--root', p.root]).stdout)
  assert.deepEqual(d.files.map((f) => f.path).sort(), ['a.ts', 'test_a.py'],
    'список снят последним — после стадии теста, а не до неё')
})

test('ветки задачи нет — это «не знаю», а не пустой дифф (И-12)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const d = JSON.parse(p.cli('firm-state.mjs', ['task-diff', '--ticket', 'T-404', '--json', '--root', p.root]).stdout)
  assert.equal(d.files, null, 'пустой список означал бы «работы нет», а это неправда')
  assert.match(d.why, /прочитать не удалось/)
})

// ── Д-33: кэш статуса у задачи, которой слияния не будет ────────────────────────────

test('снятая человеком задача получает кэш статуса сразу, хотя дерево её живо', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'], status: 'ready' })
  // Дерево задачи живо — ровно та причина, по которой патч откладывался навсегда.
  p.git('branch', 'task/T-001')
  p.git('worktree', 'add', '-q', p.sibling('T-001'), 'task/T-001')
  writeEvent(p.root, {
    ts: '2026-10-31T12:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'lifecycle', event: 'superseded', actor: 'human',
  })

  const r = p.evJson('sync')
  assert.ok(r.json.fixed.some((x) => x.startsWith('T-001')), `кэш не поправлен: ${JSON.stringify(r.json)}`)
  assert.equal(statusOf(p, 'T-001'), 'superseded',
    'слияния у снятой задачи не будет никогда — «отложить до слияния» значит не делать вовсе')
  assert.equal(r.json.deferred.length, 0)
})

test('живая задача по-прежнему ждёт слияния, и причина названа', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'todo' })
  p.git('branch', 'task/T-001')
  p.git('worktree', 'add', '-q', p.sibling('T-001'), 'task/T-001')
  writeEvent(p.root, {
    ts: '2026-10-31T12:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })

  const r = p.evJson('sync')
  assert.equal(r.json.fixed.length, 0, 'файл задачи под работающей стадией править нельзя — слияние откажет')
  assert.match(r.json.deferred.join('\n'), /ОТЛОЖЕН до слияния/)
  assert.equal(statusOf(p, 'T-001'), 'todo')
})

test('doctor называет расхождение кэша вместе с причиной, а не только факт', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'todo' })
  p.git('branch', 'task/T-001')
  p.git('worktree', 'add', '-q', p.sibling('T-001'), 'task/T-001')
  writeEvent(p.root, {
    ts: '2026-10-31T12:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })

  const d = p.evJson('doctor').json
  assert.equal(d.stale_cache.length, 1)
  assert.match(d.stale_cache[0], /дерево задачи живо, патч отложен до слияния/,
    'иначе doctor и sync выглядят спорящими: один находит, другой отвечает fixed: []')
})

test('отказ слияния у снятой задачи АРХИВНОЙ поставки: ok не зависит от знания её имени', (t) => {
  // Отчёт проект-В 05.11.2026, дефект 2. Терминальность считалась ПО ДОСКЕ, а доска строится
  // только по названной поставке: у безадресного `doctor` терминальных задач было НОЛЬ.
  // Замер на журнале проект-В: без ключа — `failed_merges: [T-171, T-181]` и `ok: false`;
  // с `--change 2026-10-23-game-redesign` — пусто и «решение человека». Ответ сверки
  // зависел от аргумента, которого человеку взять негде: поставка заархивирована,
  // `active_change` равен null и другим уже не станет.
  //
  // Снять находку было нечем — та же форма, что у развилки расписок: исправляющее событие
  // стало бы ЛОЖЬЮ, слияние действительно падало, и событие верное.
  const p = makeProject(t, { tasks: ['T-001'], archived: true })
  writeEvent(p.root, {
    ts: '2026-10-31T10:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'failed', actor: 'merge-stage', notes: 'конфликт в world.ts',
  })
  writeEvent(p.root, {
    ts: '2026-10-31T14:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'lifecycle', event: 'superseded', actor: 'human',
  })
  const blind = p.evJson('doctor').json
  assert.equal(blind.change, null, 'сцена: активной поставки нет — поставка в архиве')
  assert.deepEqual(blind.failed_merges, [],
    'безадресный doctor обязан сходиться с адресным, иначе ok зависит от знания имени мёртвой поставки')
  assert.equal(blind.failed_merges_closed.length, 1, 'след отказа остаётся видимым и здесь')
  assert.equal(blind.ok, true)

  const named = p.evJson('doctor', '--change', p.change).json
  assert.equal(named.ok, blind.ok, 'решение человека не перестаёт им быть без ключа --change')
})

test('отказ слияния, снятый решением человека, на ok не влияет, но назван', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, {
    ts: '2026-10-31T10:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'failed', actor: 'merge-stage', notes: 'конфликт в world.ts',
  })
  const before = p.evJson('doctor').json
  assert.equal(before.ok, false, 'неразобранный отказ слияния — настоящая находка')

  writeEvent(p.root, {
    ts: '2026-10-31T14:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'lifecycle', event: 'superseded', actor: 'human',
  })
  const after = p.evJson('doctor').json
  assert.deepEqual(after.failed_merges, [], 'у снятой задачи разбирать нечего: слияния не будет')
  assert.equal(after.failed_merges_closed.length, 1, 'но след отказа остаётся видимым')
  assert.equal(after.failed_merges_closed[0].closed_by, 'решение человека')

  assert.equal(after.ok, true, 'снятая человеком задача сверку не краснит')
  assert.equal(after.ok, true, 'иначе doctor краснеет навсегда — решение человека последнее слово')
})

// ── Д-31: проектирование молчит так же, как адъюдикация ─────────────────────────────
//
// Замер проект-В 31.10.2026: 29 ЗАКРЫВАЮЩИХ `design-finished` легли с `ticket: unknown`.
// Привязать их не к чему и никогда не будет чем: Архитектор и Дизайнер работают на
// `/firm-plan` и на груминге, где задачи ещё не существует, а привязке по `agent_id`
// нужен парный старт с тикетом (Архитектор молчит здесь с 0.4.x: его стадия —
// `adjudicate`, и для неё такой выход уже был). `doctor` показывает `unknown` как поломку привязки —
// значит эти 29 обесценивали признак, вместо того чтобы о чём-то говорить.
const hook = (p, payload) => p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })

test('стадия проектирования без тикета события не пишет вовсе', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = hook(p, {
    agent_type: 'firm2:firm-designer',
    hook_event_name: 'SubagentStop',
    agent_id: 'нетмаркера000',
    session_id: 'нет-такой-сессии',
    cwd: p.root,
  })
  assert.equal(r.status, 0, `молчание — штатный путь, а не отказ: ${r.stderr}`)
  assert.deepEqual(p.eventFiles(), [], 'дыра в журнале хуже отсутствия записи: привязки тут нет по предмету шага')
})

test('стадия проектирования С тикетом пишется как раньше', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  hook(p, {
    agent_type: 'firm2:firm-designer',
    hook_event_name: 'SubagentStop',
    agent_id: 'есть-тикет-0',
    session_id: 'нет-такой-сессии',
    cwd: p.root,
    // Привязка держится на МАРКЕРЕ в нагрузке, а не на поле с именем ticket: хук ищет
    // `FIRM2-TICKET` в тексте события (ADR-0004), и так же он находит его в промпте.
    prompt: `FIRM2-TICKET: T-001\nFIRM2-CHANGE: ${p.change}\nFIRM2-ATTEMPT: 1\nНарисуй экран.`,
  })
  const files = p.eventFiles()
  assert.equal(files.length, 1, 'привязанная стадия проектирования — обычное событие')
  assert.match(files[0], /T-001-design-finished/)
})
