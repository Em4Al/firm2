// И-11 в проекции тайминга и И-5: интервал стадии закрывает ЛЮБОЙ исход, а не только
// удачный. Пока брошенную стадию не закрывал никто, `active_ms` считался до `Date.now()`
// и рос сутками — врала ровно та метрика, по которой человек решает, сколько задач брать
// в прогон.
import test from 'node:test'
import assert from 'node:assert/strict'
import { timing, computeBoard, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

const MIN = 60000
const base = Date.parse('2026-09-30T10:00:00.000Z')
const at = (min) => new Date(base + min * MIN).toISOString()

function events(list) {
  return list.map(([min, stage, event]) => ({ ts: at(min), stage, event, ticket: 'T-001' }))
}

test('И-11: dev/abandoned закрывает интервал — active_ms равен 10 минутам, а не растёт от «сейчас»', () => {
  const tm = timing(events([[0, 'dev', 'started'], [10, 'dev', 'abandoned']]))
  assert.equal(tm.active_ms, 10 * MIN, 'брошенная стадия шла десять минут и ни секундой больше')
  // Второй вызов обязан дать то же число: зависимость от Date.now() и была дефектом.
  assert.equal(timing(events([[0, 'dev', 'started'], [10, 'dev', 'abandoned']])).active_ms, 10 * MIN)
})

test('И-11: merge/failed после dev/started тоже закрывает интервал', () => {
  const tm = timing(events([[0, 'dev', 'started'], [6, 'merge', 'failed']]))
  assert.equal(tm.active_ms, 6 * MIN)
})

test('И-11: незакрытая стадия честно растёт от «сейчас» — пробел, а не ноль', () => {
  const now = Date.now()
  const tm = timing([{ ts: new Date(now - 30 * MIN).toISOString(), stage: 'dev', event: 'started' }])
  assert.ok(tm.active_ms >= 30 * MIN - 2000 && tm.active_ms <= 30 * MIN + 5000,
    `идущая стадия обязана считаться до «сейчас»: ${tm.active_ms}`)
})

test('И-5: тайминг влитой задачи считается по времени событий, а не по времени чтения', () => {
  const tm = timing(events([
    [0, 'dev', 'started'], [20, 'dev', 'finished'],
    [25, 'test', 'started'], [35, 'test', 'finished'],
    [40, 'review', 'started'], [50, 'review', 'accepted'],
    [120, 'merge', 'finished'],
  ]))
  assert.equal(tm.calendar_ms, 120 * MIN, 'календарное — от первого dev/started до слияния')
  assert.equal(tm.active_ms, 40 * MIN, 'активное — сумма интервалов dev + test + review')
  assert.equal(tm.waiting_ms, 80 * MIN, 'остальное — ожидание, в первую очередь человека')
  assert.equal(tm.started, at(0))
  assert.equal(tm.merged, at(120))
})

test('И-11: брошенная попытка не раздувает активное время задачи, прошедшей цикл заново', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  for (const [min, stage, event] of [
    [0, 'dev', 'started'], [10, 'dev', 'abandoned'], // прогон сняли
    [600, 'dev', 'started'], [620, 'dev', 'finished'], // через десять часов зашли заново
    [630, 'merge', 'finished'],
  ]) {
    writeEvent(p.root, { ts: at(min), change: p.change, ticket: 'T-001', stage, event, actor: 'test' })
  }
  const task = computeBoard(p.root, p.change).tasks[0]
  assert.equal(task.status, 'merged')
  assert.equal(task.attempt, 2, 'попытки считаются по dev/started')
  assert.equal(task.timing.active_ms, 30 * MIN, '10 минут брошенной попытки + 20 минут второй')
  assert.equal(task.timing.calendar_ms, 630 * MIN)
})

// ── Где кончается календарь задачи: три состояния, а не два ───────────────────
//
// Находка человека на доске проект-В 28.10.2026: «ожидание всего 168 ч» росло само, пока на
// него смотрят, и читалось как «столько прождали». Причина — конец календаря у НЕвлитой
// задачи брался как «сейчас», и остановленная задача добавляла в ожидание время, в котором
// с ней ничего не происходило; сумма таких хвостов по всем задачам и давала число.
//
// Теперь состояний три: влита (календарь кончается слиянием), стадия идёт (до «сейчас» —
// работа происходит, И-11), стадий не идёт и слияния нет (последним событием). Хвост до
// «сейчас» не выброшен, а назван своим именем — `idle_ms`.
test('остановленная задача: календарь кончается последним событием, хвост — в idle_ms', () => {
  const now = Date.now()
  const tm = timing([
    { ts: new Date(now - 200 * MIN).toISOString(), stage: 'dev', event: 'started' },
    { ts: new Date(now - 190 * MIN).toISOString(), stage: 'dev', event: 'finished' },
  ])
  assert.equal(tm.calendar_ms, 10 * MIN, 'календарь — от старта до последнего факта, а не до «сейчас»')
  assert.equal(tm.active_ms, 10 * MIN)
  assert.equal(tm.waiting_ms, 0, 'ожидания внутри фактов нет — и выдумывать его из «сейчас» нельзя')
  assert.ok(tm.idle_ms >= 190 * MIN - 2000 && tm.idle_ms <= 190 * MIN + 5000,
    `хвост до «сейчас» назван отдельно: ${tm.idle_ms}`)
  assert.equal(tm.open_stage, null)
})

test('идущая стадия: календарь идёт до «сейчас», и idle_ms равен нулю', () => {
  // Обратная сторона того же решения: работа происходит прямо сейчас, и показывать её
  // «без движения» значило бы врать в опасную сторону (И-11 — незакрытая стадия растёт).
  const now = Date.now()
  const tm = timing([
    { ts: new Date(now - 60 * MIN).toISOString(), stage: 'dev', event: 'started' },
    { ts: new Date(now - 50 * MIN).toISOString(), stage: 'dev', event: 'finished' },
    { ts: new Date(now - 40 * MIN).toISOString(), stage: 'test', event: 'started' },
  ])
  assert.ok(tm.calendar_ms >= 60 * MIN - 2000, 'календарь идущей задачи идёт')
  assert.equal(tm.idle_ms, 0, 'у идущей задачи простоя нет по определению')
  assert.equal(tm.open_stage, 'test', 'сказано, какая именно стадия открыта')
  assert.ok(tm.waiting_ms >= 10 * MIN - 2000, 'пробел между стадиями остаётся ожиданием')
})

test('влитая задача: ни календарь, ни ожидание больше не меняются', () => {
  const now = Date.now()
  const tm = timing([
    { ts: new Date(now - 300 * MIN).toISOString(), stage: 'dev', event: 'started' },
    { ts: new Date(now - 290 * MIN).toISOString(), stage: 'dev', event: 'finished' },
    { ts: new Date(now - 280 * MIN).toISOString(), stage: 'merge', event: 'finished' },
  ])
  assert.equal(tm.calendar_ms, 20 * MIN)
  assert.equal(tm.waiting_ms, 10 * MIN)
  assert.equal(tm.idle_ms, 0, 'закрытая задача простоя не накапливает: её календарь кончился слиянием')
})

// ── Чужое время: ожидание человека и пауза в ожидание движка не идут ──────────
//
// Решение человека 28.10.2026: «давай время учитывать без ожидания (т.е. если ждут
// человека или поставлено на паузу — то это не учитываем)». Основание — ADR-0009: движок
// не распоряжается чужим временем, а значит и отвечать за него в замерах не должен.
// Ожидание раскладывается на три части, и уменьшать имеет смысл только последнюю.
test('эскалация: время до следующего события — ожидание человека, а не движка', () => {
  const tm = timing(events([
    [0, 'dev', 'started'], [10, 'dev', 'escalated'],
    [70, 'dev', 'arbitrated'], [80, 'dev', 'finished'],
    [85, 'merge', 'finished'],
  ]))
  assert.equal(tm.waiting_human_ms, 60 * MIN, 'от эскалации до разбора ждали человека')
  assert.equal(tm.waiting_pause_ms, 0, 'паузы не было')
  // Календарь 85 минут, активного 80 (dev 0→10, dev 70→80, остальное вне стадий).
  assert.equal(tm.waiting_ms - tm.waiting_human_ms, tm.waiting_engine_ms,
    'ожидание движка — это остаток после вычета чужого')
  assert.ok(tm.waiting_engine_ms < tm.waiting_ms, 'иначе чужое время предъявлено движку')
})

test('пауза прогона вычитается из ожидания задачи', () => {
  const pauses = [[base + 20 * MIN, base + 50 * MIN]]
  const tm = timing(events([
    [0, 'dev', 'started'], [10, 'dev', 'finished'],
    [60, 'test', 'started'], [70, 'test', 'finished'],
    [75, 'merge', 'finished'],
  ]), pauses)
  assert.equal(tm.waiting_pause_ms, 30 * MIN, 'прогон стоял полчаса — это не накладные движка')
  assert.equal(tm.waiting_human_ms, 0)
  assert.equal(tm.waiting_engine_ms, tm.waiting_ms - 30 * MIN)
})

test('пауза во время эскалации вычитается ОДИН раз: объединение, а не сумма', () => {
  // Худший вид ошибки здесь — похожий на успех: сумма вычла бы перекрытие дважды,
  // «ожидание движка» ушло бы в минус и обрезалось нулём, то есть выглядело бы отлично.
  const pauses = [[base + 20 * MIN, base + 80 * MIN]]
  const tm = timing(events([
    [0, 'dev', 'started'], [10, 'dev', 'escalated'],
    [90, 'dev', 'finished'], [95, 'merge', 'finished'],
  ]), pauses)
  assert.equal(tm.waiting_human_ms, 80 * MIN, 'эскалация с 10-й по 90-ю минуту')
  assert.equal(tm.waiting_pause_ms, 60 * MIN, 'пауза с 20-й по 80-ю — внутри эскалации')
  assert.equal(tm.waiting_engine_ms, tm.waiting_ms - 80 * MIN,
    'вычтено объединение (80 минут), а не сумма (140)')
  assert.ok(tm.waiting_engine_ms >= 0)
})

test('пауза вне календаря задачи её времени не касается', () => {
  // Пауза, поставленная после слияния задачи, — не её ожидание. Обрезка по календарю.
  const pauses = [[base + 200 * MIN, base + 300 * MIN]]
  const tm = timing(events([
    [0, 'dev', 'started'], [10, 'dev', 'finished'], [20, 'merge', 'finished'],
  ]), pauses)
  assert.equal(tm.waiting_pause_ms, 0, 'чужая по времени пауза в задачу не попадает')
  assert.equal(tm.waiting_engine_ms, tm.waiting_ms)
})

test('pauseSpans: пары paused/resumed, а незакрытая пауза тянется до «сейчас»', async () => {
  const { pauseSpans } = await import('../scripts/lib/firm.mjs')
  const closed = pauseSpans([
    { ts: at(10), stage: 'lifecycle', event: 'paused' },
    { ts: at(40), stage: 'lifecycle', event: 'resumed' },
  ])
  assert.deepEqual(closed, [[base + 10 * MIN, base + 40 * MIN]])
  // Повторный `paused` без снятия нового интервала не открывает: флаг один.
  const once = pauseSpans([
    { ts: at(10), stage: 'lifecycle', event: 'paused' },
    { ts: at(20), stage: 'lifecycle', event: 'paused' },
    { ts: at(40), stage: 'lifecycle', event: 'resumed' },
  ])
  assert.equal(once.length, 1)
  assert.deepEqual(once[0], [base + 10 * MIN, base + 40 * MIN])
  // Пауза, не снятая до сих пор, ДЕЙСТВУЕТ: новые стадии не открываются. Это не
  // предположение о будущем, а факт о настоящем, поэтому интервал идёт до «сейчас».
  const open = pauseSpans([{ ts: new Date(Date.now() - 15 * MIN).toISOString(), stage: 'lifecycle', event: 'paused' }])
  assert.equal(open.length, 1)
  assert.ok(open[0][1] - open[0][0] >= 15 * MIN - 2000)
  // `resumed` без `paused` — не интервал: журнал мог начаться середины (ADR-0006).
  assert.deepEqual(pauseSpans([{ ts: at(5), stage: 'lifecycle', event: 'resumed' }]), [])
})

test('события паузы статуса задач не меняют', (t) => {
  // Пауза — факт о ПРОГОНЕ, а не о задаче: `ticket: MR`. Но если такое событие попадёт в
  // поток задачи, доска от него не должна дёрнуться.
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, { ts: at(0), change: p.change, ticket: 'T-001', stage: 'dev', event: 'started', actor: 'test' })
  writeEvent(p.root, { ts: at(5), change: p.change, ticket: 'T-001', stage: 'lifecycle', event: 'paused', actor: 'human' })
  const b = computeBoard(p.root, p.change)
  const task = b.tasks.find((x) => x.id === 'T-001')
  assert.equal(task.status, 'in_progress', 'пауза не отменяет и не закрывает стадию')
})

test('pause/resume оставляют в журнале границы паузы, а не только флаг', async (t) => {
  // Флаг отвечает «стоит ли пауза СЕЙЧАС» и ничего не говорит о том, сколько она стояла.
  // Без границ в журнале время паузы оставалось бы в ожидании движка — то есть прогону
  // предъявлялся бы счёт за остановку, которую сделал человек (ADR-0009).
  const { listEvents, pauseSpans: spans } = await import('../scripts/lib/firm.mjs')
  const p = makeProject(t, { tasks: ['T-001'] })
  const on = JSON.parse(p.cli('firm-state.mjs', ['pause', '--root', p.root, '--json', '--reason', 'перепланирование']).stdout)
  assert.equal(on.paused, true)
  assert.equal(on.journaled, true, 'запись в журнал — часть ответа команды, а не побочный эффект')
  const off = JSON.parse(p.cli('firm-state.mjs', ['resume', '--root', p.root, '--json']).stdout)
  assert.equal(off.paused, false)
  assert.equal(off.journaled, true)
  const ev = listEvents(p.root).filter((e) => e.stage === 'lifecycle' && ['paused', 'resumed'].includes(e.event))
  assert.equal(ev.length, 2, 'оба конца интервала записаны')
  assert.equal(ev[0].ticket, 'MR', 'пауза — факт о прогоне, а не о задаче')
  assert.equal(ev[0].actor, 'human', 'и останавливает прогон человек')
  assert.equal(ev[0].notes, 'перепланирование', 'причина паузы сохранена: по ней потом и читают, почему стояли')
  assert.equal(spans(listEvents(p.root)).length, 1, 'интервал закрыт — считается по фактам, а не до «сейчас»')
})

// ── Время ПОСТАВКИ против суммы по задачам ───────────────────────────────────
//
// Просьба человека 29.10.2026: «это за всё время — а надо бы ещё текущую поставку взять».
// Числа шапки складывались ПО ЗАДАЧАМ, и такая сумма законно больше календаря поставки:
// задачи идут параллельно, их интервалы накладываются. На проект-В это 226 ч 46 м суммы
// против 170 ч календаря — то есть на вопрос «сколько поставка идёт» сумма отвечала
// числом, которое больше всего времени её существования.
test('deliveryTiming: поставка шла столько, сколько работала хоть одна стадия', async () => {
  const { deliveryTiming } = await import('../scripts/lib/firm.mjs')
  // Две задачи параллельно: первая 0→30, вторая 10→20. Поставка шла 30 минут, а сумма
  // по задачам дала бы 40 — и была бы права, отвечая на другой вопрос.
  const ev = [
    { ts: at(0), stage: 'dev', event: 'started', ticket: 'T-001' },
    { ts: at(10), stage: 'dev', event: 'started', ticket: 'T-002' },
    { ts: at(20), stage: 'dev', event: 'finished', ticket: 'T-002' },
    { ts: at(30), stage: 'dev', event: 'finished', ticket: 'T-001' },
  ]
  const d = deliveryTiming(ev, [])
  assert.equal(d.clean_ms, 30 * MIN, 'объединение интервалов, а не сумма')
  // Поставка не выпущена — её календарь тянется до «сейчас» (И-11), и простой растёт
  // вместе с ним: это не ошибка счёта, а факт про поставку, которая стоит.
  assert.ok(d.calendar_ms > 30 * MIN, 'календарь незакрытой поставки идёт до «сейчас»')
  assert.equal(d.idle_ms, d.calendar_ms - 30 * MIN, 'всё, что не стадии, — простой')
})

test('deliveryTiming: промежуток между волнами — простой, а не работа', async () => {
  const { deliveryTiming } = await import('../scripts/lib/firm.mjs')
  const ev = [
    { ts: at(0), stage: 'dev', event: 'started', ticket: 'T-001' },
    { ts: at(10), stage: 'dev', event: 'finished', ticket: 'T-001' },
    // Час ничего не шло: человек разбирал, планировал, спал — поставка не работала.
    { ts: at(70), stage: 'dev', event: 'started', ticket: 'T-002' },
    { ts: at(80), stage: 'dev', event: 'finished', ticket: 'T-002' },
    { ts: at(90), stage: 'release', event: 'finished', ticket: 'MR' },
  ]
  const d = deliveryTiming(ev, [])
  assert.equal(d.calendar_ms, 90 * MIN, 'календарь кончился ВЫПУСКОМ, а не «сейчас»')
  assert.equal(d.clean_ms, 20 * MIN, 'шла поставка только в две свои стадии')
  assert.equal(d.idle_ms, 70 * MIN, 'остальное — простой: ждут человека, пауза, промежутки')
})

test('deliveryTiming: пауза не вычитается из уже открытой стадии — та доигрывает', async () => {
  const { deliveryTiming } = await import('../scripts/lib/firm.mjs')
  // Пауза останавливает ОТКРЫТИЕ новых стадий, а идущая доигрывает, и это время было
  // работой. Вычитание паузы из активного съело бы на проект-В 2 часа честных стадий
  // (34,4 ч вместо 36,4 ч) — то есть ошибка была бы в сторону «работы меньше, чем есть».
  const ev = [
    { ts: at(0), stage: 'dev', event: 'started', ticket: 'T-001' },
    { ts: at(30), stage: 'dev', event: 'finished', ticket: 'T-001' },
    { ts: at(30), stage: 'release', event: 'finished', ticket: 'MR' },
  ]
  const d = deliveryTiming(ev, [[base + 10 * MIN, base + 40 * MIN]])
  assert.equal(d.clean_ms, 30 * MIN, 'стадия шла тридцать минут, пауза её не прерывала')
  assert.equal(d.pause_ms, 20 * MIN, 'пауза названа, но обрезана по календарю поставки')
})

test('deliveryTiming: пустой журнал — нули, а не выдуманный календарь', async () => {
  const { deliveryTiming } = await import('../scripts/lib/firm.mjs')
  const d = deliveryTiming([], [])
  assert.equal(d.calendar_ms, 0)
  assert.equal(d.clean_ms, 0)
  assert.equal(d.started, null, 'начала нет — и сказано это пустотой, а не датой «сейчас»')
})

// ── Решение человека закрывает календарь задачи (замер проект-В 02.11.2026) ─────
//
// До 02.11.2026 закрытием календаря считалось только слияние, и у задачи, СНЯТОЙ человеком,
// `idle_ms` рос вечно: на доске проект-В «584 ч 38 м без движения», из них три снятые задачи
// несли 182 часа и продолжали набирать (T-171 +75 ч, T-181 +60 ч, T-190 +47 ч). Это не
// пробел в журнале, а решение, которое в нём ЕСТЬ: требовать движения от задачи, по которой
// человек постановил, что движения не будет, — значит распоряжаться его решением (ADR-0009).
test('снятая человеком задача не копит «без движения»: решение закрывает календарь', () => {
  const long = [[0, 'dev', 'started'], [20, 'dev', 'finished']]
  const open = timing(events(long))
  assert.ok(open.idle_ms > 0, 'без решения хвост до «сейчас» честно растёт — это пробел')

  for (const ev of ['superseded', 'cancelled']) {
    const tm = timing(events([...long, [30, 'lifecycle', ev]]))
    assert.equal(tm.idle_ms, 0, `${ev} — решение человека, а не простой задачи`)
    assert.equal(tm.calendar_ms, 30 * MIN, 'календарь кончается решением, а не «сейчас»')
    assert.equal(tm.closed, at(30), 'время решения названо полем — по нему видно, чем кончилась задача')
  }
})

test('снятие ПОСЛЕ слияния календарь не переписывает — побеждает слияние', () => {
  const tm = timing(events([[0, 'dev', 'started'], [20, 'merge', 'finished'], [30, 'lifecycle', 'cancelled']]))
  assert.equal(tm.calendar_ms, 20 * MIN, 'влитая задача закончилась слиянием: оно факт, а решение после него — учёт')
  assert.equal(tm.idle_ms, 0)
})
