// ПОЛОСЫ ОДНОВРЕМЕННОСТИ и число одновременных стадий. Предложение проект-В 10.11.2026
// (разбор T-374) — не дефект: движок своих правил не нарушал, такого правила у него не
// было.
//
// Что было. Планировщик знал ровно два состояния: `parallel_safe: true` — «идёт со всеми»,
// `false` — «идёт одна и занимает все слоты». Среднего не было, поэтому `parallelism: 8`
// означало «восемь браузеров разом», чего на машине не бывает: метка `требует-браузера`
// читалась движком в восьми местах и ни в одном не ограничивала одновременность. Цена
// отсутствия среднего состояния замерена у проекта: единственный рычаг — объявить задачу
// исключительной, и T-415 пришлось объявить такой, хотя ей нужно было «не одновременно с
// другой БРАУЗЕРНОЙ задачей» — теперь она блокирует собой задачу про документы.
//
// Главная проверка здесь не «держит потолок», а ВТОРАЯ сторона: ключа `lanes` в конфиге
// нет — поведение прежнее, то есть ни один чужой проект не меняется. Опциональный ключ,
// который что-то меняет при своём отсутствии, — не опциональный.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { laneCaps, lanesOf, laneWarnings, concurrencyAt, listTasks, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

function writeTask(p, id, { labels = [], safe = true } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: ready\n` +
      (safe ? 'parallel_safe: true\n' : '') +
      `labels: [${labels.join(', ')}]\n---\n\nПроверочная задача.\n\n- [ ] критерий один\n`,
  )
}

const next = (p) => {
  const r = p.cli('firm-state.mjs', ['next', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const buildArgs = (p) => {
  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const LANES = 'lanes:\n  требует-браузера: 1\n'

test('потолок полосы: из трёх браузерных задач волна берёт одну', (t) => {
  const p = makeProject(t, { tasks: [], parallelism: 3, extraConfig: LANES })
  for (const id of ['T-001', 'T-002', 'T-003']) writeTask(p, id, { labels: ['требует-браузера'] })

  const n = next(p)
  assert.equal(n.start.length, 1, JSON.stringify(n))
  assert.equal(n.lane_held.length, 2)
  assert.equal(n.lane_held[0].lane, 'требует-браузера')
  assert.equal(n.lane_held[0].cap, 1)
})

test('БЕЗ ключа lanes поведение прежнее: те же три задачи идут втроём', (t) => {
  const p = makeProject(t, { tasks: [], parallelism: 3 })
  for (const id of ['T-001', 'T-002', 'T-003']) writeTask(p, id, { labels: ['требует-браузера'] })

  const n = next(p)
  assert.equal(n.start.length, 3, JSON.stringify(n))
  assert.equal(n.lane_held, undefined)
})

test('полоса держит только свою метку: соседняя задача идёт рядом', (t) => {
  const p = makeProject(t, { tasks: [], parallelism: 3, extraConfig: LANES })
  writeTask(p, 'T-001', { labels: ['требует-браузера'] })
  writeTask(p, 'T-002', { labels: ['требует-браузера'] })
  writeTask(p, 'T-003', { labels: [] })

  const n = next(p)
  const ids = n.start.map((t2) => t2.id).sort()
  assert.deepEqual(ids, ['T-001', 'T-003'], JSON.stringify(n))
})

test('потолок полосы не становится тупиком: одна задача при пустой машине идёт', (t) => {
  // Иначе потолок 1 остановил бы поставку, в которой браузерная задача единственная
  // готовая: «ждать освобождения полосы» при нуле идущих — ожидание самой себя.
  const p = makeProject(t, { tasks: [], parallelism: 3, extraConfig: LANES })
  writeTask(p, 'T-001', { labels: ['требует-браузера'] })

  assert.equal(next(p).start.length, 1)
})

test('потолки доезжают до сборщика через build-args', (t) => {
  const p = makeProject(t, { tasks: [], parallelism: 3, extraConfig: LANES })
  writeTask(p, 'T-001', { labels: ['требует-браузера'] })

  assert.deepEqual(buildArgs(p).lanes, { 'требует-браузера': 1 })
})

test('нуль в потолке — находка ворот, а не тихое «ключа нет»', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'lanes:\n  требует-браузера: 0\n' })
  writeTask(p, 'T-001', { labels: ['требует-браузера'] })

  const w = buildArgs(p).warnings.filter((x) => /lanes\./.test(x))
  assert.equal(w.length, 1, JSON.stringify(w))
  assert.match(w[0], /parallel_safe: false/)
  // И при негодном потолке полоса НЕ применяется: иначе нуль остановил бы прогон молча.
  assert.deepEqual(buildArgs(p).lanes, {})
})

test('laneCaps берёт только целые больше нуля, lanesOf — пересечение с метками', () => {
  const caps = laneCaps({ lanes: { 'требует-браузера': 2, плохая: 0, дробная: 1.5, строка: 'нет' } })
  assert.deepEqual(caps, { 'требует-браузера': 2 })
  assert.deepEqual(lanesOf({ labels: ['требует-браузера', 'high-complexity'] }, caps), ['требует-браузера'])
  assert.deepEqual(lanesOf({ labels: [] }, caps), [])
  assert.deepEqual(lanesOf(undefined, caps), [])
  assert.equal(laneWarnings({}).length, 0)
  assert.equal(laneWarnings({ lanes: [1, 2] }).length, 1)
})

// ── Сколько стадий шло одновременно ─────────────────────────────────────────
//
// Заход 3 T-374 отказался выдавать свои 40 красных за вердикт — и это правильно, — но
// обоснован отказ был прозой («нагрузка была высокой»), а проверить её постфактум было
// нечем. проект-В просил взять число у рантайма; там его нет (хук на каждого подагента
// свой), зато есть в журнале: открытая стадия — это `started` по `agent_id` без единого
// другого события.

const ev = (agent_id, event, ts, ticket = 'T-001') => ({ agent_id, event, ts, ticket, stage: 'test' })

test('concurrencyAt считает открытые стадии и себя', () => {
  const evs = [
    ev('a1', 'started', '2026-11-10T10:00:00.000Z', 'T-001'),
    ev('a2', 'started', '2026-11-10T10:01:00.000Z', 'T-002'),
    ev('a3', 'started', '2026-11-10T10:02:00.000Z', 'T-003'),
    ev('a3', 'finished', '2026-11-10T10:05:00.000Z', 'T-003'),
  ]
  const self = ev('a1', 'finished', '2026-11-10T10:10:00.000Z', 'T-001')
  assert.deepEqual(concurrencyAt(evs.concat(self), self), { stages: 2 })
})

test('брошенная стадия не надувает число вечно: отсечка восемь часов', () => {
  const evs = [
    ev('a1', 'started', '2026-11-10T10:00:00.000Z'),
    ev('old', 'started', '2026-11-09T10:00:00.000Z', 'T-009'),
  ]
  const self = ev('a1', 'finished', '2026-11-10T10:10:00.000Z')
  assert.deepEqual(concurrencyAt(evs.concat(self), self), { stages: 1 })
})

test('стадия, начавшаяся ПОСЛЕ этого финиша, не считается', () => {
  const evs = [
    ev('a1', 'started', '2026-11-10T10:00:00.000Z'),
    ev('later', 'started', '2026-11-10T11:00:00.000Z', 'T-002'),
  ]
  const self = ev('a1', 'finished', '2026-11-10T10:10:00.000Z')
  assert.deepEqual(concurrencyAt(evs.concat(self), self), { stages: 1 })
})

test('без agent_id ответ null — «не знаю», а не нуль (И-12)', () => {
  const self = { event: 'finished', ts: '2026-11-10T10:10:00.000Z', ticket: 'T-001' }
  assert.equal(concurrencyAt([self], self), null)
})

test('полоса в числе одновременности считается только при названных потолках', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: LANES })
  writeTask(p, 'T-001', { labels: ['требует-браузера'] })
  writeTask(p, 'T-002', { labels: ['требует-браузера'] })
  writeTask(p, 'T-003', { labels: [] })
  const byId = new Map(listTasks(p.root, p.change).map((x) => [x.id, x]))

  const evs = [
    ev('a1', 'started', '2026-11-10T10:00:00.000Z', 'T-001'),
    ev('a2', 'started', '2026-11-10T10:01:00.000Z', 'T-002'),
    ev('a3', 'started', '2026-11-10T10:02:00.000Z', 'T-003'),
  ]
  const self = ev('a1', 'finished', '2026-11-10T10:10:00.000Z', 'T-001')
  const caps = laneCaps({ lanes: { 'требует-браузера': 1 } })

  // Три стадии разом, из них две — браузерные.
  assert.deepEqual(concurrencyAt(evs.concat(self), self, { taskById: byId, caps }), { stages: 3, lane: 2 })
  // Задача вне полос поля `lane` не получает: нуль там читался бы как замер.
  const selfPlain = ev('a3', 'finished', '2026-11-10T10:10:00.000Z', 'T-003')
  assert.deepEqual(
    concurrencyAt(evs.concat(selfPlain), selfPlain, { taskById: byId, caps }),
    { stages: 3 },
  )
})

// ── Сквозное: хук ставит число на закрывающее событие ───────────────────────
//
// Поле считается не «где-то в библиотеке», а в том событии, по которому потом судят отказ
// стадии. Поэтому проверка идёт через настоящий хук `SubagentStop`, как и у расхода
// токенов: мимо хука поле могло бы не доехать, и тест этого не увидел бы.

const SO = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput',
    input: { status: 'ok', report: { passed: 2, failed: 0, skipped: 0 },
      mutation_check: { done: true, evidence: 'сломал знак — упало 2 теста' } } }] },
}

function stopTester(p, { agentId = 'c-1', ticket = 'T-001' } = {}) {
  const path = join(p.root, `agent-${agentId}.jsonl`)
  writeFileSync(path, JSON.stringify(SO) + '\n')
  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-tester', hook_event_name: 'SubagentStop', cwd: p.root, agent_id: agentId,
      prompt: `FIRM2-TICKET: ${ticket}\nFIRM2-CHANGE: ${p.change}`, last_assistant_message: 'ok',
      agent_transcript_path: path,
    }),
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
}

test('закрывающее событие стадии несёт concurrent_stages, считая открытые стадии соседей', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: LANES })
  // Время стартов — ОТНОСИТЕЛЬНОЕ, и это не стиль. Финиш здесь пишет настоящий хук, то есть
  // его `ts` — текущее время, а замер одновременности считает открытую стадию брошенной
  // через восемь часов. С литералом «10:00» тест был бомбой с часовым механизмом: он
  // зеленел весь день и начинал падать, когда настоящие часы доходили до 18:00 UTC. Ровно
  // это и случилось 10.11.2026. Порог измеряется от замера, значит и оснастка обязана
  // ставить время от замера, а не от календаря.
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
  writeTask(p, 'T-001', { labels: ['требует-браузера'] })
  writeTask(p, 'T-002', { labels: ['требует-браузера'] })
  writeTask(p, 'T-003', { labels: [] })

  // Два соседа открыты (есть `started`, финиша нет), третий закрыт — его не считаем.
  for (const [id, agent] of [['T-002', 'n-2'], ['T-003', 'n-3']]) {
    writeEvent(p.root, {
      ts: ago(10), change: p.change, ticket: id, stage: 'test',
      event: 'started', actor: 'firm2:firm-tester', agent_id: agent,
    })
  }
  writeEvent(p.root, {
    ts: ago(10), change: p.change, ticket: 'T-001', stage: 'test',
    event: 'started', actor: 'firm2:firm-tester', agent_id: 'c-1',
  })

  stopTester(p, { agentId: 'c-1', ticket: 'T-001' })

  const evs = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
  const fin = evs.find((e) => e.event === 'finished' && e.agent_id === 'c-1')
  assert.ok(fin, 'финиш записан')
  assert.equal(fin.concurrent_stages, 3, 'две открытые стадии соседей плюс своя')
  assert.equal(fin.concurrent_lane, 2, 'из них в полосе «требует-браузера» — две')
})

test('на старте стадии числа одновременности нет: вопрос про другой момент', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = join(p.root, 'agent-start.jsonl')
  writeFileSync(path, JSON.stringify(SO) + '\n')
  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-tester', hook_event_name: 'SubagentStart', cwd: p.root, agent_id: 's-1',
      prompt: `FIRM2-TICKET: T-001\nFIRM2-CHANGE: ${p.change}`, agent_transcript_path: path,
    }),
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const evs = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
  const st = evs.find((e) => e.event === 'started')
  assert.ok(st)
  assert.equal(st.concurrent_stages, undefined)
})
