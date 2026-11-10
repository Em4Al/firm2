// Кому принадлежат рабочие деревья и что движок вправе сносить. Разбор прогона проект-В
// 11.10.2026, два дефекта из одной пары:
//
//   Д-3. `orphans()` считал своим ЛЮБОЕ дерево, чья ветка не разобралась в тикет: дерево
//        человека на ветке `docs/…` давало «нет такой задачи», то есть сироту под снос.
//        `prune` (его зовёт предстартовая проверка `/firm-build`) сносил его молча —
//        без `--force`, но чистое дерево сносится и так, а чистым оно становится сразу
//        после коммита. Параллельная работа рядом со сборкой оставалась без безопасного
//        места: главное дерево занято веткой поставки.
//
//   Д-5. При двух живых поставках активной выбиралась ПУСТАЯ (та, которую завели на
//        разведке и ещё не наполнили задачами), потому что единственный цикл проверял
//        правило «пустая» для первой поставки раньше правила «есть открытая работа» для
//        второй. Доска выходила пустой, а раз пуста — все деревья задач читались как
//        «нет такой задачи». Два чистых дерева живых задач снёс бы следующий `prune`.
//
// Первый дефект проверяется деревом человека, второй — деревом настоящей задачи при двух
// поставках. Третья проверка держит то, ради чего уборка и существует: закрытая задача
// своё дерево отдаёт.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { activeChange, activeChangeFindings, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, COMMIT_DATE } from './helpers.mjs'
import { execFileSync } from 'node:child_process'

// Коммит в ЧУЖОМ рабочем дереве: `commitFile` из оснастки умеет только главное.
function commitFile2(p, cwd, file, message) {
  execFileSync('git', ['-C', cwd, 'add', file], { env: p.env })
  execFileSync('git', ['-C', cwd, 'commit', '-qm', message], {
    env: { ...p.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  })
}

const state = (p, ...argv) => {
  const r = p.cli('firm-state.mjs', [...argv, '--json', '--root', p.root])
  let json = null
  try {
    json = JSON.parse(r.stdout || '{}')
  } catch {
    json = null
  }
  return { ...r, json }
}

// Каталог деревьев по умолчанию: <сосед репозитория>.worktrees — так его считает
// `worktreesDir`, когда в конфиге ключа нет.
const wtDir = (p) => join(dirname(p.root), `${basename(p.root)}.worktrees`)

function engineWorktree(p, ticket) {
  const path = join(wtDir(p), ticket)
  mkdirSync(wtDir(p), { recursive: true })
  p.git('worktree', 'add', '-q', '-B', `task/${ticket}`, path, `feature/${p.change}`)
  return path
}

function humanWorktree(p, branch, name) {
  const path = p.sibling(name)
  p.git('worktree', 'add', '-q', '-b', branch, path, 'main')
  return path
}

// Задача закрывается ЖУРНАЛОМ, а не полем в файле: истина по статусу принадлежит журналу
// (ADR-0001), и `computeBoard` считает её именно оттуда. Статус в frontmatter — кэш.
function merge(p, ticket, change = p.change) {
  writeEvent(p.root, {
    change, ticket, stage: 'merge', event: 'finished', actor: 'firm2:firm-devops', source: 'test',
  })
}

function emptyChangeBeside(p, name = 'aa-черновик') {
  mkdirSync(join(p.root, 'openspec', 'changes', name, 'tasks'), { recursive: true })
  return name
}

test('Д-3: дерево человека движку не принадлежит и уборку переживает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const mine = humanWorktree(p, 'docs/груминг', 'groom')
  // Коммит здесь существен: именно ЧИСТОЕ дерево `git worktree remove` сносит без
  // `--force`, то есть опасный момент наступает сразу после коммита груминга, а не когда-то.
  writeFileSync(join(mine, 'note.md'), 'черновик задания\n')
  commitFile2(p, mine, 'note.md', 'груминг: черновик')
  p.cli('firm-state.mjs', ['prune', '--root', p.root])

  assert.ok(existsSync(mine), 'дерево человека снесли — именно это и был дефект')

  const o = state(p, 'orphans').json
  assert.deepEqual(o.orphans, [], `сирот быть не должно: ${JSON.stringify(o.orphans)}`)
  assert.equal(o.foreign.length, 1, 'чужое дерево обязано быть НАЗВАНО, а не просто обойдено')
  assert.match(o.foreign[0].reason, /вне worktrees_dir/)
})

test('Д-5: при двух поставках активна та, где есть открытая работа', (t) => {
  // Имя живой поставки нарочно ПОСЛЕДНЕЕ по алфавиту, пустой — первое: порядок и решал.
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'], status: 'ready' })
  const empty = emptyChangeBeside(p)

  assert.equal(activeChange(p.root), 'zz-живая', `активной стала ${activeChange(p.root)} вместо живой`)
  assert.ok(empty, 'пустая поставка в проекте есть — иначе проверка ни о чём')
})

test('Д-5: пустая поставка активна, когда открытой работы нет ни в одной', (t) => {
  const p = makeProject(t, { change: 'aa-закрытая', tasks: ['T-001'] })
  merge(p, 'T-001')
  mkdirSync(join(p.root, 'openspec', 'changes', 'zz-новая', 'tasks'), { recursive: true })

  assert.equal(activeChange(p.root), 'zz-новая', 'после планирования события идут в новую поставку')
})

test('Д-5: дерево живой задачи не сирота, даже когда рядом пустая поставка', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'], status: 'ready' })
  emptyChangeBeside(p)
  const wt = engineWorktree(p, 'T-001')

  const o = state(p, 'orphans').json
  assert.deepEqual(o.orphans, [], `дерево живой задачи назвали сиротой: ${JSON.stringify(o.orphans)}`)

  p.cli('firm-state.mjs', ['prune', '--root', p.root])
  assert.ok(existsSync(wt), 'дерево живой задачи снесли — ровно то, что чуть не случилось на проект-В')
})

test('закрытая задача своё дерево отдаёт — уборка не разучилась убирать', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = engineWorktree(p, 'T-001')
  merge(p, 'T-001')

  const o = state(p, 'orphans').json
  assert.equal(o.orphans.length, 1, `сирота должна найтись: ${JSON.stringify(o)}`)
  assert.equal(o.orphans[0].ticket, 'T-001')

  p.cli('firm-state.mjs', ['prune', '--root', p.root])
  assert.equal(existsSync(wt), false, 'дерево закрытой задачи должно быть снесено')
})

// ── Д-4. Доска советовала команду, которая по замыслу ничего не сделает ───────
// `sync` намеренно откладывает правку файла задачи, пока её дерево живо: запись из
// главного дерева стоит отказа слияния. Доска же печатала одно предупреждение на оба
// случая — и человек запускал `sync`, который отвечал `deferred`, то есть «не буду».
test('Д-4: про задачу в работе доска не советует sync, а объясняет отсрочку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'ready' })
  engineWorktree(p, 'T-001') // дерево живо — значит патч отложен
  merge(p, 'T-001') // в журнале «влито», в файле «ready» — кэш отстал

  const r = p.cli('firm-state.mjs', ['board', '--root', p.root])
  assert.match(r.stdout, /правка отложена до слияния, истина в журнале/, r.stdout)
  assert.doesNotMatch(r.stdout, /отстал у 1 задач — firm-event\.mjs sync/, 'совет, который не сработает')
})

test('Д-4: про задачу без живого дерева совет остаётся прежним', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], status: 'ready' })
  merge(p, 'T-001')

  const r = p.cli('firm-state.mjs', ['board', '--root', p.root])
  assert.match(r.stdout, /отстал у 1 задач — firm-event\.mjs sync/, r.stdout)
  assert.doesNotMatch(r.stdout, /отложена/, 'откладывать нечего: дерева нет')
})

// ── Закреплённая поставка: человек объявляет, движок не угадывает ─────────────
// Ключ `active_change` до 0.4.72 был фантомом: он описан в комментарии к `activeChange`,
// пишется в синтетический конфиг рубежа — и не читался ни одной строкой кода.
test('active_change сильнее расчёта: закреплена пустая, хотя работа есть рядом', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'], status: 'ready' })
  const empty = emptyChangeBeside(p)
  writeFileSync(join(p.root, '.firm', 'config'), `${readFileSync(join(p.root, '.firm', 'config'), 'utf8')}\nactive_change: ${empty}\n`)

  assert.equal(activeChange(p.root), empty, 'объявление человека сильнее расчёта движка')
  assert.deepEqual(activeChangeFindings(p.root), [], 'имя существует — претензий нет')
})

test('active_change с несуществующим именем не откатывается к догадке', (t) => {
  const p = makeProject(t, { change: 'zz-живая', tasks: ['T-001'], status: 'ready' })
  writeFileSync(join(p.root, '.firm', 'config'), `${readFileSync(join(p.root, '.firm', 'config'), 'utf8')}\nactive_change: нет-такой\n`)

  assert.equal(activeChange(p.root), null, 'тихий откат к расчёту прятал бы расхождение с человеком')
  const f = activeChangeFindings(p.root)
  assert.equal(f.length, 1, 'причина должна быть названа')
  assert.match(f[0], /нет-такой/)

  const d = p.evJson('doctor')
  assert.equal(d.json.ok, false, 'пока активная поставка не определена, зелёный doctor врёт')
  assert.equal(d.json.active_change_findings.length, 1)

  const ph = state(p, 'phase').json
  assert.equal(ph.change_from, 'active_change из конфига')
  assert.equal(ph.active_change_findings.length, 1)
})

// ── Чужие КАТАЛОГИ рядом с деревьями (Д-8.5) ─────────────────────────────────
// Разбор проект-В 13.10.2026: прогон отчитался «чисто, ничего не требует очистки», а в
// каталоге рабочих деревьев лежало 377 МБ — из них 150 МБ копия репозитория `_t101-probe`,
// сделанная ролью ради замера. Для git это не дерево, поэтому `worktree prune` его не
// видит; `unregisteredDirs` тоже — он смотрит только имена вида `T-XXX` и только пустые
// скорлупы. Молчание уборки человек читает как «там чисто».
test('копия репозитория рядом с деревьями названа и НЕ снесена', (t) => {
  const p = makeProject(t, { tasks: ['T-101'] })
  const probe = join(wtDir(p), '_t101-probe')
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'big.bin'), 'x'.repeat(200000))

  const o = state(p, 'orphans').json
  assert.equal(o.strays.length, 1, JSON.stringify(o.strays))
  assert.equal(o.strays[0].path, probe)
  // `null >= 0` в JS это true, поэтому проверяем тип: «не знаю» и «ноль» — разные ответы
  // (И-12), и утверждение обязано различать их, иначе пропустит пропавший размер.
  assert.equal(typeof o.strays[0].size_mb, 'number', 'размер нужен человеку: 150 МБ и 1 МБ — разные решения')
  assert.ok(o.strays[0].size_mb > 0)
  assert.match(o.strays[0].reason, /движок не создавал/)
  assert.ok(!o.orphans.some((x) => x.path === probe), 'в сироты под снос такой каталог не попадает')

  state(p, 'prune')
  assert.ok(existsSync(probe), 'внутри может быть работа человека — уборка его не трогает')
})

test('своё дерево задачи чужим каталогом не объявляется', (t) => {
  const p = makeProject(t, { tasks: ['T-101'] })
  engineWorktree(p, 'T-101')
  const o = state(p, 'orphans').json
  assert.deepEqual(o.strays, [], 'зарегистрированное дерево движок уже назвал в своих списках')
})

// ── Дерево основания сверки (BR-165, 0.4.109) ─────────────────────────────────
// Движок сам заводит дерево на ветке-цели, чтобы снять красные, с которыми сверяется
// утверждение приёмки. Имени задачи у него нет по построению — и ровно поэтому оно
// попадало в `foreign` с объяснением «ветка не про задачу, не наше дерево»: движок говорил
// про своё собственное дерево то же, что про дерево человека. Разница не косметическая:
// «не трогаю, потому что знаю, что здесь» человек проверяет, «не трогаю, потому что не
// моё» — принимает на слово.
test('деревья основания названы своими, а не чужими, и уборка их не трогает', (t) => {
  const p = makeProject(t, { tasks: ['T-101'] })
  mkdirSync(wtDir(p), { recursive: true })
  // Их два, и признак у них общий — имя с подчёркивания. `_base` появился 30.10.2026
  // вместе со снятием красных точки ветвления движком; поимённый список из одного `_trunk`
  // объявил бы второе дерево чужим в тот же день, когда движок его завёл.
  const trunkPath = join(wtDir(p), '_trunk')
  const basePath = join(wtDir(p), '_base')
  p.git('worktree', 'add', '-q', '--detach', trunkPath, 'main')
  p.git('worktree', 'add', '-q', '--detach', basePath, 'main')

  const o = state(p, 'orphans').json
  assert.equal(o.trunk.length, 2, 'оба дерева названы отдельно, а не свалены в чужие')
  assert.deepEqual(o.trunk.map((x) => x.path).sort(), [basePath, trunkPath].sort())
  for (const x of o.trunk) {
    assert.match(x.reason, /основани/i, 'сказано, ЧТО в этом дереве, а не только что его не трогают')
  }
  assert.match(
    o.trunk.find((x) => x.path === basePath).reason, /точк[еи] ветвления/i,
    'у дерева задач своя половина сравнения, и названа она своим именем',
  )
  for (const path of [trunkPath, basePath]) {
    assert.ok(!o.foreign.some((x) => x.path === path), 'своё дерево чужим не объявляется')
    assert.ok(!o.orphans.some((x) => x.path === path), 'и под снос не попадает')
  }
  assert.deepEqual(o.strays, [], 'как зарегистрированные деревья — и не чужие каталоги')

  state(p, 'prune')
  assert.ok(existsSync(trunkPath), 'основание сверки переснимается, а не заводится заново каждой волной')
  assert.ok(existsSync(basePath), 'и прогрев дерева задач переживает уборку — ради него оно и постоянное')
})
