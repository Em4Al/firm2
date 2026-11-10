// Метка `чувствительный-к-безопасности`: ось ревью, которой у движка не было.
//
// Поставлена 15.10.2026 по разбору ECC (`docs/ecc-ingest.md`, пункт 2). Защита движка была
// только инфраструктурной — песочница, guard-хуки, нечитаемый `.env`, — а на код самой
// поставки по этой оси не смотрел никто: ни пункта в DoD, ни триггера в ревью.
//
// Эти тесты держат три вещи, и каждая — страховка от превращения метки в украшение:
//   • метка поднимает ПАНЕЛЬ, а не просто попадает в промпт;
//   • в промпте ревью есть требование отдельного абзаца по безопасности;
//   • метка СИЛЬНЕЕ короткой полосы: иначе панель обходится второй меткой, и обход этот
//     выглядел бы законной оптимизацией.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const SECURITY_LABEL = 'чувствительный-к-безопасности'
const SHORT_LANE_LABEL = 'короткая-полоса'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

// Та же оснастка, что в `short-lane.test.mjs`: настоящее тело сборщика с заглушкой вместо
// `agent()`. Прогон по телу, а не по копии логики, — единственный способ проверить, что
// метка меняет МАРШРУТ, а не только текст.
async function run({ labels = [], short_lane = [], lane = { state: 'ok', verdict: 'подтверждена', why: 'дифф в путях' } } = {}) {
  const tasks = [{ id: 'T-001', path: 'T-001.md', labels, parallel_safe: true }]
  const calls = []
  const prompts = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    prompts.push({ label, prompt: String(prompt) })
    if (label === 'пауза?') return { state: 'running' }
    // Основание сверки (BR-165): движок снимает красные на ветке-цели один раз на прогон.
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha0000', head: 'ma1nsha0000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: ['T-001'], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('полоса:')) return lane
    if (label.startsWith('short-lane:')) return { status: 'ok' }
    if (label.startsWith('test:')) {
      return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 }, mutation_check: { done: true, evidence: 'м' } }
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
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '', tasks, short_lane,
  }))
  return { out, calls, prompts, text: logs.join('\n') }
}

test('метка безопасности — ревью идёт панелью из трёх, а не одним ревьюером', async () => {
  const r = await run({ labels: [SECURITY_LABEL] })
  assert.equal(r.calls.filter((l) => l.startsWith('qa-panel:')).length, 3)
  assert.equal(r.calls.some((l) => /^qa:/.test(l)), false)
  assert.equal(r.out.tasks[0].panel, true)
})

test('без метки — ревью одиночное (панель стоит денег и даётся за признак)', async () => {
  const r = await run({ labels: [] })
  assert.equal(r.calls.filter((l) => l.startsWith('qa-panel:')).length, 0)
  assert.equal(r.calls.some((l) => /^qa:/.test(l)), true)
  assert.equal(r.out.tasks[0].panel, false)
})

test('промпт ревью требует ОТДЕЛЬНЫЙ абзац по безопасности, и без него «принято» неполно', async () => {
  const r = await run({ labels: [SECURITY_LABEL] })
  const qa = r.prompts.filter((p) => p.label.startsWith('qa-panel:'))
  assert.equal(qa.length, 3)
  for (const p of qa) {
    assert.match(p.prompt, /ЧУВСТВИТЕЛЬНЫЙ К БЕЗОПАСНОСТИ/)
    assert.match(p.prompt, /standards\/common\.md/)
    assert.match(p.prompt, /неполон/)
  }
})

test('без метки требования по безопасности в промпте нет — иначе оно обесценится шумом', async () => {
  const r = await run({ labels: [] })
  const qa = r.prompts.filter((p) => p.label.startsWith('qa:'))
  assert.equal(qa.length, 1)
  assert.equal(/ЧУВСТВИТЕЛЬНЫЙ К БЕЗОПАСНОСТИ/.test(qa[0].prompt), false)
})

test('две метки вместе — короткая полоса ОТМЕНЕНА: триггер безопасности сильнее размера правки', async () => {
  const r = await run({ labels: [SHORT_LANE_LABEL, SECURITY_LABEL], short_lane: ['web/src/texts/**'] })
  // Зонд полосы даже не запускается: решение принято по меткам, до диффа.
  assert.equal(r.calls.some((l) => l.startsWith('полоса:')), false)
  assert.equal(r.calls.some((l) => l.startsWith('short-lane:')), false)
  assert.equal(r.calls.some((l) => l.startsWith('test:')), true)
  assert.equal(r.calls.filter((l) => l.startsWith('qa-panel:')).length, 3)
  assert.match(r.text, /полоса отменена/i)
})

test('одна короткая полоса без метки безопасности работает как прежде', async () => {
  const r = await run({ labels: [SHORT_LANE_LABEL], short_lane: ['web/src/texts/**'] })
  assert.equal(r.calls.some((l) => l.startsWith('short-lane:')), true)
  assert.equal(r.calls.some((l) => l.startsWith('test:')), false)
})
