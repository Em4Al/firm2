// Порог «стадия идёт слишком долго» считается по журналу самого проекта, а не одним
// числом на все стадии (см. врезку в lib/firm.mjs перед stageDurations/stageThresholds).
// Покрывает три вещи: stageDurations/stageThresholds (чистые функции), фильтр doctor по
// порогу СВОЕЙ стадии, и tokenUse.ctx_peak как максимум, а не сумму.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stageDurations, stageThresholds, tokenUse, writeEvent, LONG_STAGE_DEFAULTS, LONG_STAGE_FALLBACK,
} from '../scripts/lib/firm.mjs'
import { makeProject, isoAgo } from './helpers.mjs'

// ── Оснастка для чистых функций: события как объекты в памяти, без диска ────────

const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMin) => new Date(BASE + offsetMin * 60000).toISOString()
let seq = 0
const nextAgent = () => `agent-${seq++}`

// Список готовых пар started/finished одной стадии с разными agent_id — то, из чего
// stageDurations достаёт массив длительностей.
function pairs(stage, durations) {
  const out = []
  for (const d of durations) {
    const id = nextAgent()
    out.push({ ts: iso(0), stage, event: 'started', agent_id: id })
    out.push({ ts: iso(d), stage, event: 'finished', agent_id: id })
  }
  return out
}

// ── stageDurations ───────────────────────────────────────────────────────────

test('stageDurations: длительность — от started до ПОСЛЕДНЕГО не-started события ' +
  'с тем же agent_id, и агенты не путаются между собой', () => {
  const a1 = 'a1'
  const a2 = 'a2'
  // Порядок в массиве нарочно вперемешку: группировка идёт по agent_id, а не по позиции.
  const events = [
    { ts: iso(0), stage: 'dev', event: 'started', agent_id: a1 },
    { ts: iso(2), stage: 'dev', event: 'started', agent_id: a2 },
    { ts: iso(5), stage: 'dev', event: 'rejected', agent_id: a1 }, // промежуточное, не последнее
    { ts: iso(9), stage: 'dev', event: 'finished', agent_id: a2 },
    { ts: iso(12), stage: 'dev', event: 'finished', agent_id: a1 }, // последнее для a1
  ]
  const byStage = stageDurations(events)
  const dev = byStage.get('dev').slice().sort((a, b) => a - b)
  assert.deepEqual(dev, [7, 12], 'a2: 9-2=7, a1: 12-0=12 (не 5-0=5 — rejected не последнее)')
})

test('stageDurations: событие без agent_id игнорируется целиком', () => {
  const events = [
    { ts: iso(0), stage: 'dev', event: 'started' }, // нет agent_id вовсе
    { ts: iso(3), stage: 'dev', event: 'finished' },
    ...pairs('dev', [11]),
  ]
  const dev = stageDurations(events).get('dev')
  assert.deepEqual(dev, [11], 'безымянная пара не должна была попасть в расчёт')
})

test('stageDurations: событие с _broken игнорируется, даже если agent_id есть', () => {
  const id = 'b1'
  const events = [
    { ts: iso(0), stage: 'dev', event: 'started', agent_id: id },
    { ts: iso(10), stage: 'dev', event: 'finished', agent_id: id, _broken: true },
  ]
  const byStage = stageDurations(events)
  assert.equal(byStage.has('dev'), false,
    'единственный финиш был испорчен — у started не осталось пары, стадия не считается')
})

test('stageDurations: отрицательная длительность не учитывается (рассогласованные часы)', () => {
  const id = 'c1'
  const events = [
    { ts: iso(0), stage: 'dev', event: 'started', agent_id: id },
    { ts: iso(-5), stage: 'dev', event: 'finished', agent_id: id },
  ]
  assert.equal(stageDurations(events).has('dev'), false)
})

test('stageDurations: граница 480 минут — 480 не считается, 479 считается', () => {
  const events = [
    ...pairs('dev', [479]),
    { ts: iso(0), stage: 'dev', event: 'started', agent_id: 'd1' },
    { ts: iso(480), stage: 'dev', event: 'finished', agent_id: 'd1' },
  ]
  const dev = stageDurations(events).get('dev')
  assert.deepEqual(dev, [479], '480 минут — уже не длительность стадии, а след аварии')
})

// ── stageThresholds ───────────────────────────────────────────────────────────

test('stageThresholds: при ≥20 стадиях порог = p95, округлённый вверх до 5 минут', () => {
  const durations = [...Array(19).fill(5), 38] // p95 при n=20 — это максимум (индекс 19)
  const events = pairs('dev', durations)
  const out = stageThresholds(events, {})
  assert.equal(out.dev.min, 40, 'ceil(38/5)*5 = 40')
  assert.match(out.dev.source, /p95 журнала/)
  assert.match(out.dev.source, /20 стадий/)
})

test('stageThresholds: p95 зажимается снизу в 15 минут', () => {
  const durations = Array(20).fill(3)
  const out = stageThresholds(pairs('review', durations), {})
  assert.equal(out.review.min, 15, 'ceil(3/5)*5=5, но пол — 15')
})

test('stageThresholds: p95 зажимается сверху в 120 минут', () => {
  const durations = Array(20).fill(470) // < 480, иначе stageDurations сам бы это выкинул
  const out = stageThresholds(pairs('test', durations), {})
  assert.equal(out.test.min, 120, 'ceil(470/5)*5=470, но потолок — 120')
})

test('stageThresholds: при <20 стадиях — LONG_STAGE_DEFAULTS, источник «замер пилотов»', () => {
  const durations = Array(19).fill(10)
  const out = stageThresholds(pairs('test', durations), {})
  assert.equal(out.test.min, LONG_STAGE_DEFAULTS.test)
  assert.equal(out.test.source, 'замер пилотов')
})

test('stageThresholds: стадия без записи в LONG_STAGE_DEFAULTS берёт LONG_STAGE_FALLBACK, ' +
  'но ключ для неё всё равно есть в результате', () => {
  const durations = Array(3).fill(10)
  const out = stageThresholds(pairs('triage', durations), {})
  assert.ok('triage' in out, 'стадия встретилась в журнале — ключ обязан быть, даже вне LONG_STAGE_DEFAULTS')
  assert.equal(out.triage.min, LONG_STAGE_FALLBACK)
  assert.equal(out.triage.source, 'замер пилотов')
})

test('stageThresholds: monitor.long_stage_min перекрывает ВСЕ стадии и _default, источник «конфиг»', () => {
  // dev — с 20 стадиями (пошёл бы по p95), merge — вовсе без записей в журнале.
  const events = pairs('dev', [...Array(19).fill(5), 38])
  const cfg = { monitor: { long_stage_min: 7 } }
  const out = stageThresholds(events, cfg)
  assert.deepEqual(out.dev, { min: 7, source: 'конфиг' }, 'оверрайд сильнее p95-расчёта')
  assert.deepEqual(out.merge, { min: 7, source: 'конфиг' }, 'и сильнее дефолта для стадии без журнала')
  assert.deepEqual(out._default, { min: 7, source: 'конфиг' })
})

test('stageThresholds: без оверрайда и без журнала — ключи LONG_STAGE_DEFAULTS и ' +
  '_default на зашитом фолбэке', () => {
  const out = stageThresholds([], {})
  assert.equal(out.dev.min, LONG_STAGE_DEFAULTS.dev)
  assert.equal(out.review.min, LONG_STAGE_DEFAULTS.review)
  assert.equal(out.dev.source, 'замер пилотов')
  assert.deepEqual(out._default, { min: LONG_STAGE_FALLBACK, source: 'замер пилотов' })
})

// ── doctor: порог своей стадии, а не общий ────────────────────────────────────
//
// Был один порог 25 минут на все стадии (см. врезку в lib/firm.mjs): он не отличал
// `review` (p95 пилотов — 16-20) от `dev` (p95 — 38-52). Эти два теста и есть разница:
// одна и та же длительность 22 минуты должна попасть в «долго идёт» для одной стадии
// и не попасть для другой.

test('doctor: review 22 минуты — долго (её порог по умолчанию 20), ' +
  'dev те же 22 минуты — нет (её порог 45)', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  // writeEvent напрямую, как в board.test.mjs: ticket задан явно, привязка не нужна.
  const openStage = (ticket, stage, ts) =>
    writeEvent(p.root, { ts, change: p.change, ticket, stage, event: 'started', actor: 'test', agent_id: null })
  openStage('T-001', 'review', isoAgo(22 / 60))
  openStage('T-002', 'dev', isoAgo(22 / 60))

  const d = p.evJson('doctor')
  assert.equal(d.status, 0, d.stderr)

  const reviewHit = d.json.long_running.find((s) => s.startsWith('T-001 · review'))
  assert.ok(reviewHit, `review обязана попасть в long_running: ${JSON.stringify(d.json.long_running)}`)
  assert.match(reviewHit, /\(порог 20, замер пилотов\)/)

  const devHit = d.json.long_running.find((s) => s.startsWith('T-002 · dev'))
  assert.equal(devHit, undefined,
    `dev с тем же возрастом не обязана светиться при пороге 45: ${JSON.stringify(d.json.long_running)}`)

  assert.equal(d.json.ok, true, 'долгая стадия — метрика, а не поломка (не влияет на ok)')
})

// ── tokenUse: ctx_peak — максимум, а не сумма ─────────────────────────────────

test('tokenUse: ctx_peak берётся максимумом по событиям, остальные поля — суммой', () => {
  const events = [
    { tokens: { in: 1, out: 1, cache_read: 1, cache_write: 0, thinking: 0, total: 10, calls: 1, ctx_peak: 50 } },
    { tokens: { in: 2, out: 2, cache_read: 0, cache_write: 1, thinking: 1, total: 20, calls: 1, ctx_peak: 80 } },
    { tokens: { in: 3, out: 3, cache_read: 0, cache_write: 0, thinking: 0, total: 5, calls: 1, ctx_peak: 30 } },
  ]
  const out = tokenUse(events)
  assert.equal(out.ctx_peak, 80, 'максимум трёх пиков, а не их сумма (160)')
  assert.equal(out.in, 6)
  assert.equal(out.out, 6)
  assert.equal(out.total, 35)
  assert.equal(out.calls, 3)
})

test('tokenUse: события без tokens и с _broken в сумму и в максимум не идут', () => {
  const events = [
    { tokens: { total: 10, ctx_peak: 999 }, _broken: true }, // испорченное — целиком вне расчёта
    { stage: 'dev' }, // нет tokens вовсе
    { tokens: { total: 7, ctx_peak: 40 } },
  ]
  const out = tokenUse(events)
  assert.equal(out.ctx_peak, 40, 'пик испорченного события (999) не должен был попасть в максимум')
  assert.equal(out.total, 7)
})
