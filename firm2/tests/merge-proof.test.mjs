// Доказательство «влито» — мерж-коммит НА ВЕТКЕ ПОСТАВКИ, а не достижимый от её вершины
// (Д-29 проект-В 30.10.2026; признак не менялся с 0.4.38).
//
// `mergedTips()` обходил `git log feature/<поставка> --merges` без `--first-parent`, то есть
// брал все мерж-коммиты, достижимые от вершины. Слияния, сделанные ВНУТРИ ветки задачи,
// после её слияния становятся достижимы и начинают доказывать что угодно. ADR-0005 словами
// говорит «мерж-коммит на ветке поставки» — код реализовывал другое утверждение.
//
// Замер на живой поставке: 47 событий сверки, два ложных, и оба про задачи, которые в
// поставку не вливались, потому что были заменены. Первую дорогу к ошибке проложил сам
// движок (0.4.114): вершина ветки сохраняется меткой `refs/firm2/kept/T-XXX`, а заменяющая
// задача обязана внести работу заменённой — слить эту метку в свою ветку. Чем правильнее
// работает замена, тем надёжнее врала сверка.
//
// Здесь всё на настоящем git: признак про историю, и рассуждением его не проверить.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'

// Задача со своим коммитом в своей ветке. Возвращает вершину.
// Коммитится ТОЛЬКО файл работы: `add -A` затащил бы в ветку ещё и `.firm/events`, и
// слияние потом спорило бы с незакоммиченными событиями самого теста — шум, не признак.
function taskBranch(p, id, file = `${id}.txt`) {
  p.git('checkout', '-q', '-b', `task/${id}`, `feature/${p.change}`)
  writeFileSync(join(p.root, file), `работа ${id}\n`)
  p.git('add', file)
  p.git('commit', '-qm', `feat(${id}): работа`)
  const tip = p.git('rev-parse', 'HEAD').trim()
  p.git('checkout', '-q', `feature/${p.change}`)
  return tip
}

// `record` СТАВИТ файл события в индекс (так движок и работает: события слияния коммитит
// шаг слияния, ADR-0003). Незакоммиченный файл в индексе ломает `git merge` — поэтому в
// оснастке события коммитятся тем же ходом, что и в живом прогоне.
function commitEvents(p, msg = 'chore(firm2): события') {
  if (!p.git('status', '--short', '.firm/events').trim()) return
  p.git('add', '.firm/events')
  p.git('commit', '-qm', msg)
}

const mergeEvents = (p) =>
  p.eventFiles()
    .map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
    .filter((e) => e.stage === 'merge' && e.event === 'finished' && !e._corrected)

// Время старта разработки — РАНЬШЕ даты коммитов оснастки (`COMMIT_DATE`, 2026-09-30
// 15:04 +03:00): рядом в сверке стоит страховка «слияние не раньше, чем началась
// разработка», и события из будущего глушили бы её вместо проверяемого признака.
function devStarted(p, id, ts = '2026-09-30T09:00:00.000Z') {
  p.ev('record', '--ticket', id, '--stage', 'dev', '--event', 'started', '--actor', 'test', '--ts', ts)
}

test('Д-29: слияние ВНУТРЬ ветки чужой задачи влитости не доказывает', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  devStarted(p, 'T-001')
  devStarted(p, 'T-002')
  const tip1 = taskBranch(p, 'T-001')
  taskBranch(p, 'T-002')
  // T-002 подтягивает поставку в себя — штатный ход с 0.4.114 (Д-28). Но сперва пусть
  // вершина T-001 попадёт в ветку T-002 слиянием ВНУТРИ неё: это и есть ложное
  // доказательство, и оно станет достижимым, как только T-002 вольют.
  commitEvents(p)
  p.git('checkout', '-q', 'task/T-002')
  p.git('merge', '-q', '--no-ff', '-m', 'Merge task/T-001 into task/T-002', 'task/T-001')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '-q', '--no-ff', '-m', 'Merge task/T-002', 'task/T-002')

  p.ev('sync')
  const ev = mergeEvents(p)
  const ids = ev.map((e) => e.ticket).sort()
  assert.deepEqual(ids, ['T-002'], `влитой объявлена только T-002, а не ${ids.join(', ')}`)
  // Вершина T-001 физически достижима от поставки — именно на этом сверка и ошибалась.
  assert.ok(p.git('merge-base', '--is-ancestor', tip1, `feature/${p.change}`) === '', 'предпосылка теста в силе')
})

test('Д-29: перенос работы меткой в заменяющую задачу — не доказательство (штатный ход 0.4.114)', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  devStarted(p, 'T-001')
  devStarted(p, 'T-002')
  const tip1 = taskBranch(p, 'T-001')
  // Движок сохраняет вершину заменённой задачи ссылкой, а заменяющая вносит её работу.
  p.git('update-ref', 'refs/firm2/kept/T-001', tip1)
  taskBranch(p, 'T-002')
  commitEvents(p)
  p.git('checkout', '-q', 'task/T-002')
  p.git('merge', '-q', '--no-ff', '-m', "Merge tag 'keep/T-001' into task/T-002", 'refs/firm2/kept/T-001')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '-q', '--no-ff', '-m', 'Merge task/T-002', 'task/T-002')

  p.ev('sync')
  assert.deepEqual(mergeEvents(p).map((e) => e.ticket), ['T-002'], 'заменённая задача не влита, и сверка это знает')
})

test('Д-29: настоящее слияние по-прежнему доказывается — в том числе доведённое после конфликта', (t) => {
  // Сверка ради этого случая и существует: мерж, завершённый `git commit` после конфликта,
  // хука `post-merge` не вызывает. Такое слияние лежит на первой родительской цепочке.
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  p.git('checkout', '-q', '-b', 'task/T-001', `feature/${p.change}`)
  writeFileSync(join(p.root, 'спор.txt'), 'версия задачи\n')
  p.git('add', 'спор.txt'); p.git('commit', '-qm', 'feat(T-001): своя версия')
  p.git('checkout', '-q', `feature/${p.change}`)
  commitEvents(p)
  writeFileSync(join(p.root, 'спор.txt'), 'версия поставки\n')
  p.git('add', 'спор.txt'); p.git('commit', '-qm', 'chore: версия поставки')
  try {
    p.git('merge', '--no-ff', '-m', 'Merge task/T-001', 'task/T-001')
    assert.fail('ожидался конфликт')
  } catch { /* конфликт — он и нужен */ }
  writeFileSync(join(p.root, 'спор.txt'), 'разрешено человеком\n')
  p.git('add', 'спор.txt')
  p.git('commit', '-qm', 'Merge task/T-001 (конфликт разрешён руками)')

  p.ev('sync')
  const ev = mergeEvents(p)
  assert.deepEqual(ev.map((e) => e.ticket), ['T-001'], 'иначе сверка перестала бы делать свою работу')
  assert.match(ev[0].notes, /дописано сверкой/)
  assert.equal(ev[0].actor, 'reconcile')
})

test('Д-29: заменённой задаче сверка слияния не дописывает — вторая, независимая страховка', (t) => {
  // Сверка дописывает ПРОПУЩЕННОЕ, а у заменённой задачи слияние не пропущено: его не было
  // и не будет. На проект-В ложное событие пришло через семь минут после решения человека и
  // перебило его — задача читалась как влитая, а роль заменяющей была стёрта.
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  devStarted(p, 'T-001')
  devStarted(p, 'T-002')
  const tip1 = taskBranch(p, 'T-001')
  // Решение человека — ДО мерж-коммита оснастки (12:04 UTC): ровно порядок случая T-178,
  // где ложное доказательство пришло через семь минут после замены.
  p.ev('record', '--ticket', 'T-001', '--stage', 'lifecycle', '--event', 'superseded',
    '--actor', 'human', '--ts', '2026-09-30T10:00:00.000Z', '--notes', 'заменена T-002')
  commitEvents(p)
  // А теперь ПОДСУНЕМ ложное доказательство прямо на первую цепочку: пусть вершина T-001
  // окажется вторым родителем слияния поставки. Так выглядел случай T-150, где ветка
  // стояла на коммите поставки.
  p.git('merge', '-q', '--no-ff', '-m', 'Merge task/T-001', tip1)

  p.ev('sync')
  const ev = mergeEvents(p)
  assert.deepEqual(ev.map((e) => e.ticket), [], 'решение человека сильнее доказательства движка (ADR-0009)')
  const board = JSON.parse(p.cli('firm-state.mjs', ['board', '--root', p.root, '--json']).stdout)
  const task = board.tasks.find((x) => x.id === 'T-001')
  assert.equal(task.status, 'superseded', 'и статус остался тем, который записал человек')
})

test('Д-29: слияние ДО замены остаётся законным событием прошлого', (t) => {
  // Задачу могли влить, а потом заменить её предмет. Молчать тут было бы второй ошибкой —
  // противоположной, но такой же: журнал потерял бы настоящее слияние.
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  const tip = taskBranch(p, 'T-001')
  commitEvents(p)
  p.git('merge', '-q', '--no-ff', '-m', 'Merge task/T-001', tip)
  // Замена записана ПОЗЖЕ мерж-коммита (его время — 2026-09-30 12:04 UTC).
  p.ev('record', '--ticket', 'T-001', '--stage', 'lifecycle', '--event', 'superseded',
    '--actor', 'human', '--ts', '2026-10-29T18:42:24.000Z', '--notes', 'предмет заменён')
  p.ev('sync')
  assert.deepEqual(mergeEvents(p).map((e) => e.ticket), ['T-001'], 'настоящее слияние записано')
})
