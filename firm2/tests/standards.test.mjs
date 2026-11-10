// Стандарты кода проекта — вход оси Standards код-ревью.
//
// Разбор ECC 14.10.2026 (`docs/ecc-ingest.md`, пункт 1): приём `firm-review` делегирует в
// `mattpocock-skills:code-review`, который судит по двум осям, и первая — «does the code
// follow this repo's DOCUMENTED coding standards?». Документа движок не раскладывал
// никуда, то есть ось существовала с пустым входом, и половина каждого вердикта
// держалась на том, что роль придумает на ходу.
//
// Тесты держат ровно одно: пустая ось СЛЫШНА. Она не блокирует прогон (проект вправе
// стандартов не иметь, ADR-0009), но попадает и в `phase`, и в предупреждения
// `build-args` — то есть в оба места, которые читают перед сессией и перед сборкой.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { standardsState, standardsFindings, standardsFor, standardsForLines, STANDARDS_DIR } from '../scripts/lib/firm.mjs'
import { makeProject, ENGINE } from './helpers.mjs'
import { readFileSync } from 'node:fs'

function layStandards(root, files = ['common.md']) {
  mkdirSync(join(root, STANDARDS_DIR), { recursive: true })
  for (const f of files) writeFileSync(join(root, STANDARDS_DIR, f), `# ${f}\n`)
}

test('стандартов нет — одна находка, и в ней сказано, чем это кончится', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  assert.deepEqual(standardsState(p.root), { dir: STANDARDS_DIR, files: [], present: false })
  const f = standardsFindings(p.root)
  assert.equal(f.length, 1)
  assert.match(f[0], /ось Standards/)
  assert.match(f[0], /firm-setup/)
})

test('общая часть разложена — находок нет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layStandards(p.root, ['common.md', 'python.md'])
  const st = standardsState(p.root)
  assert.equal(st.present, true)
  assert.deepEqual(st.files, ['common.md', 'python.md'])
  assert.deepEqual(standardsFindings(p.root), [])
})

test('каталог есть, а common.md нет — это ОТДЕЛЬНАЯ находка: ось читает именно его', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layStandards(p.root, ['python.md'])
  const f = standardsFindings(p.root)
  assert.equal(f.length, 1)
  assert.match(f[0], /common\.md/)
  assert.match(f[0], /python\.md/)
})

test('находка видна в phase — её читают до каждой сессии маршрута', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const before = JSON.parse(p.cli('firm-state.mjs', ['phase', '--json', '--root', p.root]).stdout)
  assert.equal(before.standards.present, false)
  assert.equal(before.standards_findings.length, 1)
  layStandards(p.root)
  const after = JSON.parse(p.cli('firm-state.mjs', ['phase', '--json', '--root', p.root]).stdout)
  assert.equal(after.standards.present, true)
  assert.deepEqual(after.standards_findings, [])
})

test('находка видна в предупреждениях build-args — последний момент перед прогоном', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const args = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--json', '--root', p.root]).stdout)
  assert.equal(args.warnings.some((w) => /ось Standards/.test(w)), true)
  layStandards(p.root)
  const after = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--json', '--root', p.root]).stdout)
  assert.equal(after.warnings.some((w) => /ось Standards/.test(w)), false)
})

test('пустая ось не блокирует прогон: это предупреждение, а не ошибка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.cli('firm-state.mjs', ['build-args', '--json', '--root', p.root])
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).tasks.length, 1)
})

// ── Сами шаблоны ─────────────────────────────────────────────────────────────

test('шаблон общей части несёт frontmatter paths и перечень триггеров безопасности', () => {
  const src = readFileSync(join(ENGINE, 'templates', 'standards', 'common.md'), 'utf8')
  assert.match(src, /^---\npaths:\n\s+- "\*\*\/\*"/)
  assert.match(src, /чувствительный-к-безопасности/)
  // Инъекция, обход пути и утечка в лог — три находки, которые перечень обязан называть:
  // критерии приёмки про них не говорят по построению.
  for (const re of [/инъекц/i, /обход пути/i, /лог/i]) assert.match(src, re)
})

test('шаблон языка прицелен к файлам языка, а не ко всему дереву', () => {
  const src = readFileSync(join(ENGINE, 'templates', 'standards', 'python.md'), 'utf8')
  assert.match(src, /^---\npaths:\n\s+- "\*\*\/\*\.py"/)
  assert.match(src, /common\.md/)
})

// ── Шаблон интерфейса ────────────────────────────────────────────────────────
// Отобран из корпуса ui-ux-pro-max фильтром самого common.md: не полнота, а
// проверяемость. Тесты держат именно фильтр — список правил проект правит под себя, а вот
// попадание в файл непроверяемого правила ломает ось так же, как её пустой вход.

test('шаблон интерфейса прицелен к файлам экранов, а не ко всему дереву', () => {
  const src = readFileSync(join(ENGINE, 'templates', 'standards', 'ui.md'), 'utf8')
  assert.match(src, /^---\npaths:\n\s+- "\*\*\/\*\.html"/)
  for (const glob of ['**/*.tsx', '**/*.jsx', '**/*.vue']) assert.equal(src.includes(`"${glob}"`), true, `нет глоба ${glob}`)
  assert.match(src, /common\.md/)
})

test('шаблон интерфейса несёт все восемь предъявляемых на диффе правил', () => {
  const src = readFileSync(join(ENGINE, 'templates', 'standards', 'ui.md'), 'utf8')
  for (const [what, re] of [
    ['контраст', /4\.5:1/],
    ['тач-цели', /44×44|44x44/],
    ['зазор между целями', /8 px/],
    ['viewport meta', /width=device-width/],
    ['подпись у поля', /placeholder/],
    ['ошибка рядом с полем', /aria-describedby/],
    ['доступное имя иконочной кнопки', /aria-hidden/],
    ['фокус', /outline: none/],
    ['движение', /prefers-reduced-motion/],
  ]) assert.match(src, re, `нет правила: ${what}`)
})

test('половинные правила названы половинами, и вторая половина не потеряна', () => {
  const src = readFileSync(join(ENGINE, 'templates', 'standards', 'ui.md'), 'utf8')
  // Ровно два правила записаны половинами — контраст и тач-цели. Если их станет больше или
  // меньше молча, ось начнёт выносить вердикты там, где значения в правке нет.
  assert.equal((src.match(/\*Половина правила:\*/g) || []).length, 2)
  // И у каждой половины сказано, КУДА делась вторая: в критерий задачи, а не в корзину.
  assert.ok((src.match(/критерий задачи/g) || []).length >= 2, 'каждая половина обязана назвать, куда делась вторая')
  // Граница сформулирована по видимости значения, а не по виду записи: `min-h-[44px]`
  // предъявляется на диффе, `h-11` — нет, и путать это дорого (разбор 21.10.2026).
  assert.match(src, /min-h-\[44px\]/)
  assert.match(src, /h-11/)
})

test('в шаблоне интерфейса нет вкусовых правил и предсказаний вёрстки', () => {
  const src = readFileSync(join(ENGINE, 'templates', 'standards', 'ui.md'), 'utf8')
  const [, refusals] = src.split('## Чего в этом файле нет намеренно')
  assert.ok(refusals, 'раздел отказов обязателен: без него правила-кандидаты вернутся молча')
  // Каждое из отклонённых названо ИМЕННО в разделе отказов, а не где-нибудь в правилах.
  for (const re of [/консистентность стиля/i, /движение передаёт смысл/i, /предсказание вёрстки/i]) {
    assert.match(refusals, re)
  }
  assert.match(refusals, /measured/, 'числа-предсказания обязаны быть отправлены в measured по имени')
})

// ── Отбор стандартов по paths против файлов правки (21.10.2026) ──────────────
//
// Разбор стадии Ревьюера счётом контекста нашёл дыру не в бюджете, а в доставке:
// frontmatter `paths` у стандартов не читал НИКТО. Ревьюеру было сказано «common.md плюс
// файл ЯЗЫКА», а `ui.md` кладётся по признаку «есть экраны» и файлом языка не является —
// то есть правила интерфейса уезжали в проекты и в ось Standards не попадали вовсе.
//
// Тесты держат две стороны: нужный файл не отводится никогда (пропущенная норма дороже
// лишних символов), а ненужный не навязывается (норма не про эту правку приглашает
// замечание «по вкусу»).

function layWithPaths(root, files) {
  mkdirSync(join(root, STANDARDS_DIR), { recursive: true })
  for (const [name, paths] of Object.entries(files)) {
    const fm = paths === null ? '' : `---\npaths:\n${paths.map((p) => `  - "${p}"`).join('\n')}\n---\n\n`
    writeFileSync(join(root, STANDARDS_DIR, name), `${fm}# ${name}\n`)
  }
}

test('правка на Python берёт python.md и НЕ берёт ui.md', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layWithPaths(p.root, {
    'common.md': ['**/*'],
    'python.md': ['**/*.py'],
    'ui.md': ['**/*.tsx', '**/*.html'],
  })
  const st = standardsFor(p.root, ['src/app.py', 'src/util.py'])
  assert.deepEqual(st.applicable.map((a) => a.file), ['common.md', 'python.md'])
  assert.deepEqual(st.skipped.map((k) => k.file), ['ui.md'])
  assert.match(st.skipped[0].why, /\*\*\/\*\.tsx/)
})

test('правка экранов берёт ui.md — тот самый файл, который ось не видела', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layWithPaths(p.root, { 'common.md': ['**/*'], 'python.md': ['**/*.py'], 'ui.md': ['**/*.tsx'] })
  const st = standardsFor(p.root, ['web/components/Card.tsx'])
  assert.deepEqual(st.applicable.map((a) => a.file), ['common.md', 'ui.md'])
  assert.match(st.applicable[1].why, /Card\.tsx/)
})

test('общая часть и политика линта применимы всегда, чем бы правка ни была', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layWithPaths(p.root, { 'common.md': ['**/*.py'], 'lint-policy.md': null, 'ui.md': ['**/*.tsx'] })
  const st = standardsFor(p.root, ['README.md'])
  // common.md объявил пути, в которые правка не попала, — и всё равно читается: общая
  // часть есть вход оси, а не правило про язык.
  assert.deepEqual(st.applicable.map((a) => a.file), ['common.md', 'lint-policy.md'])
  assert.deepEqual(st.skipped.map((k) => k.file), ['ui.md'])
})

test('файл без paths читается как общий: «не знаю» решается в сторону чтения (И-12)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layWithPaths(p.root, { 'common.md': ['**/*'], 'go.md': null })
  const st = standardsFor(p.root, ['src/app.py'])
  assert.deepEqual(st.applicable.map((a) => a.file), ['common.md', 'go.md'])
  assert.match(st.applicable[1].why, /не объявлены paths/)
})

test('файлы правки не названы — отводится НИЧЕГО, а не всё', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  layWithPaths(p.root, { 'common.md': ['**/*'], 'python.md': ['**/*.py'], 'ui.md': ['**/*.tsx'] })
  const st = standardsFor(p.root, null)
  assert.equal(st.skipped.length, 0)
  assert.equal(st.applicable.length, 3)
  assert.match(standardsForLines(st).join('\n'), /отбор не делался/)
})

test('стандартов нет — отбор молчит, а находка про пустую ось остаётся', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const st = standardsFor(p.root, ['src/app.py'])
  assert.deepEqual(st.applicable, [])
  assert.equal(st.findings.length, 1)
  assert.match(st.findings[0], /ось Standards/)
})

test('шаблоны движка, которые Ревьюер раскладывает в проект, сами проходят отбор', (t) => {
  // Не синтетика: берём настоящие шаблоны и проверяем, что их frontmatter читается тем
  // же отбором. Объявление, которое не работает на собственных файлах движка, — украшение.
  const p = makeProject(t, { tasks: ['T-001'] })
  mkdirSync(join(p.root, STANDARDS_DIR), { recursive: true })
  for (const f of ['common.md', 'python.md', 'ui.md']) {
    writeFileSync(
      join(p.root, STANDARDS_DIR, f),
      readFileSync(join(ENGINE, 'templates', 'standards', f), 'utf8'),
    )
  }
  const py = standardsFor(p.root, ['pkg/mod.py'])
  assert.deepEqual(py.applicable.map((a) => a.file), ['common.md', 'python.md'])
  const ui = standardsFor(p.root, ['app/page.svelte'])
  assert.deepEqual(ui.applicable.map((a) => a.file), ['common.md', 'ui.md'])
})
