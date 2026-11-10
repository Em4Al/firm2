// Проверяем ли мы то, что обещали проверять. Разбор поставки 3.1 на проект-В 11.10.2026:
// поставка трогала ТОЛЬКО интерфейс — 605 строк продукта против 8530 строк проверок, — и
// 1 ч 20 м машинного времени не дали ни строки кода. Обе эскалации были не про код:
//
//   T-086: «чип имени при 20 широких знаках = 199,03 px» посчитано арифметикой на
//          планировании; живой прогон дал 278,89, и схема задачи развалилась на стадии dev;
//   T-082: критерий требовал замерить состояние, которое не наступает нигде.
//
// Первое ловится механически — дробное число с единицей в критерии без названного
// источника замера. Второе регуляркой не поймать никогда: это закрывает правило промпта
// «на планировании мерить прогоном», и его держит рубеж, шаг 3з.
//
// Главная проверка здесь — не «находит», а «молчит, когда надо». Первый прогон по живому
// проекту дал восемь находок из восьми задач, и все восемь — на слове «граница объёма 3.1»,
// то есть на номере поставки. Проверка, срабатывающая всегда, не отличается от молчащей.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { criteriaFindings, criteriaLines } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

// Задача с критериями: оснастка пишет свой скелет, нам нужен свой раздел приёмки.
function task(p, id, { criteria = [], labels = [], measured = null, inventory = null } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: todo\nparallel_safe: true\n` +
      `labels: [${labels.join(', ')}]\n${measured ? `measured: ${measured}\n` : ''}` +
      `${inventory ? `inventory:\n${inventory.map((x) => `  - ${x}\n`).join('')}` : ''}---\n\n` +
      `## Критерии приёмки\n\n${criteria.map((c) => `- [ ] ${c}\n`).join('')}`,
  )
}

const find = (p) => criteriaFindings(p.root, p.change)

test('вычисленное число в критерии названо находкой', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['BR-136: колонка служебного текста всего 250,72 px — имя не влезает'] })

  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /T-001/)
  assert.match(f[0], /250,72 px/, 'находка обязана показать саму строку, а не просто номер задачи')
  assert.match(f[0], /measured/, 'и назвать, чем она снимается')
})

test('measured снимает находку: источник назван — спорить не о чем', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', {
    criteria: ['BR-136: колонка служебного текста всего 250,72 px'],
    measured: 'прогон Chrome 11.10.2026, 1024 px и потолок',
  })
  assert.deepEqual(find(p), [], 'движок не запрещает число, он требует назвать источник')
})

test('молчит там, где число — не вёрстка', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', {
    criteria: [
      'граница объёма 3.1: git diff не содержит файлов админки',   // номер поставки
      'BR-16: имя игрока не длиннее 20 символов',                   // правило продукта
      'BR-125: |центр плашки − центр карты| ≤ 1 px',                 // допуск
      'при 1440 px размер клетки равен размеру при 1024 px',         // инвариант, как и надо
      'версия движка 0.4.74 записана в .firm/config',                // версия
    ],
  })
  assert.deepEqual(find(p), [], 'восемь находок из восьми задач — это шум, а не проверка')
})

test('две и более браузерные задачи без общего стенда — находка', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран открывается'], labels: ['требует-браузера'] })
  task(p, 'T-002', { criteria: ['сцена строится'], labels: ['требует-браузера'] })

  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /browser_harness/, 'указатель на стенд — ключ конфига, сам стенд пишет проект')
  assert.match(f[0], /ПЕРВАЯ задача/, 'и сказано, как это чинится в плане, а не в пожеланиях')
  assert.match(f[0], /T-001, T-002/)
})

test('одна браузерная задача стендом не обязана', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран открывается'], labels: ['требует-браузера'] })
  assert.deepEqual(find(p), [], 'общий модуль на одного — абстракция ради абстракции')
})

test('стенд назван и существует — находки нет; назван и пропал — есть', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран открывается'], labels: ['требует-браузера'] })
  task(p, 'T-002', { criteria: ['сцена строится'], labels: ['требует-браузера'] })
  const cfgPath = join(p.root, '.firm', 'config')
  const was = readFileSync(cfgPath, 'utf8')

  writeFileSync(cfgPath, `${was}\nbrowser_harness: test/browser/support.mjs\n`)
  assert.equal(find(p).length, 1, 'файла нет — обещание конфига, которое некому сдержать')
  assert.match(find(p)[0], /а файла нет/)

  mkdirSync(join(p.root, 'test', 'browser'), { recursive: true })
  writeFileSync(join(p.root, 'test', 'browser', 'support.mjs'), 'export const build = () => null\n')
  assert.deepEqual(find(p), [], 'стенд есть — движку больше нечего сказать')
})

test('critериев в задаче может не быть вовсе — это не находка этой проверки', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: [] })
  assert.deepEqual(find(p), [])
  assert.deepEqual(criteriaLines('## Критерии\n\n- [x] сделано\n- [ ] не сделано\nпросто строка\n'), ['сделано', 'не сделано'])
})

test('находки доходят до build-args — их читают перед прогоном', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['колонка 250,72 px'], labels: ['требует-браузера'], measured: null })
  task(p, 'T-002', { criteria: ['сцена строится'], labels: ['требует-браузера'] })

  const b = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--json', '--root', p.root]).stdout)
  assert.ok(b.warnings.some((w) => /250,72 px/.test(w)), JSON.stringify(b.warnings))
  assert.ok(b.warnings.some((w) => /browser_harness/.test(w)), JSON.stringify(b.warnings))

  const c = JSON.parse(p.cli('firm-state.mjs', ['criteria', '--json', '--root', p.root]).stdout)
  assert.equal(c.findings.length, 2)
  assert.deepEqual(c.browser_tasks, ['T-001', 'T-002'])
  assert.equal(c.criteria_count['T-001'], 1, 'гейт видит и объём приёмки: 15 критериев на задачу — тоже цена')
})

// ── browser_binary: адрес бинаря браузера ────────────────────────────────────
// Приём тот же, что со стендом: движок держит АДРЕС, а не реализацию. Рецепт
// («headless-shell с --single-process») роль получает промптом, но путь промптом не
// передашь — в имени каталога стоит версия, и на каждой машине она своя.
test('бинарь назван и пропал — находка; отсутствие ключа находкой НЕ делаем', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран открывается'], labels: ['требует-браузера'] })
  const cfgPath = join(p.root, '.firm', 'config')
  const was = readFileSync(cfgPath, 'utf8')

  // Ключа нет — молчим: бинарь может быть не нужен вовсе, в сессии бывают браузерные
  // инструменты. Находка на пустом ключе шумела бы на каждом проекте.
  assert.deepEqual(find(p), [])

  writeFileSync(cfgPath, `${was}\nbrowser_binary: /nope/chrome-headless-shell\n`)
  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /browser_binary/)
  assert.match(f[0], /puppeteer\/browsers install/, 'находка говорит, чем лечится')

  writeFileSync(cfgPath, `${was}\nbrowser_binary: ${join(p.root, 'shell')}\n`)
  writeFileSync(join(p.root, 'shell'), '#!/bin/sh\n')
  assert.deepEqual(find(p), [], 'бинарь на месте — движку нечего сказать')
})

test('адрес бинаря доезжает до сборки: build-args и criteria', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран открывается'], labels: ['требует-браузера'] })
  const cfgPath = join(p.root, '.firm', 'config')
  const bin = join(p.root, 'shell')
  writeFileSync(join(p.root, 'shell'), '#!/bin/sh\n')
  writeFileSync(cfgPath, `${readFileSync(cfgPath, 'utf8')}\nbrowser_binary: ${bin}\n`)

  const b = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--json', '--root', p.root]).stdout)
  assert.equal(b.browser_binary, bin, 'без этого стадия ищет бинарь сама — а искать его негде')
  const c = JSON.parse(p.cli('firm-state.mjs', ['criteria', '--json', '--root', p.root]).stdout)
  assert.equal(c.browser_binary, bin)
})

// ── Квантор без множества (предложение проект-В 10.11.2026, разбор T-374) ──────
//
// Критерий «ни один тест экрана не покраснел» выглядит проверяемым и им не является:
// множество «тесты экрана» карточка не называет, и каждый заход добирает его своим грепом.
// Проверяем обе стороны, и вторая важнее: квантор над НАЗВАННЫМ множеством молчит, иначе
// находка сработает на каждой задаче с «все» в тексте и перестанет быть сигналом.

test('квантор без множества и без inventory — находка', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['задачный прогон зелен: ни один тест экрана не покраснел от смены умолчания'] })

  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /квантован по множеству/)
  assert.match(f[0], /inventory/)
})

test('тот же критерий с inventory — молчит', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', {
    criteria: ['задачный прогон зелен: ни один тест экрана не покраснел от смены умолчания'],
    inventory: ['web/test/browser/t141.mjs', 'web/test/browser/t171.mjs'],
  })

  assert.deepEqual(find(p), [])
})

test('квантор, называющий множество путём, — молчит и без inventory', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['каждый файл в web/test/browser/t1*.mjs зелен'] })

  assert.deepEqual(find(p), [])
})

test('квантор, называющий множество обратными кавычками, — молчит', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['все три обработчика (`create`, `update`, `delete`) проверяют права'] })

  assert.deepEqual(find(p), [])
})

test('кириллица: граница слова не ломает поиск квантора', (t) => {
  // `\b` в JS считает словом только ASCII, поэтому квантор ищется явным классом. Тест
  // держит именно это: «всевозможный» и «каждодневный» квантором НЕ являются.
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран открывается во всевозможных каждодневных сценариях показа'] })

  assert.deepEqual(find(p), [])
})

test('критерий без квантора вовсе — молчит', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { criteria: ['экран рисунка открывается и держит выбор после перезагрузки'] })

  assert.deepEqual(find(p), [])
})

// ── Номер ссылки множества не называет (поправка 10.11.2026) ────────────────
//
// Замер проект-В в день выпуска сторожа: по 49 карточкам поставки квантованных критериев 75,
// находками стали 29, а должны были 59 — и ВСЕ тридцать пропущенных заглушены только
// номером ссылки. В том проекте критерий по соглашению начинается с `BR-NNN:`, и голое
// `\d` в `NAMES_SET` читало цифру номера как «множество названо в себе». Слепое пятно
// лежало ровно там, где проект дисциплинирован.
//
// Вторая сторона замера здесь обязательна и важнее первой: лекарство «снимать все цифры»
// прошло бы первую проверку так же зелено и ослепило бы сторожа к законным перечням,
// названным числом элементов (у проект-В таких 16).

test('квантор с номером правила в начале — находка: номер множества не называет', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-370', { criteria: ['BR-241: ни один из четырёх файлов не поднимает карту владений без названного выбора'] })

  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /квантован по множеству/)
})

test('числа СЛОВОМ при номере ссылки тоже не называют множество', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-371', { criteria: ['BR-253: все шесть зелены при обоих значениях умолчания, предъявлено прогоном'] })

  assert.equal(find(p).length, 1)
})

test('ВТОРАЯ СТОРОНА: цифра НЕ из ссылки по-прежнему глушит находку', (t) => {
  // «из 4 файлов» называет множество числом элементов — это законно, и так было до
  // поправки. Если бы лекарство снимало все цифры, здесь появилась бы находка.
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-372', { criteria: ['BR-241: ни один из 4 файлов не поднимает карту владений'] })

  assert.deepEqual(find(p), [])
})

test('все виды номеров снимаются одним правилом, а похожее на номер слово — нет', () => {
  // ADR-, T-, BUG-, F-, E-, D-, G-, MR- той же семьи, что BR-. А «ГОСТ-7» не номер
  // движка, и цифру в нём снимать не за что.
  const strip = (l) => l.replace(/(?:BR|ADR|T|BUG|F|E|D|G|MR)-\d+/g, '')
  assert.equal(strip('ADR-9 / T-14 / BUG-220 / MR-3'), ' /  /  / ')
  assert.match(strip('каждый ответ по ГОСТ-7 валиден'), /7/)
})

// ── Критерий — логическая строка, а не физическая ───────────────────────────
//
// Вторая находка того же замера: `criteriaLines` брала только строки с `- [ ]` и
// выбрасывала продолжения переноса. Находка от этого зависела от того, где автор нажал
// Enter, а цитаты в ней рвались на полуслове.

test('продолжение переноса приклеивается к своему пункту', () => {
  assert.deepEqual(
    criteriaLines('- [ ] ни один тест экрана не покраснел\n      от смены умолчания\n- [x] второй\n'),
    ['ни один тест экрана не покраснел от смены умолчания', 'второй'],
  )
})

test('множество, названное во ВТОРОЙ строке критерия, глушит находку', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeFileSync(
    join(p.tasksPath, 'T-373.md'),
    '---\nid: T-373\ntitle: T-373\nstatus: todo\nparallel_safe: true\nlabels: []\n---\n\n' +
      '## Критерии приёмки\n\n- [ ] BR-241: ни один файл не поднимает карту владений\n' +
      '      без названного выбора — перечень в web/test/browser/t141.mjs\n',
  )
  assert.deepEqual(find(p), [], 'путь со второй строки виден так же, как с первой')
})

test('строка без отступа пункт закрывает: абзац под списком в критерий не затягивается', () => {
  assert.deepEqual(
    criteriaLines('- [ ] первый\n  продолжение\nобычный абзац\n  уже не продолжение\n'),
    ['первый продолжение'],
  )
})
