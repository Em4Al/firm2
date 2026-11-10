// Вердикт стадии доезжает до журнала. Разбор 02.10.2026: на четыре пилотных проекта
// 328 событий `review/finished` и ровно одно `review/accepted` — хук читал
// `last_assistant_message`, а structured output роли приходит отдельным блоком
// `tool_use` в СОБСТВЕННОМ транскрипте субагента. Поле не пустое и не сломанное, просто
// отвечает не на тот вопрос, и молчание выглядело как «ревью ничего не сказало».
//
// Проверяется три слоя: чтение хвоста транскрипта (единица), сквозной путь хука
// (журнал), и то, что записанное видно там, ради чего всё затевалось — в `last_verdict`
// аргументов сборки.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  structuredOutputFromTranscript, structuredOutputFromAgent, computeBoard, writeEvent,
} from '../scripts/lib/firm.mjs'
import { makeProject, isoAgo } from './helpers.mjs'

const TAIL_BYTES = 1048576 // порог чтения в tailOfFile; тесты обязаны его перешагнуть

// Строка транскрипта: ответ ассистента со structured output. Имя инструмента то же, что
// кладёт рантайм.
const outLine = (input, role = 'assistant', name = 'StructuredOutput') =>
  JSON.stringify({
    type: 'assistant',
    message: { role, content: [{ type: 'text', text: 'All claims verified' }, { type: 'tool_use', name, input }] },
  })

const textLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

function transcript(p, name, lines) {
  const path = join(p.root, `${name}.jsonl`)
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

const ACCEPTED = {
  verdict: 'принято',
  notes: 'замечаний нет, оба критерия закрыты',
  criteria_results: [
    { criterion: 'критерий один', status: 'выполнено' },
    { criterion: 'критерий два', status: 'не выполнено' },
  ],
}

// ── Чтение хвоста ────────────────────────────────────────────────────────────

test('хвост: транскрипт больше порога чтения — structured output в конце находится', (t) => {
  const p = makeProject(t)
  // Пара мегабайт мусорных строк: настоящий транскрипт стадии именно такой, и до правки
  // вердикт искали в первых 64 КБ (headOfFile) — то есть не находили никогда.
  const junk = []
  let bytes = 0
  while (bytes < 2 * TAIL_BYTES) {
    const l = textLine('x'.repeat(500))
    junk.push(l)
    bytes += l.length + 1
  }
  const path = transcript(p, 'big', [...junk, outLine(ACCEPTED)])
  assert.ok(bytes > TAIL_BYTES, 'сцена должна перешагнуть порог, иначе тест ничего не проверяет')

  assert.deepEqual(structuredOutputFromTranscript(path), ACCEPTED)
})

test('хвост: обрезанная первая строка вердиктом не считается', (t) => {
  const p = makeProject(t)
  // Чтение с середины файла разрезает строку. Сцена подобрана по байтам так, что разрез
  // приходится ровно на `{` вложенного объекта: обрезок — синтаксически валидный JSON с
  // полем verdict. Половина строки, которую автор не писал, не должна становиться
  // решением стадии — поэтому первая строка окна выбрасывается целиком.
  const half = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input: { verdict: 'ОБРЕЗОК' } }] },
  })
  // size - TAIL_BYTES обязан попасть на начало `half`:
  //   len(pad) + len(half) + 1 + len(filler) - TAIL_BYTES === len(pad)
  const fillerLen = TAIL_BYTES - 1 - Buffer.byteLength(half)
  assert.ok(fillerLen > 1, 'арифметика сцены')
  const pad = 'p'.repeat(TAIL_BYTES) // чтобы файл был заведомо больше порога
  const filler = 'f'.repeat(fillerLen - 1) + '\n' // без tool_use: вердиктом быть не может
  const path = join(p.root, 'cut.jsonl')
  writeFileSync(path, pad + half + '\n' + filler)

  assert.equal(structuredOutputFromTranscript(path), null,
    'без выброса первой строки обрезок прошёл бы как настоящий вердикт')
})

// ── Какой именно блок считается вердиктом ────────────────────────────────────

test('берётся ПОСЛЕДНИЙ structured output, а не первый попавшийся', (t) => {
  const p = makeProject(t)
  const path = transcript(p, 'two', [
    outLine({ verdict: 'отклонено', notes: 'черновик' }),
    textLine('переделал проверку'),
    outLine({ verdict: 'принято', notes: 'итог' }),
  ])
  assert.deepEqual(structuredOutputFromTranscript(path), { verdict: 'принято', notes: 'итог' })
})

test('блок из сообщения пользователя вердиктом не считается', (t) => {
  const p = makeProject(t)
  const path = transcript(p, 'user', [
    outLine({ verdict: 'принято', notes: 'ассистент' }),
    outLine({ verdict: 'отклонено', notes: 'это сказал не ревьюер' }, 'user'),
  ])
  assert.deepEqual(structuredOutputFromTranscript(path), { verdict: 'принято', notes: 'ассистент' },
    'последний по порядку блок — пользовательский, и брать его нельзя')
})

test('tool_use без verdict/escalate/status пропускается, разбор идёт дальше', (t) => {
  const p = makeProject(t)
  const path = transcript(p, 'tools', [
    outLine({ verdict: 'принято', notes: 'настоящий' }),
    outLine({ file_path: '/x/y.md', content: 'правка файла' }), // обычный инструмент
  ])
  assert.deepEqual(structuredOutputFromTranscript(path), { verdict: 'принято', notes: 'настоящий' })
})

test('чужой инструмент с полем status вердикта не перехватывает', (t) => {
  const p = makeProject(t)
  // `status` — слишком частое поле, чтобы по одному ему опознавать вердикт: мы идём по
  // ВСЕМ ходам стадии, и последний ход часто чужой. Имя инструмента здесь и решает.
  const path = transcript(p, 'alien', [
    outLine({ verdict: 'принято', notes: 'настоящий' }),
    outLine({ status: 'ok', command: 'pytest -q' }, 'assistant', 'Bash'),
  ])
  assert.deepEqual(structuredOutputFromTranscript(path), { verdict: 'принято', notes: 'настоящий' })
})

test('structured output с одним лишь status по-прежнему находится', (t) => {
  const p = makeProject(t)
  // Роли без вердикта (Разработчик, Тестировщик) возвращают именно такую форму —
  // потерять её значило бы вернуть прежнюю тишину другим концом.
  const path = transcript(p, 'statusonly', [outLine({ status: 'ok', tests: [] })])
  assert.deepEqual(structuredOutputFromTranscript(path), { status: 'ok', tests: [] })

  // И имя сверяется без учёта регистра: оно приходит от рантайма, а не от движка.
  const other = transcript(p, 'case', [outLine({ status: 'fail' }, 'assistant', 'structuredoutput')])
  assert.deepEqual(structuredOutputFromTranscript(other), { status: 'fail' })
})

test('битая строка и отсутствующий файл — null, а не исключение', (t) => {
  const p = makeProject(t)
  assert.equal(structuredOutputFromTranscript(join(p.root, 'нет-такого.jsonl')), null)
  assert.equal(structuredOutputFromTranscript(null), null)
  assert.equal(structuredOutputFromTranscript(transcript(p, 'junk', ['не json вовсе', '{"a":1}'])), null)

  // Битая строка с tool_use не должна съедать разбор: ниже по файлу есть настоящий.
  const path = transcript(p, 'broken', [
    outLine({ verdict: 'принято', notes: 'целый' }),
    '{"message":{"role":"assistant","content":[{"type":"tool_use"', // обрыв записи
  ])
  assert.deepEqual(structuredOutputFromTranscript(path), { verdict: 'принято', notes: 'целый' })
})

test('structuredOutputFromAgent находит транскрипт по session_id и agent_id', (t) => {
  const p = makeProject(t)
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), 'sess-1', 'subagents',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-qa-7.jsonl'), outLine({ verdict: 'отклонено', notes: 'по agent_id' }) + '\n')

  assert.deepEqual(structuredOutputFromAgent(p.root, 'sess-1', 'qa-7'),
    { verdict: 'отклонено', notes: 'по agent_id' })
  assert.equal(structuredOutputFromAgent(p.root, 'sess-1', 'нет-такого'), null)
})

// ── Сквозь хук в журнал ──────────────────────────────────────────────────────

const MARKER = (ticket) => textLine(`FIRM2-TICKET: ${ticket}\nFIRM2-CHANGE: ch\nFIRM2-ATTEMPT: 1`)

function hook(p, payload) {
  return p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })
}

function events(p) {
  return p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
}

test('ревью: вердикт из транскрипта даёт accepted с критериями, а не голый finished', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = transcript(p, 'review', [MARKER('T-001'), outLine(ACCEPTED)])

  const r = hook(p, {
    agent_type: 'firm2:firm-reviewer-qa',
    hook_event_name: 'SubagentStop',
    cwd: p.root,
    agent_id: 'qa-1',
    agent_transcript_path: path,
    // Ровно то, что рантайм кладёт в нагрузку: последняя реплика текстом, не JSON.
    last_assistant_message: 'All claims verified',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)

  const [e] = events(p)
  assert.equal(e.stage, 'review')
  assert.equal(e.event, 'accepted', 'из-за этого на пилотах было 328 finished и ни одного accepted')
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.notes, ACCEPTED.notes)
  assert.deepEqual(e.criteria, [
    { c: 'критерий один', s: 'выполнено' },
    { c: 'критерий два', s: 'не выполнено' },
  ])
})

test('ревью: отклонение и эскалация приезжают тем же путём', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const rejected = transcript(p, 'rej', [MARKER('T-001'),
    outLine({ verdict: 'отклонено', notes: 'тест не покрывает второй критерий' })])
  hook(p, {
    agent_type: 'firm2:firm-reviewer-qa', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'qa-1', agent_transcript_path: rejected, last_assistant_message: 'done',
  })
  assert.equal(events(p)[0].event, 'rejected')
  assert.equal(events(p)[0].notes, 'тест не покрывает второй критерий')

  const esc = transcript(p, 'esc', [MARKER('T-001'),
    outLine({ verdict: 'отклонено', escalate: true, notes: 'нужен человек' })])
  hook(p, {
    agent_type: 'firm2:firm-reviewer-qa', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'qa-2', agent_transcript_path: esc, last_assistant_message: 'done',
  })
  assert.ok(events(p).some((e) => e.event === 'escalated'), 'эскалация — отдельный исход')
})

test('ревью: транскрипта нет — событие остаётся finished (контроль сцены)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = hook(p, {
    agent_type: 'firm2:firm-reviewer-qa',
    hook_event_name: 'SubagentStop',
    cwd: p.root,
    agent_id: 'qa-1',
    agent_transcript_path: join(p.root, 'нет-такого.jsonl'),
    last_assistant_message: 'All claims verified',
    prompt: 'FIRM2-TICKET: T-001',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.equal(events(p)[0].event, 'finished',
    'выдумывать вердикт за молчащую роль движок не вправе (ADR-0007)')
})

test('ревью: JSON в last_assistant_message по-прежнему сильнее транскрипта', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = transcript(p, 'review', [MARKER('T-001'), outLine({ verdict: 'отклонено', notes: 'из транскрипта' })])
  hook(p, {
    agent_type: 'firm2:firm-reviewer-qa', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'qa-1', agent_transcript_path: path,
    last_assistant_message: 'итог: {"verdict":"принято","notes":"из сообщения"}',
  })
  const [e] = events(p)
  assert.equal(e.event, 'accepted', 'первый источник дешевле и остаётся первым')
  assert.equal(e.notes, 'из сообщения')
})

test('ревью: вердикт берётся и без пути в нагрузке — по agent_id', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), 'sess-qa', 'subagents',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-qa-9.jsonl'),
    [MARKER('T-001'), outLine({ verdict: 'принято', notes: 'нашли по agent_id' })].join('\n') + '\n')

  const r = hook(p, {
    agent_type: 'firm2:firm-reviewer-qa', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'qa-9', session_id: 'sess-qa', last_assistant_message: 'All claims verified',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const [e] = events(p)
  assert.equal(e.event, 'accepted')
  assert.equal(e.notes, 'нашли по agent_id')
})

// ── Адъюдикация расхождения панели ───────────────────────────────────────────

function adjudicate(p, input, ticket = 'T-001') {
  const path = transcript(p, `adj-${ticket}`, [MARKER(ticket), outLine(input)])
  const r = hook(p, {
    agent_type: 'firm2:firm-architect', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: `arch-${ticket}`, agent_transcript_path: path, last_assistant_message: 'разобрал расхождение',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  return r
}

test('адъюдикация: blocker — это rejected в журнале и rework у задачи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  adjudicate(p, {
    verdict: 'blocker',
    notes: 'падает на пустом вводе, критерий два не закрыт',
    bug_path: 'openspec/changes/ch/bugs/BUG-001.md',
  })

  const [e] = events(p)
  assert.equal(e.stage, 'adjudicate')
  assert.equal(e.event, 'rejected', 'до правки здесь было finished, и причина отклонения терялась')
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.notes, 'падает на пустом вводе, критерий два не закрыт баг: openspec/changes/ch/bugs/BUG-001.md')

  assert.equal(computeBoard(p.root, p.change).tasks[0].status, 'rework')
})

test('адъюдикация: not_blocker — accepted в журнале и accepted у задачи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  adjudicate(p, { verdict: 'not_blocker', notes: 'замечание стилевое, к критериям не относится' })

  const [e] = events(p)
  assert.equal(e.event, 'accepted')
  assert.equal(e.notes, 'замечание стилевое, к критериям не относится')
  assert.equal(computeBoard(p.root, p.change).tasks[0].status, 'accepted')
})

test('адъюдикация: эскалация значит эскалацию — как на любом другом финише', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  adjudicate(p, { verdict: 'blocker', escalate: true, notes: 'расхождение не разрешить без человека' })

  const [e] = events(p)
  assert.equal(e.stage, 'adjudicate')
  assert.equal(e.event, 'escalated',
    'ни finished, ни rejected: «на одном финише эскалация значит эскалацию, а на соседнем ничего» — скрытое расхождение')
  assert.equal(e.notes, 'расхождение не разрешить без человека')
  assert.equal(computeBoard(p.root, p.change).tasks[0].status, 'blocked',
    'эскалация останавливает задачу до арбитража человека')
})

test('адъюдикация: вердикт виден в last_verdict аргументов сборки', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  adjudicate(p, {
    verdict: 'blocker',
    notes: 'тест проверяет не то, что написано в критерии',
    bug_path: 'openspec/changes/ch/bugs/BUG-002.md',
  })

  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const task = JSON.parse(r.stdout).tasks.find((x) => x.id === 'T-001')
  assert.ok(task.last_verdict, 'это и был дефект: на проект-В вердикт вписывали в задачу руками')
  assert.equal(task.last_verdict.event, 'rejected')
  assert.match(task.last_verdict.notes, /тест проверяет не то/)
  assert.match(task.last_verdict.notes, /баг: openspec\/changes\/ch\/bugs\/BUG-002\.md/)
})

test('адъюдикация: роль без вердикта не выдумывает исход', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = transcript(p, 'adj-silent', [MARKER('T-001'), textLine('посмотрел, думаю ещё')])
  hook(p, {
    agent_type: 'firm2:firm-architect', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'arch-1', agent_transcript_path: path, last_assistant_message: 'посмотрел',
  })
  assert.equal(events(p)[0].event, 'finished')
  assert.equal(computeBoard(p.root, p.change).tasks[0].status, 'ready',
    'финиш без вердикта статуса задачи не двигает')
})

// ── Задачи вне прогона: машинный список ──────────────────────────────────────

test('build-args: skipped_by_id совпадает по составу со строковым skipped', (t) => {
  // Статус задачи движок берёт из журнала, а не из frontmatter (ADR-0001), поэтому
  // состояния задач расставляются событиями.
  const p = makeProject(t, { tasks: ['T-001', 'T-040', 'T-041', 'T-042', 'T-043'] })
  const ev = (ticket, stage, event, hoursAgo) =>
    writeEvent(p.root, {
      ts: isoAgo(hoursAgo), change: p.change, ticket, stage, event, actor: 'test',
    })
  ev('T-040', 'merge', 'finished', 5)
  ev('T-041', 'review', 'escalated', 4) // эскалация = blocked, ждёт арбитража человека
  ev('T-042', 'merge', 'finished', 3)
  ev('T-042', 'release', 'finished', 2)
  ev('T-043', 'lifecycle', 'superseded', 1)

  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const json = JSON.parse(r.stdout)

  assert.deepEqual(json.skipped_by_id, {
    'T-040': 'merged', 'T-041': 'blocked', 'T-042': 'released', 'T-043': 'superseded',
  }, 'планировщик отличает влитую зависимость от ненайденной только по этому полю')
  assert.deepEqual(
    Object.entries(json.skipped_by_id).map(([id, s]) => `${id}: ${s}`).sort(),
    [...json.skipped].sort(),
    'два представления одного списка обязаны совпадать, иначе одно из них врёт',
  )
  assert.deepEqual(json.tasks.map((x) => x.id), ['T-001'], 'в прогон пропущенные не входят')
})
