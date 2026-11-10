// Четыре дефекта одной живой сборки проект-В 29.10.2026, и у них общий корень: шаг сборки
// распоряжается тем, что ему не принадлежит, либо не привозит то, что должен.
//
//   Д-24 — стадия подготовки звала `worktree add -B`, то есть СБРАСЫВАЛА ветку задачи на
//          вершину поставки. На T-150 («перенос из неслитой ветки») это уничтожило бы
//          указатель на то, что задача переносит: четыре коммита и 3471 строку.
//   Д-28 — обратная сторона: дерево есть — стадия не делала ничего, и заход работал на
//          ветке, отставшей от поставки. `task/T-178` отставала на 31 коммит и не видела
//          решения ворот, лежавшего в поставке коммитом; заход сгорел.
//   Д-25 — шаг слияния стэшил ВСЁ дерево под подписью «кэши задач» и унёс правки плана у
//          Архитектора, работавшего рядом.
//   Д-27 — решение разбора (`lifecycle/arbitrated`) не входило в выбор `last_verdict`, и
//          до промпта стадии не доходило ничем.
//
// Тесты держат то, что проверяемо без живого git: что сборщик печатает в промптах и что
// движок отдаёт в `args`. Сами команды git исполняет роль, и судить её исполнение здесь
// нечем — поэтому проверяется предписание, а не результат.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const SRC = readFileSync(new URL('../workflows/firm2-build.js', import.meta.url), 'utf8')

// ── Д-24: ветка задачи не сбрасывается ──────────────────────────────────────
test('Д-24: ключ -B не зовётся нигде — он сбрасывает ветку задачи', () => {
  // Образец — ПО ВЫЗОВУ, а не по слову: в комментариях и в разборе ловушки T-XXXf ключ
  // по-прежнему назван, и правильно — там объясняется, чего движок больше не делает.
  assert.doesNotMatch(SRC, /worktree add -B task\/\$\{task\.id\}/, 'сброс ветки движок себе больше не позволяет')
  assert.match(SRC, /worktree add -b \$\{br\}/, 'новой задаче — создание, которое ОТКАЖЕТ на существующей ветке')
})

test('Д-24: у ветки со своей работой вершина сохраняется ссылкой, а дерево берётся от неё', () => {
  assert.match(SRC, /update-ref refs\/firm2\/kept/, 'вершина сохранена: одна ссылка против потери работы')
  assert.match(SRC, /worktree add \$\{wt\} \$\{br\}/, 'дерево заводится ОТ существующей вершины, а не от поставки')
})

test('Д-24: битые регистрации снимаются там, где на них и падает — перед созданием дерева', () => {
  assert.match(SRC, /worktree prune/, 'иначе ветка числится занятой несуществующим деревом')
  assert.match(SRC, /ветки и коммиты не трогает/, 'сказано, почему это не распоряжение чужой работой')
})

// ── Что видит стадия ────────────────────────────────────────────────────────
const TASK = { id: 'T-001', path: 't.md', labels: [], parallel_safe: true }

async function prompts(extra = {}, prep = {}) {
  const calls = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'x', red: [], failed: 0, total: 10 }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [TASK.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '', ...prep }
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
    worktrees_dir: '/wt', tasks: [{ ...TASK, ...extra }],
  }))
  const find = (pre) => (calls.find((c) => c.label.startsWith(pre)) || {}).prompt || ''
  return { prepare: find('worktree:'), dev: find('dev:'), merge: find('merge:'), log: logs.join('\n') }
}

test('Д-24/Д-28: стадии подготовки названы три случая и запрет -B', async () => {
  const r = await prompts()
  assert.match(r.prepare, /ни ветки, ни дерева/)
  assert.match(r.prepare, /своих коммитов больше нуля/)
  assert.match(r.prepare, /повторный заход/)
  assert.match(r.prepare, /НЕ ИСПОЛЬЗОВАТЬ/, 'запрет сказан, а не подразумевается формой команды')
  assert.match(r.prepare, /rev-list --left-right --count/, 'расхождение измеряется, а не оценивается на глаз')
  assert.match(r.prepare, /Конфликт на merge — НЕ решай/, 'решение по предмету задачи роли не принадлежит (ADR-0009)')
})

test('Д-28: отставание доезжает до промпта разработки числом и с указанием перечитать', async () => {
  const r = await prompts({}, { behind: 31, own_commits: 2, pulled: true })
  assert.match(r.dev, /отставала от поставки на 31 коммит/, 'число, а не «возможно, устарело»')
  assert.match(r.dev, /своих коммитов 2/)
  assert.match(r.dev, /поставка ПОДТЯНУТА/)
  assert.match(r.dev, /Перечитай файл задачи/, 'иначе роль будет спорить с текстом, которого больше нет')
})

test('Д-28: не подтянули — промпт говорит это прямо, а не молчит', async () => {
  const r = await prompts({}, { behind: 31, pulled: false })
  assert.match(r.dev, /подтянуть НЕ удалось/)
  assert.match(r.dev, /может быть устаревшим/)
})

test('Д-28: отставание названо и в логе прогона — иначе заход выглядит обычным', async () => {
  const r = await prompts({}, { behind: 31, own_commits: 2, pulled: true, kept_ref: 'refs/firm2/kept/T-001' })
  assert.match(r.log, /ветка отставала от поставки на 31/)
  assert.match(r.log, /поставка подтянута/)
  assert.match(r.log, /refs\/firm2\/kept\/T-001/, 'сохранённая ссылка названа: по ней работу и находят')
})

test('Д-28: дерево свежее — лишней строки в промпте нет', async () => {
  const r = await prompts({}, { behind: 0, pulled: false })
  assert.doesNotMatch(r.dev, /ДЕРЕВО:/, 'говорить «отставания нет» значит засорять промпт')
  assert.doesNotMatch(r.log, /отставала/)
})

// ── Д-25: карман кладётся адресно ───────────────────────────────────────────
test('Д-25: шагу слияния предписан адресный карман и запрещён широкий', async () => {
  const r = await prompts()
  assert.match(r.merge, /И ПЕРЕЧИСЛЕНИЕМ ПУТЕЙ/)
  assert.match(r.merge, /Карман без путей/, 'запрет назван формой команды, а не общим словом «аккуратно»')
  assert.match(r.merge, /унесла|унесёт/, 'сказано, что именно теряется и у кого')
})

test('Д-25: чужие правки называются и записываются событием, а не уносятся молча', async () => {
  const r = await prompts()
  assert.match(r.merge, /status --short/, 'сперва посмотреть, что в дереве, — потом откладывать')
  assert.match(r.merge, /guard --event foreign-changes/)
  assert.match(r.merge, /Твоя зона — только/, 'зона шага названа путями, а не на усмотрение роли')
  assert.match(r.merge, /подпись должна описывать СОДЕРЖИМОЕ/i, 'подпись, лгущая о содержимом, — та же болезнь, что Д-22')
})

// ── Д-27: решение разбора ───────────────────────────────────────────────────
test('Д-27: build-args отдаёт решение разбора отдельным полем и целиком', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const E = (stage, event, extra = {}) => writeEvent(p.root, {
    ts: extra.ts, change: p.change, ticket: 'T-001', stage, event, actor: 'test', ...extra,
  })
  E('dev', 'started', { ts: '2026-10-29T09:00:00.000Z' })
  E('dev', 'escalated', { ts: '2026-10-29T10:00:00.000Z', notes: 'основание сверки не снято' })
  // Разбор пишется маршрутом через `record --notes`, и там обрезки нет — проверяем длинным.
  const decision = 'читать формулировку как «не растягивать холст»; ' + 'подробности: '.repeat(60)
  E('lifecycle', 'arbitrated', { ts: '2026-10-29T11:00:00.000Z', actor: 'human', notes: decision })
  const a = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json']).stdout)
  const task = a.tasks.find((x) => x.id === 'T-001')
  assert.ok(task, 'задача после разбора вернулась в прогон')
  assert.ok(task.last_arbitration, 'решение разбора отдаётся сборщику')
  assert.equal(task.last_arbitration.notes, decision, 'текст целиком: разбор — это разбор, а не пометка')
  assert.equal(task.last_arbitration.after_verdict, true, 'решение новее эскалации')
  assert.equal(task.last_verdict.event, 'escalated', 'претензия осталась на своём месте, а не подменилась')
  assert.equal(a.integrity.arbitration_chars, decision.length, 'сверка целостности считает и этот текст')
})

test('Д-27: задача встала СНОВА после разбора — решение помечено как прошлого круга', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const E = (stage, event, extra = {}) => writeEvent(p.root, {
    ts: extra.ts, change: p.change, ticket: 'T-001', stage, event, actor: 'test', ...extra,
  })
  // Разбор был, задача вернулась в цикл — и там её отклонило ревью. Это и есть случай,
  // когда решение старше последней претензии, а задача по-прежнему в прогоне.
  E('dev', 'started', { ts: '2026-10-29T09:00:00.000Z' })
  E('dev', 'escalated', { ts: '2026-10-29T10:00:00.000Z', notes: 'первый затык' })
  E('lifecycle', 'arbitrated', { ts: '2026-10-29T11:00:00.000Z', notes: 'решение первого круга' })
  E('dev', 'started', { ts: '2026-10-29T12:00:00.000Z' })
  E('dev', 'finished', { ts: '2026-10-29T12:30:00.000Z' })
  E('review', 'rejected', { ts: '2026-10-29T13:00:00.000Z', notes: 'другая претензия' })
  const a = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json']).stdout)
  const task = a.tasks.find((x) => x.id === 'T-001')
  assert.ok(task, 'отклонённая задача остаётся в прогоне')
  assert.equal(task.last_verdict.event, 'rejected', 'последняя претензия — отказ ревью, а не старая эскалация')
  assert.equal(task.last_arbitration.after_verdict, false, 'выдавать старое решение за ответ на новый затык нельзя')
})

test('Д-27: решение доезжает в промпт разработки отдельной строкой, после замечаний', async () => {
  const r = await prompts({
    last_verdict: { event: 'escalated', ts: '2026-10-29T10:00:00.000Z', notes: 'за что остановили', criteria: [] },
    last_arbitration: { ts: '2026-10-29T11:00:00.000Z', actor: 'human', notes: 'что решили', after_verdict: true },
  })
  assert.match(r.dev, /РЕШЕНИЕ РАЗБОРА/)
  assert.match(r.dev, /что решили/)
  assert.ok(r.dev.indexOf('за что остановили') < r.dev.indexOf('что решили'), 'сначала претензия, потом решение: оно новее')
  assert.match(r.dev, /решение НОВЕЕ замечаний/, 'роли сказано, какой текст старше по праву')
  assert.match(r.dev, /эскалируй С ЦИТАТОЙ/, 'несогласие с решением — тоже путь, но названный')
})

test('Д-27: решение прошлого круга промпт не выдаёт за указание', async () => {
  const r = await prompts({
    last_verdict: { event: 'escalated', ts: '2026-10-29T13:00:00.000Z', notes: 'второй затык', criteria: [] },
    last_arbitration: { ts: '2026-10-29T11:00:00.000Z', notes: 'решение первого круга', after_verdict: false },
  })
  assert.match(r.dev, /СТАРЕЕ последней эскалации/)
  assert.match(r.dev, /как контекст, а не как указание/)
})

test('Д-27: разбора не было — лишней строки в промпте нет', async () => {
  const r = await prompts()
  assert.doesNotMatch(r.dev, /РЕШЕНИЕ РАЗБОРА/)
})
