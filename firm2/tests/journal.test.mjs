// Инварианты журнала: И-1, И-2, И-3, И-6, И-7.
// Имена тестов — номера инвариантов доменной модели (docs/domain-model.md §4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, basename } from 'node:path'
import { computeBoard, listEvents, statusFromEvents, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, plainDir, SCRIPTS } from './helpers.mjs'

// ── И-1. Статус выводится только из событий ──────────────────────────────────

test('И-1: frontmatter-кэш со ЛОЖНЫМ статусом не влияет на вывод доски', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'merged' })

  // В файле задачи написано «merged», событий нет вовсе.
  const board = computeBoard(p.root, p.change)
  const task = board.tasks.find((x) => x.id === 'T-001')
  assert.equal(task.status, 'ready', 'без событий задача не начата, что бы ни было в кэше')
  assert.equal(task.cached_status, 'merged')
  assert.equal(task.cache_stale, true, 'расхождение кэша с журналом должно быть названо')
})

test('И-1: статус идёт за событиями, а не за кэшем, и doctor называет расхождение', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'merged' })
  // Событие пишем библиотекой, а не командой `record`: та зовёт `sync` и честно
  // обновляет кэш сама, а проверить надо именно состояние «кэш врёт», в котором
  // проект живёт между прогонами.
  writeEvent(p.root, {
    ts: new Date().toISOString(), change: p.change, ticket: 'T-001', stage: 'dev', event: 'started',
  })

  const board = computeBoard(p.root, p.change)
  assert.equal(board.tasks[0].status, 'in_progress', 'единственный источник истины — событие')

  // doctor читает тот же вывод и обязан показать расхождение как stale_cache.
  const d = p.evJson('doctor')
  assert.ok(d.json, `doctor не отдал JSON: ${d.stderr}`)
  assert.ok(
    (d.json.stale_cache || []).some((s) => s.startsWith('T-001:')),
    `расхождение кэша не названо: ${JSON.stringify(d.json.stale_cache)}`,
  )
})

// ── И-2. Журнал только дописывается ──────────────────────────────────────────

test('И-2: --corrects исключает прежнее событие из расчёта, но файл остаётся в журнале', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')
  const lie = p.eventFiles().find((f) => /T-001-merge-finished/.test(f))
  assert.ok(lie, 'ложное событие не записалось — проверять нечего')
  assert.equal(statusFromEvents(listEvents(p.root, { change: p.change })).status, 'merged')

  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', lie, '--notes', 'вливать было нечего')
  assert.equal(r.status, 0, r.stderr)

  // Файл НЕ удалён и НЕ изменён.
  assert.ok(existsSync(join(p.eventsPath, lie)), 'аннулирование не вправе удалять файл события')
  // Из расчёта он ушёл.
  const live = listEvents(p.root, { change: p.change })
  assert.equal(live.some((e) => e._file === lie), false, 'исправленное событие не идёт в расчёт')
  assert.equal(statusFromEvents(live).status, null, 'после аннулирования «влито» состояния нет')
  // Но увидеть его можно.
  const all = listEvents(p.root, { change: p.change, includeCorrected: true })
  assert.ok(all.find((e) => e._file === lie)._corrected, 'событие должно быть помечено исправленным')

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.corrected, [lie], 'doctor обязан показывать след ошибки')
  assert.equal(d.json.ok, true, 'аннулирование снимает находку инвариантов')
})

test('И-2: одно исправление на пачку событий, со счётом из самого большого', (t) => {
  // 25.10.2026, проект-В: одна стадия разведки оставила 31 событие с `ticket: unknown` —
  // один заход, одна причина. Тридцать одно исправляющее событие на один факт — это эхо,
  // а не журнал. И перенос счёта тут не удобство: без него починка привязки стоила бы
  // замера — было «неизвестно чьё, но посчитанное», стало бы «чьё известно, но нулевое».
  const p = makeProject(t, { tasks: ['T-001'] })
  const w = (total) => writeEvent(p.root, {
    change: p.change, ticket: 'unknown', stage: 'design', event: 'finished',
    agent_id: 'a1', tokens: { total, calls: 1 },
  })
  const files = [w(100), w(140), w(150)].map((x) => x.split(/[\\/]/).pop())

  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'design', '--event', 'finished',
    '--corrects', files.join(','), '--notes', 'стадия шла по T-001, маркера в промпте не было')
  assert.equal(r.status, 0, r.stderr)

  const live = listEvents(p.root, { change: p.change })
  assert.equal(live.filter((e) => files.includes(e._file)).length, 0, 'все три ушли из расчёта')
  const fix = live.find((e) => e.corrects)
  assert.deepEqual(fix.corrects, files, 'в событии назван каждый исправленный файл')
  assert.equal(fix.tokens.total, 150, 'счёт берётся максимумом: у одного захода финишей бывает несколько')
  assert.equal(fix.agent_id, 'a1', 'агент переносится — иначе привязка по agent_id теряется')
  assert.deepEqual(p.evJson('doctor').json.corrected.sort(), files.sort())
})

test('И-2: в пачке нет хотя бы одного файла — отказ целиком', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')
  const real = p.eventFiles().find((f) => /merge-finished/.test(f))
  const before = p.eventFiles()
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', `${real},нет-такого.json`, '--notes', 'опечатка в одном из имён')
  assert.equal(r.status, 1, 'частичное исправление хуже отказа: половина пачки ушла бы молча')
  assert.deepEqual(p.eventFiles(), before)
})

test('И-2: --corrects на несуществующий файл отвергается и ничего не пишет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const before = p.eventFiles()
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', 'нет-такого-события.json', '--notes', 'опечатка в имени')
  assert.equal(r.status, 1, 'опечатка в имени должна быть отказом, а не событием')
  assert.match(r.stderr, /нет в журнале/)
  assert.deepEqual(p.eventFiles(), before, 'отказ не должен оставлять событие в журнале')
})

test('И-2: --corrects без --notes отвергается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')
  const lie = p.eventFiles().find((f) => /merge-finished/.test(f))
  const before = p.eventFiles()

  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted', '--corrects', lie)
  assert.equal(r.status, 1, 'причина аннулирования обязательна')
  assert.match(r.stderr, /--corrects требует --notes/)
  assert.deepEqual(p.eventFiles(), before)
})

// ── И-3. Одно событие — один файл ────────────────────────────────────────────

test('И-3: два события в одну миллисекунду не затирают друг друга (разные стадии)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const ts = '2026-09-30T12:00:00.000Z'
  writeEvent(p.root, { ts, change: p.change, ticket: 'T-001', stage: 'dev', event: 'finished' })
  writeEvent(p.root, { ts, change: p.change, ticket: 'T-001', stage: 'test', event: 'started' })
  assert.equal(p.eventFiles().length, 2)
  assert.equal(listEvents(p.root, { change: p.change }).length, 2)
})

// Было дефектом движка: имя файла собиралось из ts+тикет+стадия+исход и писалось без
// проверки занятости, поэтому панель ревью теряла два события из трёх молча. Исправлено
// суффиксом и флагом `wx` — проверка остаётся, потому что это и есть И-3.
test('И-3: два события в одну миллисекунду не затирают друг друга (панель ревью: один тикет, три агента)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const ts = '2026-09-30T12:00:00.000Z'
  // Состязательная панель — три ревьюера на один тикет. Каждый пишет своё
  // `review/started` из своего субагента, и попасть в одну миллисекунду они могут.
  for (const agent of ['a1', 'a2', 'a3']) {
    writeEvent(p.root, {
      ts, change: p.change, ticket: 'T-001', stage: 'review', event: 'started', agent_id: agent,
    })
  }
  const files = p.eventFiles()
  assert.equal(files.length, 3, 'три события — три файла (ADR-0003)')
  // Занятое имя получает номер, а не теряется.
  const base = '2026-09-30T12-00-00-000Z-T-001-review-started'
  assert.deepEqual(files, [`${base}-2.json`, `${base}-3.json`, `${base}.json`])
  const got = listEvents(p.root, { change: p.change }).map((e) => e.agent_id).sort()
  assert.deepEqual(got, ['a1', 'a2', 'a3'], 'в каждом файле — свой агент, никто не затёрт')
  // Суффикс не ломает чтения: имя разбирается только как ключ `corrects`.
  assert.equal(listEvents(p.root, { change: p.change }).length, 3)
})

test('И-3: суффикс не мешает аннулировать именно тот файл, который назвали', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const ts = '2026-09-30T12:00:00.000Z'
  for (const agent of ['a1', 'a2']) {
    writeEvent(p.root, {
      ts, change: p.change, ticket: 'T-001', stage: 'merge', event: 'finished', agent_id: agent,
    })
  }
  const second = p.eventFiles().find((f) => f.endsWith('-2.json'))
  assert.ok(second, 'второй файл должен существовать')
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'retracted',
    '--corrects', second, '--notes', 'дубль')
  assert.equal(r.status, 0, r.stderr)
  const live = listEvents(p.root, { change: p.change })
  assert.equal(live.filter((e) => e.event === 'finished').length, 1, 'снят ровно один из двух')
  assert.equal(live.find((e) => e.event === 'finished').agent_id, 'a1')
})

// ── И-6. Все времена — UTC с Z ───────────────────────────────────────────────

test('И-6: у каждого записанного события ts кончается на Z', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--stage', 'dev', '--event', 'started', '--actor', 'test')
  p.ev('record', '--ticket', 'T-001', '--stage', 'dev', '--event', 'finished', '--actor', 'test')
  p.ev('record', '--ticket', 'T-001', '--stage', 'review', '--event', 'started', '--actor', 'test')
  p.ev('abandon', '--ticket', 'T-001', '--stage', 'review')

  const files = p.eventFiles()
  assert.ok(files.length >= 4, `событий меньше ожидаемого: ${files.join(', ')}`)
  for (const f of files) {
    const e = JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8'))
    assert.ok(e.ts, `${f}: событие без времени ломает сортировку журнала`)
    assert.match(e.ts, /Z$/, `${f}: ts=${e.ts} — не UTC`)
    assert.equal(new Date(e.ts).toISOString(), e.ts, `${f}: ts не канонический ISO`)
    assert.ok(f.startsWith(e.ts.replace(/[:.]/g, '-')), `${f}: штамп имени не совпадает с ts`)
  }
})

test('И-6: журнал сортируется сравнением строк — все ts сравнимы как строки', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  for (const ts of ['2026-09-30T09:00:00.000Z', '2026-09-30T08:00:00.000Z', '2026-09-30T10:30:00.000Z']) {
    writeEvent(p.root, { ts, change: p.change, ticket: 'T-001', stage: 'dev', event: 'finished' })
  }
  const got = listEvents(p.root, { change: p.change }).map((e) => e.ts)
  const sortedByTime = [...got].sort((a, b) => Date.parse(a) - Date.parse(b))
  assert.deepEqual(got, sortedByTime, 'лексикографический порядок обязан совпадать с хронологическим')
})

// ── И-7. Событие без привязки к тикету — дыра, а не норма ────────────────────

test('И-7: record без --ticket отвергается — дыру движок не создаёт сам', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const before = p.eventFiles()
  const r = p.ev('record', '--stage', 'dev', '--event', 'finished', '--actor', 'test')

  assert.equal(r.status, 1, `прежде это молча писало unknown и выходило нулём: ${r.stdout}`)
  assert.match(r.stderr, /нужен --ticket/)
  assert.match(r.stderr, /--ticket MR/, 'стадия уровня поставки должна быть названа тут же')
  assert.deepEqual(p.eventFiles(), before, 'события быть не должно вовсе')
})

test('И-7: поставочный тикет MR — законная привязка, а не дыра', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.ev('record', '--ticket', 'MR', '--stage', 'review', '--event', 'started', '--actor', 'human')
  assert.equal(r.status, 0, r.stderr)
  const d = p.evJson('doctor')
  assert.deepEqual(d.json.unknown, [], 'MR привязан — дырой он не считается')
  // На доску MR не попадает: задачи с таким номером не существует.
  const board = computeBoard(p.root, p.change)
  assert.deepEqual(board.tasks.map((x) => x.id), ['T-001'])
  assert.equal(board.slots_used, 0, 'ворота поставки слот задачи не занимают')
})

test('И-7: событие с ticket: unknown в журнале — дыра, и doctor её называет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Такое событие остаётся возможным только через путь `hook` (см. тест ниже).
  const f = basename(writeEvent(p.root, {
    ts: new Date().toISOString(), change: p.change, ticket: 'unknown',
    stage: 'dev', event: 'finished',
  }))
  const e = JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8'))
  assert.equal(e.ticket, 'unknown', 'выдумывать тикет движок не вправе')

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.unknown, [f], 'непривязанный ФИНИШ — дыра в журнале')
  assert.equal(d.json.ok, false, 'дыра обязана быть громкой, иначе метрике нельзя верить')
})

test('И-7: хук без маркера пишет unknown и кричит exit 2', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const payload = JSON.stringify({
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStop',
    cwd: p.root,
    session_id: 'нет-такой-сессии',
    last_assistant_message: 'готово',
  })
  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: payload })
  assert.equal(r.status, 2, `хук обязан выйти 2 на событии без привязки: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /БЕЗ тикета/)
  const f = p.eventFiles().find((x) => /unknown-dev-finished/.test(x))
  assert.ok(f, 'событие всё равно должно быть записано: дыру надо видеть, а не терять')
})

test('И-7: привязанный старт дырой не считается (ложная тревога на каждом прогоне недопустима)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Старт без тикета, но с agent_id, пара которого ещё не пришла: стадия ИДЁТ.
  writeEvent(p.root, {
    ts: new Date().toISOString(), change: p.change, ticket: 'unknown',
    stage: 'dev', event: 'started', agent_id: 'live-1',
  })
  const d = p.evJson('doctor')
  assert.deepEqual(d.json.unknown, [], 'идущая стадия — не дыра')
  assert.equal(d.json.pending_binding.length, 1, 'но показать её отдельно обязан')
  assert.equal(d.json.ok, true)
})

test('И-7: тикет-заглушка T-XXX из шаблонов не считается привязкой', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeFileSync(join(p.eventsPath, 'x.json'), JSON.stringify({
    ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-XXX',
    stage: 'dev', event: 'finished', agent_id: 'a1',
  }))
  const events = listEvents(p.root, { change: p.change })
  assert.equal(events.length, 1)
  // Привязки нет: ни по agent_id, ни по транскрипту её восстановить не из чего,
  // поэтому заглушка должна остаться заглушкой, а не стать «задачей T-XXX».
  const board = computeBoard(p.root, p.change)
  assert.equal(board.tasks.find((x) => x.id === 'T-001').status, 'ready')
  assert.equal(readdirSync(p.tasksPath).length, 1, 'задачи T-XXX не существует')
})

// ── И-5. Время события — время того, что произошло (флаг --ts) ────────────────

test('И-5: record --ts кладёт в событие названное время, а не время записи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.evJson('record', '--ticket', 'T-001', '--stage', 'demo', '--event', 'finished',
    '--actor', 'human', '--ts', '2026-09-30T19:30:00+03:00', '--notes', 'ворота закрыли вчера')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.json.event.ts, '2026-09-30T16:30:00.000Z', 'смещение приводится к UTC (И-6)')

  const f = p.eventFiles().find((x) => /T-001-demo-finished/.test(x))
  const e = JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8'))
  assert.equal(e.ts, '2026-09-30T16:30:00.000Z')
  assert.match(e.ts, /Z$/)
  assert.ok(Math.abs(Date.now() - Date.parse(e.ts)) > 3600000, 'время записи и время события разошлись')
})

test('И-5: неразбираемое --ts отвергается, а не превращается в «сейчас»', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const before = p.eventFiles()
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'dev', '--event', 'finished', '--ts', 'вчера вечером')
  assert.equal(r.status, 1, 'догадка о времени хуже отказа')
  assert.match(r.stderr, /не разбирается как время/)
  assert.deepEqual(p.eventFiles(), before)
})

test('И-5: abandon --ts принимает время обрыва и отвергает время до старта стадии', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, {
    ts: '2026-09-30T20:00:00.000Z', change: p.change, ticket: 'T-001', stage: 'dev', event: 'started',
  })

  const tooEarly = p.ev('abandon', '--ticket', 'T-001', '--stage', 'dev', '--ts', '2026-09-30T19:00:00Z')
  assert.equal(tooEarly.status, 1, 'стадия не могла оборваться до старта')
  assert.match(tooEarly.stderr, /раньше начала стадии/)
  assert.equal(p.eventFiles().filter((f) => /abandoned/.test(f)).length, 0)

  const ok = p.evJson('abandon', '--ticket', 'T-001', '--stage', 'dev', '--ts', '2026-09-30T22:15:00Z')
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(ok.json.event.ts, '2026-09-30T22:15:00.000Z')
  assert.equal(ok.json.started_at, '2026-09-30T20:00:00.000Z')
})

// ── И-2/И-3: журнал обязан переживать уборку, а неудача этого — быть слышной ───
//
// `writeEvent` кладёт файл события в индекс git, и это не удобство: неотслеживаемый файл
// сносит `git clean -fd` на шаге уборки (на обкатке 22.09.2026 из тринадцати событий
// уцелело одно). Значит неудача `git add` возвращает событие ровно в то состояние, от
// которого эта строка защищает. Прежде она глушилась, и видно было только следствие:
// событий нет, а `doctor` не отличает «стадия не записала» от «стадия не запускалась».
//
// Неудачу делаем настоящей, без подмены модулей: каталог вне git-репозитория — `git add`
// там отказывает сам. Запись при этом обязана состояться: журнал важнее удачи с git.
function writeEventIn(dir) {
  const lib = new URL('../scripts/lib/firm.mjs', import.meta.url).href
  const code =
    `import { writeEvent } from ${JSON.stringify(lib)}\n` +
    `const p = writeEvent(${JSON.stringify(dir)}, { ts: '2026-09-30T12:00:00.000Z', ` +
    `change: 'ch', ticket: 'T-001', stage: 'dev', event: 'started', actor: 'test' })\n` +
    'process.stdout.write(p)\n'
  return spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 })
}

test('И-2: событие записано даже вне git-репозитория, но неудача git add названа вслух', (t) => {
  const dir = plainDir(t)
  const r = writeEventIn(dir)

  assert.equal(r.status, 0, `запись не должна падать из-за git: ${r.stderr}`)
  const path = r.stdout.trim()
  assert.ok(path, 'writeEvent обязан вернуть путь')
  assert.equal(path, join(dir, '.firm', 'events', '2026-09-30T12-00-00-000Z-T-001-dev-started.json'))
  assert.ok(existsSync(path), 'файл события обязан лежать на диске')
  const e = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(e.ts, '2026-09-30T12:00:00.000Z')
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.stage, 'dev')
  assert.equal(e.event, 'started')

  // И главное: молчания быть не должно.
  assert.match(r.stderr, /НЕ попало в индекс git/)
  assert.ok(r.stderr.includes(path), 'в предупреждении обязан быть путь файла под угрозой')
  assert.match(r.stderr, /git clean -fd/, 'надо назвать, чем именно грозит неотслеживаемый файл')
  assert.match(r.stderr, /причина:/, 'причина отказа git — тоже часть вопроса')
  assert.ok(
    r.stderr.includes(`git -C ${dir} add -- ${path}`),
    `к предупреждению обязана прилагаться готовая команда:\n${r.stderr}`,
  )
})

test('И-2: в нормальном репозитории запись тиха и событие уходит в индекс', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = writeEventIn(p.root)

  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr, '', `предупреждение не должно появляться на ровном месте: ${r.stderr}`)
  const staged = p.git('diff', '--cached', '--name-only').trim().split('\n')
  assert.ok(
    staged.some((f) => f.endsWith('2026-09-30T12-00-00-000Z-T-001-dev-started.json')),
    `событие обязано попасть в индекс: ${staged.join(', ')}`,
  )
})

// ── И-7/H: ветка рабочего каталога — запасной путь только для ФИНИША ──────────
//
// На `SubagentStart` маркера в промпте ещё нет и собственного транскрипта тоже, поэтому
// последним запасным путём оставалась ветка рабочего каталога. Если cwd сессии стоит в
// дереве ЧУЖОЙ задачи, события приписываются ей: на проект-В 02.10.2026 QA-панель по T-016
// записала три `review/started` на T-023.
//
// Запасной путь тут хуже своего отсутствия. Без него старт ушёл бы как `unknown` — дыра,
// про которую `doctor` говорит прямо и которую на финише закрывает привязка по `agent_id`.
// С ним получается неправда, которую `doctor` не ловит вовсе.
function hook(p, payload) {
  return p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })
}

function foreignWorktree(p, ticket) {
  const wt = p.sibling(ticket)
  p.git('worktree', 'add', '-q', '-B', `task/${ticket}`, wt, `feature/${p.change}`)
  return wt
}

test('И-7: SubagentStart из дерева ЧУЖОЙ задачи даёт unknown, а не тикет этой ветки', (t) => {
  const p = makeProject(t, { tasks: ['T-016', 'T-023'] })
  const wt = foreignWorktree(p, 'T-023')

  const r = hook(p, {
    agent_type: 'firm2:firm-reviewer-qa',
    hook_event_name: 'SubagentStart',
    cwd: wt, // сессия осталась в дереве T-023 после ручного слияния
    agent_id: 'qa-1',
    session_id: 'нет-такой-сессии',
  })
  assert.equal(r.status, 0, `непривязанный старт с agent_id — штатный путь: ${r.stderr}`)

  const files = p.eventFiles()
  assert.equal(files.length, 1, `событий должно быть одно: ${files.join(', ')}`)
  const e = JSON.parse(readFileSync(join(p.eventsPath, files[0]), 'utf8'))
  assert.equal(e.ticket, 'unknown',
    'дыра лечится привязкой по agent_id на финише, а ложь не лечится ничем')
  assert.equal(e.stage, 'review')
  assert.ok(/unknown-review-started/.test(files[0]), `имя файла: ${files[0]}`)

  // И доска не отдаёт эту стадию чужой задаче.
  const board = computeBoard(p.root, p.change)
  assert.equal(board.tasks.find((x) => x.id === 'T-023').status, 'ready')
  assert.equal(board.tasks.find((x) => x.id === 'T-016').status, 'ready')
})

test('И-7: маркер в промпте сильнее — запасной путь не сломал главный', (t) => {
  const p = makeProject(t, { tasks: ['T-016', 'T-023'] })
  const wt = foreignWorktree(p, 'T-023')

  const r = hook(p, {
    agent_type: 'firm2:firm-reviewer-qa',
    hook_event_name: 'SubagentStart',
    cwd: wt,
    agent_id: 'qa-1',
    prompt: 'FIRM2-TICKET: T-016\nFIRM2-CHANGE: ch\nFIRM2-ATTEMPT: 2\nПроверь задачу.',
  })
  assert.equal(r.status, 0, r.stderr)

  const e = JSON.parse(readFileSync(join(p.eventsPath, p.eventFiles()[0]), 'utf8'))
  assert.equal(e.ticket, 'T-016', 'тикет берётся из маркера, а не из ветки каталога')
  assert.equal(e.attempt, 2)
  assert.equal(computeBoard(p.root, p.change).tasks.find((x) => x.id === 'T-016').status, 'in_review')
})

test('И-7: на ФИНИШЕ ветка рабочего каталога остаётся честным источником', (t) => {
  const p = makeProject(t, { tasks: ['T-016', 'T-023'] })
  const wt = foreignWorktree(p, 'T-023')

  const r = hook(p, {
    agent_type: 'firm2:firm-developer',
    hook_event_name: 'SubagentStop',
    cwd: wt,
    agent_id: 'dev-1',
    last_assistant_message: 'готово',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)

  const e = JSON.parse(readFileSync(join(p.eventsPath, p.eventFiles()[0]), 'utf8'))
  assert.equal(e.ticket, 'T-023', 'дерево задачи на финише действительно её собственное')
  assert.equal(e.stage, 'dev')
  assert.equal(e.event, 'finished')
})

// ── Словарь стадий проверяется в момент записи ───────────────────────────────
//
// Разбор стадии Технического писателя 22.10.2026. `record` принимал ЛЮБОЕ имя стадии, и
// 12.10.2026 в журнал проект-В уехало событие стадии `gate` (T-095), которой в словаре
// движка тогда не было: на дашборде его не видно, а журнал неизменяем — событие осталось
// таким навсегда. Словарь, не проверяемый на записи, отстаёт от жизни молча; здесь это
// уже случалось с `adjudicate`, `design` и `docs`.
test('стадия вне словаря отклоняется на записи, и отказ называет словарь', (t) => {
  const p = makeProject(t)
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'achive', '--event', 'finished', '--actor', 'test')
  assert.equal(r.status, 1, 'опечатка в имени стадии обязана не доехать до журнала')
  assert.match(r.stderr, /achive/)
  assert.match(r.stderr, /dev, test, review/, 'отказ без словаря не говорит, чем его исправить')
  assert.match(r.stderr, /STAGES/, 'и называет, где словарь правится, если стадия новая')
})

test('стадия ворот внутри задачи записывается: словарь догнал жизнь, а не наоборот', (t) => {
  const p = makeProject(t)
  const r = p.ev('record', '--ticket', 'T-001', '--stage', 'gate', '--event', 'finished', '--actor', 'human')
  assert.equal(r.status, 0, r.stderr)
})

test('роль архива и роль прототипа названы стадиями: иначе их событий не будет вовсе', () => {
  // Замер 22.10.2026 по четырём живым журналам: 0 событий docs/* и design/* на 2 511
  // событий при 213 закрытых поставках. Хук молча выходит на роли, которой нет в таблице,
  // поэтому дыра выглядела как «стадия не шла».
  const src = readFileSync(join(SCRIPTS, 'firm-event.mjs'), 'utf8')
  assert.match(src, /'firm2:firm-docwriter': 'docs'/)
  assert.match(src, /'firm2:firm-designer': 'design'/)
})

// Вердикт MR-ревью: стадия поставки закрывается хуком без вердикта, потому что схемы у
// неё нет (дефект P, замер по проект-В: семь событий с пустыми notes за шесть поставок).
// Сеть под этим — поле сверки; красить ok оно не должно, иначе прошлые поставки на
// неизменяемом журнале краснели бы навсегда.
test('MR-ревью, закрытое без вердикта, названо сверкой и не красит ok', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'MR', '--change', p.change, '--stage', 'review', '--event', 'finished', '--actor', 'hook')
  let d = p.evJson('doctor').json
  assert.equal(d.ok, true, JSON.stringify(d.mr_review_without_verdict))
  assert.equal(d.mr_review_without_verdict.length, 1)
  assert.match(d.mr_review_without_verdict[0], /вердикта нет/)
  // Записали вердикт — вопрос снят.
  p.ev('record', '--ticket', 'MR', '--change', p.change, '--stage', 'review', '--event', 'accepted',
    '--actor', 'orchestrator', '--notes', 'принято: дифф поставки сошёлся со спеками')
  d = p.evJson('doctor').json
  assert.deepEqual(d.mr_review_without_verdict, [])
})

test('задачное ревью без вердикта в это поле не попадает: там вердикт даёт схема', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.ev('record', '--ticket', 'T-001', '--change', p.change, '--stage', 'review', '--event', 'finished', '--actor', 'hook')
  const d = p.evJson('doctor').json
  assert.deepEqual(d.mr_review_without_verdict, [])
})
