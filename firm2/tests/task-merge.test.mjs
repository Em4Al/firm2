// Конфликт файла задачи: класс, который движок создаёт сам (Д-56, отчёт проект-В 08.11.2026).
//
// За одну поставку слияние встало семь раз, и во всех семи конфликтующий файл один —
// `openspec/changes/<поставка>/tasks/T-XXX.md`. Роль в дереве задачи дописывает протокол,
// роль в главном дереве — раздел доработки, оба в конец после одного абзаца; git не сводит
// это в принципе. Ни одна сторона не ошиблась: файл append-only по замыслу (ADR-0006), а
// разделение труда предписано маршрутом. Разрешение у всех семи было механическим и
// одинаковым — хронологический порядок разделов, — то есть описывается правилом, а не
// суждением.
//
// Тесты держат границу этого правила, и граница важнее самого разрешения: правка выше
// общего начала — это ВЫБОР, и он остаётся человеку (ADR-0009).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject, commitFile } from './helpers.mjs'

// Пустая сторона (у проект-В так было у T-363) разрешения не требует: если сторона ничего не
// дописала, git сводит файл сам и конфликта не возникает вовсе. Поле `one_side_empty` в
// ответе скрипта остаётся для вырожденного случая — повторного запуска после частичного
// разрешения, — и говорит о нём признаком, а не прозой.

// Готовит ровно ту расстановку, что была у проект-В: общий файл задачи, затем два коммита —
// один на ветке поставки, другой на ветке задачи, — и каждый ДОПИСЫВАЕТ свой раздел.
function conflictOnTaskFile(p, { deliveryAdd = '\n## Доработка\n\nпо записи о дефекте\n', taskAdd = '\n## Протокол\n\nживая проверка\n' } = {}) {
  const rel = join(p.tasksDirRel, 'T-001.md')
  const common = '# T-001\n\n- [ ] критерий один\n'
  commitFile(p, rel, common, 'план задачи', '2026-11-08T10:00:00+03:00')
  p.git('checkout', '-q', '-b', 'task/T-001')
  if (taskAdd) commitFile(p, rel, common + taskAdd, 'протокол стадии', '2026-11-08T12:00:00+03:00')
  p.git('checkout', '-q', `feature/${p.change}`)
  if (deliveryAdd) commitFile(p, rel, common + deliveryAdd, 'доработка Архитектора', '2026-11-08T11:00:00+03:00')
  return { rel, common }
}

const mergeExpectingConflict = (p) => {
  try {
    p.git('merge', '--no-ff', '-m', 'merge task/T-001', 'task/T-001')
    return false
  } catch {
    return true
  }
}

const tm = (p, argv) => {
  const r = p.cli('task-merge.mjs', [...argv, '--root', p.root])
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  return JSON.parse(r.stdout || '{}')
}

test('дописали с двух сторон — разрешается правилом, и ни одна строка не теряется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const { rel, common } = conflictOnTaskFile(p)
  assert.ok(mergeExpectingConflict(p), 'расстановка воспроизводит сам конфликт, а не описывает его')

  const r = tm(p, ['--change', p.change])
  assert.equal(r.ok, true)
  assert.equal(r.resolved.length, 1)
  const text = readFileSync(join(p.root, rel), 'utf8')
  assert.ok(text.startsWith(common), 'общее начало осталось началом')
  assert.match(text, /## Протокол/, 'сторона задачи на месте')
  assert.match(text, /## Доработка/, 'сторона поставки на месте')
  assert.ok(
    text.indexOf('## Доработка') < text.indexOf('## Протокол'),
    'хронология: доработка написана в 11:00, протокол в 12:00 — что раньше, то выше',
  )
  assert.equal(r.resolved[0].order, 'поставка → задача')
  assert.equal(r.resolved[0].order_known, true, 'порядок взят у времени коммитов, а не угадан')
  // Файл поставлен в индекс — иначе мерж нечем завершить.
  assert.equal(p.git('diff', '--name-only', '--diff-filter=U').trim(), '')
  p.git('commit', '-qm', 'merge task/T-001')
  const parents = p.git('log', '-1', '--format=%P').trim().split(/\s+/)
  assert.equal(parents.length, 2, 'доказательство слияния остаётся прежним — второй родитель (ADR-0005)')
})

test('сторона ПРАВИЛА написанное выше — отказ: там выбор, и он человеку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const rel = join(p.tasksDirRel, 'T-001.md')
  const common = '# T-001\n\n- [ ] критерий один\n'
  commitFile(p, rel, common, 'план задачи', '2026-11-08T10:00:00+03:00')
  p.git('checkout', '-q', '-b', 'task/T-001')
  commitFile(p, rel, common + '\n## Протокол\n', 'протокол стадии', '2026-11-08T12:00:00+03:00')
  p.git('checkout', '-q', `feature/${p.change}`)
  commitFile(p, rel, '# T-001\n\n- [ ] критерий ПЕРЕПИСАН\n', 'арбитраж переписал критерий', '2026-11-08T11:00:00+03:00')
  assert.ok(mergeExpectingConflict(p))

  const r = tm(p, ['--change', p.change])
  assert.equal(r.ok, false)
  assert.equal(r.resolved.length, 0)
  assert.match(r.refused[0].why, /ADR-0009/, 'отказ назван решением о границе, а не сбоем')
  assert.notEqual(p.git('diff', '--name-only', '--diff-filter=U').trim(), '', 'конфликт оставлен человеку как был')
})

test('файл вне каталога задач поставки не трогается вовсе, и мерж не считается разобранным', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  commitFile(p, 'app.py', 'x = 1\n', 'код поставки', '2026-11-08T10:00:00+03:00')
  p.git('checkout', '-q', '-b', 'task/T-001')
  commitFile(p, 'app.py', 'x = 2\n', 'правка задачи', '2026-11-08T12:00:00+03:00')
  p.git('checkout', '-q', `feature/${p.change}`)
  commitFile(p, 'app.py', 'x = 3\n', 'правка поставки', '2026-11-08T11:00:00+03:00')
  assert.ok(mergeExpectingConflict(p))

  const r = tm(p, ['--change', p.change])
  assert.equal(r.ok, false, 'чужой файл в индексе — это не «готово»')
  assert.deepEqual(r.foreign, ['app.py'])
  assert.equal(readFileSync(join(p.root, 'app.py'), 'utf8').includes('<<<<<<<'), true, 'маркеры конфликта оставлены как есть')
})

test('без --change скрипт ничего не правит и печатает, зачем он', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conflictOnTaskFile(p)
  assert.ok(mergeExpectingConflict(p))
  const r = p.cli('task-merge.mjs', ['--root', p.root])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /ничего не правит/)
  assert.notEqual(p.git('diff', '--name-only', '--diff-filter=U').trim(), '', 'запуск «посмотреть» не означает правку')
})

// ── Д-68: стороны дописали РАЗНЫЕ разделы ───────────────────────────────────
//
// Отчёт проект-В 09.11.2026. Те же три задачи (T-409…T-411) дали один и тот же конфликт, и
// скрипт отказался от всех трёх: в ветке поставки раздел «Замечания» (дописал Архитектор,
// разбирая эскалацию), в ветке задачи — «Протокол проверки» (дописал исполнитель). Заголовки
// разные, общих строк не тронул никто, правильное сведение — объединение; человек свёл его
// трижды одинаково.
//
// Почему строчный признак видел замену: дерево задачи стояло на коммите ДО правки
// Архитектора, поэтому его сторона «переписала» то, чего у неё не было. То есть отказ был
// верен по своему признаку и преждевременен по сути — отсюда вторая попытка, разделами.
//
// Цена каждого такого случая выше, чем кажется: пока индекс главного дерева не сведён, git
// не начинает НИКАКОГО слияния, и один конфликт останавливает слияния всех остальных задач.
function sectionConflict(p) {
  const rel = join(p.tasksDirRel, 'T-001.md')
  const plan = '# T-001\n\n- [ ] критерий один\n\n## План\n\nшаг первый\n'
  const withNotes = plan + '\n## Замечания\n\nсторожей приписать задачам\n'
  // Общее начало несёт раздел Архитектора: дерево задачи подтягивало поставку на подготовке,
  // поэтому он попал в точку ветвления.
  commitFile(p, rel, withNotes, 'план и замечания', '2026-11-09T10:00:00+03:00')
  p.git('checkout', '-q', '-b', 'task/T-001')
  // А сторона задачи закоммичена из дерева, стоявшего на коммите ДО этой правки: раздела
  // Архитектора у неё нет вовсе, и свой протокол она дописала к старому тексту. Для git это
  // «переписала написанное выше» — отсюда и прежний отказ (Д-68).
  commitFile(p, rel, plan + '\n## Протокол проверки\n\n29 passed\n', 'протокол исполнителя', '2026-11-09T18:00:00+03:00')
  p.git('checkout', '-q', `feature/${p.change}`)
  // Сторона поставки тоже дописала свой раздел — иначе конфликта не было бы вовсе.
  commitFile(p, rel, withNotes + '\n## Арбитраж\n\nсторожа приписаны T-404\n', 'решение арбитража', '2026-11-09T17:00:00+03:00')
  return { rel, plan, withNotes }
}

test('Д-68: разные заголовки сводятся объединением, и ни один раздел не теряется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const { rel } = sectionConflict(p)
  assert.ok(mergeExpectingConflict(p), 'расстановка воспроизводит сам конфликт')

  const r = tm(p, ['--change', p.change])
  assert.equal(r.ok, true)
  assert.equal(r.resolved[0].by, 'разделы', 'сведено вторым признаком, и он назван')
  const text = readFileSync(join(p.root, rel), 'utf8')
  assert.match(text, /## План/)
  assert.match(text, /## Замечания/)
  assert.match(text, /## Протокол проверки/)
  assert.match(text, /## Арбитраж/)
  assert.match(text, /сторожей приписать задачам/, 'раздел, которого у стороны задачи не было, не потерян')
  assert.ok(text.indexOf('## План') < text.indexOf('## Замечания'), 'общий раздел остался на месте')
  assert.deepEqual(r.resolved[0].added_sections, { delivery: ['## Арбитраж'], task: ['## Протокол проверки'] })
  assert.equal(p.git('diff', '--name-only', '--diff-filter=U').trim(), '', 'файл поставлен в индекс')
})

test('Д-68: один и тот же заголовок с двух сторон — отказ, там выбор содержимого', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const rel = join(p.tasksDirRel, 'T-001.md')
  const common = '# T-001\n\n## План\n\nшаг\n'
  commitFile(p, rel, common, 'план', '2026-11-09T10:00:00+03:00')
  p.git('checkout', '-q', '-b', 'task/T-001')
  commitFile(p, rel, common + '\n## Протокол проверки\n\n9227 passed\n', 'протокол исполнителя', '2026-11-09T18:00:00+03:00')
  p.git('checkout', '-q', `feature/${p.change}`)
  commitFile(p, rel, common + '\n## Протокол проверки\n\nпрогон не предъявлен\n', 'протокол Архитектора', '2026-11-09T17:00:00+03:00')
  assert.ok(mergeExpectingConflict(p))

  const r = tm(p, ['--change', p.change])
  assert.equal(r.ok, false)
  assert.match(r.refused[0].why, /ADR-0009/)
  assert.notEqual(p.git('diff', '--name-only', '--diff-filter=U').trim(), '', 'конфликт оставлен человеку')
})

test('Д-68: правка ОБЩЕГО раздела разделами не сводится — это чужой текст', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const rel = join(p.tasksDirRel, 'T-001.md')
  const common = '# T-001\n\n## План\n\nшаг первый\n'
  commitFile(p, rel, common, 'план', '2026-11-09T10:00:00+03:00')
  p.git('checkout', '-q', '-b', 'task/T-001')
  commitFile(p, rel, common + '\n## Протокол\n\nготово\n', 'протокол', '2026-11-09T18:00:00+03:00')
  p.git('checkout', '-q', `feature/${p.change}`)
  commitFile(p, rel, '# T-001\n\n## План\n\nшаг ПЕРЕПИСАН\n', 'переписан план', '2026-11-09T17:00:00+03:00')
  assert.ok(mergeExpectingConflict(p))

  const r = tm(p, ['--change', p.change])
  assert.equal(r.ok, false)
  assert.equal(r.resolved.length, 0)
})
