// Потеря члена QA-панели (дефект проект-В, 05.10.2026).
//
// Что было: член панели из трёх упал, agent() вернул null, `.filter(Boolean)` молча выбросил
// его, и панель решила «2 из 2 принято» без третьего. В журнале следа не было.
//
// Что должно быть теперь (firm2/workflows/firm2-build.js, askQa / reviewPanel / reviewOne /
// recordQaLoss / buildTicket):
//   - упавшего члена перезапускают один раз (label `<label>-retry`);
//   - не вышло — он ПОТЕРЯН, и неполная панель задачу не принимает;
//   - потеря без единого «отклонено», либо с «отклонено», которое Архитектор снял
//     (not_blocker), — эскалация человеку, а не принятие и не новый заход Разработчика;
//   - потеря с blocker — обычный возврат к Разработчику;
//   - в журнал (стадией DevOps) пишется guard/qa-member-lost, а при эскалации ещё
//     review/escalated; запись делается в конце попытки, после адъюдикации.
//
// Workflow-скрипт — не модуль: `export const meta`, затем тело с top-level await и глобалами
// agent / parallel / log / phase / args. Рантайма Claude Code здесь нет, поэтому тест
// собирает из файла асинхронную функцию и зовёт её со скриптованными заглушками агентов.
// Прод-код при этом исполняется настоящий — подменяется только то, что за agent().
//
// Скрипт можно подменить переменной FIRM2_BUILD_SCRIPT (путь к файлу): так мутационная
// проверка гоняется на копии, а не на живом файле, который параллельно правят.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

const ACCEPT = { verdict: 'принято', notes: 'ок' }
const REJECT = { verdict: 'отклонено', notes: 'не закрыт критерий 2' }

const RISKY = { id: 'T-001', path: 't.md', labels: ['факточувствительный'], parallel_safe: true }
const PLAIN = { id: 'T-001', path: 't.md', labels: [], parallel_safe: true }

// qa — { <label>: ответ | null }: ответ на вызов с ТОЧНО таким label; null — «упал».
// Не названный label отвечает «принято». Повтор — отдельный label (`...-retry`), поэтому
// «упал один раз» и «упал оба раза» различаются ключами.
// adj — вердикт Архитектора на адъюдикации.
async function runBuild({ task = RISKY, qa = {}, adj = 'not_blocker' } = {}) {
  const calls = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt, opts })
    if (label === 'пауза?') return { state: 'running' }
    // Основание сверки (BR-165): движок снимает красные на ветке-цели один раз на прогон.
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha0000', head: 'ma1nsha0000', cmd: 'suite', red: [], failed: 0, total: 10 }
    // Зонд состояния поставки (Д-8.2/8.4): здесь поставка не меняется по ходу, значит
    // ответ — ровно то, что было в args.
    if (label === 'состояние поставки') return { state: 'ok', exists: [task.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    // Дифф задачи снимает движок (Д-37), а с 0.4.118 срыв этого зонда ещё и пишется
    // событием (Д-41) — заглушка обязана его знать, иначе тест ловит чужой сбой.
    if (label.startsWith('дифф:')) {
      return { state: 'ok', base: 'base0000', added: 10, deleted: 1, files: [{ path: 'a.ts', added: 10, deleted: 1 }], uncommitted: [] }
    }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return {
        status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 },
        mutation_check: { done: true, evidence: 'мутация → 1 упал' },
      }
    }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) {
      return label in qa ? qa[label] : ACCEPT
    }
    if (label.startsWith('adjudicate:')) return { verdict: adj, bug_path: 'docs/bugs/BUG-001.md' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const logs = []
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const args = JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '', tasks: [task],
  })
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, args)
  const labels = calls.map((c) => c.label)
  return {
    out, calls, labels, logs,
    task: out.tasks[0],
    journal: calls.filter((c) => c.label.startsWith('journal:')),
    retries: labels.filter((l) => l.endsWith('-retry')),
  }
}

const LOST = '--event qa-member-lost'
const ESCALATED = '--event escalated'

// ── 1. Все живы ───────────────────────────────────────────────────────────────

test('панель: все трое живы и «принято» — принято, без перезапусков и без записи в журнал', async () => {
  const r = await runBuild()
  assert.equal(r.task.accepted, true)
  assert.equal(r.task.attempts, 1)
  assert.equal(r.task.panel, true)
  assert.deepEqual(r.retries, [])
  assert.deepEqual(r.journal, [])
  assert.deepEqual(r.task.qa_incidents, [])
  assert.ok(r.labels.includes('merge:T-001'), 'принятая задача должна идти в слияние')
})

// ── 2. Упал один раз, перезапуск спас ─────────────────────────────────────────

test('панель: член #2 упал один раз, на перезапуске ответил — принято, в журнале одна диагностика без эскалации', async () => {
  const r = await runBuild({ qa: { 'qa-panel:T-001#1.2': null } })
  assert.equal(r.task.accepted, true)
  assert.equal(r.task.attempts, 1)
  assert.deepEqual(r.retries, ['qa-panel:T-001#1.2-retry'])
  assert.equal(r.journal.length, 1, 'ровно один journal:')
  assert.equal(r.journal[0].label, 'journal:T-001#1')
  assert.ok(r.journal[0].prompt.includes(LOST), 'команда qa-member-lost')
  assert.ok(!r.journal[0].prompt.includes(ESCALATED), 'эскалации в записи быть не должно')
  assert.ok(r.journal[0].prompt.includes('--ticket T-001 --attempt 1'))
  assert.equal(r.task.qa_incidents.length, 1)
  assert.equal(r.task.qa_incidents[0].escalated, false)
  assert.equal(r.task.qa_incidents[0].lost, 0, 'перезапуск спас — потерянных нет')
  assert.equal(r.task.qa_incidents[0].seats, 3)
})

test('панель: запись о потере делается в конце попытки — после всех голосов и до слияния', async () => {
  const r = await runBuild({ qa: { 'qa-panel:T-001#1.2': null } })
  const at = (l) => r.labels.indexOf(l)
  assert.ok(at('journal:T-001#1') > at('qa-panel:T-001#1.2-retry'))
  assert.ok(at('journal:T-001#1') > at('qa-panel:T-001#1.1'))
  assert.ok(at('journal:T-001#1') > at('qa-panel:T-001#1.3'))
  assert.ok(at('journal:T-001#1') < at('merge:T-001'))
})

// ── 3. Потерян окончательно, возражений нет ───────────────────────────────────

test('панель: член #2 упал оба раза, остальные «принято» — НЕ принято, эскалация, второй попытки нет', async () => {
  const r = await runBuild({
    qa: { 'qa-panel:T-001#1.2': null, 'qa-panel:T-001#1.2-retry': null },
  })
  assert.equal(r.task.accepted, false)
  assert.equal(r.task.escalate, true)
  assert.equal(r.task.attempts, 1)
  assert.ok(!r.labels.includes('dev:T-001#2'), 'Разработчика заново звать не за чем')
  assert.ok(!r.labels.some((l) => l.startsWith('adjudicate:')), 'возражений нет — адъюдикации нет')
  assert.ok(!r.labels.includes('merge:T-001'), 'неполной панелью в слияние не идём')
  assert.deepEqual(r.retries, ['qa-panel:T-001#1.2-retry'], 'перезапуск ровно один')
  assert.equal(r.journal.length, 1)
  assert.ok(r.journal[0].prompt.includes(LOST))
  assert.ok(r.journal[0].prompt.includes(ESCALATED), 'задача уходит человеку — событие escalated')
  assert.equal(r.task.qa_incidents.length, 1)
  assert.equal(r.task.qa_incidents[0].escalated, true)
  assert.equal(r.task.qa_incidents[0].lost, 1)
  assert.equal(r.task.qa_incidents[0].seats, 3)
})

// ── 4. Потерян + dissent, который Архитектор снял ─────────────────────────────

test('панель: потеря + dissent, Архитектор not_blocker — НЕ принято, эскалация; запись после адъюдикации', async () => {
  const r = await runBuild({
    qa: {
      'qa-panel:T-001#1.1': REJECT,
      'qa-panel:T-001#1.2': null, 'qa-panel:T-001#1.2-retry': null,
    },
    adj: 'not_blocker',
  })
  assert.equal(r.task.accepted, false)
  assert.equal(r.task.escalate, true)
  assert.equal(r.task.attempts, 1)
  assert.ok(!r.labels.includes('dev:T-001#2'))
  assert.ok(!r.labels.includes('merge:T-001'))
  assert.equal(r.journal.length, 1, 'одна запись на попытку, а не по записи на ветку')
  assert.ok(r.journal[0].prompt.includes(LOST))
  assert.ok(r.journal[0].prompt.includes(ESCALATED))
  const adjAt = r.labels.findIndex((l) => l.startsWith('adjudicate:'))
  const jAt = r.labels.findIndex((l) => l.startsWith('journal:'))
  assert.ok(adjAt >= 0, 'dissent должен дойти до Архитектора')
  assert.ok(jAt > adjAt, 'запись о потере — после адъюдикации, иначе её перекроет adjudicate/accepted')
  assert.deepEqual(r.task.bugs, ['docs/bugs/BUG-001.md'], 'баг Архитектора не теряется')
  assert.equal(r.task.qa_incidents[0].escalated, true)
})

// ── 5. Потерян + blocker ──────────────────────────────────────────────────────

test('панель: потеря + dissent, Архитектор blocker — обычный возврат к Разработчику, эскалации в записи нет', async () => {
  const r = await runBuild({
    qa: {
      'qa-panel:T-001#1.1': REJECT,
      'qa-panel:T-001#1.2': null, 'qa-panel:T-001#1.2-retry': null,
    },
    adj: 'blocker',
  })
  assert.ok(r.labels.includes('dev:T-001#2'), 'blocker — задача идёт на попытку 2')
  assert.equal(r.task.attempts, 2)
  // На попытке 2 все живы и «принято» (заглушка по умолчанию) — задача принята.
  assert.equal(r.task.accepted, true)
  assert.equal(r.journal.length, 1, 'потеря случилась только на попытке 1')
  assert.equal(r.journal[0].label, 'journal:T-001#1')
  assert.ok(r.journal[0].prompt.includes(LOST))
  assert.ok(!r.journal[0].prompt.includes(ESCALATED), 'человеку задача не уходит — события escalated нет')
  assert.equal(r.task.qa_incidents.length, 1)
  assert.equal(r.task.qa_incidents[0].escalated, false)
  assert.equal(r.task.qa_incidents[0].lost, 1)
  const adjAt = r.labels.findIndex((l) => l.startsWith('adjudicate:'))
  assert.ok(r.labels.findIndex((l) => l.startsWith('journal:')) > adjAt)
})

// ── 6. Одиночный ревьюер (не рискованная задача) ──────────────────────────────

test('одиночный ревьюер: упал оба раза — НЕ принято, эскалация, журнал с обеими командами', async () => {
  const r = await runBuild({
    task: PLAIN,
    qa: { 'qa:T-001#1': null, 'qa:T-001#1-retry': null },
  })
  assert.equal(r.task.panel, false)
  assert.equal(r.task.accepted, false)
  assert.equal(r.task.escalate, true)
  assert.equal(r.task.attempts, 1)
  assert.ok(!r.labels.includes('dev:T-001#2'))
  assert.ok(!r.labels.includes('merge:T-001'))
  assert.deepEqual(r.retries, ['qa:T-001#1-retry'])
  assert.equal(r.journal.length, 1)
  assert.ok(r.journal[0].prompt.includes(LOST))
  assert.ok(r.journal[0].prompt.includes(ESCALATED))
  assert.equal(r.task.qa_incidents[0].seats, 1)
  assert.equal(r.task.qa_incidents[0].lost, 1)
  assert.equal(r.task.qa_incidents[0].escalated, true)
})

test('одиночный ревьюер: упал один раз, перезапуск ответил — принято, в журнале только qa-member-lost', async () => {
  const r = await runBuild({ task: PLAIN, qa: { 'qa:T-001#1': null } })
  assert.equal(r.task.accepted, true)
  assert.deepEqual(r.retries, ['qa:T-001#1-retry'])
  assert.equal(r.journal.length, 1)
  assert.ok(r.journal[0].prompt.includes(LOST))
  assert.ok(!r.journal[0].prompt.includes(ESCALATED))
  assert.equal(r.task.qa_incidents[0].escalated, false)
  assert.equal(r.task.qa_incidents[0].lost, 0)
  assert.ok(r.labels.includes('merge:T-001'))
})

test('одиночный ревьюер: жив с первого раза — ни перезапуска, ни записи', async () => {
  const r = await runBuild({ task: PLAIN })
  assert.equal(r.task.accepted, true)
  assert.deepEqual(r.retries, [])
  assert.deepEqual(r.journal, [])
  assert.deepEqual(r.task.qa_incidents, [])
})

// ── 7. Регрессия исходного дефекта ────────────────────────────────────────────

for (const seat of [1, 2, 3]) {
  test(`регрессия проект-В 05.10.2026: место #${seat} потеряно, двое других «принято» — «2 из 2» не принимает`, async () => {
    const qa = { [`qa-panel:T-001#1.${seat}`]: null, [`qa-panel:T-001#1.${seat}-retry`]: null }
    const r = await runBuild({ qa })
    assert.equal(r.task.accepted, false, 'два голоса из трёх — не приёмка')
    assert.equal(r.task.escalate, true)
    assert.ok(!r.labels.includes('merge:T-001'), 'в слияние такая задача не идёт')
    assert.ok(r.journal.length >= 1, 'потеря обязана оставить след в журнале')
    assert.ok(r.journal.every((j) => j.prompt.includes(LOST)))
  })
}
