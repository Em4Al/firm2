// Объявленные границы модулей против настоящего диффа поставки.
//
// Замер проект-В 3.2 (25.10.2026): Архитектор пишет в `design.md` решение «Границы модулей»
// деревом, где у каждой строки есть глагол — «правится», «НОВЫЙ», «НЕ меняется». Из восьми
// объявленных границ две были нарушены и прошли всю поставку незамеченными:
// `app/ruleset/schema.py` получил новое поле при «ни нового поля», `app/game/creation.py` —
// правку при «НЕ затронуты ни одной строкой».
//
// Тесты держат три границы, и каждая уже была неправдой:
//   1. дерево с отступами разбирается в ПОЛНЫЕ пути: `app/` + `ruleset/` + `schema.py`, а
//      не `app/app/ruleset/schema.py` (первая редакция складывала накопленные префиксы);
//   2. `\b` перед кириллицей не работает — в JS `\w` только ASCII, и `/\bНЕ/` не нашёл НИ
//      ОДНОГО объявления на живом документе, где их восемь;
//   3. молчание о границах — законный путь (ADR-0009): нет тех-спеки или нет блока — нет
//      находок, иначе проверка шумит на каждой поставке до первой настоящей находки.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { boundaryFindings, declaredBoundaries, declaredFrozen, designDoc } from '../scripts/lib/firm.mjs'
import { commitFile, makeProject } from './helpers.mjs'

const D9 = [
  '```',
  'app/',
  '  ruleset/',
  '    loader.py        правится: два корня, слияние вид за видом',
  '    errors.py        НЕ меняется: его текст и есть отказ записи',
  '    schema.py        НЕ меняется: ни нового поля, ни происхождения сущности',
  '  content/           НОВЫЙ ПАКЕТ — вся запись слоя',
  '  access/admin.py    НЕ меняется ВОВСЕ: тот же секрет, новой роли нет',
  '  game/, rules/,',
  '  store/             НЕ затронуты ни одной строкой: партия держит снимок',
  '```',
].join('\n')

function design(p, text) {
  const doc = designDoc(p.root, p.change)
  mkdirSync(dirname(doc), { recursive: true })
  writeFileSync(doc, `# Тех-спека\n\n## D9. Границы модулей\n\n${text}\n`)
  return doc
}

// Объявленные границы — существующие пути. В настоящем проекте это так по определению
// (граница говорит о том, что в коде есть), а в фикстуре файлы надо создать: иначе сверка
// честно скажет, что проверять ей нечем, — ровно та находка, которая заведена ниже.
//
// Создаются они на ВЕТКЕ-ЦЕЛИ и там же коммитятся: положи их в ветку поставки — и они сами
// попадут в её дифф, то есть фикстура начнёт нарушать объявленные ею же границы.
function materialize(p, text) {
  p.git('checkout', '-q', 'main')
  for (const f of declaredFrozen(text)) {
    const abs = join(p.root, f.path)
    const file = /\.\w+$/.test(f.path) ? abs : join(abs, '.keep')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '# заглушка границы\n')
  }
  p.git('add', '-A')
  p.git('commit', '-qm', 'база: файлы, о которых говорят границы')
  p.git('checkout', '-q', `feature/${p.change}`)
}

test('дерево с отступами разбирается в полные пути, а перечень делит пояснение', () => {
  const frozen = declaredFrozen(D9)
  assert.deepEqual(frozen.map((f) => f.path), [
    'app/ruleset/errors.py',
    'app/ruleset/schema.py',
    'app/access/admin.py',
    'app/game',
    'app/rules',
    'app/store',
  ], 'префиксы уровней не складываются между собой, а запятая переносит пояснение на весь перечень')
  assert.match(frozen[0].why, /НЕ меняется/)
})

test('«правится» и «НОВЫЙ» границей не объявляются', () => {
  const paths = declaredFrozen(D9).map((f) => f.path)
  assert.ok(!paths.includes('app/ruleset/loader.py'), 'файл, объявленный правимым, — обычная работа')
  assert.ok(!paths.includes('app/content'), 'новый пакет тем более')
})

test('кириллическое «НЕ» распознаётся: \\b перед ним в JS не работает', () => {
  // `/\bНЕ\s+меняется/` на этой строке не находит НИЧЕГО: `\w` в JS — только ASCII,
  // поэтому границы слова перед «Н» не возникает. На живом документе это дало ноль
  // находок там, где их восемь.
  assert.equal(declaredFrozen('```\na.py   НЕ меняется: причина\n```').length, 1)
  assert.equal(declaredFrozen('```\nb.py   кода НЕ меняет: причина\n```').length, 1, 'глагол бывает не первым словом')
})

test('файл, объявленный неизменным, но тронутый диффом, — находка с именем задачи', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, D9)
  design(p, D9)
  // Каталоги живут на ветке-цели, здесь их нет: правка создаёт их заново — это и есть
  // «дифф поставки трогает объявленную границу».
  mkdirSync(join(p.root, 'app', 'ruleset'), { recursive: true })
  commitFile(p, 'app/ruleset/schema.py', 'class Card:\n    own_skin_texts = None\n', 'feat(T-128): поле под скины')
  const f = boundaryFindings(p.root, p.change)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /app\/ruleset\/schema\.py/)
  assert.match(f[0], /T-128/, 'без номера задачи человек ищет виновника руками')
})

test('каталог, объявленный нетронутым, ловится по файлу внутри него', (t) => {
  const p = makeProject(t, { tasks: [] })
  design(p, D9)
  mkdirSync(join(p.root, 'app', 'game'), { recursive: true })
  commitFile(p, 'app/game/creation.py', 'def create():\n    pass\n', 'feat(T-132): отказ создания')
  assert.equal(boundaryFindings(p.root, p.change).filter((x) => /app\/game/.test(x)).length, 1)
})

test('правка файла, объявленного правимым, молчит', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, D9)
  design(p, D9)
  // Каталоги живут на ветке-цели, здесь их нет: правка создаёт их заново — это и есть
  // «дифф поставки трогает объявленную границу».
  mkdirSync(join(p.root, 'app', 'ruleset'), { recursive: true })
  commitFile(p, 'app/ruleset/loader.py', 'def load():\n    pass\n', 'feat(T-111): два корня')
  assert.deepEqual(boundaryFindings(p.root, p.change), [])
})

test('нет тех-спеки или нет блока границ — находок нет', (t) => {
  const p = makeProject(t, { tasks: [] })
  mkdirSync(join(p.root, 'app', 'ruleset'), { recursive: true })
  commitFile(p, 'app/ruleset/schema.py', 'x = 1\n', 'feat(T-001): что-то')
  assert.deepEqual(boundaryFindings(p.root, p.change), [], 'тех-спеки нет вовсе')
  design(p, 'Границы тут словами, без дерева: трогать ядро не будем.')
  assert.deepEqual(boundaryFindings(p.root, p.change), [], 'решение «границы не называю» законно (ADR-0009)')
})

test('отказ git — это «не знаю», а не «соблюдено»', (t) => {
  const p = makeProject(t, { tasks: [] })
  design(p, D9)
  const f = boundaryFindings(p.root, p.change, null, { base: 'нет-такой-ссылки', branch: 'и-такой-нет' })
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /сверка НЕ выполнена/)
})

// ── Границы, нарисованные ASCII-деревом (Д-47 проект-В, 04.11.2026) ────────────
//
// Архитектор рисует состав пакетов глифами (`├── admin.py`), и до 0.4.126 разбор этого не
// знал: головой строки оказывался `│`, имя файла уезжало в пояснение. Замер на живом
// `design.md` поставки G-014: 23 записи, `path` равен `│` во ВСЕХ. То есть шаг 4 маршрута
// оставался без машины ровно на той форме, которой состав пакетов и объявляется, — а
// объявление пакета `app/telegram/` лгало четырьмя способами одновременно и дожило до ворот.
const TREE = [
  '```',
  'app/',
  '├── telegram/              НОВЫЙ пакет: порт, адаптер, разбор команд',
  '│   ├── adapter.py         НОВЫЙ: реализация порта на HTTP-клиенте',
  '│   └── intents.py         НОВЫЙ: «обновление → намерение»',
  '├── access/',
  '│   ├── admin.py           НЕ меняется ни одной строкой: секрет Админа',
  '│   ├── entry.py           правится ОДНОЙ правкой: отказ мёртвой ссылки',
  '│   │                      ПЕРЕСМОТРЕНА 04.11.2026: прежнее «НЕ меняется ни одной» было шире',
  '│   └── codes.py           правится: новые коды отказов темы',
  '├── game/, rules/,',
  '│   store/                 НЕ затронуты ни одной строкой: партия держит снимок',
  '└── api/',
  '    ├── player.py          НЕ затронут ни одной строкой: игровой путь от телеграма НЕ зависит',
  '    └── realtime.py        НЕ затронут: шина уже умеет всё, что нужно',
  '```',
  '',
  '```',
  'web/src/',
  '├── screens/admin/',
  '│   └── AdminLogin.tsx     НЕ меняется ни одной строкой',
  '└── board/, skins/, ui/    НЕ затронуты ни одной строкой',
  '```',
].join('\n')

test('Д-47: дерево глифами разбирается в ПОЛНЫЕ пути, а не в глиф', () => {
  const d = declaredFrozen(TREE)
  const paths = d.map((x) => x.path)
  assert.equal(paths.some((p) => /[│├└─]/.test(p)), false, `глиф в пути: ${paths.join(', ')}`)
  for (const want of [
    'app/access/admin.py', 'app/game', 'app/rules', 'app/store',
    'app/api/player.py', 'app/api/realtime.py',
    'web/src/screens/admin/AdminLogin.tsx', 'web/src/board', 'web/src/skins', 'web/src/ui',
  ]) {
    assert.ok(paths.includes(want), `${want} не разобран: ${paths.join(', ')}`)
  }
})

test('Д-47: корень блока с косой внутри («web/src/») опознаётся как корень', () => {
  const d = declaredFrozen(TREE)
  assert.equal(d.some((x) => x.path === 'app/board' || x.path === 'app/ui'), false,
    'иначе вложенное наследует префикс ПРЕДЫДУЩЕГО корня, и путь выглядит настоящим, будучи ложным')
})

test('Д-47: правимое остаётся правимым, даже когда в пояснении дальше встретилось «НЕ меняется»', () => {
  const d = declaredFrozen(TREE)
  assert.equal(d.some((x) => x.path === 'app/access/entry.py'), false,
    'глагол читается в НАЧАЛЕ пояснения: иначе «правится … НЕ меняется» объявляется неизменным и даёт ложную находку')
  assert.equal(d.some((x) => x.path === 'app/access/codes.py'), false)
})

test('Д-47: продолжение пояснения не становится ни путём, ни границей', () => {
  const d = declaredFrozen(TREE)
  assert.equal(d.some((x) => /ПЕРЕСМОТРЕНА/.test(x.path)), false)
  assert.equal(d.some((x) => /^[А-Яа-я]/.test(x.path)), false, `проза в пути: ${d.map((x) => x.path).join(', ')}`)
})

test('Д-47: граница о ЗАВИСИМОСТИ называется отдельным родом — диффом она не проверяется', () => {
  const d = declaredFrozen([
    '```',
    'app/',
    '└── api/',
    '    └── player.py        НЕ зависит от телеграма ни одним импортом',
    '```',
  ].join('\n'))
  assert.equal(d.length, 1)
  assert.equal(d[0].kind, 'depends',
    'на G-014 «player.py не меняется» было выполнено буквально, а независимость отменил импорт в соседнем файле (BUG-101)')
})

// ── Граница, которую нечем проверить (замер 05.11.2026 на живых поставках) ───
//
// Сверка ищет объявленный путь в списке изменённых файлов. Путь, которого в ветке-цели
// нет, не совпадёт НИКОГДА — то есть обещание проходит ворота всегда, не будучи проверено
// ни разу. Замер по четырём живым проектам: 53 объявленные границы, таких две —
// `web/src/screens/player/.game-console-view` (это селектор CSS, а не файл) и
// `web/src/board/coinMark.tsx` (файла нет вовсе). Обе прошли ворота со словами
// «findings: []». Шума признак не даёт: 2 из 53, и обе находки настоящие.
//
// Тот же род, что `kind: depends`: границу, которую диффом не проверить, надо НАЗВАТЬ, а не
// молча зачесть — молчание сверки значит «не знаю», а не «соблюдено» (И-12).

test('граница названа путём, которого в ветке-цели нет, — находка, а не молчание', (t) => {
  const p = makeProject(t, { tasks: [] })
  design(p, '```\napp/view/.game-console-view   НЕ ТРОГАЕТСЯ: это область внутри экрана\n```')
  const f = boundaryFindings(p.root, p.change)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /такого пути в main нет/)
  assert.match(f[0], /сверить её диффом НЕЧЕМ/)
  assert.match(f[0], /назовите файл/, 'отказ без выхода роль обходит: сказано, чем заменить селектор')
})

test('существующий путь такой находки не даёт — проверка не шумит', (t) => {
  const p = makeProject(t, { tasks: [] })
  const text = '```\napp/access/admin.py   НЕ меняется ни одной строкой: секрет Админа\n```'
  materialize(p, text)
  design(p, text)
  assert.deepEqual(boundaryFindings(p.root, p.change), [])
})

test('граница о зависимости тоже обязана называть существующий путь', (t) => {
  const p = makeProject(t, { tasks: [] })
  design(p, '```\napp/api/player.py   НЕ зависит от телеграма ни одним импортом\n```')
  const f = boundaryFindings(p.root, p.change)
  assert.ok(f.some((x) => /такого пути в main нет/.test(x)),
    `иначе обещание о независимости висит на пути, которого нет: ${JSON.stringify(f)}`)
  // И сама независимость названа НЕ словом обычной границы. До 06.11.2026 такая запись
  // шла в ту же сверку, что «НЕ меняется», и при тронутом файле давала находку
  // «объявлен неизменным, а дифф его трогает» — про файл, который неизменным себя не
  // объявлял. Снять такую находку, не соврав, нельзя, а что нельзя снять честно — снимают
  // молчанием.
  assert.ok(f.some((x) => /объявлена как НЕЗАВИСИМОСТЬ/.test(x) && /диффом оно не проверяется/.test(x)),
    `род границы назван своим словом: ${JSON.stringify(f)}`)
  assert.equal(f.some((x) => /объявлен неизменным/.test(x)), false, 'и чужого слова в находке нет')
})

test('граница о зависимости не судится диффом: тронутый файл её не нарушает', (t) => {
  const p = makeProject(t, { tasks: [] })
  const text = '```\napp/api/player.py   НЕ зависит от телеграма ни одним импортом\n```'
  materialize(p, text)
  design(p, text)
  // Поставка файл правит — и это не нарушение: неизменности он не обещал. Обещал он
  // независимость, а её дифф не проверяет никак.
  mkdirSync(join(p.root, 'app', 'api'), { recursive: true })
  commitFile(p, 'app/api/player.py', '# правка игрового пути\n', 'feat(T-1): правка player.py')
  const f = boundaryFindings(p.root, p.change)
  assert.equal(f.some((x) => /объявлен неизменным/.test(x)), false,
    `чужое слово в находке: ${JSON.stringify(f)}`)
  assert.ok(f.some((x) => /объявлена как НЕЗАВИСИМОСТЬ/.test(x)),
    `род границы обязан быть назван, а не промолчать: ${JSON.stringify(f)}`)
})

// ── Перенос строки дерева — не новая запись (отчёт проект-В Д-54, 06.11.2026) ───
//
// В живом `design.md` строка не поместилась и пояснение продолжилось ниже, под колонкой
// пояснения. Разбор взял хвост переноса за отдельное имя и склеил его с каталогом
// предыдущего уровня: граница `web/src/screens/player/.game-console-view` — путь, которого
// нет нигде. Родня 0.4.126 (глифы дерева читались как путь `│`): разбор по-прежнему не
// отличал продолжение от записи. Автор при этом файл НАЗВАЛ — просто строка не поместилась,
// и находка 0.4.128 показывала ему не то слово.
test('Д-54: перенос пояснения не становится путём и дописывается к своей записи', () => {
  const d = declaredFrozen([
    '```',
    'web/src/',
    '└── screens/player/',
    '    ├── game.css        ПРАВИТСЯ: разрешение не гасить и прокрутка (D15). Правило',
    '    │                   .game-console-view .board-viewctl (:420) НЕ ТРОГАЕТСЯ',
    '    └── LobbyScreen.tsx НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ — органа в лобби нет',
    '```',
  ].join('\n'))
  assert.equal(d.some((x) => /game-console-view/.test(x.path)), false,
    `хвост переноса взят за путь: ${d.map((x) => x.path).join(', ')}`)
  assert.deepEqual(d.map((x) => x.path), ['web/src/screens/player/LobbyScreen.tsx'],
    'правимый файл границей не становится, а соседняя запись переносом не съедена')
})

test('Д-54: перенос не отменяет и не создаёт границу — глагол читается у своей записи', () => {
  const d = declaredFrozen([
    '```',
    'app/',
    '└── access/',
    '    ├── entry.py        правится ОДНОЙ правкой: отказ мёртвой ссылки',
    '    │                   ПЕРЕСМОТРЕНА 04.11.2026: прежнее «НЕ меняется ни одной» было шире',
    '    └── admin.py        НЕ меняется ни одной строкой: секрет Админа',
    '```',
  ].join('\n'))
  assert.deepEqual(d.map((x) => x.path), ['app/access/admin.py'],
    `перенос про ОТМЕНУ прежнего обещания прочитан как новое: ${JSON.stringify(d)}`)
  assert.match(d[0].why, /секрет Админа/)
})

test('Д-54: пояснение с переноса доезжает до человека целиком', () => {
  const d = declaredFrozen([
    '```',
    'app/',
    '└── api/',
    '    └── player.py       НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ — игровой путь живёт выше, и',
    '                        решение об этом стоит решением человека от 04.11.2026',
    '```',
  ].join('\n'))
  assert.equal(d.length, 1, JSON.stringify(d))
  assert.match(d[0].why, /решением человека от 04\.11\.2026/,
    'иначе человек читает половину правила, а вторая половина тихо пропадает')
})

// ── Условная граница: вердикт, область которого названа тикетами ──────────────
//
// Дополнение проект-В 08.11.2026 к Д-47. Семь «расхождений» сверки оказались артефактами
// ФОРМЫ объявления, и живой корпус показал, что форма эта господствует именно в
// содержательных местах: безусловные границы покрывают каталоги целиком, а интересные —
// всегда с условием. Запрещать её нельзя (заменить нечем), понимать прозу движок не станет.
// Третий путь машинный: условие обязано назвать тикеты, и тогда сверка судит границу против
// них. Формулировки ниже — дословно из живых design.md проект-В.
const COND = [
  '```',
  'web/',
  '  admin/           НЕ меняется, кроме образца типа в редакторе наборов карт (T-188)',
  '  src/fix/         НЕ ЗАТРОНУТЫ НИ ОДНОЙ СТРОКОЙ задачами починки T-365, T-366',
  '  legacy/          НЕ ЗАТРОНУТЫ НИ ОДНОЙ СТРОКОЙ тремя задачами починки',
  '```',
].join('\n')

test('исключение названо тикетом: правка этой задачи границу не нарушает', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, COND)
  design(p, COND)
  mkdirSync(join(p.root, 'web', 'admin'), { recursive: true })
  commitFile(p, 'web/admin/types.tsx', 'export const sample = 1\n', 'feat(T-188): образец типа в редакторе')
  const f = boundaryFindings(p.root, p.change).filter((x) => /web\/admin/.test(x))
  assert.deepEqual(f, [], 'сверка судит условие против названного тикета, а не против диффа поставки')
})

test('исключение названо, а трогает ЕЩЁ кто-то — находка называет чужих', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, COND)
  design(p, COND)
  mkdirSync(join(p.root, 'web', 'admin'), { recursive: true })
  commitFile(p, 'web/admin/types.tsx', 'export const sample = 1\n', 'feat(T-188): образец типа')
  commitFile(p, 'web/admin/roles.tsx', 'export const roles = []\n', 'feat(T-199): новая роль')
  const f = boundaryFindings(p.root, p.change).filter((x) => /web\/admin/.test(x))
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /T-199/, 'назван тот, кто не был исключением')
  assert.doesNotMatch(f[0], /кроме названного исключения \(T-188, T-199\)/, 'исключение не раздувается чужими')
})

test('обещание дано ПРО задачи, и нарушила его одна из них — находка', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, COND)
  design(p, COND)
  mkdirSync(join(p.root, 'web', 'src', 'fix'), { recursive: true })
  commitFile(p, 'web/src/fix/run.mjs', 'export const run = 1\n', 'fix(T-366): починка оснастки')
  const f = boundaryFindings(p.root, p.change).filter((x) => /src\/fix/.test(x))
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /T-366/)
  assert.match(f[0], /своей же областью/, 'сказано, чем именно нарушено')
})

test('обещание про задачи, а тронула чужая — обещания это не касается', (t) => {
  // «НЕ ЗАТРОНУТЫ тремя задачами починки» ничего не говорит про остальные задачи поставки,
  // и выдавать их правку за нарушение значило бы судить по прочитанному не тому.
  const p = makeProject(t, { tasks: [] })
  materialize(p, COND)
  design(p, COND)
  mkdirSync(join(p.root, 'web', 'src', 'fix'), { recursive: true })
  commitFile(p, 'web/src/fix/run.mjs', 'export const run = 1\n', 'feat(T-400): не починка')
  const f = boundaryFindings(p.root, p.change).filter((x) => /src\/fix/.test(x))
  assert.deepEqual(f, [])
})

test('условие без названных тикетов — находка, и она говорит, чего не хватает', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, COND)
  design(p, COND)
  mkdirSync(join(p.root, 'web', 'legacy'), { recursive: true })
  commitFile(p, 'web/legacy/old.tsx', 'export const old = 1\n', 'fix(T-365): починка записи')
  const f = boundaryFindings(p.root, p.change).filter((x) => /legacy/.test(x))
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /С УСЛОВИЕМ/)
  assert.match(f[0], /Назовите тикеты/)
  assert.match(f[0], /Число вместо имён/, 'назван ровно тот случай, где сверка встала бы')
})

test('условие с тикетами, но виновника коммиты не называют — сверка говорит «не выполнена»', (t) => {
  const p = makeProject(t, { tasks: [] })
  materialize(p, COND)
  design(p, COND)
  mkdirSync(join(p.root, 'web', 'admin'), { recursive: true })
  commitFile(p, 'web/admin/types.tsx', 'export const sample = 1\n', 'chore: правка без номера задачи')
  const f = boundaryFindings(p.root, p.change).filter((x) => /web\/admin/.test(x))
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /И-12/, 'молчание тут значило бы «соблюдено»')
})

// ── Два объявления об одном пути (F-048) ─────────────────────────────────────
test('один путь объявлен дважды с разными вердиктами — находка, решает последнее', (t) => {
  const p = makeProject(t, { tasks: [] })
  const twice = [
    '```',
    'web/results.tsx    ПРАВИТСЯ: сужение колонок (D14)',
    '```',
    '',
    'Ниже девятью разделами:',
    '',
    '```',
    'web/results.tsx    НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ: решение человека на воротах',
    '```',
  ].join('\n')
  materialize(p, twice)
  design(p, twice)
  mkdirSync(join(p.root, 'web'), { recursive: true })
  commitFile(p, 'web/results.tsx', 'export const r = 1\n', 'feat(T-300): сужение колонок')
  const f = boundaryFindings(p.root, p.change)
  const dbl = f.filter((x) => /сказано 2 раза/.test(x))
  assert.equal(dbl.length, 1, JSON.stringify(f))
  assert.match(dbl[0], /вердикты РАЗНЫЕ/)
  assert.match(dbl[0], /взяла ПОСЛЕДНЕЕ/)
  // Последнее объявление — «не затронут», значит правка этого пути и есть нарушение.
  assert.equal(f.filter((x) => /объявлен неизменным/.test(x)).length, 1, JSON.stringify(f))
})

test('один путь дважды с ОДНИМ вердиктом — не находка: повтор не противоречие', (t) => {
  const p = makeProject(t, { tasks: [] })
  const twice = [
    '```',
    'web/results.tsx    НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ: партия держит снимок',
    'web/results.tsx    НЕ МЕНЯЕТСЯ: то же решение, сказанное в составе пакета',
    '```',
  ].join('\n')
  materialize(p, twice)
  design(p, twice)
  assert.deepEqual(boundaryFindings(p.root, p.change), [])
})

// ── Привязка виновника на НАСТОЯЩЕМ мерже (замер проект-В 08.11.2026) ──────────
//
// Номера задач в сообщения коммитов доезжают: 186 заголовков из 196 за поставку G-018 несут
// `T-XXX`, а десять без номера (журнал, план, SDD, мерж поставки) не трогают продуктовые
// каталоги вовсе. Но у привязки есть ловушка, и она отменяет механизм целиком: при обходе
// `--first-parent` ответом на «кто тронул путь» становится ОДИН мерж поставки, а он тикета
// не несёт — то есть каждый путь каждой поставки привязался бы к безтикетному коммиту, и
// сверка условия объявила бы себя невыполненной на всём корпусе.
//
// Тест закрепляет посылку, а не опцию: история с ДВУМЯ родителями, и ответ — задача, а не
// мерж. На линейной истории признак не воспроизводится, поэтому мерж здесь настоящий.
test('виновника пути сверка находит через мерж задачи, а не упирается в безтикетный мерж', (t) => {
  const p = makeProject(t, { tasks: [] })
  const text = [
    '```',
    'web/admin/      НЕ меняется, кроме образца типа (T-188)',
    '```',
  ].join('\n')
  materialize(p, text)
  design(p, text)
  // Работа идёт в ветке задачи, как её ведёт сборка, и вливается мержем БЕЗ номера в
  // заголовке — ровно как мерж поставки у проект-В.
  p.git('checkout', '-q', '-b', 'task/T-188')
  mkdirSync(join(p.root, 'web', 'admin'), { recursive: true })
  commitFile(p, 'web/admin/types.tsx', 'export const sample = 1\n', 'feat(T-188): образец типа в редакторе')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '-m', 'Merge поставка: плоский рисунок клеток', 'task/T-188')

  const f = boundaryFindings(p.root, p.change).filter((x) => /web\/admin/.test(x))
  assert.deepEqual(f, [], 'исключение T-188 узнано через свой коммит, хотя сверху стоит мерж без номера')
})

test('та же история, но правка пришла от чужой задачи — находка называет её, а не мерж', (t) => {
  const p = makeProject(t, { tasks: [] })
  const text = [
    '```',
    'web/admin/      НЕ меняется, кроме образца типа (T-188)',
    '```',
  ].join('\n')
  materialize(p, text)
  design(p, text)
  p.git('checkout', '-q', '-b', 'task/T-199')
  mkdirSync(join(p.root, 'web', 'admin'), { recursive: true })
  commitFile(p, 'web/admin/roles.tsx', 'export const roles = []\n', 'feat(T-199): новая роль')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '-m', 'Merge поставка: роли', 'task/T-199')

  const f = boundaryFindings(p.root, p.change).filter((x) => /web\/admin/.test(x))
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /T-199/)
})

// ── Д-69: табличная форма границ ─────────────────────────────────────────────
//
// Замер Архитектора проект-В 09.11.2026: в таблицу «Границы, обещанные всей поставкой»
// добавлены две строки, а `declared` остался 15 — то есть сверка читала только ASCII-дерево,
// и часть объявленных границ не охранялась ничем. Узнать об этом можно было единственным
// способом: добавить строку и посмотреть на счётчик.
//
// Это та же болезнь, что Д-47 (сверка не читала дерево): признак требовал ОДНОЙ формы
// записи, а документ пишет человек — и пишет той формой, которая удобнее в этом месте.
test('Д-69: границы из таблицы читаются наравне с деревом', () => {
  const doc = [
    '## Границы, обещанные всей поставкой',
    '',
    '| Файл | Вердикт | Почему |',
    '| --- | --- | --- |',
    '| web/src/board.tsx | НЕ ТРОГАЕТСЯ | каркас доски вне поставки |',
    '| web/src/legend.tsx | правится | переносим легенду |',
    '',
    '```',
    'web/src/',
    '├── panel.tsx        НЕ ТРОГАЕТСЯ: реестр панелей',
    '```',
  ].join('\n')
  const all = declaredBoundaries(doc)
  assert.deepEqual(all.map((r) => r.path).sort(), ['web/src/board.tsx', 'web/src/legend.tsx', 'web/src/panel.tsx'])
  const frozen = declaredFrozen(doc).map((r) => r.path).sort()
  assert.deepEqual(frozen, ['web/src/board.tsx', 'web/src/panel.tsx'], '«правится» сверка не судит — ни в дереве, ни в таблице')
  assert.equal(all.find((r) => r.path === 'web/src/board.tsx').form, 'таблица', 'форма записи названа: по ней читают замер')
})

test('Д-69: условие с тикетами читается и в таблице — это и есть граница задачи', () => {
  const doc = [
    '| Файл | Вердикт |',
    '| --- | --- |',
    '| tests/test_gate.py | НЕ ТРОГАЕТСЯ, кроме T-404 |',
  ].join('\n')
  const rec = declaredFrozen(doc)[0]
  assert.equal(rec.path, 'tests/test_gate.py')
  assert.deepEqual(rec.cond, { kind: 'except', tickets: ['T-404'] })
})

test('Д-69: шапка, разделитель и проза за границы не принимаются', () => {
  const doc = [
    '| Файл | Вердикт | Почему |',
    '| --- | --- | --- |',
    '| Все экраны плеера | НЕ ТРОГАЮТСЯ | фраза, а не путь |',
    '| x | НЕ ТРОГАЕТСЯ | одна буква — не путь |',
  ].join('\n')
  assert.deepEqual(declaredBoundaries(doc), [], 'шум в таблице дороже молчания: он обесценивает проверку')
})

test('Д-69: тикеты условия берутся из самого условия, а не из пояснения', () => {
  // Живая строка проект-В: «НЕ ЗАТРОНУТ … задачами T-412, T-413: счёт запаса сделан T-399».
  // T-399 здесь — автор прошлой правки, а не область условия, и сверка находила ложное
  // нарушение «T-399 трогает путь».
  const doc = [
    '| Файл | Вердикт |',
    '| --- | --- |',
    '| web/src/boardSlack.ts | НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ задачами T-412, T-413: вход «рисунок» сделан T-399 |',
  ].join('\n')
  assert.deepEqual(declaredFrozen(doc)[0].cond.tickets, ['T-412', 'T-413'])
})

test('Д-69: условное объявление не считается спором с прежним «правится»', () => {
  // Два утверждения о разном: поставка файл правит, а названные задачи — нет. Архитектор
  // обязан писать границу задачи именно так, и находка здесь была бы шумом (замер: все три
  // «разных вердикта» на живом design.md проект-В оказались этой парой).
  const doc = [
    '```',
    'web/src/',
    '├── boardDrawing.ts   правится одной строкой умолчания (T-374)',
    '```',
    '',
    '| Файл | Вердикт |',
    '| --- | --- |',
    '| web/src/boardDrawing.ts | задачами T-412 и T-413 НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ |',
  ].join('\n')
  const text = doc
  assert.equal(declaredBoundaries(text).length, 2, 'оба объявления записаны — вопрос «сколько раз сказано» остаётся')
  // Находки двойного вердикта тут быть не должно; судит такую границу сверка по тикетам.
  assert.equal(declaredFrozen(text)[0].path, 'web/src/boardDrawing.ts')
})
