// Д-65…Д-67: отнесение красных, опоздавший отчёт о слиянии, принятые и невлитые.
//
// Отчёт проект-В 09.11.2026, второй прогон поставки G-020 (274 агента, 4 ч 43 мин, влито 30).
//
//   Д-65 (главная): `delivery_red_check` не отнёс НИ ОДНОГО из восьми красных поставки —
//     по всем восьми `state: "unknown", why: "точка ветвления не снята"`, при успешно снятом
//     основании ветки-цели. Поле существует ровно ради этого ответа; Оркестратор сделал ту же
//     работу руками за две минуты. Хуже, чем ноль пользы: восемь записей «неизвестно» в поле
//     с именем `..._check` читаются как ПРОВЕРЕННЫЙ список;
//   Д-66: к слиянию, упавшему по ВНЕШНЕЙ причине (несведённый индекс от чужого мержа),
//     прогон не возвращался — задача висела в accepted час с четвертью и была влита руками;
//   Д-67: отчёт шага о падении слияния дописывался ПОСЛЕ того, как мерж довёл человек, и
//     становился последним словом журнала — «не влито» при влитой задаче. Трижды за вечер.
import test from 'node:test'
import assert from 'node:assert/strict'
import { statusFromEvents } from '../scripts/lib/firm.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const rec = (id, over = {}) => ({
  id, path: `tasks/${id}.md`, labels: [], parallel_safe: true, depends_on: [], status: 'ready', attempt: 0, ...over,
})

// Прогон с управляемыми ответами: что вернёт основание ветки-цели, что — точка ветвления,
// какие красные назовёт стадия теста, прошло ли слияние.
async function run({ trunkRed = [], baseState = 'ok', baseRed = [], deliveryRed = [], mergeStatus = 'ok' } = {}) {
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [], merged: [], workable: [] }
    if (label.startsWith('основание: красные на')) {
      return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'suite', red: trunkRed, failed: trunkRed.length, total: 100 }
    }
    if (label.startsWith('основание: точка ветвления')) {
      if (baseState !== 'ok') return { state: 'unknown', output: 'дерево _base не завелось: Operation not permitted' }
      return { state: 'ok', sha: 'ba5esha00000', head: 'ba5esha00000', cmd: 'suite', red: baseRed, failed: baseRed.length, total: 100 }
    }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt/T-001', branch: 'task/T-001' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 }, delivery_red: deliveryRed }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:') || label.startsWith('merge-failed:')) return { status: 'ok' }
    if (label.startsWith('дифф:')) return { status: 'ok', files: [], added: 0, deleted: 0 }
    if (label.startsWith('merge:') || label.startsWith('merge-retry:')) {
      return mergeStatus === 'ok' ? { status: 'ok' } : { status: 'fail', notes: 'индекс главного дерева не сведён' }
    }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof', registry_left: false }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/wt', tasks: [rec('T-001')], test_cmd: 'npm test', task_test_cmd: 'npm test',
    // Время прогон получает ТОЛЬКО так: собственное ему запрещено раннером (Д-72).
    now: '2026-11-10T09:30:00Z',
  }))
  return { out, log: logs.join('\n') }
}

test('Д-65: предсуществующее красное опознаётся одним снимком, без точки ветвления', async () => {
  // Ровно расстановка проект-В: основание ветки-цели снято, точка ветвления нет. Прежде оба
  // снимка требовались ВМЕСТЕ, и ответ был «неизвестно» даже там, где он известен.
  const r = await run({ baseState: 'unknown', trunkRed: ['t141::test_panel'], deliveryRed: ['t141::test_panel'] })
  const check = r.out.delivery_red_check
  assert.equal(check.length, 1)
  assert.equal(check[0].state, 'pre-existing')
  assert.equal(check[0].trunk, 'ma1nsha00000')
})

test('Д-65: не снятое отнесение называется ОДНОЙ причиной, а не N записями «неизвестно»', async () => {
  const r = await run({ baseState: 'unknown', deliveryRed: ['a::x', 'b::y', 'c::z'] })
  assert.deepEqual(r.out.delivery_red_check.map((c) => c.state), ['unknown', 'unknown', 'unknown'])
  const un = r.out.delivery_red_unchecked
  assert.deepEqual(un.names, ['a::x', 'b::y', 'c::z'])
  assert.match(un.why, /точка ветвления/, 'причина названа')
  assert.match(un.why, /Operation not permitted/, 'и это настоящая причина зонда, а не слово «неизвестно»')
  assert.match(un.how, /merge-base/, 'рядом рецепт, которым это снимается руками за минуты')
  assert.match(r.log, /ОТНЕСЕНИЕ НЕ СНЯТО по 3 из 3/)
  assert.match(r.log, /НЕ «не подтверждено»/, 'разница названа: не проверено — не то же, что не подтверждено')
})

test('Д-65: взятый sha виден в итоге, и у каждой записи есть время отнесения', async () => {
  const r = await run({ baseRed: ['own::red'], deliveryRed: ['own::red'] })
  assert.deepEqual(r.out.base_snapshots, [{ sha: 'ba5esha00000', red: 1, total: 100 }])
  assert.equal(r.out.delivery_red_check[0].state, 'confirmed')
  assert.equal(r.out.delivery_red_check[0].ts, '2026-11-10T09:30:00Z',
    'момент отнесения назван временем из args — своё прогону запрещено (Д-72)')
  assert.match(r.log, /поле ts называет момент аргументов прогона/)
})

test('Д-66: принята и не влита — своим списком в итоге и второй попыткой слияния', async () => {
  const r = await run({ mergeStatus: 'fail' })
  assert.deepEqual(r.out.accepted_not_merged.map((x) => x.id), ['T-001'])
  assert.equal(r.out.accepted_not_merged[0].merge_retry, 'fail', 'вторая попытка сделана и названа')
  assert.match(r.log, /ПРИНЯТЫ, НО НЕ ВЛИТЫ/)
  assert.match(r.log, /НЕ «не сделаны»/, 'сказано, чем это отличается от незапущенной задачи')
})

test('Д-66: внешняя причина снята — вторая попытка проходит, и это сказано', async () => {
  // Первое слияние падает, второе проходит: ровно случай T-400, где мешал чужой несведённый
  // индекс, а не содержимое задачи.
  let n = 0
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [], merged: [], workable: [] }
    if (label.startsWith('основание:')) return { state: 'unknown', output: 'не мерили' }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt/T-001', branch: 'task/T-001' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:') || label.startsWith('merge-failed:')) return { status: 'ok' }
    if (label.startsWith('дифф:')) return { status: 'ok', files: [], added: 0, deleted: 0 }
    // Повтор идёт тем же вызовом слияния (label `merge:`), только позже: первый падает по
    // чужой причине, второй проходит — ровно случай T-400.
    if (label.startsWith('merge:')) { n += 1; return n === 1 ? { status: 'fail', notes: 'чужой несведённый индекс' } : { status: 'ok' } }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof' }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/wt', tasks: [rec('T-001')], test_cmd: 'npm test',
  }))
  assert.equal(n, 2, 'слияние звалось дважды: своя попытка и повтор в конце прогона')
  assert.deepEqual(out.accepted_not_merged, [], 'после удачной второй задача не числится невлитой')
  assert.match(logs.join('\n'), /слияние прошло со второй попытки/)
})

// ── Д-67: опоздавший отчёт о падении попытки ────────────────────────────────

const ev = (stage, event, ts, over = {}) => ({ ticket: 'T-001', stage, event, ts, ...over })

test('Д-67: отчёт о падении, записанный ПОСЛЕ слияния, влитое не отменяет', () => {
  const evs = [
    ev('dev', 'started', '2026-11-09T18:00:00Z'),
    ev('review', 'accepted', '2026-11-09T18:40:00Z'),
    ev('merge', 'finished', '2026-11-09T18:47:10Z'),
    ev('merge', 'failed', '2026-11-09T18:47:38Z'), // перо шага опоздало на 28 секунд
  ]
  assert.equal(statusFromEvents(evs).status, 'merged', 'влито доказано вторым родителем (ADR-0005), а не последним словом')
})

test('Д-67: падение ДО слияния по-прежнему возвращает задачу в «принята, не влита»', () => {
  const evs = [
    ev('dev', 'started', '2026-11-09T18:00:00Z'),
    ev('review', 'accepted', '2026-11-09T18:40:00Z'),
    ev('merge', 'failed', '2026-11-09T18:42:00Z'),
  ]
  assert.equal(statusFromEvents(evs).status, 'accepted')
})

test('Д-67: запись такого отчёта помечается в момент записи и говорит вслух', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'human')
  const r = p.cli('firm-event.mjs', ['record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'failed',
    '--actor', 'merge-stage', '--notes', 'конфликт в файле задачи', '--root', p.root])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /слияние УЖЕ состоялось/)
  assert.match(r.stderr, /stale_attempt/)
  const dir = join(p.root, '.firm', 'events')
  const failed = readdirSync(dir)
    .filter((f) => f.includes('merge-failed'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))[0]
  assert.equal(failed.stale_attempt, true, 'признак в самом событии: журнал неизменяем, а читателям нужен ответ')
  assert.match(failed.notes, /ПОПЫТКА УСТАРЕЛА/)
})

test('Д-67: doctor не считает находкой отчёт, опоздавший за слияние', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'human')
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'failed', '--actor', 'merge-stage', '--notes', 'конфликт')
  const d = JSON.parse(p.cli('firm-event.mjs', ['doctor', '--json', '--root', p.root]).stdout)
  assert.deepEqual(d.failed_merges, [], 'исправляющего события для этого больше не нужно — его писали трижды за вечер')
  const closed = d.failed_merges_closed.find((x) => x.ticket === 'T-001')
  assert.equal(closed.closed_by, 'слияние состоялось')
  assert.match(closed.why, /ADR-0005/)
})
