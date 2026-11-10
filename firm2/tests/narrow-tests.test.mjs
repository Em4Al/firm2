// Узкий задачный прогон: проект вправе проверять задачи не полным набором, а ворота — им.
//
// Повод — замер проект-В 28.10.2026: стадия теста 26 минут против девяти, когда из задачного
// прогона убраны мета-тесты (они судят не продукт, а механизм установки по локфайлу).
// Переезд таких проверок на ворота — РАЗМЕН, а не экономия: поломка всплывёт позже и
// пачкой. Размен выгоден ровно до тех пор, пока ворота действительно гоняют полный набор,
// и отвечать за это должен движок, а не память человека.
//
// Чего тесты не трогают: что считать мета-тестом и каким маркером их исключать. Это язык
// проекта, движок берёт команду дословно (ADR-0010).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject, loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const TASK = { id: 'T-001', path: 't.md', labels: [], parallel_safe: true }

const NARROW = 'stack:\n  test_cmd: "uv run pytest"\n  task_test_cmd: "uv run pytest -m \'not meta\'"\n'
const WIDE = 'stack:\n  test_cmd: "uv run pytest"\n'

const buildArgs = (p) => JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json']).stdout)

test('обе команды доезжают до сборщика, и сужение названо признаком', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROW })
  const a = buildArgs(p)
  assert.equal(a.test_cmd, 'uv run pytest', 'полный набор остаётся эталоном под своим именем')
  assert.match(a.task_test_cmd, /not meta/, 'задачам отдана узкая команда')
  assert.equal(a.task_tests_narrowed, true, 'сужение считает движок, а не стадия сравнением строк')
})

test('ключа нет — обе команды одна и та же, и сужения нет', (t) => {
  // Умолчание намеренное: сузить задачный прогон значит согласиться платить за это на
  // воротах. Молчаливое сужение сузило бы заодно и ворота — то есть проверки перестали бы
  // гоняться вовсе, вместо того чтобы переехать.
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: WIDE })
  const a = buildArgs(p)
  assert.equal(a.task_test_cmd, a.test_cmd)
  assert.equal(a.task_tests_narrowed, false)
})

test('firm-state stack называет сужение словами и предупреждает о его цене', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROW })
  const r = JSON.parse(p.cli('firm-state.mjs', ['stack', '--root', p.root, '--json']).stdout)
  assert.equal(r.task_tests_narrowed, true)
  const note = (r.notes || []).find((n) => /СУЖЕН/.test(n))
  assert.ok(note, 'сужение попадает в находки: иначе оно живёт только в конфиге')
  assert.match(note, /не означает зелёный на воротах/)
  assert.match(note, /тот же набор|один набор/, 'сказано и про основание сверки')
})

// ── Что видят стадии ─────────────────────────────────────────────────────────
async function prompts(extra) {
  const calls = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label.startsWith('основание:')) {
      return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'x', red: [], failed: 0, total: 10 }
    }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [TASK.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return {
        status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 },
        runs: {
          base: { sha: 'abc1234567890def', cmd: 'c', red: [], failed: 0, total: 10 },
          head: { sha: 'fed0987654321cba', cmd: 'c', red: [], failed: 0, total: 10 },
        },
      }
    }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '', tasks: [TASK], ...extra,
  }))
  const find = (pre) => (calls.find((c) => c.label.startsWith(pre)) || {}).prompt || ''
  return {
    dev: find('dev:'),
    prep: find('worktree:'),
    test: find('test:'),
    qa: calls.find((c) => c.label.startsWith('qa-panel:') || c.label.startsWith('qa:')).prompt,
    trunk: find('основание:'),
    log: logs.join('\n'),
  }
}

const NARROW_ARGS = {
  test_cmd: 'uv run pytest',
  task_test_cmd: "uv run pytest -m 'not meta'",
  task_tests_narrowed: true,
}

test('стадии названа задачная команда и сказано, чего её зелёный не значит', async () => {
  const r = await prompts(NARROW_ARGS)
  assert.match(r.test, /ЗАДАЧНЫЙ ПРОГОН СУЖЕН/)
  assert.match(r.test, /not meta/, 'команда названа дословно, а не описана')
  assert.match(r.test, /НЕ ОЗНАЧАЕТ ЗЕЛЁНЫЙ НА ВОРОТАХ/)
  assert.match(r.test, /uv run pytest»/, 'полный набор тоже назван: стадия должна знать, что её прогон — часть')
})

test('основание сверки снимается ЗАДАЧНОЙ командой — обе половины про один набор', async () => {
  const r = await prompts(NARROW_ARGS)
  assert.match(r.trunk, /not meta/, 'зонд гонит то же, что стадия')
  assert.match(r.trunk, /ТОТ ЖЕ набор/, 'сказано, почему именно эта команда')
  assert.doesNotMatch(r.trunk, /ПОЛНЫЙ набор проверок проекта/, 'полный набор здесь был бы второй половиной про другое')
})

test('Ревьюеру сказано, что принять можно, а утверждать полноту — нет', async () => {
  const r = await prompts(NARROW_ARGS)
  assert.match(r.qa, /Принять задачу по узкому прогону/)
  assert.match(r.qa, /МОЖНО/)
  assert.match(r.qa, /утверждать по нему полноту|полноту: /i)
  assert.match(r.qa, /непредъявимы/, 'названа цена фразы «регрессий нет» в вердикте')
})

test('сужение названо один раз на волну в логе прогона', async () => {
  const r = await prompts(NARROW_ARGS)
  assert.match(r.log, /Задачный прогон СУЖЕН проектом/)
  assert.match(r.log, /ворота — «uv run pytest»/)
})

test('сужения нет — лишних абзацев в промптах тоже нет', async () => {
  // Абзац в промпте стоит денег на каждой задаче, и платить за него проект, который не
  // сужал, не должен.
  const r = await prompts({})
  assert.doesNotMatch(r.test, /ЗАДАЧНЫЙ ПРОГОН СУЖЕН/)
  assert.doesNotMatch(r.qa, /узкому прогону/)
  assert.doesNotMatch(r.log, /СУЖЕН/)
})

test('доска называет сужение там же, где читают поставку', (t) => {
  // Иначе узкий зелёный на доске выглядит как полный — то есть как то, чем не является.
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROW })
  p.cli('dashboard.mjs', [p.change], { env: { CLAUDE_PROJECT_DIR: p.root } })
  const h = readFileSync(join(p.root, '.firm', 'dashboard.html'), 'utf8')
  assert.match(h, /Задачный прогон сужен проектом/)
  assert.match(h, /not meta/, 'обе команды названы дословно')
  assert.match(h, /цена сужения переехала туда, а не исчезла/, 'сказано, что это размен, а не экономия')
})

test('проект без сужения лишней строки на доске не получает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: WIDE })
  p.cli('dashboard.mjs', [p.change], { env: { CLAUDE_PROJECT_DIR: p.root } })
  const h = readFileSync(join(p.root, '.firm', 'dashboard.html'), 'utf8')
  assert.doesNotMatch(h, /сужен проектом/)
})

// ── Д-21: карманы называются, но не снимаются ────────────────────────────────
test('prune называет отложенные карманы и ни одного не снимает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeFileSync(join(p.root, 'work.txt'), 'правка человека\n')
  p.git('add', '-A')
  p.git('commit', '-qm', 'work')
  writeFileSync(join(p.root, 'work.txt'), 'незакоммиченная правка\n')
  p.git('stash', 'push', '-m', 'firm2: кэш статуса перед слиянием T-001', '--', 'work.txt')
  const before = p.git('stash', 'list')
  const r = JSON.parse(p.cli('firm-state.mjs', ['prune', '--root', p.root, '--json']).stdout)
  assert.ok(r.stashes, 'карман назван: молча копиться он не должен')
  assert.equal(r.stashes.count, 1)
  assert.equal(r.stashes.mine, 1, 'подпись движка опознана')
  assert.match(r.stashes.note, /НЕ снимает/, 'сказано, что уборка — решение человека')
  assert.match(r.stashes.note, /git stash pop/, 'названа команда, которой карман достают')
  assert.equal(p.git('stash', 'list'), before, 'карман на месте: в нём может лежать единственная копия работы')
})

test('карманов нет — prune о них молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = JSON.parse(p.cli('firm-state.mjs', ['prune', '--root', p.root, '--json']).stdout)
  assert.equal(r.stashes, null, 'пустой список не повод для строки')
})

// ── Исключённое из задачного прогона (Д-55) ──────────────────────────────────
//
// Отчёт проект-В 08.11.2026. Сужение верно и движком же поощряется, но исключённое не
// предъявлялось НИЧЕМ до ворот: `build-args` сужение видел, запрет полного набора в промпты
// писал, а вопроса «кто и когда прогонит исключённое» не задавал никто. Цена — единственный
// в проекте гейт из 164 живых проверок, не прогнанный ни разу за 32 задачи и семь волн, и
// пять красных на воротах, три из них настоящие.
//
// Состав выпавшего движок вывести не может (чужой раннер, чужие флаги) — его ОБЪЯВЛЯЕТ
// проект, а движок требует объявления и называет исключённое непрогнанным.
const EXCLUDED =
  NARROW +
  '  task_tests_excluded:\n' +
  '    - tests/test_gate.py\n' +
  '    - tests/test_pack.py\n' +
  '  task_tests_presented_by:\n' +
  '    tests/test_gate.py: "ворота 3б"\n'

test('объявленное исключённое доезжает до сборщика нормализованной формой', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: EXCLUDED })
  const a = buildArgs(p)
  assert.deepEqual(a.task_tests_excluded, [
    { path: 'tests/test_gate.py', by: 'ворота 3б' },
    { path: 'tests/test_pack.py', by: null },
  ], 'список путей и отображение предъявителей сводятся в одну форму на двух потребителей')
  const w = (a.warnings || []).find((x) => /без предъявителя/.test(x))
  assert.ok(w, 'файл без предъявителя назван предупреждением перед прогоном')
  assert.match(w, /tests\/test_pack\.py/)
  assert.doesNotMatch(w, /test_gate/, 'у кого предъявитель назван — тот не находка')
})

test('сужение без объявления состава — предупреждение: предъявить нечем', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: NARROW })
  const a = buildArgs(p)
  assert.deepEqual(a.task_tests_excluded, [])
  const w = (a.warnings || []).find((x) => /состав исключённого не объявлен/.test(x))
  assert.ok(w, 'молчание тут дороже всего: неизвестно даже, что перестало гоняться')
  assert.match(w, /task_tests_excluded/, 'названо, чем это объявляется')
})

test('сужения нет — про исключённое не говорится вовсе', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: WIDE })
  const a = buildArgs(p)
  assert.equal((a.warnings || []).some((x) => /исключённ/.test(x)), false)
})

test('исключённое названо непрогнанным в логе волны, по именам', async () => {
  const r = await prompts({
    ...NARROW_ARGS,
    task_tests_excluded: [
      { path: 'tests/test_gate.py', by: null },
      { path: 'tests/test_pack.py', by: 'ворота 3б' },
    ],
  })
  assert.match(r.log, /НЕ ПРОГОНЯЕТСЯ НИ ОДНОЙ СТАДИЕЙ ЭТОЙ ВОЛНЫ \(2\)/)
  assert.match(r.log, /tests\/test_gate\.py — ПРЕДЪЯВИТЕЛЯ НЕТ/)
  assert.match(r.log, /tests\/test_pack\.py — предъявляет: ворота 3б/)
})

test('сужение объявлено, состав — нет: лог говорит, что это слепое пятно', async () => {
  const r = await prompts(NARROW_ARGS)
  assert.match(r.log, /Состав исключённого из задачного прогона НЕ ОБЪЯВЛЕН/)
  assert.match(r.log, /нет в том, что мы смотрим/, 'названа цена формулы «новых красных нет»')
})

// ── Д-70 и Д-71: запрет ожидания назван заранее; ссылки дерева — по объявлению ──
//
// Отчёт проект-В 09.11.2026. Д-70: сторож долгого ожидания отменил за прогон 86 вызовов — он
// прав по делу (роли писали циклы `until`/`sleep` вместо suite-run), но правило узнавалось
// ИЗ ОТКАЗА, и каждая отмена стоила роли хода; одна задача записала «съело два круга».
// Запрет полного набора назван в промпте заранее и ходов не стоит — значит и этот должен.
//
// Д-71: в рабочих деревьях задач нет `web/node_modules`, и симлинк ставила руками каждая
// роль (три за вечер, одна забыла снять до коммита). Знать про `node_modules` движку
// неоткуда — состав объявляет проект, а движок кладёт объявленное в подготовку дерева.
test('Д-70: запрет цикла ожидания стоит в промпте стадии, с механизмом и ценой', async () => {
  const { test: dev } = await prompts({ test_cmd: 'npm test', task_test_cmd: 'npm test' })
  assert.match(dev, /ЦИКЛ ОЖИДАНИЯ СТОРОЖ ОТМЕНИТ \(exit 2\)/, 'сказано заранее и тем же словом, что про полный набор')
  assert.match(dev, /suite-run\.mjs" start/, 'назван механизм, которым ждать можно')
  assert.match(dev, /wait --id/)
  assert.match(dev, /540/, 'назван потолок одного ожидания — иначе роль не знает, сколько раз звать')
})

test('Д-71: ссылки кладутся в подготовку дерева ТОЛЬКО по объявлению проекта', async () => {
  const no = await prompts({ test_cmd: 'npm test', worktrees_dir: '/wt' })
  assert.doesNotMatch(no.prep, /ln -s/, 'не объявлено — ни одной новой строки в промпте')

  const yes = await prompts({ test_cmd: 'npm test', worktrees_dir: '/wt', worktree_links: ['web/node_modules', '.venv'] })
  const prep = yes.prep
  assert.match(prep, /web\/node_modules/)
  assert.match(prep, /\.venv/)
  assert.match(prep, /ln -s/, 'дана команда, а не описание')
  assert.match(prep, /КОММИТИТЬ ССЫЛКИ НЕЛЬЗЯ/, 'названа та ошибка, которую роль уже совершила')
  assert.match(prep, /stack\.worktree_links/, 'сказано, что это объявление проекта, а не догадка движка')
})
