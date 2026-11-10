// Цена стадии: бюджет, правило одного вызова и основание, снятое движком один раз на
// коммит.
//
// Разбор 30.10.2026 (проект-В, волна из 62 стадий). Медиана стадии разработки — 15 минут,
// теста — 17; максимумы — 136 и 155. Весь хвост оказался не работой: 7.3 часа из 15.1
// часа стадий ушли в циклы ожидания собственных прогонов, запущенных фоном, потому что
// вызов команды обрывается примерно на десяти минутах. А запускались они ради ВТОРОЙ
// ПОЛОВИНЫ сравнения — красных на точке ветвления, — которую промпт Тестировщика велел
// снять самому, хотя абзацем ниже было написано, что движок основание выдаёт.
//
// Тесты держат четыре вещи, и каждая — против возврата своего дефекта:
//   1. точка ветвления меряется ОДИН раз на коммит: вторая задача той же волны прогона не
//      повторяет (иначе возвращается двойная плата за один факт);
//   2. стадиям сказано своё дерево на точке ветвления не заводить;
//   3. бюджет назван в промпте вместе со штатным выходом — остановиться, а не успеть
//      любой ценой;
//   4. мутация проверяется адресным прогоном, а не набором.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const mkTask = (id) => ({ id, path: `${id}.md`, labels: [], parallel_safe: true })

// Прогон с настоящим телом сборщика: подменяется только то, что за agent().
async function run({ tasks = [mkTask('T-001')], base = null, extra = {} } = {}) {
  const calls = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label.startsWith('основание: точка ветвления')) {
      // Зонд отвечает так, как ему велено промптом: уже измеренный коммит — «same».
      const asked = [...prompt.matchAll(/([0-9a-f]{12})/g)].map((m) => m[1])
      if (base && asked.includes(base.sha.slice(0, 12))) return { state: 'same', sha: base.sha }
      return base ? { ...base, state: 'ok' } : { state: 'unknown', output: 'дерево не завелось' }
    }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'suite', red: [], failed: 0, total: 9 }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: tasks.map((t) => t.id), merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt', branch: 'task/x' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
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
  await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/wt-dir', task_test_cmd: 'suite -q', test_cmd: 'suite -q',
    stage_budget: { dev: 30, test: 30 }, tasks, ...extra,
  }))
  const pick = (pre) => calls.filter((c) => c.label.startsWith(pre))
  return { calls, logs: logs.join('\n'), dev: pick('dev:'), test: pick('test:'), basePrompts: pick('основание: точка ветвления') }
}

const BASE = { sha: 'c24952fabcde0000', head: 'c24952fabcde0000', cmd: 'suite -q', red: ['tests/test_old.py::t1'], failed: 1, total: 100 }

test('точка ветвления меряется один раз на коммит, а не на каждую задачу', async () => {
  const r = await run({ tasks: [mkTask('T-001'), mkTask('T-002')], base: BASE })
  assert.equal(r.basePrompts.length, 2, 'спрашивают по разу на задачу — merge-base у них может быть разный')
  // Второй зонд получает список уже измеренных sha и отвечает «same» — то есть прогона
  // не было. Это и есть вся экономия: на проект-В две стадии независимо мерили c24952f.
  assert.match(r.basePrompts[1].prompt, /c24952fabcde/, 'второму зонду названы уже измеренные коммиты')
  assert.match(r.basePrompts[1].prompt, /НИЧЕГО НЕ ГОНЯЙ/, 'и сказано, что делать при совпадении')
  assert.match(r.logs, /уже измерена в этом прогоне — прогон не повторялся/)
})

test('стадии теста выданы ОБЕ половины сравнения, и база прямо запрещена к перегону', async () => {
  const r = await run({ base: BASE })
  const p = r.test[0].prompt
  assert.match(p, /ТОЧКА ВЕТВЛЕНИЯ ТОЖЕ СНЯТА ДВИЖКОМ/)
  assert.match(p, /c24952fabcde/, 'sha назван — его можно сверить одной дешёвой командой')
  assert.match(p, /tests\/test_old\.py::t1/, 'и список красных выдан поимённо')
  assert.match(p, /Своего дерева на точке ветвления НЕ ЗАВОДИ/)
  assert.doesNotMatch(p, /прогони тесты на merge-base/i, 'старое «прогони сам» стоило 155 минут на одной стадии')
})

test('основание не снято — дерево всё равно заводить не велено', async () => {
  const r = await run({ base: null })
  const p = r.test[0].prompt
  assert.match(p, /ТОЧКУ ВЕТВЛЕНИЯ движку снять не удалось/)
  assert.match(p, /НЕ ЗАВОДИ/, 'холодное дерево не укладывается ни в один вызов — запрет остаётся')
  assert.match(p, /основание точки ветвления не снято/, 'названа честная формулировка для notes')
})

test('бюджет стадии назван обеим стадиям вместе со штатным выходом', async () => {
  const r = await run({ base: BASE })
  for (const [what, prompt] of [['разработке', r.dev[0].prompt], ['тесту', r.test[0].prompt]]) {
    assert.match(prompt, /БЮДЖЕТ СТАДИИ — 30 МИНУТ/, `бюджет не назван ${what}`)
    assert.match(prompt, /status: "fail"/, 'штатный выход назван: остановиться, а не успеть любой ценой')
    assert.match(prompt, /ЧТО СЪЕЛО ВРЕМЯ/, 'причина перерасхода — то, ради чего бюджет и нужен')
  }
})

test('бюджет снят проектом — лишнего абзаца в промпте нет', async () => {
  const r = await run({ base: BASE, extra: { stage_budget: {} } })
  assert.doesNotMatch(r.dev[0].prompt, /БЮДЖЕТ СТАДИИ/)
  assert.doesNotMatch(r.test[0].prompt, /БЮДЖЕТ СТАДИИ/)
  assert.match(r.test[0].prompt, /НЕ УКЛАДЫВАЕТСЯ В ОДИН ВЫЗОВ/,
    'правило одного вызова от бюджета не зависит: оно про устройство рантайма, а не про норму проекта')
})

test('правило одного вызова названо обеим стадиям и несёт рецепт, а не запрет', async () => {
  const r = await run({ base: BASE })
  for (const prompt of [r.dev[0].prompt, r.test[0].prompt]) {
    assert.match(prompt, /НЕ УКЛАДЫВАЕТСЯ В ОДИН ВЫЗОВ/)
    assert.match(prompt, /АДРЕСНО/, 'сказано, чем заменить полный прогон')
  }
  assert.match(r.test[0].prompt, /обе половины сравнения красных тебе ВЫДАНЫ/)
})

test('мутация проверяется адресным прогоном, а не набором', async () => {
  const r = await run({ base: BASE })
  const p = r.test[0].prompt
  assert.match(p, /КАЖДАЯ МУТАЦИЯ ПРОВЕРЯЕТСЯ АДРЕСНЫМ ПРОГОНОМ/)
  assert.match(p, /Набором целиком мутацию не проверяй ни одной/)
  assert.match(p, /pytest путь::тест/, 'форма адресного прогона названа, а не подразумевается')
})

// ── Отметка перерасхода на событии ───────────────────────────────────────────
//
// Движок идущую стадию не прерывает — прервать подагента нечем. Поэтому бюджет держится
// тремя вещами: назван в промпте (выше), ИЗМЕРЕН на финише (здесь) и виден на доске.
// Отметка ставится на самом событии, а не считается потом по журналу: событие
// иммутабельно (ADR-0003), и факт о стадии живёт в её собственном событии — там же, где
// расход токенов.
import { writeEvent, listEvents } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

const hook = (p, payload) =>
  p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })

// Старт кладём прямо в журнал: хук на старте пишет то же самое, а нам нужен контроль над
// временем — иначе стадия всегда «уложилась», и проверять было бы нечего.
function startedAt(p, { ticket, stage, agentId, ts }) {
  writeEvent(p.root, {
    ts, change: p.change, ticket, stage, event: 'started', actor: `firm2:firm-${stage === 'dev' ? 'developer' : 'tester'}`,
    attempt: 1, agent_id: agentId, session_id: 's1', source: 'hook',
  })
}

const finish = (p, { ticket, stage, agentId }) => hook(p, {
  agent_type: `firm2:firm-${stage === 'dev' ? 'developer' : 'tester'}`,
  hook_event_name: 'SubagentStop',
  agent_id: agentId,
  cwd: p.root,
  prompt: `FIRM2-TICKET: ${ticket}\nFIRM2-CHANGE: ${p.change}`,
})

const finishedOf = (p, ticket) =>
  listEvents(p.root, { change: p.change }).filter((e) => e.ticket === ticket && e.event === 'finished')

test('стадия вышла за бюджет — на событии стоит отметка с замером и порогом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const ago = new Date(Date.now() - 95 * 60000).toISOString()
  startedAt(p, { ticket: 'T-001', stage: 'dev', agentId: 'aaa1', ts: ago })
  finish(p, { ticket: 'T-001', stage: 'dev', agentId: 'aaa1' })

  const ev = finishedOf(p, 'T-001').find((e) => e.stage === 'dev')
  assert.ok(ev, 'финиш стадии не записан')
  assert.ok(ev.over_budget, 'перерасход не отмечен — значит бюджет остался словами в промпте')
  assert.equal(ev.over_budget.budget, 30)
  assert.ok(ev.over_budget.minutes >= 94 && ev.over_budget.minutes <= 96, `замер ${ev.over_budget.minutes}`)
})

test('стадия в бюджет уложилась — отметки нет вовсе', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  startedAt(p, { ticket: 'T-001', stage: 'test', agentId: 'bbb1', ts: new Date(Date.now() - 12 * 60000).toISOString() })
  finish(p, { ticket: 'T-001', stage: 'test', agentId: 'bbb1' })
  const ev = finishedOf(p, 'T-001').find((e) => e.stage === 'test')
  assert.ok(ev)
  assert.equal(ev.over_budget, undefined, 'отметка на каждой стадии обесценила бы сигнал')
})

test('проект снял бюджет — перерасход не считается ни у одной стадии', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'stage_budget: off\n' })
  startedAt(p, { ticket: 'T-001', stage: 'dev', agentId: 'ccc1', ts: new Date(Date.now() - 200 * 60000).toISOString() })
  finish(p, { ticket: 'T-001', stage: 'dev', agentId: 'ccc1' })
  const ev = finishedOf(p, 'T-001').find((e) => e.stage === 'dev')
  assert.ok(ev)
  assert.equal(ev.over_budget, undefined, '«бюджета нет» видно в конфиге, и это честнее тихого завышения')
})

test('порог проекта сильнее умолчания движка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'stage_budget:\n  dev: 120\n' })
  startedAt(p, { ticket: 'T-001', stage: 'dev', agentId: 'ddd1', ts: new Date(Date.now() - 95 * 60000).toISOString() })
  finish(p, { ticket: 'T-001', stage: 'dev', agentId: 'ddd1' })
  const ev = finishedOf(p, 'T-001').find((e) => e.stage === 'dev')
  assert.equal(ev.over_budget, undefined, '95 минут при бюджете 120 — не перерасход')
})

test('Д-30: проект сузил набор — стадиям сказано, что полный не гнать ни разу', async () => {
  // Текстовая половина потолка. Сторож отменяет вызов (tests/guards.test.mjs), но роль,
  // которая узнаёт о запрете только из отказа, уже потратила ход — и пойдёт искать обход.
  const r = await run({ base: BASE, extra: { test_cmd: 'npm test', task_test_cmd: 'npm test -- --ignore meta' } })
  for (const [what, prompt] of [['разработке', r.dev[0].prompt], ['тесту', r.test[0].prompt]]) {
    assert.match(prompt, /НАБОР ЦЕЛИКОМ В СТАДИИ НЕ ГОНИ НИ РАЗУ/, `запрет не назван ${what}`)
    assert.match(prompt, /npm test -- --ignore meta/, 'названа команда, которую гнать')
    assert.match(prompt, /шаг 3б/, 'названо место полного прогона — ворота поставки')
    assert.match(prompt, /сторож отменит/, 'сказано, что это не совет: вызов будет отменён')
  }
})

test('Д-30: сужения нет — прежнее правило «один раз и последним» остаётся', async () => {
  // Запрет без выхода роль обходит, а не исполняет: без задачного набора замены полному
  // прогону у стадии нет вовсе, и потолок тут был бы вреден.
  const r = await run({ base: BASE, extra: { test_cmd: 'npm test', task_test_cmd: null } })
  assert.match(r.test[0].prompt, /набор целиком нужен — гони его ОДИН раз и последним/)
  assert.doesNotMatch(r.test[0].prompt, /НЕ ГОНИ НИ РАЗУ/)
})
