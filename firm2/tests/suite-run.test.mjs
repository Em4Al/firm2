// Долгий прогон набора: механика вместо просьбы (отчёт проект-В 03.11.2026, находка 5).
//
// Что чинится. Потолок одного вызова инструмента — 10 минут, полный набор проекта идёт 43,
// и роль упаковки оба захода увела его в фон и закончила ход. Во второй раз — при
// дословном запрете в промпте и с названной ценой первого случая. Значит держать это
// должен механизм: прогон переживает ход роли, ждётся короткими ожиданиями, а конец
// стадии при идущем прогоне виден в журнале событием, а не только на совести роли.
//
// Вторая половина находки — сводка. Роль назвала причину единственного красного по
// `PASSED`-строкам из середины лога, тогда как ответ (`pass 1103 / fail 2`) стоял в сводке
// раннера. Поэтому числа снимает скрипт, а не глаз.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'

const run = (p, argv) => {
  const r = p.cli('suite-run.mjs', [...argv, '--root', p.root])
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  return JSON.parse(r.stdout || '{}')
}

// Ждём итог короткими ожиданиями — так же, как это делает роль.
const waitDone = (p, id, limit = 30) => {
  for (let i = 0; i < limit; i++) {
    const s = run(p, ['wait', '--id', id, '--timeout', '3'])
    if (s.state !== 'running') return s
  }
  throw new Error(`прогон ${id} не кончился за ${limit} ожиданий`)
}

test('прогон переживает вызов: start отдаёт id, wait — итог и числа раннера', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, [
    'start', '--ticket', 'T-001', '--label', 'проба',
    '--cmd', 'echo "=== 2 failed, 1103 passed, 5 skipped in 2543.11s ==="; exit 1',
  ])
  assert.ok(started.id, 'id — это то, чем прогон потом находят')

  const done = waitDone(p, started.id)
  assert.equal(done.state, 'finished')
  assert.equal(done.exit_code, 1, 'код возврата — факт, и он не теряется')
  assert.equal(done.summary.runner, 'pytest')
  assert.equal(done.summary.passed, 1103)
  assert.equal(done.summary.failed, 2, 'ровно те числа, которые роль прочитала неверно по середине лога')
})

test('сводка не разобрана — скрипт говорит это, а не выдумывает числа', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, ['start', '--cmd', 'echo "какой-то чужой раннер сказал что-то своё"'])
  const done = waitDone(p, started.id)
  assert.equal(done.summary, null)
  assert.match(done.summary_why, /НЕ выдуманы/, 'ADR-0007: неопределённость не выдаётся за ответ')
  assert.match(done.tail, /чужой раннер/, 'хвост лога остаётся — по нему человек разберёт сам')
})

test('команда, кончающаяся на exit, всё равно оставляет код возврата', (t) => {
  // Без скобок вокруг команды `exit` выходил бы из той же оболочки, и строка с кодом не
  // писалась бы никогда: прогон кончился, а ожидание ждёт его до таймаута. Поймано первым
  // же зондом скрипта.
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, ['start', '--cmd', 'echo готово; exit 3'])
  const done = waitDone(p, started.id)
  assert.equal(done.state, 'finished')
  assert.equal(done.exit_code, 3)
})

test('wait не врёт про идущий прогон: возвращает running с длительностью', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, ['start', '--cmd', 'sleep 20'])
  const mid = run(p, ['wait', '--id', started.id, '--timeout', '2'])
  assert.equal(mid.state, 'running')
  assert.ok(mid.duration_s >= 0)
  assert.match(mid.note, /НЕ сбой/, 'ожидание — штатный ход, а не повод кончать ход роли')
  p.cli('suite-run.mjs', ['status', '--id', started.id, '--root', p.root])
  process.kill(started.pid, 'SIGKILL')
})

test('конец стадии при идущем прогоне: событие guard/suite-abandoned и возврат в работу', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Расписку прогона кладём руками — так же, как её кладёт `start`, но с тем `agent_id`,
  // который придёт в хук. Запускать настоящий `sleep` на 20 минут тест не станет.
  mkdirSync(join(p.root, '.firm', 'runs'), { recursive: true })
  writeFileSync(join(p.root, '.firm', 'runs', 'r1.json'), JSON.stringify({
    id: 'r1',
    cmd: 'uv run pytest',
    cwd: p.root,
    pid: process.pid,
    started: new Date().toISOString(),
    ticket: 'T-001',
    agent_id: 'ag-1',
  }))

  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-devops',
      hook_event_name: 'SubagentStop',
      cwd: p.root,
      agent_id: 'ag-1',
      session_id: 'sess-1',
    }),
  })
  // DevOps не ведёт стадию цикла, поэтому событие стадии он не пишет; признак брошенного
  // прогона от этого не зависит — он про факт, а не про роль.
  const files = p.eventFiles().filter((f) => /guard-suite-abandoned/.test(f))
  assert.equal(files.length, 1, `событие обязано быть: ${p.eventFiles().join(', ')}`)
  const e = JSON.parse(readFileSync(join(p.eventsPath, files[0]), 'utf8'))
  assert.match(e.notes, /uv run pytest/, 'в событии названа команда — иначе по нему нечего разбирать')
  assert.equal(r.status, 2, 'на SubagentStop это возвращает роль в работу: прогон надо дождаться')
  assert.match(`${r.stderr}`, /suite-run\.mjs" wait --id r1/, 'отказ несёт исполнимую команду с путём, а не совет')
})

test('кончившийся прогон брошенным не считается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(join(p.root, '.firm', 'runs'), { recursive: true })
  writeFileSync(join(p.root, '.firm', 'runs', 'r2.json'), JSON.stringify({
    id: 'r2', cmd: 'uv run pytest', cwd: p.root, pid: process.pid,
    started: new Date().toISOString(), ticket: 'T-001', agent_id: 'ag-2',
  }))
  writeFileSync(join(p.root, '.firm', 'runs', 'r2.code'), '0\n')

  p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-devops',
      hook_event_name: 'SubagentStop',
      cwd: p.root,
      agent_id: 'ag-2',
      session_id: 'sess-2',
    }),
  })
  assert.deepEqual(p.eventFiles().filter((f) => /suite-abandoned/.test(f)), [],
    'прогон с итогом на диске — это сделанная работа, а не брошенная')
})

test('чужой прогон стадию не держит: расписка помнит, кто запустил', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(join(p.root, '.firm', 'runs'), { recursive: true })
  writeFileSync(join(p.root, '.firm', 'runs', 'r3.json'), JSON.stringify({
    id: 'r3', cmd: 'uv run pytest', cwd: p.root, pid: process.pid,
    started: new Date().toISOString(), ticket: 'T-002', agent_id: 'кто-то-другой',
  }))

  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-devops',
      hook_event_name: 'SubagentStop',
      cwd: p.root,
      agent_id: 'ag-3',
      session_id: 'sess-3',
    }),
  })
  assert.notEqual(r.status, 2, 'держать роль за чужой прогон — это шум, который обесценит сигнал')
  assert.deepEqual(p.eventFiles().filter((f) => /suite-abandoned/.test(f)), [])
})

// ── Два одинаковых прогона из одного дерева (Д-59, отчёт проект-В 08.11.2026) ───
//
// Роль ворот запустила свой полный прогон одновременно с прогоном Оркестратора из того же
// дерева: два `npm run test:browser` состязались за браузеры, гейт упёрся в потолок 3600 с,
// и таймаут был объявлен КРАСНЫМ ПОСТАВКИ. В одиночку тот же гейт уложился в 2370 с, а
// ложное красное стоило часа разбора. Ни роль, ни Оркестратор чужого прогона не видели —
// значит видеть должен механизм: пересечение стоит в реестре.
test('второй такой же прогон из того же дерева отклоняется, и в отказе стоит id идущего', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const first = run(p, ['start', '--cwd', p.root, '--cmd', 'sleep 20'])
  const second = p.cli('suite-run.mjs', ['start', '--cwd', p.root, '--cmd', 'sleep 20', '--root', p.root])
  assert.equal(second.status, 2, second.stdout)
  assert.match(second.stderr, new RegExp(first.id), 'назван id идущего — по нему ждут, а не гадают')
  assert.match(second.stderr, /wait --id/, 'дан исполнимый выход: дождаться, а не запускать своё')
  assert.match(second.stderr, /allow-parallel/, 'и названа дверь для законного второго прогона')
})

test('тот же прогон с --allow-parallel проходит: запрет не абсолютный, а названный', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  run(p, ['start', '--cwd', p.root, '--cmd', 'sleep 20'])
  const second = run(p, ['start', '--cwd', p.root, '--cmd', 'sleep 20', '--allow-parallel'])
  assert.ok(second.id, 'решение человека движок не отменяет (ADR-0009)')
})

test('другая команда рядом — не отказ, но сказано, что дерево делится', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const first = run(p, ['start', '--cwd', p.root, '--cmd', 'sleep 20'])
  const second = run(p, ['start', '--cwd', p.root, '--cmd', 'sleep 21'])
  assert.ok(second.id, 'два разных набора рядом — законное состояние')
  assert.equal(second.running_nearby.length, 1)
  assert.equal(second.running_nearby[0].id, first.id)
  assert.match(second.nearby_why, /таймаут при соседе — не красное поставки/)
})

// ── Предъявление прогона воротам (Д-59, случай 1) ────────────────────────────
//
// Роль объявила шаг завершённым при `dod.checked: false` и двух файлах в состоянии
// «завершаются»: прозой это читается как отчёт о прогоне, машинно прогона не было.
test('proof: прогона нет — ok: false, и это ответ, а не ошибка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = run(p, ['proof', '--ticket', 'MR'])
  assert.equal(r.ok, false)
  assert.match(r.why, /не предъявил/, 'сказано именно то, чего не хватает')
})

test('proof: прогон идёт — шаг не кончен, и назван способ дождаться', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, ['start', '--ticket', 'MR', '--cmd', 'sleep 20'])
  const r = run(p, ['proof', '--ticket', 'MR'])
  assert.equal(r.ok, false)
  assert.match(r.why, new RegExp(started.id))
  assert.match(r.why, /wait --id/)
})

test('proof: прогон кончился — отдаёт id, код возврата и сводку, то есть то, что роль сказать не может', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, ['start', '--ticket', 'MR', '--cmd', 'echo "# pass 120"; echo "# fail 2"; exit 1'])
  waitDone(p, started.id)
  const r = run(p, ['proof', '--ticket', 'MR'])
  assert.equal(r.ok, true)
  assert.equal(r.proof.id, started.id)
  assert.equal(r.proof.exit_code, 1, 'код возврата — факт, и он в ответе')
  assert.equal(r.proof.summary.failed, 2, 'числа из сводки раннера, а не из пересказа')
})

test('proof: прогон под чужой привязкой за предъявление своей не считается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const started = run(p, ['start', '--ticket', 'T-001', '--cmd', 'echo ok'])
  waitDone(p, started.id)
  const r = run(p, ['proof', '--ticket', 'MR'])
  assert.equal(r.ok, false)
  assert.equal(r.runs.length, 0)
})
