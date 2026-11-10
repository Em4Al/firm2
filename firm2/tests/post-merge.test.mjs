// И-4 со стороны git-хука: хук — спусковой крючок, а не судья.
//
// Хук ставится так же, как у человека: копией в `.git/hooks/post-merge` + chmod +x, —
// и срабатывает на настоящем `git merge`. Проверяются три случая, два из которых были
// ложными событиями: `--ff-only` (мерж-коммита нет вовсе) и слияние ветки задачи в
// ПОСТОРОННЮЮ ветку (git-хуки общие для всех рабочих деревьев, поэтому слияние
// ветки-зависимости внутри дерева другой задачи записывалось как влитие в поставку).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, commitFile, plainDir, COMMIT_DATE } from './helpers.mjs'

const MERGE_TS = new Date(COMMIT_DATE).toISOString()

// Ветка задачи со своим коммитом, заведённая на вершине поставки.
function taskBranch(p, ticket) {
  p.git('checkout', '-q', '-b', `task/${ticket}`, `feature/${p.change}`)
  commitFile(p, `${ticket}.txt`, `${ticket}\n`, ticket)
  p.git('checkout', '-q', `feature/${p.change}`)
}

// Событие пишется ДО ветки задачи и коммитится: `writeEvent` кладёт файл в индекс, а
// `git merge` отказывается работать с непустым индексом («your local changes would be
// overwritten»). В маршруте журнал коммитит стадия слияния, здесь — мы.
function devStarted(p, ticket) {
  writeEvent(p.root, {
    ts: '2026-09-30T11:00:00.000Z', change: p.change, ticket,
    stage: 'dev', event: 'started', actor: 'test',
  })
  p.git('commit', '-qm', `журнал: ${ticket} dev/started`)
}

const mergeEvents = (p) => p.eventFiles().filter((f) => /merge-finished/.test(f))

test('И-4: post-merge на --ff-only не пишет события — мерж-коммита нет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()

  p.git('merge', '--ff-only', 'task/T-001')
  assert.equal(p.git('log', '-1', '--format=%P').trim().split(/\s+/).length, 1, 'сцена: мержа-коммита нет')
  assert.match(p.git('reflog', '-1', '--format=%gs'), /merge task\/T-001/, 'хук опознаёт ветку по рефлогу')

  assert.deepEqual(mergeEvents(p), [],
    'прежде хук писал событие по тексту рефлога, и doctor потом объявлял его невозможным')
})

test('И-4: post-merge на --no-ff в ветку поставки пишет событие со временем мерж-коммита', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()

  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')

  const files = mergeEvents(p)
  assert.equal(files.length, 1, `событие слияния должно быть одно: ${files.join(', ')}`)
  const e = JSON.parse(readFileSync(join(p.eventsPath, files[0]), 'utf8'))
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.ts, MERGE_TS, 'время события — время мерж-коммита (И-5)')
  assert.equal(e.actor, 'reconcile', 'событие пишет сверка по доказательству, а не хук по рефлогу')
})

test('И-4: post-merge на слиянии ветки задачи в ПОСТОРОННЮЮ ветку молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()

  // Так выглядит слияние ветки-зависимости внутри рабочего дерева другой задачи:
  // хуки git общие для всех деревьев, и рефлог здесь такой же, как у настоящего слияния.
  p.git('checkout', '-q', '-b', 'task/T-002', `feature/${p.change}`)
  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')
  assert.match(p.git('reflog', '-1', '--format=%gs'), /merge task\/T-001/)

  assert.deepEqual(mergeEvents(p), [],
    'влили в чужую ветку — доска показывала бы merged, а build-args вычёркивал задачу из прогона')
})

test('И-4: post-merge в чужом репозитории (engine не firm2) молчит и выходит нулём', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  const hook = p.installPostMerge()
  // Хуки плагина оказываются и в проектах, которые о firm2 не просили.
  writeFileSync(join(p.root, '.firm', 'config'), 'engine: agent-dev-firm\n')

  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')
  assert.deepEqual(mergeEvents(p), [], 'чужие репозитории нас не касаются')

  // И напрямую — та же точка входа, что у git.
  const r = spawnSync('bash', [hook], { cwd: p.root, env: p.env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.deepEqual(mergeEvents(p), [])
})

test('И-4: слияние ВНУТРИ рабочего дерева задачи не пишет события в журнал поставки', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()

  // Дерево задачи T-002; git-хуки общие для всех рабочих деревьев, поэтому хук сработает
  // и здесь. Корень он обязан взять из первой записи `worktree list` — то есть главное
  // дерево, — иначе события уедут в `.firm/events` ветки задачи и при возврате на ветку
  // поставки половина журнала исчезнет.
  const wt = p.sibling('T-002')
  p.git('worktree', 'add', '-q', '-B', 'task/T-002', wt, `feature/${p.change}`)
  const inTree = (...a) => execFileSync('git', ['-C', wt, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: p.env,
  })
  inTree('merge', '--no-ff', '--no-edit', 'task/T-001')

  assert.deepEqual(mergeEvents(p), [], 'влили в ветку задачи, а не в поставку — доказательства нет')
  // И журнал не раздвоился: в дереве задачи новых файлов событий не появилось.
  const wtEvents = readdirSync(join(wt, '.firm', 'events')).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(wtEvents, p.eventFiles(), 'в дереве задачи — только то, что пришло из коммитов')
})

// ── G. Выпуск: хук обязан спросить, КУДА влили ───────────────────────────────
//
// Признаком выпуска было только ИМЯ влитой ветки из текста рефлога. Git-хуки общие для
// всех рабочих деревьев, поэтому `git merge feature/<поставка>` ВНУТРИ дерева задачи —
// законный ход, подтянуть в задачу правку из поставки — читался как «поставку влили в
// main»: на проект-В 02.10.2026 это дало 22 события `release/finished` разом, при
// непройденных MR-ревью и демо-воротах, и `doctor` на это ничего не сказал.

const releaseEvents = (p) => p.eventFiles().filter((f) => /release-finished/.test(f))

// Поставка, доведённая до слияния задачи: журнал закоммичен, чтобы индекс не мешал мержам.
function deliveredChange(p) {
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()
  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')
  assert.equal(mergeEvents(p).length, 1, 'сцена: задача влита и событие слияния записано')
  p.git('add', '-A')
  p.git('commit', '-qm', 'журнал и кэш статусов')
}

test('G: слияние feature/<поставка> в главную ветку даёт release/finished', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)

  p.git('checkout', '-q', 'main')
  p.git('merge', '--no-ff', '--no-edit', `feature/${p.change}`)

  const files = releaseEvents(p)
  assert.equal(files.length, 1, `выпуск обязан записаться: ${p.eventFiles().join(', ')}`)
  const e = JSON.parse(readFileSync(join(p.eventsPath, files[0]), 'utf8'))
  assert.equal(e.ticket, 'T-001')
  assert.equal(e.change, p.change)
  assert.equal(e.actor, 'git-post-merge')
})

test('G: слияние поставки в ПОСТОРОННЮЮ ветку главного дерева — не выпуск, и хук это говорит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)

  p.git('checkout', '-q', '-b', 'side', 'main')
  // Сообщение хука идёт в stderr, поэтому зовём git так, чтобы его увидеть.
  const r = spawnSync('git', ['-C', p.root, 'merge', '--no-ff', '--no-edit', `feature/${p.change}`], {
    encoding: 'utf8', env: p.env,
  })
  assert.equal(r.status, 0, r.stderr)

  assert.deepEqual(releaseEvents(p), [], 'влили не в главную ветку — выпуска не было')
  assert.match(r.stderr, /влита в side, а не в main — это не выпуск/,
    'молчать нельзя: ход законный, но человек должен видеть, что события НЕ будет')
  assert.match(r.stderr, /vcs\.target_branch/, 'надо назвать, чем ветка выпуска задаётся')
})

test('G: слияние поставки ВНУТРИ дерева задачи — не выпуск (случай проект-В, 22 ложных события)', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  deliveredChange(p)

  // Дерево задачи T-002 и законный ход внутри него: подтянуть правку из поставки.
  const wt = p.sibling('T-002')
  p.git('worktree', 'add', '-q', '-B', 'task/T-002', wt, 'main')
  const r = spawnSync('git', ['-C', wt, 'merge', '--no-ff', '--no-edit', `feature/${p.change}`], {
    encoding: 'utf8', env: p.env,
  })
  assert.equal(r.status, 0, `сцена не собралась: ${r.stderr}`)

  assert.deepEqual(releaseEvents(p), [],
    'поставка не выпущена: MR-ревью и демо-ворота не пройдены, PR не существует')
  assert.match(r.stderr, /task\/T-002, а не в main/, 'хук обязан назвать ветку-получателя')
  assert.match(r.stderr, /НЕ записано/)
})

test('G: ветка выпуска берётся из vcs.target_branch, а не захардкожена', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'vcs:\n  target_branch: trunk\n',
  })
  deliveredChange(p)
  p.git('branch', 'trunk', 'main')

  // В main — не выпуск: главная ветка этого проекта называется иначе.
  p.git('checkout', '-q', 'main')
  const intoMain = spawnSync('git', ['-C', p.root, 'merge', '--no-ff', '--no-edit', `feature/${p.change}`], {
    encoding: 'utf8', env: p.env,
  })
  assert.equal(intoMain.status, 0, intoMain.stderr)
  assert.deepEqual(releaseEvents(p), [], 'main здесь не главная ветка')
  assert.match(intoMain.stderr, /влита в main, а не в trunk/)

  // А в trunk — выпуск.
  p.git('checkout', '-q', 'trunk')
  p.git('merge', '--no-ff', '--no-edit', 'main')
  assert.equal(releaseEvents(p).length, 1, 'слияние в trunk обязано быть выпуском')
})

// Путь через ORIG_HEAD — отдельная ветка того же `if`, и чинилась она отдельно. Она
// опаснее соседней: имя поставки берётся не из рефлога, а из ЗАГОЛОВКОВ пришедших
// коммитов, то есть срабатывает и там, где слияния вовсе не делали, — например в дереве
// задачи после обычного `git pull`.
//
// Сцена воспроизводит `gh pr merge` + `git pull --ff-only`: имени влитой ветки в рефлоге
// нет, зато в пришедших коммитах есть заголовок со ссылкой на feature/<поставка>.
function pullLikeScene(p, branch) {
  const before = p.git('rev-parse', 'HEAD').trim()
  p.git('merge', '--no-ff', '--no-edit', `feature/${p.change}`)
  p.git('update-ref', 'ORIG_HEAD', before)
  // Рефлог переписываем так, как его пишет pull: «merge <ветка>» в нём нет.
  p.git('update-ref', '-m', 'pull --ff-only: Fast-forward', 'HEAD', p.git('rev-parse', 'HEAD').trim())
  assert.match(p.git('reflog', '-1', '--format=%gs'), /pull --ff-only/, `сцена на ${branch}`)
  return spawnSync('bash', [join(p.root, '.git', 'hooks', 'post-merge')], {
    cwd: p.root, env: p.env, encoding: 'utf8', timeout: 30000,
  })
}

test('G: путь через ORIG_HEAD пишет выпуск, когда поставка приехала в главную ветку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)
  p.git('checkout', '-q', 'main')

  const r = pullLikeScene(p, 'main')
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.equal(releaseEvents(p).length, 1, `выпуск через pull обязан записаться: ${r.stderr}`)
})

test('G: путь через ORIG_HEAD молчит, когда поставка приехала не в главную ветку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)
  p.git('checkout', '-q', '-b', 'side', 'main')

  const r = pullLikeScene(p, 'side')
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.deepEqual(releaseEvents(p), [], 'обычный pull в непрофильную ветку выпуском не является')
  assert.match(r.stderr, /приехала в side, а не в main — это не выпуск/)
  assert.match(r.stderr, /НЕ записано/)
})

// Рефлог `HEAD` у git по-деревный: слияние записано в том дереве, где случилось. Хук же
// брал ответ из главного дерева (`git -C "$root" reflog`), а вопрос «куда влили» задавал
// про дерево слияния — та же асимметрия, что дала G, в соседней паре строк.
//
// Сцена, в которой это стреляло: главное дерево стоит на `feature/<поставка>` — обычное
// состояние во время сборки, — а рабочее дерево на главной ветке. Тогда `into` совпадает
// с целевой, а `merged` подтягивается из устаревшей записи чужого рефлога, и выпуск
// пишется на слиянии, которого сейчас не было.
//
// Чинилось в два захода: сперва рефлог, потом `ORIG_HEAD`/`HEAD` в соседней ветке того же
// `if`. Промежуточная редакция спрашивала их у ГЛАВНОГО дерева (через `env -u GIT_DIR`), и
// этот тест был красным: `ORIG_HEAD` главного дерева выставляет обычный шаг слияния задачи,
// а в его истории стоит заголовок «Merge branch 'task/T-001' into feature/ch», из которого
// добывалось имя поставки. Теперь все четыре ответа — `into`, рефлог, `ORIG_HEAD`, `HEAD` —
// берутся у дерева слияния, то есть там же, где задан вопрос.
test('G: устаревшая запись в рефлоге ГЛАВНОГО дерева не делает выпуск из чужого слияния', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)

  // Главное дерево остаётся на поставке, и последняя запись его рефлога — слияние
  // поставки. Как она туда попала, хуку неважно: важно, что она не про то слияние,
  // которое сейчас произошло.
  p.git('update-ref', '-m', "merge feature/ch: Merge made by the 'ort' strategy.",
    'HEAD', p.git('rev-parse', 'HEAD').trim())
  assert.match(p.git('reflog', '-1', '--format=%gs'), /^merge feature\/ch:/, 'сцена: рефлог главного дерева')
  assert.equal(p.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), `feature/${p.change}`)

  // Рабочее дерево на ГЛАВНОЙ ветке: `into` совпадёт с веткой выпуска, и от ложного
  // выпуска остаётся защищать только одно — честно прочитанный рефлог.
  const wt = p.sibling('release')
  p.git('worktree', 'add', '-q', wt, 'main')
  assert.match(p.git('worktree', 'list'), /\[main\]/, 'сцена: главная ветка выписана в рабочее дерево')

  // Слияние в этом дереве — не про поставку: соседняя ветка от main, и ни в одном
  // заголовке пришедших коммитов нет `feature/...`.
  const sha = p.git('commit-tree', p.git('rev-parse', 'main^{tree}').trim(),
    '-p', p.git('rev-parse', 'main').trim(), '-m', 'правка в соседней ветке').trim()
  p.git('branch', 'side', sha)
  // Приманка, на которую ловилась промежуточная редакция: ORIG_HEAD главного дерева
  // выставил обычный шаг слияния задачи, и в его истории стоит заголовок с именем
  // поставки. Спросив про главное дерево, хук добыл бы `ch` отсюда.
  assert.ok(p.git('rev-parse', '--verify', 'ORIG_HEAD').trim(),
    'сцена: ORIG_HEAD главного дерева выставлен слиянием задачи')
  assert.match(p.git('log', '--format=%s', 'ORIG_HEAD..HEAD'), /feature\/ch/,
    'сцена: в истории главного дерева есть заголовок с именем поставки')

  const r = spawnSync('git', ['-C', wt, 'merge', '--no-ff', '--no-edit', 'side'], {
    encoding: 'utf8', env: p.env,
  })
  assert.equal(r.status, 0, `сцена не собралась: ${r.stderr}`)

  assert.deepEqual(releaseEvents(p), [],
    'выпуск писался бы на слиянии, которого сейчас не было — ответ надо брать там же, где задан вопрос')
  // Доказательство, что рефлог прочитан у ТОГО дерева: хук не увидел «merge feature/ch»
  // и честно сказал, что слияние не опознано.
  assert.match(r.stderr, /слияние не опознано/)
})

// ── Четвёртое место того же класса: КУДА писать журнал ───────────────────────
//
// Хук вычисляет `$root` честно (первая запись `worktree list`), но до 02.10.2026 звал
// `node "$event_js" sync` без `--root`, и корень журнала искался заново уже внутри node —
// `CLAUDE_PROJECT_DIR || repoRoot()`. То есть ответ на вопрос «куда писать» брался не
// оттуда, где вопрос задан, а из окружения сессии. `CLAUDE_PROJECT_DIR` выставляет рантайм
// на сессию, а git зовут откуда угодно — хоть из команды другого проекта.
//
// Сцена: сессия «открыта» в проекте A, слияние делается в проекте B. Событие обязано
// появиться в журнале B и не появиться в A. Без `--root` тест красный в обе стороны:
// сверка уходит в A, где доказывать нечего, и событие слияния теряется вообще.

// Задача, доведённая до слияния БЕЗ хука: доказательство (мерж-коммит со вторым родителем)
// в репозитории есть, события в журнале ещё нет. Именно это состояние и подхватывает `sync`.
function provenMerge(p, ticket = 'T-001') {
  devStarted(p, ticket)
  taskBranch(p, ticket)
  p.git('merge', '--no-ff', '--no-edit', `task/${ticket}`)
  assert.equal(p.git('log', '-1', '--format=%P').trim().split(/\s+/).length, 2, 'сцена: мерж-коммит есть')
}

test('И-4: событие пишется в журнал проекта, где слияние, а не того, что в CLAUDE_PROJECT_DIR', (t) => {
  const foreign = makeProject(t, { change: 'other', tasks: ['T-009'] })
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()
  const foreignBefore = foreign.eventFiles()

  // Сессия открыта в чужом проекте — ровно то, что делает рантайм, когда git зовут из
  // команды соседнего проекта.
  const r = spawnSync('git', ['-C', p.root, 'merge', '--no-ff', '--no-edit', 'task/T-001'], {
    encoding: 'utf8', env: { ...p.env, CLAUDE_PROJECT_DIR: foreign.root },
  })
  assert.equal(r.status, 0, `сцена не собралась: ${r.stderr}`)

  assert.equal(mergeEvents(p).length, 1,
    `событие обязано лежать там, где слияние: ${p.eventFiles().join(', ')} / stderr: ${r.stderr}`)
  assert.deepEqual(foreign.eventFiles(), foreignBefore, 'в чужом журнале не должно появиться ничего')
})

test('И-4: чужой проект с ГОТОВЫМ доказательством не перехватывает событие слияния', (t) => {
  // Злой вариант: в чужом проекте та же поставка и та же задача, и доказательство под неё
  // уже лежит — ветка task/T-001 и мерж-коммит. Сверка, ушедшая туда, записала бы событие
  // по чужому доказательству, а не потеряла его.
  const foreign = makeProject(t, { tasks: ['T-001'] })
  provenMerge(foreign)
  const foreignBefore = foreign.eventFiles()
  assert.deepEqual(mergeEvents(foreign), [], 'сцена: в чужом журнале события слияния ещё нет')

  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()

  const r = spawnSync('git', ['-C', p.root, 'merge', '--no-ff', '--no-edit', 'task/T-001'], {
    encoding: 'utf8', env: { ...p.env, CLAUDE_PROJECT_DIR: foreign.root },
  })
  assert.equal(r.status, 0, `сцена не собралась: ${r.stderr}`)

  assert.equal(mergeEvents(p).length, 1, `событие в своём журнале: ${p.eventFiles().join(', ')}`)
  assert.deepEqual(foreign.eventFiles(), foreignBefore,
    'ни одного нового события в чужом проекте, хотя доказательство там готово')
})

test('И-12: worktree list не ответил — корень неизвестен, событие НЕ записано, код 0', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  provenMerge(p)
  const hook = p.installPostMerge()
  const before = p.eventFiles()

  // Отказ подделываем честно: хук запускается там, где `git worktree list` не отвечает.
  // Запасного пути (`rev-parse --show-toplevel`) в хуке больше нет намеренно — в связанном
  // дереве он вернул бы путь ЭТОГО дерева, и журнал уехал бы в ветку задачи.
  const r = spawnSync('bash', [hook], {
    cwd: plainDir(t), env: p.env, encoding: 'utf8', timeout: 30000,
  })

  assert.equal(r.status, 0, `хук не смеет валить слияние: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /корень неизвестен/, 'человек должен узнать, почему события нет')
  assert.match(r.stderr, /НЕ записан/)
  assert.deepEqual(p.eventFiles(), before, 'неправильный корень хуже отсутствия события')
})

// ── Запись события ИЗ СВЯЗАННОГО ДЕРЕВА (отчёт проект-В 03.11.2026, находка 1) ──
//
// Git зовёт хук с выставленными `GIT_DIR` и `GIT_INDEX_FILE`, и они СИЛЬНЕЕ ключа `-C`.
// Из-за этого на выпуске проект-В 139 событий легли файлами в главное дерево, а в индекс —
// дерева слияния: 139 записей `AD` там, где файлов нет, и 139 неотслеживаемых файлов там,
// где они есть. Смысл `git add` в том, чтобы `git clean -fd` не снёс журнал молча, — то
// есть защита не сработала ровно в том сценарии, ради которого стоит.
//
// Проверяем живьём, ответом git, а не наличием строки в исходнике: имя переменной в коде
// ничего не доказывает.
test('находка 1: событие из связанного дерева ложится в индекс ГЛАВНОГО дерева', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = p.sibling('trunk')
  p.git('worktree', 'add', '-q', '-b', 'trunk-probe', wt, `feature/${p.change}`)
  const gitDir = execFileSync('git', ['-C', wt, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  // Ровно то окружение, с которым git запускает хук в связанном дереве.
  const r = p.cli('firm-event.mjs', [
    'record', '--root', p.root, '--ticket', 'T-001', '--stage', 'guard',
    '--event', 'worktree-probe', '--actor', 'test',
  ], {
    env: { GIT_DIR: gitDir, GIT_WORK_TREE: wt, GIT_INDEX_FILE: join(gitDir, 'index') },
  })
  assert.equal(r.status, 0, r.stderr)

  const file = p.eventFiles().find((f) => /guard-worktree-probe/.test(f))
  assert.ok(file, `событие записано: ${p.eventFiles().join(', ')}`)
  const rel = join('.firm', 'events', file)

  const inMain = spawnSync('git', ['-C', p.root, 'ls-files', '--error-unmatch', '--', rel], {
    encoding: 'utf8', env: p.env,
  })
  assert.equal(inMain.status, 0,
    'файл остался неотслеживаемым в главном дереве — именно его и сносит `git clean -fd`')

  const foreign = spawnSync('git', ['-C', wt, 'diff', '--cached', '--name-only'], {
    encoding: 'utf8', env: p.env,
  }).stdout || ''
  assert.equal(foreign.includes('.firm/events'), false,
    'в индексе связанного дерева события быть не должно: это и были 139 записей AD')
})

// ── Д-51: событие принадлежит ВЕТКЕ, а не дереву (проект-В, 05.11.2026) ────────
//
// Замер: вливание `3d` → `main` сделано в связанном дереве (`проект-В.worktrees/_trunk`, там
// выгружен `main`), главное дерево стояло на уже выпущенной ветке поставки. Хук записал 35
// событий `release-finished` в ГЛАВНОЕ дерево и там же проиндексировал — то есть записи о
// выпуске в `main` легли на ветку, к `main` отношения не имеющую. Не разбери человек
// каталог руками, 35 событий не доехали бы никуда.
//
// Это тот же вопрос, что и 01.10.2026 («событие уехало на ветку задачи»), заданный с
// другой стороны: оба раза дерево выбиралось вместо ветки. Правило теперь одно — событие
// пишется туда, где выгружена ветка-владелец, а это ровно одно дерево: git не даёт
// выгрузить ветку дважды.

const eventsIn = (dir) => {
  try {
    return readdirSync(join(dir, '.firm', 'events')).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

test('Д-51: выпуск в связанном дереве пишется НА ВЕТКУ-ЦЕЛЬ, а не в главное дерево', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)
  // Главное дерево уходит на постороннюю ветку — состояние проект-В: поставка уже выпущена,
  // а дерево осталось на её ветке.
  p.git('checkout', '-q', '-b', 'dead/after-release')
  const trunk = p.sibling('trunk')
  p.git('worktree', 'add', '-q', trunk, 'main')

  const r = spawnSync('git', ['merge', '--no-ff', '--no-edit', `feature/${p.change}`], {
    cwd: trunk, encoding: 'utf8', env: p.env, timeout: 30000,
  })
  assert.equal(r.status, 0, `сцена не собралась: ${r.stderr}`)

  const release = (dir) => eventsIn(dir).filter((f) => /release-finished/.test(f))
  assert.equal(release(trunk).length, 1,
    `выпуск обязан лечь туда, где выгружена ветка-цель: в trunk ${eventsIn(trunk).join(', ')}, ` +
    `в главном ${eventsIn(p.root).join(', ')}`)
  assert.deepEqual(release(p.root), [],
    'в главном дереве сейчас посторонняя ветка — запись туда и есть дефект: события не доедут никуда')
  // И проиндексировано ТАМ ЖЕ: неотслеживаемый файл сносит `git clean -fd`.
  const staged = execFileSync('git', ['-C', trunk, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
  assert.match(staged, /\.firm\/events\/.*release-finished/)
  // Сказано вслух: иначе человек ищет события в главном дереве и читает «хук не сработал».
  assert.match(r.stderr, /выгружена не здесь/)
})

test('Д-51: когда ветка-цель выгружена в главном дереве, ничего не меняется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  deliveredChange(p)
  p.git('checkout', '-q', 'main')
  p.git('merge', '--no-ff', '--no-edit', `feature/${p.change}`)
  assert.equal(releaseEvents(p).length, 1, 'обычный путь выпуска не должен сдвинуться')
})

test('Д-51: слияние задачи в связанном дереве поставки пишется туда же, где ветка поставки', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  devStarted(p, 'T-001')
  taskBranch(p, 'T-001')
  p.installPostMerge()
  // Ветка поставки уходит в связанное дерево, главное остаётся на main — зеркальный
  // случай: прежде правки пометок задачи и событие слияния легли бы на main.
  p.git('checkout', '-q', 'main')
  const wt = p.sibling('delivery')
  p.git('worktree', 'add', '-q', wt, `feature/${p.change}`)
  const r = spawnSync('git', ['merge', '--no-ff', '--no-edit', 'task/T-001'], {
    cwd: wt, encoding: 'utf8', env: p.env, timeout: 30000,
  })
  assert.equal(r.status, 0, `сцена не собралась: ${r.stderr}`)
  assert.equal(eventsIn(wt).filter((f) => /merge-finished/.test(f)).length, 1,
    `событие слияния обязано лечь на ветку поставки: ${eventsIn(wt).join(', ')} | главное: ${eventsIn(p.root).join(', ')}`)
  assert.deepEqual(eventsIn(p.root).filter((f) => /merge-finished/.test(f)), [])
})
