// Короткая полоса: правка, которой стадии надзора не нужны.
//
// Замер проект-В по T-088: разработка 41 секунда и −12 строк в трёх файлах, тестирование
// 24 минуты 36 секунд и +175 строк нового теста — на снятый ключ словаря. Проект завёл
// своё правило (BR-138) и исполнял его РУКАМИ, в обход движка: стадии не открывались,
// событий не было, и такая работа выглядела в журнале пропавшей.
//
// Эти тесты держат не ускорение, а две страховки при нём:
//   • метка — лишь ЗАЯВКА планирования, судит её код по настоящему диффу ветки;
//   • ненастроенное правило не даёт полосы молча: ключа нет — полный цикл и строка в лог.
// Без второй страховки короткая полоса стала бы четвёртым способом пройти проверку, не
// выполнив её, — рядом с пропуском теста, ожидаемым падением и маской запуска.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { laneGlob, laneAllows, shortLaneState, statusFromEvents, SHORT_LANE_LABEL, SHORT_LANE_MAX_DELETED } from '../scripts/lib/firm.mjs'
import { loadBuildBody } from './helpers.mjs'

test('образец пути: * не переходит через сегмент, ** переходит', () => {
  assert.equal(laneGlob('web/*.ts').test('web/a.ts'), true)
  assert.equal(laneGlob('web/*.ts').test('web/deep/a.ts'), false)
  assert.equal(laneGlob('web/**').test('web/deep/a.ts'), true)
  assert.equal(laneGlob('docs/**/*.md').test('docs/a/b/c.md'), true)
  // Точка в образце — точка, а не «любой символ»: иначе `texts.ts` открывал бы полосу
  // файлу `textsXts`.
  assert.equal(laneGlob('web/texts.ts').test('web/textsXts'), false)
  assert.equal(laneGlob(''), null)
})

test('laneAllows: достаточно одного образца из списка', () => {
  const paths = ['web/src/texts/**', 'docs/**/*.md']
  assert.equal(laneAllows(paths, 'web/src/texts/ru/common.ts'), true)
  assert.equal(laneAllows(paths, 'docs/guides/x.md'), true)
  assert.equal(laneAllows(paths, 'web/src/core/engine.ts'), false)
  assert.equal(laneAllows([], 'docs/a.md'), false)
})

// Настоящий репозиторий с двумя ветками: вердикт полосы берётся из диффа, а не из слов.
// `base` — что лежало в ветке поставки до задачи (чтобы правка могла быть удалением).
function repo({ files, paths, base = {}, cap = null }) {
  const root = mkdtempSync(join(tmpdir(), 'lane-'))
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'a@b.c')
  git('config', 'user.name', 'lane')
  mkdirSync(join(root, '.firm'), { recursive: true })
  writeFileSync(join(root, 'README.md'), 'base\n')
  for (const [rel, text] of Object.entries(base)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  git('add', '-A')
  git('commit', '-m', 'base')
  git('branch', 'feature/demo')
  git('checkout', '-b', 'task/T-088')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  git('add', '-A')
  git('commit', '-m', 'work')
  const cfg = paths === null
    ? ''
    : `short_lane:\n  paths:\n${paths.map((p) => `    - "${p}"`).join('\n')}\n` +
      (cap === null ? '' : `  max_deleted_lines: ${cap}\n`)
  writeFileSync(join(root, '.firm', 'config'), `engine: firm2\n${cfg}`)
  return root
}

test('дифф целиком в разрешённых путях — полоса подтверждена', () => {
  const root = repo({ files: { 'web/src/texts/ru.ts': 'export const a = 1\n' }, paths: ['web/src/texts/**'] })
  const st = shortLaneState(root, 'demo', 'T-088')
  assert.equal(st.verdict, 'подтверждена')
  assert.deepEqual(st.outside, [])
})

test('один файл за пределами путей отменяет полосу целиком', () => {
  const root = repo({
    files: { 'web/src/texts/ru.ts': 'export const a = 1\n', 'web/src/core/engine.ts': 'export const b = 2\n' },
    paths: ['web/src/texts/**'],
  })
  const st = shortLaneState(root, 'demo', 'T-088')
  assert.equal(st.verdict, 'отменена')
  assert.deepEqual(st.outside, ['web/src/core/engine.ts'])
  assert.match(st.why, /полным циклом/)
})

test('ключа в конфиге нет — полоса не настроена, и это сказано словами', () => {
  const root = repo({ files: { 'web/src/texts/ru.ts': 'x\n' }, paths: null })
  const st = shortLaneState(root, 'demo', 'T-088')
  assert.equal(st.configured, false)
  assert.equal(st.verdict, 'не настроена')
  assert.match(st.why, /short_lane\.paths/)
})

test('дифф прочитать не удалось — полоса НЕ подтверждена (И-12)', () => {
  // Ветки задачи не существует: git отказывает. «Не знаю» здесь не «можно короче».
  const root = repo({ files: { 'web/src/texts/ru.ts': 'x\n' }, paths: ['web/src/texts/**'] })
  const st = shortLaneState(root, 'demo', 'T-999')
  assert.equal(st.verdict, 'не подтверждена')
  assert.match(st.why, /И-12/)
})

test('событие guard/short-lane даёт задаче статус accepted', () => {
  const s = statusFromEvents([
    { stage: 'dev', event: 'started' },
    { stage: 'dev', event: 'finished' },
    { stage: 'guard', event: 'short-lane' },
  ])
  assert.equal(s.status, 'accepted')
})

// ── Файлы вне путей, где в диффе только удаления ──────────────────────────────
//
// Замер по истории проект-В: правило о путях покупало одну задачу из сорока — T-088 упиралась
// в единственный `.tsx`. Удалением нельзя ввести логику, можно только убрать, поэтому такие
// файлы полосу не отменяют. Три границы при этом обязательны, и каждой здесь свой тест.

// Случай T-088 дословно: снято пояснение вместе с ключом словаря и осиротевшим стилем.
const T088 = {
  base: {
    'web/src/texts/ru.ts': 'export const ru = {\n  a: "раз",\n  hostHint: "подсказка",\n}\n',
    'web/src/screens/player/HostControlPanel.tsx': '<div className="hint">{t.hostHint}</div>\n<div>остальное</div>\n',
    'web/src/screens/player/player.css': '.hint { color: red; }\n.rest { color: blue; }\n',
  },
  files: {
    'web/src/texts/ru.ts': 'export const ru = {\n  a: "раз",\n}\n',
    'web/src/screens/player/HostControlPanel.tsx': '<div>остальное</div>\n',
    'web/src/screens/player/player.css': '.rest { color: blue; }\n',
  },
}

test('T-088: текст в путях, а в компоненте и стиле только удаления — полоса', () => {
  const root = repo({ ...T088, paths: ['web/src/texts/**'] })
  const st = shortLaneState(root, 'demo', 'T-088')
  assert.equal(st.verdict, 'подтверждена')
  assert.deepEqual(st.deletions_only.sort(), [
    'web/src/screens/player/HostControlPanel.tsx',
    'web/src/screens/player/player.css',
  ])
  assert.match(st.why, /ввести логику удалением нельзя/)
})

test('одна добавленная строка вне путей отменяет полосу целиком', () => {
  const files = { ...T088.files }
  files['web/src/screens/player/HostControlPanel.tsx'] = '<div>остальное</div>\n<div>новое</div>\n'
  const root = repo({ base: T088.base, files, paths: ['web/src/texts/**'] })
  const st = shortLaneState(root, 'demo', 'T-088')
  assert.equal(st.verdict, 'отменена')
  assert.deepEqual(st.deletions_only, [])
  // Граница не выдержала на одном файле — внешними снова считаются ВСЕ, включая стиль,
  // который сам по себе был чистым удалением. Полумера («часть прошла») дала бы полосу
  // диффу, который её не заслужил.
  assert.deepEqual(st.outside.sort(), [
    'web/src/screens/player/HostControlPanel.tsx',
    'web/src/screens/player/player.css',
  ])
})

test('удаление без ни одного файла в путях полосы не даёт', () => {
  // Снос целого модуля к тексту отношения не имеет, хотя формально это одни удаления.
  const root = repo({
    base: { 'app/rules/engine.py': 'def score(x):\n    return x * 2\n' },
    files: { 'app/rules/engine.py': 'def score(x):\n' },
    paths: ['web/src/texts/**'],
  })
  const st = shortLaneState(root, 'demo', 'T-088')
  assert.equal(st.verdict, 'отменена')
  assert.deepEqual(st.deletions_only, [])
})

test('удалено больше потолка — не мелкая правка', () => {
  const base = {
    'web/src/texts/ru.ts': 'export const ru = {\n  a: "раз",\n  b: "два",\n}\n',
    'web/src/screens/player/Big.tsx': Array.from({ length: 30 }, (_, i) => `<div>строка ${i}</div>`).join('\n') + '\n',
  }
  const files = {
    'web/src/texts/ru.ts': 'export const ru = {\n  a: "раз",\n}\n',
    'web/src/screens/player/Big.tsx': '<div>строка 0</div>\n',
  }
  const tight = repo({ base, files, paths: ['web/src/texts/**'], cap: 5 })
  assert.equal(shortLaneState(tight, 'demo', 'T-088').verdict, 'отменена')
  const loose = repo({ base, files, paths: ['web/src/texts/**'], cap: 100 })
  assert.equal(shortLaneState(loose, 'demo', 'T-088').verdict, 'подтверждена')
  // Без ключа действует измеренный потолок движка: 29 удалённых строк в него проходят.
  const dflt = repo({ base, files, paths: ['web/src/texts/**'] })
  assert.equal(SHORT_LANE_MAX_DELETED, 40)
  assert.equal(shortLaneState(dflt, 'demo', 'T-088').verdict, 'подтверждена')
})

// ── Планировщик: настоящее тело сборщика с заглушкой вместо agent() ───────────
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()

async function run({ labels = [], short_lane = [], lane = { state: 'ok', verdict: 'подтверждена', why: 'дифф в путях' } } = {}) {
  const tasks = [{ id: 'T-088', path: 'T-088.md', labels, parallel_safe: true }]
  const calls = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label === 'пауза?') return { state: 'running' }
    // Основание сверки (BR-165): движок снимает красные на ветке-цели один раз на прогон.
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'ma1nsha0000', head: 'ma1nsha0000', cmd: 'suite', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: ['T-088'], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('полоса:')) return lane
    if (label.startsWith('short-lane:')) return { status: 'ok' }
    if (label.startsWith('test:')) {
      return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 }, mutation_check: { done: true, evidence: 'м' } }
    }
    if (label.startsWith('qa')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label.startsWith('merge-failed:') || label.startsWith('journal:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (ths) => Promise.all(ths.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  const out = await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '', tasks, short_lane,
  }))
  return { out, calls, text: logs.join('\n') }
}

test('полоса подтверждена — стадии test и review не открываются, событие пишется', async () => {
  const r = await run({ labels: [SHORT_LANE_LABEL], short_lane: ['web/src/texts/**'] })
  assert.equal(r.calls.some((l) => l.startsWith('test:')), false)
  assert.equal(r.calls.some((l) => l.startsWith('qa')), false)
  assert.equal(r.calls.some((l) => l.startsWith('short-lane:')), true)
  assert.equal(r.out.tasks[0].accepted, true)
  assert.match(r.text, /короткая полоса/i)
})

test('полоса отменена диффом — полный цикл, и причина названа в логе', async () => {
  const r = await run({
    labels: [SHORT_LANE_LABEL], short_lane: ['web/src/texts/**'],
    lane: { state: 'ok', verdict: 'отменена', why: 'дифф вышел за пути (src/core/engine.ts)' },
  })
  assert.equal(r.calls.some((l) => l.startsWith('test:')), true)
  assert.equal(r.calls.some((l) => l.startsWith('qa')), true)
  assert.equal(r.calls.some((l) => l.startsWith('short-lane:')), false)
  assert.match(r.text, /отменена[\s\S]*engine\.ts/)
})

test('зонд не ответил — полный цикл (отказ читается закрыто)', async () => {
  const r = await run({ labels: [SHORT_LANE_LABEL], short_lane: ['web/**'], lane: { state: 'unknown', output: 'нет node' } })
  assert.equal(r.calls.some((l) => l.startsWith('test:')), true)
  assert.match(r.text, /полный цикл/)
})

test('метка стоит, а путей в конфиге нет — полосы нет, и прогон говорит почему', async () => {
  const r = await run({ labels: [SHORT_LANE_LABEL], short_lane: [] })
  assert.equal(r.calls.some((l) => l.startsWith('полоса:')), false)
  assert.equal(r.calls.some((l) => l.startsWith('test:')), true)
  assert.match(r.text, /short_lane\.paths/)
})

test('без метки полоса не проверяется вовсе — лишнего зонда нет', async () => {
  const r = await run({ labels: [], short_lane: ['web/**'] })
  assert.equal(r.calls.some((l) => l.startsWith('полоса:')), false)
  assert.equal(r.calls.some((l) => l.startsWith('test:')), true)
})
