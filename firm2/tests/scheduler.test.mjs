// Планировщик против живой поставки. Разбор проект-В 12–13.10.2026, три дефекта одного корня:
// прогон живёт списком задач из `args`, снятым на СТАРТЕ, а истина о поставке — журнал
// (ADR-0001). Прогон идёт часами, и всё, что меняется по ходу, для него не существовало.
//
//   Д-8.2  человек добавил к идущей сборке T-106 и поставил её в depends_on у T-101.
//          Ветка «зависимости нет в поставке вовсе» считала зависимость ВЫПОЛНЕННОЙ —
//          T-101 пошла бы работать на механизме, которого ещё нет.
//   Д-8.3  слияние упало, события merge/failed никто не записал: промпт просит роль,
//          а роль не исполнила. doctor отвечал ok при незакрытом слиянии два часа.
//   Д-8.4  задача с merged: false навсегда вне `done`; зависимые не стартовали молча,
//          даже после того как человек довёл слияние руками.
//
// Тесты гоняют НАСТОЯЩЕЕ тело сборщика с заглушкой вместо agent(): проверяется решение
// планировщика, а не текст промптов.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

const T = (id, extra = {}) => ({ id, path: `${id}.md`, labels: [], parallel_safe: true, ...extra })

// settled — что зонд отвечает на каждом опросе: массив ответов по порядку, последний
// повторяется. merge — { <id>: 'ok' | 'fail' }.
async function run({ tasks, settled = [{ state: 'ok', exists: tasks.map((t) => t.id), merged: [] }], merge = {}, extraArgs = {} } = {}) {
  const calls = []
  const logs = []
  let probe = 0
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label === 'пауза?') return { state: 'running' }
    // Основание сверки (BR-165): движок снимает красные на ветке-цели один раз на прогон.
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha0000', head: 'ma1nsha0000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return settled[Math.min(probe++, settled.length - 1)]
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 }, mutation_check: { done: true, evidence: 'м' } }
    }
    if (label.startsWith('qa')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('merge:')) {
      const id = label.slice('merge:'.length)
      return merge[id] === 'fail' ? { status: 'fail', notes: 'конфликт в двух файлах' } : { status: 'ok' }
    }
    if (label.startsWith('merge-failed:') || label.startsWith('journal:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (ths) => Promise.all(ths.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '', tasks,
    ...extraArgs,
  }))
  return { out, calls, logs, labels: calls.map((c) => c.label), text: logs.join('\n') }
}

test('Д-8.2: зависимость, заведённая после старта, НЕ считается выполненной', async () => {
  const r = await run({
    tasks: [T('T-101', { depends_on: ['T-106'] })],
    // В поставке T-106 уже есть — её завели, пока прогон шёл. В `tasks` прогона её нет.
    settled: [{ state: 'ok', exists: ['T-101', 'T-106'], merged: [] }],
  })
  assert.ok(!r.labels.some((l) => l.startsWith('dev:')), 'T-101 не должна начаться: механизма ещё нет')
  assert.match(r.text, /T-106/)
  assert.match(r.text, /ПОСЛЕ старта|появились задачи вне плана/)
  assert.match(r.text, /перезапусти|перезапуск/, 'человеку сказано, чем это лечится')
})

test('опечатка в depends_on по-прежнему считается выполненной — иначе встанет любая поставка', async () => {
  const r = await run({
    tasks: [T('T-101', { depends_on: ['T-999'] })],
    settled: [{ state: 'ok', exists: ['T-101'], merged: [] }],
  })
  assert.ok(r.labels.some((l) => l.startsWith('dev:')), 'T-999 в поставке нет вовсе — это опечатка, а не объём')
  assert.match(r.text, /T-999/)
})

test('Д-8.4: задачу, влитую по ходу, прогон видит и пускает зависимых', async () => {
  const r = await run({
    tasks: [T('T-104', { depends_on: ['T-102'] })],
    // T-102 этим прогоном не бралась (её слияние человек довёл руками), зато она влита.
    settled: [{ state: 'ok', exists: ['T-102', 'T-104'], merged: ['T-102'] }],
  })
  assert.ok(r.labels.some((l) => l === 'dev:T-104#1'), 'зависимость влита — задача обязана стартовать')
  assert.match(r.text, /T-102 влита/)
})

test('Д-8.3: провал слияния пишется событием, а не только строкой в логе', async () => {
  const r = await run({ tasks: [T('T-102')], merge: { 'T-102': 'fail' } })
  const rec = r.calls.find((c) => c.label === 'merge-failed:T-102')
  assert.ok(rec, 'без события doctor отвечает ok при незакрытом слиянии')
  assert.match(rec.prompt, /--stage merge --event failed/)
  assert.match(rec.prompt, /конфликт в двух файлах/, 'причина обязана попасть в журнал')
  assert.match(r.text, /слияние НЕ прошло/)
})

test('зонд молчит — прогон работает по старому знанию и говорит об этом', async () => {
  const r = await run({
    tasks: [T('T-101', { depends_on: ['T-106'] })],
    settled: [{ state: 'unknown', output: 'команда не запустилась' }],
  })
  // Направление отказа тут обратное паузе: остановка стоила бы всего прогона на каждом
  // сбое зонда, а неизвестность не делает прежнее поведение хуже.
  assert.ok(r.labels.some((l) => l.startsWith('dev:')), 'прежнее поведение сохраняется')
  assert.match(r.text, /спросить не удалось|не видна/)
})

test('тупик называет, кто кого ждёт и почему', async () => {
  const r = await run({
    tasks: [T('T-104', { depends_on: ['T-102'] }), T('T-102')],
    merge: { 'T-102': 'fail' },
    settled: [{ state: 'ok', exists: ['T-102', 'T-104'], merged: [] }],
  })
  assert.match(r.text, /T-104 ждёт: T-102/)
  assert.match(r.text, /не принята или её слияние не прошло/)
})

// ── Полоса одновременности в САМОМ сборщике ─────────────────────────────────
//
// `firm-state.mjs next` — вид человеку; пускает задачи этот скрипт, и потолок полосы
// обязан держать он. Предложение проект-В 10.11.2026 (разбор T-374): без третьего состояния
// единственный рычаг проекта — `parallel_safe: false`, то есть «не одновременно НИ С КЕМ»
// вместо «не одновременно с другой браузерной».

const BROWSER = (id) => T(id, { labels: ['требует-браузера'] })

test('полоса с потолком 1: три браузерные задачи идут по одной, и все три проходят', async () => {
  const r = await run({
    tasks: [BROWSER('T-001'), BROWSER('T-002'), BROWSER('T-003')],
    extraArgs: { lanes: { 'требует-браузера': 1 }, parallelism: 3 },
  })
  assert.equal(r.out.tasks.filter((x) => x.accepted).length, 3, JSON.stringify(r.out.tasks))
  assert.match(r.text, /ждёт полосу «требует-браузера»/)
  assert.match(r.text, /потолок 1/)
})

test('БЕЗ ключа lanes сборщик ведёт себя как раньше и про полосу молчит', async () => {
  const r = await run({
    tasks: [BROWSER('T-001'), BROWSER('T-002'), BROWSER('T-003')],
    extraArgs: { parallelism: 3 },
  })
  assert.equal(r.out.tasks.filter((x) => x.accepted).length, 3)
  assert.ok(!/ждёт полосу/.test(r.text), 'ключа нет — ни одной новой строки в логе')
})

test('полоса держит только свою метку: задача без метки идёт рядом', async () => {
  const r = await run({
    tasks: [BROWSER('T-001'), BROWSER('T-002'), T('T-003')],
    extraArgs: { lanes: { 'требует-браузера': 1 }, parallelism: 3 },
  })
  assert.equal(r.out.tasks.filter((x) => x.accepted).length, 3)
  // T-003 про полосу не слышала — её имя в строке ожидания стоять не должно.
  assert.ok(!/T-003 ждёт полосу/.test(r.text), r.text)
})

test('про ожидание полосы говорится ОДИН раз на задачу, а не на каждом круге', async () => {
  const r = await run({
    tasks: [BROWSER('T-001'), BROWSER('T-002'), BROWSER('T-003')],
    extraArgs: { lanes: { 'требует-браузера': 1 }, parallelism: 3 },
  })
  const said = r.logs.filter((l) => /T-002 ждёт полосу/.test(l))
  assert.equal(said.length, 1, said.join('\n'))
})

// ── Инвентарь в промптах ────────────────────────────────────────────────────
//
// Поле `inventory` без промпта было бы бухгалтерией: три захода T-374 добирали множество
// грепом именно потому, что прочитать его было негде.

test('закрытый инвентарь уезжает в промпты разработки, теста и ревью', async () => {
  const r = await run({
    tasks: [T('T-001', { inventory: ['web/test/t141.mjs', 'web/test/t171.mjs'] })],
  })
  for (const stage of ['dev:', 'test:', 'qa']) {
    const call = r.calls.find((c) => c.label.startsWith(stage))
    assert.ok(call, `вызов стадии ${stage} есть`)
    assert.match(call.prompt, /ИНВЕНТАРЬ ЗАДАЧИ — 2 позиции/, stage)
    assert.match(call.prompt, /web\/test\/t171\.mjs/, stage)
    assert.match(call.prompt, /ДОБИРАТЬ ЕГО ГРЕПОМ ТЫ НЕ ВПРАВЕ/, stage)
  }
})

test('инвентаря нет — ни одной строки про него в промпте', async () => {
  const r = await run({ tasks: [T('T-001')] })
  const dev = r.calls.find((c) => c.label.startsWith('dev:'))
  assert.ok(!/ИНВЕНТАРЬ/.test(dev.prompt), 'напоминание о пустом перечне учило бы искать его грепом')
})
