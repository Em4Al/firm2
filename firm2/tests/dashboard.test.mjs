// Дашборд — ПРОЕКЦИЯ, и проверяется он как проекция: что показано и чего не показано.
//
// Главное здесь — дефект 02.10.2026, найденный на живом проекте. Снимок делается НА
// СОБЫТИИ, а последнее событие после смены стадии — всегда `dev/started`, у которого тикета
// в тот момент ещё нет: маркер читается из транскрипта субагента, а файл транскрипта рантайм
// создаёт мгновением позже. Снимок, сделанный ровно тогда, показывал «в работе никого» — и
// оставался таким до конца стадии, десятки минут. Человек открывает доску сразу после смены
// задачи и видит пустоту, хотя работа идёт.
//
// Признак «идёт работа» берётся не из журнала, а из репозитория — живое рабочее дерево
// `task/T-XXX`, — и это не второй судья над статусом (статус по-прежнему из журнала,
// ADR-0001), а ответ на отдельный вопрос: «идёт ли работа прямо сейчас».
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDashboard } from '../scripts/dashboard.mjs'
import { writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, brokenGitDir } from './helpers.mjs'

const html = (p) => readFileSync(buildDashboard(p.root, p.change), 'utf8')

// Рабочее дерево задачи лежит ВНЕ репозитория (§9).
function addWorktree(p, ticket) {
  const path = p.sibling(ticket)
  p.git('worktree', 'add', '-q', '-B', `task/${ticket}`, path, `feature/${p.change}`)
  return path
}

function writeTask(p, id, { status = 'todo', deps = [], parallelSafe = null, ui = null, labels = [] } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\n` +
      (deps.length ? `depends_on: [${deps.join(', ')}]\n` : '') +
      (parallelSafe === null ? '' : `parallel_safe: ${parallelSafe}\n`) +
      (ui === null ? '' : `ui: ${ui}\n`) +
      (labels.length ? `labels: [${labels.join(', ')}]\n` : '') +
      '---\n\nПроверочная задача.\n\n- [ ] критерий один\n',
  )
}

const WORKING_CHIP = '<span class="chip">идёт работа</span>'
const TREES_LINE = /Прямо сейчас есть рабочие деревья задач/

test('И-12: задача с живым рабочим деревом и без событий помечена «идёт работа»', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')

  const h = html(p)
  assert.ok(h.includes(WORKING_CHIP), 'в таблице статусов обязан быть чип')
  assert.match(h, /· идёт работа/, 'и приписка на карточке графа')
  assert.match(h, TREES_LINE, 'молчать нельзя: пустая доска читается как «прогон встал» (ADR-0007)')
  assert.match(h, /T-001/)
  // Статус НЕ подменён: он по-прежнему из журнала (ADR-0001), дерево отвечает на другой
  // вопрос. Иначе доска стала бы вторым судьёй над статусом.
  assert.match(h, /Снимок сделан во время идущей стадии/)
  assert.match(h, /dashboard\.mjs|firm-dashboard/, 'надо сказать, чем пересобрать')
})

test('И-12: без живого рабочего дерева — ни пометки, ни баннера', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const h = html(p)
  assert.equal(h.includes(WORKING_CHIP), false, 'пометка берётся из дерева, а не из воздуха')
  assert.doesNotMatch(h, TREES_LINE)
  assert.doesNotMatch(h, /Снимок сделан во время идущей стадии/)
})

test('И-1: влитая задача с живым деревом НЕ помечается — журнал знает точнее', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, {
    ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'finished', actor: 'test',
  })
  addWorktree(p, 'T-001') // дерево просто не убрали шагом уборки

  const h = html(p)
  assert.match(h, /Влита|влита/, 'сцена: журнал считает задачу влитой')
  assert.equal(h.includes(WORKING_CHIP), false,
    'иначе влитые задачи висели бы «в работе» до ручной уборки деревьев')
  assert.doesNotMatch(h, TREES_LINE, 'и про такое дерево говорить нечего')
})

test('И-12: git не ответил (inFlightTickets → null) — дашборд не выдумывает пометок', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')
  // Отказ git подделываем тем же приёмом, что в inflight.test.mjs: подставным `git`,
  // который всегда отвечает 128. Переменной `GIT_DIR` этого больше не сделать — движок
  // снимает её на входе (отчёт проект-В 03.11.2026, находка 1). `null` — честное «не знаю»,
  // и из него не следует ни «идёт работа», ни «не идёт».
  const r = p.cli('dashboard.mjs', [p.change], {
    env: { PATH: `${brokenGitDir(t)}:${process.env.PATH}` },
  })
  assert.equal(r.status, 0, `сборка не смеет падать: ${r.stdout}${r.stderr}`)
  const h = readFileSync(join(p.root, '.firm', 'dashboard.html'), 'utf8')
  assert.equal(h.includes(WORKING_CHIP), false, 'не знаем — не говорим')
  assert.doesNotMatch(h, TREES_LINE)
})

test('И-12: непривязанный старт в журнале назван в баннере', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Ровно то событие, из-за которого всё и затевалось: стадия началась, транскрипта ещё нет.
  writeEvent(p.root, {
    ts: new Date().toISOString(), change: p.change, ticket: 'unknown',
    stage: 'dev', event: 'started', actor: 'hook', agent_id: 'a1',
  })

  const h = html(p)
  assert.match(h, /Снимок сделан во время идущей стадии/)
  assert.match(h, /Непривязанных стартов в журнале: <b>1<\/b>/)
  assert.match(h, /Привязка достроится сама на финише/,
    'это нормальное свойство момента, и так и надо сказать — иначе читается как дефект')
  // Дерева нет, значит и строки про деревья быть не должно: два повода независимы.
  assert.doesNotMatch(h, TREES_LINE)
})

// Граф растёт ВНИЗ, и ось Y — ВОЛНА прогона, а не глубина зависимостей (просьба
// 30.10.2026: «логика планировщика никак не отражена на дереве задач»). Проверки держат
// обе стороны: строка не шире потолка parallelism, и задачи в работе стоят на одной
// горизонтали — иначе на вопрос «почему взяты эти» доска опять не отвечает.
const viewBox = (h) => {
  const m = h.match(/viewBox="0 0 (\d+) (\d+)"/)
  assert.ok(m, 'в графе должен быть viewBox')
  return { w: Number(m[1]), h: Number(m[2]) }
}

const rowCaps = (h) => (h.match(/class="rowcap[^"]*">([^<]*)</g) || [])
  .map((x) => x.replace(/.*">/, '').replace(/<$/, ''))

// Карточки одной горизонтали: y в transform карточки.
const rowOf = (h, id) => {
  const m = h.match(new RegExp(`id="box-${id}" class="box" data-id="${id}" transform="translate\\((\\d+),(\\d+)\\)"`))
  assert.ok(m, `карточки ${id} в графе нет`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

test('граф: строка — волна, и шире потолка parallelism она не растёт', (t) => {
  const few = makeProject(t, { tasks: [] })
  for (const id of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006']) {
    writeTask(few, id, { parallelSafe: true })
  }
  const many = makeProject(t, { tasks: [] })
  for (let i = 1; i <= 10; i += 1) {
    writeTask(many, `T-0${String(i).padStart(2, '0')}`, { parallelSafe: true })
  }
  const a = viewBox(html(few)), b = viewBox(html(many))

  assert.equal(a.w, b.w, 'десять независимых задач не смеют быть шире шести: волна по трое')
  assert.ok(a.w <= 900, `ширина графа должна влезать в колонку страницы, а не ${a.w}`)
  assert.ok(b.h > a.h, 'расти граф обязан вниз — лишние задачи это новые волны')
  assert.deepEqual(rowCaps(html(few)).slice(0, 2), [
    'волна 1 · пойдёт первой: зависимости закрыты', 'волна 2',
  ], 'подпись строки обязана называть волну: без неё карточки опять читаются как глубина')
})

test('граф: цепочка зависимостей растёт вниз, а не вправо', (t) => {
  const p = makeProject(t, { tasks: [] })
  for (const [i, id] of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005'].entries()) {
    writeTask(p, id, { deps: i ? [`T-00${i}`] : [], parallelSafe: true })
  }
  const chain = viewBox(html(p))

  const flat = makeProject(t, { tasks: [] })
  for (const id of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005']) writeTask(flat, id, { parallelSafe: true })
  const wide = viewBox(html(flat))

  assert.ok(chain.w < wide.w, 'цепочка — один столбец: каждая задача ждёт предыдущую')
  assert.ok(chain.h > wide.h, 'пять волн по одной задаче — это пять строк')
})

test('граф: задачи в работе стоят на одной горизонтали, а свободный слот нарисован', (t) => {
  const p = makeProject(t, { tasks: [] })
  for (const id of ['T-001', 'T-002', 'T-003', 'T-004']) writeTask(p, id, { parallelSafe: true })
  // Две задачи в работе (разные стадии), третий слот пуст — ровно состояние проект-В
  // 30.10.2026, с которого пришла просьба.
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:10:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'test', event: 'started', actor: 'test',
  })

  const h = html(p)
  assert.equal(rowOf(h, 'T-001').y, rowOf(h, 'T-002').y,
    'задачи, которые идут вместе, обязаны стоять на одной линии — это и есть вопрос')
  assert.notEqual(rowOf(h, 'T-003').y, rowOf(h, 'T-001').y, 'не взятые в работу — ниже, следующей волной')
  const caps = rowCaps(h)
  assert.ok(caps.some((c) => c === 'идёт сейчас · занято 2 из 3 слотов'),
    `подпись текущей волны обязана называть занятые слоты, а есть ${JSON.stringify(caps)}`)
  assert.match(h, /слот свободен/,
    'пустой слот при готовых задачах — главная статья календарного расхода, и его надо видеть')
})

test('граф: исключительная задача занимает волну одна, и причина названа', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { parallelSafe: true })
  writeFileSync(
    join(p.tasksPath, 'T-002.md'),
    '---\nid: T-002\ntitle: T-002\nstatus: todo\nparallel_safe: false\n' +
      'exclusive_why: правит общий конфиг\n---\n\nЗадача.\n\n- [ ] критерий\n',
  )
  const caps = rowCaps(html(p))
  assert.ok(caps.some((c) => /T-002 идёт одна: правит общий конфиг/.test(c)),
    `волна исключительной задачи обязана называть причину, а есть ${JSON.stringify(caps)}`)
})

test('граф: заблокированное и снятое — вне плана, и зависимые от них не уезжают в волны', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { parallelSafe: true })
  writeTask(p, 'T-002', { deps: ['T-001'], parallelSafe: true })
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'review', event: 'escalated', actor: 'test',
  })

  const caps = rowCaps(html(p))
  assert.ok(caps.some((c) => /вне плана прогона/.test(c) && /1 заблокировано/.test(c)),
    `заблокированная задача не в волне: ${JSON.stringify(caps)}`)
  assert.ok(caps.some((c) => /ждут снятого или заблокированного/.test(c)),
    'зависимая от заблокированной не пойдёт ни в одну волну — и сказать об этом надо')
  assert.ok(!caps.some((c) => /^волна/.test(c)), 'волн здесь нет вовсе: идти нечему')
})

test('почему в работе эти: основание, ∥ и слот названы по фактам задачи', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { parallelSafe: true })
  writeTask(p, 'T-002', { deps: ['T-001'], parallelSafe: true })
  writeTask(p, 'T-003', { parallelSafe: true })
  merged(p, 'T-001')
  writeEvent(p.root, {
    ts: '2026-09-30T11:00:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'dev', event: 'started', actor: 'test',
  })

  const h = html(p)
  const why = (h.match(/<div class="why">([\s\S]*?)<\/div>/) || [])[1] || ''
  assert.ok(why, 'блока «почему в работе именно эти» нет')
  assert.match(why, /T-002/)
  assert.match(why, /T-001 влита/, 'основание задачи — её закрытые зависимости, названные по именам')
  assert.match(why, /∥ можно вести вместе/)
  assert.match(why, /Готовы и ждут: <b>T-003<\/b>/,
    'почему НЕ взята — половина того же вопроса, и она про готовые задачи')
  assert.match(why, /parallelism — 3/, 'потолок — третье условие правила, и его надо назвать')
})

test('граф: у каждого ребра есть data-from/data-to и парная копия для попадания мышью', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002', { deps: ['T-001'] })

  const h = html(p)
  const attrs = 'data-from="T-001" data-to="T-002"'
  const paths = h.match(new RegExp(`<path [^>]*${attrs}[^>]*/>`, 'g')) || []
  assert.equal(paths.length, 2, `ребро рисуется двумя путями, а найдено ${paths.length}`)
  assert.equal(paths.filter((s) => s.includes('class="hit"')).length, 1,
    'щёлкнуть по линии толщиной 1.5 пикселя мышью нельзя — нужна невидимая толстая копия')
  assert.equal(paths.filter((s) => s.includes('class="edge"')).length, 1, 'и сама видимая линия')
  // Копия обязана лежать на том же пути, иначе мышь ловит не ту связь.
  const d = (s) => (s.match(/ d="([^"]+)"/) || [])[1]
  assert.equal(d(paths[0]), d(paths[1]), 'оба пути — одна и та же кривая')
  // Обработчик щелчка ищет ровно эти атрибуты; потерянная кликабельность молчалива.
  assert.match(h, /path\.hit/, 'в скрипте должен быть разбор щелчка по ребру')
  assert.match(h, /data-from/)
})

// Остальные блоки правкой не тронуты, и это утверждение проверяемо: проекция обязана
// остаться полной. Так дешевле всего заметить, что «косметическая» правка графа увезла
// с собой таблицу.
test('дашборд остался полным: статусы, тайминг, ворота, модели, события', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, {
    ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })
  const h = html(p)
  for (const block of ['Тайминг', 'Ворота поставки', 'Расход по моделям', 'Ошибки по источнику', 'Последние события']) {
    assert.ok(h.includes(block), `блок «${block}» пропал из дашборда`)
  }
  assert.match(h, /T-001/)
  assert.match(h, /слотов \d+\/\d+/, 'шапка со слотами и числом событий — тоже проекция')
})

// ── Свёртка влитого: вид, а не отбор данных ──────────────────────────────────
//
// На большой поставке (проект-В — 69 задач, 52 влитых) граф и таблица целиком состоят из
// законченного, и живую работу в них не найти. Главный инвариант правки — не «спрятать
// влитое», а «спрятать то, на что никто живой не ссылается»: иначе у живой задачи
// обрывается стрелка и «ждёт T-040» указывает в пустоту.

const merged = (p, id) =>
  writeEvent(p.root, {
    ts: '2026-09-30T10:00:00.000Z', change: p.change, ticket: id,
    stage: 'merge', event: 'finished', actor: 'test',
  })

const released = (p, id) => {
  merged(p, id)
  writeEvent(p.root, {
    ts: '2026-09-30T11:00:00.000Z', change: p.change, ticket: id,
    stage: 'release', event: 'finished', actor: 'test',
  })
}

// Видимая половина страницы: граф без атрибута `hidden` и строки таблицы без класса
// свёртки. Видов графа на странице до четырёх — по сочетанию двух галочек, — и видимый
// ровно один; `gview(h, key)` достаёт любой по ключу вида («m» — спрятано влитое,
// «o» — снятое человеком, «-» — не спрятано ничего).
const gview = (h, key) => (h.match(new RegExp(`<div class="gview" data-view="${key}"[^>]*>([\\s\\S]*?)<\\/div>`)) || [])[1] || ''
const liveGraph = (h) => (h.match(/<div class="gview" data-view="[a-z-]+">([\s\S]*?)<\/div>/) || [])[1] || ''
const allGraph = (h) => gview(h, '-')
const foldedRows = (h) => [...h.matchAll(/<tr class="folded"><td class="mono">(T-[\w.]+)</g)].map((m) => m[1])
const outRows = (h) => [...h.matchAll(/<tr class="out"><td class="mono">(T-[\w.]+)</g)].map((m) => m[1])
const rowIds = (h) => [...h.matchAll(/<tr(?: class="(?:folded|out)")?><td class="mono">(T-[\w.]+)</g)].map((m) => m[1])

test('свёртка: влитая задача, на которую никто не ссылается, уходит из живого графа', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-040')
  merged(p, 'T-040')

  const h = html(p)
  assert.deepEqual(foldedRows(h), ['T-040'])
  assert.equal(liveGraph(h).includes('data-id="T-040"'), false, 'в живом графе законченному делать нечего')
  assert.ok(liveGraph(h).includes('data-id="T-001"'), 'живая задача остаётся')
  assert.ok(allGraph(h).includes('data-id="T-040"'), 'во втором графе она на месте — её возвращает галочка')
})

test('свёртка: влитая задача, от которой зависит живая, НЕ сворачивается', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-040')
  writeTask(p, 'T-041', { deps: ['T-040'] })
  merged(p, 'T-040')

  const h = html(p)
  assert.deepEqual(foldedRows(h), [],
    'спрятать основание живой задачи значит оборвать ей стрелку и указать «ждёт T-040» в пустоту')
  // Сворачивать нечего — значит и вид прежний: один граф, никакой галочки.
  assert.equal((h.match(/<svg class="graph"/g) || []).length, 1)
  assert.equal(h.includes('id="fold"'), false)
  assert.match(h, /data-from="T-040" data-to="T-041"/, 'связь нарисована')
})

test('свёртка: не влитые задачи не сворачиваются влитой галочкой ни при каком статусе', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002')
  writeTask(p, 'T-003')
  writeTask(p, 'T-050')
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'review', event: 'accepted', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'review', event: 'escalated', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-003',
    stage: 'lifecycle', event: 'cancelled', actor: 'test',
  })
  merged(p, 'T-050') // чтобы галочка вообще появилась

  const h = html(p)
  assert.deepEqual(foldedRows(h), ['T-050'],
    'принятая и заблокированная — не влитые: их судьба ещё решается')
  // Отменённая прячется ВТОРОЙ галочкой, а не этой: её судьба как раз решена человеком.
  assert.deepEqual(outRows(h), ['T-003'])
  for (const id of ['T-001', 'T-002']) {
    assert.ok(liveGraph(h).includes(`data-id="${id}"`), `${id} обязана остаться в живом графе`)
  }
  assert.ok(gview(h, 'm').includes('data-id="T-003"'),
    'в виде, где снятое показано, отменённая на месте')
})

test('свёртка: released сворачивается наравне с merged', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-040')
  released(p, 'T-040')

  const h = html(p)
  assert.deepEqual(foldedRows(h), ['T-040'], 'выпущенная закончена не меньше влитой')
})

test('свёртка: сворачивать нечего — дашборд не меняется вовсе', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002', { deps: ['T-001'] })

  const h = html(p)
  assert.equal((h.match(/<svg class="graph"/g) || []).length, 1, 'второй граф на маленькой поставке лишний')
  assert.equal(h.includes('id="fold"'), false, 'и галочка, которая ничего не прячет, тоже')
  assert.equal(h.includes('class="gview'), false)
})

test('свёртка: есть что прятать — два графа и галочка с правильным склонением', (t) => {
  const one = makeProject(t, { tasks: [] })
  writeTask(one, 'T-001')
  writeTask(one, 'T-040')
  merged(one, 'T-040')
  const h1 = html(one)
  assert.equal((h1.match(/<svg class="graph"/g) || []).length, 2, 'живой и полный')
  assert.match(h1, /id="fold" checked/, 'по умолчанию свёрнуто — ради этого всё и затевалось')
  assert.match(h1, /— 1 задача</)

  const few = makeProject(t, { tasks: [] })
  writeTask(few, 'T-001')
  for (const id of ['T-040', 'T-041', 'T-042']) {
    writeTask(few, id)
    merged(few, id)
  }
  assert.match(html(few), /— 3 задачи</)

  const many = makeProject(t, { tasks: [] })
  writeTask(many, 'T-001')
  for (let i = 40; i < 45; i++) {
    writeTask(many, `T-0${i}`)
    merged(many, `T-0${i}`)
  }
  assert.match(html(many), /— 5 задач</)
})

test('свёртка: строки таблицы спрятаны классом, а не удалены (ADR-0001)', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-040')
  merged(p, 'T-040')

  const h = html(p)
  assert.deepEqual(rowIds(h).sort(), ['T-001', 'T-040'],
    'доска только на чтение: спрятанное обязано доставаться галочкой, а не исчезать из файла')
  assert.match(h, /tr\.folded,tr\.out\{display:none\}/, 'прячет CSS')
  assert.match(h, /body\.show-all tr\.folded\{display:table-row\}/, 'и он же возвращает')
})

// ── Вторая свёртка: снятое решением человека ────────────────────────────────────────
//
// Повод — просьба человека 30.10.2026: «задачи superseded показаны в конце, они по сути
// выброшены и вместо них взяты другие, и теперь мешают». Решение то же, что у влитого:
// прячем по умолчанию, но не удаляем — доска только на чтение (ADR-0001), и спрятанное
// обязано доставаться галочкой.

const superseded = (p, id) =>
  writeEvent(p.root, {
    ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: id,
    stage: 'lifecycle', event: 'superseded', actor: 'human',
  })

test('снятое человеком спрятано по умолчанию, но лежит в файле и в своём виде графа', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-178')
  superseded(p, 'T-178')

  const h = html(p)
  assert.match(h, /id="fold-out" checked/, 'галочка стоит — значит по умолчанию спрятано')
  assert.match(h, /— 1 задача</, 'склонение и счёт названы')
  assert.deepEqual(outRows(h), ['T-178'], 'строка таблицы спрятана классом')
  assert.deepEqual([...new Set(rowIds(h))].sort(), ['T-001', 'T-178'], 'из файла она не исчезла')
  assert.equal(liveGraph(h).includes('data-id="T-178"'), false, 'в видимом графе её нет')
  assert.ok(allGraph(h).includes('data-id="T-178"'), 'а в виде «показать всё» — есть')
  assert.match(h, /body\.show-out tr\.out\{display:table-row\}/, 'возвращает её CSS по галочке')
})

test('отменённая прячется той же галочкой, что и заменённая', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002')
  writeEvent(p.root, {
    ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'lifecycle', event: 'cancelled', actor: 'human',
  })

  const h = html(p)
  assert.deepEqual(outRows(h), ['T-002'],
    'отмена и замена — одно решение человека: задача выброшена и в план не вернётся')
})

test('две свёртки независимы: четыре вида графа и четыре ключа', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-040')
  writeTask(p, 'T-178')
  merged(p, 'T-040')
  superseded(p, 'T-178')

  const h = html(p)
  assert.equal((h.match(/<svg class="graph"/g) || []).length, 4,
    'по виду на сочетание: ничего не спрятано, спрятано влитое, спрятано снятое, спрятано и то и то')
  for (const key of ['-', 'm', 'o', 'mo']) {
    assert.ok(h.includes(`data-view="${key}"`), `вид ${key} обязан быть в файле`)
  }
  // Видимый по умолчанию — тот, где спрятано и влитое, и снятое.
  assert.match(h, /<div class="gview" data-view="mo">/, 'он единственный без атрибута hidden')
  assert.equal(gview(h, 'mo').includes('data-id="T-040"'), false)
  assert.equal(gview(h, 'mo').includes('data-id="T-178"'), false)
  assert.ok(gview(h, 'mo').includes('data-id="T-001"'), 'живая задача видна в любом виде')
  assert.ok(gview(h, 'm').includes('data-id="T-178"'), 'снятое показано, влитое спрятано')
  assert.ok(gview(h, 'o').includes('data-id="T-040"'), 'и наоборот')
})

test('снимать нечего — второй галочки нет вовсе', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002', { deps: ['T-001'] })

  const h = html(p)
  assert.equal(h.includes('id="fold-out"'), false, 'галочка, которая ничего не прячет, — шум')
})

test('свёртка: щелчки по связям живут в ОБОИХ графах', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-040')
  merged(p, 'T-040')

  const h = html(p)
  assert.match(h, /querySelectorAll\('svg\.graph'\)/,
    'querySelector нашёл бы только первый граф, и во втором подсветка молча не работала бы')
  assert.match(h, /getElementById\('fold'\)/, 'и сама галочка должна что-то переключать')
})

// ── Легенда графа и разведённые флаги карточки (правка 05.10.2026) ───────────
//
// Легенда — вывод под самим SVG-графом, помеченный `<div class="legend">`. Та же разметка
// используется ещё раз выше, в сводке карточек-счётчиков («N задач · M влито…»), поэтому
// извлекаем именно нашу: она идёт сразу после закрытия `<div class="scroll">…</svg></div>`
// и перед подсказкой про щелчок по стрелке — эта пара тегов в разметке встречается ровно
// раз на один граф (в тестах граф не сворачивается, см. ниже).
const graphLegend = (h) => (h.match(/<\/svg><\/div>([\s\S]*?)<p class="muted hint">/) || [])[1] || ''

// Карточка задачи на графе: `<g id="box-T-XXX" …>…</g>`, без вложенных `<g>`.
const boxOf = (h, id) => (h.match(new RegExp(`<g id="box-${id}"[^]*?<\\/g>`)) || [])[0] || ''
const numberLine = (box) => (box.match(/<text x="14" y="21" class="n">([^]*?)<\/text>/) || [])[1] || ''
const flagsLine = (box) => (box.match(/<text x="[^"]+" y="21" class="f"[^>]*>([^]*?)<\/text>/) || [])[1] || ''

test('легенда: только parallel_safe:true в проекте — есть «∥», нет «одна»', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { parallelSafe: true })
  writeTask(p, 'T-002', { parallelSafe: true })

  const lg = graphLegend(html(p))
  assert.match(lg, /можно вести одновременно с другими/, '∥ встречается на странице — обязана быть объяснена')
  assert.doesNotMatch(lg, /идёт в одиночку/, 'ни одной parallel_safe:false задачи нет — «одна» здесь шум')
})

test('легенда: только parallel_safe:false в проекте — есть «одна», нет «∥»', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { parallelSafe: false })
  writeTask(p, 'T-002', { parallelSafe: false })

  const lg = graphLegend(html(p))
  assert.match(lg, /идёт в одиночку/)
  assert.doesNotMatch(lg, /можно вести одновременно с другими/, 'ни одной parallel_safe:true задачи нет — ∥ не встречается')
})

test('легенда: точки статусов — только встречающиеся, и в порядке ORDER, а не в порядке задач', (t) => {
  const p = makeProject(t, { tasks: [] })
  // Порядок файлов/создания — ready, blocked, rework. ORDER же ставит их иначе:
  // blocked, rework, ready. Совпади порядок вывода с порядком создания задач —
  // мутация «статусы в порядке задач» прошла бы незамеченной.
  writeTask(p, 'T-001') // без событий и зависимостей — ready
  writeTask(p, 'T-002')
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'review', event: 'escalated', actor: 'test',
  }) // blocked
  writeTask(p, 'T-003')
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-003',
    stage: 'review', event: 'rejected', actor: 'test',
  }) // rework

  const lg = graphLegend(html(p))
  // Статусы, которых на странице нет (например «на ревью», «влита», «выпущена»,
  // «ждёт зависимости», «принята», «снята», «в разработке», «в тестах»), не называем.
  for (const absent of ['на ревью', 'влита', 'выпущена', 'ждёт зависимости', 'принята', 'снята', 'в разработке', 'в тестах']) {
    assert.doesNotMatch(lg, new RegExp(absent), `статуса «${absent}» на странице нет — упоминать его шум`)
  }
  const iBlocked = lg.indexOf('заблокирована')
  const iRework = lg.indexOf('на доработке')
  const iReady = lg.indexOf('ждёт слот')
  assert.ok(iBlocked >= 0 && iRework >= 0 && iReady >= 0, `все три статуса обязаны быть названы: ${lg}`)
  assert.ok(iBlocked < iRework && iRework < iReady,
    `порядок обязан быть ORDER (blocked, rework, ready), а не порядком создания задач (ready, blocked, rework): ${lg}`)
})

test('карточка графа: ∥ стоит у номера задачи, а UI/⚙ — в правом блоке, и не наоборот', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { parallelSafe: true, ui: true, labels: ['high-complexity'] })

  const box = boxOf(html(p), 'T-001')
  assert.ok(box, 'карточка T-001 обязана быть в графе')

  const num = numberLine(box)
  const flags = flagsLine(box)
  assert.match(num, /<tspan class="par">∥<\/tspan>/, '∥ — внутри элемента с номером задачи')
  assert.doesNotMatch(num, /UI/, 'номер задачи не смешивается с UI')
  assert.doesNotMatch(num, /⚙/, 'номер задачи не смешивается с ⚙')

  assert.doesNotMatch(flags, /∥/, '∥ ушёл из правого блока флагов — смысл правки 05.10.2026')
  assert.match(flags, /UI/, 'UI остаётся справа')
  assert.match(flags, /⚙/, '⚙ остаётся справа')
})

test('легенда: пустой список задач не ломает сборку и не печатает ничего', (t) => {
  const p = makeProject(t, { tasks: [] })
  const h = html(p)
  assert.equal(graphLegend(h), '', 'нет задач — нет и обозначений, которые надо было бы объяснять')
})

// ── Сводка обязана складываться в итог ────────────────────────────────────────
//
// Разбор проект-В 28.10.2026. Карточек было пять — задач, влито, ждут слот, ждут
// зависимости, блок/доработка, — и ни одна не считала задачи В РАБОТЕ. На живой доске это
// читалось так: «63 задач», а дальше 12 + 11 + 37 + 0 = 60. Три задачи, которые велись
// прямо в тот момент, в сводке отсутствовали — доска молчала ровно про ту работу, ради
// которой на неё смотрят. Хуже: против одной из трёх были открыты два блокирующих бага.
//
// Поэтому «прочее» считается ОСТАТКОМ, а не перечнем статусов: статус, которому не
// досталось карточки, попадает в остаток и остаётся видимым. Исчезнуть из сводки молча
// он больше не может.
const cardsOf = (h) =>
  [...h.matchAll(/<div class="card[^"]*"><b>(\d+)<\/b><span>([^<·]+)/g)].map((m) => ({ n: Number(m[1]), label: m[2].trim() }))

// Статус задачи — производное ЖУРНАЛА, а не frontmatter (ADR-0001), поэтому стадии здесь
// открываются событиями: иначе тест проверял бы кэш, а доска показывает не его.
const started = (p, id, stage) =>
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: id,
    stage, event: 'started', actor: 'test',
  })

test('карточки сводки складываются в итог: задачи в работе не пропадают', (t) => {
  const p = makeProject(t, { tasks: [] })
  for (const id of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-008']) writeTask(p, id, { status: 'todo' })
  merged(p, 'T-001')
  started(p, 'T-002', 'dev')
  started(p, 'T-003', 'test')
  started(p, 'T-004', 'review')
  writeTask(p, 'T-005', { status: 'ready' })
  writeEvent(p.root, {
    ts: '2026-09-30T09:30:00.000Z', change: p.change, ticket: 'T-007',
    stage: 'review', event: 'rejected', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:40:00.000Z', change: p.change, ticket: 'T-008',
    stage: 'review', event: 'accepted', actor: 'test',
  })

  const h = html(p)
  const cards = cardsOf(h)
  const total = cards.find((c) => c.label === 'задач')
  assert.equal(total.n, 8)
  const work = cards.find((c) => c.label === 'в работе')
  assert.ok(work, 'карточки «в работе» нет — сводка молчит про идущую работу')
  assert.equal(work.n, 3, 'разработка, тесты и ревью — это работа, и считается она вместе')
  assert.match(h, /в разработке 1, в тестах 1, на ревью 1/, 'из чего сложились три — видно без перехода на вкладку')
  assert.ok(cards.find((c) => c.label === 'принята, не влита'), 'принятая, но не влитая — ни работа, ни результат, и своя карточка ей нужна')

  const parts = cards.filter((c) => c.label !== 'задач').reduce((a, c) => a + c.n, 0)
  assert.equal(parts, total.n, `сводка не сходится: ${parts} против ${total.n} — ${JSON.stringify(cards)}`)
})

test('статус без своей карточки попадает в «прочее», а не исчезает', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  merged(p, 'T-001')
  // Снятая задача — решение ЧЕЛОВЕКА, и живёт оно событием, а не полем в файле (И-9).
  writeTask(p, 'T-002', { status: 'todo' })
  writeEvent(p.root, {
    ts: '2026-09-30T09:50:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'lifecycle', event: 'cancelled', actor: 'human',
  })
  const cards = cardsOf(html(p))
  const other = cards.find((c) => c.label.startsWith('прочее'))
  assert.ok(other, 'снятая задача не попала никуда — это и есть дефект, который чинится остатком')
  assert.equal(other.n, 1)
  const total = cards.find((c) => c.label === 'задач').n
  assert.equal(cards.filter((c) => c.label !== 'задач').reduce((a, c) => a + c.n, 0), total)
})

test('пустых карточек сводка не показывает: ноль принятых и ноль прочего — строк нет', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  merged(p, 'T-001')
  writeTask(p, 'T-002', { status: 'ready' })
  const labels = cardsOf(html(p)).map((c) => c.label)
  assert.ok(!labels.includes('принята, не влита'), 'пустая строка на доске — шум, а не полнота')
  assert.ok(!labels.some((l) => l.startsWith('прочее')))
})

// ── Числа сводки не врут: кэш отделён от работы, ожидание названо суммой ──────
//
// Замер проект-В 28.10.2026 по поставке 2026-10-23-game-redesign: «токенов всего» 510,5M,
// из них 480,5M чтение кэша (94,1%), 26,1M запись кэша и 3,9M вывода (0,76%). То есть
// карточка показывала, сколько раз перечитан контекст, а человек читал её как «сколько
// сделано»: 94% числа — перечитывание уже посланного.
//
// Переводить кэш в «эквивалент» движок не станет: коэффициент — это ЦЕНА, разная у
// моделей и планов, а порог выражается в замеренном (ADR-0010). Поэтому обе величины
// стоят рядом, и в сводке — свежая.
test('в сводке стоят свежие токены, а кэш назван отдельно и с долей', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:10:00.000Z', change: p.change, ticket: 'T-001', stage: 'dev',
    event: 'finished', actor: 'test', model: 'claude-opus-5',
    tokens: { in: 1000, out: 4000, cache_read: 95000, cache_write: 0, total: 100000, calls: 7 },
  })
  const h = html(p)
  const card = [...h.matchAll(/<div class="card[^"]*"><b>([^<]+)<\/b><span>([^<]*)/g)]
    .find((m) => m[2].includes('свежих токенов'))
  assert.ok(card, 'карточки свежих токенов нет — сводка снова меряет перечитывание')
  assert.match(card[1], /5\.0k/, 'свежее — это вход плюс выход (1k + 4k), а не сумма с кэшем')
  assert.match(card[2], /кэш 95k \(95%\)/, 'кэш назван числом и долей: прятать его нельзя, он настоящий')
  // Метод замера расхода, закреплённый проектом, — это `out` И число вызовов. Без второго
  // свежее число отвечает «сколько написано», но не «сколько раз за это платили».
  assert.match(card[2], /7 вызовов/, 'число вызовов стоит рядом со свежим расходом')
  assert.match(h, /Числа «всего» включают кэш, и это не работа/, 'в разделе токенов сказано, что значит каждое число')
  // В таблице задач теперь ДВЕ колонки, и обе названы тем, что в них лежит.
  assert.match(h, />Свежих</, 'колонка чистого расхода — то, ради чего таблицу и читают')
  assert.match(h, />С кэшем</, 'и сумма с кэшем рядом: величина настоящая, просто про другое')
  assert.match(h, /dev 5\.0k/, 'разбивка по стадиям тоже свежая, иначе дорогой выглядит самая длинная стадия')
})

test('ожидание названо суммой по задачам, а незакрытые посчитаны отдельно', (t) => {
  // Сумма по задачам законно больше календаря: задачи идут параллельно. А у незакрытой
  // задачи конец интервала — «сейчас», то есть число растёт само, пока на него смотришь.
  // Читать такое как «столько прождали» нельзя, поэтому части названы врозь.
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  // Стадия ЗАКРЫТА, а слияния нет: ровно случай волны, которую остановили. Промежуток от
  // финиша стадии до «сейчас» и есть то ожидание, которое растёт само.
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:10:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'finished', actor: 'test',
  })
  const h = html(p)
  const card = /ожидания движка/.test(h) ? ['', ''] : null
  assert.ok(card, 'разбивка ожидания с вкладки «Тайминг» пропала')
  assert.match(h, /сумма по задачам, а не\s+календарь/, 'иначе сумма читается как календарь поставки')
  const idle = [...h.matchAll(/<div class="card[^"]*"><b>([^<]+)<\/b><span>([^<]*)/g)]
    .find((m) => m[2].includes('без движения'))
  assert.ok(idle, 'хвост до «сейчас» не выброшен, а назван своей карточкой')
  assert.match(idle[2], /не влиты, стадий не идёт/, 'сказано, про какие именно задачи это время')
  assert.match(h, /ПОСЛЕДНИМ СОБЫТИЕМ/, 'в разделе тайминга объяснено, где кончается календарь задачи')
})

test('закрытая задача «незакрытым ожиданием» не считается', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  writeEvent(p.root, {
    ts: '2026-09-30T09:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'dev', event: 'started', actor: 'test',
  })
  merged(p, 'T-001')
  const cards = [...html(p).matchAll(/<div class="card[^"]*"[^>]*><b>([^<]+)<\/b><span>([^<]*)/g)]
  assert.ok(cards.find((m) => m[2].includes('чистое по задачам')), 'карточка чистого времени на месте')
  assert.ok(!cards.some((m) => m[2].includes('без движения')), 'у влитой задачи календарь закрыт слиянием, и карточка здесь была бы ложной')
})

test('в шапке — чистое время, а разбивка ожидания ушла на вкладку', (t) => {
  // Решение человека 28.10.2026: время, когда ждут человека или прогон стоит на паузе,
  // движку не предъявляется (ADR-0009). Карточка «ожидание» показывала сумму всего, и по
  // ней выходило, что прогон провёл в ожидании 168 ч — вместе с чужими интервалами.
  //
  // Поправка 29.10.2026, по просьбе человека: разбивка ожидания тремя карточками в шапке
  // отвечала на вопрос «что чинить», а от шапки ждут другого — «сколько это заняло».
  // Поэтому в шапке стоит ЧИСТОЕ время (календарь минус чужое), вычтенное названо в
  // подсказке, а разбивка осталась на вкладке «Тайминг» и в таблице.
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  const E = (ts, stage, event, extra = {}) => writeEvent(p.root, {
    ts, change: p.change, ticket: 'T-001', stage, event, actor: 'test', ...extra,
  })
  E('2026-09-30T09:00:00.000Z', 'dev', 'started')
  E('2026-09-30T09:10:00.000Z', 'dev', 'escalated')
  // Час ждали человека. Внутри этого часа полчаса прогон стоял на паузе.
  writeEvent(p.root, {
    ts: '2026-09-30T09:20:00.000Z', change: p.change, ticket: 'MR',
    stage: 'lifecycle', event: 'paused', actor: 'human',
  })
  writeEvent(p.root, {
    ts: '2026-09-30T09:50:00.000Z', change: p.change, ticket: 'MR',
    stage: 'lifecycle', event: 'resumed', actor: 'human',
  })
  E('2026-09-30T10:10:00.000Z', 'dev', 'arbitrated')
  E('2026-09-30T10:20:00.000Z', 'dev', 'finished')
  E('2026-09-30T10:30:00.000Z', 'merge', 'finished')
  const h = html(p)
  const cards = [...h.matchAll(/<div class="card[^"]*"[^>]*><b>([^<]+)<\/b><span>([^<]*)/g)]
  const clean = cards.find((m) => m[2].includes('чистое по задачам'))
  assert.ok(clean, 'в шапке нет чистого времени — главного числа поставки')
  // Календарь 90 минут, активного 10 (стадия dev закрылась эскалацией), ожидания 80.
  // Чужое вычитается ОБЪЕДИНЕНИЕМ часа и получаса, то есть час: чистого остаётся 30 минут.
  assert.match(clean[1], /^30м$/, `чистое время — календарь минус чужое: ${clean[1]}`)
  assert.match(clean[2], /без ожидания человека и паузы/, 'сказано, чего в этом числе нет')
  assert.match(clean[2], /вычтено 1ч 0м/, 'и сколько именно вычли — иначе число нечем проверить')
  // Чужое не спрятано: подсказка карточки называет обе части и накладные движка.
  const tip = (h.match(/<div class="card" title="([^"]+)"><b>30м<\/b><span>чистое по задачам/) || [])[1] || ''
  assert.match(tip, /Вычтено 1ч 0м чужого/, 'вычтено ОБЪЕДИНЕНИЕ, а не сумма частей')
  assert.match(tip, /1ч 0м ждут человека/)
  assert.match(tip, /30м на паузе/)
  assert.match(tip, /накладные движка — 20м/, 'ожидание движка названо там же, а не потеряно')
  // Разбивка на месте, просто не в шапке.
  assert.match(h, /20м ожидания движка/, 'вкладка «Тайминг» по-прежнему раскладывает ожидание')
  assert.match(h, /вычитаются они\s+ОБЪЕДИНЕНИЕМ/, 'сказано, почему перекрытие не вычитается дважды')
  assert.match(h, /<th[^>]*>Чистое<\/th>/, 'в таблице задач чистое время стоит своей колонкой')
  // Второе число — про саму ПОСТАВКУ, а не про сумму по задачам: задачи идут
  // параллельно, и сумма на вопрос «сколько поставка шла» не отвечает.
  const went = cards.find((m) => m[2].includes('шла поставка'))
  assert.ok(went, 'в шапке нет времени самой поставки')
  // Одна задача, одна стадия dev в 10 минут: поставка шла ровно её.
  assert.match(went[1], /^10м$/, `поставка шла ровно столько, сколько была открыта стадия: ${went[1]}`)
  assert.match(went[2], /когда работала хоть одна стадия/, 'сказано, что это за время')
  assert.match(h, /Два числа, и они отвечают на разные вопросы/, 'на вкладке разведены сумма и календарь')
  assert.match(h, /поставка СТОИЛА/, 'и названо, на какой вопрос отвечает сумма по задачам')
})

// Замер проект-В 02.11.2026: двенадцать задач, ЗАМЕНЁННЫХ человеком, висели карточкой
// «прочее — статус вне словаря доски». Остаточное ведро отработало как задумано (молча
// ничего не потерялось), но ответить, что это за двенадцать, доска не могла: `superseded`
// в её словаре не было с самого начала, хотя движок пишет именно его.
test('заменённая задача названа словом, а не «статусом вне словаря доски»', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { status: 'todo' })
  merged(p, 'T-001')
  writeTask(p, 'T-002', { status: 'todo' })
  writeEvent(p.root, {
    ts: '2026-09-30T09:50:00.000Z', change: p.change, ticket: 'T-002',
    stage: 'lifecycle', event: 'superseded', actor: 'human', notes: 'заменена на T-003',
  })
  const h = html(p)
  const other = cardsOf(h).find((c) => c.label.startsWith('прочее'))
  assert.ok(other, 'задача вне названных групп обязана быть видна остатком')
  assert.equal(other.n, 1)
  assert.match(other.label, /заменена/, 'статус назван словом')
  assert.doesNotMatch(other.label, /вне словаря доски/)
})
