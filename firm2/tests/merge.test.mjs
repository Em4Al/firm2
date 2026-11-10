// Инварианты слияния: И-4, И-5, И-12 (и И-6 для события, дописанного сверкой).
// Приём построения репозитория — из scripts/preflight.mjs, раздел 4.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listEvents, writeEvent, computeBoard } from '../scripts/lib/firm.mjs'
import { makeProject, commitFile, COMMIT_DATE, isoAgo } from './helpers.mjs'

// Сверка зовётся так, как её зовёт движок, — командой `sync`. Импортировать
// `firm-event.mjs` нельзя: это CLI, и импорт означал бы его ИСПОЛНЕНИЕ
// (см. предупреждение в preflight.mjs, шаг 2).
function reconcile(p) {
  const r = p.evJson('sync')
  assert.equal(r.status, 0, `sync упал: ${r.stderr}`)
  assert.ok(r.json, `sync не отдал JSON: ${r.stdout}`)
  return r.json.reconciled
}

const MERGE_TS = new Date(COMMIT_DATE).toISOString() // 2026-09-30T12:04:05.000Z
const DEV_TS = '2026-09-30T11:00:00.000Z' // раньше слияния, иначе срабатывает страховка

// Порядок важен: события пишутся ПОСЛЕ сборки git-сцены. `writeEvent` кладёт файл
// события в индекс (чтобы `git clean` его не снёс), и коммит на ветке задачи забрал бы
// журнал с собой — в настоящем маршруте этого не бывает, там ветка задачи живёт в
// отдельном рабочем дереве, а журнал пишется в главное.
function devStarted(p, ticket, ts = DEV_TS) {
  writeEvent(p.root, { ts, change: p.change, ticket, stage: 'dev', event: 'started', actor: 'test' })
}

function reviewAccepted(p, ticket, ts) {
  writeEvent(p.root, { ts, change: p.change, ticket, stage: 'review', event: 'accepted', actor: 'test' })
}

// Ветка задачи, влитая через КОНФЛИКТ: `git merge` встаёт, доводит `git commit`, и
// post-merge на этот путь не вешается ни одним хуком git (ADR-0005).
function mergeWithConflict(p, ticket) {
  p.git('checkout', '-q', '-b', `task/${ticket}`)
  commitFile(p, 'f.txt', `${ticket}\n`, ticket)
  p.git('checkout', '-q', `feature/${p.change}`)
  commitFile(p, 'f.txt', 'поставка\n', 'parallel')
  try {
    p.git('merge', '--no-ff', '--no-edit', `task/${ticket}`)
  } catch {
    commitFile(p, 'f.txt', 'разрешено\n', `merge ${ticket} (конфликт разрешён)`)
  }
}

// ── И-4 ──────────────────────────────────────────────────────────────────────

test('И-4: слияние после конфликта дописывается сверкой — ровно одним событием', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeWithConflict(p, 'T-001')
  devStarted(p, 'T-001')

  const written = reconcile(p)
  assert.equal(written.length, 1, 'сверка обязана увидеть мерж-коммит, которого не видел хук')
  assert.equal(written[0].ticket, 'T-001')

  const files = p.eventFiles().filter((f) => /T-001-merge-finished/.test(f))
  assert.equal(files.length, 1, `событий слияния должно быть одно: ${files.join(', ')}`)

  // Идемпотентность: сверка зовётся на каждом событии стадии.
  assert.deepEqual(reconcile(p), [], 'повторная сверка не должна дублировать')
  assert.equal(p.eventFiles().filter((f) => /T-001-merge-finished/.test(f)).length, 1)
})

test('И-4: ветка без своих коммитов на вершине поставки не считается влитой', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  // Ровно то, что делает стадия Prepare: worktree add -B task/T-001 ... feature/ch.
  p.git('branch', '-q', 'task/T-001', `feature/${p.change}`)

  assert.deepEqual(reconcile(p), [], 'свежая ветка «влита» только для наивных проверок')
  assert.deepEqual(p.eventFiles().filter((f) => /merge-finished/.test(f)), [])
})

test('И-4: ветка, ставшая ПЕРВЫМ родителем соседнего слияния, не считается влитой (дефект 0.4.40)', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002', 'T-003'] })

  // Сначала влили T-001 — вершина поставки стала мерж-коммитом M.
  mergeWithConflict(p, 'T-001')
  const M = p.git('rev-parse', 'HEAD').trim()

  // T-002 завели сразу после этого: её вершина — ровно M, своих коммитов нет.
  p.git('branch', '-q', 'task/T-002', `feature/${p.change}`)
  assert.equal(p.git('rev-parse', 'task/T-002').trim(), M)

  // Теперь вливаем СОСЕДНЮЮ задачу: у нового мерж-коммита первый родитель — M,
  // то есть вершина ветки T-002.
  p.git('checkout', '-q', '-b', 'task/T-003', `feature/${p.change}`)
  commitFile(p, 'g.txt', 'T-003\n', 'T-003')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '--no-edit', 'task/T-003')
  const parents = p.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/)
  assert.equal(parents[1], M, 'сцена не собралась: первый родитель должен быть вершиной T-002')

  for (const id of ['T-001', 'T-002', 'T-003']) devStarted(p, id)
  const written = reconcile(p)
  assert.deepEqual(
    written.map((w) => w.ticket).sort(), ['T-001', 'T-003'],
    'влиты только T-001 и T-003; T-002 — первый родитель, а не «что влили»',
  )
  assert.deepEqual(p.eventFiles().filter((f) => /T-002-merge/.test(f)), [])
})

test('И-4: ложное «влито» в журнале ловится инвариантами doctor и снимается аннулированием', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.git('branch', '-q', 'task/T-001', `feature/${p.change}`)
  // Время свежее: открытая стадия старше шести часов — отдельная находка (И-11),
  // и она бы смешалась с проверяемой здесь.
  devStarted(p, 'T-001', isoAgo(0.1))
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')

  const bad = p.evJson('doctor')
  assert.equal(bad.json.ok, false, 'доказанная неправда в журнале обязана валить ok')
  const hit = (bad.json.impossible_events || []).find((i) => i.ticket === 'T-001')
  assert.ok(hit, `находка не названа: ${JSON.stringify(bad.json.impossible_events)}`)
  assert.match(hit.fix, /--event retracted --corrects/, 'к находке обязана прилагаться готовая команда')

  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', hit.file, '--notes', 'вливать было нечего')
  assert.equal(r.status, 0, r.stderr)
  const healed = p.evJson('doctor')
  assert.equal(healed.json.ok, true, 'после аннулирования находки быть не должно')
  // Сверка после аннулирования обязана молчать сама: доказательства-то нет.
  assert.deepEqual(reconcile(p), [])
})

// ── И-5 и И-6 для дописанного события ────────────────────────────────────────

test('И-5: время события слияния — время мерж-коммита, а не момента записи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeWithConflict(p, 'T-001')
  devStarted(p, 'T-001')

  const written = reconcile(p)
  assert.equal(written[0].ts, MERGE_TS, 'журнал отвечает «когда случилось», а не «когда заметили»')

  const commitIso = new Date(p.git('log', '-1', '--format=%cI', `feature/${p.change}`).trim()).toISOString()
  assert.equal(written[0].ts, commitIso)
  assert.ok(
    Math.abs(Date.now() - Date.parse(written[0].ts)) > 3600000,
    'время записи и время события должны расходиться — иначе проверка ничего не проверяет',
  )
})

test('И-6: событие, дописанное сверкой, тоже в UTC с Z (а не +03:00 из %cI)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeWithConflict(p, 'T-001')
  devStarted(p, 'T-001')
  // %cI отдаёт время со смещением — убедимся, что сцена действительно такая.
  assert.match(p.git('log', '-1', '--format=%cI', `feature/${p.change}`).trim(), /\+03:00$/)

  reconcile(p)
  const f = p.eventFiles().find((x) => /T-001-merge-finished/.test(x))
  const e = JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8'))
  assert.match(e.ts, /Z$/, `ts=${e.ts}: смешать +03:00 с Z значит поехать порядком событий`)
  assert.equal(e.actor, 'reconcile', 'источник события должен быть назван')
  assert.ok(e.notes && e.notes.includes('сверкой'), 'событие обязано объяснять, откуда взялось')
})

test('И-6: порядок событий после сверки остаётся хронологическим при сравнении строк', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeWithConflict(p, 'T-001')
  devStarted(p, 'T-001')
  reconcile(p)
  const ts = listEvents(p.root, { change: p.change }).map((e) => e.ts)
  assert.deepEqual(ts, [...ts].sort((a, b) => Date.parse(a) - Date.parse(b)))
  assert.deepEqual(ts, [DEV_TS, MERGE_TS])
})

// ── И-12 ─────────────────────────────────────────────────────────────────────

test('И-12: мерж-коммита нет — сверка молчит и ничего не пишет в журнал', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Влито «мимо правил»: содержимое ветки в поставке, мерж-коммита нет.
  p.git('branch', '-q', 'task/T-001', `feature/${p.change}`)
  devStarted(p, 'T-001', isoAgo(0.2))
  reviewAccepted(p, 'T-001', isoAgo(0.1))

  const before = p.eventFiles()
  const sync = p.evJson('sync')
  assert.equal(sync.status, 0, sync.stderr)
  assert.deepEqual(sync.json.reconciled, [], 'недоказанное не попадает в журнал')
  assert.deepEqual(p.eventFiles(), before, 'sync не вправе дописывать события слияния без доказательства')
  assert.equal(computeBoard(p.root, p.change).tasks[0].status, 'accepted')
})

test('И-12: doctor задаёт ВОПРОС accepted_not_merged вместо утверждения и не валит ok', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.git('branch', '-q', 'task/T-001', `feature/${p.change}`)
  devStarted(p, 'T-001', isoAgo(0.2))
  reviewAccepted(p, 'T-001', isoAgo(0.1))

  const d = p.evJson('doctor')
  const q = (d.json.accepted_not_merged || []).find((x) => x.ticket === 'T-001')
  assert.ok(q, `задача, принятая и не влитая, обязана быть названа: ${JSON.stringify(d.json.accepted_not_merged)}`)
  assert.equal(q.branch, 'task/T-001')
  assert.equal(q.in_delivery, true, 'своих коммитов относительно поставки нет — это движок знает')
  assert.match(q.question, /влили мимо правил/, 'это вопрос человеку, а не вывод движка')
  assert.match(q.question, /--event finished --actor human/, 'к вопросу прилагается готовая команда')
  assert.equal(d.json.ok, true, 'законное промежуточное состояние не должно красить doctor')
  assert.deepEqual(d.json.impossible_events, [], 'утверждать «влито» движок не вправе')
})

test('И-12: задача со своими коммитами просто ждёт слияния — другого вопроса нет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.git('checkout', '-q', '-b', 'task/T-001')
  commitFile(p, 'f.txt', 'работа\n', 'T-001')
  p.git('checkout', '-q', `feature/${p.change}`)
  devStarted(p, 'T-001', isoAgo(0.2))
  reviewAccepted(p, 'T-001', isoAgo(0.1))

  const d = p.evJson('doctor')
  const q = (d.json.accepted_not_merged || []).find((x) => x.ticket === 'T-001')
  assert.equal(q.in_delivery, false)
  assert.equal(q.question, 'ждёт слияния')
  assert.equal(d.json.ok, true)
})

// ── И-2 и ADR-0006: сверка уважает аннулирование ──────────────────────────────

test('И-2: после аннулирования сверка НЕ пишет то же событие заново', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeWithConflict(p, 'T-001')
  devStarted(p, 'T-001')

  // Настоящее слияние: сверка законно дописывает событие.
  assert.equal(reconcile(p).length, 1)
  const written = p.eventFiles().find((f) => /T-001-merge-finished/.test(f))

  // Человек видит в git больше движка и говорит «нет».
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', written, '--notes', 'мерж-коммит относится к другой поставке')
  assert.equal(r.status, 0, r.stderr)

  // Прежде признак «последнее событие слияния — finished» исчезал вместе с аннулированным
  // событием, и следующий же sync писал ту же запись снова — решение человека отменялось.
  const again = reconcile(p)
  assert.deepEqual(again, [], 'его «нет» сильнее нашего доказательства')
  const live = listEvents(p.root, { change: p.change })
  assert.equal(live.some((e) => e.stage === 'merge' && e.event === 'finished'), false)
  assert.equal(computeBoard(p.root, p.change).tasks[0].status, 'in_progress',
    'задача не числится влитой — иначе следующий прогон молча её пропустит')
})

test('И-4: два «влито» по одной задаче — находка, влияющая на ok', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeWithConflict(p, 'T-001')
  devStarted(p, 'T-001')
  // Стадию закрываем: открытая стадия старше шести часов — отдельная находка (И-11),
  // и она бы валила ok сама, то есть проверка стала бы бессмысленной.
  writeEvent(p.root, {
    ts: '2026-09-30T11:30:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'finished', actor: 'test',
  })
  reconcile(p)

  // Второе событие слияния: влить задачу дважды нельзя.
  writeEvent(p.root, {
    ts: new Date().toISOString(), change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'finished', actor: 'test',
  })

  const d = p.evJson('doctor')
  assert.equal(d.json.ok, false, 'дубль сдвигает тайминг и может прийти от слияния в чужую ветку')
  const dups = (d.json.impossible_events || []).filter((i) => i.ticket === 'T-001')
  assert.equal(dups.length, 1, 'находка — на лишнее событие, а не на оба')
  assert.match(dups[0].why, /уже есть событие слияния/)
  assert.match(dups[0].fix, /--event retracted --corrects/)

  // И снимается она тем же аннулированием.
  const fix = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', dups[0].file, '--notes', 'дубль')
  assert.equal(fix.status, 0, fix.stderr)
  assert.equal(p.evJson('doctor').json.ok, true)
})
