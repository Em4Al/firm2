// Д-72 и Д-73. Два отчёта проект-В от 10.11.2026 про один прогон: 92 вызова агентов, 1 ч 35
// мин, 15 задач, влито ноль.
//
// Д-72 — моя регрессия 0.4.135. В сборщик уехала строка `new Date().toISOString()`, а раннер
// Workflow запрещает скрипту брать время («Date.now() / new Date() are unavailable in
// workflow scripts (breaks resume)») и роняет этим ВЕСЬ вызов стадии. Стояла строка на
// несущем пути — переход Test → QA, — и каждая задача теряла вердикт после пройденных
// разработки и тестов. Прошло это мои тесты потому, что тест исполняет тело прогона обычным
// Node, где `Date` есть: значит запрет держит ТЕКСТ (здесь и шагом 3ж рубежа), а не прогон.
//
// Д-73 — круг планировщика. `T-408` заходила 21 раз одним и тем же сообщением о сорванной
// подготовке дерева: признак `returned_from_escalation` читается из журнала и не меняется от
// того, что прогон задачу уже вернул, поэтому возврат (Д-63) срабатывал каждый круг.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE, loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const rec = (id, over = {}) => ({
  id, path: `tasks/${id}.md`, labels: [], parallel_safe: true, depends_on: [],
  status: 'ready', attempt: 0, ...over,
})
const RETURNED = { escalated_ts: '2026-11-10T07:00:00Z', arbitrated_ts: '2026-11-10T08:00:00Z', actor: 'human' }
const NOW = '2026-11-10T09:30:00Z'

// `prepFail` — задачи, у которых подготовка дерева срывается всегда (ровно случай T-408).
// `deliveryRed` — что Тестировщик называет красным у поставки.
async function run({ tasks, probes = [{}], prepFail = [], deliveryRed = null, now = NOW }) {
  const logs = []
  const calls = []
  let probe = 0
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ba5esha00000', head: 'ba5esha00000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') {
      const r = probes[Math.min(probe++, probes.length - 1)]
      return { state: 'ok', exists: [], merged: [], workable: [], ...r }
    }
    if (label.startsWith('worktree:')) {
      const id = label.slice(9).split('#')[0]
      return prepFail.includes(id)
        ? { status: 'fail', notes: 'branch is already used by worktree' }
        : { status: 'ok', worktree: '', branch: '' }
    }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      const r = { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
      if (deliveryRed) r.delivery_red = deliveryRed
      return r
    }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof', merges_checked: true, unfinished_merges: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/wt', tasks, now,
  }))
  return { calls, log: logs.join('\n'), out }
}

test('в скриптах прогонов нет собственного времени: раннер его запрещает', () => {
  // Единственная проверка, которая ловит Д-72: исполняющий тест этого увидеть не может —
  // тело прогона он гоняет обычным Node, где `new Date()` работает.
  const dir = join(ENGINE, 'workflows')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  assert.ok(files.length, 'каталог прогонов не пуст')
  for (const f of files) {
    const code = readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
    assert.doesNotMatch(code, /new Date\b/, `${f}: собственное время роняет весь вызов стадии — время приходит в args`)
    assert.doesNotMatch(code, /Date\.now\s*\(/, `${f}: то же про Date.now`)
  }
})

test('время снимка отнесения берётся из args и названо момент аргументов', async () => {
  const r = await run({ tasks: [rec('T-001')], deliveryRed: ['web/foo.spec.ts'] })
  const st = r.out.delivery_red_check || []
  assert.equal(st.length, 1)
  assert.equal(st[0].ts, NOW, 'штамп — время, пришедшее в args')
  assert.match(r.log, /поле ts называет момент аргументов прогона/)
})

test('времени в args нет — говорится «момент неизвестен», а не подставляется своё', async () => {
  const r = await run({ tasks: [rec('T-001')], deliveryRed: ['web/foo.spec.ts'], now: null })
  const st = r.out.delivery_red_check || []
  assert.equal(st[0].ts, null)
  assert.match(r.log, /время в args не передано/)
})

test('сорванная сверка отнесения не стоит задаче вердикта', async () => {
  // Отнесение красных — диагностика, а стояло на несущем пути. Ломаем ровно его: имя,
  // которое не читается. Вердикт задачи обязан дойти, а диагностика — назваться «не знаю».
  const bad = { toString() { throw new Error('имя не строка') } }
  const r = await run({ tasks: [rec('T-001')], deliveryRed: [bad] })
  const mine = r.out.tasks.find((t) => t.id === 'T-001')
  assert.ok(mine && mine.accepted, 'вердикт задачи дошёл')
  assert.match(r.log, /отнесение красных поставки не посчитано/)
  assert.match(r.log, /Вердикт задачи это не отменяет/)
  const st = r.out.delivery_red_check || []
  assert.equal(st.length, 1)
  assert.equal(st[0].state, 'unknown', 'несчитанное отнесение — это «не знаю» с причиной (И-12)')
  assert.match(String(st[0].why), /сверка отнесения сорвалась/)
})

test('подготовка дерева повторяется один раз, и причина уходит в эскалацию', async () => {
  const r = await run({ tasks: [rec('T-408')], prepFail: ['T-408'] })
  const preps = r.calls.filter((l) => l.startsWith('worktree:T-408'))
  assert.equal(preps.length, 2, 'один повтор, а не круг и не ноль')
  assert.equal(r.calls.filter((l) => l.startsWith('dev:')).length, 0, 'работы не было: дерева нет')
  const mine = r.out.tasks.find((t) => t.id === 'T-408')
  assert.ok(mine.escalate, 'задача эскалирует')
  assert.match(String(mine.prepare_failed), /already used by worktree/, 'причина лежит в результате, а не только в логе')
  assert.equal(mine.prepare_failed_same, true, 'та же причина названа тем, что она та же')
  assert.match(r.log, /не удалась дважды/)
})

test('задачу, у которой не завелось дерево, разобранная эскалация обратно не вернёт', async () => {
  // Круг T-408 целиком: разбор в журнале есть, подготовка срывается всегда. 21 заход
  // превращается в один с повтором.
  const r = await run({
    tasks: [rec('T-408'), rec('T-409', { depends_on: ['T-408'] })],
    prepFail: ['T-408'],
    probes: [
      { workable: [rec('T-408')] },
      { workable: [rec('T-408', { attempt: 1, returned_from_escalation: RETURNED })] },
      { workable: [rec('T-408', { attempt: 1, returned_from_escalation: RETURNED })] },
    ],
  })
  assert.equal(r.calls.filter((l) => l.startsWith('worktree:T-408')).length, 2)
  assert.doesNotMatch(r.log, /Возвращаю T-408/, 'разбор относился к содержанию, а сорвалось до первой стадии')
})

test('возврат из разбора — один на задачу за прогон', async () => {
  // Признак возврата читается из журнала и сам не гаснет: без счёта он срабатывал каждый
  // круг. Задача эскалирует стадией, а не подготовкой, — то есть возврат ей положен, но один.
  const logs = []
  const calls = []
  let probe = 0
  const dependent = rec('T-501', { depends_on: ['T-500'] })
  const probes = [
    { workable: [rec('T-500'), dependent] },
    { workable: [rec('T-500', { attempt: 1, returned_from_escalation: RETURNED }), dependent] },
    { workable: [rec('T-500', { attempt: 1, returned_from_escalation: RETURNED }), dependent] },
    { workable: [rec('T-500', { attempt: 1, returned_from_escalation: RETURNED }), dependent] },
  ]
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ba5esha00000', head: 'ba5esha00000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: [], merged: [], ...probes[Math.min(probe++, probes.length - 1)] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: true, notes: 'снова упираюсь в чужую нарезку' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof', merges_checked: true, unfinished_merges: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/wt', tasks: [rec('T-500'), rec('T-501', { depends_on: ['T-500'] })], now: NOW,
  }))
  const back = logs.join('\n').match(/Возвращаю T-500 в очередь/g) || []
  assert.equal(back.length, 1, 'второй возврат — это уже не мандат, а надежда на третий раз')
})
