// Артефакт стадии — это КОММИТ, а не рабочее дерево. Разбор 04.10.2026 по 30
// отклонённым заходам четырёх пилотов: примерно седьмая часть отклонений — не про
// продукт, а про `git add`. Ревьюер пишет «функционально сильно» и отклоняет, потому что
// тестовый файл остался untracked и при слиянии исчезнет. Цена каждого такого случая —
// полный второй заход dev → test → review (медиана 59 минут против 24 у задачи,
// принятой с первого раза).
//
// Проверяется граница, на которой это ловится: финиш стадии в хуке. Сцена настоящая —
// `git worktree add` по тому самому пути, который движок считает деревом задачи
// (`worktreesDir`), иначе проверка смотрела бы в пустоту и тест зеленел бы впустую.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { worktreesDir } from '../scripts/lib/firm.mjs'
import { makeProject, COMMIT_DATE } from './helpers.mjs'

// Дерево задачи ровно там, где его ищет движок: <родитель>/<проект>.worktrees/<тикет>.
// `p.sibling()` из общей оснастки для этого не годится — он даёт случайный каталог,
// про который `uncommittedInTaskWorktree` ничего не знает.
function taskWorktree(t, p, ticket) {
  const dir = worktreesDir(p.root, null)
  const wt = join(dir, ticket)
  p.git('worktree', 'add', '-q', '-B', `task/${ticket}`, wt, `feature/${p.change}`)
  t.after(() => {
    try {
      p.git('worktree', 'remove', '--force', wt)
    } catch { /* каталог мог быть снесён самим тестом */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return wt
}

function gitIn(p, wt, ...a) {
  return execFileSync('git', ['-C', wt, ...a], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...p.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  })
}

// Финиш стадии так, как его присылает рантайм: привязка по ветке рабочего каталога.
function finish(p, { stage, cwd }) {
  const agent = {
    dev: 'firm2:firm-developer',
    test: 'firm2:firm-tester',
    review: 'firm2:firm-reviewer-qa',
  }[stage]
  assert.ok(agent, `неизвестная стадия сцены: ${stage}`)
  return p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: agent,
      hook_event_name: 'SubagentStop',
      cwd,
      agent_id: `${stage}-1`,
      last_assistant_message: 'готово',
    }),
  })
}

function events(p) {
  return p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
}

test('финиш test: неотслеживаемый тестовый файл в дереве задачи — exit 2 и файл назван', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  writeFileSync(join(wt, 'test_t001.py'), 'def test_x():\n    assert True\n')

  const r = finish(p, { stage: 'test', cwd: wt })
  assert.equal(r.status, 2,
    `именно за это ревью отклоняло задачу через час работы: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /НЕ закоммичена/)
  assert.match(r.stderr, /test_t001\.py/, 'роль обязана узнать, какой файл потеряется')
  // Команда собирается из ИМЁН, а не из `-A`: разбор проект-В 11.10.2026 (Д-5) — роль
  // выполнила `add -A` дословно и втянула в коммит чужой профиль Chrome, 296 файлов.
  assert.match(r.stderr, /git -C .*T-001 add -- test_t001\.py/, 'и чем это чинится')
  assert.doesNotMatch(r.stderr, /git -C \S+ add -A/, 'готовая команда с -A и была механизмом дефекта')

  // Событие пишется ДО проверки: журнал не вправе молчать о состоявшейся стадии.
  const [e] = events(p)
  assert.equal(e.stage, 'test')
  assert.equal(e.event, 'finished')
  assert.equal(e.ticket, 'T-001')
})

test('финиш dev: правка отслеживаемого файла без коммита — тот же отказ', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  // Файл под версией, правка в рабочем дереве: `?? ` его не покажет, покажет ` M `.
  writeFileSync(join(wt, 'src.py'), 'print(1)\n')
  gitIn(p, wt, 'add', 'src.py')
  gitIn(p, wt, 'commit', '-qm', 'основание')
  writeFileSync(join(wt, 'src.py'), 'print(2)\n')

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /M src\.py/, 'незакоммиченная правка теряется так же, как новый файл')
  assert.equal(events(p).length, 1, 'событие стадии всё равно записано')
})

test('чистое дерево задачи — exit 0 и ни слова в stderr', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  writeFileSync(join(wt, 'test_t001.py'), 'def test_x():\n    assert True\n')
  gitIn(p, wt, 'add', '-A')
  gitIn(p, wt, 'commit', '-qm', 'работа стадии')

  const r = finish(p, { stage: 'test', cwd: wt })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.equal(r.stderr.trim(), '',
    'ложная тревога на каждом финише обесценивает настоящую')
  assert.equal(events(p).length, 1)
})

test('финиш review при грязном дереве задачи — движок молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  writeFileSync(join(wt, 'проверка-гипотезы.txt'), 'пробник ревьюера\n')

  const r = finish(p, { stage: 'review', cwd: wt })
  assert.equal(r.status, 0,
    `Ревьюер читает, а не производит: его пробники — его дело: ${r.stdout}${r.stderr}`)
  assert.equal(r.stderr.trim(), '')
})

test('следы движка под .firm/ грязью не считаются', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  mkdirSync(join(wt, '.firm', 'events'), { recursive: true })
  writeFileSync(join(wt, '.firm', 'events', 'x.json'), '{}\n')
  writeFileSync(join(wt, '.firm', 'current.json'), '{}\n')

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 0,
    `журнал и доску ведёт движок в главном дереве, роль за них не отвечает: ${r.stderr}`)
  assert.equal(r.stderr.trim(), '')
})

test('дерева задачи нет вовсе — молчим, а не падаем', (t) => {
  // Задача со своим `worktree` в конфиге (или стадия, запущенная до создания дерева):
  // каталога по имени тикета нет, и выдумывать ответ движок не вправе.
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = p.sibling('T-001') // дерево ЕСТЬ, но не там, где его ищет движок
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  writeFileSync(join(wt, 'test_t001.py'), 'def test_x():\n    assert True\n')

  const r = finish(p, { stage: 'test', cwd: wt })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.equal(r.stderr.trim(), '')
  assert.equal(events(p).length, 1, 'событие при этом пишется как обычно')
})

test('старт стадии грязь не проверяет — дерево ещё не её работа', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  writeFileSync(join(wt, 'хвост-прошлой-попытки.txt', ), 'мусор\n')

  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-developer',
      hook_event_name: 'SubagentStart',
      cwd: wt,
      agent_id: 'dev-1',
      prompt: 'FIRM2-TICKET: T-001\nFIRM2-CHANGE: ch',
    }),
  })
  assert.equal(r.status, 0, `спрашивать о коммите на старте бессмысленно: ${r.stderr}`)
  assert.equal(r.stderr.trim(), '')
})


// ── Д-5. Движок не пропустил мусор — он велел его закоммитить ─────────────────
// Разбор проект-В 11.10.2026. Браузерная проверка задачи T-079 оставила в рабочем дереве
// профиль Chrome (296 файлов, 4,1 МБ). На финише стадии СОСЕДНЕЙ задачи T-086 хук
// остановил стадию с готовой командой `git add -A && git commit` — и роль выполнила её
// дословно. В поставку уехал коммит, где четыре настоящих файла тонут в 296 чужих.
//
// Проверка при этом правильная и обоснована замером (седьмая часть отклонений ревью —
// про забытый `git add`). Неправильно было ПРЕДПИСАНИЕ. Отсюда три проверки ниже:
// команда собирается из имён, узнанный артефакт прогона в неё не попадает и называется
// отдельно, а свалка из неузнанных файлов готовой команды не получает вовсе.

// Профиль Chrome так, как его оставляет браузерная проверка: каталог внутри дерева,
// имя — от задачи, которая проверку гоняла.
function chromeProfile(wt, n = 25, name = 'web/.browser-check-t079-qa/profile-qejGPx') {
  mkdirSync(join(wt, name, 'Default'), { recursive: true })
  for (let i = 0; i < n; i++) writeFileSync(join(wt, name, 'Default', `blob-${i}.bin`), 'x'.repeat(2048))
  return name
}

test('Д-5: артефакт прогона назван отдельно и в команду коммита НЕ попадает', (t) => {
  const p = makeProject(t, { tasks: ['T-086'] })
  const wt = taskWorktree(t, p, 'T-086')
  writeFileSync(join(wt, 'header.tsx'), 'export const H = () => null\n')
  chromeProfile(wt, 25)

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 2, `работа не закоммичена — стадию держим: ${r.stderr}`)
  assert.match(r.stderr, /Похоже на артефакты прогана|Похоже на артефакты прогона/)
  assert.match(r.stderr, /web\/\.browser-check-t079-qa/, 'мусор обязан быть НАЗВАН, а не выброшен молча')
  assert.match(r.stderr, /\$TMPDIR/, 'и сказано, где его место')

  const cmd = r.stderr.split('\n').find((l) => l.includes('add --'))
  assert.ok(cmd, `команда коммита должна быть: ${r.stderr}`)
  assert.match(cmd, /header\.tsx/, 'своя работа в команде есть')
  assert.doesNotMatch(cmd, /browser-check/, 'а чужой профиль в неё не попадает — это и был дефект')
})

test('Д-5: только артефакт прогона — стадию не держим, но говорим', (t) => {
  const p = makeProject(t, { tasks: ['T-086'] })
  const wt = taskWorktree(t, p, 'T-086')
  writeFileSync(join(wt, 'header.tsx'), 'export const H = () => null\n')
  gitIn(p, wt, 'add', '-A')
  gitIn(p, wt, 'commit', '-qm', 'работа стадии')
  chromeProfile(wt, 25)

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 0, `коммит роли на месте — возвращать её в работу незачем: ${r.stderr}`)
  assert.match(r.stderr, /browser-check/, 'но каталог обязан быть назван: иначе доживёт до чужого add -A')
})

test('Д-5: неузнанная свалка готовой команды не получает', (t) => {
  const p = makeProject(t, { tasks: ['T-086'] })
  const wt = taskWorktree(t, p, 'T-086')
  writeFileSync(join(wt, 'header.tsx'), 'export const H = () => null\n')
  // Тридцать файлов, которых образцы не знают: движку неизвестно, работа это или нет —
  // и именно поэтому он не вправе предлагать команду, которая закоммитит всё.
  mkdirSync(join(wt, 'какой-то-каталог'), { recursive: true })
  for (let i = 0; i < 30; i++) writeFileSync(join(wt, 'какой-то-каталог', `f-${i}.dat`), 'y'.repeat(100))

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /слишком много/)
  assert.match(r.stderr, /какой-то-каталог/, 'место скопления названо одной строкой, а не тридцатью')
  assert.doesNotMatch(r.stderr, /git -C \S+ add -A/)
  assert.doesNotMatch(r.stderr, /add -- header/, 'готовой команды тут быть не должно вовсе')
  assert.match(r.stderr, /add -- <файл>/, 'форма команды подсказана, имена роль подставит сама')
})

test('Д-5: большой ОДИН файл тоже свалка — порог считает байты, а не только штуки', (t) => {
  const p = makeProject(t, { tasks: ['T-086'] })
  const wt = taskWorktree(t, p, 'T-086')
  writeFileSync(join(wt, 'dump.bin'), 'z'.repeat(1048577))

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /слишком много/)
  assert.doesNotMatch(r.stderr, /add -- dump\.bin/, 'мегабайт двоичного — не результат стадии')
})

test('имя файла с кириллицей печатается как есть и годится для команды', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = taskWorktree(t, p, 'T-001')
  // git по умолчанию отдаёт такое имя октальными escape-последовательностями, и движок
  // печатал бы роли имя, которого в дереве нет, а команда `git add` его не нашла бы.
  writeFileSync(join(wt, 'протокол-проверки.md'), 'что прошло\n')

  const r = finish(p, { stage: 'dev', cwd: wt })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /протокол-проверки\.md/, 'имя обязано дойти до роли читаемым')
  assert.doesNotMatch(r.stderr, /\\3\d\d/, 'октальные escape-последовательности в имени — приписка не туда')
})
