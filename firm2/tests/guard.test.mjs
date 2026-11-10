// И-9: стадия пишет только в своё рабочее дерево (write-guard.mjs).
//
// Рантайм здесь не нужен: хук читает полезную нагрузку PreToolUse со stdin и отвечает
// кодом возврата. Это ровно тот интерфейс, который можно проверить снаружи.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { makeProject, commitFile, COMMIT_DATE } from './helpers.mjs'

function guard(p, file, { cwd = p.root, tool = 'Write' } = {}) {
  return p.cli('write-guard.mjs', [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, cwd, tool_input: { file_path: file } }),
  })
}

// Рабочее дерево задачи лежит ВНЕ репозитория (§9).
function addWorktree(p, ticket) {
  const path = p.sibling(ticket)
  p.git('worktree', 'add', '-q', '-B', `task/${ticket}`, path, `feature/${p.change}`)
  return path
}

test('И-9: пока живо рабочее дерево задачи, запись в главное дерево запрещена', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')

  const rel = guard(p, 'src/x.py')
  assert.equal(rel.status, 2, `относительный путь обязан быть остановлен: ${rel.stdout}${rel.stderr}`)
  assert.match(rel.stderr, /запись в ГЛАВНОЕ рабочее дерево запрещена/)
  assert.match(rel.stderr, /T-001 →/, 'хук обязан назвать, куда писать вместо этого')

  const abs = guard(p, join(p.root, 'tests', 'test_t001.py'))
  assert.equal(abs.status, 2, 'абсолютный путь внутрь главного дерева — тот же случай')
})

test('И-9: запись в собственное рабочее дерево задачи разрешена', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = addWorktree(p, 'T-001')
  const r = guard(p, join(wt, 'src', 'x.py'))
  assert.equal(r.status, 0, `${r.stderr}`)
})

test('И-9: каталоги поставки разрешены — они принадлежат не задаче', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')
  for (const f of [
    'openspec/changes/ch/design.md', 'docs/adr/0001-x.md', '.claude/settings.json',
    // Остальной `.firm/` — тоже поставка: конфиг, дашборд, claim-файлы пишет движок.
    // Эта строка важнее запрета журнала ниже: сузить `.firm/` слишком широко значит
    // отнять у движка дашборд, и заметно это будет не сразу.
    '.firm/config', '.firm/dashboard.md', '.firm/dashboard.html', '.firm/current/a1.json',
    '.firm/paused',
  ]) {
    const r = guard(p, f)
    assert.equal(r.status, 0, `${f} должен быть разрешён: ${r.stderr}`)
  }
  // А похожее имя — нет: слэш на конце списка существенен.
  assert.equal(guard(p, 'docsy/x.md').status, 2, 'docsy — не docs')
  // И каталог с похожим именем внутри `.firm/` журналом не считается.
  assert.equal(guard(p, '.firm/eventsx/y.json').status, 0, '.firm/eventsx — не .firm/events')
})

// И-2 и ADR-0006 держались здесь случайно — тем, что никто не пробовал. Правка журнала
// ИНСТРУМЕНТОМ невидима навсегда: отредактированное руками событие остаётся синтаксически
// правильным, и ни `doctor`, ни ревью его потом не отличат от записанного кодом.
test('И-2: запись в .firm/events/ инструментом запрещена — журнал только дописывается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')

  const r = guard(p, '.firm/events/2026-09-30T12-00-00-000Z-T-001-dev-started.json')
  assert.equal(r.status, 2, `правка события должна быть остановлена: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /запись в журнал событий инструментом запрещена/)
  // Канал «сказать» обязан нести готовую замену, а не только запрет (ADR-0007).
  assert.match(r.stderr, /firm-event\.mjs record/, 'надо назвать, чем записывают факт')
  assert.match(r.stderr, /--event retracted --corrects/, 'и чем исправляют прежнее событие')
  assert.match(r.stderr, /И-2|ADR-0006/, 'запрет должен ссылаться на решение, а не быть вкусом')

  // Сам каталог — тоже запрет: правка `.firm/events` как файла ничем не лучше.
  assert.equal(guard(p, '.firm/events').status, 2)
})

test('И-2: журнал закрыт и когда сборка НЕ идёт — иммутабельность не зависит от рабочих деревьев', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Ни одного рабочего дерева: запись в код главного дерева сейчас законна.
  assert.equal(guard(p, 'src/x.py').status, 0, 'сцена: защита главного дерева молчит')
  // А журнал закрыт всё равно: событие неизменяемо всегда, а не только во время прогона.
  assert.equal(guard(p, '.firm/events/x.json').status, 2)
})

test('И-9: нет живых рабочих деревьев — сборка не идёт, и защита молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = guard(p, 'src/x.py')
  assert.equal(r.status, 0, 'до сборки деревьев нет, писать в главное дерево законно')
})

test('И-9: дерево, от которого остался только след (prunable), живым не считается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = addWorktree(p, 'T-001')
  assert.equal(guard(p, 'src/x.py').status, 2)

  rmSync(wt, { recursive: true, force: true }) // шаг уборки снёс каталог, prune не позвал
  assert.match(p.git('worktree', 'list', '--porcelain'), /task\/T-001/, 'след в git должен остаться')
  const r = guard(p, 'src/x.py')
  assert.equal(r.status, 0, 'иначе запись в главное дерево была бы запрещена навсегда')
})

test('И-9: аварийный выход в .firm/config снимает защиту — и это видно в конфиге', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'guard:\n  write_outside_worktree: off\n',
  })
  addWorktree(p, 'T-001')
  // Рубильник обязан РАБОТАТЬ: это та половина, которую легко потерять, переставляя
  // проверки местами, — и потеря была бы молчаливой наоборот, запретом невиновного.
  assert.equal(guard(p, 'src/x.py').status, 0, 'относительный путь в код главного дерева')
  assert.equal(guard(p, join(p.root, 'tests', 'test_t001.py')).status, 0, 'и абсолютный тоже')
})

// Рубильник снимает ровно одну защиту — «чья это работа сейчас»: она про текущую сборку и
// потому законно снимается на время. Иммутабельность журнала — про другое и исключений не
// знает: её нельзя снять «на время», потому что переписанное событие остаётся переписанным
// навсегда. Человеку рубильник для журнала и не нужен: хук видит только вызовы инструментов
// агента, а своим редактором человек правит мимо него.
test('И-2: аварийный выход НЕ открывает журнал — иммутабельность не снимается на время', (t) => {
  const p = makeProject(t, {
    tasks: ['T-001'],
    extraConfig: 'guard:\n  write_outside_worktree: off\n',
  })
  addWorktree(p, 'T-001')

  const r = guard(p, '.firm/events/2026-09-30T12-00-00-000Z-T-001-dev-started.json')
  assert.equal(r.status, 2, `при off журнал обязан остаться закрытым: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /запись в журнал событий инструментом запрещена/)
  assert.match(r.stderr, /--event retracted --corrects/, 'замена названа и здесь')
  // А соседи по `.firm/` при этом по-прежнему разрешены.
  assert.equal(guard(p, '.firm/dashboard.html').status, 0)
})

test('И-9: в проекте не под firm2 хук не вмешивается вовсе', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')
  writeFileSync(join(p.root, '.firm', 'config'), 'engine: agent-dev-firm\n')
  assert.equal(guard(p, 'src/x.py').status, 0, 'хуки плагина видны во всех проектах')
})

test('И-9: нагрузка без пути к файлу хука не касается', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  addWorktree(p, 'T-001')
  const r = p.cli('write-guard.mjs', [], { input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }) })
  assert.equal(r.status, 0)
  const empty = p.cli('write-guard.mjs', [], { input: '' })
  assert.equal(empty.status, 0, 'нет нагрузки — не наше дело')
})

// ── Незакрытая операция git: противоречие двух правил маршрута ────────────────
//
// Нашла сессия проект-Г 02.10.2026. «Стадия пишет только в своё рабочее дерево» и
// «конфликт слияния разрешается в ГЛАВНОМ дереве» упирались друг в друга: пока жива хоть
// одна задача, разрешить конфликт было нельзя. Выйти удалось, только сняв рабочие деревья
// T-007 и T-009 заранее, — а при живых параллельных задачах снимать их нельзя, то есть
// выхода не было бы вовсе.
//
// Признак берётся у git, а не у роли и не по времени, и окно кончается вместе с операцией.
// Поэтому проверяются все четыре состояния подряд, на одной сцене: два последних — про то,
// что окно открыто ШИРЕ конфликтующих файлов и что оно само закрывается.

// `rev-parse --verify` на отсутствующем рефе выходит ненулём, а `p.git` на этом бросает.
function ref(p, name) {
  const r = spawnSync('git', ['-C', p.root, 'rev-parse', '-q', '--verify', name], {
    encoding: 'utf8', env: p.env,
  })
  return (r.stdout || '').trim()
}

function inTree(p, dir) {
  return (...a) => execFileSync('git', ['-C', dir, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...p.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  })
}

// Сцена разрешения конфликта: главное дерево на `feature/ch`, живое дерево `task/T-001`,
// один и тот же файл правлен в обеих ветках по-разному.
function conflictScene(p) {
  commitFile(p, 'app.py', 'общая строка\nбаза\n', 'app.py')
  const wt = addWorktree(p, 'T-001')
  const task = inTree(p, wt)
  writeFileSync(join(wt, 'app.py'), 'общая строка\nиз задачи\n')
  task('add', '-A')
  task('commit', '-qm', 'T-001: правка app.py')
  commitFile(p, 'app.py', 'общая строка\nиз поставки\n', 'поставка: правка app.py')
  return wt
}

// `git merge` на конфликте выходит ненулём, а `p.git` на этом бросает.
function mergeExpectingConflict(p, branch) {
  const r = spawnSync('git', ['-C', p.root, 'merge', '--no-edit', branch], { encoding: 'utf8', env: p.env })
  assert.equal(r.status, 1, `сцена: ожидался конфликт, а не ${r.status}: ${r.stdout}${r.stderr}`)
  assert.ok(ref(p, 'MERGE_HEAD'), 'сцена: слияние не закрыто')
}

test('И-9: пока слияние в главном дереве не закрыто, запись разрешена — и снова запрещена после', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conflictScene(p)

  // 1. До слияния — обычная сборка, запрет на месте.
  assert.equal(guard(p, 'app.py').status, 2, 'до слияния запись в главное дерево запрещена')

  // 2. Конфликт не закрыт — разрешение конфликта это работа Оркестратора, не стадии.
  mergeExpectingConflict(p, 'task/T-001')
  const open = guard(p, 'app.py')
  assert.equal(open.status, 0,
    `разрешать конфликт больше негде: главное дерево — единственное место (${open.stderr})`)

  // 3. Файл добавлен в индекс, слияние ещё не закрыто. Это решение, а не побочный эффект:
  // после `git add` файл уходит из списка неслитых, и «разрешить ровно конфликтующие»
  // вернуло бы тот же запрет в СЕРЕДИНУ операции.
  writeFileSync(join(p.root, 'app.py'), 'общая строка\nразрешено руками\n')
  p.git('add', 'app.py')
  assert.equal(p.git('diff', '--name-only', '--diff-filter=U').trim(), '',
    'сцена: неслитых файлов больше нет, а слияние всё ещё открыто')
  assert.equal(guard(p, 'app.py').status, 0, 'повторная правка того же файла посреди слияния')
  // И сосед, который не конфликтовал вовсе: окно открыто по состоянию, а не по списку файлов.
  assert.equal(guard(p, 'src/helper.py').status, 0, 'разрешены ВСЕ пути, а не только конфликтующие')

  // 4. Слияние закрыто — защита вернулась сама, без всякой уборки.
  p.git('commit', '-qm', 'слияние T-001: конфликт разрешён')
  assert.equal(ref(p, 'MERGE_HEAD'), '', 'сцена: слияние закрыто')
  const after = guard(p, 'app.py')
  assert.equal(after.status, 2, 'окно не смеет оставаться открытым после операции')
  assert.match(after.stderr, /T-001 →/, 'и дерево задачи всё ещё живо')
})

test('И-2: незакрытое слияние не открывает журнал — иммутабельность конфликтом не отменяется', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conflictScene(p)
  mergeExpectingConflict(p, 'task/T-001')

  // Сцена проверена соседним разрешением: код главного дерева сейчас открыт.
  assert.equal(guard(p, 'app.py').status, 0, 'сцена: окно операции открыто')

  const r = guard(p, '.firm/events/2026-09-30T12-00-00-000Z-T-001-dev-started.json')
  assert.equal(r.status, 2, `журнал обязан остаться закрытым: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /запись в журнал событий инструментом запрещена/)
  // Файлам событий и конфликтовать не из чего: один файл на событие (ADR-0003).
  assert.equal(guard(p, '.firm/dashboard.html').status, 0, 'а соседи по .firm/ открыты как всегда')
})

test('И-9: признак не «только merge» — незакрытый rebase открывает окно так же', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conflictScene(p)
  // Посторонняя ветка от базы с той же строкой: rebase поставки на неё даст конфликт.
  p.git('checkout', '-q', '-b', 'other', 'main')
  commitFile(p, 'app.py', 'общая строка\nиз посторонней ветки\n', 'other: правка app.py')
  p.git('checkout', '-q', `feature/${p.change}`)
  assert.equal(guard(p, 'app.py').status, 2, 'сцена: запрет на месте')

  const r = spawnSync('git', ['-C', p.root, 'rebase', 'other'], { encoding: 'utf8', env: p.env })
  assert.notEqual(r.status, 0, `сцена: ожидался конфликт rebase: ${r.stdout}${r.stderr}`)
  assert.equal(ref(p, 'MERGE_HEAD'), '', 'у rebase нет MERGE_HEAD — признак обязан быть другим')

  assert.equal(guard(p, 'app.py').status, 0, 'rebase — такая же незакрытая операция git')

  spawnSync('git', ['-C', p.root, 'rebase', '--abort'], { encoding: 'utf8', env: p.env })
  assert.equal(guard(p, 'app.py').status, 2, 'операция отменена — защита вернулась')
})

// `merge --squash` — тот случай, в котором окно закрывалось РАНЬШЕ операции: MERGE_HEAD
// git здесь не заводит, и из всех признаков оставались только неслитые файлы, которые
// снимает `git add`, то есть сам разрешающий конфликт. Защита возвращалась посреди работы.
// Признак нашёлся того же свойства, что MERGE_HEAD: `SQUASH_MSG` git заводит сам и сам
// удаляет при коммите.
const gitPathExists = (p, name) =>
  existsSync(resolve(p.root, p.git('rev-parse', '--git-path', name).trim()))

test('И-9: конфликтный merge --squash держит окно до коммита, а не до git add', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  conflictScene(p)
  assert.equal(guard(p, 'app.py').status, 2, 'сцена: запрет на месте')

  const r = spawnSync('git', ['-C', p.root, 'merge', '--squash', '--no-edit', 'task/T-001'], {
    encoding: 'utf8', env: p.env,
  })
  assert.notEqual(r.status, 0, `сцена: ожидался конфликт squash: ${r.stdout}${r.stderr}`)
  // Иначе тест доказывал бы первый признак ещё раз: у squash своего мерж-состояния нет.
  assert.equal(ref(p, 'MERGE_HEAD'), '', 'у merge --squash нет MERGE_HEAD')
  assert.ok(gitPathExists(p, 'SQUASH_MSG'), 'сцена: git завёл SQUASH_MSG')
  assert.equal(guard(p, 'app.py').status, 0, 'разрешать конфликт больше негде')

  // Главное. На прежней редакции здесь было бы 2: неслитых файлов не осталось, а других
  // признаков у squash нет — защита возвращалась, не дождавшись коммита.
  writeFileSync(join(p.root, 'app.py'), 'общая строка\nразрешено руками\n')
  p.git('add', 'app.py')
  assert.equal(p.git('diff', '--name-only', '--diff-filter=U').trim(), '',
    'сцена: неслитых файлов нет — значит окно держит уже не этот признак')
  assert.ok(gitPathExists(p, 'SQUASH_MSG'), 'а SQUASH_MSG ещё на месте: операция не закончена')
  assert.equal(guard(p, 'app.py').status, 0, 'окно обязано держаться до конца операции')
  assert.equal(guard(p, 'src/helper.py').status, 0, 'и здесь разрешены все пути, а не конфликтующие')

  // Коммит закрывает операцию, и заготовки сообщения git убирает сам.
  p.git('commit', '-qm', 'squash T-001: конфликт разрешён')
  assert.equal(gitPathExists(p, 'SQUASH_MSG'), false, 'сцена: git удалил SQUASH_MSG при коммите')
  assert.equal(gitPathExists(p, 'MERGE_MSG'), false, 'и MERGE_MSG тоже')
  const after = guard(p, 'app.py')
  assert.equal(after.status, 2, 'окно не смеет оставаться открытым после операции')
  assert.match(after.stderr, /T-001 →/, 'дерево задачи всё ещё живо')
})
