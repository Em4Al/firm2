// Учётные записи груминга (ADR-0012). Проверяется ровно то, на чём держится решение:
// номер не переиспользуется, запись не теряется от битого файла, а ФАКТИЧЕСКОЕ состояние
// берётся из git, а не из объявленного человеком статуса.
//
// Почему последнее важно отдельной проверкой. Вся цена дефектов 11.10.2026 была в том, что
// движок СЧИТАЛ состояние вместо того, чтобы его знать: «активная поставка» выводилась
// из формы каталогов и выводилась неверно. Здесь противоположное устройство — статус
// объявлен (`grooming` → `groomed` → `planned`), факт прочитан (дерево, ветка, досье), — и
// расхождение между ними не прячется, а называется находкой.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  groomBranch, groomDossierDir, groomFindings, groomFromBranch, groomPath, groomState,
  groomView, groomWorktreesDir, listGroom, nextGroomId, readGroom, usedGroomIds, writeGroom,
} from '../scripts/lib/firm.mjs'
import { execFileSync } from 'node:child_process'
import { buildDashboard } from '../scripts/dashboard.mjs'
import { makeProject, COMMIT_DATE } from './helpers.mjs'

// Дерево груминга — ровно там и ровно на той ветке, которые считает движок: если тест
// заведёт его в другом месте, проверка «дерево живо» станет проверкой самой себя.
function groomWorktree(t, p, id, slug) {
  const dir = groomWorktreesDir(p.root, null)
  const path = join(dir, `${id}-${slug}`)
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  p.git('worktree', 'add', '-q', '-b', groomBranch(id, slug), path, 'main')
  return path
}

// Досье пишется ТАМ, где идёт груминг: в своём дереве, на своей ветке. В главное дерево
// оно приезжает слиянием на планировании — до него главное дерево про досье не знает.
function dossier(p, id, slug, at = p.root) {
  const d = groomDossierDir(at, { id, slug })
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'requirements.md'), `---\nrelease: 3.2\n---\n\n# ${id}\n`)
  return d
}

test('номер груминга сквозной: занят и записью, и каталогом досье', (t) => {
  const p = makeProject(t, {})
  assert.equal(nextGroomId(p.root), 'G-001', 'в пустом проекте первый номер — G-001')

  writeGroom(p.root, { id: 'G-001', slug: 'own-content', title: 'свой контент', status: 'grooming' })
  assert.equal(nextGroomId(p.root), 'G-002')

  // Учётную запись могли снести (`.firm/` не под git), а каталог досье остался в истории.
  // Переиспользование такого номера склеило бы две темы в одном каталоге.
  dossier(p, 'G-007', 'admin-rework')
  assert.equal(nextGroomId(p.root), 'G-008', 'каталог досье без записи обязан занимать номер')
  assert.deepEqual(usedGroomIds(p.root).get('G-007'), ['docs/backlog'])
})

test('запись дополняется, а не переписывается: created держится, updated идёт', async (t) => {
  const p = makeProject(t, {})
  const a = writeGroom(p.root, { id: 'G-001', slug: 'own-content', title: 'свой контент', status: 'grooming', release: '3.2' })
  await new Promise((r) => setTimeout(r, 5))
  const b = writeGroom(p.root, { id: 'G-001', status: 'groomed' })

  assert.equal(b.created, a.created, 'дата появления темы не переписывается статусом')
  assert.notEqual(b.updated, a.updated)
  assert.equal(b.slug, 'own-content', 'частичная запись не должна терять поля')
  assert.equal(b.release, '3.2')
  assert.equal(readGroom(p.root, 'G-001').status, 'groomed')
})

test('мусор в записи не принимается: номер, слаг и статус проверяются', (t) => {
  const p = makeProject(t, {})
  assert.throws(() => writeGroom(p.root, { id: 'G1', slug: 'x' }), /G-001/)
  // Слаг идёт в имя каталога и в имя ветки. Кириллица в нём — та же приписка не туда,
  // что Д-6: имя обрежется или не совпадёт, и досье окажется не там, где его ищут.
  assert.throws(() => writeGroom(p.root, { id: 'G-001', slug: 'своё-содержимое' }), /слаг/)
  assert.throws(() => writeGroom(p.root, { id: 'G-001', slug: 'Own-Content' }), /слаг/)
  assert.throws(() => writeGroom(p.root, { id: 'G-001', slug: 'ok', status: 'готово' }), /статус/)
  assert.equal(existsSync(groomPath(p.root, 'G-001')), false, 'отвергнутая запись не должна оставлять файл')
})

test('битый файл записи — находка, а не отсутствие темы', (t) => {
  const p = makeProject(t, {})
  mkdirSync(join(p.root, '.firm', 'groom'), { recursive: true })
  writeFileSync(groomPath(p.root, 'G-001'), '{ это не json')

  const [rec] = listGroom(p.root)
  assert.equal(rec.id, 'G-001', 'тема обязана остаться видимой: «не разобрал» ≠ «нет темы»')
  assert.match(rec._broken, /JSON/)
  assert.match(groomFindings(p.root)[0], /G-001/)
  // Перезапись поверх битого файла потеряла бы то, что человек мог туда написать руками.
  assert.throws(() => writeGroom(p.root, { id: 'G-001', status: 'groomed' }), /руками/)
})

test('состояние темы читается из git и ФС, а не из статуса', (t) => {
  const p = makeProject(t, {})
  writeGroom(p.root, { id: 'G-001', slug: 'own-content', title: 'свой контент', status: 'grooming' })

  const before = groomState(p.root, readGroom(p.root, 'G-001'))
  assert.equal(before.branch, 'groom/G-001-own-content')
  assert.equal(before.branch_exists, false)
  assert.equal(before.worktree_alive, false)
  assert.equal(before.commits_ahead, null, 'ветки нет — считать нечего, и это не ноль')
  assert.equal(before.dossier, null)

  const wt = groomWorktree(t, p, 'G-001', 'own-content')
  dossier(p, 'G-001', 'own-content', wt)

  const after = groomState(p.root, readGroom(p.root, 'G-001'))
  assert.equal(after.worktree_alive, true)
  assert.equal(after.branch_exists, true)
  assert.equal(after.commits_ahead, 0, 'ветка только что от main — коммитов поверх ноль')
  assert.equal(after.dossier, 'docs/backlog/G-001-own-content', 'досье на ветке груминга — это и есть досье')
  assert.equal(after.dossier_in, 'дерево груминга')

  // А после планирования то же досье лежит в главном дереве, и дерева груминга уже нет.
  const merged = makeProject(t, {})
  writeGroom(merged.root, { id: 'G-001', slug: 'own-content', status: 'planned' })
  dossier(merged, 'G-001', 'own-content')
  assert.equal(groomState(merged.root, readGroom(merged.root, 'G-001')).dossier_in, 'главное дерево')

  // Отказ счёта — не ноль. Ветка есть, а базы нет (или git отказал в песочнице): «не
  // знаю» обязано дойти до читателя, иначе тема покажется не содержащей работы.
  writeGroom(p.root, { id: 'G-001', base: 'нет-такой-базы' })
  assert.equal(groomState(p.root, readGroom(p.root, 'G-001')).commits_ahead, null)
})

test('расхождение объявленного с фактическим называется, а не прячется', (t) => {
  const p = makeProject(t, {})

  // Объявлено «прогрумлено», а досье нет — планировать нечего.
  writeGroom(p.root, { id: 'G-001', slug: 'own-content', status: 'groomed' })
  assert.match(groomFindings(p.root).join('\n'), /G-001 объявлен прогрумленным, а досье нет/)

  dossier(p, 'G-001', 'own-content')
  assert.deepEqual(groomFindings(p.root), [], 'досье появилось — претензия снимается')

  // Объявлено «в работе», а дерева нет — грумить негде.
  writeGroom(p.root, { id: 'G-002', slug: 'backups', status: 'grooming' })
  assert.match(groomFindings(p.root).join('\n'), /G-002 в работе, а дерева нет/)

  // Ушло на планирование, а дерево живо — его пора отдать.
  groomWorktree(t, p, 'G-003', 'admin-rework')
  writeGroom(p.root, { id: 'G-003', slug: 'admin-rework', status: 'planned' })
  dossier(p, 'G-003', 'admin-rework')
  assert.match(groomFindings(p.root).join('\n'), /G-003 уже на планировании, а дерево груминга живо/)

  assert.equal(groomView(p.root).length, 3, 'виден весь груминг разом, а не по одному')
})

test('номер темы достаётся из имени ветки — по нему движок узнаёт своё дерево', () => {
  assert.equal(groomFromBranch('groom/G-012-own-content'), 'G-012')
  assert.equal(groomFromBranch('groom/G-012'), 'G-012')
  assert.equal(groomFromBranch('task/T-001'), null)
  assert.equal(groomFromBranch('docs/груминг'), null, 'ветка человека темой груминга не считается')
  assert.equal(groomFromBranch(null), null)
})

// ── Команды: дерево заводит код, а не промпт ──────────────────────────────────
// Три шага (номер → ветка → дерево) человек и роль сделают по-разному, и тогда движок не
// найдёт ни дерева, ни досье там, где их ищет. Поэтому шаги в коде, и проверяется ровно
// их связность: что завелось — то и видно в `groom list`, и то же самое уборка обходит.
const st = (p, ...argv) => {
  const r = p.cli('firm-state.mjs', [...argv, '--root', p.root])
  let json = null
  try {
    json = JSON.parse(r.stdout || '{}')
  } catch { json = null }
  return { ...r, json }
}

// Каталог деревьев груминга создаёт сама команда — за уборкой следим здесь.
const willClean = (t, p) => t.after(() => rmSync(groomWorktreesDir(p.root, null), { recursive: true, force: true }))

test('groom new: номер, ветка и дерево заводятся одним действием', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)

  const r = st(p, 'groom', 'new', '--title', 'Own content beside the built-in', '--release', '3.2')
  assert.equal(r.json.ok, true, r.stderr || r.stdout)
  assert.equal(r.json.id, 'G-001')
  assert.equal(r.json.slug, 'own-content-beside-the-built-in', 'слаг выводится из латинского заголовка')
  assert.equal(r.json.branch, 'groom/G-001-own-content-beside-the-built-in')
  assert.equal(r.json.status, 'grooming')
  assert.equal(r.json.release, '3.2')
  assert.ok(existsSync(r.json.worktree), `дерева нет: ${r.json.worktree}`)

  const list = st(p, 'groom', 'list').json
  assert.equal(list.count, 1)
  assert.equal(list.groom[0].worktree_alive, true)
  assert.deepEqual(list.findings, [], `находок быть не должно: ${JSON.stringify(list.findings)}`)
})

test('groom new: русский заголовок без --slug останавливает, а не выдумывает', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)

  const r = st(p, 'groom', 'new', '--title', 'Редактор карт')
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /--slug/)
  // Номер не должен сгореть: переиспользование номеров запрещено, значит выдавать их
  // впустую нельзя. И дерева тоже быть не должно.
  assert.equal(nextGroomId(p.root), 'G-001', 'отказ не вправе тратить номер')
  assert.equal(st(p, 'groom', 'list').json.count, 0)

  const ok = st(p, 'groom', 'new', '--title', 'Редактор карт', '--slug', 'map-editor')
  assert.equal(ok.json.ok, true, ok.stdout)
  assert.equal(ok.json.title, 'Редактор карт', 'заголовок остаётся человеческим — латиница нужна только пути')
})

test('groom new: дерево не завелось — записи нет и номер цел', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)

  const r = st(p, 'groom', 'new', '--title', 'backups', '--base', 'нет-такой-базы')
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /нет-такой-базы/)
  assert.equal(st(p, 'groom', 'list').json.count, 0, 'тема без дерева — тема, которую некуда грумить')
  assert.equal(nextGroomId(p.root), 'G-001')
})

test('groom new: занятый слаг не выдаётся дважды', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)

  assert.equal(st(p, 'groom', 'new', '--title', 'backups').json.ok, true)
  const r = st(p, 'groom', 'new', '--title', 'Бэкапы', '--slug', 'backups')
  assert.equal(r.json.ok, false, 'два дерева с одним слагом — одно имя ветки на две темы')
  assert.match(r.json.error, /G-001/)
})

test('groom set: правит статус и выпуск, слаг не правит', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)
  st(p, 'groom', 'new', '--title', 'backups')

  assert.match(st(p, 'groom', 'set', 'G-001', '--slug', 'other').json.error, /слаг не меняется/)
  assert.match(st(p, 'groom', 'set', 'G-001', '--status', 'готово').json.error, /статус/)
  assert.match(st(p, 'groom', 'set', 'G-404', '--status', 'groomed').json.error, /не знает/)
  assert.match(st(p, 'groom', 'set', 'G-001').json.error, /нечего менять/)

  const r = st(p, 'groom', 'set', 'G-001', '--status', 'groomed', '--release', '3.3')
  assert.equal(r.json.ok, true, r.stdout)
  assert.equal(r.json.status, 'groomed')
  assert.equal(r.json.release, '3.3')
  // Статус объявлен, досье ещё нет — расхождение называется сразу, в ответе той же команды.
  assert.match(r.json.findings.join('\n'), /досье нет/)
})

test('groom retire: чистое дерево отдаётся, дерево с работой остаётся человеку', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)
  const wt = st(p, 'groom', 'new', '--title', 'backups').json.worktree

  // Незакоммиченная правка — это работа, и отдавать дерево с ней движок не вправе.
  writeFileSync(join(wt, 'черновик.md'), 'на середине\n')
  const busy = st(p, 'groom', 'retire', 'G-001')
  assert.equal(busy.json.ok, false)
  assert.ok(existsSync(wt), 'дерево с работой снесли — это потеря, а не уборка')
  assert.match(busy.json.kept, /черновик|contains modified|modified or untracked/)

  rmSync(join(wt, 'черновик.md'))
  const done = st(p, 'groom', 'retire', 'G-001')
  assert.equal(done.json.ok, true, done.stdout)
  assert.equal(done.json.status, 'planned', 'тема ушла на планирование')
  assert.equal(existsSync(wt), false)
})

test('уборка поставки деревья груминга не касается — и называет их по имени', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)
  const wt = st(p, 'groom', 'new', '--title', 'backups').json.worktree

  const o = st(p, 'orphans').json
  assert.deepEqual(o.orphans, [], `дерево груминга назвали сиротой: ${JSON.stringify(o.orphans)}`)
  assert.deepEqual(o.foreign, [], 'дерево груминга — не «чужое»: движок про него знает по учётной записи')
  assert.equal(o.groom.length, 1)
  assert.equal(o.groom[0].id, 'G-001')
  assert.equal(o.groom[0].status, 'grooming')

  st(p, 'prune')
  assert.ok(existsSync(wt), 'prune снёс дерево груминга — ровно то, от чего защищает ADR-0012')
})

// ── groom land: единственное место, где движок меняет историю ─────────────────
// Четыре отказа вперёд одного слияния, и каждый проверяется отдельно: слияние не в ту
// ветку, слияние поверх незакоммиченных правок человека, слияние, теряющее работу в самом
// дереве груминга, и слияние пустоты. Пятая проверка — что в удачном случае тема реально
// приезжает в главное дерево вместе с досье.
function commitIn(p, cwd, file, text, message) {
  writeFileSync(join(cwd, file), text)
  execFileSync('git', ['-C', cwd, 'add', '-A'], { env: p.env })
  execFileSync('git', ['-C', cwd, 'commit', '-qm', message], {
    env: { ...p.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
  })
}

function groomed(t, p, title = 'backups') {
  willClean(t, p)
  const r = st(p, 'groom', 'new', '--title', title).json
  assert.equal(r.ok, true, JSON.stringify(r))
  mkdirSync(join(r.worktree, 'docs', 'backlog', `${r.id}-${r.slug}`), { recursive: true })
  commitIn(p, r.worktree, join('docs', 'backlog', `${r.id}-${r.slug}`, 'requirements.md'), `---\nrelease: 3.3\n---\n\n# ${title}\n`, `груминг ${r.id}: требования`)
  st(p, 'groom', 'set', r.id, '--status', 'groomed')
  return r
}

test('groom land: тема приезжает в базу вместе с досье, дерево отдаётся', (t) => {
  const p = makeProject(t, {})
  const g = groomed(t, p)
  p.git('checkout', '-q', 'main')

  const r = st(p, 'groom', 'land', g.id).json
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.commits, 1)
  assert.equal(r.status, 'planned')
  assert.ok(existsSync(join(p.root, 'docs', 'backlog', `${g.id}-${g.slug}`, 'requirements.md')), 'досье не приехало в главное дерево')
  assert.equal(existsSync(g.worktree), false, 'дерево отдано')
  assert.match(r.change_name, /^\d{4}-\d{2}-\d{2}-backups$/, 'имя будущей поставки предлагается, но папку заводит планирование')
  assert.equal(existsSync(join(p.root, 'openspec', 'changes', r.change_name)), false, 'папку поставки land не создаёт — это работа планирования')
})

test('groom land: не из базы — отказ, а не слияние в ветку поставки', (t) => {
  const p = makeProject(t, {})
  const g = groomed(t, p)
  // Главное дерево стоит на ветке поставки (так оно и стоит всю сборку). Слить тему сюда
  // значило бы подмешать груминг в поставку и в её MR-дифф.
  const r = st(p, 'groom', 'land', g.id).json
  assert.equal(r.ok, false)
  assert.match(r.error, new RegExp(`feature/${p.change}`))
  assert.equal(st(p, 'groom', 'list').json.groom[0].status, 'groomed', 'отказ не вправе менять статус темы')
})

test('groom land: незакоммиченное не перезаписывается — ни там, ни тут', (t) => {
  const p = makeProject(t, {})
  const g = groomed(t, p)
  p.git('checkout', '-q', 'main')

  writeFileSync(join(g.worktree, 'на-середине.md'), 'ещё пишу\n')
  const a = st(p, 'groom', 'land', g.id).json
  assert.equal(a.ok, false)
  assert.match(a.error, /в дереве груминга есть незакоммиченная работа/)
  rmSync(join(g.worktree, 'на-середине.md'))

  writeFileSync(join(p.root, 'своё.md'), 'правка человека\n')
  const b = st(p, 'groom', 'land', g.id).json
  assert.equal(b.ok, false)
  assert.match(b.error, /в главном дереве есть незакоммиченные правки/)
  assert.ok(existsSync(g.worktree), 'отказ ничего не сносит')
})

test('groom land: пустую ветку вливать нечему', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)
  const g = st(p, 'groom', 'new', '--title', 'backups').json
  p.git('checkout', '-q', 'main')

  const r = st(p, 'groom', 'land', g.id).json
  assert.equal(r.ok, false)
  assert.match(r.error, /нет коммитов поверх/)
})

test('учётная запись не пачкает дерево поставки', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)
  // Главное дерево стоит на ветке поставки — так оно стоит всю сборку.
  assert.match(p.git('rev-parse', '--abbrev-ref', 'HEAD'), new RegExp(`feature/${p.change}`))

  const r = st(p, 'groom', 'new', '--title', 'backups').json
  assert.equal(r.registry_hidden.hidden, true)
  st(p, 'groom', 'set', 'G-001', '--status', 'groomed')

  // Ни нового файла в диффе поставки, ни правки `.gitignore`: запись спрятана локально.
  // Это тот же дефект, что был у `.firm/dashboard.html`, — он пачкал коммиты поставки.
  assert.equal(p.git('status', '--porcelain').trim(), '', `груминг оставил след в дереве поставки:\n${p.git('status', '--porcelain')}`)
})

// ── Дашборд: груминг отдельной вкладкой ──────────────────────────────────────
// Жалоба человека, из которой выросло ADR-0012, была ровно про это: «не хочу, чтобы у
// меня как сейчас ломался дашборд по поставке». Поэтому проверяется и то, что вкладка
// есть, и то, что без груминга её НЕТ — то есть дашборд поставки остаётся прежним.
const dash = (p) => readFileSync(buildDashboard(p.root, p.change), 'utf8')

test('дашборд: без груминга вкладки нет — доска поставки прежняя', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const h = dash(p)
  assert.doesNotMatch(h, /data-tab="groom"/)
  assert.match(h, /data-tab="status"/, 'доска поставки на месте')
})

test('дашборд: груминг сгруппирован по выпуску, и выпуск берётся из досье', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const g = groomed(t, p, 'backups')      // в досье `release: 3.3`, в записи выпуска нет
  st(p, 'groom', 'new', '--title', 'map editor', '--release', '3.2')

  const h = dash(p)
  assert.match(h, /data-tab="groom"/, 'вкладка груминга появилась')
  assert.match(h, /Груминг/)
  assert.match(h, /<h3>3\.2 /, 'выпуск из учётной записи')
  assert.match(h, /<h3>3\.3 /, 'выпуск из фронтматтера досье — там он ближе к требованиям')
  assert.match(h, /G-001/)
  assert.match(h, /прогрумлено/, `статус темы ${g.id} должен быть читаемым словом`)
  assert.match(h, /map editor/)

  // Доска поставки от этого не меняется: задача поставки на месте, груминга в ней нет.
  const status = h.slice(h.indexOf('<section data-tab="status">'), h.indexOf('<section data-tab="timing"'))
  assert.match(status, /T-001/)
  assert.doesNotMatch(status, /G-001/, 'тема груминга не вправе проступать в доске поставки')
})

test('дашборд: тема без выпуска собрана в свою группу, а не потеряна', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  willClean(t, p)
  st(p, 'groom', 'new', '--title', 'map editor')

  assert.match(dash(p), /выпуск не назначен/)
})

// ── Д-15: номер занят носителем, а не его формой ──────────────────────────────
//
// Разбор проект-В 27.10.2026, настоящая коллизия и дважды. Темы `G-012` (провенанс) и
// `G-013` (запасной путь BR-144) завели 25.10.2026 руками — файлом `G-XXX-<слаг>.md` и
// строкой в таблице бэклога, мимо `groom new`. Распределитель номеров считал занятыми
// только КАТАЛОГИ, поэтому выдал `G-012` второй раз «планшету в объёме» (26.10) и `G-013`
// второй раз теме самообслуживания (27.10). `groom list` молчал: он сверяет свой реестр.
//
// Форма досье остаётся каталогом — это не отменяется. Но ЗАНЯТОСТЬ номера не вопрос
// формы: номер, уже названный человеком, занят, как бы ни был оформлен носитель. Движок,
// выдающий занятый номер, молча склеивает две темы в одном каталоге и в одной ветке.
test('номер, занятый досье-ФАЙЛОМ, второй раз не выдаётся', (t) => {
  const p = makeProject(t, { tasks: [] })
  const backlog = join(p.root, 'docs', 'backlog')
  mkdirSync(backlog, { recursive: true })
  writeFileSync(join(backlog, 'G-012-provenance.md'), '# Провенанс правил\n')

  const used = usedGroomIds(p.root)
  assert.ok(used.has('G-012'), 'тема, заведённая файлом, для движка существует')
  assert.match(used.get('G-012').join(' '), /файлом/, 'сказано, ЧЕМ занят номер: человеку чинить форму, а не гадать')
  assert.equal(nextGroomId(p.root), 'G-013', 'следующий номер — после занятого, а не он сам')
})

test('номер, занятый веткой груминга, тоже не выдаётся: досье ещё в своей ветке', (t) => {
  // Дыра, которой не закрывают ни реестр, ни бэклог: досье темы, которую сейчас грумят,
  // лежит в ЕЁ ветке и приезжает в главное дерево только на /firm-plan.
  const p = makeProject(t, { tasks: [] })
  p.git('branch', 'groom/G-021-skin-fruits')
  const used = usedGroomIds(p.root)
  assert.ok(used.has('G-021'))
  assert.match(used.get('G-021').join(' '), /ветка groom\/G-021/)
  assert.equal(nextGroomId(p.root), 'G-022')
})

test('тема мимо groom new названа находкой, а не принята молча', (t) => {
  // Номер движок больше не переиспользует — но тему он всё равно НЕ ЗНАЕТ: её нет в
  // `groom list`, стадии разведки к ней не привяжутся маркером и в `groom cost` она не
  // войдёт. Молчание об этом и есть то, из-за чего два номера разошлись по две темы.
  const p = makeProject(t, { tasks: [] })
  const backlog = join(p.root, 'docs', 'backlog')
  mkdirSync(backlog, { recursive: true })
  writeFileSync(join(backlog, 'G-012-provenance.md'), '# Провенанс правил\n')

  const f = groomFindings(p.root).join('\n')
  assert.match(f, /G-012/)
  assert.match(f, /мимо `groom new`/)
  assert.match(f, /groom cost/, 'названа цена незнания, а не только сам факт')
})

test('учтённая тема находкой «мимо groom new» не объявляется', (t) => {
  const p = makeProject(t, { tasks: [] })
  writeGroom(p.root, { id: 'G-001', slug: 'skins', title: 'Скины', status: 'grooming', branch: groomBranch('G-001', 'skins'), worktree: join(groomWorktreesDir(p.root, null), 'G-001-skins') })
  dossier(p, 'G-001', 'skins')
  assert.ok(!groomFindings(p.root).some((x) => /мимо/.test(x)), 'своя тема чужой не объявляется')
})

// ── Заявка на номер темы (вторая половина Д-15, 02.11.2026) ──────────────────
//
// Первые три источника занятости появляются ВМЕСТЕ с работой, и между «номер выбран» и
// «каталог, файл и ветка заведены» оставалось окно: распределитель выдавал тот же номер
// второму спрашивающему. Замер проект-В 02.11.2026 — два столкновения за историю проекта,
// оба здесь (`G-012 → G-015`, `G-013 → G-014`), оба разобраны переномерованием ПОСЛЕ
// факта. В пространствах, где номер появляется вместе с текстом (`T-NNN`, `BUG-NNN`,
// `BR-N`), столкновений нет ни одного — поэтому заявка заведена только у тем.
test('groom claim: номер занят заявкой, темы при этом нет', (t) => {
  const p = makeProject(t, {})
  const r = st(p, 'groom', 'claim', '--title', 'Редактор карт, работа начнётся завтра')
  assert.equal(r.json.ok, true, r.stderr || r.stdout)
  assert.equal(r.json.id, 'G-001')

  assert.deepEqual(usedGroomIds(p.root).get('G-001').length, 1, 'номер занят ровно одним источником — заявкой')
  assert.match(usedGroomIds(p.root).get('G-001')[0], /заявка в журнале/)
  assert.equal(nextGroomId(p.root), 'G-002', 'следующий спрашивающий получает другой номер — ради этого всё и заведено')

  const list = st(p, 'groom', 'list').json
  assert.equal(list.count, 0, 'темы нет: заявка её не заводит')
  assert.equal(list.claimed.length, 1, 'но номер занят, и это видно')
  assert.equal(list.claimed[0].id, 'G-001')
  assert.match(list.claimed[0].notes, /Редактор карт/, 'заявка названа предметом, иначе она не отличима от молчания')
})

test('groom claim: без --title не выдаётся — заявка без предмета молчит', (t) => {
  const p = makeProject(t, {})
  const r = st(p, 'groom', 'claim')
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /--title/)
  assert.equal(nextGroomId(p.root), 'G-001', 'номер не сгорел')
})

test('groom claim: заявленный номер берёт тема, заведённая следом', (t) => {
  const p = makeProject(t, {})
  willClean(t, p)
  const claim = st(p, 'groom', 'claim', '--title', 'Own content').json
  const made = st(p, 'groom', 'new', '--title', 'Own content', '--id', claim.id).json
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal(made.id, claim.id, 'заявленный номер забирается явным --id: угадывать, какая заявка «та самая», движку не по чему')
  const list = st(p, 'groom', 'list').json
  assert.equal(list.count, 1)
  assert.equal(list.claimed.length, 0, 'заявка исполнена — висеть в списке ей больше незачем')
})

test('groom claim: занятый номер по --id не выдаётся второй раз', (t) => {
  const p = makeProject(t, {})
  st(p, 'groom', 'claim', '--title', 'первая')
  const again = st(p, 'groom', 'claim', '--title', 'вторая', '--id', 'G-001')
  assert.equal(again.json.ok, false)
  assert.match(again.json.error, /уже занят/)
  assert.match(again.json.error, /не переиспользуются/)
})
