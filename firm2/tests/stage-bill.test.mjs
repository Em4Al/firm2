// Счёт стадии: куда делось её время. Пятый замер движка, заведён по разбору 30.10.2026.
//
// Вопрос «почему стадия теста шла два с половиной часа» машинного ответа не имел: журнал
// знает начало и конец стадии и ничего не знает о том, что внутри. Ответ пришлось
// собирать руками по транскрипту субагента — и он оказался не про нарезку задач и не про
// лишние тесты: время ушло в циклы ожидания прогонов, запущенных фоном.
//
// Замер, как и остальные четыре, НИЧЕГО не запрещает: код возврата всегда 0 (ADR-0009).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

const TEST_CMD = 'stack:\n  test_cmd: "suite -q"\n  task_test_cmd: "suite -q"\n'

// Транскрипт субагента там, где его кладёт рантайм. Нас интересуют только вызовы Bash со
// штампом времени: из них и считается, шла стадия или ждала.
function transcript(p, { session = 's1', agent, calls }) {
  const dir = join(
    process.env.CLAUDE_CONFIG_DIR, 'projects',
    String(p.root).replace(/[^A-Za-z0-9]/g, '-'), session, 'subagents',
  )
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `agent-${agent}.jsonl`),
    calls.map(([ts, cmd]) => JSON.stringify({
      type: 'assistant', timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] },
    })).join('\n') + '\n',
  )
}

function stage(p, { ticket, stageName = 'test', agent, calls, event = 'finished' }) {
  transcript(p, { agent, calls })
  writeEvent(p.root, {
    ts: calls[calls.length - 1][0], change: p.change, ticket, stage: stageName, event,
    actor: 'firm2:firm-tester', attempt: 1, agent_id: agent, session_id: 's1', source: 'hook',
  })
}

const bill = (p, args = []) => JSON.parse(p.cli('stage-bill.mjs', ['--json', ...args]).stdout)

const T = (m) => `2026-10-30T16:${String(m).padStart(2, '0')}:00.000Z`

test('ожидание считается фактом — временем до следующего вызова, а не намерением команды', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: TEST_CMD })
  stage(p, {
    ticket: 'T-001', agent: 'a1',
    calls: [
      [T(0), 'git status --short'],
      [T(5), 'for i in $(seq 1 29); do [ -f done ] && break; sleep 20; done'], // ждала 10 минут
      [T(15), 'grep -n FAILED log'],
    ],
  })
  const r = bill(p)
  assert.equal(r.stages, 1)
  assert.equal(r.span_ms, 15 * 60000, 'шла — от первого вызова до последнего')
  assert.equal(r.waited_ms, 10 * 60000, 'ждала — ровно промежуток после вызова, который только спал')
  assert.equal(r.waited_share, 67)
  assert.equal(r.stages_detail[0].polls, 1)
})

test('полный прогон набора отличается от адресного, и исключающий флаг его не маскирует', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: TEST_CMD })
  stage(p, {
    ticket: 'T-001', agent: 'a2',
    calls: [
      [T(0), 'suite -q'],                                   // полный
      [T(2), 'suite -q --ignore=tests/test_meta.py'],       // тоже полный: минус один файл
      [T(4), 'suite -q tests/test_x.py::test_one'],         // адресный
      [T(6), 'node --test web/test/browser/t199.mjs'],      // адресный
    ],
  })
  const r = bill(p)
  assert.equal(r.full_runs, 2, 'исключающий флаг называет путь, но прогон от этого адресным не становится')
})

test('стадия считается по агенту, а не по событию: панель из трёх не умножает время втрое', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: TEST_CMD })
  stage(p, { ticket: 'T-001', stageName: 'review', agent: 'a3', calls: [[T(0), 'ls'], [T(8), 'ls']] })
  // Тот же агент пишет второе событие (финиш и вердикт) — стадия от этого не удваивается.
  writeEvent(p.root, {
    ts: T(8), change: p.change, ticket: 'T-001', stage: 'review', event: 'accepted',
    actor: 'firm2:firm-reviewer-qa', attempt: 1, agent_id: 'a3', session_id: 's1', source: 'hook',
  })
  const r = bill(p)
  assert.equal(r.stages, 1, 'одна стадия — один агент')
  assert.equal(r.span_ms, 8 * 60000)
})

test('перерасход бюджета виден в замере, а бюджеты названы', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: TEST_CMD })
  transcript(p, { agent: 'a4', calls: [[T(0), 'ls'], [T(50), 'ls']] })
  writeEvent(p.root, {
    ts: T(50), change: p.change, ticket: 'T-001', stage: 'test', event: 'finished',
    actor: 'firm2:firm-tester', attempt: 1, agent_id: 'a4', session_id: 's1', source: 'hook',
    over_budget: { minutes: 50, budget: 30 },
  })
  const r = bill(p)
  assert.equal(r.over_budget, 1)
  assert.deepEqual(r.budgets, { dev: 30, test: 30 })
  assert.deepEqual(r.stages_detail[0].over_budget, { minutes: 50, budget: 30 })
})

test('транскриптов нет — замер молчит словами «не записано», а не нулями', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: TEST_CMD })
  writeEvent(p.root, {
    ts: T(0), change: p.change, ticket: 'T-001', stage: 'dev', event: 'finished',
    actor: 'firm2:firm-developer', attempt: 1, agent_id: 'нет-такого', session_id: 's1', source: 'hook',
  })
  const r = p.cli('stage-bill.mjs', [])
  assert.equal(r.status, 0, 'замер ничего не запрещает (ADR-0009)')
  assert.match(r.stdout, /не записано/)
  assert.match(r.stdout, /а не «стадии были мгновенными»/,
    'пустой замер обязан называть себя пустым: молчание тут читается как «всё быстро»')
  assert.equal(bill(p).stages, 0)
})

test('одна задача — ключ --ticket, и в счёт идёт только она', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'], extraConfig: TEST_CMD })
  stage(p, { ticket: 'T-001', agent: 'b1', calls: [[T(0), 'ls'], [T(10), 'ls']] })
  stage(p, { ticket: 'T-002', agent: 'b2', calls: [[T(0), 'ls'], [T(30), 'ls']] })
  assert.equal(bill(p).stages, 2)
  const one = bill(p, ['--ticket', 'T-002'])
  assert.equal(one.stages, 1)
  assert.equal(one.span_ms, 30 * 60000)
})
