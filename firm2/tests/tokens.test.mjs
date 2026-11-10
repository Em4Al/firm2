// Расход токенов и время стадии: `tokensOf` (хук SubagentStop), `tokenUse` и колонка
// «Модель / инстр.» на дашборде.
//
// Две ошибки, из-за которых это написано (разбор T-053, проект-В, 05.10.2026):
//   1. рантайм пишет запрос по блокам контента, и в первом блоке `output_tokens` — потоковая
//      заглушка (2–5), итог стоит в последнем. Брали первую запись — вывод стадии занижался
//      в шесть раз (9 817 вместо 56 635);
//   2. на вопрос «агент работал или ждал» отвечать было нечем: из 80 минут стадии 75 ушли
//      на ответы модели, 5 — на инструменты, и ни токены, ни пик контекста этого не показывают.
//
// Транскрипты здесь синтетические, с заданными метками времени: ожидаемые числа считаются
// руками из таблицы в тесте, а не из того, что вернул код.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDashboard } from '../scripts/dashboard.mjs'
import { tokenUse, duplicateFinishes, writeEvent, duplicateFinishSummary } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

const T0 = Date.parse('2026-10-05T10:00:00.000Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()

// ── Оснастка транскрипта ─────────────────────────────────────────────────────

let seq = 0
// Запись ответа модели: один блок запроса. usage задаётся целиком, чтобы тест видел, из
// какой именно записи взято каждое число.
function asst(sec, { rid, uuid, model = 'claude-sonnet-x', usage = {}, noTs = false } = {}) {
  const o = {
    type: 'assistant',
    uuid: uuid ?? `u-${++seq}`,
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'x' }], usage },
  }
  if (rid) o.requestId = rid
  if (!noTs) o.timestamp = at(sec)
  return o
}
const user = (sec) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(sec),
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
})
const attachment = (sec) => ({ type: 'attachment', uuid: `u-${++seq}`, timestamp: at(sec), attachment: { type: 'x' } })

const U = (inp, out, cr = 0, cw = 0, thinking = null) => ({
  input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
  ...(thinking == null ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
})

// Структурный вывод тестера — чтобы стадия закрылась без претензий и код хука был 0.
const SO = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput',
    input: { status: 'ok', report: { passed: 2, failed: 0, skipped: 0 },
      mutation_check: { done: true, evidence: 'сломал знак — упало 2 теста' } } }] },
}

// Прогоняет хук SubagentStop по транскрипту и возвращает поле `tokens` события finished.
function stop(t, records) {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = join(p.root, 'agent.jsonl')
  writeFileSync(path, [...records, SO].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-tester', hook_event_name: 'SubagentStop', cwd: p.root, agent_id: 'tk-1',
      prompt: 'FIRM2-TICKET: T-001\nFIRM2-CHANGE: ch', last_assistant_message: 'ok',
      agent_transcript_path: path,
    }),
  })
  assert.equal(r.status, 0, `хук обязан отработать молча: ${r.stdout}${r.stderr}`)
  const evs = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
  const fin = evs.find((e) => e.stage === 'test' && e.event === 'finished')
  assert.ok(fin, 'событие finished записано')
  assert.ok(fin.tokens, 'и в нём есть tokens')
  return fin.tokens
}

// ── tokensOf: какая запись запроса побеждает ────────────────────────────────

test('запрос из трёх блоков с output 2/2/700 даёт вывод 700, один вызов и согласованный total', (t) => {
  const tk = stop(t, [
    user(0),
    asst(5, { rid: 'R1', usage: U(10, 2, 1000, 50) }),
    asst(6, { rid: 'R1', usage: U(10, 2, 1000, 50) }),
    asst(7, { rid: 'R1', usage: U(10, 700, 1000, 50) }),
  ])
  assert.equal(tk.out, 700, 'вывод — из итоговой записи, а не из потоковой заглушки')
  assert.equal(tk.calls, 1, 'три блока — один вызов API')
  assert.equal(tk.in, 10)
  assert.equal(tk.cache_read, 1000)
  assert.equal(tk.cache_write, 50)
  assert.equal(tk.total, 10 + 700 + 1000 + 50)
  assert.equal(tk.ctx_peak, 10 + 1000 + 50)
  assert.equal(tk.by_model['claude-sonnet-x'].total, tk.total, 'разбивка по моделям сходится с итогом')
  assert.equal(tk.by_model['claude-sonnet-x'].out, 700)
})

test('итоговая запись не обязана стоять последней: побеждает наибольший output', (t) => {
  const tk = stop(t, [
    asst(1, { rid: 'R1', usage: U(10, 700) }),
    asst(2, { rid: 'R1', usage: U(10, 2) }),
  ])
  assert.equal(tk.out, 700)
  assert.equal(tk.calls, 1)
})

test('два разных requestId суммируются, и у каждого свой победитель', (t) => {
  const tk = stop(t, [
    asst(1, { rid: 'R1', usage: U(10, 2, 100) }),
    asst(2, { rid: 'R1', usage: U(10, 300, 100) }),
    asst(3, { rid: 'R2', usage: U(20, 5, 400) }),
    asst(4, { rid: 'R2', usage: U(20, 50, 400) }),
  ])
  assert.equal(tk.calls, 2)
  assert.equal(tk.out, 350)
  assert.equal(tk.in, 30)
  assert.equal(tk.cache_read, 500)
  assert.equal(tk.total, 30 + 350 + 500)
  assert.equal(tk.ctx_peak, 420, 'пик — наибольший контекст одного запроса (20+400), а не сумма')
})

test('при равном output побеждает более поздняя запись, а остальные поля берутся из неё же', (t) => {
  const tk = stop(t, [
    asst(1, { rid: 'R1', usage: U(10, 40, 100) }),
    asst(2, { rid: 'R1', usage: U(10, 40, 200) }),
  ])
  assert.equal(tk.calls, 1)
  assert.equal(tk.out, 40)
  assert.equal(tk.cache_read, 200, 'равенство разрешается в пользу поздней записи')
})

test('записи без requestId считаются по uuid, каждая отдельно; повтор uuid — одним вызовом', (t) => {
  const tk = stop(t, [
    asst(1, { uuid: 'a', usage: U(1, 10) }),
    asst(2, { uuid: 'b', usage: U(2, 20) }),
    asst(3, { uuid: 'b', usage: U(2, 25) }), // тот же uuid: один вызов, победитель — 25
  ])
  assert.equal(tk.calls, 2)
  assert.equal(tk.out, 10 + 25)
  assert.equal(tk.in, 3)
})

test('запись без requestId и без uuid считается сама по себе, а не склеивается с соседними', (t) => {
  const bare = (sec, usage) => {
    const o = asst(sec, { usage })
    delete o.uuid
    return o
  }
  const tk = stop(t, [bare(1, U(1, 10)), bare(2, U(2, 20))])
  assert.equal(tk.calls, 2)
  assert.equal(tk.out, 30)
})

test('thinking и модель берутся из выбранной записи, а не из первой', (t) => {
  const tk = stop(t, [
    asst(1, { rid: 'R1', model: 'claude-first', usage: U(10, 2, 0, 0, 5) }),
    asst(2, { rid: 'R1', model: 'claude-final', usage: U(10, 700, 0, 0, 300) }),
  ])
  assert.equal(tk.thinking, 300)
  assert.deepEqual(Object.keys(tk.by_model), ['claude-final'], 'вызов целиком записан на модель итоговой записи')
  assert.equal(tk.by_model['claude-final'].thinking, 300)
  assert.equal(tk.model, 'claude-final')
})

test('usage в записи не-assistant (user, system) в расход не идёт', (t) => {
  const stray = (type, rid, sec) => ({ type, uuid: `s-${rid}`, requestId: rid, timestamp: at(sec),
    message: { usage: U(999, 999) } })
  const tk = stop(t, [asst(1, { rid: 'R1', usage: U(10, 20) }), stray('user', 'RU', 2), stray('system', 'RS', 3)])
  assert.equal(tk.calls, 1)
  assert.equal(tk.out, 20)
  assert.equal(tk.in, 10)
})

// ── tokensOf: время модели и время инструментов ─────────────────────────────

// Сцена (секунды от начала):
//   user 0 → A 120 → user 130 → B1 430 → B2 830 (тот же запрос) → attachment 840 → C 850 → user 860
// Интервалы, кончающиеся ответом модели:  A 120, B1 300, B2 400, C 20  → 840 с
// Интервалы, кончающиеся результатом:     130−120 = 10, 860−850 = 10    → 20 с
// Самая долгая пауза перед ПЕРВЫМ блоком: max(120, 300, 20) = 300; 400 между блоками
// одного запроса — стрим, в максимум не идёт.
const SCENE = () => [
  user(0),
  asst(120, { rid: 'A', usage: U(1, 10) }),
  user(130),
  asst(430, { rid: 'B', usage: U(1, 2) }),
  asst(830, { rid: 'B', usage: U(1, 50) }),
  attachment(840),
  asst(850, { rid: 'C', usage: U(1, 10) }),
  user(860),
]

test('время: wait/tool/max на заданных метках считаются точно', (t) => {
  const tk = stop(t, SCENE())
  assert.equal(tk.wait_ms, 840 * 1000, 'время модели')
  assert.equal(tk.tool_ms, 20 * 1000, 'время инструментов')
  assert.equal(tk.wait_max_ms, 300 * 1000)
})

test('время: wait + tool равны полной длительности записи без остатка', (t) => {
  const tk = stop(t, SCENE())
  assert.equal(tk.wait_ms + tk.tool_ms, 860 * 1000)
})

test('пауза между блоками одного requestId идёт в wait_ms, но не в wait_max_ms', (t) => {
  const tk = stop(t, SCENE())
  assert.ok(tk.wait_ms >= 400 * 1000, 'четыреста секунд стрима вошли в сумму')
  assert.ok(tk.wait_max_ms < 400 * 1000, 'но рекордом паузы не стали')
})

test('attachment между записями ничего не меняет в расчёте', (t) => {
  const withAtt = stop(t, SCENE())
  const without = stop(t, SCENE().filter((r) => r.type !== 'attachment'))
  assert.equal(withAtt.wait_ms, without.wait_ms)
  assert.equal(withAtt.tool_ms, without.tool_ms)
  assert.equal(withAtt.wait_max_ms, without.wait_max_ms)
  assert.equal(withAtt.wait_ms, 840 * 1000, 'и интервал 835→850 не разрезан приложением надвое')
})

test('без requestId каждая запись — свой запрос, и пауза перед каждой идёт в максимум', (t) => {
  const tk = stop(t, [
    user(0),
    asst(100, { uuid: 'a', usage: U(1, 10) }),
    asst(800, { uuid: 'b', usage: U(1, 10) }),
  ])
  assert.equal(tk.wait_ms, 800 * 1000)
  assert.equal(tk.wait_max_ms, 700 * 1000)
})

test('без requestId два блока с одним uuid — один запрос: пауза между ними не рекорд', (t) => {
  const tk = stop(t, [
    user(0),
    asst(100, { uuid: 'same', usage: U(1, 2) }),
    asst(800, { uuid: 'same', usage: U(1, 50) }),
  ])
  assert.equal(tk.calls, 1, 'так же считает и расход')
  assert.equal(tk.wait_ms, 800 * 1000)
  assert.equal(tk.wait_max_ms, 100 * 1000)
})

test('запись без метки времени не ломает расчёт и не даёт интервала', (t) => {
  const tk = stop(t, [
    user(0),
    asst(0, { rid: 'A', usage: U(1, 10), noTs: true }),
    asst(60, { rid: 'B', usage: U(1, 10) }),
  ])
  assert.equal(tk.wait_ms, 60 * 1000)
  assert.equal(tk.tool_ms, 0)
})

test('отрицательный интервал (метки не по порядку) пропускается, а не вычитается', (t) => {
  const tk = stop(t, [
    user(0),
    asst(100, { rid: 'A', usage: U(1, 10) }),
    asst(50, { rid: 'B', usage: U(1, 10) }), // назад во времени
    user(70),
  ])
  assert.equal(tk.wait_ms, 100 * 1000, 'отрицательные 50 с в сумму не вошли')
  assert.ok(tk.tool_ms >= 0)
  assert.equal(tk.wait_max_ms, 100 * 1000)
})

// ── tokenUse ─────────────────────────────────────────────────────────────────

const ev = (stage, tokens, extra = {}) => ({ stage, event: 'finished', tokens, ...extra })

test('tokenUse: wait_ms и tool_ms суммируются по событиям, wait_max_ms — максимум', () => {
  const u = tokenUse([
    ev('dev', { total: 10, wait_ms: 1000, tool_ms: 400, wait_max_ms: 700 }),
    ev('test', { total: 10, wait_ms: 2000, tool_ms: 100, wait_max_ms: 1500 }),
    ev('review', { total: 10, wait_ms: 500, tool_ms: 50, wait_max_ms: 900 }),
  ])
  assert.equal(u.wait_ms, 3500)
  assert.equal(u.tool_ms, 550)
  assert.equal(u.wait_max_ms, 1500, 'максимум, а не сумма 3100')
})

test('tokenUse: испорченное событие вне расчёта целиком', () => {
  const u = tokenUse([
    ev('dev', { total: 10, wait_ms: 1000, tool_ms: 400, wait_max_ms: 700 }),
    ev('test', { total: 10, wait_ms: 99999, tool_ms: 99999, wait_max_ms: 99999 }, { _broken: true }),
  ])
  assert.equal(u.wait_ms, 1000)
  assert.equal(u.tool_ms, 400)
  assert.equal(u.wait_max_ms, 700)
  assert.equal(u.total, 10)
})

test('tokenUse: старые события без полей дают нули, а не NaN', () => {
  const u = tokenUse([
    ev('dev', { total: 10, calls: 1 }),
    ev('test', { total: 5, calls: 1 }),
    { stage: 'review', event: 'started' }, // вообще без tokens
  ])
  assert.equal(u.wait_ms, 0)
  assert.equal(u.tool_ms, 0)
  assert.equal(u.wait_max_ms, 0)
  assert.equal(u.total, 15)
})

test('tokenUse: старые и новые события вместе — нули не мешают суммам', () => {
  const u = tokenUse([
    ev('dev', { total: 10 }),
    ev('test', { total: 5, wait_ms: 300, tool_ms: 100, wait_max_ms: 200 }),
  ])
  assert.equal(u.wait_ms, 300)
  assert.equal(u.tool_ms, 100)
  assert.equal(u.wait_max_ms, 200)
})

// ── Двойной счёт: несколько финишей одного захода ────────────────────────────
//
// Замер 25.10.2026 по журналу проект-В: у 37 заходов из 808 финишей больше одного, и каждый
// лишний несёт ПОЛНЫЙ счёт заново. Наивная сумма по поставке 3.2 давала 559.6M против
// 360.8M настоящих. Читатель берёт по заходу максимум — а не сумму и не первое событие.

test('tokenUse: два финиша одного захода считаются один раз, по большему счёту', () => {
  const u = tokenUse([
    ev('design', { total: 100, calls: 10 }, { agent_id: 'a1' }),
    ev('design', { total: 140, calls: 14 }, { agent_id: 'a1' }),
  ])
  assert.equal(u.total, 140, 'максимум, а не сумма 240 и не первое 100')
  assert.equal(u.calls, 14)
})

test('tokenUse: берётся БОЛЬШИЙ счёт захода, а не последний по порядку', () => {
  // Транскрипт только растёт, поэтому меньший счёт в более позднем событии означает
  // неполное чтение, а не подешевевшую работу. Занижать замер — та же ошибка, что
  // завышать его двойным счётом, только молчаливее: правдоподобное число и никакого следа.
  const u = tokenUse([
    ev('design', { total: 140, calls: 14 }, { agent_id: 'a1' }),
    ev('design', { total: 100, calls: 10 }, { agent_id: 'a1' }),
  ])
  assert.equal(u.total, 140, 'максимум, а не последнее 100')
  assert.equal(u.calls, 14)
})

test('tokenUse: заходы разных агентов складываются как прежде', () => {
  const u = tokenUse([
    ev('dev', { total: 100 }, { agent_id: 'a1' }),
    ev('dev', { total: 140 }, { agent_id: 'a1' }),
    ev('test', { total: 7 }, { agent_id: 'a2' }),
  ])
  assert.equal(u.total, 147)
})

test('tokenUse: события без agent_id дублями не считаются', () => {
  // Старые журналы агента в событии не несли вовсе. Схлопывать их было бы хуже двойного
  // счёта: там каждое событие — отдельная стадия, и остался бы один максимум на весь журнал.
  const u = tokenUse([ev('dev', { total: 100 }), ev('test', { total: 40 })])
  assert.equal(u.total, 140)
})

test('tokenUse: старт с токенами не отменяет финиш того же захода', () => {
  const u = tokenUse([
    { stage: 'dev', event: 'started', agent_id: 'a1' },
    ev('dev', { total: 90 }, { agent_id: 'a1' }),
  ])
  assert.equal(u.total, 90)
})

test('duplicateFinishes: называет заход, число лишних событий и завышение', () => {
  const rows = duplicateFinishes([
    ev('design', { total: 100 }, { agent_id: 'a1', ticket: 'MR', _file: 'f1.json' }),
    ev('design', { total: 140 }, { agent_id: 'a1', ticket: 'MR', _file: 'f2.json' }),
    ev('design', { total: 150 }, { agent_id: 'a1', ticket: 'MR', _file: 'f3.json' }),
    ev('dev', { total: 10 }, { agent_id: 'a2', ticket: 'T-001', _file: 'f4.json' }),
  ])
  assert.equal(rows.length, 1, 'одиночный заход находкой не считается')
  assert.equal(rows[0].agent_id, 'a1')
  assert.equal(rows[0].extra, 2)
  assert.equal(rows[0].counted, 150)
  assert.equal(rows[0].would_inflate_by, 240, '100 + 140 — то, что насчитала бы наивная сумма сверху')
  assert.equal(rows[0].inflated_by, undefined,
    'имя `inflated_by` утверждало, что учёт РАЗДУТ, и было прочитано буквально: отчёт проект-В ' +
    '03.11.2026 назвал 1,25 млрд ошибкой дашборда при работающей дедупликации в tokenUse')
  assert.deepEqual(rows[0].files, ['f1.json', 'f2.json', 'f3.json'])
})

// Сводка — не косметика над массивом строк: ответ обязан лежать там же, где числа.
// Голый массив отвечал на «где», а читался как «на сколько врёт учёт» (находка 3).
test('duplicateFinishSummary: числа идут с ответом, что двойной счёт уже снят', () => {
  const sum = duplicateFinishSummary([
    ev('design', { total: 100 }, { agent_id: 'a1', ticket: 'MR', _file: 'f1.json' }),
    ev('design', { total: 150 }, { agent_id: 'a1', ticket: 'MR', _file: 'f2.json' }),
    ev('dev', { total: 10 }, { agent_id: 'a2', ticket: 'T-001', _file: 'f3.json' }),
  ])
  assert.equal(sum.agents, 1)
  assert.equal(sum.extra_events, 1)
  assert.equal(sum.would_inflate_by, 100)
  assert.equal(sum.counted, 150)
  assert.match(sum.note, /УЖЕ снят читателем/)
  assert.equal(sum.rows.length, 1)
})

test('duplicateFinishSummary: пусто — это «не найдено», а не отсутствие ответа', () => {
  const sum = duplicateFinishSummary([ev('dev', { total: 10 }, { agent_id: 'a1' })])
  assert.deepEqual(sum.rows, [])
  assert.equal(sum.would_inflate_by, 0)
  assert.match(sum.note, /не найдено/)
})

test('duplicateFinishes: старт лишним финишем не считается', () => {
  const rows = duplicateFinishes([
    { stage: 'dev', event: 'started', agent_id: 'a1', tokens: { total: 5 } },
    ev('dev', { total: 10 }, { agent_id: 'a1' }),
  ])
  assert.deepEqual(rows, [])
})

// ── Дашборд: колонка «Модель / инстр.» ──────────────────────────────────────

const MIN = 60 * 1000

// Одна задача с событиями dev/started и dev/finished; tokens — то, что записал бы хук.
function boardWith(t, tokens) {
  const p = makeProject(t, { tasks: ['T-001'] })
  const base = Date.now() - 3 * 3600 * 1000
  const w = (min, stage, event, extra = {}) =>
    writeEvent(p.root, {
      ts: new Date(base + min * MIN).toISOString(), change: p.change, ticket: 'T-001',
      stage, event, actor: 'test', ...extra,
    })
  w(0, 'dev', 'started')
  w(80, 'dev', 'finished', tokens ? { tokens } : {})
  return readFileSync(buildDashboard(p.root, p.change), 'utf8')
}

// Ячейка колонки «Модель / инстр.» в строке задачи. Колонок стало тринадцать: расход
// задачи показывается двумя числами — свежим и суммой с кэшем (разбор 28.10.2026).
const TIMING_CELLS = 14
function waitCell(html) {
  const row = html.split('<tr>').find((r) => r.startsWith('<td class="mono">T-001</td>') &&
    (r.match(/<td[ >]/g) || []).length === TIMING_CELLS)
  assert.ok(row, 'строка задачи в таблице времени найдена')
  const cells = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((m) => ({ attrs: m[1], text: m[2] }))
  // Задача, Название, Чистое, Календарное, Активное, Ожидание движка, Доля, Свежих,
  // С кэшем, Вывод, Пик ctx, [Модель / инстр.], Стадии, Модели
  assert.equal(cells.length, TIMING_CELLS, `в строке ${TIMING_CELLS} ячеек`)
  return cells[11]
}

test('дашборд: wait 75м / tool 5м и пауза 16.6м — показаны, подсказка называет паузу', (t) => {
  const h = boardWith(t, {
    in: 1, out: 1, cache_read: 0, cache_write: 0, thinking: 0, total: 2, calls: 1, ctx_peak: 1,
    wait_ms: 75 * MIN, tool_ms: 5 * MIN, wait_max_ms: Math.round(16.6 * MIN),
  })
  const c = waitCell(h)
  assert.equal(c.text, '1ч 15м / 5м')
  assert.match(c.attrs, /title="самая долгая пауза перед ответом модели — 17м"/)
  assert.match(h, /<th[^>]*>Модель \/ инстр\.<\/th>/, 'заголовок колонки есть')
})

test('дашборд: задача без полей времени — прочерк и без подсказки', (t) => {
  const h = boardWith(t, { in: 1, out: 1, cache_read: 0, cache_write: 0, thinking: 0, total: 2, calls: 1, ctx_peak: 1 })
  const c = waitCell(h)
  assert.equal(c.text, '—')
  assert.doesNotMatch(c.attrs, /title/)
})

test('дашборд: задача вовсе без tokens — тоже прочерк', (t) => {
  const c = waitCell(boardWith(t, null))
  assert.equal(c.text, '—')
  assert.doesNotMatch(c.attrs, /title/)
})

test('дашборд: пауза короче 10 минут — суммы видны, подсказки нет', (t) => {
  const c = waitCell(boardWith(t, {
    total: 2, calls: 1, wait_ms: 20 * MIN, tool_ms: 3 * MIN, wait_max_ms: 9 * MIN + 59 * 1000,
  }))
  assert.equal(c.text, '20м / 3м')
  assert.doesNotMatch(c.attrs, /title/)
})

test('дашборд: пауза ровно 10 минут — подсказка уже есть (порог включает границу)', (t) => {
  const c = waitCell(boardWith(t, {
    total: 2, calls: 1, wait_ms: 20 * MIN, tool_ms: 3 * MIN, wait_max_ms: 10 * MIN,
  }))
  assert.match(c.attrs, /title="самая долгая пауза перед ответом модели — 10м"/)
})

test('дашборд: нулевые tool при ненулевом wait — показывается, а не прочерк', (t) => {
  const c = waitCell(boardWith(t, { total: 2, calls: 1, wait_ms: 30 * 1000, tool_ms: 0, wait_max_ms: 0 }))
  assert.equal(c.text, '30с / —', 'прочерк только когда нулевы обе суммы')
})
