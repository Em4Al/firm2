// Привязка стадий РАЗВЕДКИ к теме и замер её стоимости.
//
// До 0.4.105 стадии груминга уезжали в журнал с `ticket: MR` и `change: null`. Дырой это
// не было — `doctor` зелёный, привязка достраивалась по `agent_id`, — но стоило замера:
// сказать «разведка темы G-007 обошлась во столько» было нечем, и ретро проект-В 3.2
// пришлось спаривать события по `agent_id`, потому что спаривать было больше не по чему.
//
// Тесты держат четыре решения, и каждое можно было принять иначе:
//   1. стадию разведки выдаёт МАРКЕР, а не роль: Архитектор в сборке ведёт `adjudicate`,
//      на груминге — разведку, и различить их по `agent_type` нельзя принципиально;
//   2. поэтому роль, которой в таблице «роль → стадия» нет вовсе (PM), на груминге стадию
//      получает — а в сборке по-прежнему молчит;
//   3. тикет задачи ПЕРЕБИВАЕТ тему: задача конкретнее;
//   4. номер темы не попадает в занятые номера задач, иначе `next-id` считал бы темы
//      задачами и выдавал бы занятые номера.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { groomCost, groomCostLines, nextIds, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

const hook = (p, payload) => p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })
const events = (p) => p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))

// Транскрипт субагента там, где его кладёт рантайм: имя файла из `agent_id`, первая
// строка — промпт стадии с маркерами, которые положила команда.
function transcript(p, { session, agent, marks, tokens = null }) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), session, 'subagents',
  )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `agent-${agent}.jsonl`)
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: `${marks}\nРаботай.` } })]
  if (tokens) {
    lines.push(JSON.stringify({
      type: 'assistant', requestId: `r-${agent}`,
      message: { role: 'assistant', model: 'claude-opus-5', usage: tokens },
    }))
  }
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

function stage(p, { agent, role, marks, session = 'сессия-1', tokens = null }) {
  const path = transcript(p, { session, agent, marks, tokens })
  // Путь к собственному транскрипту рантайм кладёт в нагрузку на финише, но не на старте —
  // ровно поэтому маркер темы на старте ищется по `agent_id`, а счёт токенов существует
  // только у события финиша.
  hook(p, { agent_type: role, hook_event_name: 'SubagentStart', cwd: p.root, agent_id: agent, session_id: session })
  hook(p, {
    agent_type: role, hook_event_name: 'SubagentStop', cwd: p.root, agent_id: agent,
    session_id: session, agent_transcript_path: path,
  })
}

test('маркер темы даёт стадию groom и привязку к теме — у любой из трёх ролей', (t) => {
  const p = makeProject(t, { tasks: [] })
  stage(p, { agent: 'a1', role: 'firm2:firm-architect', marks: 'FIRM2-GROOM: G-007' })
  const ev = events(p)
  assert.ok(ev.length >= 2, `событий должно быть два: ${ev.length}`)
  for (const e of ev) {
    assert.equal(e.stage, 'groom', 'роль та же, что в сборке ведёт adjudicate — стадию здесь решает маркер')
    assert.equal(e.ticket, 'G-007')
  }
  assert.equal(ev[0].actor, 'firm2:firm-architect', 'кто именно вёл разведку — в actor, а не в стадии')
})

test('PM, которой в таблице «роль → стадия» нет, на груминге стадию получает', (t) => {
  const p = makeProject(t, { tasks: [] })
  stage(p, { agent: 'a2', role: 'firm2:firm-pm', marks: 'FIRM2-GROOM: G-008' })
  assert.equal(events(p).length, 2, 'в сборке PM не участвует и молчит, на разведке — пишет')
  assert.equal(events(p)[0].stage, 'groom')
})

test('маркер задачи перебивает маркер темы: задача конкретнее', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, { agent: 'a3', role: 'firm2:firm-developer', marks: 'FIRM2-TICKET: T-001\nFIRM2-GROOM: G-009' })
  const last = events(p).pop()
  assert.equal(last.ticket, 'T-001')
  assert.equal(last.stage, 'dev', 'стадия сборки остаётся стадией сборки')
})

test('номер темы не попадает в занятые номера задач', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeEvent(p.root, { ticket: 'G-042', stage: 'groom', event: 'finished', actor: 'firm2:firm-pm' })
  const n = nextIds(p.root, { kind: 'task' })
  assert.equal(n.next, 'T-001')
  // `used_count` — число занятых номеров, и человек читает его как «столько задач в
  // проекте». Тема задачей не является, и считать её здесь значит врать в это число:
  // номер `G-042` в выдачу не влияет (`idNumber` его не разбирает), а счётчик — да.
  assert.equal(n.used_count, 0, 'тема — не занятый номер задачи')
})

test('замер складывает заходы темы: токены, работу и кто вёл', (t) => {
  const p = makeProject(t, { tasks: [] })
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 }
  stage(p, { agent: 'b1', role: 'firm2:firm-pm', marks: 'FIRM2-GROOM: G-007', tokens: usage })
  stage(p, { agent: 'b2', role: 'firm2:firm-architect', marks: 'FIRM2-GROOM: G-007', tokens: usage })
  stage(p, { agent: 'b3', role: 'firm2:firm-pm', marks: 'FIRM2-GROOM: G-008', tokens: usage })
  const c = groomCost(p.root)
  assert.equal(c.themes, 2)
  assert.equal(c.runs, 3)
  const g7 = c.per_theme.find((r) => r.id === 'G-007')
  assert.equal(g7.runs, 2)
  assert.ok(g7.tokens > 0, 'токены берутся с финиша: на старте транскрипта ещё нет')
  assert.deepEqual(Object.keys(g7.actors).sort(), ['firm2:firm-architect', 'firm2:firm-pm'])
})

test('второй финиш одного захода не удваивает токены темы', (t) => {
  // Рантайм пишет SubagentStop не один раз на заход, и каждое событие несёт ПОЛНЫЙ счёт
  // заново — транскрипт к тому моменту лишь дорос. Складывать их значит считать одну
  // работу дважды (замер проект-В 25.10.2026: 37 заходов из 808, завышение в полтора раза).
  const p = makeProject(t, { tasks: [] })
  const small = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 }
  const big = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3000 }
  stage(p, { agent: 'd1', role: 'firm2:firm-pm', marks: 'FIRM2-GROOM: G-011', tokens: small })
  const one = groomCost(p.root).per_theme[0].tokens
  const path = transcript(p, { session: 'сессия-1', agent: 'd1', marks: 'FIRM2-GROOM: G-011', tokens: big })
  hook(p, {
    agent_type: 'firm2:firm-pm', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'd1', session_id: 'сессия-1', agent_transcript_path: path,
  })
  // Третий финиш — с усечённым транскриптом: счёт в нём МЕНЬШЕ. Меньший счёт позже по
  // времени означает неполное чтение, а не подешевевшую работу, поэтому «последний» здесь
  // не годится — только максимум.
  const short = transcript(p, { session: 'сессия-1', agent: 'd1', marks: 'FIRM2-GROOM: G-011', tokens: small })
  hook(p, {
    agent_type: 'firm2:firm-pm', hook_event_name: 'SubagentStop', cwd: p.root,
    agent_id: 'd1', session_id: 'сессия-1', agent_transcript_path: short,
  })
  const r = groomCost(p.root).per_theme[0]
  assert.equal(r.runs, 1, 'заход один — события финиша три')
  assert.equal(r.tokens, 3030, 'ровно второй счёт целиком: 10 + 20 + 3000')
  assert.ok(r.tokens > one, `берётся больший счёт, а не первый (${one})`)
  assert.notEqual(r.tokens, one + 3030, 'и не сумма двух финишей')
})

test('незакрытый заход считается отдельно, а не нулём работы', (t) => {
  const p = makeProject(t, { tasks: [] })
  transcript(p, { session: 'с', agent: 'c1', marks: 'FIRM2-GROOM: G-010' })
  hook(p, { agent_type: 'firm2:firm-pm', hook_event_name: 'SubagentStart', cwd: p.root, agent_id: 'c1', session_id: 'с' })
  const r = groomCost(p.root).per_theme[0]
  assert.equal(r.runs, 1)
  assert.equal(r.open_runs, 1, 'открытый интервал — это «идёт» или «сняли», и выдавать его за ноль значит занижать замер')
})

test('record события темы не приписывает его активной поставке', (t) => {
  // Разведка поставки не материализует (ADR-0012). Активная поставка в проекте при этом
  // есть всегда, и подстановка по умолчанию записала бы тему в чужую поставку — то есть
  // в поле, по которому потом считают цену этой поставки.
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.ev('record', '--ticket', 'G-011', '--stage', 'groom', '--event', 'finished',
    '--actor', 'human', '--notes', 'досье написано')
  assert.equal(r.status, 0, r.stderr)
  const ev = events(p).find((e) => e.ticket === 'G-011')
  assert.equal(ev.change, null, 'у темы поставки нет')
  const forced = p.ev('record', '--ticket', 'G-011', '--stage', 'groom', '--event', 'started',
    '--change', p.change, '--actor', 'human')
  assert.equal(forced.status, 0, forced.stderr)
  assert.equal(
    events(p).find((e) => e.ticket === 'G-011' && e.event === 'started').change, p.change,
    'названную явно поставку движок не переспрашивает',
  )
})

test('пустой замер говорит «не записано», а не «бесплатно»', (t) => {
  const p = makeProject(t, { tasks: [] })
  const c = groomCost(p.root)
  assert.equal(c.themes, 0)
  assert.match(groomCostLines(c).join('\n'), /не «бесплатно», а «не записано»/)
})
