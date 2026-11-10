// Д-63. Задачу, которую прогон сам эскалировал, а человек разобрал по ходу, прогон не
// подхватывал — и не мог: добор брал только то, чего в его списке нет ВОВСЕ.
//
// Отчёт проект-В 09.11.2026, первый прогон поставки G-020 (40 задач, движок 0.4.133). `T-388` —
// узел графа, на неё опирались семь задач — сделала работу и эскалировала с находкой про
// нарезку. Архитектор разобрал за 69 минут, Оркестратор записал `lifecycle/arbitrated`
// штатной командой, доска показала `ready`, `sync` и `doctor` зелены. Прогон задачу больше
// не взял: список задач он получает в `args` на старте, а фильтр добора снимал всё, что
// уже есть в `BY_ID`, — то есть и задачу собственного плана. Полтора часа на двух слотах из
// восьми, 26 задач с нулём попыток, ещё одни ворота человека.
//
// Возврат узкий, и тесты держат именно его границы: признак машинный (`arbitrated` ПОСЛЕ
// `escalated`), задача из плана ЭТОГО прогона, эскалировал её он сам, попытки берутся из
// журнала и не обнуляются — разбор лишнего захода не даёт (Д-11).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const rec = (id, over = {}) => ({
  id, path: `tasks/${id}.md`, labels: [], parallel_safe: true, depends_on: [],
  status: 'ready', attempt: 0, ...over,
})
const RETURNED = { escalated_ts: '2026-11-09T07:53:00Z', arbitrated_ts: '2026-11-09T09:02:00Z', actor: 'human' }

// `escalateOnce` — задачи, чья стадия разработки эскалирует на ПЕРВОЙ попытке и работает на
// второй: ровно путь T-388. `probes` — ответы зонда состояния по порядку вызовов.
async function run({ tasks, probes, escalateOnce = [] }) {
  const logs = []
  const calls = []
  const seen = new Map()
  let probe = 0
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha0000', head: 'ma1nsha0000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') {
      const r = probes[Math.min(probe++, probes.length - 1)]
      return { state: 'ok', exists: [], merged: [], workable: [], ...r }
    }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) {
      const id = label.slice(4).split('#')[0]
      const n = (seen.get(id) || 0) + 1
      seen.set(id, n)
      if (escalateOnce.includes(id) && n === 1) {
        return { status: 'ok', escalate: true, notes: 'находка про нарезку: сторожа не приписаны никому' }
      }
      return { status: 'ok', escalate: false }
    }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof' }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '', tasks,
  }))
  return {
    built: calls.filter((l) => l.startsWith('dev:')).map((l) => l.slice(4).split('#')[0]),
    log: logs.join('\n'),
    out,
  }
}

test('разобранная эскалация возвращает задачу плана в очередь, и зависимые разблокируются', async () => {
  // Расстановка проект-В в миниатюре: узел графа и задача, которая его ждёт.
  const node = rec('T-388')
  const dependent = rec('T-389', { depends_on: ['T-388'] })
  const r = await run({
    tasks: [node, dependent],
    escalateOnce: ['T-388'],
    probes: [
      { workable: [node, dependent] },
      // Разбор записан человеком по ходу прогона: статус снова ready, попытка уже горела.
      { workable: [rec('T-388', { attempt: 1, returned_from_escalation: RETURNED }), dependent] },
    ],
  })
  assert.equal(r.built.filter((id) => id === 'T-388').length, 2, 'задача прошла второй заход')
  assert.ok(r.built.includes('T-389'), 'ждавшая её задача пошла в работу в ЭТОМ прогоне')
  assert.match(r.log, /Возвращаю T-388 в очередь/)
  assert.match(r.log, /эскалация разобрана/)
  assert.match(r.log, /попытка 2 из 3/, 'счёт попыток продолжается — разбор не дарит заход')
  assert.match(r.log, /ворот человека/, 'названа альтернатива: ждать конца прогона и запускать заново')
})

test('в итоге прогона о возвращённой задаче одна запись, а не две', async () => {
  const node = rec('T-388')
  const r = await run({
    tasks: [node, rec('T-389', { depends_on: ['T-388'] })],
    escalateOnce: ['T-388'],
    probes: [
      { workable: [node] },
      { workable: [rec('T-388', { attempt: 1, returned_from_escalation: RETURNED })] },
    ],
  })
  const mine = r.out.tasks.filter((t) => t.id === 'T-388')
  assert.equal(mine.length, 1, 'две записи об одной задаче читаются как две задачи')
  assert.ok(!mine[0].escalate, 'осталась запись второго захода, а не прежняя с эскалацией')
  assert.ok(mine[0].accepted, 'и в ней тот исход, которым задача кончилась на самом деле')
})

test('без машинного признака возврата задача не берётся повторно', async () => {
  // Статус `ready` у эскалировавшей задачи сам по себе ничего не значит: доска показывает
  // его и до разбора. Решает поле, снятое по журналу, — иначе прогон крутил бы круг.
  const node = rec('T-388')
  const r = await run({
    tasks: [node, rec('T-389', { depends_on: ['T-388'] })],
    escalateOnce: ['T-388'],
    probes: [{ workable: [node] }, { workable: [rec('T-388', { attempt: 1 })] }],
  })
  assert.equal(r.built.filter((id) => id === 'T-388').length, 1)
  assert.doesNotMatch(r.log, /Возвращаю T-388/)
})

test('попытки кончились — возврата нет: лимит против бесконечного круга остаётся', async () => {
  const node = rec('T-388')
  const r = await run({
    tasks: [node, rec('T-389', { depends_on: ['T-388'] })],
    escalateOnce: ['T-388'],
    probes: [
      { workable: [node] },
      { workable: [rec('T-388', { attempt: 3, returned_from_escalation: RETURNED })] },
    ],
  })
  assert.equal(r.built.filter((id) => id === 'T-388').length, 1)
  assert.doesNotMatch(r.log, /Возвращаю T-388/)
})

test('чужую эскалацию прогон не подбирает: её вёл другой прогон', async () => {
  // Задача не из плана этого прогона и эскалировала не в нём. Признак возврата у неё есть,
  // но подбирать за чужим прогоном движок не станет (ADR-0009) — её возьмёт перезапуск.
  const r = await run({
    tasks: [rec('T-001')],
    probes: [{ workable: [rec('T-001'), rec('T-700', { attempt: 1, status: 'ready', returned_from_escalation: RETURNED })] }],
  })
  assert.doesNotMatch(r.log, /Возвращаю T-700/)
})
