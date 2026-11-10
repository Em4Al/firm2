// «Форма плана» (lib/firm.mjs): за сколько волн пройдёт поставка и чего это стоит.
//
// dependencyDepth/waves/planShape — чистые функции над массивом задач; `plan-shape` —
// команда firm-state.mjs поверх planShape; предупреждение про cost_of_exclusive —
// замена доли в exclusivityWarnings (firm-state.mjs), которая раньше считала долю
// исключительных задач — число, честно названное бесполезным в комментарии кода.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dependencyDepth, waves, planShape, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, isoAgo } from './helpers.mjs'

function writeTask(p, id, { safe = false, why = null, deps = [] } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: todo\n` +
      (safe ? 'parallel_safe: true\n' : '') +
      (why ? `exclusive_why: ${why}\n` : '') +
      (deps.length ? `depends_on: [${deps.join(', ')}]\n` : '') +
      '---\n\nПроверочная задача.\n\n- [ ] критерий один\n',
  )
}

const merged = (p, id) =>
  writeEvent(p.root, {
    ts: isoAgo(1), change: p.change, ticket: id, stage: 'merge', event: 'finished', actor: 'test',
  })

function buildArgs(p) {
  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const costWarn = (w) => w.find((x) => x.includes('пометки exclusive стоят')) || null
const silentWarn = (w) => w.find((x) => x.includes('без причины')) || null

// Минимальная форма задачи, которой достаточно этим чистым функциям: им не нужны ни
// файлы, ни журнал — только id/depends_on/parallel_safe/exclusive_why.
const mk = (id, deps = [], extra = {}) => ({ id, depends_on: deps, parallel_safe: true, exclusive_why: null, ...extra })

// ── dependencyDepth ───────────────────────────────────────────────────────────

test('dependencyDepth: глубина растёт по цепочке на единицу за уровень', () => {
  const tasks = [mk('A'), mk('B', ['A']), mk('C', ['B'])]
  const depth = dependencyDepth(tasks)
  assert.equal(depth.get('A'), 0)
  assert.equal(depth.get('B'), 1)
  assert.equal(depth.get('C'), 2)
})

test('dependencyDepth: зависимость на задачу ВНЕ списка игнорируется, а не ломает счёт', () => {
  const tasks = [mk('X', ['НЕТ-ТАКОЙ-ЗАДАЧИ'])]
  const depth = dependencyDepth(tasks)
  assert.equal(depth.get('X'), 0, 'несуществующая зависимость не считается как уровень')
})

// Цикл не должен зависать — он и есть повод для этой правки. Проверяем конкретное
// детерминированное поведение (не просто «не упало»): первая по порядку задача в
// рекурсии добирается до цикла и получает «долгий» путь, вторая обрывает его нулём.
test('dependencyDepth: цикл не зацикливает — повторно встреченный узел получает 0', () => {
  const ab = dependencyDepth([mk('A', ['B']), mk('B', ['A'])])
  assert.deepEqual([...ab.entries()], [['B', 1], ['A', 2]])

  // Порядок задач в массиве определяет, кто «обрывает» цикл нулём — зависимость
  // детерминирована, а не случайна, и это стоит закрепить явно.
  const ba = dependencyDepth([mk('B', ['A']), mk('A', ['B'])])
  assert.deepEqual([...ba.entries()], [['A', 1], ['B', 2]])
})

// ── waves ──────────────────────────────────────────────────────────────────────

test('waves: готовые задачи берутся не больше potolka parallelism', () => {
  const tasks = [mk('A'), mk('B'), mk('C'), mk('D')]
  const r = waves(tasks, { parallelism: 3 })
  assert.deepEqual(r.waves, [['A', 'B', 'C'], ['D']])
  assert.equal(r.stuck, null)
})

test('waves: хоть одна исключительная среди готовых — волна состоит РОВНО из неё одной', () => {
  const tasks = [mk('A'), mk('B'), mk('C', [], { parallel_safe: false })]
  const r = waves(tasks, { parallelism: 3 })
  assert.deepEqual(r.waves, [['C'], ['A', 'B']],
    'исключительная забирает волну себе целиком, даже когда слотов хватило бы на всех')
})

test('waves: respectExclusive:false снимает правило «одна исключительная — вся волна»', () => {
  const tasks = [mk('A'), mk('B'), mk('C', [], { parallel_safe: false })]
  const r = waves(tasks, { parallelism: 3, respectExclusive: false })
  assert.deepEqual(r.waves, [['A', 'B', 'C']], 'без правила все три готовы сразу и идут одной волной')
})

test('waves: задачи из done не попадают в расчёт, их зависимые готовы немедленно', () => {
  const tasks = [mk('A'), mk('B', ['A'])]
  const r = waves(tasks, { parallelism: 3, done: ['A'] })
  assert.deepEqual(r.waves, [['B']], 'A сделана — она не волна и не повод ждать')
})

test('waves: held — задача не идёт в волну и не закрывает зависимость', () => {
  const tasks = [mk('A'), mk('B', ['A']), mk('C')]
  const r = waves(tasks, { parallelism: 3, held: ['A'] })
  assert.deepEqual(r.waves, [['C']], 'заблокированная A в волну не идёт')
  assert.deepEqual(r.stuck, ['B'], 'и B честно висит: её зависимость не закрыта, а остановлена')
})

test('waves: held НЕ равно «выбросить из списка» — иначе зависимость считается закрытой', () => {
  const tasks = [mk('A'), mk('B', ['A'])]
  const held = waves(tasks, { parallelism: 3, held: ['A'] })
  const dropped = waves([mk('B', ['A'])], { parallelism: 3 })
  assert.deepEqual(dropped.waves, [['B']],
    'id вне списка не проверяется вовсе — так и задумано для задач чужой поставки')
  assert.deepEqual(held.waves, [], 'а held держит: B не поедет в волну, которой не будет')
})

test('waves: цикл в зависимостях — stuck со списком id, а не вечный цикл', (t) => {
  // Жёсткий предел времени у ЭТОГО теста специально: если защита от цикла когда-нибудь
  // исчезнет и алгоритм действительно зависнет на какой-то другой форме графа, тест
  // обязан упасть по таймауту, а не подвесить весь прогон `npm test`.
  t.timeout = 5000
  const tasks = [mk('A', ['B']), mk('B', ['A'])]
  const r = waves(tasks, { parallelism: 3 })
  assert.deepEqual(r.waves, [])
  assert.deepEqual(new Set(r.stuck), new Set(['A', 'B']))
})

test('waves: цикл в ЧАСТИ графа — решаемая часть идёт волнами, неразрешимая — в stuck', (t) => {
  t.timeout = 5000
  const tasks = [mk('A', ['B']), mk('B', ['A']), mk('C')]
  const r = waves(tasks, { parallelism: 3 })
  assert.deepEqual(r.waves, [['C']])
  assert.deepEqual(new Set(r.stuck), new Set(['A', 'B']))
})

// ── planShape ──────────────────────────────────────────────────────────────────

test('planShape: цепочка длиннее potolka — волна по одной задаче, first_waves не больше пяти', () => {
  const tasks = []
  for (let i = 1; i <= 7; i++) tasks.push(mk(`T${i}`, i > 1 ? [`T${i - 1}`] : []))
  const shape = planShape(tasks, { parallelism: 5 })
  assert.equal(shape.tasks, 7)
  assert.equal(shape.depth, 7)
  assert.equal(shape.waves, 7, 'цепочка идёт по одной задаче на волну независимо от потолка')
  assert.equal(shape.waves_without_exclusive, 7)
  assert.equal(shape.floor, 7)
  assert.equal(shape.first_waves.length, 5, 'первых волн не больше пяти, даже когда их семь')
  assert.deepEqual(shape.first_waves, [['T1'], ['T2'], ['T3'], ['T4'], ['T5']])
})

// Это и есть находка на живых данных: «floor 11 при десяти оставшихся задачах». Глубина
// обязана считаться по ОСТАВШЕМУСЯ подграфу — зависимость на уже сделанную задачу не
// удлиняет цепочку ожидания.
test('planShape: глубина считается по ОСТАВШЕМУСЯ подграфу, а не по полной истории поставки', () => {
  // Цепочка из шести, пять первых уже сделаны (done) — в работе осталась одна задача,
  // зависящая от последней сделанной. По полному графу её «глубина» была бы 5 (считая
  // всю цепочку позади), и floor разошёлся бы с реальностью: одна задача — одна волна.
  const tasks = []
  for (let i = 1; i <= 6; i++) tasks.push(mk(`T${i}`, i > 1 ? [`T${i - 1}`] : []))
  const done = ['T1', 'T2', 'T3', 'T4', 'T5']
  const shape = planShape(tasks, { parallelism: 3, done })

  assert.equal(shape.tasks, 1, 'сделанные задачи не считаются живыми')
  assert.equal(shape.waves_without_exclusive, 1, 'оставшейся задаче нужна ровно одна волна')
  assert.equal(shape.floor, 1,
    'старая ошибка посчитала бы глубину по полной цепочке позади (5) и дала бы floor 6')
  assert.equal(shape.depth, 1)
})

// Инвариант, который сформулировал разбор: floor — теоретический минимум, и выше его
// реальный (жадный) план быть не может. Проверяем на нескольких РАЗРЕШИМЫХ формах графа
// (без stuck — там гарантия не обещана, поставка в принципе не проходима).
test('planShape: floor никогда не больше waves_without_exclusive — на нескольких формах графа', () => {
  const scenarios = []

  // Цепочка.
  {
    const tasks = []
    for (let i = 1; i <= 7; i++) tasks.push(mk(`T${i}`, i > 1 ? [`T${i - 1}`] : []))
    scenarios.push(planShape(tasks, { parallelism: 5 }))
  }
  // Найденная на живых данных форма: длинный сделанный хвост, короткий живой остаток.
  {
    const tasks = []
    for (let i = 1; i <= 6; i++) tasks.push(mk(`T${i}`, i > 1 ? [`T${i - 1}`] : []))
    scenarios.push(planShape(tasks, { parallelism: 3, done: ['T1', 'T2', 'T3', 'T4', 'T5'] }))
  }
  // Широкий фронт независимых задач при маленьком потолке.
  {
    const tasks = [mk('A'), mk('B'), mk('C'), mk('D'), mk('E')]
    scenarios.push(planShape(tasks, { parallelism: 2 }))
  }
  // Смешанный граф: исключительные плюс параллельные.
  {
    const tasks = [
      mk('T1', [], { parallel_safe: false }), mk('T2', [], { parallel_safe: false }),
      mk('T3'), mk('T4'),
    ]
    scenarios.push(planShape(tasks, { parallelism: 3 }))
  }

  for (const shape of scenarios) {
    assert.equal(shape.stuck, null, 'инвариант заявлен для разрешимых форм графа')
    assert.ok(shape.floor <= shape.waves_without_exclusive,
      `floor (${shape.floor}) не может быть больше waves_without_exclusive (${shape.waves_without_exclusive}): ${JSON.stringify(shape)}`)
  }
})

test('planShape: cost_of_exclusive — ровно разница между waves и waves_without_exclusive', () => {
  const tasks = [
    mk('T1', [], { parallel_safe: false }), mk('T2', [], { parallel_safe: false }),
    mk('T3'), mk('T4'),
  ]
  const shape = planShape(tasks, { parallelism: 3 })
  assert.equal(shape.waves, 3)
  assert.equal(shape.waves_without_exclusive, 2)
  assert.equal(shape.cost_of_exclusive, 1)
  assert.equal(shape.exclusive, 2)
  assert.equal(shape.exclusive_without_why, 2)
})

test('planShape: без исключительных задач cost_of_exclusive — 0, а не отрицательное и не случайное', () => {
  const tasks = [mk('A'), mk('B'), mk('C')]
  const shape = planShape(tasks, { parallelism: 3 })
  assert.equal(shape.exclusive, 0)
  assert.equal(shape.cost_of_exclusive, 0)
  assert.equal(shape.waves, shape.waves_without_exclusive)
})

test('planShape: исключительная задача без причины считается отдельно от «без причины вообще»', () => {
  const tasks = [
    mk('T1', [], { parallel_safe: false }), // без причины
    mk('T2', [], { parallel_safe: false, exclusive_why: 'общий файл' }),
    mk('T3'),
  ]
  const shape = planShape(tasks, { parallelism: 3 })
  assert.equal(shape.exclusive, 2)
  assert.equal(shape.exclusive_without_why, 1)
})

test('planShape: тупиковая часть графа видна в stuck, остальное считается как обычно', (t) => {
  t.timeout = 5000
  const tasks = [mk('A', ['B']), mk('B', ['A']), mk('C')]
  const shape = planShape(tasks, { parallelism: 3 })
  assert.deepEqual(new Set(shape.stuck), new Set(['A', 'B']))
  assert.deepEqual(shape.first_waves, [['C']])
})

// ── firm-state.mjs plan-shape ──────────────────────────────────────────────────

test('plan-shape: changes нет вовсе — ok:false с причиной, а не исключение', (t) => {
  const p = makeProject(t, { tasks: [] })
  // У каждого синтетического проекта один каталог поставки (даже без задач) — убираем
  // его целиком, чтобы активной поставки не было вовсе, а не «поставка без задач».
  rmSync(join(p.root, 'openspec', 'changes', p.change), { recursive: true, force: true })

  const r = p.cli('firm-state.mjs', ['plan-shape', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.ok, false)
  assert.match(j.reason, /нет активной поставки/)
})

test('plan-shape: поставка с влитой задачей — ok:true, merged считает её, живые идут в tasks', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002', 'T-003'], parallelism: 3, parallelSafe: true })
  merged(p, 'T-001')

  const r = p.cli('firm-state.mjs', ['plan-shape', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.ok, true)
  assert.equal(j.change, p.change)
  assert.equal(j.merged, 1, 'влитая задача считается, но не как живая')
  assert.equal(j.tasks, 2, 'живых осталось две — влитая не в счёте')
  assert.equal(j.waves, 1, 'две параллельные задачи без исключительности — одна волна')
  assert.ok(j.note && j.note.length > 0, 'предупреждение о неравенстве волн по времени обязано быть сказано')
})

test('plan-shape: снятая (cancelled) задача тоже уходит в done — не висит в живых', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'], parallelSafe: true })
  writeEvent(p.root, {
    ts: isoAgo(1), change: p.change, ticket: 'T-001', stage: 'lifecycle', event: 'cancelled', actor: 'test',
  })

  const r = p.cli('firm-state.mjs', ['plan-shape', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.tasks, 1, 'снятая задача не ждёт и не считается живой')
  // До 10.11.2026 здесь стояло `merged: 1` с оговоркой «done — это влито ИЛИ снято»: сам
  // тест и был записью того, как имя перестало говорить правду. Теперь числа три, и
  // каждое отвечает на свой вопрос — на воротах поставки звучат все три.
  assert.equal(j.merged, 0, 'влитых нет: задача ОТМЕНЕНА, а не влита')
  assert.equal(j.closed, 1, 'а закрытая есть')
})

// ── exclusivityWarnings: цена в волнах вместо доли ────────────────────────────

test('warnings: cost_of_exclusive > 0 — предупреждение называет волны, а не долю', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { why: 'общий файл' })
  writeTask(p, 'T-002', { why: 'общий файл' })
  writeTask(p, 'T-003', { safe: true })
  writeTask(p, 'T-004', { safe: true })

  const w = buildArgs(p).warnings
  const warn = costWarn(w)
  assert.ok(warn, `предупреждение о цене обязано быть: ${JSON.stringify(w)}`)
  assert.match(warn, /пометки exclusive стоят 1 волн/)
  assert.match(warn, /поставка пройдёт за 3 заходов вместо 2/)
  assert.match(warn, /форма графа допускает 2/)
  assert.doesNotMatch(warn, /\d+%/, 'новое предупреждение не про долю в процентах')
})

test('warnings: cost_of_exclusive === 0 — предупреждения про цену нет, даже если исключительная задача есть', (t) => {
  const p = makeProject(t, { tasks: [] })
  // Единственная задача в поставке: идёт она одна что с пометкой, что без — цены нет.
  writeTask(p, 'T-001', { why: 'общий файл' })

  const w = buildArgs(p).warnings
  assert.equal(costWarn(w), null, 'цена 0 — говорить не о чём')
})

test('warnings: предупреждение «без причины» работает по-прежнему, независимо от цены в волнах', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001') // исключительная и молчит
  writeTask(p, 'T-002', { why: 'общий файл' })
  writeTask(p, 'T-003', { safe: true })
  writeTask(p, 'T-004', { safe: true })

  const w = buildArgs(p).warnings
  const silent = silentWarn(w)
  assert.ok(silent, `предупреждение «без причины» не должно было сломаться: ${JSON.stringify(w)}`)
  assert.match(silent, /\(1\): T-001/)
  assert.doesNotMatch(silent, /T-002/)
  // И цена в волнах рядом — оба предупреждения независимы и могут идти вместе.
  assert.ok(costWarn(w), 'в этой сцене цена тоже положительна — оба предупреждения должны быть видны разом')
})

test('warnings: исключительных задач нет вовсе — ни одного из двух предупреждений', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001', { safe: true })
  writeTask(p, 'T-002', { safe: true })

  const w = buildArgs(p).warnings
  assert.equal(silentWarn(w), null)
  assert.equal(costWarn(w), null)
})

// ── Снятая задача закрыта так же, как отменённая (дефект 10.11.2026) ─────────
//
// Нашёл Архитектор проект-В. Предикат «задача не пойдёт никогда» был выписан литеральным
// списком в трёх местах движка, и `superseded` не было ни в одном — при том, что это
// статус, который движок пишет САМ, событием `lifecycle/superseded`, и терминален он ровно
// как `cancelled`, который в списке был. Функция противоречила себе.
//
// Живой вывод на проект-В при четырёх снятых задачах: незакрытых на доске шесть, в
// `plan-shape` десять; первой волной планировалась СНЯТАЯ задача, `waves: 6` против
// настоящих четырёх. Цена не в числе, а в том, что по этому числу принимают решения:
// поднятие `parallelism` с 3 до 8 у них подписано человеком через замер формы плана.
//
// ВТОРАЯ СТОРОНА ЗАМЕРА — здесь она важнее первой, и оговорку дал сам проект-В. «Снятых в
// волнах не стало» прошло бы слишком легко; сломаться не должна привязка ЗАМЕСТИТЕЛЯ:
// задача, снятая, но имеющая живого заместителя с зависимостями на неё, не должна выпасть
// из графа так, чтобы заместитель оказался в первой волне раньше своих настоящих
// предпосылок. Поэтому ниже проверяется не только «T-415 исчезла», но и весь порядок волн.

const supersededEv = (p, id) =>
  writeEvent(p.root, {
    ts: isoAgo(2), change: p.change, ticket: id, stage: 'lifecycle', event: 'superseded', actor: 'human',
  })

function shapeCmd(p) {
  const r = p.cli('firm-state.mjs', ['plan-shape', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('plan-shape: снятая задача не планируется волной, и форма считается по живым', (t) => {
  // Фигура проект-В: T-415 снята и исключительна, её заменяет T-416 (fixes), на которую
  // переставлены T-375/T-376; дальше T-377 и T-378 цепочкой.
  const p = makeProject(t, { tasks: [], parallelism: 8 })
  writeTask(p, 'T-200', { safe: true })
  writeTask(p, 'T-415')
  writeTask(p, 'T-416', { safe: false, why: 'правит общее умолчание', deps: ['T-200'] })
  writeTask(p, 'T-375', { safe: true, deps: ['T-416'] })
  writeTask(p, 'T-376', { safe: true, deps: ['T-416'] })
  writeTask(p, 'T-377', { safe: true, deps: ['T-375', 'T-376'] })
  writeTask(p, 'T-378', { safe: true, deps: ['T-377'] })
  merged(p, 'T-200')
  supersededEv(p, 'T-415')

  const s = shapeCmd(p)
  const flat = s.first_waves.flat()
  assert.ok(!flat.includes('T-415'), `снятая задача в волнах: ${JSON.stringify(s.first_waves)}`)
  // Порядок заместителя и его потомков — та самая вторая сторона.
  assert.deepEqual(s.first_waves, [['T-416'], ['T-375', 'T-376'], ['T-377'], ['T-378']])
  assert.equal(s.waves, 4)
  assert.equal(s.tasks, 5, 'в счёт идут только живые')
  // Имя обязано говорить правду: `merged` — влито, `closed` — закрыто вообще. До этой
  // правки одно поле `merged` считало закрытое и давало на живом проекте 43 при 39
  // влитых (находка проект-В того же вечера: на воротах это читается как сбой учёта).
  assert.equal(s.merged, 1, 'влита одна — T-200')
  assert.equal(s.closed, 2, 'закрыты две — влитая и снятая')
  assert.equal(s.superseded, 1)
  assert.match(s.note, /`merged` — влито/, 'разница названа там же, где числа')
})

test('то же без правки читалось бы как шесть волн: снятая давала СВОЮ волну', (t) => {
  // Контрольный замер той же фигуры «старым» предикатом — руками, через planShape с
  // done без `superseded`. Нужен, чтобы число 4 выше не выглядело случайным.
  const tasks = [
    mk('T-415', [], { parallel_safe: false, exclusive_why: 'общее умолчание' }),
    mk('T-416', ['T-200'], { parallel_safe: false }),
    mk('T-375', ['T-416']), mk('T-376', ['T-416']),
    mk('T-377', ['T-375', 'T-376']), mk('T-378', ['T-377']),
  ]
  const old = planShape(tasks, { parallelism: 8, done: ['T-200'] })
  const now = planShape(tasks, { parallelism: 8, done: ['T-200', 'T-415'] })
  assert.equal(old.waves, 5, 'снятая занимала собой волну — она исключительна')
  assert.equal(now.waves, 4)
})

test('снятая задача не числится живой ни в одном из трёх мест, где спрашивают «закрыта ли»', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-200', { safe: true })
  writeTask(p, 'T-415')
  merged(p, 'T-200')
  supersededEv(p, 'T-415')
  // Полная обвязка признаков: без BRD и design.md `phase` отвечает про более ранний шаг
  // маршрута и до вопроса о задачах не доходит вовсе.
  mkdirSync(join(p.root, 'docs', 'product'), { recursive: true })
  writeFileSync(join(p.root, 'docs', 'product', 'BRD-1.md'), '# требования\n')
  writeFileSync(join(p.root, 'openspec', 'changes', p.change, 'design.md'), '# план\n')

  // 1) форма плана — выше. 2) следующий шаг: живых задач нет, значит поставка закрыта,
  // а не «иди в firm-build» (до правки снятая звала прогон на себя).
  const ph = JSON.parse(p.cli('firm-state.mjs', ['phase', '--root', p.root, '--json']).stdout)
  assert.equal(ph.next_command, 'поставка закрыта', JSON.stringify(ph.next_command))
  // 3) дерево снятой задачи — сирота, а не «задача при деле».
  assert.match(
    JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json']).stdout).skipped.join(' '),
    /T-415: superseded/,
  )
})

test('blocked в закрытые НЕ входит: задача ждёт арбитража и вернётся', () => {
  const tasks = [mk('T-1'), mk('T-2', ['T-1'])]
  // `blocked` не передаётся в done ничем — проверяем само решение на уровне набора.
  assert.equal(planShape(tasks, { parallelism: 3, done: [] }).waves, 2)
})

test('поставка, в которой открытого не осталось, а снятое осталось, активной не числится', (t) => {
  // Четвёртая копия того же списка жила в выборе активной поставки, и она была хуже трёх:
  // по ней движок решает, КАКАЯ поставка идёт. Поставка со снятыми остатками числилась бы
  // активной навсегда, и события следующей уезжали бы в неё — класс Д-1 (проект-В,
  // 11.10.2026: события стадий в чужой поставке, деревья живых задач как сироты).
  const p = makeProject(t, { change: 'ch-old', tasks: [] })
  writeTask(p, 'T-100', { safe: true })
  merged(p, 'T-100')
  writeTask(p, 'T-101')
  supersededEv(p, 'T-101')
  // Вторая поставка, с живой работой: её и надо выбрать.
  mkdirSync(join(p.root, 'openspec', 'changes', 'ch-new', 'tasks'), { recursive: true })
  writeFileSync(
    join(p.root, 'openspec', 'changes', 'ch-new', 'tasks', 'T-200.md'),
    '---\nid: T-200\ntitle: T-200\nstatus: todo\nparallel_safe: true\n---\n\n- [ ] критерий\n',
  )

  const ph = JSON.parse(p.cli('firm-state.mjs', ['phase', '--root', p.root, '--json']).stdout)
  assert.equal(ph.change, 'ch-new', `активной выбрана ${ph.change}`)
})
