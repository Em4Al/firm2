// Инварианты проекций и жизненного цикла: И-8 (слоты), И-10 (архив), И-11 (чужая стадия).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeBoard, statusFromEvents, listEvents, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, isoAgo } from './helpers.mjs'

function ev(p, ticket, stage, event, { ts = isoAgo(0.1), agent_id = null } = {}) {
  writeEvent(p.root, { ts, change: p.change, ticket, stage, event, actor: 'test', agent_id })
}

// ── И-8. Слот занимает задача, а не агент ────────────────────────────────────

test('И-8: при parallelism 2 третья готовая задача остаётся ready, а не уходит в работу', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002', 'T-003'], parallelism: 2, parallelSafe: true })
  ev(p, 'T-001', 'dev', 'started')
  ev(p, 'T-002', 'dev', 'started')

  const board = computeBoard(p.root, p.change, { parallelism: 2 })
  const by = new Map(board.tasks.map((x) => [x.id, x]))
  assert.equal(board.slots_used, 2)
  assert.equal(board.parallelism, 2)
  assert.equal(by.get('T-001').status, 'in_progress')
  assert.equal(by.get('T-002').status, 'in_progress')
  assert.equal(by.get('T-003').status, 'ready', 'потолок параллелизма обязан что-то ограничивать')
  assert.deepEqual(by.get('T-003').waiting_for, ['слоты заняты'], 'причина ожидания должна быть названа')
})

test('И-8: три агента на одном тикете — это один слот, а не три (панель ревью)', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002', 'T-003'], parallelism: 3, parallelSafe: true })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(0.5) })
  ev(p, 'T-001', 'dev', 'finished', { ts: isoAgo(0.4) })
  ev(p, 'T-001', 'test', 'finished', { ts: isoAgo(0.3) })
  // Состязательная панель: три ревьюера, три своих agent_id, один тикет.
  ev(p, 'T-001', 'review', 'started', { ts: isoAgo(0.21), agent_id: 'r1' })
  ev(p, 'T-001', 'review', 'started', { ts: isoAgo(0.2), agent_id: 'r2' })
  ev(p, 'T-001', 'review', 'started', { ts: isoAgo(0.19), agent_id: 'r3' })

  const board = computeBoard(p.root, p.change, { parallelism: 3 })
  assert.equal(board.slots_used, 1, 'слот меряет задачи, а не агентов (иначе получается «6 из 3»)')
  assert.equal(board.tasks.find((x) => x.id === 'T-001').status, 'in_review')
  // Остальные две задачи при этом свободно идут в работу.
  for (const id of ['T-002', 'T-003']) {
    const x = board.tasks.find((y) => y.id === id)
    assert.equal(x.status, 'ready')
    assert.deepEqual(x.waiting_for, [], `${id}: слоты есть, ждать нечего`)
  }
})

test('И-8: непривязанная идущая стадия dev тоже занимает слот', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'], parallelism: 2, parallelSafe: true })
  ev(p, 'T-001', 'dev', 'started')
  // Старт, которому рантайм ещё не дал привязки: слот он уже занимает.
  ev(p, 'unknown', 'dev', 'started', { agent_id: 'live-1' })

  const board = computeBoard(p.root, p.change, { parallelism: 2 })
  assert.equal(board.in_flight_unbound, 1)
  assert.equal(board.slots_used, 2, 'иначе доска показывала бы «0 из 2» при работающей сборке')
  const t2 = board.tasks.find((x) => x.id === 'T-002')
  assert.equal(t2.status, 'ready')
  assert.match(t2.waiting_for.join(' '), /слоты заняты/)
})

test('И-8: задача с parallel_safe: false ждёт, чтобы идти одной', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'], parallelism: 3 })
  ev(p, 'T-001', 'dev', 'started')

  const board = computeBoard(p.root, p.change, { parallelism: 3 })
  const t2 = board.tasks.find((x) => x.id === 'T-002')
  assert.equal(t2.status, 'ready')
  assert.deepEqual(t2.waiting_for, ['parallel_safe: false — ждёт, чтобы идти одной'])
})

// ── И-10. Архивный снимок спеки не меняется никогда ──────────────────────────

test('И-10: sync не пишет в openspec/changes/archive/** и говорит об этом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'todo', archived: true })
  const file = join(p.tasksPath, 'T-001.md')
  assert.match(file, /openspec\/changes\/archive\//)
  const before = readFileSync(file, 'utf8')

  // В журнале задача влита и выпущена — кэш в снимке заведомо расходится с журналом.
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(2) })
  ev(p, 'T-001', 'merge', 'finished', { ts: isoAgo(1) })

  const r = p.evJson('sync', '--change', p.change)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(file, 'utf8'), before, 'архивный снимок иммутабелен (Д-14)')
  assert.deepEqual(r.json.fixed, [], 'правок в снимке быть не должно')
  assert.ok(
    (r.json.archived || []).some((s) => s.startsWith('T-001:')),
    `расхождение в снимке обязано быть названо, а не молча исправлено: ${JSON.stringify(r.json.archived)}`,
  )
})

test('И-10: критерии приёмки в архивном снимке тоже не отмечаются', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], archived: true })
  const file = join(p.tasksPath, 'T-001.md')
  const before = readFileSync(file, 'utf8')
  assert.match(before, /- \[ \] критерий один/)

  // Вердикт ревью с разбором по критериям — ровно то, что в живой задаче ставит галочку.
  writeEvent(p.root, {
    ts: isoAgo(1), change: p.change, ticket: 'T-001', stage: 'review', event: 'accepted',
    actor: 'test', criteria: [{ c: 'критерий один', s: 'выполнено' }],
  })
  const r = p.evJson('sync', '--change', p.change)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(file, 'utf8'), before, 'снимок не правится ничем, включая галочки')
})

// ── И-11. Движок не закрывает чужую стадию ───────────────────────────────────

test('И-11: открытая стадия старше шести часов попадает в abandoned_stages с готовой командой', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(8) })
  const before = p.eventFiles()

  const d = p.evJson('doctor')
  assert.equal(d.json.ok, false, 'висящая стадия обязана валить ok (на проект-В он отвечал ok: true)')
  assert.equal(d.json.abandoned_stages.length, 1)
  const hit = d.json.abandoned_stages[0]
  assert.equal(hit.ticket, 'T-001')
  assert.equal(hit.stage, 'dev')
  assert.equal(hit.age_h, 8)
  assert.equal(hit.fix, 'firm-event.mjs abandon --ticket T-001 --stage dev')

  // И главное: движок НЕ пишет событие сам.
  assert.deepEqual(p.eventFiles(), before, 'сочинённое finished испортило бы тайминг сильнее пробела')
  assert.deepEqual(d.json.long_running, [], 'брошенная стадия не считается «долго идущей»')
})

test('И-11: долгая, но не брошенная стадия называется и на ok не влияет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(1) })

  const d = p.evJson('doctor')
  assert.equal(d.json.ok, true, 'долгая стадия — метрика, а не поломка')
  assert.equal(d.json.long_running.length, 1)
  // Порог теперь считается по стадии, а не один на всех (см. thresholds.test.mjs):
  // для dev без статистики проекта берётся зашитое значение по замеру пилотов — 45.
  assert.match(d.json.long_running[0], /T-001 · dev — 60 мин \(порог 45, замер пилотов\)/)
  assert.match(d.json.long_running[0], /если прогон снят — firm-event\.mjs abandon/,
    'рычаг человеку нужен сразу, а не через пять часов')
})

test('И-11: после abandon задача «не начата», а число попыток НЕ обнулено', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(9) })
  ev(p, 'T-001', 'dev', 'finished', { ts: isoAgo(8.5) })
  ev(p, 'T-001', 'review', 'rejected', { ts: isoAgo(8) })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(7) }) // вторая попытка, она и повисла

  const beforeBoard = computeBoard(p.root, p.change)
  assert.equal(beforeBoard.tasks[0].status, 'in_progress')
  assert.equal(beforeBoard.tasks[0].attempt, 2)
  assert.equal(beforeBoard.slots_used, 1)

  const r = p.evJson('abandon', '--ticket', 'T-001', '--stage', 'dev')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.json.event.event, 'abandoned')
  assert.equal(r.json.event.actor, 'human', 'событие пишет человек, а не движок')

  const board = computeBoard(p.root, p.change)
  const task = board.tasks[0]
  assert.equal(statusFromEvents(listEvents(p.root, { change: p.change })).status, null,
    'abandoned возвращает задачу в «не начата»')
  assert.equal(task.status, 'ready', 'доска пересчитывает ready/todo по зависимостям')
  assert.equal(task.attempt, 2, 'попытки считаются по dev/started — предел трёх заходов цел')
  assert.equal(board.slots_used, 0, 'слот освободился')

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.abandoned_stages, [], 'закрытая стадия больше не висит')
  assert.equal(d.json.ok, true)
})

test('И-11: abandon отказывается закрывать стадию, которой нет, и перечисляет открытые', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(8) })
  const before = p.eventFiles()

  const r = p.evJson('abandon', '--ticket', 'T-001', '--stage', 'review')
  assert.equal(r.status, 1, 'закрывать нечего — значит отказ, а не событие')
  assert.match(r.json.reason, /нет открытой стадии review/)
  assert.deepEqual(r.json.open_stages.map((o) => o.stage), ['dev'], 'что открыто — должно быть названо')
  assert.deepEqual(p.eventFiles(), before)
})

test('И-11: abandoned не обнуляет кэш статуса молча — sync приводит файл к «не начата»', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'in_progress' })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(8) })
  p.evJson('abandon', '--ticket', 'T-001')

  const text = readFileSync(join(p.tasksPath, 'T-001.md'), 'utf8')
  assert.match(text, /^status: ready$/m, 'кэш обязан догнать журнал, а не остаться «в работе»')
})

// ── I. Счётчик попыток: ноль у ни разу не начатой задачи ─────────────────────
//
// `statusFromEvents` возвращал `Math.max(attempt, 1)`, то есть единицу у задачи без
// событий. Сборщик берёт это число и ПРИБАВЛЯЕТ к нему (`attempt++` в начале цикла),
// поэтому первый заход нумеровался вторым, а `while (attempt < MAX_ATTEMPTS)` при пределе
// три давал два прохода вместо трёх — свежая задача теряла треть своих попыток. Видно это
// было только по меткам прогона: первая волна на проект-В пошла как `dev:T-011#2`.

test('I: у задачи без событий попыток ноль, а не одна', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })

  assert.equal(statusFromEvents([]).attempt, 0, 'ноль попыток и есть ноль')
  assert.equal(statusFromEvents([]).status, null)

  const task = computeBoard(p.root, p.change).tasks[0]
  assert.equal(task.status, 'ready')
  assert.equal(task.attempt, 0, 'иначе сборщик нумерует первый заход вторым')
})

test('I: попытки считаются по dev/started — один старт даёт единицу, два дают двойку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(2) })
  assert.equal(computeBoard(p.root, p.change).tasks[0].attempt, 1)

  ev(p, 'T-001', 'review', 'rejected', { ts: isoAgo(1.5) })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(1) })
  assert.equal(computeBoard(p.root, p.change).tasks[0].attempt, 2)
})

test('I: build-args отдаёт сборщику ноль, а не единицу — лимит в три захода цел', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  ev(p, 'T-002', 'dev', 'started', { ts: isoAgo(1) })

  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const json = JSON.parse(r.stdout)
  const by = new Map(json.tasks.map((x) => [x.id, x]))
  assert.equal(by.get('T-001').attempt, 0, 'свежая задача входит в прогон с нулём попыток')
  assert.equal(by.get('T-002').attempt, 1, 'а начатая — с единицей')
})

test('I: третья попытка остаётся третьей — Д-11 не задет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Три захода за всю жизнь задачи, в том числе из разных прогонов.
  for (const h of [30, 20, 10]) {
    ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(h) })
    ev(p, 'T-001', 'review', 'rejected', { ts: isoAgo(h - 0.5) })
  }
  assert.equal(computeBoard(p.root, p.change).tasks[0].attempt, 3,
    'попытки считаются по всей жизни задачи, а не по жизни прогона')
})

// ── Модели ролей: эскалация на метке high-complexity ─────────────────────────
//
// Решение человека 02.10.2026: эскалацию распространить на Тестировщика, Ревьюера не
// трогать. Довод за первого — на этой метке код пишут сильной моделью именно потому, что
// задача сложная, и проверяющий не должен быть слабее проверяемого там, где сложность
// объявлена явно. Довод против второго — ревью рискованной задачи ведёт панель из трёх
// голосов на каждую попытку: подъём модели умножил бы цену на три, а замысел панели —
// независимость голосов, а не способность одного.
//
// Workflow тестом не покрывается (нет доступа к ФС), поэтому проверяется граница, через
// которую ключ к нему попадает: `models()` в firm-state.mjs. Без строки в `ROLE_KEYS`
// ключ отбрасывался бы здесь — то есть правка работала бы только на бумаге.
const modelsOf = (p, extra = []) => {
  const r = p.cli('firm-state.mjs', ['models', '--root', p.root, '--json', ...extra])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('эскалация Тестировщика: ключ доезжает до workflow без предупреждений', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'models:\n  tester: sonnet\n  tester_high_complexity: opus\n',
  })
  const m = modelsOf(p)
  assert.equal(m.models.tester_high_complexity, 'opus', 'иначе ключ отбрасывается до workflow')
  assert.equal(m.models.tester, 'sonnet', 'обычная модель роли при этом остаётся своей')
  assert.deepEqual(m.warnings, [], `предупреждений быть не должно: ${m.warnings.join('; ')}`)

  // И та же половина через `build-args`: workflow получает модели именно оттуда.
  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).models.tester_high_complexity, 'opus',
    'build-args — единственная дорога ключа в сборщик')
})

// Эта половина важнее первой: опечатка, прошедшая молча, даёт «работает на бумаге» —
// ключ в конфиге есть, человек уверен, что модель поднята, а Тестировщик идёт на слабой.
test('эскалация Тестировщика: опечатка в ключе не проходит молча', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'models:\n  tester_highcomplexity: opus\n',
  })
  const m = modelsOf(p)
  assert.equal('tester_highcomplexity' in m.models, false, 'неизвестный ключ в вывод не попадает')
  assert.equal(m.warnings.length, 1, `об опечатке надо сказать: ${JSON.stringify(m.warnings)}`)
  assert.match(m.warnings[0], /tester_highcomplexity/, 'предупреждение обязано назвать ключ')
  assert.match(m.warnings[0], /нет такой роли/)
})

test('эскалация Тестировщика: негодное значение отбрасывается с предупреждением', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'models:\n  tester_high_complexity: "gpt"\n',
  })
  const m = modelsOf(p)
  assert.equal('tester_high_complexity' in m.models, false,
    'отказ API на середине сборки дороже, чем отброшенный оверрайд здесь')
  assert.equal(m.warnings.length, 1, JSON.stringify(m.warnings))
  assert.match(m.warnings[0], /tester_high_complexity/)
  assert.match(m.warnings[0], /не opus\/sonnet\/haiku/)
})

// Умолчания у Тестировщика нет намеренно: это выбор проекта, а не правило движка. Тест
// закрепляет, что молча ничего не подорожало, — и рядом, что прежнее умолчание
// Разработчика на месте, потому что потерять его при этой правке было проще всего.
test('эскалация Тестировщика: без ключа умолчания нет, а у Разработчика есть', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const m = modelsOf(p)
  assert.equal('tester_high_complexity' in m.models, false,
    'умолчание здесь означало бы, что цена выросла у всех проектов сразу и молча')
  assert.equal(m.models.developer_high_complexity, 'opus',
    'а это правило движка с самого начала (§4), и правка не смеет его снять')
  assert.deepEqual(m.warnings, [])
  // 'inherit' — это «роль идёт на своей модели», а не значение: в вывод он тоже не попадает.
  const inherit = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'models:\n  tester_high_complexity: inherit\n',
  })
  const mi = modelsOf(inherit)
  assert.equal('tester_high_complexity' in mi.models, false, 'inherit — отказ от оверрайда')
  assert.deepEqual(mi.warnings, [], 'и это не повод предупреждать')
})

// ── Задача, вставшая на закрытой стадии (Д-72, второе следствие) ─────────────

// Прогон упал между Test и QA, и журнал при этом ПОЛОН: `test/finished` записан штатно,
// открытых стадий нет, `doctor` отвечал `ok: true`, `open_stages` и `long_running` пусты.
// Три задачи проект-В 10.11.2026 стояли мёртвыми, и сказать об этом было нечему.
test('финиш без следующей стадии старше шести часов называется в stalled_tickets', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(12) })
  ev(p, 'T-001', 'dev', 'finished', { ts: isoAgo(11) })
  ev(p, 'T-001', 'test', 'started', { ts: isoAgo(10) })
  ev(p, 'T-001', 'test', 'finished', { ts: isoAgo(9) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.open_stages, [], 'открытых стадий и правда нет — журнал полон')
  assert.equal(d.json.stalled_tickets.length, 1, 'мёртвая задача обязана быть названа')
  const hit = d.json.stalled_tickets[0]
  assert.equal(hit.ticket, 'T-001')
  assert.equal(hit.last_stage, 'test')
  assert.equal(hit.last_event, 'finished')
  assert.ok(hit.age_h >= 9, `возраст называется числом: ${hit.age_h}`)
  assert.match(hit.why, /следующая не начиналась/)
  assert.match(hit.fix, /firm-build/, 'лечится новым прогоном, а не исправляющим событием')
})

test('идущая задача в stalled_tickets не попадает: у неё открыта стадия', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(2) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets, [])
})

test('свежий финиш не называется мёртвым: «идёт» и «оборвалось» различает время', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'test', 'finished', { ts: isoAgo(1) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets, [], 'час — это очередь, а не смерть')
})

test('терминальное событие закрывает вопрос: эскалация и слияние не мёртвая стоянка', (t) => {
  // Словарь событий тут не вкусовой: стадия `merge`, событие `finished`. Свой набор имён я
  // в 0.4.136 и написал — с `merged`, которого в журнале нет, — и 28 влитых задач проект-В
  // уехали в находки. Терминальность теперь берётся у `statusFromEvents`, то есть у того же
  // словаря, что у доски.
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  ev(p, 'T-001', 'dev', 'finished', { ts: isoAgo(20) })
  ev(p, 'T-001', 'lifecycle', 'escalated', { ts: isoAgo(19) })
  ev(p, 'T-002', 'merge', 'finished', { ts: isoAgo(18) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets.map((x) => x.ticket), [], 'ждущая человека задача стоит по делу')
})

// Замер проект-В 10.11.2026 по живому журналу: 82 записи, настоящих 3–4. Два класса шума, и
// оба механические — влитые задачи и срабатывания сторожа.

test('влитая задача не подвисшая, и исправляющее событие её таковой не делает', (t) => {
  const p = makeProject(t, { tasks: ['T-395', 'T-409'] })
  ev(p, 'T-395', 'merge', 'finished', { ts: isoAgo(12) })
  // Ровно расстановка проект-В по Д-67: отчёт о попытке опоздал, его погасили исправляющим
  // событием, и `retracted` оказался ПОСЛЕДНЕЙ записью по времени.
  ev(p, 'T-409', 'merge', 'finished', { ts: isoAgo(14) })
  ev(p, 'T-409', 'merge', 'failed', { ts: isoAgo(13) })
  ev(p, 'T-409', 'merge', 'retracted', { ts: isoAgo(12) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets.map((x) => x.ticket), [],
    'слияние и есть терминальное событие задачи; исправление — не последнее слово (ADR-0006)')
})

test('срабатывание сторожа не считается закрытой стадией: guard не стадия', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'T-001', 'dev', 'started', { ts: isoAgo(20) })
  ev(p, 'T-001', 'dev', 'finished', { ts: isoAgo(19) })
  ev(p, 'T-001', 'merge', 'finished', { ts: isoAgo(18) })
  // Сторож срабатывает ПОСРЕДИ чужой стадии и её не закрывает. У проект-В таких записей было
  // 45 из 82: long-wait, suite-started, secret, review-stale, foreign-changes.
  ev(p, 'T-001', 'guard', 'long-wait', { ts: isoAgo(17) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets, [], 'влитая задача со сторожем сверху остаётся влитой')
})

test('но сорванный канал стадии сторожем не считается — он и значит смерть стадии', (t) => {
  const p = makeProject(t, { tasks: ['T-401'] })
  ev(p, 'T-401', 'dev', 'started', { ts: isoAgo(9) })
  ev(p, 'T-401', 'dev', 'finished', { ts: isoAgo(8.5) })
  ev(p, 'T-401', 'guard', 'stage-call-failed', { ts: isoAgo(7) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets.map((x) => x.ticket), ['T-401'],
    'именно этим событием опознались три настоящие жертвы Д-72')
})

test('тема разведки не задача: её «стоянка» этим полем не измеряется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  ev(p, 'G-011', 'groom', 'finished', { ts: isoAgo(418) })

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.stalled_tickets.map((x) => x.ticket), [], 'у темы нет ни стадий цикла, ни слияния (ADR-0012)')
})
