// Разрешения на каталоги, которые движок завёл сам. Правило простое: каталог, в который
// движок велит стадии писать, обязан быть в настройках проекта — иначе роль упирается в
// отказ записи в каталоге, которого человек в настройках даже не видит.
//
// Найдено 12.10.2026 на вопрос «можно уже грумить?»: деревья груминга появились в 0.4.73
// (ADR-0012), а `firm-permissions.mjs` прописывал только деревья ЗАДАЧ — груминг встал бы
// на первом же файле досье. Ошибка не в коде груминга, а в том, что настройка отстала от
// нового каталога на четыре версии.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeProject } from './helpers.mjs'

const dry = (p) => p.cli('firm-permissions.mjs', ['--dry-run', '--root', p.root]).stdout

test('деревья груминга и задач прописываются оба', (t) => {
  const p = makeProject(t, { tasks: [] })
  const out = dry(p)
  for (const where of ['additionalDirectories', 'allowWrite']) {
    assert.match(out, new RegExp(`${where}[^\\n]*\\.worktrees`), `деревья задач в ${where}`)
    assert.match(out, new RegExp(`${where}[^\\n]*\\.groom`), `деревья груминга в ${where}`)
  }
})

test('каталог груминга прописывается заранее, до первого груминга', (t) => {
  const p = makeProject(t, { tasks: [] })
  // Каталог создаёт первый груминг. Ждать его значит получить отказ посреди разведки:
  // разрешение на несуществующий путь безвредно, а остановка сессии — нет.
  assert.match(dry(p), /\.groom/)
})

test('свой groom_dir из конфига уважается', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'groom_dir: "/tmp/firm2-test-groom-elsewhere"\n' })
  const out = dry(p)
  assert.match(out, /firm2-test-groom-elsewhere/, 'путь берётся из конфига, а не собирается по шаблону')
})

// ── Маркер набора инструментов ищется не только в корне (Д-18) ───────────────
//
// Отчёт проект-В 28.10.2026. Правило `existsSync(join(root, marker))` неявно предполагало
// однокорневой проект: один язык, его манифест наверху. У проект-В бэкенд Python в корне,
// а весь JavaScript в `web/` — `package.json` в корне нет, кэш `.npm` не разрешался,
// `vitest` в песочнице не стартовал. Дорого не это, а ВИД отказа: роль получает `EPERM`,
// неотличимый от проблемы прав, и объясняет его сама — три независимых ложных диагноза
// «в кэше чужие файлы root» за три недели, а каталог принадлежал человеку.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test('манифест в подкаталоге: кэш разрешается, и сказано, каким маркером', (t) => {
  const p = makeProject(t, { tasks: [] })
  mkdirSync(join(p.root, 'web'), { recursive: true })
  writeFileSync(join(p.root, 'web', 'package.json'), '{"name":"web"}\n')
  p.git('add', '-A')
  p.git('commit', '-qm', 'web')
  const out = dry(p)
  assert.match(out, /allowWrite[^\n]*\.npm/, 'кэш npm разрешён, хотя манифеста в корне нет')
  assert.match(out, /маркер: web\/package\.json/, 'названо, ЧЕМ сработало правило: иначе разрешение не проверить')
})

test('манифест внутри node_modules правило не включает', (t) => {
  // Иначе маркер нашёлся бы на чужом манифесте в зависимостях — и правило срабатывало бы
  // в любом проекте, где хоть что-то установлено.
  const p = makeProject(t, { tasks: [] })
  mkdirSync(join(p.root, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(p.root, 'node_modules', 'left-pad', 'package.json'), '{"name":"left-pad"}\n')
  p.git('add', '-f', 'node_modules')
  p.git('commit', '-qm', 'vendored')
  assert.doesNotMatch(dry(p), /\.npm/, 'вендорные каталоги при поиске маркера отсекаются')
})

test('кэша на машине ещё нет — разрешение всё равно прописывается', (t) => {
  // До этого добавлялся только существующий каталог. На чистой машине, где инструмент ни
  // разу не запускался, разрешения не было бы и при верном маркере: оно появилось бы
  // поздно и молча — уже после отказа, который его и потребовал. Запись в несуществующий
  // каталог всё равно не состоится, пока его не создаст сам инструмент.
  const p = makeProject(t, { tasks: [] })
  writeFileSync(join(p.root, 'Cargo.toml'), '[package]\nname = "x"\n')
  p.git('add', '-A')
  p.git('commit', '-qm', 'cargo')
  assert.match(dry(p), /allowWrite[^\n]*\.cargo\/registry/, 'разрешение не ждёт первого запуска инструмента')
})

test('манифест в подкаталоге, не заведённый в git, тоже считается', (t) => {
  // Запасной путь на случай, когда git недоступен или файл ещё не закоммичен: один
  // уровень вниз своими руками. Этого хватает на `web/`, `frontend/`, `client/`.
  const p = makeProject(t, { tasks: [] })
  mkdirSync(join(p.root, 'frontend'), { recursive: true })
  writeFileSync(join(p.root, 'frontend', 'package.json'), '{"name":"f"}\n')
  assert.match(dry(p), /allowWrite[^\n]*\.npm/, 'незакоммиченный манифест — тоже факт о проекте')
})

test('ни одного манифеста — лишних разрешений нет', (t) => {
  const p = makeProject(t, { tasks: [] })
  const out = dry(p)
  assert.doesNotMatch(out, /\.npm/, 'без JS-проекта кэш npm разрешать не за что')
  assert.doesNotMatch(out, /\.cargo/)
})

test('отказ снятия песочницы различает два EPERM', (t) => {
  // Вторая половина Д-18, и она дороже первой: пока отказ приходит ролям в виде, не
  // отличимом от проблемы прав, они будут объяснять его сами — и объясняли неверно
  // трижды. Подсказка стоит в отказе `bash-guard`, то есть ровно там, где роль уже
  // упёрлась и собирается снять защиту.
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = p.sibling('T-001')
  mkdirSync(wt, { recursive: true })
  p.git('worktree', 'add', '-q', '-b', 'task/T-001', wt, 'HEAD')
  const r = p.cli('bash-guard.mjs', [], {
    input: JSON.stringify({ cwd: wt, tool_input: { command: 'npm ci', dangerouslyDisableSandbox: true } }),
  })
  assert.equal(r.status, 2, 'снятие песочницы стадией по-прежнему отклоняется')
  assert.match(r.stderr, /Operation not permitted.*\$HOME|\$HOME.*Operation not permitted/s)
  assert.match(r.stderr, /ПЕСОЧНИЦА, а не права доступа/)
  assert.match(r.stderr, /ls -ld/, 'названа команда, которой владелец проверяется, а не предполагается')
  assert.match(r.stderr, /firm-permissions\.mjs/, 'сказано, кто разрешает кэши — иначе роль снова полезет чинить права')
})

test('скрипт говорит, когда новые границы вступают в силу', (t) => {
  // Вопрос «а только в новой сессии?» возникает у каждого, кто запустил скрипт, и скрипт
  // о нём молчал. Ответ замерен на проект-В 28.10.2026: проба прошла в уже открытой сессии.
  const p = makeProject(t, { tasks: [] })
  const r = p.cli('firm-permissions.mjs', ['--root', p.root])
  assert.match(r.stdout, /Перезапускать сессию не нужно/)
  assert.match(r.stdout, /замерено 28\.10\.2026/, 'утверждение подписано замером, а не подано как общее знание')
  assert.match(r.stdout, /firm-probe/, 'названа команда, которой это проверяется на месте')
})
