// И-14: отправка наружу оставляет расписку, и цепочка расписок цела (ADR-0014).
//
// Три стороны, и третья — та, ради которой всё затевалось:
//   1. расписка пишется на настоящую отправку и НЕ пишется на обычную работу (расписка на
//      каждый `git status` обесценила бы настоящие — довод образцов secret-scan);
//   2. секрет в команде в журнал не попадает: расписка не должна становиться вторым местом,
//      где лежит ключ;
//   3. удалённая или правленая расписка находится `doctor`-ом — это и есть вся ценность
//      цепочки, без неё журнал отправок ничем не лучше лога.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { listEvents, receiptDigest } from '../scripts/lib/firm.mjs'
import { makeProject, commitFile, plainDir } from './helpers.mjs'

function hook(p, payload, env = {}) {
  return p.cli('egress.mjs', [], { input: JSON.stringify(payload), env })
}

const bash = (p, command) => hook(p, { tool_name: 'Bash', tool_input: { command }, cwd: p.root })

function receipts(p) {
  return listEvents(p.root).filter((e) => e.stage === 'guard' && e.event === 'egress')
}

// Удалённый remote: настоящий адрес, по которому гвард обязан назвать ХОСТ, а не псевдоним
// `origin` — «уехало в origin» не ответ на вопрос «куда уехало».
function withRemote(p) {
  p.git('remote', 'add', 'origin', 'https://github.com/example/project.git')
}

// ── Что считается отправкой ──────────────────────────────────────────────────

test('И-14: пуш ветки задачи — расписка с хостом, ссылкой и отпечатком', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  p.git('checkout', '-q', '-b', 'task/T-001')
  commitFile(p, 'T-001.txt', 'работа\n', 'T-001')
  p.git('checkout', '-q', `feature/${p.change}`)

  const r = bash(p, 'git -C . push origin task/T-001')
  assert.equal(r.status, 0, 'расписка ничего не держит')
  const [e] = receipts(p)
  assert.equal(e.ticket, 'T-001', 'задача взята из ссылки в самой команде')
  assert.equal(e.egress.sink, 'push')
  assert.equal(e.egress.host, 'github.com', 'псевдоним origin развёрнут в настоящий хост')
  assert.equal(e.egress.ref, 'task/T-001')
  assert.match(String(e.tree), /^[0-9a-f]{12}$/, 'у пуша ветки есть отпечаток содержимого')
  assert.equal(e.prev, null, 'первая расписка задачи ссылки не имеет')
  assert.equal(e.digest, receiptDigest({ prev: null, ts: e.ts, ticket: 'T-001', sink: 'push', host: 'github.com', ref: 'task/T-001', tree: e.tree }))
})

test('И-14: сеть, PR и публикация тоже оставляют расписку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'curl -s https://api.example.org/v1/ingest -d @payload.json')
  bash(p, 'gh pr create --fill --base main')
  bash(p, 'npm publish --access public')
  const got = receipts(p).map((e) => e.egress.sink).sort()
  assert.deepEqual(got, ['http', 'pr', 'publish'])
  const http = receipts(p).find((e) => e.egress.sink === 'http')
  assert.equal(http.egress.host, 'api.example.org')
  assert.equal(http.ticket, 'MR', 'отправка вне задачи — уровень поставки, а не unknown (И-7)')
})

test('И-14: WebFetch и WebSearch — отдельный путь наружу, мимо песочницы и git', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  hook(p, { tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/api' }, cwd: p.root })
  hook(p, { tool_name: 'WebSearch', tool_input: { query: 'как устроен post-merge' }, cwd: p.root })
  const got = receipts(p)
  assert.equal(got.length, 2)
  const fetched = got.find((e) => e.egress.tool === 'WebFetch')
  assert.equal(fetched.egress.host, 'docs.example.com')
  const searched = got.find((e) => e.egress.tool === 'WebSearch')
  assert.equal(searched.egress.sink, 'search')
  assert.equal(searched.egress.host, null, 'у поиска хоста нет, и выдумывать его нечего (И-12)')
})

test('И-14: обычная работа расписок не плодит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  for (const cmd of [
    'git -C . status --short',
    'git -C . log --oneline -5',
    'git -C . add -- file.txt',
    'npm test',
    'ls -la https-docs',
    'node scripts/firm-state.mjs phase',
  ]) {
    assert.equal(bash(p, cmd).status, 0)
  }
  assert.equal(receipts(p).length, 0, 'расписка на каждую команду обесценила бы настоящие')
})

test('чужой проект и пустая нагрузка — молча мимо', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const foreign = plainDir(t)
  const r = p.cli('egress.mjs', [], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: foreign }),
    env: { CLAUDE_PROJECT_DIR: foreign },
  })
  assert.equal(r.status, 0)
  assert.equal(p.cli('egress.mjs', [], { input: 'не json' }).status, 0, 'fail-open: расписка не вправе ломать отправку')
})

// ── Секрет в расписку не попадает ────────────────────────────────────────────

test('И-14: токен из команды в журнал не уезжает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}` // синтетический: форма настоящая
  bash(p, `curl -H "Authorization: Bearer ${token}" https://api.example.org/push`)
  const [e] = receipts(p)
  const whole = readFileSync(join(p.eventsPath, e._file), 'utf8')
  assert.equal(whole.includes(token), false, 'расписка не должна становиться вторым местом, где лежит ключ')
  assert.match(e.notes, /срезано/)
  assert.equal(e.egress.host, 'api.example.org', 'хост при этом записан — ради него всё и затевалось')
})

test('И-14: пароль в URL пуша не сохраняется целиком', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  bash(p, 'git push https://user:hT7xQ2vwPASS@git.example.org/repo.git main')
  const [e] = receipts(p)
  const whole = readFileSync(join(p.eventsPath, e._file), 'utf8')
  assert.equal(whole.includes('hT7xQ2vwPASS'), false)
  assert.equal(e.egress.host, 'git.example.org')
})

// ── Цепочка: ради чего всё это ───────────────────────────────────────────────

test('И-14: расписки одной задачи сцеплены, разных — нет', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  withRemote(p)
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-002')
  bash(p, 'git push origin task/T-001')

  const mine = receipts(p).filter((e) => e.ticket === 'T-001').sort((a, b) => a.ts.localeCompare(b.ts))
  assert.equal(mine.length, 2)
  assert.equal(mine[0].prev, null)
  assert.equal(mine[1].prev, mine[0].digest, 'вторая расписка задачи ссылается на первую')

  const other = receipts(p).find((e) => e.ticket === 'T-002')
  assert.equal(other.prev, null, 'цепочка по задаче: соседняя задача своей не трогает')

  const r = p.evJson('doctor', '--change', p.change)
  assert.deepEqual(r.json.egress_chain, [], 'честный журнал находок не даёт')
})

test('И-14: удалённая расписка рвёт цепочку и красит doctor', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')

  const mine = receipts(p).filter((e) => e.ticket === 'T-001').sort((a, b) => a.ts.localeCompare(b.ts))
  assert.equal(mine.length, 3)
  rmSync(join(p.eventsPath, mine[1]._file)) // средняя исчезла — именно так прячут отправку

  const r = p.evJson('doctor', '--change', p.change)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.egress_chain.length, 1)
  assert.match(r.json.egress_chain[0].why, /удалили|разорвана/)
})

test('И-14: правленая расписка не сходится со своим digest', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'curl -s https://api.example.org/ingest -d @dump.json')

  const [e] = receipts(p)
  const path = join(p.eventsPath, e._file)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.egress.host = 'безобидный.local' // переписать «куда уехало» — главный мотив подделки
  writeFileSync(path, JSON.stringify(raw, null, 1))

  const r = p.evJson('doctor', '--change', p.change)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.egress_chain.length, 1)
  assert.match(r.json.egress_chain[0].why, /не сходится с её digest/)
})

test('И-14: перецепка после удаления тоже видна — digest считается вместе с prev', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')

  const mine = receipts(p).filter((e) => e.ticket === 'T-001').sort((a, b) => a.ts.localeCompare(b.ts))
  assert.equal(mine.length, 3)

  // Самый грамотный способ спрятать отправку: убрать среднюю расписку И перецепить
  // следующую на первую, чтобы разрыва не осталось. Защищает от этого только то, что `prev`
  // входит в канон digest: перецепленная расписка перестаёт сходиться сама с собой
  // (найдено проверкой мутацией 21.10.2026 — без этого теста мутация выживала).
  rmSync(join(p.eventsPath, mine[1]._file))
  const path = join(p.eventsPath, mine[2]._file)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.prev = mine[0].digest
  writeFileSync(path, JSON.stringify(raw, null, 1))

  const r = p.evJson('doctor', '--change', p.change)
  assert.equal(r.json.ok, false, 'перецепленная цепочка не должна выглядеть целой')
  assert.match(r.json.egress_chain.map((f) => f.why).join(' | '), /не сходится с её digest/)
})

// ── Развилка цепочки — не разрыв (найдено замером 05.11.2026) ───────────────
//
// Цепочка по задаче ставилась с оговоркой «иначе вилка читалась бы разрывом» — и тут же
// требовала СТРОГО одного следующего за каждой распиской. Но задача `MR` принадлежит всей
// поставке, и расписки ей пишут все параллельные деревья и обе живые линии продукта: вилка
// внутри `MR` так же неизбежна, как между задачами. Замер на журнале проект-В: 134 расписки,
// из них 120 у `MR`; развилок 4, ссылок на несуществующую расписку НОЛЬ — то есть все
// четыре находки сверки были ложными, и снять их было нечем (журнал неизменяем, ADR-0006).
//
// Доказывает цепочка не порядок, а достижимость. Поэтому тесты держат три разных ответа:
// развилка — наблюдение, пустая ссылка — находка, оборванное начало — находка.

// Расписка-двойник: тот же предшественник, своё время, честный digest. Так выглядит вторая
// отправка, сделанная ПАРАЛЛЕЛЬНО первой в другом рабочем дереве.
function forkReceipt(p, after, { ts, ref }) {
  const base = {
    prev: after.prev, ts, ticket: after.ticket,
    sink: after.egress.sink, host: after.egress.host, ref, tree: after.tree,
  }
  const file = `${ts.replace(/[:.]/g, '-')}-${after.ticket}-guard-egress.json`
  writeFileSync(join(p.eventsPath, file), JSON.stringify({
    ts, change: after.change, ticket: after.ticket, stage: 'guard', event: 'egress',
    actor: 'egress', prev: after.prev, digest: receiptDigest({ ...base, ref }),
    tree: after.tree, egress: { ...after.egress, ref },
    notes: `${after.egress.sink} → ${after.egress.host}`,
  }, null, 1) + '\n')
  return file
}

test('И-14: две расписки с одним предшественником — параллельная запись, а не разрыв', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')

  const mine = receipts(p).filter((e) => e.ticket === 'T-001').sort((a, b) => a.ts.localeCompare(b.ts))
  assert.equal(mine.length, 2)
  // Время — ПОЗЖЕ обеих: двойник пишется параллельно второй отправке, а не до первой.
  forkReceipt(p, mine[1], { ts: '2026-12-01T10:00:00.000Z', ref: 'task/T-001-параллельно' })

  const r = p.evJson('doctor', '--change', p.change)
  assert.deepEqual(r.json.egress_chain, [],
    'развилка — не находка: иначе каждая параллельная отправка краснит doctor НАВСЕГДА, снять нечем')
  assert.equal(r.json.egress_forks.length, 1, 'но назвать её надо: это карта того, сколько линий писали разом')
  assert.match(r.json.egress_forks[0].why, /параллельная запись/)
  assert.equal(r.json.ok, true, 'на ok развилка не влияет')
})

test('И-14: ссылка в пустоту остаётся находкой — развилка защиту не сняла', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')

  const mine = receipts(p).filter((e) => e.ticket === 'T-001').sort((a, b) => a.ts.localeCompare(b.ts))
  rmSync(join(p.eventsPath, mine[1]._file))

  const r = p.evJson('doctor', '--change', p.change)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.egress_chain.length, 1)
  assert.match(r.json.egress_chain[0].why, /не принадлежит ни одной расписке/)
  assert.deepEqual(r.json.egress_forks, [], 'удаление — не развилка, и путать их нельзя')
})

test('И-14: расписка без prev при уже существующих — тоже находка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  bash(p, 'git push origin task/T-001')
  bash(p, 'git push origin task/T-001')

  const mine = receipts(p).filter((e) => e.ticket === 'T-001').sort((a, b) => a.ts.localeCompare(b.ts))
  const path = join(p.eventsPath, mine[1]._file)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  // Начать цепочку заново — способ отвязать всё, что было до: разрыва «не сходится» нет,
  // потому что digest пересчитан, но связь с прошлым пропала.
  raw.prev = null
  raw.digest = receiptDigest({
    prev: null, ts: raw.ts, ticket: raw.ticket,
    sink: raw.egress.sink, host: raw.egress.host, ref: raw.egress.ref, tree: raw.tree,
  })
  writeFileSync(path, JSON.stringify(raw, null, 1))

  const r = p.evJson('doctor', '--change', p.change)
  assert.equal(r.json.ok, false)
  assert.match(r.json.egress_chain.map((f) => f.why).join(' | '), /цепочку начали заново/)
})

// ── Д-20: отправка опознаётся подкомандой, а не словом «push» в тексте ───────
//
// Отчёт проект-В 28.10.2026. Образец ловил подстроку, и под него попадали `git stash push`
// (укладка в ЛОКАЛЬНЫЙ карман перед слиянием) и слово `push` внутри `echo` в читающей
// команде. Проверено, что отправки при этом не было: локальная ветка была на 94 коммита
// впереди своего следа в origin. Цена не в лишней строке журнала: расписка — удостоверение
// (ADR-0014), и поток ложных делает настоящую неотличимой — на поставке со множеством
// слияний ложные составляли ВЕСЬ `guard/egress`.
test('Д-20: git stash push и слово push в тексте расписок не плодят', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  for (const cmd of [
    'git -C /repo stash push -- openspec/changes/x/tasks',
    'git stash push -m "firm2: кэш статусов перед разбором конфликта T-119"',
    'git stash pop',
    'git -C . branch -r && echo "--- рефлог push? ---" && git -C . reflog -3',
    'echo "не забыть push" && git -C . status',
    'git -C . log --oneline --grep=push -5',
  ]) {
    assert.equal(bash(p, cmd).status, 0, cmd)
  }
  assert.equal(receipts(p).length, 0, 'ни одна из этих команд наружу ничего не отправляет')
})

test('Д-20: настоящий пуш по-прежнему опознаётся, в том числе с глобальными ключами', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  // Направление ошибки здесь несимметрично: пропустить отправку хуже, чем записать лишнюю,
  // поэтому формы разбираются, а не угадываются.
  const forms = [
    'git push',
    'git -C /repo push origin feature/demo',
    'git --git-dir=/repo/.git --work-tree=/repo push -u origin HEAD',
    'git -c user.name=x push --force-with-lease',
    'cd /repo && git push origin task/T-001',
    'bash -c "git push origin main"',
  ]
  for (const cmd of forms) assert.equal(bash(p, cmd).status, 0, cmd)
  assert.equal(receipts(p).length, forms.length, 'каждая настоящая отправка оставила расписку')
  for (const r of receipts(p)) assert.equal(r.egress.host, 'github.com', 'хост назван адресом, а не псевдонимом')
})

test('Д-20: имя remote берётся из разобранной подкоманды, а не из текста', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withRemote(p)
  p.git('remote', 'add', 'upstream', 'https://gitlab.com/other/project.git')
  bash(p, 'git -C . push upstream feature/demo')
  const r = receipts(p)
  assert.equal(r.length, 1)
  assert.equal(r[0].egress.host, 'gitlab.com', 'отправка ушла не в origin, и расписка говорит куда')
})
