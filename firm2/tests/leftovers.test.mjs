// Остатки после сборки: «не проверено» — не то же, что «чисто» (Д-57, Д-58).
//
// Отчёт проект-В 08.11.2026. За сутки накопилось 11 процессов с рабочим каталогом в уже
// снесённых деревьях задач (пары `node` + `chrome-headless-shell`, один Python). Хуже
// другое: шаг уборки не мог их УВИДЕТЬ — под песочницей `pgrep` падает («sysmond service not
// found»), `ps` не запускается вовсе, а снятие песочницы правильно отклоняет сторож. Трижды
// шаг вернул `leftovers.found: []`, каждый раз честно оговорив В ПРОЗЕ, что это значит «не
// проверено». Поле машиночитаемо, оговорка — нет, и отчёт волны выглядел как «мусора нет».
//
// Обход нашла одна стадия из трёх сама: `lsof` под песочницей разрешён и показывает И
// процессы, И их рабочие каталоги. Ею и найдены все 11. Значит рецепт — в промпт, а
// различение «чисто/не проверено» — в поле.
//
// Д-58 рядом: `worktree remove` из сессии сносит каталог и падает на служебной записи
// внутри `.git`. Это граница песочницы, а не дефект движка, — но шаг обязан сказать, что
// осталась половина и доделать может только человек.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const TASK = { id: 'T-001', path: 't.md', labels: [], parallel_safe: true }

async function runBuild(leftoversAnswer) {
  const calls = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label.startsWith('основание:')) return { state: 'unknown', output: 'дерево не завелось' }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [TASK.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '/wt/T-001', branch: 'task/T-001' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) return { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return leftoversAnswer
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '/wt', tasks: [TASK], test_cmd: 'npm test',
  }))
  return {
    prompt: (calls.find((c) => c.label === 'leftovers') || {}).prompt || '',
    log: logs.join('\n'),
  }
}

test('в промпт уборки положен рецепт lsof, а pgrep назван неработающим', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof' })
  assert.match(r.prompt, /lsof -a -d cwd -c node -c chrome-headless-shell/, 'рецепт дан дословно, а не описан')
  assert.match(r.prompt, /pgrep/, 'сказано, чем НЕ смотреть')
  assert.match(r.prompt, /sysmon/, 'назван сам отказ — по нему стадия узнает его в своём выводе')
  assert.match(r.prompt, /снятие песочницы/, 'закрыт обход, который стадия иначе попробует')
})

test('промпт требует различать «чисто» и «не проверено», и объясняет разницу', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof' })
  assert.match(r.prompt, /checked/)
  assert.match(r.prompt, /РАЗНЫЕ ответы/)
  assert.match(r.prompt, /не проверено/)
})

test('checked: false — прогон говорит это вслух, а пустой список за «чисто» не берёт', async () => {
  const r = await runBuild({ found: [], checked: false, how: 'pgrep упал, ps не запускается' })
  assert.match(r.log, /НЕ ПРОВЕРЕНЫ/)
  assert.match(r.log, /НЕ значит «чисто»/)
  assert.match(r.log, /pgrep упал/, 'названо, чем стадия пыталась смотреть')
})

test('checked: true и пустой список — лишних строк в логе нет', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof' })
  assert.doesNotMatch(r.log, /НЕ ПРОВЕРЕНЫ/)
  assert.doesNotMatch(r.log, /остались процессы/)
})

test('нашлись процессы — сказано сколько, и решение оставлено человеку', async () => {
  // Ответ БЕЗ поля orphans — так отвечает шаг со старым промптом (кэш плагина отстаёт), и
  // это «не знаю», а не «чужие»: пустого суждения тут не было вовсе (И-12).
  const r = await runBuild({ found: ['node 123 /wt/T-340', 'chrome-headless-shell 124 /wt/T-340'], checked: true, how: 'lsof' })
  assert.match(r.log, /остались процессы \(2\)/)
  assert.match(r.log, /гасить решает человек/)
  assert.match(r.log, /НЕ НАЗВАНЫ и не опровергнуты/)
  assert.match(r.log, /до 0\.4\.141/, 'названа причина, по которой поля нет')
})

test('Д-58: недоделанная уборка дерева называет команду человека, а не молчит', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof', worktree_prune_pending: true })
  assert.match(r.log, /worktree prune/)
  assert.match(r.log, /только человек/)
  assert.match(r.log, /prunable/, 'названо последствие: ветка числится занятой')
})

// Д-58, вторая редакция по замеру проект-В 08.11.2026. Первая говорила роли, ЧТО обычно
// остаётся («каталог снят, запись осталась — песочница закрывает .git»). Замер это
// опроверг: три прогона подряд дали два отказа `worktree remove` на записи и один полный
// успех на свежем дереве, где до силы и до финального `prune` дело вообще не дошло.
// Причина не найдена ни одной из трёх точек. Значит объяснение из движка убирается, а
// вопрос остаётся — и он отвечается замером: `worktree list --porcelain` печатает строку
// `prunable` у записи, которой каталог не соответствует. То же лекарство, что у Д-57:
// не оговорка в прозе, а поле, которое кто-то обязан заполнить измерением.
test('остаток служебных записей спрашивается замером, а не выводится из кода возврата', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof' })
  assert.match(r.prompt, /worktree list --porcelain/, 'рецепт замера дан дословно')
  assert.match(r.prompt, /registry_left/)
  assert.match(r.prompt, /ПЕРЕМЕЖАЕТСЯ/, 'сказано, почему правило из кодов возврата не годится')
  assert.match(r.prompt, /разные вопросы/, 'отказ prune и остаток записи — не одно и то же')
})

test('registry_left: false — замер назван, и это не молчание', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof', registry_left: false })
  assert.match(r.log, /проверены: не осталось ни одной/)
  assert.doesNotMatch(r.log, /только человек/, 'нечего доделывать — человека не зовём')
})

test('registry_left: true — названа половина, которая осталась, и команда человека', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof', registry_left: true })
  assert.match(r.log, /worktree prune/)
  assert.match(r.log, /prunable/)
})

test('поля нет вовсе — сказано, что остаток НЕ ЗАМЕРЕН, а не «всё убрано»', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof', worktree_prune_pending: true })
  assert.match(r.log, /НЕ ЗАМЕРЕН/)
  assert.match(r.log, /porcelain/, 'назван вопрос, которым это замеряется')
})

// Д-68, возврат от 10.11.2026. Шаг уборки называет сирот поимённо, а незавершённые слияния
// в деревьях задач — не называл вовсе. Такое слияние переживает прогон: дерево остаётся,
// `MERGE_HEAD` в нём стоит, и следующий прогон падает ЧУЖИМ именем, потому что git с
// несведённым индексом не начинает никакого мержа (Д-34; у проект-В 09.11.2026 на поиск
// причины ушло два с половиной часа).
test('в промпт уборки положен рецепт поиска незавершённых слияний по деревьям', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof', merges_checked: true, unfinished_merges: [] })
  assert.match(r.prompt, /rev-parse -q --verify MERGE_HEAD/, 'рецепт дан дословно')
  assert.match(r.prompt, /ls-files -u/, 'и вторая половина: какие пути не сведены')
  assert.match(r.prompt, /merge --abort/, 'сказано, чего делать НЕЛЬЗЯ в чужом дереве')
})

test('незавершённые слияния названы поимённо и с ценой для следующего прогона', async () => {
  const r = await runBuild({
    found: [], checked: true, how: 'lsof', merges_checked: true,
    unfinished_merges: ['/wt/T-400 (task/T-400): MERGE_HEAD ab12cd, несведённых путей 2 — web/a.ts, web/b.ts'],
  })
  assert.match(r.log, /НЕЗАВЕРШЁННЫЕ СЛИЯНИЯ \(1\)/)
  assert.match(r.log, /T-400/, 'имя дерева в логе, а не только в результате')
  assert.match(r.log, /ЧУЖИМ именем/, 'названа цена: следующий прогон упадёт не своим конфликтом')
})

test('«не проверено» по слияниям — отдельный ответ, а не пустой список', async () => {
  const r = await runBuild({ found: [], checked: true, how: 'lsof', merges_checked: false, unfinished_merges: [] })
  assert.match(r.log, /НЕ ПРОВЕРЕНЫ/)
  assert.match(r.log, /не значит «нет»/)
  assert.doesNotMatch(r.log, /ни одного \(MERGE_HEAD нет нигде\)/)
})

// ── Имя сироты — отдельный ответ от «что видел» (находка проект-В 10.11.2026) ──
//
// Стадия замера T-415 завела дерево сравнения в `$TMPDIR` — законно, так велит правило про
// временные файлы, — и шесть живых `chrome-headless-shell` оттуда в `found` ПОПАЛИ, а
// сиротами названы не были: признак сироты в промпте был один и смотрел только на рабочий
// каталог внутри `worktrees_dir`. Сигнал был, имени не было, и процессы гасил человек по
// просьбе соседней сессии, а не по слову движка; нагрузка машины 39–57 в том прогоне
// набежала ровно от этих шести.
//
// Проверяем обе стороны, и вторая здесь так же важна: процессы ЧЕЛОВЕКА (его сервер, его
// браузер, процесс другого проекта) сиротами называть нельзя — на той машине их было
// четыре. Поэтому `orphans` подмножество `found`, а не второй список, и пустой `orphans`
// при непустом `found` — честный третий ответ, который прогон тоже говорит вслух.

test('второй признак сироты не смотрит на рабочий каталог и назван в промпте', async () => {
  const r = await runBuild({ found: [], orphans: [], checked: true, how: 'lsof' })
  assert.match(r.prompt, /ДВУМЯ ПРИЗНАКАМИ/)
  assert.match(r.prompt, /\$TMPDIR/, 'сказано, что каталог может быть любым')
  assert.match(r.prompt, /жив(ой)? СЕЙЧАС|живой СЕЙЧАС/)
  assert.match(r.prompt, /ГДЕ ГРАНИЦА: процессы ЧЕЛОВЕКА сиротами не называй/)
  assert.match(r.prompt, /orphans/)
})

test('названные сироты печатаются поимённо, а не числом', async () => {
  const r = await runBuild({
    found: [
      '41201 chrome-headless-shell — /tmp/x/_cmp',
      '41202 chrome-headless-shell — /tmp/x/_cmp',
      '5100 node — /Users/x/проект-В/web (сервер человека)',
    ],
    orphans: [
      '41201 chrome-headless-shell — сирота по признаку 2: браузер проекта жив после конца волны, каталог /tmp/x/_cmp',
      '41202 chrome-headless-shell — сирота по признаку 2: браузер проекта жив после конца волны, каталог /tmp/x/_cmp',
    ],
    checked: true, how: 'lsof',
  })
  assert.match(r.log, /НАЗВАНЫ СИРОТАМИ/)
  assert.match(r.log, /2 из них/)
  assert.match(r.log, /41201/)
  assert.match(r.log, /признаку 2/)
  // Сервер человека в сиротах не назван — значит и в этой строке его нет.
  assert.ok(!/5100/.test(r.log.split('НАЗВАНЫ СИРОТАМИ')[1] || ''), r.log)
})

test('процессы есть, сиротой не назван ни один — это тоже сказано вслух', async () => {
  const r = await runBuild({
    found: ['5100 node — /Users/x/проект-В/web'],
    orphans: [],
    checked: true, how: 'lsof',
  })
  assert.match(r.log, /сиротой не назван ни один/)
  assert.match(r.log, /шаг СУДИЛ и счёл их чужими/)
  // И названа цена ошибки шага: если это браузер проекта, признак 2 его пропустил.
  assert.match(r.log, /признак 2 его пропустил/)
})
