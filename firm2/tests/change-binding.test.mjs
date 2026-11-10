// Привязка события к ПОСТАВКЕ. Разбор прогона проект-В 11.10.2026 (Д-1): в проекте стало
// две живых поставки — 3.1 со задачами и 3.2, заведённая на разведке и ещё без задач, —
// и восемь событий стадий уехали в 3.2, по которой сборка не шла. На дашборде поставки
// при этом было пусто, хотя три стадии шли.
//
// Виноват не момент, а догадка. На `SubagentStart` маркера взять неоткуда (собственного
// транскрипта субагента ещё нет), и это структурное свойство; но код не оставлял поле
// пустым, а звал `activeChange`, а та выбирает «первую, в которой задач ещё нет» — то
// есть ровно незапланированную. Пустое поле читатель журнала обрабатывает сам: событие
// без поставки попадает в выборку любой, а достройка по `agent_id` и по транскрипту
// заполняет `change` из того же источника, что и тикет, — но только если поле ПУСТО.
// Догадка не просто врала: она блокировала починку, которая в движке уже была.
//
// Отсюда проверки ниже: хук не угадывает при двух поставках, не ломается при одной,
// читатель видит событие без поставки в правильной доске, а транскрипт достраивает поле
// до верного значения.
//
// Последняя проверка — про находку этих же тестов, которой в разборе прогона нет. Образец
// маркера был `[\w.-]+`, то есть имя поставки обрывалось на первой не-ASCII букве:
// `2026-10-10-черновик` уезжал в журнал как `2026-10-10-`. На проект-В имена поставок
// английские, и дефект не выстрелил бы, — но это та же приписка не туда, что Д-1, только
// без следа в именах файлов.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { listEvents, computeBoard, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

const hook = (p, payload) => p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })

const theEvent = (p) => {
  const files = p.eventFiles()
  assert.equal(files.length, 1, `событие должно быть одно: ${files.join(', ')}`)
  return JSON.parse(readFileSync(join(p.eventsPath, files[0]), 'utf8'))
}

// Вторая живая поставка БЕЗ задач. Имя нарочно первое по алфавиту: именно так выглядел
// проект-В, и именно сортировка `listChanges` решала исход.
function emptyChangeBeside(p, name = 'aa-черновик') {
  mkdirSync(join(p.root, 'openspec', 'changes', name, 'tasks'), { recursive: true })
  return name
}

// Транскрипт субагента там, где его кладёт рантайм: имя файла — из `agent_id`, первая
// строка — промпт стадии с маркерами, которые пишет workflow.
function subagentTranscript(p, { session, agent, ticket, change }) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), session, 'subagents',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `agent-${agent}.jsonl`),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `FIRM2-TICKET: ${ticket}\nFIRM2-CHANGE: ${change}\nFIRM2-ATTEMPT: 1\nРаботай.` },
    }) + '\n',
  )
}

test('Д-1: при двух живых поставках хук не угадывает — поле остаётся пустым', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'] })
  emptyChangeBeside(p)

  const r = hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'dev-1',
    session_id: 'нет-такой-сессии',
  })
  assert.equal(r.status, 0, `непривязанный старт с agent_id — штатный путь: ${r.stderr}`)

  const e = theEvent(p)
  assert.equal(e.ticket, 'unknown', 'тикет на старте брать неоткуда — это известно и штатно')
  assert.equal(e.change, null, `поставку угадывать нельзя, а записано: ${JSON.stringify(e.change)}`)
})

test('Д-1: пока поставка одна, догадки нет вовсе — поле заполняется', (t) => {
  const p = makeProject(t, { change: 'ch', tasks: ['T-001'] })

  hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'dev-1',
    session_id: 'нет-такой-сессии',
  })

  assert.equal(theEvent(p).change, 'ch', 'единственная поставка — не догадка, а единственный вариант')
})

test('Д-1: событие без поставки видно в доске живой поставки, а не теряется', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'] })
  emptyChangeBeside(p)

  hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'dev-1',
    prompt: 'FIRM2-TICKET: T-001\nFIRM2-ATTEMPT: 1\nРаботай.', // тикет есть, поставки в промпте нет
  })

  const e = theEvent(p)
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.change, null)

  const seen = listEvents(p.root, { change: 'zz-живая' })
  assert.equal(seen.length, 1, 'событие без поставки обязано попадать в выборку любой поставки')

  const board = computeBoard(p.root, 'zz-живая')
  const task = board.tasks.find((x) => x.id === 'T-001')
  assert.equal(task.status, 'in_progress', `доска должна видеть стадию в работе, а видит: ${task.status}`)
})

test('Д-1: транскрипт появился позже — читатель достраивает обе привязки', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'] })
  emptyChangeBeside(p)

  // Транскрипта в момент старта ещё нет — ровно так было на проект-В.
  hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'dev-1',
    session_id: 'sess-1',
  })
  const e0 = theEvent(p)
  assert.equal(e0.ticket, 'unknown')
  assert.equal(e0.change, null, 'в файле — то, что было известно в тот момент (ADR-0003)')

  // Рантайм дописал транскрипт стадии: он и есть источник обеих привязок.
  subagentTranscript(p, { session: 'sess-1', agent: 'dev-1', ticket: 'T-001', change: 'zz-живая' })

  const [e] = listEvents(p.root, { change: 'zz-живая' })
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.change, 'zz-живая', 'поставка должна достроиться оттуда же, откуда тикет')
  assert.equal(e._ticket_from, 'transcript')
})

test('имя поставки с не-ASCII буквами читается целиком, а не до первой из них', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'] })
  emptyChangeBeside(p)
  // Транскрипт на месте уже к старту — тогда хук привязывает сразу, без достройки.
  subagentTranscript(p, { session: 'sess-1', agent: 'dev-1', ticket: 'T-001', change: 'zz-живая' })

  hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'dev-1',
    session_id: 'sess-1',
  })

  const e = theEvent(p)
  assert.equal(e.ticket, 'T-001')
  // `[\w.-]` в образце маркера обрывал имя на первой не-ASCII букве и записывал `zz-`:
  // имя, не совпадающее ни с одной поставкой, то есть приписка не туда без следа.
  assert.equal(e.change, 'zz-живая', `имя поставки обрезано: ${e.change}`)
})

// ── Д-2: doctor слеп, когда дыра именно в поле поставки ───────────────────────
test('Д-2: doctor находит событие, приписанное чужой поставке', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'] })
  const other = emptyChangeBeside(p)

  // Ровно то, что движок писал до починки Д-1: задача живой поставки, поставка — соседняя.
  writeEvent(p.root, {
    change: other, ticket: 'T-001', stage: 'dev', event: 'started', actor: 'firm2:firm-developer',
    attempt: 1, agent_id: 'dev-1', source: 'hook',
  })

  const d = p.evJson('doctor', '--change', 'zz-живая')
  assert.equal(d.json.ok, false, 'приписка не туда — находка, а не норма')
  assert.equal(d.json.misfiled.length, 1, `должна быть одна находка: ${JSON.stringify(d.json.misfiled)}`)
  assert.match(d.json.misfiled[0], /T-001 принадлежит «zz-живая»/)
})

test('Д-2: на честном журнале находки нет', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'] })
  emptyChangeBeside(p)
  writeEvent(p.root, {
    change: 'zz-живая', ticket: 'T-001', stage: 'dev', event: 'started', actor: 'firm2:firm-developer',
    attempt: 1, agent_id: 'dev-1', source: 'hook',
  })
  // И отдельно: событие БЕЗ поставки — это не приписка не туда, а честное «неизвестно».
  writeEvent(p.root, {
    change: null, ticket: 'T-001', stage: 'dev', event: 'finished', actor: 'firm2:firm-developer',
    attempt: 1, agent_id: 'dev-1', source: 'hook',
  })
  const d = p.evJson('doctor', '--change', 'zz-живая')
  assert.deepEqual(d.json.misfiled, [], `находок быть не должно: ${JSON.stringify(d.json.misfiled)}`)
})

// ── Д-44: на старте привязывает ЯРЛЫК вызова, а не транскрипт ────────────────
//
// Замер по журналу проект-В 02.11.2026: с 28.10 рантайм пишет первой строкой транскрипта
// свою преамбулу («[Workflow harness — user request] …»), а промпт стадии с маркером
// приходит второй строкой, следующим ходом. На `SubagentStart` в файле только преамбула —
// 595 стартов из ~600 уехали с `ticket: "unknown"` против 3 из 27 до неё. Цена: отказ
// паузы на старте `dev` стоит под условием «тикет известен» и не сработал ни разу за пять
// дней, то есть пауза держалась одной линией вместо двух.

// Транскрипт КАК СЕЙЧАС: первая строка — преамбула рантайма, маркера в ней нет. Рядом —
// мета-файл с `description`, то есть с нашим собственным ярлыком вызова.
function startingAgent(p, { session, agent, label, preamble = true }) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), session, 'subagents', 'workflows', 'wf_test',
  )
  mkdirSync(dir, { recursive: true })
  if (preamble) {
    writeFileSync(
      join(dir, `agent-${agent}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '[Workflow harness — user request] The harness relays, verbatim…' },
      }) + '\n',
    )
  }
  if (label) writeFileSync(join(dir, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'firm2:firm-tester', description: label }))
}

test('Д-44: старт привязан по ярлыку вызова, хотя маркера в транскрипте ещё нет', (t) => {
  const p = makeProject(t, { tasks: ['T-264'] })
  startingAgent(p, { session: 'sess-d44', agent: 'a1', label: 'test:T-264#2 [claude-sonnet-5-5]' })

  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'a1',
    session_id: 'sess-d44',
  })
  assert.equal(r.status, 0, r.stderr)
  const e = theEvent(p)
  assert.equal(e.ticket, 'T-264', 'ярлык вызова пишет код движка — это не догадка')
  assert.equal(e.attempt, 2, 'номер попытки взят из #<цифры> того же ярлыка')
  assert.equal(e.stage, 'test')
})

test('Д-44: ярлыка нет — старт по-прежнему unknown, а не угадан', (t) => {
  // Запасной путь не должен превращаться в догадку: нет ярлыка — нет и привязки.
  const p = makeProject(t, { tasks: ['T-264'] })
  startingAgent(p, { session: 'sess-d44b', agent: 'a2', label: null })

  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'a2',
    session_id: 'sess-d44b',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(theEvent(p).ticket, 'unknown')
})

test('Д-44: маркер в транскрипте сильнее ярлыка', (t) => {
  // Ярлык — запасной путь. Промпт стадии несёт и поставку, и попытку, и он первичен.
  const p = makeProject(t, { change: 'ch', tasks: ['T-001'] })
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), 'sess-d44c', 'subagents', 'workflows', 'wf_test',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent-a3.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'FIRM2-TICKET: T-001\nFIRM2-CHANGE: ch\nFIRM2-ATTEMPT: 1' } }) + '\n',
  )
  writeFileSync(join(dir, 'agent-a3.meta.json'), JSON.stringify({ description: 'test:T-999#7' }))

  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'a3',
    session_id: 'sess-d44c',
  })
  assert.equal(r.status, 0, r.stderr)
  const e = theEvent(p)
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.attempt, 1)
  assert.equal(e.change, 'ch')
})

test('Д-44: заглушка T-XXX в ярлыке привязкой не становится', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  startingAgent(p, { session: 'sess-d44d', agent: 'a4', label: 'adjudicate:T-XXX#1' })

  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'a4',
    session_id: 'sess-d44d',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(theEvent(p).ticket, 'unknown', 'T-XXX — заглушка шаблонов, и она уже уезжала в журнал привязкой к несуществующей задаче')
})

test('Д-44: пауза снова держит старт новой задачи — вторая линия ожила', (t) => {
  // То, чем дефект платился: отказ стоит под условием «тикет известен», и пять дней не
  // срабатывал ни разу (в журнале проект-В ноль событий guard/pause-held).
  const p = makeProject(t, { tasks: ['T-300'] })
  p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json'])
  startingAgent(p, { session: 'sess-d44e', agent: 'a5', label: 'dev:T-300#1 [claude-sonnet-5-5]' })

  const r = hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'a5',
    session_id: 'sess-d44e',
  })
  assert.equal(r.status, 2, 'пауза отказывает старту новой задачи')
  const held = listEvents(p.root, {}).filter((e) => e.stage === 'guard' && e.event === 'pause-held')
  assert.equal(held.length, 1)
  assert.equal(held[0].ticket, 'T-300')
})

// ── Поправка к Д-44 по отчёту проект-В 03.11.2026 (находка 2) ──────────────────
//
// Починка 0.4.122 была написана верно и не сработала ни разу: ярлык искался ПО ПУТИ
// транскрипта, а на `SubagentStart` транскрипта нет вовсе. Тесты выше этого не поймали
// именно потому, что сами кладут оба файла сразу — оснастка была щедрее рантайма.
//
// Замер по стадии теста T-291 (одна из 1612 непривязанных событий поставки): событие
// 13:43:07, мета-файл 13:43:09, транскрипт 14:07:04 — то есть к финишу стадии. Отсюда три
// проверки ниже: мета без транскрипта, мета с опозданием и ярлык стадии уровня поставки.
function metaOnly(p, { session, agent, label }) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), session, 'subagents', 'workflows', 'wf_test',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'firm2:firm-tester', description: label }))
  return dir
}

test('находка 2: транскрипта на старте НЕТ, а ярлык всё равно привязывает', (t) => {
  const p = makeProject(t, { tasks: ['T-291'] })
  metaOnly(p, { session: 'sess-f2a', agent: 'b1', label: 'test:T-291#3 [claude-sonnet-5-5]' })

  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'b1',
    session_id: 'sess-f2a',
  })
  assert.equal(r.status, 0, r.stderr)
  const e = theEvent(p)
  assert.equal(e.ticket, 'T-291', 'ровно тот случай, что дал 37 % журнала без тикета')
  assert.equal(e.attempt, 3)
})

test('находка 2: мета-файл опоздал на секунду — старт его ДОЖДАЛСЯ', (t) => {
  const p = makeProject(t, { tasks: ['T-291'] })
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), 'sess-f2b', 'subagents', 'workflows', 'wf_test',
  )
  mkdirSync(dir, { recursive: true })
  // Отставание рантайма воспроизводим так же, как оно случается: файл появляется ПОСЛЕ
  // того, как хук уже позван. Иначе проверка меряет не ожидание, а наличие файла.
  const late = spawn('sh', ['-c',
    `sleep 1; printf '%s' '{"description":"dev:T-291#1"}' > ${JSON.stringify(join(dir, 'agent-b2.meta.json'))}`,
  ], { detached: true, stdio: 'ignore' })
  late.unref()

  const r = hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'b2',
    session_id: 'sess-f2b',
  })
  assert.equal(r.status, 0, r.stderr)
  const e = theEvent(p)
  assert.equal(e.ticket, 'T-291', 'две секунды отставания рантайма нечем обойти, кроме ожидания')
  assert.ok(e.bind_wait_ms >= 500, `цена ожидания обязана быть в событии: ${e.bind_wait_ms}`)
})

test('находка 2: ярлык стадии поставки привязывает к MR', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  metaOnly(p, { session: 'sess-f2c', agent: 'b3', label: 'review:MR' })

  const r = hook(p, {
    agent_type: 'firm2:firm-reviewer-qa',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'b3',
    session_id: 'sess-f2c',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(theEvent(p).ticket, 'MR', 'у MR-ревью, архива спеки и прототипа тикета нет по устройству')
})

test('находка 2: ни ярлыка, ни транскрипта — unknown, но с замером ожидания', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })

  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStart',
    cwd: p.root,
    agent_id: 'b4',
    session_id: 'sess-f2d',
  })
  assert.equal(r.status, 0, r.stderr)
  const e = theEvent(p)
  assert.equal(e.ticket, 'unknown', 'догадываться нельзя: ложь хуже дыры')
  assert.ok(e.bind_wait_ms >= 4000,
    `«файла не было и через пять секунд» — это доказательство, а не предположение: ${e.bind_wait_ms}`)
})

test('находка 2: на ФИНИШЕ движок не ждёт ничего', (t) => {
  // Ожидание платное и стоит там, где без него будет `unknown`. На финише транскрипт уже
  // есть, и пятисекундная пауза на каждой стадии была бы чистым убытком.
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = Date.now()
  const r = hook(p, {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStop',
    cwd: p.root,
    agent_id: 'b5',
    session_id: 'sess-f2e',
  })
  assert.equal(r.status, 2, 'событие без привязки на финише — дыра, и хук обязан сказать громко')
  assert.ok(Date.now() - started < 3000, 'финиш не ждёт мета-файл')
})
