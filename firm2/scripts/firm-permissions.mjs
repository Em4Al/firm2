#!/usr/bin/env node
// Согласует границы песочницы и разрешений с тем, где firm2 реально работает.
//
// Зачем это отдельный шаг. Рабочие деревья задач лежат ВНЕ репозитория
// (`../<repo>.worktrees`, §9) — иначе codegraph посчитал бы каждое за копию кода, а глобы
// тестов и линтера собирали бы файлы соседних веток. Но песочница по умолчанию разрешает
// запись только в текущий каталог, временный каталог сессии и то, что добавлено в
// `permissions.additionalDirectories`. Получается: путь знает движок, а песочница — нет,
// и вся сборка превращается в череду запросов на подтверждение.
//
// Лечится не ослаблением песочницы вообще, а точным расширением ровно на тот каталог,
// который движок сам же и создаёт.
//
//   node firm-permissions.mjs [--dry-run] [--root <путь>] [--probe-only]
//
// Идемпотентно: повторный запуск ничего не меняет и говорит об этом.
//
// Кроме правки настроек скрипт ПРОВЕРЯЕТ запись — см. probe() ниже. До 23.09.2026 он
// умел только советовать, и совет невозможно было отличить от исполненного: на пилоте
// каталог `config/` оказался закрыт встроенной защитой учётных данных, скрипт об этом
// промолчал, и отказ вылез посреди сборки, на слиянии задачи (Д-5 разбора T-105).

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { repoRoot, readConfig, worktreesDir, groomWorktreesDir, requireKnownFlags} from './lib/firm.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_')
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// Неизвестный флаг — отказ, а не умолчание (Д-61): правило одно на все CLI движка.
requireKnownFlags(process.argv.slice(2), ['dry_run', 'probe_only'], { cmd: 'firm-permissions.mjs' })
const root = args.root ? String(args.root) : repoRoot()
const cfg = readConfig(root) || {}
const wt = worktreesDir(root, cfg)

const settingsPath = join(root, '.claude', 'settings.json')
let settings = {}
let existed = false
if (existsSync(settingsPath)) {
  existed = true
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch (e) {
    process.stderr.write(`[firm2] ${settingsPath} не разбирается как JSON: ${e.message}\n`)
    process.stderr.write('Почини файл руками — перезаписывать чужие настройки вслепую нельзя.\n')
    process.exit(1)
  }
}

const changes = []

function ensureArray(obj, path) {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  const last = path[path.length - 1]
  if (!Array.isArray(cur[last])) cur[last] = []
  return cur[last]
}

function add(path, value, why) {
  const arr = ensureArray(settings, path)
  if (!arr.includes(value)) {
    arr.push(value)
    changes.push(`+ ${path.join('.')}: ${value} — ${why}`)
  }
}

// 1. Рабочие деревья задач. additionalDirectories закрывает сразу две вещи: Read/Write/Edit
//    по путям вне проекта и запись из песочницы (её дефолт включает эти каталоги).
add(
  ['permissions', 'additionalDirectories'],
  wt,
  'рабочие деревья задач: без этого каждая правка файла в worktree спрашивает разрешение',
)
// 2. Явное allowWrite — на случай, если запись туда делает подпроцесс (git, тесты, линтер),
//    а не сам инструмент. Дублирование безвредно и снимает целый класс отказов.
add(
  ['sandbox', 'filesystem', 'allowWrite'],
  wt,
  'запись подпроцессов (git worktree, тесты, линтер) в те же деревья',
)

// 2б. Деревья ГРУМИНГА — тот же случай, другой каталог. Появились в 0.4.73 (ADR-0012:
//     разведка всегда идёт в своём дереве `<repo>.groom/G-XXX-<слаг>`), а этот скрипт о них
//     не знал: прописывал деревья задач и молчал про груминг. Следствие — груминг упирается
//     в отказ записи на первом же файле досье, причём в каталоге, которого человек в
//     настройках не видит. Найдено 12.10.2026 при вопросе «можно уже грумить?».
//     Каталог может ещё не существовать (его создаёт первый груминг) — как и `wt`, он
//     прописывается заранее: разрешение на несуществующий путь безвредно, а отказ посреди
//     разведки стоит сессии.
const gd = groomWorktreesDir(root, cfg)
add(
  ['permissions', 'additionalDirectories'],
  gd,
  'деревья груминга (ADR-0012): без этого каждая правка файла досье спрашивает разрешение',
)
add(
  ['sandbox', 'filesystem', 'allowWrite'],
  gd,
  'запись подпроцессов (git worktree, коммит досье) в деревья груминга',
)

// 3. Кэши инструментов сборки. Тесты в песочнице падают не на коде, а на том, что uv или
//    npm не могут писать в свой кэш в $HOME. Роль видит отказ и делает единственное, что
//    ей остаётся — просит запустить команду без песочницы, то есть человек получает запрос
//    на подтверждение ровно там, где ничего опасного не происходит. Дешевле разрешить
//    кэш, чем отключать песочницу целиком: снаружи проекта это всё равно всего два каталога.
//    Добавляем только то, чем проект действительно пользуется, и только если каталог есть.
const TOOLCHAINS = [
  { marker: ['uv.lock', 'pyproject.toml'], dirs: ['.cache/uv', '.local/share/uv'], why: 'кэш uv: без него `uv run pytest` в песочнице не стартует' },
  { marker: ['package.json'], dirs: ['.npm'], why: 'кэш npm: без него npm в песочнице упирается в отказ записи' },
  { marker: ['Cargo.toml'], dirs: ['.cargo/registry'], why: 'реестр cargo' },
]

// Маркер ищется НЕ только в корне репозитория (Д-18, проект-В 28.10.2026). Правило
// `existsSync(join(root, m))` неявно предполагало однокорневой проект: один язык, его
// манифест наверху. У проект-В бэкенд Python в корне, а весь JavaScript в `web/` — обычная
// раскладка веб-приложения, — и `package.json` в корне нет вовсе. Кэш `.npm` не
// разрешался, и `npm` в песочнице упирался в отказ записи.
//
// Поправка 28.10.2026: в первой редакции этого комментария стояло «`vitest` в песочнице не
// запускался». Пример неверен и взят из первой версии отчёта проекта: `vitest` в проект-В
// нет и быть не должно — его не пускает машинная проверка приёмки (второй раннер в
// проекте запрещён). Роли упирались в отказ, пытаясь запустить ЗАПРЕЩЁННЫЙ проектом
// раннер, и отказ песочницы это нарушение закрыл собой. Оставить пример — значит научить
// следующего читателя, что vitest был частью оснастки проект-В.
//
// Дорого тут не пропущенный инструмент, а ВИД отказа: роль получает `EPERM`,
// неотличимый от проблемы прав доступа, и объясняет его сама. По журналу проект-В — пять
// тикетов за 24 дня и ТРИ независимых одинаковых ложных диагноза («в кэше чужие файлы
// root»); каталог при этом принадлежал человеку. А одна стадия в ответ сняла песочницу
// точечно — то есть дефект разрешений подталкивал роли снимать защиту ровно там, где
// замысел этого скрипта был обратный: разрешить кэш дешевле, чем отключать песочницу.
//
// Спрашиваем ГИТ, а не обходим дерево: `ls-files` отдаёт только версионные файлы и сам
// не полезет в `node_modules`, где манифестов сотни и все чужие. Глубина не ограничена
// намеренно — `frontend/`, `web/`, `packages/*` монорепы устроены по-разному, а цена
// ошибки несимметрична: лишнее разрешение на кэш — ничто против трёх ложных диагнозов.
// Вендорные каталоги всё равно отсекаем: манифест мог быть закоммичен и внутрь них.
const VENDOR = new Set(['node_modules', '.venv', 'venv', 'vendor', 'site-packages', 'dist', 'build', '.tox', 'target'])
const vendored = (rel) => rel.split('/').some((seg) => VENDOR.has(seg))

function markerPaths(names) {
  // Пути относительно корня, короткие сначала: в сообщении хочется видеть `web/package.json`,
  // а не первый попавшийся из глубины.
  const hits = []
  for (const n of names) if (existsSync(join(root, n))) hits.push(n)
  let tracked = null
  try {
    tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...names.map((n) => `*${n}`)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    tracked = null
  }
  // Глоб `*package.json` ловит и `my-package.json` — сверяем имя файла целиком.
  for (const rel of (tracked || '').split('\0').filter(Boolean)) {
    if (!names.includes(basename(rel))) continue
    if (vendored(rel) || hits.includes(rel)) continue
    hits.push(rel)
  }
  // Один уровень вниз смотрим ВСЕГДА, а не только когда git недоступен: манифест может
  // быть ещё не закоммичен. Это обычное состояние проекта, который только что завели, —
  // и тогда разрешение появилось бы поздно и молча, уже после отказа.
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    dirs = []
  }
  for (const d of dirs) {
    if (d.startsWith('.') || VENDOR.has(d)) continue
    for (const n of names) {
      const rel = `${d}/${n}`
      if (!hits.includes(rel) && existsSync(join(root, rel))) hits.push(rel)
    }
  }
  return hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

for (const tc of TOOLCHAINS) {
  const hits = markerPaths(tc.marker)
  if (!hits.length) continue
  for (const d of tc.dirs) {
    const abs = join(homedir(), d)
    // Существование каталога БОЛЬШЕ не требуется, и это та же правка, что у `wt` и `gd`
    // выше. Кэш создаёт первый запуск инструмента: на чистой машине разрешения не было
    // бы и при верном маркере — появилось бы оно поздно и молча, уже после отказа,
    // который его и потребовал. Разрешение на несуществующий путь безвредно: писать в
    // него всё равно нечему, пока инструмент его не создаст.
    add(['sandbox', 'filesystem', 'allowWrite'], abs, `${tc.why} (маркер: ${hits[0]})`)
  }
}

// 4. Каталог состояния движка. Если он попал в denyWrite — журнал событий, дашборд и
//    claim-файлы писать нельзя, то есть маршрут не работает вовсе. Такое бывает, когда
//    настройки копируют из репозитория, где firm2 разрабатывают: там запрет уместен.
const denyWrite = (settings.sandbox && settings.sandbox.filesystem && settings.sandbox.filesystem.denyWrite) || null
if (Array.isArray(denyWrite)) {
  const hits = denyWrite.filter((p) => /(^|\/)\.firm\/?$/.test(String(p).replace(/^\.\//, './')))
  for (const h of hits) {
    const i = denyWrite.indexOf(h)
    denyWrite.splice(i, 1)
    changes.push(`- sandbox.filesystem.denyWrite: ${h} — движок пишет сюда журнал событий и дашборд`)
  }
}

// Отдельная жалоба, не правка: каталоги IDE под версией. Их правит работающая IDE, а git
// трогает при каждом переключении веток и слиянии — на обкатке это дало отказ
// «unable to unlink old '.idea/....iml'» посреди слияния, и роль в ответ попросила снять
// песочницу целиком. Чинится не разрешением, а тем, что IDE-файлам в ветках не место.
const IDE_DIRS = ['.idea', '.vscode']
for (const d of IDE_DIRS) {
  let tracked = ''
  try {
    tracked = execFileSync('git', ['-C', root, 'ls-files', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    continue
  }
  const n = tracked.split('\n').filter(Boolean).length
  if (!n) continue
  process.stdout.write(
    `[firm2] под версией ${n} файлов в ${d}/ — их правит IDE, а git трогает на каждом слиянии.\n` +
      `        Это источник отказов «unable to unlink old» посреди сборки. Развязать:\n` +
      `          git rm -r --cached ${d} && echo "${d}/" >> .gitignore\n`,
  )
}

// Секреты литералом в коде. Django из коробки кладёт SECRET_KEY прямо в settings.py с
// пометкой django-insecure — и такой файл песочница защищает как хранилище учётных данных.
// Дальше стадия не может его править, роль просит расширить права, а расширение снимает
// защиту с каталога, где лежит вся конфигурация. Лечится не правами, а выносом секрета.
let secretHits = ''
try {
  secretHits = execFileSync(
    'git',
    // Шаблон собран из кусков нарочно: написанный литералом, он лежал бы в этом файле
    // целиком, и скрипт при запуске в своём же репозитории находил бы сам себя.
    ['-C', root, 'grep', '-l', '-E', ['django', 'insecure-'].join('-') + '|SECRET_KEY\\s*=\\s*["\']'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
} catch {
  secretHits = ''
}
const secretFiles = secretHits.split('\n').filter(Boolean)
if (secretFiles.length) {
  process.stdout.write(
    `[firm2] секрет литералом в коде: ${secretFiles.join(', ')}\n` +
      `        песочница защищает такие файлы, и стадии не смогут их править. Расширять права\n` +
      `        на каталог нельзя — он для того и закрыт. Вынести секрет в .env (он уже под\n` +
      `        защитой и в .gitignore), в коде оставить чтение из окружения без запасного значения.\n` +
      `        Порядок важен: сперва вынести секрет, потом разрешать каталог в allowWrite.\n` +
      `        Защита закрывает каталог целиком, так что после выноса разрешать придётся его,\n` +
      `        а не отдельный файл — но открывать к тому моменту будет уже нечего.\n`,
  )
}

// ── Проба записи ──────────────────────────────────────────────────────────────
//
// Совет без проверки бесполезен: разрешение можно прописать и всё равно не иметь записи.
// Встроенная защита учётных данных Claude Code закрывает каталог ЦЕЛИКОМ и правами из
// `allowWrite` не перебивается — на пилоте так был закрыт `config/` Django-проекта, и
// узналось это на слиянии T-105, посреди сборки. Проба стоит доли секунды и переносит
// тот же отказ на preflight, где он стоит одной строки в диалоге с человеком.
//
// Что пробуем: каталоги ВЕРХНЕГО уровня, которые ведёт git (значит, поставка их трогает),
// плюс корень, `.firm` и каталог рабочих деревьев. Скрытые и неотслеживаемые каталоги
// (`.venv`, `node_modules`, `__pycache__`) не трогаем: поставка в них не пишет.
function topLevelDirs(root) {
  let out = ''
  try {
    out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return []
  }
  const dirs = new Set()
  for (const f of out.split('\0')) {
    if (!f) continue
    const i = f.indexOf('/')
    if (i > 0 && !f.startsWith('.')) dirs.add(f.slice(0, i))
  }
  return [...dirs].sort()
}

// Код ошибки — не деталь, а диагноз, и различить их стоит одной строки:
//   EPERM  — каталог закрыла ПЕСОЧНИЦА. Файловая система так не отвечает, если режим,
//            владелец и euid позволяют запись. Правами это не чинится, и настройками
//            проекта тоже не всегда: см. врезку ниже.
//   EACCES — не хватает прав по режиму, владельцу или ACL: обычный chmod/chown.
//   EROFS  — том смонтирован только на чтение.
// Различие установлено на пилоте 23.09.2026: два каталога с mode=0755, одним владельцем
// и одним euid — один писался, другой отдавал EPERM. Это и назвало виновника.
// Чем EPERM снимается, а чем нет — выяснено бисекцией на проект-Б 23.09.2026.
// Из `.claude/settings.json` проекта убрали сначала блок `sandbox.filesystem`, потом весь
// `sandbox` целиком, с перезапуском сессии на каждом шаге. Корень проекта и свеже созданный
// подкаталог писались, `config/` — нет. Значит правило встроено в рантайм или выведено им
// самим, и настройками проекта не отменяется: ни `allowWrite`, ни снятием `denyWrite`.
// Команды `/sandbox` в сборке CLI может не быть вовсе — там она ответила «неизвестная
// команда». Поэтому совет один и исполнимый: шаг, которому нужен этот каталог, делает
// человек в ОБЫЧНОМ Терминале, вне сессии. Там песочницы нет.
const DIAGNOSIS = {
  EPERM: 'песочница Claude Code (ни права ФС, ни настройки проекта это не перебивают)',
  EACCES: 'права файловой системы — режим, владелец или ACL',
  EROFS: 'том примонтирован только на чтение',
}

function probeOne(dir) {
  const mark = join(dir, '.firm-write-probe')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(mark, 'firm2 probe\n')
    rmSync(mark)
    return null
  } catch (e) {
    try {
      rmSync(mark, { force: true })
    } catch {}
    return e.code || e.message
  }
}

function probe(root, wtDir) {
  const targets = [
    { path: root, why: 'корень проекта — сюда идут слияние и журнал' },
    { path: join(root, '.firm'), why: 'журнал событий, дашборд, claim-файлы' },
    { path: wtDir, why: 'рабочие деревья задач' },
    ...topLevelDirs(root).map((d) => ({ path: join(root, d), why: 'каталог под версией — поставка его трогает' })),
  ]
  const denied = []
  for (const t of targets) {
    const err = probeOne(t.path)
    if (err) denied.push({ ...t, err })
  }
  return denied
}

// ── Опасные имена каталогов ───────────────────────────────────────────────────
//
// Проба ловит запрет по факту: каталог уже закрыт, и узнаём мы об этом на preflight.
// Но имя видно и до отказа, а знать заранее полезнее по трём причинам: список правил
// песочницы закрыт и может меняться; каталог, созданный ПОСЛЕ старта сессии, сегодня
// пишется, а завтра, в новой сессии, уже нет; и переименование дешевле, пока в проект
// не наросли ссылки. Поэтому имена проверяем отдельно от пробы и сообщаем в обоих
// случаях — и когда запись уже закрыта, и когда пока открыта.
//
// Список не претендует на полноту правил Claude Code — он про то, как МЫ называем свои
// каталоги. `config` подтверждён опытом (пилот 23.09.2026), остальные — того же рода.
const RISKY_DIR_NAMES = new Set(['config', 'configs', 'conf', 'settings', 'secrets', 'credentials'])

// Сколько файлов упоминают каталог — это цена переименования, и человек вправе видеть её
// до решения, а не после. Ищем и модульную форму (`config.settings`), и путевую
// (`config/settings.py`). git grep смотрит только отслеживаемое: .venv и node_modules
// в счёт не идут.
function refCount(root, name) {
  try {
    // Граница слова пишется явной альтернативой: в POSIX-регулярках (а git grep -E — они)
    // никакого `\b` нет, и шаблон с ним молча не совпадает ни разу. Ровно на этом сначала
    // вхолостую отработала замена при переименовании на пилоте.
    const out = execFileSync('git', ['-C', root, 'grep', '-I', '-l', '-E', `(^|[^A-Za-z0-9_])${name}[./]`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\n').filter(Boolean).length
  } catch {
    return 0 // git grep выходит с 1, когда совпадений нет
  }
}

function riskyDirs(root, denied) {
  const closed = new Set(denied.map((d) => (d.path.startsWith(root) ? d.path.slice(root.length + 1) : d.path)))
  return topLevelDirs(root)
    .filter((d) => RISKY_DIR_NAMES.has(d.toLowerCase()))
    .map((d) => ({ dir: d, closed: closed.has(d), files: refCount(root, d) }))
}

function reportRisky(root, denied) {
  const risky = riskyDirs(root, denied)
  if (!risky.length) return
  process.stdout.write('\n[firm2] каталоги с именами, которые запирает песочница:\n')
  for (const r of risky) {
    const state = r.closed ? 'ЗАКРЫТ на запись' : 'пока пишется, но имя рискованное'
    process.stdout.write(`  ${r.dir}/  — ${state}; упоминаний в коде и документации: ${r.files} файл(ов)\n`)
  }
  process.stdout.write(
    'Скажи человеку: имя каталога выбирали мы, и переименование снимает проблему разом —\n' +
      'в отличие от ручного обхода на каждую задачу. Пакет настроек Django зови по имени\n' +
      'проекта: django-admin startproject так и делает, `config` — просто привычка.\n' +
      'Переименование делается ЗДЕСЬ, на этапе настройки, — не тикетом и не на сборке.\n' +
      'Оно трогает общие файлы (manage.py, conftest.py, тесты, README) и параллельно с\n' +
      'задачами идти не может; на настройке задач ещё нет, и это самое дешёвое окно.\n' +
      'Руками его не\n' +
      'делай — есть скрипт, и он умеет то, чего рецепт словами не обеспечивает:\n' +
      '  node "$ENGINE/scripts/firm-rename-dir.mjs" --from <старое> --to <новое> --dry-run\n' +
      '  node "$ENGINE/scripts/firm-rename-dir.mjs" --from <старое> --to <новое>\n' +
      'Сначала ВСЕГДА --dry-run, и покажи человеку обе половины вывода: что будет заменено\n' +
      'и что скрипт доказать не смог. Вторую он разбирает сам — под имя каталога попадает\n' +
      'и постороннее (на пилоте так выглядели {{ config.title }} в шаблоне и config.json\n' +
      'элементов: трогать их было нельзя).\n' +
      'Скрипт требует чистого дерева, гоняет lint_cmd и test_cmd и при красном откатывает\n' +
      'всё через reset --hard. Коммит не делает — дифф смотрит человек.\n',
  )
  // Порядок важен: прод проверяется ДО замены, иначе проверять будет уже поздно.
  for (const r of risky) reportProd(r.dir)
}

// Прод — вторая половина вопроса о переименовании, и до 0.4.17 её никто не задавал.
// Код переименование поправит само, а настройки развёртывания живут ВНЕ репозитория:
// переменная окружения в панели, команда запуска, точка монтирования. Каталог переехал,
// команда осталась ссылаться на старое имя — и прод падает на первом же деплое после
// зелёного переименования. Проверено на проект-А 27.09.2026: команда запуска
// `gunicorn config.wsgi:application` нашлась в двух контейнерах сразу.
//
// Проверку движок НЕ выполняет сам: до прод-сервера у него доступа нет и быть не должно.
// Он печатает команды, человек выполняет их у себя и отвечает. Это ворота, а не проба.
//
// Команды намеренно простые: POSIX sh, без jq и подстановок процессов — их вставляют
// во встроенный терминал панели, где из инструментов бывает только busybox. Форма
// `{{json .Config.Cmd}}` сюда не годится: на docker сервера она дала template parsing
// error, поэтому entrypoint и cmd перебираются через range.
function prodCheckCommands(dir) {
  const re = `(^|[^A-Za-z0-9_])${dir}[./]`
  const head = (fmt) =>
    `for c in $(docker ps -q); do n=$(docker inspect $c --format '{{.Name}}'); ` +
    `docker inspect $c --format '${fmt}' | grep -E '${re}' | sed "s|^|$n  |"; done`
  return [
    ['переменные окружения', head('{{range .Config.Env}}{{println .}}{{end}}')],
    [
      'команда запуска',
      head('{{range .Config.Entrypoint}}{{println .}}{{end}}{{range .Config.Cmd}}{{println .}}{{end}}'),
    ],
    [
      'точки монтирования',
      `for c in $(docker ps -q); do n=$(docker inspect $c --format '{{.Name}}'); ` +
        `docker inspect $c --format '{{range .Mounts}}{{println .Destination}}{{end}}' | ` +
        `grep -E '(^|[^A-Za-z0-9_])${dir}([./]|$)' | sed "s|^|$n  |"; done`,
    ],
  ]
}

function reportProd(dir) {
  process.stdout.write(
    `\n[firm2] ПЕРЕД переименованием ${dir}/ — проверить прод.\n` +
      'Переименование поправит код, но не настройки развёртывания: они живут вне\n' +
      'репозитория, и движок их не видит. Дай человеку выполнить это на сервере\n' +
      '(в Coolify — терминал сервера, НЕ контейнера: внутри контейнера нет docker):\n\n',
  )
  for (const [what, cmd] of prodCheckCommands(dir)) {
    process.stdout.write(`  # ${what}\n  ${cmd}\n\n`)
  }
  process.stdout.write(
    'Пустой вывод у всех трёх — чисто, на проде править нечего.\n' +
      'Что-то вывелось — разобрать ДО замены, по каждой находке:\n' +
      `  • есть в репозитории (git grep в каталоге проекта, НЕ на сервере) — это код,\n` +
      '    переименование поправит само, в панели делать нечего;\n' +
      '  • в репозитории нет — значит задано в панели развёртывания, и человек правит\n' +
      '    там руками, в каждом приложении: одна и та же команда бывает у двух сразу.\n' +
      'Проект нигде не развёрнут — так и скажи, шаг пропускается.\n',
  )
}

function reportProbe(denied, root) {
  if (!denied.length) {
    process.stdout.write('[firm2] проба записи: все каталоги поставки доступны\n')
    reportRisky(root, denied)
    return 0
  }
  process.stdout.write(`[firm2] ПРОБА ЗАПИСИ НЕ ПРОШЛА — ${denied.length} каталог(ов) закрыты:\n`)
  for (const d of denied) {
    const rel = d.path.startsWith(root) ? d.path.slice(root.length + 1) || '.' : d.path
    process.stdout.write(`  ${rel}  ${d.err} — ${DIAGNOSIS[d.err] || 'причина неизвестна'}\n`)
    process.stdout.write(`      (${d.why})\n`)
  }
  if (denied.some((d) => d.err === 'EPERM')) {
    process.stdout.write(
      '\nEPERM — это песочница, а не файловая система и не git. Проверяется так: если режим,\n' +
        'владелец и euid позволяют запись, ФС вернула бы EACCES, а не EPERM. Из сессии такое\n' +
        'не чинится ничем: ни allowWrite в .claude/settings.json, ни повтором команды. На пилоте\n' +
        'сняли весь блок sandbox из настроек проекта — каталог остался закрыт, значит правило\n' +
        'встроено в рантайм. Команды /sandbox в сборке CLI может не быть.\n' +
        'Скажи человеку, по порядку:\n' +
        '  1) ПЕРЕИМЕНОВАТЬ каталог, если имя выбирали мы. Известный случай — пакет настроек\n' +
        '     Django, названный config: на пилоте переименование в имя проекта открыло запись\n' +
        '     при включённой песочнице. Разовая правка вместо обхода на каждую задачу; делать\n' +
        '     её надо ДО сборки, отдельной задачей — она трогает общие файлы.\n' +
        '  2) Если имя не наше — доводить такие шаги в ОБЫЧНОМ Терминале, вне сессии.\n' +
        'Выключать песочницу целиком не предлагай.\n' +
        'Пока каталог закрыт, сборка дойдёт до слияния задачи, которая его правит, и встанет —\n' +
        'ровно так на пилоте встала T-105.\n',
    )
  }
  reportRisky(root, denied)
  return 1
}

if (args.probe_only) {
  process.exit(reportProbe(probe(root, wt), root))
}

if (!changes.length) {
  process.stdout.write('[firm2] границы песочницы уже согласованы с движком, менять нечего\n')
  process.stdout.write(`        рабочие деревья: ${wt}\n`)
  process.exit(reportProbe(probe(root, wt), root))
}

const rendered = JSON.stringify(settings, null, 2) + '\n'

if (args.dry_run) {
  process.stdout.write(changes.join('\n') + '\n\n' + rendered)
  process.exit(0)
}

// Файл машинный: в нём абсолютные пути этой машины (каталог рабочих деревьев, кэши в
// домашнем каталоге). В репозитории ему не место — у коллеги он не сработает, а в ветке
// поставки будет выглядеть как чужой мусор. Говорим об этом ровно один раз, при записи.
let tracked = ''
try {
  tracked = execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', settingsPath], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
} catch {
  tracked = ''
}
if (tracked.trim()) {
  process.stdout.write(
    `[firm2] ${settingsPath} под версией, а пути в нём машинные — на другой машине он бессмыслен.\n` +
      `        Развязать: git rm --cached .claude/settings.json && echo ".claude/settings.json" >> .gitignore\n`,
  )
}

mkdirSync(join(root, '.claude'), { recursive: true })
writeFileSync(settingsPath, rendered)
process.stdout.write(
  `[firm2] ${existed ? 'обновил' : 'создал'} ${settingsPath}\n` + changes.map((c) => '  ' + c).join('\n') + '\n',
)
// Момент вступления в силу — вопрос, который возникает у каждого, кто это запустил, а
// скрипт о нём молчал. Ответ ЗАМЕРЕН, а не выведен из общих соображений: 28.10.2026 на
// проект-В человек добавил `~/.npm` этим скриптом и тут же в УЖЕ ОТКРЫТОЙ сессии прошла
// проба `touch ~/.npm/_cacache/.firm-probe`, до того отвечавшая «Operation not permitted».
// Границы читаются на вызов, а не берутся при старте сессии.
process.stdout.write(
  '        Перезапускать сессию не нужно: новые границы действуют сразу (замерено 28.10.2026).\n' +
    '        Проверить на месте: touch ~/.npm/_cacache/.firm-probe && rm ~/.npm/_cacache/.firm-probe\n',
)

// Настройки записаны — теперь проверяем, что они дают запись на самом деле.
process.exit(reportProbe(probe(root, wt), root))
