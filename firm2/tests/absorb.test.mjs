// Д-14. Задача, вернувшаяся в цикл или заведённая в поставку ПОСЛЕ старта прогона,
// волной не перепланировалась — и слот при этом простаивал.
//
// Повод — замер прогона 2026-10-23-game-redesign (движок 0.4.103, parallelism 3):
// занятость 1,73 слота из 3 и 5,5 слото-часов простоя при ГОТОВОЙ задаче в поставке.
// Механизмы: T-172 (заведена арбитражем T-134 в 09:16) и T-176 (10:39) — плана прогона
// не было; T-150 — эскалация снята человеком в 12:32 с оставшимися попытками, но в
// очередь задача не вернулась. До 0.4.108 прогон про такие задачи только сообщал.
//
// Тесты держат добор и его четыре границы — каждая снимает свой способ навредить:
//   1. задача пригодная (ready/rework) берётся и ведётся до конца;
//   2. статус, означающий «ей уже заняты» (in_progress, accepted), не берётся;
//   3. попытки кончились — не берётся: иначе добор обнуляет MAX_ATTEMPTS;
//   4. один раз за прогон: второй возврат — решение человека, а не круг движка;
//   5. план прогона исчерпан — добора нет, и об этом сказано поимённо (ADR-0009).
//
// Прод-код исполняется настоящий: подменяется только то, что за agent().
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const rec = (id, over = {}) => ({
  id, path: `tasks/${id}.md`, labels: [], parallel_safe: true, depends_on: [],
  status: 'ready', attempt: 0, ...over,
})
const PLAN = rec('T-001')

// `probes` — ответы зонда состояния по порядку вызовов: столько зондов, сколько раз
// планировщик спросил. Последний повторяется, иначе прогон упёрся бы в конец списка.
async function run(probes) {
  const calls = []
  const logs = []
  let probe = 0
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label === 'пауза?') return { state: 'running' }
    // Основание сверки (BR-165): движок снимает красные на ветке-цели один раз на прогон.
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha0000', head: 'ma1nsha0000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') {
      const r = probes[Math.min(probe++, probes.length - 1)]
      return { state: 'ok', exists: [], merged: [], ...r }
    }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
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
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '', tasks: [PLAN],
  }))
  // Метка стадии несёт номер попытки (`dev:T-900#1`) — здесь важна только задача.
  const built = calls.filter((l) => l.startsWith('dev:')).map((l) => l.slice(4).split('#')[0])
  return { built, log: logs.join('\n'), out }
}

test('пригодная задача вне плана добирается и доводится до конца', async () => {
  const { built, log } = await run([{ workable: [PLAN, rec('T-900')] }])
  assert.ok(built.includes('T-900'), `добор не состоялся, вели только ${built.join(', ')}`)
  assert.match(log, /Добираю T-900/)
  assert.match(log, /заведена после старта прогона/)
  assert.match(log, /простой слота/, 'названа альтернатива добору — иначе непонятно, зачем прогон отступил от плана')
})

test('вернувшаяся в цикл задача добирается, и это названо возвратом, а не появлением', async () => {
  // Ровно случай T-150: эскалацию сняли, попытки остались. Признак возврата — не статус
  // (вернуться можно и в `ready`), а ненулевая попытка.
  const { built, log } = await run([{ workable: [PLAN, rec('T-150', { attempt: 2 })] }])
  assert.ok(built.includes('T-150'))
  assert.match(log, /вернулась в цикл/)
  assert.match(log, /попытка 3 из 3/, 'номер попытки продолжает счёт, а не начинает заново')
})

test('задача, которой уже заняты, не добирается', async () => {
  // `in_progress`/`in_test`/`in_review` — её прямо сейчас ведёт этот или чужой прогон,
  // `accepted` — она ждёт слияния. Взять такую значит вести одну работу дважды.
  for (const status of ['in_progress', 'in_test', 'in_review', 'accepted', 'blocked', 'merged']) {
    const { built } = await run([{ workable: [PLAN, rec('T-901', { status })] }])
    assert.ok(!built.includes('T-901'), `статус ${status} добирать нельзя`)
  }
})

test('попытки кончились — добора нет: иначе возврат обнуляет лимит', async () => {
  const { built, log } = await run([{ workable: [PLAN, rec('T-902', { attempt: 3 })] }])
  assert.ok(!built.includes('T-902'))
  assert.doesNotMatch(log, /Добираю T-902/)
})

test('одна задача добирается один раз за прогон', async () => {
  const { built } = await run([{ workable: [PLAN, rec('T-903')] }])
  assert.equal(built.filter((id) => id === 'T-903').length, 1, 'второй добор той же задачи — это круг, а не работа')
})

test('план прогона исчерпан — добора нет, и это сказано поимённо', async () => {
  // Мандат прогона — его план. T-904 исключительная, поэтому она ждёт конца T-001 и
  // держит очередь непустой; к моменту следующего зонда из плана не осталось ничего —
  // ни в очереди, ни в работе, — и добор кончается вместе с мандатом.
  const { built, log } = await run([
    { workable: [PLAN, rec('T-904', { parallel_safe: false, exclusive_why: 'для теста' })] },
    { workable: [rec('T-905')] },
  ])
  assert.ok(built.includes('T-904'), 'первый добор при живом плане состоялся')
  assert.ok(!built.includes('T-905'), 'после исчерпания плана прогон чужую работу не берёт')
  assert.match(log, /T-905/, 'задача названа поимённо, а не «есть ещё задачи»')
  assert.match(log, /перезапуск \/firm-build|Перезапуск \/firm-build/, 'сказано, чем её взять')
})
