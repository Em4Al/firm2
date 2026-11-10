// Цена исключительности, названная вслух. Задача без `parallel_safe` идёт ОДНА и
// занимает собой все слоты. Поведение правильное, но до 05.10.2026 оно было УМОЛЧАНИЕМ:
// поле не заполнено — значит исключительная, и сказать об этом было некому. Замер
// обкатки проект-В: 43 задачи из 72 исключительные, 82% рабочего времени машина вела одну
// стадию при трёх настроенных слотах.
//
// Движок поведение НЕ меняет и за Архитектора не решает: он требует причину (ADR-0007 —
// молчаливое решение перестаёт быть молчаливым). Предупреждение про ДОЛЮ исключительных
// задач (50%/60%) заменено 05.10.2026 ценой в волнах (`cost_of_exclusive` из planShape,
// см. firm2/tests/planshape.test.mjs) — доля ничего не говорила о календаре: цепочка
// бывает последовательной по существу, и там 60% исключительных не стоят ничего.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDashboard } from '../scripts/dashboard.mjs'
import { listTasks, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

function writeTask(p, id, { safe = false, why = null, deps = [] } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: todo\n` +
      (safe ? 'parallel_safe: true\n' : '') +
      (why ? `exclusive_why: ${why}\n` : '') +
      (deps.length ? `depends_on: [${deps.join(', ')}]\n` : '') +
      '---\n\nПроверочная задача.\n\n- [ ] критерий один\n',
  )
}

const merged = (p, id) =>
  writeEvent(p.root, {
    ts: '2026-09-30T10:00:00.000Z', change: p.change, ticket: id,
    stage: 'merge', event: 'finished', actor: 'test',
  })

function buildArgs(p) {
  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const silentWarn = (w) => w.find((x) => x.includes('без причины')) || null

// ── Поле доезжает до сборщика ────────────────────────────────────────────────

test('exclusive_why читается из frontmatter и попадает в каждую задачу build-args', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { why: 'общий alembic-ревизион, две миграции разом не сольются' })
  writeTask(p, 'T-002', { safe: true })

  assert.equal(listTasks(p.root, p.change).find((x) => x.id === 'T-001').exclusive_why,
    'общий alembic-ревизион, две миграции разом не сольются')

  const by = new Map(buildArgs(p).tasks.map((x) => [x.id, x]))
  assert.equal(by.get('T-001').exclusive_why, 'общий alembic-ревизион, две миграции разом не сольются',
    'планировщик обязан назвать причину в тот момент, когда за неё платят слотами')
  assert.equal(by.get('T-002').exclusive_why, null)
})

// ── Предупреждение «без причины» ─────────────────────────────────────────────

test('без причины: названы ровно те задачи, где исключительность молчит', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001') // исключительная и молчит
  writeTask(p, 'T-002', { why: 'правит общий конфиг сборки' })
  writeTask(p, 'T-003', { safe: true })
  writeTask(p, 'T-004', { safe: true })

  const w = silentWarn(buildArgs(p).warnings)
  assert.ok(w, `предупреждение обязано быть: ${JSON.stringify(buildArgs(p).warnings)}`)
  assert.match(w, /\(1\): T-001/)
  assert.doesNotMatch(w, /T-002/, 'названная причина — это решение, а не умолчание')
  assert.doesNotMatch(w, /T-003|T-004/, 'параллельная задача слотов не занимает')
  assert.match(w, /exclusive_why/, 'надо сказать, чем закрыть претензию')
})

test('у всех исключительных есть причина — предупреждения нет', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { why: 'общая миграция' })
  writeTask(p, 'T-002', { safe: true })

  assert.equal(silentWarn(buildArgs(p).warnings), null)
})

test('исключительных нет вовсе — молчим про обе беды', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { safe: true })
  writeTask(p, 'T-002', { safe: true })

  const w = buildArgs(p).warnings
  assert.equal(silentWarn(w), null)
  assert.equal(w.some((x) => x.includes('exclusive')), false, 'ни одной исключительной — цены в волнах тоже нет')
})

// Предупреждение про ДОЛЮ (50%/60%) заменено ценой в волнах — см.
// firm2/tests/planshape.test.mjs, раздел «exclusivityWarnings: цена в волнах вместо доли».

// ── Дашборд: заметка и чип ───────────────────────────────────────────────────

const html = (p) => readFileSync(buildDashboard(p.root, p.change), 'utf8')
const BANNER = /Прогон будет почти однополосным/

test('баннер: при доле выше половины среди незавершённых', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002')
  writeTask(p, 'T-003', { safe: true })

  const h = html(p)
  assert.match(h, BANNER)
  assert.match(h, /Из 3 незавершённых задач 2 \(67%\)/)
  assert.match(h, /Причина не названа у 2: T-001, T-002/)
})

test('баннер: задача с причиной в список молчащих не попадает', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { why: 'общая схема БД' })
  writeTask(p, 'T-002')
  writeTask(p, 'T-003', { safe: true })

  const h = html(p)
  assert.match(h, BANNER, 'доля считается по всем исключительным, названа причина или нет')
  assert.match(h, /Причина не названа у 1: T-002/)
  assert.doesNotMatch(h, /Причина не названа у 1: T-001/)
})

test('баннер: влитые и отменённые в долю не входят', (t) => {
  // Иначе на доделанной поставке заметка висела бы вечно: влитые задачи были
  // исключительными, но слотов они больше не занимают.
  const p = makeProject(t, { tasks: [] })
  for (const id of ['T-040', 'T-041', 'T-042', 'T-043', 'T-044']) {
    writeTask(p, id) // исключительные и уже влитые
    merged(p, id)
  }
  writeTask(p, 'T-001')
  for (const id of ['T-002', 'T-003', 'T-004', 'T-005']) writeTask(p, id, { safe: true })

  const h = html(p)
  assert.doesNotMatch(h, BANNER,
    'живых исключительных одна из пяти — прогон широкий, и пугать нечем')
})

test('баннер: при малой доле его нет', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002', { safe: true })
  writeTask(p, 'T-003', { safe: true })

  assert.doesNotMatch(html(p), BANNER)
})

test('чип «одна» стоит у исключительной задачи и несёт причину в подсказке', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { why: 'правит общий conftest.py' })
  writeTask(p, 'T-002', { safe: true })
  writeTask(p, 'T-003')

  const h = html(p)
  const row = (id) => (h.match(new RegExp(`<tr[^>]*><td class="mono">${id}<[\\s\\S]*?</tr>`)) || [])[0] || ''

  assert.match(row('T-001'), /<span class="chip one" title="правит общий conftest\.py">одна<\/span>/,
    'цена для всего прогона видна в таблице наравне с метками')
  assert.doesNotMatch(row('T-002'), /chip one/, 'у параллельной задачи чипа быть не должно')
  assert.match(row('T-002'), /∥/)
  assert.match(row('T-003'), /title="причина не указана">одна</,
    'молчание тоже показывается — именно его и надо заметить')
})
