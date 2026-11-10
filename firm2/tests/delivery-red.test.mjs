// Красное поставки обязано быть подтверждено снимком, а не словом.
//
// Отчёт проект-В 04.11.2026 по воротам G-014: `delivery_red` назвал красным
// `tests/test_t047_qa_goal_card_text.py`, а четыре прогона (включая `-n 4 --dist loadfile`)
// дали зелёный; приписанное основание содержало два markdown-файла. То есть в итог прогона
// уехало ИЗМЕРЕНИЕ, выданное за красное, и стоило это хода на опровержение.
//
// Класс тот же, что Д-43 (закрыт в 0.4.120 полем `head` у зонда основания): признак привязан
// к ревизии, которую никто не доказал. Разница в предмете: там доказывали ревизию, здесь —
// принадлежность красного. Утверждение «внесла поставка» проверяемо целиком: красное обязано
// стоять на точке ветвления и НЕ стоять на ветке-цели.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

async function run({ deliveryRed = [], trunkRed = [], baseRed = [] } = {}) {
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание: точка ветвления')) {
      return { state: 'ok', sha: 'ba5e00000000', head: 'ba5e00000000', cmd: 'suite', red: baseRed, failed: baseRed.length, total: 10 }
    }
    if (label.startsWith('основание:')) {
      return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'suite', red: trunkRed, failed: trunkRed.length, total: 10 }
    }
    if (label === 'состояние поставки') return { state: 'ok', exists: ['T-101'], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return {
        status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 },
        mutation_check: { done: true, evidence: 'м' }, delivery_red: deliveryRed,
      }
    }
    if (label.startsWith('qa')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label.startsWith('merge-failed:') || label.startsWith('journal:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (ths) => Promise.all(ths.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    // Зонды основания без этих трёх ключей не работают вовсе (и честно возвращают null),
    // а без снимков нечем и подтверждать: проверка существует только там, где есть чем.
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/tmp/firm2-wt', task_test_cmd: 'suite', test_cmd: 'suite',
    tasks: [{ id: 'T-101', path: 'T-101.md', labels: [], parallel_safe: true }],
  }))
  return { out, text: logs.join('\n') }
}

const stateOf = (out, name) => (out.delivery_red_check || []).find((c) => c.name === name) || null

test('красное, стоящее на точке ветвления и не на ветке-цели, — подтверждено снимком', async () => {
  const r = await run({ deliveryRed: ['tests/test_a.py'], baseRed: ['tests/test_a.py'], trunkRed: [] })
  assert.equal(stateOf(r.out, 'tests/test_a.py').state, 'confirmed')
  assert.match(r.text, /подтверждено снимком основания/)
  assert.match(stateOf(r.out, 'tests/test_a.py').why, /ba5e0000/, 'подтверждение называет ревизию, а не себя')
})

test('красное, которого нет ни на точке ветвления, ни на ветке-цели, названо НЕПОДТВЕРЖДЁННЫМ', async () => {
  // Ровно случай проект-В: имя в списке есть, за именем — ничего.
  const r = await run({ deliveryRed: ['tests/test_t047_qa_goal_card_text.py'], baseRed: [], trunkRed: [] })
  const c = stateOf(r.out, 'tests/test_t047_qa_goal_card_text.py')
  assert.equal(c.state, 'unproven')
  assert.match(r.text, /НЕ ПОДТВЕРЖДЕНО/)
  assert.match(r.text, /прогони их адресно|проверь прогоном/,
    'движок не снимает утверждение сам (ADR-0009) — он называет, чем оно не подтверждено')
  // Из списка имя НЕ исчезает: снять красное у поставки может только человек.
  assert.ok((r.out.delivery_red || []).includes('tests/test_t047_qa_goal_card_text.py'))
})

test('красное, стоящее на ветке-цели, поставке не принадлежит — и это сказано', async () => {
  const r = await run({ deliveryRed: ['tests/test_b.py'], baseRed: ['tests/test_b.py'], trunkRed: ['tests/test_b.py'] })
  assert.equal(stateOf(r.out, 'tests/test_b.py').state, 'pre-existing')
  assert.match(r.text, /предсуществующее/)
})

test('имя сверяется по сути: узел теста и файл — одно и то же красное', async () => {
  const r = await run({
    deliveryRed: ['tests/test_c.py::test_one'],
    baseRed: ['tests/test_c.py'],
    trunkRed: [],
  })
  assert.equal(stateOf(r.out, 'tests/test_c.py::test_one').state, 'confirmed',
    'иначе проверка краснела бы на форме записи, а не на существе — это был бы шум')
})
