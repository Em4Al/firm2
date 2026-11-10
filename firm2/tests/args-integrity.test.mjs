// Целостность переданного `args`: сборщик проверяет, что вход приехал ЦЕЛИКОМ.
//
// Повод — Д-23 проект-В 29.10.2026. Вывод `build-args` на живой поставке 47 КБ, а отдать его
// сборщику можно только вставкой в вызов Workflow: путь к файлу инструмент не принимает.
// Маршрут при этом велит «руками ничего не составляй» — правило без исполнимого пути. И
// его обошли: Оркестратор обрезал `last_verdict.notes` у трёх задач и обнулил у одной
// список из двадцати критериев. Прогон запустился и выглядел нормальным. Между тем
// `last_verdict.notes` уходит в промпт стадии ДОСЛОВНО — Разработчик получил бы пересказ
// вердикта вместо вердикта на задаче, которую за эти критерии и эскалировали.
//
// Проверяется счётчиками, а не хешем, намеренно: хеш пришлось бы считать дважды — в
// скрипте и в сборщике, — и две реализации одного хеша разъезжаются молча, давая ложный
// отказ посреди волны. Счётчики так разъехаться не могут.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject, loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

// ── Что печатает движок ──────────────────────────────────────────────────────
test('build-args несёт отпечаток своего вывода — счёт задач, критериев и символов', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  const a = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json']).stdout)
  assert.ok(a.integrity, 'без отпечатка сверять нечего')
  assert.equal(a.integrity.tasks, a.tasks.length, 'счёт задач — от того же списка, который уехал')
  assert.equal(typeof a.integrity.verdict_criteria, 'number')
  assert.equal(typeof a.integrity.verdict_chars, 'number')
})

test('отпечаток считается по тем полям, которые режут при сокращении', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Вердикт с пояснением: ровно то, что обрезали на проект-В. Отклонение, а не эскалация:
  // эскалированная задача ждёт человека (`blocked`) и в прогон не отдаётся вовсе.
  p.cli('firm-event.mjs', [
    'record', '--root', p.root, '--ticket', 'T-001', '--stage', 'review',
    '--event', 'rejected', '--actor', 'reviewer-qa', '--notes', 'двадцать критериев не закрыты',
  ])
  const a = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json']).stdout)
  const v = a.tasks[0].last_verdict
  assert.ok(v && v.notes, 'вердикт доехал до задачи')
  assert.equal(a.integrity.verdict_chars, v.notes.length, 'символы пояснения посчитаны, а не прикинуты')
})

test('--out кладёт вывод файлом, а в терминал отдаёт сводку и правило передачи', (t) => {
  // Вставлять 47 КБ из прокрутки терминала — тот самый путь, на котором случилась обрезка.
  const p = makeProject(t, { tasks: ['T-001'] })
  const dest = join(p.root, 'args.json')
  const r = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--out', dest, '--json']).stdout)
  assert.equal(r.wrote, dest)
  assert.ok(r.bytes > 0)
  assert.ok(r.integrity, 'сводка называет отпечаток: человеку видно, что сверять')
  assert.match(r.note, /ничего не сокращая/)
  const onDisk = JSON.parse(readFileSync(dest, 'utf8'))
  assert.equal(onDisk.change, p.change, 'в файле лежит полный args, а не сводка')
  assert.deepEqual(onDisk.integrity, r.integrity)
})

// ── Что делает сборщик ───────────────────────────────────────────────────────
const TASK = { id: 'T-001', path: 't.md', labels: [], parallel_safe: true }

async function run(extra) {
  const calls = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'x', red: [], failed: 0, total: 10 }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [TASK.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return {
        status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 },
        runs: {
          base: { sha: 'abc1234567890def', cmd: 'c', red: [], failed: 0, total: 10 },
          head: { sha: 'fed0987654321cba', cmd: 'c', red: [], failed: 0, total: 10 },
        },
      }
    }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  let error = null
  try {
    await fn(stub, parallel, () => {}, () => {}, JSON.stringify({
      change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
      worktrees_dir: '', tasks: [TASK], ...extra,
    }))
  } catch (e) { error = e }
  return { error, calls }
}

const WHOLE = { tasks: 1, verdict_criteria: 0, verdict_chars: 0 }

test('отпечаток сошёлся — прогон идёт как обычно', async () => {
  const r = await run({ integrity: WHOLE })
  assert.equal(r.error, null)
  assert.ok(r.calls.length > 0)
})

test('задачу потеряли по дороге — прогон встаёт и называет расхождение числами', async () => {
  const r = await run({ integrity: { ...WHOLE, tasks: 2 } })
  assert.ok(r.error, 'молча ехать на неполном входе нельзя')
  assert.match(r.error.message, /tasks — движок насчитал 2, в args 1/)
})

test('обрезали пояснение вердикта — видно именно это, а не «что-то не так»', async () => {
  // Та самая правка с проект-В: задача на месте, пересказ короче вердикта.
  const task = { ...TASK, last_verdict: { notes: 'коротко', criteria: ['a', 'b'] } }
  const r = await run({ tasks: [task], integrity: { tasks: 1, verdict_criteria: 2, verdict_chars: 420 } })
  assert.match(r.error.message, /verdict_chars — движок насчитал 420, в args 7/)
  assert.doesNotMatch(r.error.message, /verdict_criteria/, 'целые поля в упрёк не ставятся')
})

test('обнулили список критериев — считается и это', async () => {
  const task = { ...TASK, last_verdict: { notes: 'ок', criteria: [] } }
  const r = await run({ tasks: [task], integrity: { tasks: 1, verdict_criteria: 20, verdict_chars: 2 } })
  assert.match(r.error.message, /verdict_criteria — движок насчитал 20, в args 0/)
})

test('останов случается ДО первой стадии: ни одного вызова роли', async () => {
  // Цена повторной вставки должна быть нулевой, иначе сверку начнут обходить.
  const r = await run({ integrity: { ...WHOLE, tasks: 5 } })
  assert.deepEqual(r.calls, [], 'ни одна стадия не открыта, значит и событий нет')
  assert.match(r.error.message, /ДО первой стадии/)
  assert.match(r.error.message, /build-args --out/, 'сказано, как передать иначе, а не только что виноват')
})

test('отпечатка в args нет — сборщик не падает (старый вывод тоже должен ехать)', async () => {
  const r = await run({})
  assert.equal(r.error, null, 'проверка не может ломать прогон на выводе прежней версии движка')
})

// ── Файл аргументов — единственный след входа волны (замер проект-В 02.11.2026) ─
//
// Рецепт в `firm-build.md` называл фиксированное имя (`$TMPDIR/args.json`), и каждая
// следующая волна стирала вход предыдущей. Разбор на проект-В сверил стадию одной волны с
// `args` ДРУГОЙ, на шесть часов старше, и предъявил дефект «стадия несёт тикет, которого
// не было на входе» — то есть разбор пошёл в сторону несущего механизма маршрута
// (маркер кладёт код, взяться он может только из `args`). Находка снялась сверкой
// происхождения файлов, но стоила хода обеим сторонам.
test('build-args --out не затирает файл прежней волны, а кладёт рядом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const dest = join(p.root, 'args.json')

  const first = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--out', dest, '--json']).stdout)
  assert.equal(first.wrote, dest, 'первый раз — ровно туда, куда попросили')
  assert.equal(first.kept, null)
  writeFileSync(dest, JSON.stringify({ метка: 'вход прежней волны' }))

  const second = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--out', dest, '--json']).stdout)
  assert.notEqual(second.wrote, dest, 'второй раз — рядом, а не поверх')
  assert.equal(second.kept, dest, 'сказано, какой файл оставлен на месте')
  assert.match(second.wrote, /args-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/, 'имя несёт время, то есть различает волны')
  assert.match(second.note, /единственный его след/, 'сказано, почему не поверх')

  assert.deepEqual(JSON.parse(readFileSync(dest, 'utf8')), { метка: 'вход прежней волны' }, 'прежний вход цел')
  assert.ok(JSON.parse(readFileSync(second.wrote, 'utf8')).tasks, 'а новый — настоящие аргументы')
})
