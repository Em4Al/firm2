// НА КАКОМ КОДЕ ШЛА СТАДИЯ — И ПОЛЕ ТОЛЬКО ТОГДА, КОГДА ЭТО НОВОСТЬ.
//
// Наблюдение проект-В 10.11.2026 (седьмой прогон, попытка 2): `scripts/` читаются по
// `engine_root` живьём, значит доставка движка меняет код ПОД ИДУЩЕЙ ВОЛНОЙ — стадии,
// начатые до пуша, работают на старом коде, начатые после — на новом, и на одну попытку
// может прийтись смешанный. Само по себе это не дефект: обкатка и значит, что движок
// меняется под проектом. Дефект — в том, что эта граница оставалась ПОДОЗРЕНИЕМ: роль своей
// версии не знает, а журнал её не помнил, и «попытка дала странное» нечем было ни
// подтвердить, ни опровергнуть (ADR-0007).
//
// Замер двусторонний, и вторая сторона тут важнее первой: поле пишется ТОЛЬКО при
// расхождении. Одинаковое значение на каждом событии читалось бы как «механизм работает»,
// ничего при этом не меря, — та же ловушка, из-за которой `bind_wait_ms` пишется только
// когда ожидание было.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProject } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ACTUAL = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version

function finish(p) {
  const path = join(p.root, 'agent.jsonl')
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input: { status: 'ok' } }] },
  }) + '\n')
  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-developer', hook_event_name: 'SubagentStop', cwd: p.root, agent_id: 'dr-1',
      prompt: `FIRM2-TICKET: T-001\nFIRM2-CHANGE: ${p.change}`, agent_transcript_path: path,
    }),
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const evs = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
  return evs.find((e) => e.event === 'finished' && e.stage === 'dev')
}

test('стадия на другом коде, чем записано у проекта, оставляет улику в событии', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'engine_version: "0.0.1"\n' })
  const fin = finish(p)
  assert.ok(fin, 'финиш записан')
  assert.deepEqual(fin.engine_drift, { recorded: '0.0.1', actual: ACTUAL })
})

test('при совпадении версий поля нет — улика без новости была бы шумом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: `engine_version: "${ACTUAL}"\n` })
  const fin = finish(p)
  assert.ok(fin, 'финиш записан')
  assert.ok(!('engine_drift' in fin), `поле лишнее: ${JSON.stringify(fin.engine_drift)}`)
})

test('версии у проекта не записано вовсе — это не расхождение, а молчание', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const fin = finish(p)
  assert.ok(fin, 'финиш записан')
  // Проект, который adopt ещё не звал, не «разошёлся» — ему просто нечем расходиться, и
  // выдавать это за улику значит называть незнание находкой (И-12).
  assert.ok(!('engine_drift' in fin), 'отсутствие записанной версии расхождением не считается')
})
