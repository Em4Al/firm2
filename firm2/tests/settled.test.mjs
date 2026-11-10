// Что поставка знает о себе СЕЙЧАС — для планировщика идущего прогона. Разбор проект-В
// 12–13.10.2026 (Д-8.2, Д-8.4): планировщик живёт списком задач из `args`, снятым на старте,
// а истина о поставке — журнал (ADR-0001). Всё, что меняется за часы прогона, для него не
// существует: задача, заведённая по ходу, не видна (а зависимость на неё считалась
// ВЫПОЛНЕННОЙ), задача, слияние которой человек довёл руками, навсегда вне `done`.
//
// Workflow-скрипт файлов не читает, поэтому ответ отдаётся командой и нарочно узкий: два
// списка идентификаторов, никакой интерпретации.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'

function task(p, id, { status = 'todo', deps = [] } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nparallel_safe: true\n` +
      `depends_on: [${deps.join(', ')}]\n---\n\n## Критерии приёмки\n\n- [ ] сделано\n`,
  )
}
const settled = (p) => JSON.parse(p.cli('firm-state.mjs', ['settled', '--json', '--root', p.root]).stdout)

test('exists называет и задачу, заведённую после старта прогона', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-101')
  task(p, 'T-106') // её в args прогона не было
  const s = settled(p)
  assert.deepEqual(s.exists.sort(), ['T-101', 'T-106'])
  assert.deepEqual(s.merged, [], 'ничего не влито — списку влитых взяться неоткуда')
})

test('merged берётся из журнала, а не из файла задачи', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-102')
  // Статус в файле остаётся прежним: истину о слиянии держит журнал (И-5, ADR-0005).
  p.ev('record', '--ticket', 'T-102', '--stage', 'merge', '--event', 'finished', '--actor', 'human')
  const s = settled(p)
  assert.deepEqual(s.merged, ['T-102'], 'влито по журналу — зависимые обязаны разблокироваться')
  assert.ok(s.exists.includes('T-102'))
})

test('выпущенная задача считается влитой: иначе зависимые ждут навсегда', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-090')
  p.ev('record', '--ticket', 'T-090', '--stage', 'merge', '--event', 'finished', '--actor', 'human')
  p.ev('record', '--ticket', 'T-090', '--stage', 'release', '--event', 'finished', '--actor', 'human')
  assert.deepEqual(settled(p).merged, ['T-090'])
})

test('поставки нет — пустые списки, а не падение', (t) => {
  const p = makeProject(t, { tasks: [], archived: true })
  const s = settled(p)
  assert.ok(Array.isArray(s.exists) && Array.isArray(s.merged))
})

// ── Д-63: признак «вернулась разбором эскалации» ─────────────────────────────
//
// Отчёт проект-В 09.11.2026. `T-388` эскалировала, человек разобрал по ходу прогона и записал
// `lifecycle/arbitrated`, доска показала `ready` — а прогон задачу не взял. Статус `ready`
// сам по себе ответа не даёт: такой же он и до разбора, и у задачи, которая вообще не
// эскалировала. Поэтому признак отдельный и считается по журналу — у промпта нет часов.
const rec = (p, id) => settled(p).workable.find((t) => t.id === id)

test('разбор ПОСЛЕ эскалации — признак возврата есть, и время обоих событий названо', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-388')
  p.ev('record', '--ticket', 'T-388', '--stage', 'dev', '--event', 'started', '--actor', 'test')
  p.ev('record', '--ticket', 'T-388', '--stage', 'dev', '--event', 'escalated', '--actor', 'test')
  p.ev('record', '--ticket', 'T-388', '--stage', 'lifecycle', '--event', 'arbitrated', '--actor', 'human')
  const r = rec(p, 'T-388')
  assert.ok(r.returned_from_escalation, 'задачу, разбор которой записан, прогон обязан увидеть')
  assert.ok(r.returned_from_escalation.escalated_ts)
  assert.ok(r.returned_from_escalation.arbitrated_ts >= r.returned_from_escalation.escalated_ts)
  assert.equal(r.returned_from_escalation.actor, 'human')
  assert.equal(r.attempt, 1, 'попытка остаётся горевшей: разбор лишнего захода не даёт (Д-11)')
})

test('эскалация без разбора — признака нет: задача ждёт человека, а не прогона', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-388')
  p.ev('record', '--ticket', 'T-388', '--stage', 'dev', '--event', 'started', '--actor', 'test')
  p.ev('record', '--ticket', 'T-388', '--stage', 'dev', '--event', 'escalated', '--actor', 'test')
  assert.equal(rec(p, 'T-388'), undefined, 'эскалировавшая задача из рабочего набора выходит (blocked)')
})

test('новая эскалация обнуляет прежний разбор: решение прошлого круга не ответ на текущий затык', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-388')
  for (const [stage, event, actor] of [
    ['dev', 'started', 'test'], ['dev', 'escalated', 'test'],
    ['lifecycle', 'arbitrated', 'human'],
    ['dev', 'started', 'test'], ['dev', 'escalated', 'test'],
  ]) p.ev('record', '--ticket', 'T-388', '--stage', stage, '--event', event, '--actor', actor)
  // Задача снова ждёт человека, и в рабочем наборе её нет — значит и подхватывать нечего.
  assert.equal(rec(p, 'T-388'), undefined)
})

test('задача без эскалации вовсе признака не несёт', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-200')
  assert.equal(rec(p, 'T-200').returned_from_escalation, null)
})
