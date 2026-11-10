// ОТВЕТ «УЖЕ ИЗМЕРЕНО» ОБЯЗАН НАЗВАТЬ ИЗМЕРЕННОЕ.
//
// Найдено 10.11.2026 при разборе второго отчёта проект-В за день. Отчёт просил другого — он
// заметил, что четыре ответа зонда основания пришли без поля `head`, и предлагал завести
// для пропущенного прогона отдельное состояние, чтобы «нет head» означало ровно одно.
// Отдельное состояние у движка уже было (`state: "same"`, и `provenRevision` применяется
// только к `state: "ok"`), то есть противоречия правила с оптимизацией не было. Дыра
// оказалась рядом и хуже.
//
// Ветка дедупликации стояла условием `state === 'same' && BASE.has(sha)`. Ответ с
// НЕузнанным sha проваливался мимо неё и мимо сверки ревизии (та зовётся только для
// `'ok'`) в общую запись, где пустой `red` становился измерением «красных 0»: движок
// сочинял снимок коммита и выдавал его стадиям как данность. Класс Д-43 — числа под
// верным именем точки ветвления, — только без чужой ревизии: без замера вообще.
//
// Воспроизводилось это собственным промптом движка: список уже измеренных коммитов он
// показывал в 12 знаков, и зонд, честно сверившийся с этим списком, возвращал сокращённый
// sha. Поэтому тест держит ТРИ случая: точное совпадение, однозначный префикс (ровно та
// форма, которой учил промпт) и неузнанный ответ, где единственный законный исход —
// «не знаю», а не нуль.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

const SHA = 'ba5e0dedbeef1234567890abcdef1234567890ab'

// Две задачи, оба зонда точки ветвления под нашим управлением: первый мерит, второй
// отвечает дедупликацией так, как велит `second`.
async function run(second) {
  const logs = []
  let measured = 0
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание: точка ветвления')) {
      measured += 1
      if (measured === 1) {
        return { state: 'ok', sha: SHA, head: SHA, cmd: 'suite', red: ['a::x', 'b::y'], failed: 2, total: 10 }
      }
      return second
    }
    if (label.startsWith('основание:')) {
      return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'suite', red: [], failed: 0, total: 10 }
    }
    if (label === 'состояние поставки') return { state: 'ok', exists: ['T-101', 'T-102'], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
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
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/tmp/firm2-wt', task_test_cmd: 'suite', test_cmd: 'suite',
    now: '2026-11-10T09:00:00Z',
    tasks: [
      { id: 'T-101', path: 'T-101.md', labels: [], parallel_safe: true },
      { id: 'T-102', path: 'T-102.md', labels: [], parallel_safe: true },
    ],
  }))
  return { out, text: logs.join('\n') }
}

// Снимки основания прогона: по одному на РАЗЛИЧНУЮ точку ветвления. Сочинённый замер
// виден здесь вторым снимком с нулём красных — тем, которого никто не делал.
const snaps = (out) => out.base_snapshots || []

test('точный sha: измерение переиспользуется, и в логе названы ВЗЯТЫЕ числа', async () => {
  const r = await run({ state: 'same', sha: SHA })
  assert.match(r.text, /уже измерена в этом прогоне/)
  assert.match(r.text, /числа взяты у того замера \(красных 2\)/)
  assert.deepEqual(snaps(r.out), [{ sha: SHA, red: 2, total: 10 }])
})

test('СОКРАЩЁННЫЙ sha — та форма, которой учил сам промпт, — разрешается префиксом', async () => {
  const r = await run({ state: 'same', sha: SHA.slice(0, 12) })
  assert.match(r.text, /уже измерена в этом прогоне/)
  // Один снимок, с настоящими числами и ПОЛНЫМ sha измеренного: до правки здесь
  // появлялся второй снимок на сокращённый sha с «красных 0».
  assert.deepEqual(snaps(r.out), [{ sha: SHA, red: 2, total: 10 }])
})

test('неузнанный sha: «не знаю» вместо нуля — снимка коммита никто не делал', async () => {
  const r = await run({ state: 'same', sha: 'deadbeefdead' })
  assert.match(r.text, /НЕ принято/)
  assert.match(r.text, /которого среди измеренных нет/)
  assert.match(r.text, /сочинить «красных нет» — тем более/)
  assert.deepEqual(snaps(r.out), [{ sha: SHA, red: 2, total: 10 }], 'сочинённого снимка нет')
})

test('промпт зонда больше не показывает известные коммиты сокращёнными', () => {
  // Причина дефекта была в тексте, а не только в условии: движок показывал список в 12
  // знаков и получал в ответ 12 знаков. Провод держит именно это.
  assert.ok(!/known\.map\(\(x\) => x\.slice\(0, 12\)\)/.test(BODY), 'список известных sha — полный')
  assert.match(BODY, /sha возвращай ПОЛНОСТЬЮ/)
})
