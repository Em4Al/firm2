// Право снимать тесты: решение человека 10.11.2026, первый из двух отложенных шагов уборки.
//
// До него права не имела ни одна роль, и это стоило больше, чем выглядело: набор только рос,
// а дифф, снимающий хоть один тест, Ревьюер отклонял — не по разбору, а потому что законного
// снятия в его правилах не существовало вовсе. Право при этом не может быть голым: тест —
// это чьё-то решение о том, что важно, и отменять его молча нельзя.
//
// Машина здесь делает ровно то, что проверяемо чтением файлов (критерий машинных мест в
// CLAUDE.md): СВЕРЯЕТ снимки и называет каждый снятый тест. Суждение «ловится ли это
// чем-то ещё» машинного ответа не имеет — и именно поэтому возвращается как «требует
// карточки», а не как разрешение (И-12).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject, commitFile, SCRIPTS } from './helpers.mjs'

// Набор, с которого начинает каждая расстановка: четыре теста, и каждый своего класса.
//
// Собирается СКЛЕЙКОЙ, а не литералом, и это не причуда: разбор окупаемости гоняется по
// собственному набору движка (`test-audit.test.mjs`), и дословный `test('…', () => {` в
// оснастке он прочитал бы как настоящий тест без утверждений — четыре находки на пустом
// месте. Разбор, который врёт на своём же репозитории, обесценивает каждую свою находку;
// та же причина, по которой в `lib/tests.mjs` тело теста разбирается по скобкам.
const T = 'test'
const CASE = (name, body, mark = '') =>
  `${mark}${T}('${name}', () => {\n${body}\n})\n`
const BEFORE =
  "import test from 'node:test'\n" +
  "import assert from 'node:assert/strict'\n\n" +
  CASE('И-7: журнал только дописывается', '  assert.equal(1, 1)') + '\n' +
  CASE('складывает два числа', '  assert.equal(add(2, 2), 4)') + '\n' +
  CASE(
    'конфиг читается с кириллицей',
    "  assert.ok(parse('ключ: значение'))",
    '// firm2: тест оставить — держит формат конфига, который читают четыре проекта\n',
  ) + '\n' +
  CASE('зонд покрытия', '  add(2, 2)')

function setup(t, after) {
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(join(p.root, 'tests'), { recursive: true })
  commitFile(p, 'tests/unit.test.mjs', BEFORE, 'tests: набор до снятия')
  const base = execFileSync('git', ['-C', p.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', ...p.env ? { env: p.env } : {} }).trim()
  if (after !== null) writeFileSync(join(p.root, 'tests/unit.test.mjs'), after)
  return { p, base }
}

function removals(p, base, extra = []) {
  const out = execFileSync('node', [join(SCRIPTS, 'test-audit.mjs'), '--removed', '--base', base, '--json', '--root', p.root, ...extra], {
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

test('снятое называется поимённо, а снятие кандидата машинного разбора обосновано замером', (t) => {
  // Снят «зонд покрытия» — тест без единого утверждения, то есть класс, который разбор
  // печатает находкой с 0.4.80.
  const { p, base } = setup(t, BEFORE.replace(CASE('зонд покрытия', '  add(2, 2)'), ''))
  const r = removals(p, base)
  assert.equal(r.checked, true)
  assert.equal(r.removed.length, 1, 'снятый тест назван, а не посчитан')
  assert.equal(r.removed[0].test, 'зонд покрытия')
  assert.equal(r.removed[0].file, 'tests/unit.test.mjs')
  assert.equal(r.removed[0].machine_candidate, 'без утверждений')
  assert.equal(r.removed[0].verdict, 'обосновано замером')
})

test('снятие теста, которого разбор кандидатом не называл, требует карточки — это не запрет', (t) => {
  const { p, base } = setup(t, BEFORE.replace(CASE('складывает два числа', '  assert.equal(add(2, 2), 4)'), ''))
  const r = removals(p, base)
  assert.equal(r.removed.length, 1)
  assert.equal(r.removed[0].test, 'складывает два числа')
  assert.equal(r.removed[0].machine_candidate, null)
  assert.equal(r.removed[0].verdict, 'требует карточки')
  assert.match(r.removed[0].why, /машинного довода за снятие нет/)
  assert.match(r.removed[0].why, /firm-test-audit/, 'названо, чем снятие обосновывается')
})

test('помеченный человеком тест снять нельзя: исход «запрещено», а не предупреждение', (t) => {
  const { p, base } = setup(t, BEFORE.replace(
    CASE(
      'конфиг читается с кириллицей',
      "  assert.ok(parse('ключ: значение'))",
      '// firm2: тест оставить — держит формат конфига, который читают четыре проекта\n',
    ),
    '',
  ))
  const r = removals(p, base)
  assert.equal(r.removed.length, 1)
  assert.equal(r.removed[0].kept_by_human, true)
  assert.equal(r.removed[0].verdict, 'запрещено')
  assert.match(r.removed[0].why, /записанное решение человека/)
})

test('тест, названный инвариантом, тоже запрещён: его снятие — правка доменной модели', (t) => {
  const { p, base } = setup(t, BEFORE.replace(CASE('И-7: журнал только дописывается', '  assert.equal(1, 1)'), ''))
  const r = removals(p, base)
  assert.equal(r.removed.length, 1)
  assert.equal(r.removed[0].invariant_named, true)
  assert.equal(r.removed[0].verdict, 'запрещено')
  assert.match(r.removed[0].why, /доменной модели/)
})

test('переписанный тест — не снятый: снято одно, добавлено одно, и оба названы числом', (t) => {
  const after = BEFORE.replace(
    CASE('зонд покрытия', '  add(2, 2)'),
    CASE('зонд покрытия: теперь с утверждением', '  assert.equal(add(2, 2), 4)'),
  )
  const { p, base } = setup(t, after)
  const r = removals(p, base)
  assert.equal(r.removed.length, 1, 'имя сменилось — старое имя снято, и об этом сказано')
  assert.equal(r.added, 1, 'добавленное считается отдельно: переписывание не прячется в нуле')
})

test('снесённый файл проверок — это снятие всех его тестов, а не отсутствие находок', (t) => {
  const { p, base } = setup(t, null)
  execFileSync('git', ['-C', p.root, 'rm', '-q', '--', 'tests/unit.test.mjs'])
  const r = removals(p, base)
  assert.equal(r.removed.length, 4, 'все четыре теста файла названы поимённо')
  assert.equal(r.removed.filter((x) => x.verdict === 'запрещено').length, 2, 'и два из них снимать нельзя')
})

test('ничего не снято — так и сказано, а не молчанием', (t) => {
  const { p, base } = setup(t, BEFORE + '\n' + CASE('ещё один', '  assert.ok(true)'))
  const r = removals(p, base)
  assert.equal(r.checked, true)
  assert.deepEqual(r.removed, [])
  assert.equal(r.added, 1)
})

test('сверка без основания — «не проверено» с причиной, а не пустой список', (t) => {
  const { p } = setup(t, BEFORE)
  const out = execFileSync('node', [join(SCRIPTS, 'test-audit.mjs'), '--removed', '--json', '--root', p.root], { encoding: 'utf8' })
  const r = JSON.parse(out)
  assert.equal(r.checked, false)
  assert.match(r.why, /основание/)
  assert.deepEqual(r.removed, [], 'пустой список при checked: false не значит «ничего не снято»')
})

test('несуществующий ref — тоже «не проверено», а не «снятого нет»', (t) => {
  const { p } = setup(t, BEFORE)
  const r = removals(p, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  assert.equal(r.checked, false)
  assert.match(r.why, /git не ответил/)
})

test('опечатка в флаге сверки отвергается, а не читается как разбор набора', (t) => {
  const { p } = setup(t, BEFORE)
  const r = spawnSync('node', [join(SCRIPTS, 'test-audit.mjs'), '--remove', '--base', 'HEAD', '--root', p.root], { encoding: 'utf8' })
  assert.equal(r.status, 2, 'цена опечатки здесь — НЕВЕРНЫЙ ОТВЕТ: «--remove» молча напечатал бы разбор набора')
  assert.equal(r.stdout, '', 'и ни строки разбора, которую можно прочесть как «снятого нет»')
  assert.match(r.stderr, /неизвестный флаг --remove/)
})

// ── Вторая половина права: сверка доезжает до Ревьюера промптом ──────────────────────────
//
// Условие права («снятие не бывает молчаливым»), оставленное в одном промпте Ревьюера, было
// бы просьбой — а просьбу роль обходит, когда исполнить нельзя или некогда (CLAUDE.md, раздел
// о машинных местах). Поэтому сверку снятого снимает ДВИЖОК и кладёт Ревьюеру в промпт тем
// же зондом, что и дифф: лишнего вызова это не стоит, те же две команды по той же ветке.
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

async function runBuild(diffAnswer) {
  const prompts = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ba5e00000000', head: 'ba5e00000000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: [], merged: [], workable: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt/T-001', branch: 'task/T-001' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
    if (label.startsWith('дифф:')) return diffAnswer
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) {
      prompts.push(prompt)
      return { verdict: 'принято', notes: 'ок' }
    }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof', merges_checked: true, unfinished_merges: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, () => {}, () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '/wt',
    tasks: [{ id: 'T-001', path: 'tasks/T-001.md', labels: [], parallel_safe: true, depends_on: [] }],
    now: '2026-11-10T12:00:00Z',
  }))
  return prompts.join('\n---\n')
}

test('зонд диффа спрашивает и сверку снятого — тем же вызовом, не новым', async () => {
  const prompts = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label.startsWith('дифф:')) {
      prompts.push(prompt)
      return { state: 'ok', base: 'ba5e', files: [], added: 0, deleted: 0, removed: [], removed_checked: true }
    }
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ba5e00000000', head: 'ba5e00000000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: [], merged: [], workable: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt/T-001', branch: 'task/T-001' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [], checked: true, how: 'lsof', merges_checked: true, unfinished_merges: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, () => {}, () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '/wt',
    tasks: [{ id: 'T-001', path: 'tasks/T-001.md', labels: [], parallel_safe: true, depends_on: [] }],
    now: '2026-11-10T12:00:00Z',
  }))
  assert.equal(prompts.length, 1, 'вызов один: лишний зонд стоил бы задаче минуты за тот же ответ')
  assert.match(prompts[0], /test-audit\.mjs" --removed --base/, 'команда сверки дана дословно')
  assert.match(prompts[0], /основанием ИЗ ПЕРВОГО ответа/, 'основание берётся из диффа, а не выдумывается')
  assert.match(prompts[0], /судить снятое будет Ревьюер, а не ты/, 'зонд не судит — он перо')
})

test('снятое с исходом «запрещено» приезжает Ревьюеру как основание отклонить', async () => {
  const qa = await runBuild({
    state: 'ok', base: 'ba5e', files: [], added: 0, deleted: 0, removed_checked: true,
    removed: [{ file: 'tests/unit.test.mjs', line: 4, test: 'И-7: журнал только дописывается', verdict: 'запрещено', why: 'тест назван инвариантом' }],
  })
  assert.match(qa, /СНЯТЫЕ ТЕСТЫ \(1\)/)
  assert.match(qa, /снимать тест роль ВПРАВЕ, молча не вправе/)
  assert.match(qa, /ЗАПРЕЩЕНО снято: 1 — это основание ОТКЛОНИТЬ/)
  assert.match(qa, /И-7: журнал только дописывается/, 'тест назван поимённо')
})

test('снятое без машинного довода приезжает как требование карточки, а не как запрет', async () => {
  const qa = await runBuild({
    state: 'ok', base: 'ba5e', files: [], added: 0, deleted: 0, removed_checked: true,
    removed: [{ file: 'tests/unit.test.mjs', line: 9, test: 'складывает два числа', verdict: 'требует карточки', why: 'машинного довода за снятие нет' }],
  })
  assert.match(qa, /ТРЕБУЕТ КАРТОЧКИ: 1/)
  assert.match(qa, /firm-test-audit/)
  assert.doesNotMatch(qa, /основание ОТКЛОНИТЬ/, 'отсутствие машинного довода — не запрет')
  assert.match(qa, /судишь ДОВОД, а не вкус/, 'граница независимости названа тут же')
})

test('сорванная сверка приезжает как «не проверено», а не как «не снято»', async () => {
  const qa = await runBuild({
    state: 'ok', base: 'ba5e', files: [], added: 0, deleted: 0, removed_checked: false, removed: [],
  })
  assert.match(qa, /СНЯТЫЕ ТЕСТЫ СВЕРИТЬ НЕ УДАЛОСЬ/)
  assert.match(qa, /«не проверено», а не «не снято»/)
  assert.match(qa, /ось снятых тестов у тебя НЕ пройдена/)
})

test('снятого нет — сказано именно это, и сказано сверкой', async () => {
  const qa = await runBuild({
    state: 'ok', base: 'ba5e', files: [], added: 0, deleted: 0, removed_checked: true, removed: [], removed_added: 2,
  })
  assert.match(qa, /Снятых тестов нет: сверка движка/)
  assert.match(qa, /добавлено 2/)
})
