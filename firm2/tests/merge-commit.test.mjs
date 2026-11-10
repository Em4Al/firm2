// Д-19. Коммит движка после слияния: заголовок обязан называть то, что в коммите лежит.
//
// Хук `post-merge` пишет события слияния в ГЛАВНОЕ дерево и сам кладёт их в индекс
// (иначе `git clean` их снесёт). Что с ними делать дальше, движок не предписывал вовсе —
// и стадия придумывала и команду, и заголовок. Замер проект-В 28.10.2026: коммит
// «chore(firm2): события слияния T-144» содержал РОВНО ОДИН файл, `.claude/settings.json`,
// — правку человека, сделанную в ту же минуту; событий в нём не было, они легли в соседний
// коммит. Главное дерево — рабочее место человека, и он работает там, пока идёт волна.
//
// Прод-код исполняется настоящий: подменяется только то, что за agent().
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const TASK = { id: 'T-001', path: 't.md', title: 'демо', labels: [], parallel_safe: true }

async function mergePrompt() {
  const calls = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label.startsWith('основание:')) return { state: 'unknown', output: 'дерево не завелось' }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [TASK.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt/T-001', branch: 'task/T-001' }
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
  await fn(stub, parallel, () => {}, () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '', tasks: [TASK],
  }))
  const m = calls.find((c) => c.label.startsWith('merge:'))
  assert.ok(m, 'слияние не позвали — проверять нечего')
  return m.prompt
}

test('коммит событий ПОСЛЕ слияния предписан, путём и заголовком', async () => {
  const p = await mergePrompt()
  assert.match(p, /ШАГ 3а/, 'шаг существует: без него стадия придумывает его сама')
  assert.match(p, /add \.firm\/events/, 'путь перечислен, а не собран широко')
  assert.match(p, /события слияния T-001/, 'заголовок задан движком, а не стадией')
})

test('широкий add в этом шаге запрещён поимённо', async () => {
  const p = await mergePrompt()
  // Все три формы, потому что роль выберет ту, которую не запретили. И проверяется именно
  // ЗАПРЕТ, а не упоминание: первая редакция теста ловила слова `git add -A` и проходила
  // на мутации, где той же строкой этот add разрешался.
  assert.match(p, /здесь НЕ использовать — ни одну из трёх/, 'запрет назван запретом')
  assert.match(p, /git commit -a/, 'запрещён `git commit -a`')
  assert.match(p, /git add -A/, 'запрещён `git add -A`')
  assert.match(p, /git add \./, 'запрещён `git add .`')
  assert.match(p, /рабочее место\nЧЕЛОВЕКА|рабочее место ЧЕЛОВЕКА/, 'сказано, ЧЬИ правки лежат в главном дереве')
  assert.match(p, /settings\.json/, 'назван замер: что именно уехало под заголовком движка')
})

test('чужое незакоммиченное не коммитится и не прячется, а называется в notes', async () => {
  const p = await mergePrompt()
  assert.match(p, /НЕ коммить его и не прячь/)
  assert.match(p, /notes/, 'направление отказа открытое: движок не трогает чужое, но и не молчит о нём')
  assert.match(p, /ADR-0009/)
})

// ── Д-21/Д-38: карман шаг больше не заводит, а найденный — подписан и назван ──
//
// Отчёт проект-В 28.10.2026: `git stash list` отдал 27 записей через шесть поставок, самая
// старая — трёхнедельной давности (к 01.11.2026 их 44). Карман клал шаг слияния: правка
// файла задачи мешала мержу. С 0.4.118 он её КОММИТИТ — файл задачи документ поставки, и
// его место в ветке, — то есть причина кармана снята у корня (Д-38). Правила про карман
// остаются ровно для найденного: прежние версии оставили их в деревьях, и возврат такого
// кармана по-прежнему делается `pop`, а не `drop`.
test('файлы задач коммитятся, а не откладываются карманом (Д-38)', async () => {
  const p = await mergePrompt()
  assert.match(p, /add \.firm\/events \.firm\/ids docs\/bugs openspec\/changes\/demo\/tasks/,
    'коммит на ШАГЕ 2; `.firm/ids` — брони номеров багов, они того же рода, что журнал (находка 4)')
  assert.match(p, /В КАРМАН \(git stash\) файлы задач НЕ КЛАДУТСЯ/)
  assert.match(p, /add -- <пути файлов задач>/, 'если файл изменился после ШАГА 2 — снова коммит, адресно')
  assert.doesNotMatch(p, /stash push -m "firm2: кэш статуса перед слиянием/,
    'рецепта «отложи кэш статуса» больше нет: именно по этой подписи уехали правки плана (Д-25, Д-38)')
})

test('карман, найденный в дереве, подписан по содержимому и возвращается pop (Д-21)', async () => {
  const p = await mergePrompt()
  assert.match(p, /stash push -m "firm2:/, 'подпись движка обязательна и у кармана человека')
  assert.match(p, /Подпись .* обязательна/, 'сказано, зачем подпись, а не только что она нужна')
  assert.match(p, /должна описывать СОДЕРЖИМОЕ/, 'подпись, лгущая о содержимом, — та же болезнь, что Д-22')
  assert.match(p, /именно pop, НЕ drop/, 'прежнее правило на месте: drop уничтожает молча')
  assert.match(p, /Карман в этом случае ОСТАЁТСЯ лежать/, 'оставленный карман — не ошибка стадии')
})
