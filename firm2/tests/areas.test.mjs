// Пометки задачи против её фактического диффа. Замер обкатки проект-В 05.10.2026 по 66
// влитым задачам, классифицированным ПО ДИФФУ, а не по флагу: смешанные (экран + сервер)
// дали 1.95 бага на задачу против 1.09 у чисто серверных, и 77% этих дефектов нашёл
// человек на демо. Сам флаг `ui` расходился с диффом у 13 задач из 66 в обе стороны —
// T-001 правил 14 файлов `web/` при `ui: false`, то есть не ходил к Дизайнеру.
//
// Движок не запрещает и не правит: он называет расхождение. И молчит, когда областей в
// конфиге нет, — выдумать «web/ — это экран» за проект значит соврать в половине
// проектов (ADR-0007). Проверяется поэтому и то, и другое: что говорит, и что молчит.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { areaRules, areasOfFiles, filesByTask, areaFindings } from '../scripts/lib/firm.mjs'
import { buildDashboard } from '../scripts/dashboard.mjs'
import { makeProject, COMMIT_DATE } from './helpers.mjs'
import { execFileSync } from 'node:child_process'

const RULES = [
  { name: 'ui', prefixes: ['web/'] },
  { name: 'server', prefixes: ['app/', 'api/'] },
]
const AREAS_CONFIG = 'areas:\n  ui: "web/"\n  server: "app/, api/"\n'

// Коммит задачи в ветке поставки — с заголовком того формата, который движок сам и велит
// ролям (`commitRule`: `feat(T-XXX): …`). Привязка файлов к задаче держится на нём.
function taskCommit(p, subject, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(p.root, rel)), { recursive: true })
    writeFileSync(join(p.root, rel), text)
  }
  p.git('add', '-A')
  execFileSync('git', ['-C', p.root, 'commit', '-qm', subject], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...p.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  })
}

function writeTask(p, id, { ui = false, labels = [] } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: todo\n` +
      (ui ? 'ui: true\n' : '') +
      (labels.length ? `labels: [${labels.join(', ')}]\n` : '') +
      '---\n\nПроверочная задача.\n\n- [ ] критерий один\n',
  )
}

// ── Разбор конфигурации ──────────────────────────────────────────────────────

test('areaRules: одна область и перечисление через запятую', (t) => {
  void t
  assert.deepEqual(areaRules({ areas: { ui: 'web/' } }), [{ name: 'ui', prefixes: ['web/'] }])
  assert.deepEqual(areaRules({ areas: { ui: 'web/', server: 'app/, api/' } }), RULES)
})

test('areaRules: нет секции или пустые значения — правил нет, и вся проверка молчит', (t) => {
  void t
  for (const cfg of [null, {}, { areas: null }, { areas: 'web/' }, { areas: { ui: '' } }, { areas: { ui: ' , ' } }]) {
    assert.deepEqual(areaRules(cfg), [], `конфиг ${JSON.stringify(cfg)} правил давать не должен`)
  }
})

test('areasOfFiles: совпадение по началу пути и точное совпадение', (t) => {
  void t
  assert.deepEqual([...areasOfFiles(['web/app/page.tsx'], RULES)], ['ui'])
  assert.deepEqual([...areasOfFiles(['app/main.py', 'api/v1.py'], RULES)], ['server'])
  assert.deepEqual([...areasOfFiles(['web/a.tsx', 'app/b.py'], RULES)].sort(), ['server', 'ui'])
  assert.deepEqual([...areasOfFiles(['docs/readme.md', 'webhooks.py'], RULES)], [],
    'сравнение по началу пути: `webhooks.py` — не каталог `web/`')
  assert.deepEqual([...areasOfFiles(['web/'], RULES)], ['ui'], 'точное совпадение с префиксом — тоже попадание')
})

// ── Разбор истории поставки ──────────────────────────────────────────────────

test('filesByTask: файлы разложены по номеру задачи из заголовка коммита', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002')
  p.git('add', '-A')
  p.git('commit', '-qm', 'задачи поставки')
  taskCommit(p, 'feat(T-001): экран списка', { 'web/list.tsx': 'экран\n' })

  // Вторая задача приходит своей веткой и вливается без перемотки — как в маршруте.
  p.git('checkout', '-q', '-b', 'task/T-002')
  taskCommit(p, 'fix(T-002,BUG-001): разбор ответа сервера', { 'app/parse.py': 'сервер\n' })
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '--no-edit', '-m', 'merge(T-003): влитие ветки задачи', 'task/T-002')

  // Номер, упомянутый в прозе, задачей коммита не делает: привязка держится на формате
  // движка `feat(T-XXX): …`, а не на любом вхождении номера в заголовок.
  taskCommit(p, 'chore: правка по следам T-009', { 'docs/note.md': 'заметка\n' })

  const by = filesByTask(p.root, p.change)
  assert.deepEqual([...(by.get('T-001') || [])], ['web/list.tsx'])
  assert.deepEqual([...(by.get('T-002') || [])], ['app/parse.py'])
  assert.equal(by.has('T-003'), false,
    'мерж-коммит содержимого не добавляет: оно уже посчитано по исходным коммитам')
  assert.equal([...(by.get('T-001') || [])].includes('.gitignore'), false,
    'коммит без номера задачи в заголовке ничьим не считается')
  assert.equal(by.has('T-009'), false,
    'упоминание номера в прозе — не формат движка, и файлы по нему не раздаются')
})

test('filesByTask: нет такой ветки или нет change — пустая карта, а не падение', (t) => {
  const p = makeProject(t, { tasks: [] })
  assert.equal(filesByTask(p.root, null).size, 0)
  assert.equal(filesByTask(p.root, 'нет-такой-поставки').size, 0)
})

// ── Находки ──────────────────────────────────────────────────────────────────

const only = (task, files) => areaFindings(task, new Set(files), RULES)

test('находка: правит экран при ui: false', (t) => {
  void t
  const out = only({ id: 'T-001', ui: false, labels: ['требует-браузера'] }, ['web/a.tsx'])
  assert.equal(out.length, 1, out.join(' | '))
  assert.match(out[0], /T-001: правит экран, но стоит ui: false/)
  assert.match(out[0], /Дизайнер/, 'цена расхождения — несверенный макет, её и надо назвать')
})

test('находка: ui: true без единого файла экрана', (t) => {
  void t
  const out = only({ id: 'T-052', ui: true, labels: [] }, ['app/main.py'])
  assert.deepEqual(out, ['T-052: помечена ui: true, но ни одного файла экрана не тронула'])
})

test('находка: экран без метки «требует-браузера»', (t) => {
  void t
  const out = only({ id: 'T-003', ui: true, labels: [] }, ['web/a.tsx'])
  assert.equal(out.length, 1, out.join(' | '))
  assert.match(out[0], /без метки «требует-браузера» — живой проверки не было/)
})

test('находка: смешанная задача — экран и сервер разом', (t) => {
  void t
  const out = only({ id: 'T-004', ui: true, labels: ['требует-браузера'] }, ['web/a.tsx', 'api/v1.py'])
  assert.equal(out.length, 1, out.join(' | '))
  assert.match(out[0], /T-004: смешанная — правит и экран, и server/)
  assert.match(out[0], /77%/, 'без числа это просто вкусовое замечание')
})

test('всё сходится — находок нет; и их нет никогда без объявленных областей', (t) => {
  void t
  const good = { id: 'T-005', ui: true, labels: ['требует-браузера'] }
  assert.deepEqual(only(good, ['web/a.tsx']), [])
  assert.deepEqual(only({ id: 'T-006', ui: false, labels: [] }, ['app/main.py']), [],
    'чисто серверная задача претензий не вызывает')

  // Области не объявлены — проверки нет вовсе, даже самой вопиющей.
  const loud = { id: 'T-007', ui: false, labels: [] }
  assert.deepEqual(areaFindings(loud, new Set(['web/a.tsx', 'app/b.py']), []), [])
  assert.deepEqual(areaFindings(loud, new Set(), RULES), [], 'задача без диффа — не повод для разговора')
})

// ── Сверка говорит только про свежее слияние ─────────────────────────────────

test('sync: находки печатаются по свежеслитой задаче, а не по всем влитым', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: AREAS_CONFIG })
  writeTask(p, 'T-001')
  writeTask(p, 'T-002')
  p.git('add', '-A')
  p.git('commit', '-qm', 'задачи поставки')

  const land = (id, file) => {
    p.git('checkout', '-q', '-b', `task/${id}`)
    taskCommit(p, `feat(${id}): экран`, { [file]: 'экран\n' })
    p.git('checkout', '-q', `feature/${p.change}`)
    p.git('merge', '--no-ff', '--no-edit', '-m', `merge ${id}`, `task/${id}`)
  }

  land('T-001', 'web/one.tsx')
  const first = p.ev('sync')
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stderr, /T-001: правит экран, но стоит ui: false/)

  land('T-002', 'web/two.tsx')
  const second = p.ev('sync')
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stderr, /T-002: правит экран/, 'про свежеслитую сказать обязаны')
  assert.doesNotMatch(second.stderr, /T-001/,
    'сорок строк про давно влитое на каждом слиянии — шум, который перестают читать')
})

test('sync: без областей в конфиге сверка молчит', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeTask(p, 'T-001')
  p.git('add', '-A')
  p.git('commit', '-qm', 'задачи поставки')
  p.git('checkout', '-q', '-b', 'task/T-001')
  taskCommit(p, 'feat(T-001): экран', { 'web/one.tsx': 'экран\n' })
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '--no-edit', '-m', 'merge T-001', 'task/T-001')

  const r = p.ev('sync')
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stderr, /правит экран/,
    'области свои в каждом проекте: выдумать их за проект значит соврать в половине')
})

// ── Заметка на дашборде ──────────────────────────────────────────────────────

const html = (p) => readFileSync(buildDashboard(p.root, p.change), 'utf8')
const NOTE = /Пометки задач расходятся с тем, что они правили/

function scene(t, extraConfig) {
  const p = makeProject(t, { tasks: [], extraConfig })
  writeTask(p, 'T-001') // экран при ui: false
  writeTask(p, 'T-002', { ui: true, labels: ['требует-браузера'] }) // смешанная
  writeTask(p, 'T-003') // чисто серверная — к ней претензий нет
  p.git('add', '-A')
  p.git('commit', '-qm', 'задачи поставки')
  taskCommit(p, 'feat(T-001): экран', { 'web/one.tsx': 'экран\n' })
  taskCommit(p, 'feat(T-002): экран и сервер', { 'web/two.tsx': 'экран\n', 'api/two.py': 'сервер\n' })
  taskCommit(p, 'feat(T-003): сервер', { 'app/three.py': 'сервер\n' })
  return p
}

test('дашборд: без areas в конфиге заметки нет', (t) => {
  assert.doesNotMatch(html(scene(t, '')), NOTE)
})

test('дашборд: с areas заметка есть, и счётчик смешанных верен', (t) => {
  const h = html(scene(t, AREAS_CONFIG))
  assert.match(h, NOTE)
  assert.match(h, /T-001: правит экран, но стоит ui: false/)
  assert.match(h, /Смешанных задач \(правят и экран, и сервер\): <b>1<\/b>/,
    'смешанная тут одна — T-002; T-003 сервер не делает смешанной')
  assert.doesNotMatch(h, /T-003:/, 'чисто серверная задача в список расхождений не попадает')
})
