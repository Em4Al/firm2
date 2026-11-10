// Брони номеров: один номер — один хозяин, даже когда спрашивают одновременно.
//
// Отчёт проект-В 03.11.2026, находка 4 (третий случай подряд: BUG-158, BUG-159, BUG-171).
// Номер выдавался «следующим свободным по `docs/bugs` главного дерева», а баг пишет роль
// В СВОЁМ рабочем дереве: в главном дереве его файла нет до слияния, и ветки задачи не
// читает никто. Два зовущих в одну минуту получали один и тот же номер, и расходилось это
// уже после записи — перенумерованием руками.
//
// Проверяется не «есть ли код брони», а само свойство: два независимых ПРОЦЕССА, зовущих
// выдачу разом, не получают общего номера. Внутри одного процесса это проверить нечем —
// гонка там не воспроизводится.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { nextIds } from '../scripts/lib/firm.mjs'
import { makeProject, SCRIPTS } from './helpers.mjs'

const bug = (p, id, title = 'проверочный баг') => {
  mkdirSync(join(p.root, 'docs', 'bugs'), { recursive: true })
  writeFileSync(join(p.root, 'docs', 'bugs', `${id}.md`), `---\nid: ${id}\nstatus: open\n---\n\n${title}\n`)
}

test('выдача номера бага КЛАДЁТ броню, и второй зовущий получает следующий', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-170')

  const first = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  const second = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)

  assert.equal(first.next, 'BUG-171')
  assert.equal(first.claimed, true, 'номер бага выдаётся с бронью по умолчанию')
  assert.equal(second.next, 'BUG-172', 'ровно это и было столкновением: раньше оба получали BUG-171')
  assert.ok(existsSync(join(p.root, '.firm', 'ids', 'BUG-171.json')), 'броня лежит в главном дереве — там, где журнал')
})

test('--peek смотрит, не занимая: сверке номер не нужен', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-170')

  const look = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--peek', '--root', p.root, '--json']).stdout)
  assert.equal(look.next, 'BUG-171')
  assert.equal(look.claimed, false)
  assert.equal(existsSync(join(p.root, '.firm', 'ids', 'BUG-171.json')), false, 'посмотреть — не взять')
})

test('номера задач по умолчанию НЕ бронируются, а по --claim бронируются', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })

  const plain = nextIds(p.root, { kind: 'task', count: 3 })
  assert.deepEqual(plain.ids, ['T-002', 'T-003', 'T-004'])
  assert.equal(plain.claimed, false, 'нарезку плана правят, и броня на двадцать номеров вперёд — мусор')

  const claimed = nextIds(p.root, { kind: 'task', count: 2, claim: true })
  assert.deepEqual(claimed.ids, ['T-002', 'T-003'])
  const after = nextIds(p.root, { kind: 'task', count: 1 })
  assert.equal(after.next, 'T-004', 'занятое броней считается занятым и для обычной выдачи')
})

test('два ПРОЦЕССА, спросившие разом, общего номера не получают', async (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-100')

  // Процессы запускаются ПО-НАСТОЯЩЕМУ одновременно: `spawn`, а не `spawnSync`. Синхронный
  // вызов выстроил бы их в очередь, и тест был бы зелёным даже на выдаче «по максимуму
  // каталога» — то есть доказывал бы не то, что утверждает. Первая редакция этого теста
  // была именно такой, и это ровно тот класс ошибки, который разбирают тесты движка про
  // мутацию: зелёный тест обязан уметь покраснеть.
  const one = () => new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [
      join(SCRIPTS, 'firm-state.mjs'), 'next-id', '--kind', 'bug', '--root', p.root, '--json',
    ], { cwd: p.root, env: p.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    ch.stdout.on('data', (d) => { out += d })
    ch.stderr.on('data', (d) => { err += d })
    ch.on('error', reject)
    ch.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`код ${code}: ${err}`))))
  })

  const outs = await Promise.all([one(), one(), one(), one(), one()])
  const ids = outs.map((o) => JSON.parse(o).next)
  assert.equal(new Set(ids).size, ids.length, `номера должны быть разными, пришло: ${ids.join(', ')}`)
})

test('броня не теряется, когда файла бага ещё нет ни в одном дереве', (t) => {
  // Главный случай находки: роль взяла номер, пишет файл у себя в worktree, и в это время
  // номер спрашивает Оркестратор из главного дерева.
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-157')

  const role = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  assert.equal(role.next, 'BUG-158')
  const orchestrator = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  assert.equal(orchestrator.next, 'BUG-159',
    'файла BUG-158 на диске нет и не будет до слияния — занятость держится броней, а не каталогом')
})

// ── Д-50: вид, которого распределитель не знает (проект-В, 05.11.2026) ─────────
//
// `next-id --kind adr` отдавал `{ kind: "task", id: "T-336" }`: неизвестный вид не
// отвергался, а подменялся задачным. Ответ внутренне честен — поле `kind` говорит «task», —
// но роль спрашивала про ADR и читает `id`, то есть PM записал бы в решение номер задачи.
// Это ровно тот класс, от которого распределитель номеров и существует, и он прошёл
// насквозь, потому что подмена МОЛЧИТ: отказ роль увидит, подмену нет.

const adr = (p, file) => {
  mkdirSync(join(p.root, 'docs', 'adr'), { recursive: true })
  writeFileSync(join(p.root, 'docs', 'adr', file), '# решение\n\n**Статус:** принято\n')
}

test('Д-50: неизвестный вид — ОТКАЗ с кодом 2, а не номер задачи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  for (const kind of ['dec', 'epic', 'g', 'ADR']) {
    const r = p.cli('firm-state.mjs', ['next-id', '--kind', kind, '--root', p.root, '--json'])
    assert.equal(r.status, 2, `${kind}: подмена молчит, отказ виден — поэтому отказ`)
    assert.equal(r.stdout.trim(), '', `${kind}: номера в ответе быть не должно вовсе`)
    assert.match(r.stderr, /неизвестный вид номера/)
    assert.match(r.stderr, /task, bug, br, adr/, 'отказ обязан назвать, что движок распределяет')
  }
})

test('Д-50: вид не назван вовсе — по-прежнему задача (умолчание, а не подмена)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.cli('firm-state.mjs', ['next-id', '--root', p.root, '--json'])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).kind, 'task')
})

test('Д-50: --kind adr выдаёт номер РЕШЕНИЯ по имени файла', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  adr(p, '0001-первое.md')
  adr(p, '0007-седьмое.md')
  const r = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'adr', '--root', p.root, '--json']).stdout)
  assert.equal(r.kind, 'adr')
  assert.equal(r.next, 'ADR-0008')
  assert.equal(r.max_used, 7)
  // Номер без имени файла не годится: ADR нумеруются именем и только им.
  assert.match(r.file_hint, /docs\/adr\/0008-/)
})

test('Д-50: потолок ADR считается по ЖИВЫМ линиям, а не по одному дереву (корень Д-46)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  adr(p, '0001-первое.md')
  p.git('add', '-A')
  p.git('commit', '-qm', 'первое решение')
  // Вторая живая линия: решение заведено на ветке груминга и в дерево ещё не влито. Ровно
  // замер проект-В 05.11.2026 — ADR-0037 и ADR-0038 лежали в дереве темы G-018, и потолок по
  // одному дереву выдал бы 0037 второй раз, то есть столкновение номеров.
  p.git('checkout', '-q', '-b', 'groom/G-001')
  adr(p, '0038-решение-темы.md')
  p.git('add', '-A')
  p.git('commit', '-qm', 'решение темы')
  p.git('checkout', '-q', `feature/${p.change}`)
  assert.equal(existsSync(join(p.root, 'docs', 'adr', '0038-решение-темы.md')), false, 'сцена: в дереве его нет')

  const wt = p.sibling('groom')
  p.git('worktree', 'add', '-q', wt, 'groom/G-001')
  const r = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'adr', '--root', p.root, '--json']).stdout)
  assert.equal(r.next, 'ADR-0039', `потолок по одному дереву дал бы ADR-0002: ${JSON.stringify(r)}`)
  assert.equal(r.ceiling_from, 'groom/G-001', 'откуда взят максимум — часть ответа: иначе роль ищет номер в docs/adr и не находит')
})

// ── Д-45: номер, занятый на ЖИВОЙ ЛИНИИ, а не в этом дереве ──────────────────
//
// Отчёт проект-В. Замер 06.11.2026 по тринадцати деревьям проект-В дал две разные вещи, и
// честно сказать надо обе:
//   - симптом отчёта («номера багов видят только главное дерево») сегодня не
//     воспроизводится: `repoRoot()` разрешает корень в ГЛАВНОЕ дерево через
//     `--git-common-dir`, то есть читающая сторона в своё дерево и не смотрит. Ни одной
//     брони, которой нет в главном дереве, по всем деревьям проект-В не нашлось;
//   - открытой осталась обратная дыра: номер, занятый файлом на ещё не влитой ВЕТКЕ, не
//     виден никому. Для багов живых случаев у проект-В ноль (все ветки отстают от main), но
//     для решений ровно эта дыра ЗАМЕРЕНА — Д-46, ADR-0037/0038 в дереве темы, — а читает
//     обе стороны один и тот же код. Поэтому потолок берётся по живым линиям для всех
//     видов, а не только для `adr`.
test('Д-45: номер бага с невлитой ветки занят — потолок считается по живым линиям', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-100')
  p.git('add', '-A')
  p.git('commit', '-qm', 'баг в дереве')
  p.git('checkout', '-q', '-b', 'groom/G-001')
  bug(p, 'BUG-140')
  p.git('add', '-A')
  p.git('commit', '-qm', 'баг темы')
  p.git('checkout', '-q', `feature/${p.change}`)
  assert.equal(existsSync(join(p.root, 'docs', 'bugs', 'BUG-140.md')), false, 'сцена: в дереве его нет')
  const wt = p.sibling('groom-bug')
  p.git('worktree', 'add', '-q', wt, 'groom/G-001')

  const r = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--peek', '--root', p.root, '--json']).stdout)
  assert.equal(r.next, 'BUG-141', `потолок по одному дереву выдал бы BUG-101 — номер, уже занятый: ${JSON.stringify(r)}`)
  assert.equal(r.ceiling_from, 'groom/G-001', 'откуда взят максимум — часть ответа: в docs/bugs этого номера роль не найдёт')
})

test('Д-45: то же для номера задачи — нарезка на ветке тоже занимает номера', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.git('checkout', '-q', '-b', 'groom/G-002')
  mkdirSync(join(p.root, 'openspec', 'changes', 'ch-темы', 'tasks'), { recursive: true })
  writeFileSync(join(p.root, 'openspec', 'changes', 'ch-темы', 'tasks', 'T-220.md'), '---\nid: T-220\nstatus: todo\n---\n')
  p.git('add', '-A')
  p.git('commit', '-qm', 'нарезка темы')
  p.git('checkout', '-q', `feature/${p.change}`)
  const wt = p.sibling('groom-task')
  p.git('worktree', 'add', '-q', wt, 'groom/G-002')

  const r = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'task', '--peek', '--root', p.root, '--json']).stdout)
  assert.equal(r.next, 'T-221', `номер задачи с невлитой ветки не увиден: ${JSON.stringify(r)}`)
  assert.equal(r.ceiling_from, 'groom/G-002')
})

test('Д-45: броня кладётся в ОДНО место на проект, а не в дерево зовущего', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-100')
  p.git('add', '-A')
  p.git('commit', '-qm', 'баг в дереве')
  p.git('checkout', '-q', '-b', 'groom/G-003')
  p.git('checkout', '-q', `feature/${p.change}`)
  const wt = p.sibling('groom-claim')
  p.git('worktree', 'add', '-q', wt, 'groom/G-003')

  // Зовут ИЗ дерева груминга, корнем называя его же: так зовёт роль, которой дерево дано
  // промптом. Броня обязана лечь в главное дерево — номер принадлежит проекту, а не ветке.
  const r = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', wt, '--json']).stdout)
  assert.equal(r.claimed, true)
  assert.ok(existsSync(join(p.root, '.firm', 'ids', `${r.next}.json`)),
    `броня ушла в дерево зовущего: главное дерево её не увидит, и второй груминг возьмёт тот же номер (${r.next})`)
  assert.equal(existsSync(join(wt, '.firm', 'ids', `${r.next}.json`)), false, 'и в своём дереве её нет')
})

// ── Освобождение брони: обратная сторона выдачи (06.11.2026) ─────────────────
//
// След нашёлся живым: в проект-В лежала броня `BUG-175` без файла бага — её положил
// ДИАГНОСТИЧЕСКИЙ вызов `next-id --kind bug` (у багов броня по умолчанию, и это лечило три
// столкновения подряд). Дороги назад не было вовсе: номер занят навсегда, снять его можно
// было только удалением файла руками, приёмом, нигде не описанным. Распределитель без
// освобождения монотонно раздувает нумерацию, а номер бага человек читает как счётчик.
test('броня с номера, которым ничего не названо, снимается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bug(p, 'BUG-100')
  const got = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  assert.equal(got.next, 'BUG-101')
  assert.ok(existsSync(join(p.root, '.firm', 'ids', 'BUG-101.json')))

  const back = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--release', 'BUG-101', '--root', p.root, '--json']).stdout)
  assert.equal(back.released, true)
  assert.equal(existsSync(join(p.root, '.firm', 'ids', 'BUG-101.json')), false, 'броня снята с диска')
  const again = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--peek', '--root', p.root, '--json']).stdout)
  assert.equal(again.next, 'BUG-101', 'и номер снова свободен — иначе освобождение ничего не освободило')
})

test('броня с номера, которым НАЗВАН файл, не снимается — отказ с кодом 2', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const got = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  bug(p, got.next, 'баг заведён этим номером')
  const r = p.cli('firm-state.mjs', ['next-id', '--release', got.next, '--root', p.root, '--json'])
  assert.equal(r.status, 2, 'молчаливое снятие читалось бы как «номер свободен» (И-12)')
  assert.equal((r.stdout || '').trim(), '', 'ответа в stdout нет')
  assert.match(r.stderr, /уже названо/)
  assert.ok(existsSync(join(p.root, '.firm', 'ids', `${got.next}.json`)), 'броня на месте')
})

test('освобождение того, чего нет, — ответ «нечего», а не ошибка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--release', 'BUG-900', '--root', p.root, '--json']).stdout)
  assert.equal(r.released, false)
  assert.match(r.why, /брони с таким номером нет/)
})

test('не номер вовсе — отказ, а не тихое «нечего освобождать»', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.cli('firm-state.mjs', ['next-id', '--release', 'docs/bugs', '--root', p.root, '--json'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /не похож на номер/)
})

// ── Петля сверки и броня в чужом коммите (случай проект-В 06.11.2026) ──────────
//
// Два следствия брони, названные проект-В после того, как он сам в них попался:
//   1. сверка номера зовётся тем же `next-id`, значит проверка результата создаёт бронь
//      ЗАНОВО: убрал за собой, переспросил «что теперь видит распределитель» — и начал
//      сначала. Выход из петли надо было УГАДАТЬ (не переспрашивать), а роль, которая не
//      знает, прочитает «после удаления номер снова занят» как «удаление не работает»;
//   2. броня кладётся в индекс, и `git add -A` перед коммитом поставки уносит её в чужой
//      коммит, не показав: у проект-В она чуть не уехала в коммит плана `2932eb61`.
test('выдача с бронью говорит вслух, что номер занят, и даёт дорогу назад', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const got = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  assert.equal(got.claimed, true)
  assert.match(got.note, /номер ЗАНЯТ этим вызовом/)
  assert.equal(got.verify, 'next-id --kind bug --peek', 'сверять — только --peek')
  assert.equal(got.release, `next-id --release ${got.next}`, 'дорога назад названа в самом ответе')
})

test('ответ освобождения сам предупреждает о петле сверки', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const got = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  const back = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--release', got.next, '--root', p.root, '--json']).stdout)
  assert.equal(back.released, true)
  assert.match(back.verify, /--peek/)
  assert.match(back.note, /займёт номер заново/, 'иначе уборка за собой приводит туда, откуда начали')
})

test('броня не попадает ни в индекс, ни в «git status» — чужой коммит её не унесёт', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const got = JSON.parse(p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json']).stdout)
  assert.ok(existsSync(join(p.root, '.firm', 'ids', `${got.next}.json`)), 'броня на диске есть')
  const status = p.git('status', '--short')
  assert.equal(/\.firm\/ids/.test(status), false, `броня видна в git status и уедет первым же add -A: ${status}`)
  // Защита от `git clean -fd` при этом не снята, а перенесена в игнор. Проверяем ПОСЫЛКУ
  // — что путь действительно ignored, — а не поведение `git clean`: живой вызов `clean`
  // заперт по меньшей мере в двух независимых средах (здесь песочницей, у проект-В правилом
  // доступа), то есть такой тест не прошёл бы ни у одной стороны. `check-ignore` не заперт
  // нигде. Остальное — документированный контракт git: ignored сносит только `-x`.
  const ignored = p.git('check-ignore', '-v', join('.firm', 'ids', `${got.next}.json`))
  assert.match(ignored, /\.firm\/\.gitignore/, 'игнор держит броню вне индекса, не отдавая её clean -fd')
  assert.match(ignored, /:\d+:ids\/\s/, 'и правило именно про каталог брони, а не случайное совпадение')
})

test('файл игнора объясняет себя и называет цену — его не примут за чужой мусор', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.cli('firm-state.mjs', ['next-id', '--kind', 'bug', '--root', p.root, '--json'])
  const text = readFileSync(join(p.root, '.firm', '.gitignore'), 'utf8')
  assert.match(text, /ids\//)
  assert.match(text, /git clean -fdx/, 'цена названа там, где её прочитают')
  assert.match(text, /ОКНО между выдачей номера и записью файла/,
    'и сказано, чего стоит потеря брони: окна, а не забытого номера')
  // Файл один на проект и он отслеживаемый — иначе игнор не спасёт от clean -fd сам себя.
  assert.match(p.git('ls-files', '--', '.firm/.gitignore'), /\.firm\/\.gitignore/)
})

// ── Д-75: бронь — запись О номере, а не место, им названное ──────────────────
//
// Отчёт проект-В 10.11.2026, предпусковая проверка четвёртого прогона G-020. `T-414` — замена
// исчерпавшей попытки `T-404`: номер взят штатно (`next-id --claim`), карточка им названа, —
// и `doctor` отвечал `ok: false`, называя «дубль» с местами `[…/tasks, .firm/ids]`. То есть
// штатный исход СВОЕЙ ЖЕ команды краснил сверку, а выхода у проекта не было: `--release` на
// названном номере отказывает по делу (бронь — последнее, что помнит о занятости), снести
// файл руками значит обойти защиту.
//
// Какая ветка ошибалась, сказал их замер: условие выполнялось у 40 номеров (1 задача + 39
// багов), названа одна задача — багов `duplicateIds` не перебирает вовсе. Молчащая ветка
// месяц жила на живых данных и не помешала ни разу; значит ошибка в задачной.
test('Д-75: номер с бронью И карточкой дублем не считается, и doctor зелен', (t) => {
  const p = makeProject(t, { tasks: ['T-414'] })
  // Бронь — ровно так, как её кладёт `next-id --claim`.
  const r = p.cli('firm-state.mjs', ['next-id', '--kind', 'task', '--claim', '--root', p.root, '--json'])
  const claimed = JSON.parse(r.stdout).next
  assert.ok(existsSync(join(p.root, '.firm', 'ids', `${claimed}.json`)), 'броня положена')
  // И карточка, названная ЗАБРОНИРОВАННЫМ номером: это и есть случай T-414.
  writeFileSync(join(p.tasksPath, `${claimed}.md`), `---\nid: ${claimed}\nstatus: todo\n---\n\n## Критерии приёмки\n- [ ] один\n`)

  const d = p.evJson('doctor')
  assert.deepEqual(d.json.duplicate_ids, [], 'штатный исход своей же команды не может быть находкой')
  assert.equal(d.json.ok, true, `doctor обязан быть зелен: ${JSON.stringify(d.json.duplicate_ids)}`)
})

test('Д-75, вторая сторона: одна карточка в двух живых поставках — по-прежнему находка', (t) => {
  // Признак годности сторожа двусторонний (приём проект-В от 10.11.2026): «перестало ловить
  // лишнее» плюс «ловит прежнее». Эту сторону они не мерили — воспроизведение требует
  // положить в репозиторий поддельную карточку, — поэтому она проверяется здесь.
  const p = makeProject(t, { tasks: ['T-500'] })
  const other = join(p.root, 'openspec', 'changes', 'second', 'tasks')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'T-500.md'), '---\nid: T-500\nstatus: todo\n---\n\n## Критерии приёмки\n- [ ] один\n')

  const d = p.evJson('doctor')
  assert.equal(d.json.duplicate_ids.length, 1, 'один номер в двух живых поставках склеит стадии в журнале')
  assert.equal(d.json.duplicate_ids[0].id, 'T-500')
  assert.equal(d.json.duplicate_ids[0].where.length, 2, 'и названы ОБА места, а не бронь с карточкой')
  assert.equal(d.json.ok, false, 'настоящий дубль обязан краснить сверку')
})

test('Д-75: бронь не прячет настоящий дубль — места считаются без неё', (t) => {
  // Третий случай, которого нет ни у одной из сторон: и бронь, и две карточки. Находка
  // обязана остаться, а бронь не должна попасть в перечень мест.
  const p = makeProject(t, { tasks: ['T-500'] })
  const other = join(p.root, 'openspec', 'changes', 'second', 'tasks')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'T-500.md'), '---\nid: T-500\nstatus: todo\n---\n\n## Критерии приёмки\n- [ ] один\n')
  mkdirSync(join(p.root, '.firm', 'ids'), { recursive: true })
  writeFileSync(join(p.root, '.firm', 'ids', 'T-500.json'), JSON.stringify({ id: 'T-500', kind: 'task' }))

  const d = p.evJson('doctor')
  assert.equal(d.json.duplicate_ids.length, 1)
  assert.ok(!d.json.duplicate_ids[0].where.includes('.firm/ids'), 'бронь — запись О номере, а не место, им названное')
})
