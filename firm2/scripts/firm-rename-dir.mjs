#!/usr/bin/env node
// Переименование каталога, который запирает песочница (Д-7 разбора 24.09.2026).
//
// Зачем механизм, а не инструкция. Переименование `config` → `myapp` на пилоте
// делалось руками по написанному рецепту, и рецепт не сработал дважды подряд: сначала
// замена вхолостую (в BSD sed нет `\b`), потом проверка с фильтром `--include='*.py'
// --include='*.md'` — и ссылка в `pyproject.toml` уцелела. Тесты этого не видят: 835
// зелёных, а `lint_cmd` поставки красный. Нашлось на MR-ревью, вместе с настоящими
// дефектами. Инструкция, которую дважды исполнили неверно, — это не инструкция.
//
// Почему нельзя заменять вслепую. На том же репозитории под шаблон `config\.` попадают
// `{{ config.title }}` в шаблоне панели и `config.json` элементов — к пакету настроек
// они отношения не имеют, и слепая замена их бы сломала. Поэтому набор замен выводится
// из СОДЕРЖИМОГО каталога: заменяем только `<старое>.X` и `<старое>/X`, где `X` реально
// лежит внутри. `title` файлом не является — `{{ config.title }}` остаётся нетронутым;
// `elements/reading_club/config.json` не начинается с `config/` — тоже остаётся.
//
// Что скрипт НЕ делает. Не решает за человека: имя каталога — его дело. Не трогает
// записи о прошлом (`docs/bugs/`, `openspec/changes/archive/`) — это протокол, а не
// текущее состояние. Не «дочищает» то, чего не смог доказать: всё непокрытое печатается
// человеку списком, и это главный вывод, а не сноска.
//
// Использование:
//   firm-rename-dir.mjs --from config --to myapp --dry-run   что будет сделано
//   firm-rename-dir.mjs --from config --to myapp             сделать и проверить
//
// Проверка после замены: остаток ищется `git grep` по ВСЕМУ отслеживаемому, без фильтра
// по типам файлов, затем гоняются `lint_cmd` и `test_cmd` из `.firm/config`. Красный
// результат откатывает всё (`git reset --hard`), потому что дерево на входе обязано быть
// чистым — это требование, а не совет.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { repoRoot, readConfig } from './lib/firm.mjs'

const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const DRY = argv.includes('--dry-run')
const FROM = arg('from')
const TO = arg('to')

const root = repoRoot()
function git(args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

function die(msg, code = 1) {
  process.stderr.write(`[firm2] ${msg}\n`)
  process.exit(code)
}

if (!FROM || !TO) {
  process.stdout.write(
    'firm-rename-dir.mjs — переименовать каталог верхнего уровня и починить ссылки на него\n\n' +
      '  --from <имя>    что переименовываем (каталог верхнего уровня, под версией)\n' +
      '  --to <имя>      во что\n' +
      '  --dry-run       только показать: что заменится и что останется человеку\n\n' +
      'Дерево должно быть чистым: при красной проверке скрипт откатывает всё через reset --hard.\n',
  )
  process.exit(FROM || TO ? 1 : 0)
}

// ── Предусловия ───────────────────────────────────────────────────────────────
// Чистое дерево — не придирка: откат при красной проверке делается `reset --hard`, и на
// грязном дереве он снёс бы чужую работу. Отказ здесь дешевле разбирательства потом.
const dirty = git(['status', '--porcelain']).trim()
if (dirty && !DRY) die(`дерево не чистое — сначала закоммить или спрячь:\n${dirty}`)

const fromPath = join(root, FROM)
if (!existsSync(fromPath) || !statSync(fromPath).isDirectory()) die(`каталога ${FROM}/ нет`)
if (existsSync(join(root, TO))) die(`${TO}/ уже существует`)

// ── Из чего выводим замены ────────────────────────────────────────────────────
// Члены каталога: `settings.py` даёт и модульную форму `config.settings`, и путевую
// `config/settings.py`. Вложенные каталоги дают только путевую — модульная для пакета
// внутри пакета всё равно начинается с того же префикса и покрывается им.
const members = new Set()
for (const e of readdirSync(fromPath, { withFileTypes: true })) {
  if (e.name.startsWith('.')) continue
  members.add(e.name) // путевая форма: config/settings.py, config/templates
  if (e.isFile() && extname(e.name)) members.add(basename(e.name, extname(e.name))) // модульная: config.settings
}
if (!members.size) die(`${FROM}/ пуст — нечего выводить`)

const alt = [...members].map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
// Граница слова — явной альтернативой: в POSIX-регулярках `\b` нет, и шаблон с ним молча
// не совпадает ни разу. Ровно на этом вхолостую отработала замена на пилоте.
const SAFE = new RegExp(`(^|[^A-Za-z0-9_])${FROM}([./])(${alt})\\b`, 'g')
// Похожее, но недоказанное. Шире, чем SAFE, нарочно: имя может встретиться и не через
// точку со слэшем, а куском собранного пути — `REPO_ROOT / "config" / "settings.py"`.
// Именно такую строку рецепт пропустил на пилоте (tests/test_t003_session_cookie_flags.py),
// потому что искали только `config.` и `config/`. Шум в этом списке допустим: он для
// глаз человека, а не для автоматической правки.
const SUSPECT = new RegExp(`(^|[^A-Za-z0-9_])${FROM}([^A-Za-z0-9_]|$)`)

// ── Файлы, которые смотрим ────────────────────────────────────────────────────
// Только отслеживаемое git: .venv и node_modules не наши. Записи о прошлом исключаем —
// переписывать протокол нельзя.
// Записи о прошлом не правим. `.firm/` в этом списке с 01.10.2026: события отслеживаются
// git (writeEvent делает `git add`), поэтому попадали под замену — и переименование
// каталога переписывало цитаты в `notes` разбора ревью, то есть ровно то, в чём и была
// ценность записи (И-2, ADR-0006: журнал только дописывается). Пути файлов в `notes` и
// `criteria` кладёт хук из structured output роли, так что совпадение — норма, а не
// редкость. Найдено ревью по инвариантам.
const KEEP_HISTORY = [/^docs\/bugs\//, /^openspec\/changes\/archive\//, /^\.firm\//]
// Файлы САМОГО каталога тоже правим: Django-шаблон кладёт в settings.py строки
// `ROOT_URLCONF = "config.urls"` и `WSGI_APPLICATION = "config.wsgi.application"`, и
// каталог, переехавший вместе с ними, не поднимется. Найдено собственным тестом.
// После `git mv` они лежат уже под новым именем — путь пересчитываем при записи.
const tracked = git(['ls-files', '-z'])
  .split('\0')
  .filter(Boolean)
  .filter((f) => !KEEP_HISTORY.some((re) => re.test(f)))
const moved = (f) => (f === FROM || f.startsWith(`${FROM}/`) ? TO + f.slice(FROM.length) : f)

function isText(abs) {
  try {
    const buf = readFileSync(abs)
    return !buf.includes(0)
  } catch {
    return false
  }
}

const planned = [] // { file, hits }
const leftover = [] // { file, line, text } — доказать не смогли, решает человек
for (const f of tracked) {
  const abs = join(root, f)
  if (!isText(abs)) continue
  const src = readFileSync(abs, 'utf8')
  if (!SUSPECT.test(src)) continue
  const hits = (src.match(SAFE) || []).length
  if (hits) planned.push({ file: f, hits })
  const after = src.replace(SAFE, `$1${TO}$2$3`)
  after.split('\n').forEach((line, i) => {
    if (SUSPECT.test(line)) leftover.push({ file: f, line: i + 1, text: line.trim().slice(0, 120) })
  })
}

// ── Отчёт ─────────────────────────────────────────────────────────────────────
process.stdout.write(`[firm2] переименование ${FROM}/ → ${TO}/\n`)
process.stdout.write(`        формы замены выведены из содержимого: ${[...members].sort().join(', ')}\n\n`)
if (planned.length) {
  process.stdout.write(`Будет заменено в ${planned.length} файл(ах):\n`)
  for (const p of planned) process.stdout.write(`  ${p.file}  (${p.hits})\n`)
} else {
  process.stdout.write('Замен не требуется: ссылок обеих форм не найдено.\n')
}
if (leftover.length) {
  process.stdout.write(
    `\nОСТАЁТСЯ ЧЕЛОВЕКУ — ${leftover.length} совпадени(й) с именем «${FROM}», которые скрипт\n` +
      `доказать не смог и поэтому НЕ трогает. Посмотри каждое: к переименованному каталогу\n` +
      `относится не всё, что похоже (на пилоте так выглядели {{ config.title }} в шаблоне и\n` +
      `config.json элементов — их трогать было нельзя):\n`,
  )
  for (const l of leftover.slice(0, 40)) process.stdout.write(`  ${l.file}:${l.line}  ${l.text}\n`)
  if (leftover.length > 40) process.stdout.write(`  … и ещё ${leftover.length - 40}\n`)
}

if (DRY) {
  process.stdout.write('\n--dry-run: ничего не изменено.\n')
  process.exit(0)
}

// ── Выполнение ────────────────────────────────────────────────────────────────
const before = git(['rev-parse', 'HEAD']).trim()
git(['mv', FROM, TO])
for (const p of planned) {
  const abs = join(root, moved(p.file))
  writeFileSync(abs, readFileSync(abs, 'utf8').replace(SAFE, `$1${TO}$2$3`))
}
process.stdout.write(`\nПеренесено и поправлено. Проверяю.\n`)

// ── Проверка ──────────────────────────────────────────────────────────────────
// Остаток ищем БЕЗ фильтра по типам файлов — именно фильтр `--include` упустил на пилоте
// ссылку в pyproject.toml. Линт гоняем наравне с тестами: тесты ту ссылку не видели.
// Две поправки 01.10.2026, и без любой из них проверка бесполезна или вредна.
//
// Первая: `\b` здесь НЕ работает. В JS-регулярке (`SAFE` выше) он есть, а `git grep -E`
// берёт POSIX ERE, где его нет, — шаблон молча не совпадает ни разу, и ветка «остались
// ссылки» не срабатывала никогда. То есть страховка, ради которой ниже стоит `reset
// --hard`, не существовала. Это ровно та грабля, про которую предупреждает комментарий у
// `SAFE`: там её обошли явной альтернативой, а здесь забыли. Нашли автотесты.
//
// Вторая: искать надо там же, где правим. `KEEP_HISTORY` исключает `.firm/`, `docs/bugs/`
// и архив спек из ЗАМЕНЫ (журнал только дописывается, И-2), но `git grep` шёл по всему
// отслеживаемому — и, будь регулярка живой, нашёл бы упоминание каталога в `notes`
// события, счёл это недоделанной заменой и откатил бы переименование целиком. Проект, у
// которого каталог хоть раз попал в журнал, стало бы невозможно переименовать. Поэтому
// исключения повторены здесь pathspec-ом; два места с одним смыслом — но git не умеет
// принимать готовый список регулярок, а разъехаться им не даст тест.
const KEEP_PATHSPEC = ['--', ':(exclude).firm', ':(exclude)docs/bugs', ':(exclude)openspec/changes/archive']
let rest = ''
try {
  rest = git(
    ['grep', '-n', '-E', `(^|[^A-Za-z0-9_])${FROM}([./])(${alt})([^A-Za-z0-9_]|$)`, ...KEEP_PATHSPEC],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
} catch {
  rest = '' // git grep выходит с 1, когда совпадений нет
}
if (rest.trim()) {
  process.stdout.write(`\nОСТАЛИСЬ ССЫЛКИ ДОКАЗУЕМОЙ ФОРМЫ — это ошибка скрипта, не твоя:\n${rest}`)
}

const cfg = readConfig(root) || {}
const stack = cfg.stack || {}
const checks = [
  ['lint', stack.lint_cmd],
  ['test', stack.test_cmd],
].filter(([, cmd]) => cmd)

let failed = rest.trim() ? ['остаток ссылок'] : []
for (const [name, cmd] of checks) {
  process.stdout.write(`\n— ${name}: ${cmd}\n`)
  try {
    execFileSync(cmd, { cwd: root, shell: true, stdio: 'inherit' })
  } catch {
    failed.push(name)
  }
}
if (!checks.length) {
  process.stdout.write('\nlint_cmd/test_cmd в .firm/config не заданы — проверить нечем, прогони сам.\n')
}

if (failed.length) {
  process.stdout.write(`\n[firm2] ПРОВЕРКА КРАСНАЯ (${failed.join(', ')}) — откатываю к ${before.slice(0, 7)}.\n`)
  git(['reset', '--hard', before])
  process.stdout.write(
    'Дерево вернулось в исходное состояние. Причина видна выше: чаще всего это ссылка формы,\n' +
      'которую скрипт не выводит из содержимого каталога (например, путь, собранный из кусков:\n' +
      'REPO_ROOT / "config" / "settings.py"). Поправь её отдельно и запусти снова.\n',
  )
  process.exit(1)
}

process.stdout.write(
  `\n[firm2] готово: ${FROM}/ → ${TO}/, проверки зелёные. Не закоммичено — посмотри дифф и\n` +
    `закоммить сам:  git -C ${root} add -A && git -C ${root} commit -m "refactor: ${FROM} → ${TO}"\n`,
)
if (leftover.length) {
  process.stdout.write(`Напоминание: ${leftover.length} совпадени(й) оставлено тебе, список выше.\n`)
}
process.exit(0)
