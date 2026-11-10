#!/usr/bin/env node
// Рубеж перед доставкой: прогнать движок по себе, прежде чем он уедет в проекты.
//
// Появился 01.10.2026, после дня, в котором я привёз в четыре живых проекта три дефекта
// подряд. Все три прошли бы любую проверку «а компилируется ли» — и всё равно портили
// журнал на настоящих прогонах по пять миллионов токенов. Вывод простой: отлаживать
// движок прогонами — самый дорогой известный способ найти опечатку.
//
// Проверок пять, и каждая отвечает на свой вопрос. Порядок — от дешёвой к дорогой:
//
//  0. ЛИНТЕР (`no-undef` и ещё четыре ловушки, см. eslint.config.mjs в корне). Единственная
//     проверка здесь, которая видит НЕИСПОЛНЕННЫЕ ветки: обращение к тому, чего нет, она
//     находит статически и целиком. Шаги ниже видят только то, что исполнилось.
//  1. СИНТАКСИС (`node --check`). Ловит опечатку, не ловит ничего больше.
//  2. СВЯЗЫВАНИЕ МОДУЛЕЙ. Каждый модуль импортируется в отдельном процессе. ESM
//     проверяет имена импортов при связывании, то есть ДО исполнения: импорт функции,
//     которой в `lib/firm.mjs` нет, падает здесь, а не на третьей стадии сборки у
//     человека. Я привёз такое сегодня дважды (`eventsDirOf` вместо `eventsDir`,
//     забытый `homedir`).
//  3. ЗАПУСК БЕЗ АРГУМЕНТОВ. Каждый CLI должен печатать подсказку и выходить чисто.
//     Ловит падения на верхнем уровне модуля.
//  3а. ТЕСТЫ НА ИНВАРИАНТЫ (`firm2/tests/*.test.mjs`). Прогон ниже проверяет, что движок
//     работает; тесты — что он работает ВЕРНО, по инвариантам И-1…И-12 доменной модели.
//  4. ПРОГОН ПО СИНТЕТИЧЕСКОМУ ПРОЕКТУ. Одноразовый git-репозиторий с поставкой, двумя
//     задачами и настоящим слиянием через конфликт; по нему гоняются те же команды, что
//     у людей. Это ловит класс «константу удалил, а обращение осталось» — такое видно
//     только исполнением (сегодняшний `devGroup is not defined`). Здесь же проверяются и
//     инварианты журнала: в репозиторий подкладывается ложное «влито», и `doctor`
//     ОБЯЗАН вернуть `ok: false` — иначе рубеж, поставленный ради них, молча сломан.
//
// Линтер стоит шагом 0, а не вместо шагов 2–4: связывание модулей и исполнение проверяют
// другое, и ни одна из трёх проверок не заменяет остальные. Если `node_modules` нет (а в
// проекте, который читает движок по `engine_root`, их и не будет), шаг честно помечается
// пропущенным — и видно, что проверка не выполнялась, а не что она прошла.
//
//   node scripts/preflight.mjs           # человеку
//   node scripts/preflight.mjs --json    # машине
//
// Код возврата 1 — что-то не прошло. Этим и держится `bump-version.mjs`: версия не
// поднимается, пока рубеж не пройден, то есть недоделанная правка физически не может
// уехать в проекты.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolesTable } from './lib/roles.mjs'
// Разбор границ зовётся напрямую: шаг 3ш проверяет СВОЙСТВО разбора на живой форме, а
// подкладывать под это одноразовый проект с git-деревом незачем — дифф тут не нужен.
import { declaredFrozen } from './lib/firm.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const engine = join(here, '..')
const json = process.argv.includes('--json')
const fails = []
const steps = []

function note(step, ok, detail = '') {
  steps.push({ step, ok, detail })
  if (!ok) fails.push(`${step}: ${detail}`)
  if (!json) process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${step}${ok || !detail ? '' : ` — ${detail}`}\n`)
}

// Скрипты и workflow проверяются по-разному, и это не придирка. Скрипты — модули ESM:
// их можно импортировать, и связывание проверит имена импортов. Workflow модулем НЕ
// является: рантайм оборачивает его тело в функцию и исполняет, поэтому там законен
// `return` на верхнем уровне и доступны глобальные `agent`, `parallel`, `phase`, которых
// вне рантайма нет. Импортировать его — значит получить `SyntaxError: Illegal return
// statement` на ровном месте. `node --check` для `.js` разбирает файл той же моделью, что
// и рантайм, и это ровно та проверка, которая для workflow возможна.
function scripts() {
  const out = []
  for (const dir of [join(engine, 'scripts'), join(engine, 'scripts', 'lib')]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.mjs')) out.push(join(dir, f))
  }
  return out
}

function workflows() {
  return readdirSync(join(engine, 'workflows'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(engine, 'workflows', f))
}

// stdin закрыт намеренно, и это не мелочь: часть скриптов — hook-и, они читают полезную
// нагрузку со стандартного входа. Запущенные без аргументов и с открытым stdin они честно
// ждут ввода, и рубеж вместо проверки превращался в двухминутное ожидание на каждом
// таком файле. Таймаут по той же причине короткий: зависший шаг должен падать быстро,
// иначе медленную проверку начнут обходить, а обойдённая проверка не защищает ни от чего.
function run(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  })
}

// Падение видно не только по коду возврата: скрипт может поймать ошибку, напечатать её и
// выйти нулём. Поэтому стек в выводе — тоже провал.
const TRACE = /\b(ReferenceError|TypeError|SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export|Cannot find)\b/

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''
}

// ── 0. Линтер ────────────────────────────────────────────────────────────────
const eslintBin = join(engine, '..', 'node_modules', '.bin', 'eslint')
if (existsSync(eslintBin)) {
  const r = run([eslintBin, 'firm2'], { cwd: join(engine, '..'), timeout: 120000 })
  note('линтер', r.status === 0, firstLine(r.stdout) || firstLine(r.stderr) || `код ${r.status}`)
  if (r.status !== 0 && !json) process.stdout.write(`${r.stdout || ''}${r.stderr || ''}`)
} else {
  note('линтер — ПРОПУЩЕН (нет node_modules; в корне репозитория: npm i)', true)
}

// ── 0а. Подключён ли хук pre-commit ──────────────────────────────────────────
// Сам линтер стоит ещё и хуком (`.githooks/pre-commit`), чтобы коммит с обращением к
// тому, чего нет, не уезжал в проекты через `scripts/` — там версии нет, и правка
// доезжает мгновенно. Но `core.hooksPath` — локальная настройка: в файлах репозитория её
// нет, и в свежем клоне хука не будет. Поэтому шаг не валит рубеж, а сообщает: клон без
// хука не сломан, он просто без шлюза.
{
  let path = ''
  try {
    path = execFileSync('git', ['-C', join(engine, '..'), 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    path = ''
  }
  note(
    path === '.githooks'
      ? 'хук pre-commit подключён'
      : 'хук pre-commit НЕ подключён — один раз: git config core.hooksPath .githooks',
    true,
  )
}

// ── 1. Синтаксис ─────────────────────────────────────────────────────────────
for (const m of [...scripts(), ...workflows()]) {
  const r = run(['node', '--check', m])
  note(`синтаксис ${m.slice(engine.length + 1)}`, r.status === 0, firstLine(r.stderr))
}

// ── 2. Связывание модулей ────────────────────────────────────────────────────
// Импортируется ТОЛЬКО lib/: это чистые модули без побочных действий. CLI-скрипты
// импортировать нельзя, и я это проверил на себе дважды за один заход.
//
// Первое: импорт модуля — это его ИСПОЛНЕНИЕ. `bump-version.mjs` при импорте делает
// ровно то, для чего написан, — поднимает версию. Рубеж, проверяя движок, накрутил версию
// до 0.4.2058. Второе: `preflight.mjs` в том же списке запускал сам себя, и проверка
// уходила в рекурсию вместо проверки.
//
// Связывание CLI-скриптов при этом не пропущено: ESM сверяет имена импортов ДО
// исполнения, поэтому шаг 3 (запуск без аргументов) проверяет его заодно — несуществующий
// импорт там падает с `does not provide an export`, не дойдя до первой строки main.
for (const m of scripts().filter((f) => f.includes(`${sep}lib${sep}`))) {
  const r = run(['node', '--input-type=module', '-e', `await import(${JSON.stringify(m)})`])
  note(`импорт ${m.slice(engine.length + 1)}`, !TRACE.test(r.stderr || ''), firstLine(r.stderr))
}

// ── 3. Запуск CLI без аргументов ─────────────────────────────────────────────
// Список задан перечислением, а не обходом каталога, и это защита от предыдущего абзаца:
// новый скрипт попадёт сюда, только когда его сюда ОСОЗНАННО добавят, посмотрев, что он
// делает без аргументов. `bump-version.mjs` и `preflight.mjs` здесь быть не могут никогда.
for (const cli of ['firm-event.mjs', 'firm-state.mjs', 'dashboard.mjs', 'engine-root.mjs', 'firm-permissions.mjs', 'roles.mjs', 'stage-bill.mjs', 'suite-run.mjs', 'task-merge.mjs']) {
  const r = run(['node', join(engine, 'scripts', cli)])
  const out = `${r.stdout || ''}${r.stderr || ''}`
  note(`подсказка ${cli}`, !TRACE.test(out) && r.status !== null, firstLine(r.stderr))
}

// ── 3б. Хуки объявлены и существуют ──────────────────────────────────────────
// Хук — это ЕДИНСТВЕННАЯ защита, про которую нельзя узнать из прогона: рантайм зовёт его
// сам, и объявление с опечаткой в пути просто не срабатывает. Молча. Поэтому сверяем
// каждое объявление в hooks.json с файлом на диске и с его исполняемостью: защита,
// которой нет, хуже отсутствующей — на неё рассчитывают.
{
  let hooks = null
  try {
    hooks = JSON.parse(readFileSync(join(engine, 'hooks', 'hooks.json'), 'utf8')).hooks
  } catch (e) {
    note('hooks.json читается', false, String(e.message || e))
  }
  for (const [event, list] of Object.entries(hooks || {})) {
    for (const m of list || []) {
      for (const h of m.hooks || []) {
        const cmd = String(h.command || '')
        const rel = cmd.replace('${CLAUDE_PLUGIN_ROOT}/', '').split(/\s+/)[0]
        const abs = join(engine, rel)
        let ok = existsSync(abs)
        if (ok) {
          try {
            ok = Boolean(statSync(abs).mode & 0o111)
          } catch {
            ok = false
          }
        }
        note(`хук ${event}(${m.matcher || '*'}) → ${rel}`, ok, ok ? '' : `нет файла или не исполняемый: ${abs}`)
      }
    }
  }
}

// ── 3в. Адаптеры приёмов целят в существующие скилы ──────────────────────────
// Тот же класс, что шаг 3б, и поставлен по той же причине. Приём-адаптер — это SKILL.md,
// который говорит «вызови Skill tool со скиллом `<плагин>:<имя>`». Если имени нет, узнать
// об этом можно ровно одним способом: дойти в живом прогоне до стадии, которая его зовёт.
//
// Поставлено 09.10.2026, после находки: `firm-verify` всё время целил в
// `mattpocock-skills:verify`, которого у Мэтта не было НИКОГДА (ноль коммитов по пути в
// его репозитории). Адаптер лежал с первого коммита маркетплейса и не сработал ни разу —
// его зовёт только MR-ревью поставки, «если уместно», а до выдачи маршрут не доходил.
// Внешний набор живёт своей жизнью: в 1.3 у Мэтта исчез `resolving-merge-conflicts`,
// появились `implement-spec`, `pr`, `retro`. Переименование на той стороне — штатное
// событие, и ловить его должен рубеж, а не прогон за пять миллионов токенов.
//
// Проверка намеренно управляется данными, а не списком: имена берутся из самих SKILL.md,
// набор установленных скилов — из манифестов в кэше плагинов. Добавил адаптер — он
// проверяется сам, править рубеж не нужно.
//
// Плагина нет на машине (CI, чужой компьютер, движок читается по `engine_root`) — шаг
// честно ПРОПУЩЕН, а не пройден: видно, что проверка не выполнялась. Это правило всего
// рубежа, см. линтер без `node_modules`.
{
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

  // Установленные плагины: имя → множество имён скилов. Источник путей —
  // `installed_plugins.json`, то есть РОВНО те версии, которые грузит рантайм. Обходить
  // кэш целиком нельзя, и это проверено на первом же прогоне: снятая версия 1.2.3
  // осталась в кэше рядом с 1.3.1, объединение дало `resolving-merge-conflicts`, которого
  // в 1.3.1 уже нет, — то есть проверка молча прощала бы ровно то переименование, ради
  // которого поставлена. Кэш как источник годится только на то, чтобы НЕ найти плагин.
  const installed = new Map()
  const addSkill = (plugin, name) => {
    if (!installed.has(plugin)) installed.set(plugin, new Set())
    installed.get(plugin).add(name)
  }
  const dirs = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
  }
  // Запись в installed_plugins.json: "<плагин>@<маркетплейс>": [{ installPath, … }].
  // Один плагин может стоять в двух областях (user и project) — тогда путей несколько.
  const roots = []
  try {
    const reg = JSON.parse(readFileSync(join(cfgDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    for (const [id, entries] of Object.entries(reg.plugins || {})) {
      for (const e of entries || []) {
        if (e && e.installPath) roots.push([id.split('@')[0], e.installPath])
      }
    }
  } catch {
    // Реестра нет (чистая машина, CI) — список останется пустым, и каждая ссылка ниже
    // честно пометится пропущенной.
  }
  for (const [plugin, root] of roots) {
    // Манифест — источник истины: он перечисляет пути скилов, и они могут лежать в
    // разных подкаталогах (у Мэтта это skills/engineering и skills/productivity —
    // обход одного каталога половины набора не увидит).
    let listed = null
    try {
      listed = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).skills
    } catch { /* манифеста нет или битый — ниже обход каталогов */ }
    if (Array.isArray(listed)) {
      for (const s of listed) {
        const name = String(s).replace(/\/+$/, '').split('/').pop()
        if (existsSync(join(root, String(s), 'SKILL.md'))) addSkill(plugin, name)
      }
      continue
    }
    // Манифест без `skills` — скилы подхватываются по раскладке каталогов, и вложенность
    // бывает обеих глубин: skills/<имя>/SKILL.md и skills/<группа>/<имя>/SKILL.md.
    for (const group of dirs(join(root, 'skills'))) {
      if (existsSync(join(root, 'skills', group, 'SKILL.md'))) addSkill(plugin, group)
      for (const name of dirs(join(root, 'skills', group))) {
        if (existsSync(join(root, 'skills', group, name, 'SKILL.md'))) addSkill(plugin, name)
      }
    }
  }

  // Ссылки из адаптеров. Ищется ЗАЯВЛЕНИЕ О ДЕЛЕГИРОВАНИИ, а не любое упоминание имени, и
  // это тоже проверено на себе: первая редакция падала на абзаце в `firm-verify`, который
  // рассказывает ИСТОРИЮ про несуществовавший `mattpocock-skills:verify`. Запрещать такие
  // абзацы — ровно наоборот тому, зачем они написаны: без них правка выглядит
  // немотивированной и приём снова станет адаптером в никуда.
  //
  // Поэтому строка берётся в расчёт, если на ней есть одно из двух: вызов («Skill tool»)
  // или объявление зависимости («Адаптер поверх») — соглашение, по которому написаны все
  // адаптеры движка, проверено по всем девяти SKILL.md. Строка `description:` во
  // frontmatter считается объявлением наравне: там зависимость названа для человека.
  const refs = new Map()
  const skillsDir = join(engine, 'skills')
  const DECLARES = /Skill tool|[Аа]даптер поверх|^description:/
  for (const name of dirs(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!DECLARES.test(line)) continue
      for (const m of line.matchAll(/\b([a-z][a-z0-9-]*-skills)\s*:\s*([a-z][a-z0-9-]*)\b/g)) {
        if (m[1] === 'firm2') continue
        const key = `${m[1]}:${m[2]}`
        if (!refs.has(key)) refs.set(key, new Set())
        refs.get(key).add(name)
      }
    }
  }

  if (refs.size === 0) {
    note('адаптеры приёмов — ПРОПУЩЕНО (ни один не ссылается на внешний скил)', true)
  }
  for (const [ref, users] of [...refs.entries()].sort()) {
    const [plugin, skill] = ref.split(':')
    const have = installed.get(plugin)
    const who = [...users].sort().join(', ')
    if (!have) {
      note(`приём ${who} → ${ref} — ПРОПУЩЕНО (плагин ${plugin} не установлен)`, true)
      continue
    }
    note(`приём ${who} → ${ref}`, have.has(skill), have.has(skill) ? '' : `нет такого скила; у плагина есть: ${[...have].sort().join(', ')}`)
  }
}

// ── 3г. Перекрёстные ссылки разрешаются ──────────────────────────────────────
// Поставлено 09.10.2026 по итогам ретро. Повод: «точка изоляции зависимости — см. блупринт
// §10» вела в документ сессии `проект-Д`, которого в этом репозитории нет и никогда не
// было, — и прожила так год в шести файлах. Вторая такая же нашлась тем же разбором:
// «снимок иммутабелен (замысел §11)», тогда как §11 замысла — это «Конфигурация», а про
// иммутабельность архива написано в приёме `firm-docs`.
//
// Корень не в опечатках, а в конвенции: `§N` означал три разных вещи — раздел замысла,
// раздел ТОГО ЖЕ файла и шаг другой команды. При такой неоднозначности мёртвая ссылка не
// читается как мёртвая: она читается как «надо открыть какой-то документ».
//
// Отсюда правило, которое можно проверить машинно: **у ссылки обязан быть якорь**. На той
// же строке либо имя файла (`firm2-design.md §6`), либо явное «этого документа» / «этой
// команды». Голый `§N` — провал.
//
// CHANGELOG исключён намеренно: это журнал, его записи описывают состояние на свою дату, и
// переписывать их задним числом — то же, что править журнал событий (ADR-0006). Ссылки в
// старых записях остаются как были.
{
  const mdFiles = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.codegraph' || e.name === '.git') continue
        walk(p)
      } else if (e.name.endsWith('.md') && e.name !== 'CHANGELOG.md') {
        mdFiles.push(p)
      }
    }
  }
  walk(engine)

  const ANCHOR = /\.md|этого документа|этой команды|этого приёма/
  const dangling = []
  const adrRefs = new Map()
  for (const file of mdFiles) {
    const rel = file.slice(engine.length + 1)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes('§') && !ANCHOR.test(line)) dangling.push(`${rel}:${i + 1}`)
      for (const m of line.matchAll(/\bADR-(\d{4})\b/g)) {
        if (!adrRefs.has(m[1])) adrRefs.set(m[1], `${rel}:${i + 1}`)
      }
    })
  }
  note(
    `ссылки на разделы с якорем (${mdFiles.length} документов)`,
    dangling.length === 0,
    dangling.length ? `без якоря: ${dangling.join(', ')}` : '',
  )

  // Комментарии кода — тот же класс ссылок, но здесь ПОКАЗЫВАЕМ, а не запрещаем, и это
  // осознанно. На 09.10.2026 их 41, и каждая требует решения, в какой документ она должна
  // вести: «раздел 3 команды» не говорит, какой именно команды, а `lib/firm.mjs:1`
  // ссылается на «раздел 7 замысла» про отсутствие внешних зависимостей, тогда как это
  // ADR-0010, то
  // есть похоже на ещё одну мёртвую ссылку. Разбор этих сорока одной — отдельный заход;
  // пока число на виду, чтобы оно не росло незаметно.
  // Сам рубеж из подсчёта исключён: он объясняет правило и неизбежно цитирует примеры
  // мёртвых ссылок — иначе счётчик считал бы собственную документацию.
  const codeDangling = []
  for (const file of [...scripts(), ...workflows()].filter((f) => !f.endsWith('preflight.mjs'))) {
    const rel = file.slice(engine.length + 1)
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('§') && !ANCHOR.test(line)) codeDangling.push(`${rel}:${i + 1}`)
      for (const g of line.matchAll(/\bADR-(\d{4})\b/g)) {
        if (!adrRefs.has(g[1])) adrRefs.set(g[1], `${rel}:${i + 1}`)
      }
    })
  }
  note(`ссылки на разделы в комментариях кода без якоря: ${codeDangling.length} (не запрет, см. комментарий)`, true)

  let adrDir = []
  try {
    adrDir = readdirSync(join(engine, 'docs', 'adr'))
  } catch { /* каталога нет — ниже каждая ссылка станет провалом, и это верно */ }
  const missing = [...adrRefs.entries()]
    .filter(([num]) => !adrDir.some((f) => f.startsWith(`${num}-`)))
    .map(([num, where]) => `ADR-${num} (${where})`)
  note(
    `ссылки на ADR разрешаются (${adrRefs.size} решений)`,
    missing.length === 0,
    missing.length ? `нет файла: ${missing.join(', ')}` : '',
  )
}

// ── 3д. Сколько приёмов зовётся кодом ────────────────────────────────────────
// Не запрет, а счётчик на видном месте — по итогам того же ретро. Приём, который зовут
// только текстом промпта, вызывается на усмотрение агента, и его немоту замечают не
// проверки, а отсутствие результата через несколько поставок (так прожил `firm-verify`,
// CHANGELOG 0.4.67). Порога здесь нет намеренно: какой приём обязан иметь объективный
// триггер — решение предметное, а не арифметическое (ADR-0011, «Чего это решение НЕ
// закрывает»). Шаг держит соотношение на виду, чтобы оно не ухудшалось тихо.
{
  const names = readdirSync(join(engine, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  let code = ''
  for (const w of workflows()) code += readFileSync(w, 'utf8')
  // Имя целиком, а не подстрокой: первая редакция считала `firm-review` вызванным, потому
  // что строка `firm2:firm-reviewer-qa` его содержит, и показывала «2 из 9» вместо одного.
  // Счётчик, который завышает, хуже отсутствующего: он сообщает, что всё налаживается.
  const byCode = names.filter((n) => new RegExp(`\\b${n}\\b`).test(code))
  note(
    `приёмов с вызовом по коду: ${byCode.length} из ${names.length}` +
      (byCode.length ? ` (${byCode.join(', ')})` : ''),
    true,
  )
}

// ── 3е. Два правила рантайма, которые раньше держались абзацем в CLAUDE.md ────
// Оба — известные дефекты движка Claude Code, обойдённые в `firm2-build.js`, и оба
// проверяются регуляркой. До 09.10.2026 они жили только текстом («Правила работы в этом
// репозитории»), то есть надеялись на память агента, который правит workflow.
//
//  — КЛЮЧИ СХЕМ ТОЛЬКО ASCII. Кириллица в ключе `properties` даёт 400 от Anthropic API,
//    и не при разборе файла, а на первом же вызове роли с этой схемой — то есть посреди
//    прогона, после того как человек ушёл от экрана. Значения `enum` кириллицей законны:
//    их модель возвращает, а не называет ими поля.
//  — `agentType` ТРЕБУЕТ ПРЕФИКСА ПЛАГИНА. `firm-developer` без `firm2:` рантайм не
//    находит; стадия не запускается, события нет, задача молча стоит.
//
// Проверка идёт по схемам и по карте ролей, а не по списку имён: добавил схему — она
// проверяется сама.
{
  const nonAscii = /[^ -~]/
  // Ключ в литерале объекта: начало строки или `{`/`,` перед ним, двоеточие после. Имя
  // ключа задано через исключение, а не перечислением разрешённых букв: ключ `принято:` —
  // законный идентификатор JS, и искать надо ИМЕННО его, иначе проверка не увидит ровно
  // того, за чем ставилась.
  const KEY = /(?:^|[{,])\s*(?:(['"])([^'"]+)\1|([^\s:'"{}[\],()]+))\s*:/g
  const badKeys = []
  const badAgents = []

  for (const file of workflows()) {
    const rel = file.slice(engine.length + 1)
    const src = readFileSync(file, 'utf8')
    // Комментарии снимаются построчно: они сплошь по-русски и сплошь с двоеточиями, и без
    // этого шага каждая вторая строка пояснения читалась бы как ключ с кириллицей.
    const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, ''))

    // Схемы ищутся по форме объявления, а не по списку: `const X_SCHEMA = {` и до парной
    // закрывающей скобки. Счёт скобок грубый (строку с `{` внутри кавычек он спутает), но
    // ошибка здесь расширяет область проверки, а не сужает, — то есть безопасна.
    for (let i = 0; i < code.length; i++) {
      if (!/^const\s+[A-Z][A-Z0-9_]*\s*=\s*\{/.test(code[i])) continue
      let depth = 0
      for (let j = i; j < code.length; j++) {
        depth += (code[j].match(/\{/g) || []).length - (code[j].match(/\}/g) || []).length
        for (const m of code[j].matchAll(KEY)) {
          const key = m[2] || m[3]
          if (nonAscii.test(key)) badKeys.push(`${rel}:${j + 1} ключ «${key}»`)
        }
        if (depth <= 0) {
          i = j
          break
        }
      }
    }

    // `agentType` приходит двумя путями: литералом и ссылкой в карту ролей (`A.developer`).
    // Карта разбирается по имени из самой ссылки — чтобы проверка не знала, что она зовётся
    // `A`, и не ослепла при переименовании.
    const maps = new Map()
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^}]*)\}/g)) {
      const pairs = new Map()
      for (const p of m[2].matchAll(/([\w$]+)\s*:\s*'([^']*)'/g)) pairs.set(p[1], p[2])
      maps.set(m[1], pairs)
    }
    code.forEach((line, n) => {
      for (const m of line.matchAll(/agentType:\s*(?:'([^']*)'|([A-Za-z_$][\w$]*)\.([\w$]+))/g)) {
        const where = `${rel}:${n + 1}`
        if (m[1] !== undefined) {
          if (!m[1].startsWith('firm2:')) badAgents.push(`${where} литерал «${m[1]}»`)
          continue
        }
        const value = maps.get(m[2])?.get(m[3])
        if (value === undefined) badAgents.push(`${where} ${m[2]}.${m[3]} — не нашёл в карте ролей`)
        else if (!value.startsWith('firm2:')) badAgents.push(`${where} ${m[2]}.${m[3]} = «${value}»`)
      }
    })
  }

  note(
    'ключи схем workflow — только ASCII',
    badKeys.length === 0,
    badKeys.length ? `${badKeys.join('; ')} — кириллица в ключе даёт 400 от API на первом вызове роли` : '',
  )
  note(
    'agentType с префиксом плагина',
    badAgents.length === 0,
    badAgents.length ? `${badAgents.join('; ')} — без префикса firm2: рантайм роль не находит` : '',
  )
}

// ── 3ж. Правила, которые живут только в промпте ───────────────────────────────
// Два правила браузерной стадии не проверяются ничем, кроме этого шага: они обращены к
// роли, а не к коду, то есть исполняются текстом промпта. Разбор проект-В 11.10.2026
// (Д-5, Д-6) показал, чем это кончается, когда правила нет: тридцать браузерных проверок
// написали тридцать копий стенда, каждая решала, где держать профиль Chrome, и один
// профиль оказался внутри репозитория — 296 файлов, 4,1 МБ в коммите соседней задачи.
//
// Проверка грубая — ищет упоминание по образцу, а не разбирает смысл. Этого хватает для
// того единственного, от чего она ставится: правило нельзя удалить, не заметив.
{
  const want = [
    { re: /\$TMPDIR/, what: 'артефакты прогона — только в $TMPDIR' },
    { re: /СТЕНД НЕ ПИШИ ЗАНОВО|общий (модуль|стенд)/i, what: 'готовый стенд использовать, новый не писать' },
  ]
  const missing = []
  for (const file of workflows()) {
    const src = readFileSync(file, 'utf8')
    // Правило нужно только там, где вообще есть браузерная метка.
    if (!src.includes('требует-браузера')) continue
    const rel = file.slice(engine.length + 1)
    for (const w of want) if (!w.re.test(src)) missing.push(`${rel}: нет правила «${w.what}»`)
  }
  note(
    'правила браузерной стадии на месте',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без него каждая проверка решает заново, где держать профиль браузера (Д-5/Д-6, 11.10.2026)` : '',
  )
}

// ── 3з. Правило формулировки критериев ────────────────────────────────────────
// Механическая находка `criteriaFindings` закрывает половину случая: дробное число с
// единицей в критерии без замера. Вторую половину — критерий, требующий замерить
// состояние, которое не наступает нигде, — не поймает никакая регулярка; её закрывает
// правило «на планировании мерить прогоном, а не считать», и живёт оно текстом в промптах.
// Поэтому текст проверяется так же, как правила браузерной стадии (шаг 3ж).
{
  const want = [
    { file: 'commands/firm-plan.md', re: /measured/, what: 'число в критерии только с measured' },
    { file: 'commands/firm-plan.md', re: /browser_harness/, what: 'стенд первой задачей, если его нет' },
    { file: 'agents/architect.md', re: /measured/, what: 'критерий свойством, а не числом' },
    { file: 'agents/designer.md', re: /прогоном, а не арифметикой|замеряй живым прогоном/i, what: 'замер прогоном, а не расчётом' },
  ]
  const missing = []
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет правила «${w.what}»`)
  }
  note(
    'правила проверяемости критериев на месте',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без них критерий снова станет числом из расчёта, а стадия встанет на нём (разбор поставки 3.1, 11.10.2026)` : '',
  )
}

// ── 3и. Рецепт браузера и запрет `add -A` в предписаниях ─────────────────────
// Два правила, за которыми стоят замеры, а не вкус, и оба живут текстом.
//
// Рецепт. 11.10.2026 замерено: системный Chrome под песочницей не поднимается ни в одном
// режиме `--headless` (`ProcessSingleton` требует unix-сокета, `bind()` запрещён), а
// `chrome-headless-shell --single-process` поднимается, и CDP через pipe работает целиком.
// Проект, упёршийся в эту стену, уже собирался открыть машину ключом `sandbox_off: allow`.
// Исчезни рецепт из текста — стена вернётся, а с ней и это предложение.
//
// Запрет `add -A`. Это Д-5: движок не пропустил мусор, он ВЕЛЕЛ его закоммитить, и роль
// исполнила предписание дословно — 296 файлов чужого профиля Chrome в коммите, где
// настоящих правок четыре. Хук предписание уже не даёт; промпты ролей давали его ещё
// после починки хука. Поэтому проверка смотрит на текст, а не на код: `add -A` допустим
// только как названный запрет.
{
  const want = [
    { file: 'scripts/bash-guard.mjs', re: /chrome-headless-shell/, what: 'рецепт браузера в отказе песочницы' },
    { file: 'workflows/firm2-build.js', re: /chrome-headless-shell[\s\S]{0,400}single-process/, what: 'рецепт браузера в промпте стадии' },
    { file: 'agents/tester.md', re: /chrome-headless-shell/, what: 'рецепт браузера у Тестировщика' },
    { file: 'workflows/firm2-build.js', re: /ARGS\.browser_binary/, what: 'путь бинаря из конфига в промпт' },
    { file: 'scripts/firm-state.mjs', re: /browser_binary/, what: 'путь бинаря в build-args' },
    // Д-8.2/8.4: планировщик обязан спрашивать состояние поставки по ходу прогона, иначе
    // задача, заведённая после старта, считается выполненной зависимостью, а влитая руками
    // навсегда остаётся вне `done`. Правило живёт в коде прогона, и его легко потерять при
    // правке планировщика — поэтому рубеж держит и вызов, и команду, которую он зовёт.
    { file: 'workflows/firm2-build.js', re: /settledState\(\)/, what: 'зонд состояния поставки в планировщике' },
    { file: 'scripts/firm-state.mjs', re: /case 'settled'/, what: 'команда settled, которую зовёт зонд' },
    { file: 'workflows/firm2-build.js', re: /recordMergeFailed/, what: 'запись merge/failed решением кода (Д-8.3)' },
    // Д-8.5: рабочие копии ради замера — в `$TMPDIR`. Правило адресовано тому, кто каталог
    // создаёт, и стоит в промптах трёх стадий сразу.
    { file: 'workflows/firm2-build.js', re: /РАБОЧИЕ КОПИИ И ЗАМЕРЫ/, what: 'копии и замеры в $TMPDIR' },
    { file: 'scripts/firm-state.mjs', re: /strayDirs/, what: 'чужие каталоги в worktrees_dir названы с размером' },
    { file: 'agents/tester.md', re: /требует-браузера[\s\S]{0,200}пропуск/i, what: 'пропуск не закрывает браузерный критерий' },
    { file: 'agents/tester.md', re: /Общая проверка вместо теста на задачу/, what: 'общая проверка вместо теста на задачу' },
    // Инвентарь: поле есть у трёх читателей сразу, и текст каждого — часть механизма.
    // Поставить поле некому, если о нём не сказано планированию; судить по нему некому,
    // если о нём не сказано надзору; а запрет «добирать грепом» живёт только в промптах
    // исполнителей — в коде такого запрета быть не может, это суждение о замысле.
    { file: 'commands/firm-plan.md', re: /inventory/, what: 'реквизит inventory назван планированию' },
    { file: 'agents/architect.md', re: /Квантор — над множеством/, what: 'правило квантора у Архитектора: он поле и ставит' },
    { file: 'agents/reviewer-qa.md', re: /против ИНВЕНТАРЯ/, what: 'надзор судит кванторный критерий против перечня, а не против впечатления' },
    { file: 'agents/developer.md', re: /Инвентарь задачи закрыт/, what: 'исполнитель знает, что перечень закрыт' },
    { file: 'agents/tester.md', re: /Инвентарь задачи закрыт/, what: 'то же Тестировщику: добирал перечень грепом каждый заход' },
    { file: 'templates/task.example.md', re: /inventory/, what: 'шаблон карточки знает про поле' },
    { file: 'templates/firm-config.example', re: /lanes:/, what: 'шаблон конфига знает про полосы' },
    // Короткая полоса. Держим не ускорение, а две страховки при нём: метку ставит
    // планирование (поэтому правило есть у Архитектора), а судит заявку КОД по настоящему
    // диффу (поэтому есть и зонд в прогоне, и команда, которую он зовёт). Исчезни вторая —
    // полоса станет четвёртым способом пройти проверку, не выполнив её.
    { file: 'workflows/firm2-build.js', re: /laneState\(task\)/, what: 'проверка короткой полосы в цикле задачи' },
    { file: 'scripts/firm-state.mjs', re: /case 'lane-check'/, what: 'команда lane-check, которую зовёт зонд полосы' },
    { file: 'scripts/lib/firm.mjs', re: /case 'guard\/short-lane'/, what: 'статус задачи, прошедшей короткой полосой' },
    { file: 'agents/architect.md', re: /короткая-полоса/, what: 'метку короткой полосы ставит планирование' },
    // Замер массы. Команда, которую никто не зовёт, не отвечает ни на один вопрос:
    // правило держит и саму команду, и единственное место, где её читают, — планирование.
    { file: 'scripts/firm-state.mjs', re: /case 'mass'/, what: 'команда mass' },
    // Послабление для файлов вне путей держится на том, что добавленных строк там ноль.
    // Исчезни эта проверка — полосой поедет любая правка компонента, и метка станет
    // единственным судьёй, против которого всё правило и строилось.
    { file: 'scripts/lib/firm.mjs', re: /deletions_only/, what: 'вне путей допускаются только удаления' },
    { file: 'commands/firm-plan.md', re: /firm-state\.mjs" mass/, what: 'замер массы на планировании' },
  ]
  const missing = []
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет правила «${w.what}»`)
  }
  // `add -A` в предписаниях. Строка проходит, только если в ней же назван запрет:
  // объяснение «`add -A` не использовать, потому что…» — это и есть нужный текст.
  const prescribed = []
  for (const dir of ['agents', 'commands', 'workflows', 'skills']) {
    const base = join(engine, dir)
    if (!existsSync(base)) continue
    for (const f of readdirSync(base, { recursive: true })) {
      const path = join(base, String(f))
      if (!/\.(md|js|mjs)$/.test(String(f)) || !existsSync(path) || statSync(path).isDirectory()) continue
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.includes('add -A')) continue
        if (/не использовать|а не \\?`?add -A|НЕ использовать/i.test(line)) continue
        prescribed.push(`${dir}/${f}: ${line.trim().slice(0, 70)}`)
      }
    }
  }
  if (prescribed.length) missing.push(`предписан \`add -A\`: ${prescribed.join(' | ')}`)
  note(
    'рецепт браузера на месте, `add -A` не предписан',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — замеры 11.10.2026: Д-5 (4,1 МБ чужого профиля в коммите) и стена песочницы перед браузером` : '',
  )
}

// ── 3к. Вход оси Standards и ось безопасности ────────────────────────────────
// Поставлено 15.10.2026 вместе с самими стандартами, и поставлено по той же логике, что
// шаг 3в: тот сверяет, что адаптер целит в существующий скил, а этот — что у скила есть
// ВХОД. Разбор ECC (`docs/ecc-ingest.md`, пункт 1) нашёл ровно эту дыру: приём
// `firm-review` годами судил по оси «documented coding standards», а документа движок
// никуда не раскладывал — половина каждого вердикта держалась на том, что роль придумает.
//
// Проверка текстовая, как 3ж–3и: правила обращены к ролям, то есть исполняются промптом.
// Её задача одна — шаблон стандартов и метку безопасности нельзя удалить, не заметив.
{
  const want = [
    { file: 'templates/standards/common.md', re: /^---\npaths:/, what: 'общая часть стандартов с frontmatter paths' },
    { file: 'templates/standards/common.md', re: /чувствительный-к-безопасности/, what: 'триггеры безопасности и метка' },
    { file: 'commands/firm-setup.md', re: /templates\/standards\/common\.md/, what: 'шаг, раскладывающий стандарты в проект' },
    { file: 'commands/firm-setup.md', re: /templates\/standards\/ui\.md/, what: 'шаг кладёт и стандарты интерфейса' },
    { file: 'templates/standards/ui.md', re: /^---\npaths:/, what: 'стандарты интерфейса с frontmatter paths' },
    { file: 'templates/standards/ui.md', re: /Половина правила/, what: 'половинные правила названы половинами (иначе ось судит там, где значения в правке нет)' },
    { file: 'templates/standards/ui.md', re: /Чего в этом файле нет намеренно/, what: 'раздел отказов: без него вкусовые правила вернутся молча' },
    { file: 'skills/firm-review/SKILL.md', re: /docs\/standards/, what: 'ось Standards названа файлом' },
    { file: 'skills/firm-review/SKILL.md', re: /непровере/i, what: 'нет стандартов — ось объявляется непроверенной' },
    { file: 'agents/reviewer-qa.md', re: /docs\/standards/, what: 'Ревьюер судит ось Standards по файлу' },
    { file: 'agents/architect.md', re: /чувствительный-к-безопасности/, what: 'метку безопасности ставит планирование' },
    { file: 'workflows/firm2-build.js', re: /SECURITY_LABEL/, what: 'метка безопасности поднимает панель' },
    { file: 'templates/definition-of-done.md', re: /secret-scan/, what: 'секреты в DoD' },
    // Отбор по `paths`, поставлен 21.10.2026 по разбору стадии Ревьюера. До него frontmatter
    // стандартов не читал НИКТО: `ui.md` уезжал в проекты и в ось не попадал вовсе, потому
    // что Ревьюеру было сказано «common.md плюс файл ЯЗЫКА», а кладётся `ui.md` по признаку
    // «есть экраны». Объявление, которое никто не читает, — это не норма, а украшение.
    { file: 'scripts/lib/firm.mjs', re: /export function standardsFor\b/, what: 'отбор стандартов по paths против файлов правки' },
    { file: 'scripts/firm-state.mjs', re: /case 'standards'/, what: 'команда standards' },
    { file: 'agents/reviewer-qa.md', re: /standards --ticket/, what: 'Ревьюер спрашивает, какие стандарты относятся к правке' },
    { file: 'agents/developer.md', re: /standards --ticket/, what: 'Разработчик читает нормы ДО кода (common.md обещает именно это)' },
    { file: 'agents/tester.md', re: /standards --ticket/, what: 'Тестировщик читает нормы по тестам' },
    { file: 'agents/reviewer-qa.md', re: /§8 \*\*файла проекта\*\*/, what: 'ось безопасности судит по файлу ПРОЕКТА, а не по шаблону движка' },
  ]
  const missing = []
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет «${w.what}»`)
  }
  // Метка без механики — украшение. Проверяем, что она действительно делает задачу
  // рискованной (панель), а не только упомянута константой.
  const build = readFileSync(join(engine, 'workflows', 'firm2-build.js'), 'utf8')
  if (!/const risky =[\s\S]{0,200}SECURITY_LABEL/.test(build)) {
    missing.push('workflows/firm2-build.js: метка безопасности не входит в `risky` — панель не соберётся')
  }
  if (!/laneState[\s\S]{0,900}SECURITY_LABEL/.test(build)) {
    missing.push('workflows/firm2-build.js: короткая полоса не отменяется меткой безопасности — панель обходится второй меткой')
  }
  // Отбор, который сличает пути своим способом, разойдётся с короткой полосой в том, что
  // считается совпадением, и спорить будут два разных ответа на один вопрос.
  const libsrc = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  if (!/standardsFor[\s\S]{0,1800}laneAllows\(paths, f\)/.test(libsrc)) {
    missing.push('scripts/lib/firm.mjs: отбор стандартов сличает пути не через laneAllows — два сопоставления разойдутся')
  }
  if (!/STANDARDS_ALWAYS/.test(libsrc)) {
    missing.push('scripts/lib/firm.mjs: общая часть не объявлена всегда применимой — отбор сможет отвести common.md')
  }
  note(
    'стандарты кода и ось безопасности на месте',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без этого ось Standards код-ревью снова останется с пустым входом (разбор ECC 14.10.2026, пункт 1)` : '',
  )
}

// ── 3л. Расписка о ревью привязана к отпечатку дерева ────────────────────────
// И-13 держится не одним местом, а четырьмя, и каждое по отдельности выглядит
// необязательным: штемпель отпечатка в событии, гвард на слиянии, его регистрация в
// hooks.json и проверка `doctor` задним числом. Убери любое — механизм перестаёт работать
// МОЛЧА: события пишутся, гвард не срабатывает, `doctor` отвечает `ok`. Шаг проверяет, что
// все четыре на месте и связаны (ADR-0013).
{
  const missing = []
  const want = [
    { file: 'scripts/lib/firm.mjs', re: /export function taskTree/, what: 'отпечаток дерева задачи' },
    { file: 'scripts/lib/firm.mjs', re: /export function acceptedReceipt/, what: 'чтение расписки о принятии' },
    { file: 'scripts/review-receipt.mjs', re: /FIRM2_STALE_REVIEW/, what: 'именованный выход для человека (ADR-0009)' },
    { file: 'hooks/hooks.json', re: /review-receipt\.sh/, what: 'гвард зарегистрирован на PreToolUse(Bash)' },
    { file: 'docs/domain-model.md', re: /\*\*И-13\*\*/, what: 'инвариант И-13 назван в доменной модели' },
    { file: 'docs/adr/0013-вердикт-привязан-к-отпечатку-дерева.md', re: /Статус: принято/, what: 'ADR-0013' },
  ]
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет «${w.what}»`)
  }
  // Штемпель без сверки — украшение; сверка без штемпеля молчит всегда. Проверяем обе
  // стороны связи в одном файле событий.
  const evsrc = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  if (!/\['review', 'adjudicate'\]\.includes\(stage\)[\s\S]{0,200}taskTree/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: вердикт ревью не стемпливает отпечаток — сверять будет нечего')
  }
  if (!/stale_receipts: staleReceiptsFound/.test(evsrc) || !/staleReceiptsFound\.length === 0/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: находка И-13 не выведена в doctor или не влияет на ok')
  }
  note(
    'расписка о ревью привязана к отпечатку дерева (И-13)',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без этого в поставку уедет содержимое, которого надзор не видел, и будет числиться принятым (ADR-0013)` : '',
  )
}

// ── 3м. Расписка об отправке наружу ──────────────────────────────────────────
// Тот же довод, что у 3л: механизм собран из частей, каждая из которых по отдельности
// выглядит необязательной, а без любой он перестаёт работать МОЛЧА — расписки не пишутся
// или пишутся без цепочки, и `doctor` отвечает `ok`. Проверяется ещё и граница ADR-0014:
// расписка не гвард, exit в обёртке обязан быть нулевым всегда.
{
  const missing = []
  const want = [
    { file: 'scripts/lib/firm.mjs', re: /export function receiptDigest/, what: 'канон digest расписки' },
    { file: 'scripts/egress.mjs', re: /prevOf/, what: 'цепочка по задаче' },
    { file: 'scripts/egress.mjs', re: /redact\(cmd\)/, what: 'команда в журнал идёт срезанной (иначе расписка — второе место, где лежит ключ)' },
    { file: 'hooks/hooks.json', re: /egress\.sh/, what: 'расписка зарегистрирована на PreToolUse' },
    { file: 'hooks/hooks.json', re: /WebFetch\|WebSearch/, what: 'путь наружу мимо песочницы и git тоже под учётом' },
    { file: 'docs/domain-model.md', re: /\*\*И-14\*\*/, what: 'инвариант И-14 назван в доменной модели' },
    { file: 'docs/adr/0014-расписка-об-отправке-наружу.md', re: /Статус: принято/, what: 'ADR-0014' },
  ]
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет «${w.what}»`)
  }
  const sh = existsSync(join(engine, 'hooks', 'egress.sh')) ? readFileSync(join(engine, 'hooks', 'egress.sh'), 'utf8') : ''
  if (!/\nexit 0\n?$/.test(sh)) {
    missing.push('hooks/egress.sh: обёртка отдаёт код расписки наружу — учёт стал бы гвардом и держал бы отправку (ADR-0014)')
  }
  const evsrc = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  if (!/egress_chain: egressFindings/.test(evsrc) || !/egressFindings\.length === 0/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: разрыв цепочки расписок не выведен в doctor или не влияет на ok')
  }
  // Развилка цепочки — НЕ разрыв, и это отдельный пункт: линейность внутри задачи `MR`
  // реальностью не исполняется (все параллельные деревья и обе живые линии пишут ей
  // расписки). Замер проект-В 05.11.2026: 120 расписок `MR`, развилок 4, ссылок в пустоту
  // ноль — то есть четыре находки сверки были ложными, и снять их нечем (журнал
  // неизменяем). Доказывает цепочка достижимость, а не порядок.
  if (!/egress_forks: egressForks/.test(evsrc) || !/параллельная запись, не разрыв/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: развилка цепочки расписок снова считается разрывом — на параллельной записи doctor краснеет навсегда')
  }
  // Две находки проект-В 05.11.2026 той же формы: сверка краснеет НАВСЕГДА, а снять нечем.
  //   1. сторожевое событие без привязки уходило `unknown` (И-7 — дыра привязки), хотя для
  //      расписок и сверки секретов ответ `MR` принят давно: решение жило поимённо в
  //      каждом файле и до `bash-guard.mjs` не доехало. Теперь оно в `writeEvent`, один раз;
  //   2. терминальность задачи считалась по доске, то есть только при названной поставке:
  //      у безадресного `doctor` снятых человеком задач было ноль, и отказ слияния у
  //      архивной поставки краснел вечно.
  const libsrc = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  if (!/rest\.stage === 'guard' && \(!rest\.ticket \|\| rest\.ticket === 'unknown'\)/.test(libsrc)) {
    missing.push('scripts/lib/firm.mjs: сторожевое событие без привязки снова уходит unknown — это дыра привязки, которую снять нечем')
  }
  if (!/statusFromEvents\(evs\)\.status/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: терминальность задачи снова считается по доске — у безадресного doctor снятых человеком задач ноль')
  }
  note(
    'расписка об отправке наружу и цепочка расписок (И-14)',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без этого на вопрос «что уехало наружу» ответа снова не будет (ADR-0014)` : '',
  )
}

// ── 3н. Разбор окупаемости тестов: граница машинного и суждения ──────────────
// Приём `firm-test-audit` предлагает СНИМАТЬ тесты, и это единственный механизм движка,
// чей выход уменьшает защиту. Поэтому у него две границы, и обе проверяются текстом, а не
// памятью: (1) машинный разбор печатает только предъявимое строкой и возвращает 0 всегда
// — иначе он стал бы гвардом, запрещающим собственные тесты; (2) приём несёт ОТКАЗНЫЙ
// список — чего не трогаем никогда. Без второго разбор превращается в уборку по вкусу, а
// снятый по вкусу тест — это молча снятая защита (тот же довод, что у `secret-scan`).
{
  const missing = []
  const want = [
    { file: 'scripts/lib/tests.mjs', re: /export function auditTests/, what: 'машинный разбор набора' },
    { file: 'scripts/lib/tests.mjs', re: /ГРАНИЦА ЭТОГО ФАЙЛА/, what: 'граница «только предъявимое строкой» названа в коде' },
    { file: 'scripts/test-audit.mjs', re: /--json/, what: 'машинный выход для приёма' },
    // Решение человека 10.11.2026 сменило здесь не формулировку, а правило: право снимать
    // тест у роли есть. Провод поэтому проверяет НОВУЮ границу — «приём ничего не удаляет
    // сам», — а старую строку «снимает тест человек» он держал бы вопреки решению.
    { file: 'skills/firm-test-audit/SKILL.md', re: /Приём ничего не удаляет сам/, what: 'приём предлагает, а не правит (ADR-0009)' },
    { file: 'skills/firm-test-audit/SKILL.md', re: /снятие без карточки не бывает законным/, what: 'право снимать названо вместе с его условием' },
    { file: 'skills/firm-test-audit/SKILL.md', re: /Чего не трогаем никогда/, what: 'отказный список' },
    { file: 'skills/firm-test-audit/SKILL.md', re: /Медленный тест/, what: 'медленно — не довод для снятия' },
    { file: 'skills/firm-test-audit/SKILL.md', re: /firm2: тест оставить/, what: 'пометка человека снимает тест с разбора' },
    { file: 'skills/firm-test-audit/SKILL.md', re: /test-audit\.mjs/, what: 'приём начинает с машинного разбора, а не с чтения' },
  ]
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет «${w.what}»`)
  }
  // Разбор, который умеет падать, рано или поздно окажется в чьём-то CI как гейт.
  const cli = existsSync(join(engine, 'scripts', 'test-audit.mjs'))
    ? readFileSync(join(engine, 'scripts', 'test-audit.mjs'), 'utf8')
    : ''
  if (/process\.exit\((?!0\))/.test(cli)) {
    missing.push('scripts/test-audit.mjs: ненулевой выход — разбор стал бы гейтом, запрещающим собственные тесты')
  }
  note(
    'разбор окупаемости тестов: машинное отделено от суждения',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без этого приём снимает тесты по вкусу, а снятая по вкусу защита хуже отсутствующей (ADR-0009)` : '',
  )
}

// ── 3о. Счёт контекста движка: границы замера ────────────────────────────────
// Счёт контекста — самый соблазнительный из трёх замеров движка: он даёт большое круглое
// число, которое хочется назвать «движок стоит N токенов». Обе границы, которые делают
// это число правдой, легко потерять одной правкой, и потеря не видна — число останется.
//
//   1. Окна НЕ складываются: у подагента своё окно, тело роли не прибавляется к окну
//      сессии. Общий итог был бы ложью, и в выводе это сказано словами.
//   2. Пороги находок — в СИМВОЛАХ (замер), а не в токенах (пересчёт по коэффициенту,
//      который на этой машине никто не мерил). Домашнее правило «правило без замера —
//      вкус» действует и на сам движок.
{
  const missing = []
  const want = [
    { file: 'scripts/lib/context.mjs', re: /export function contextBill/, what: 'счёт контекста' },
    { file: 'scripts/lib/context.mjs', re: /контексты не складываются/, what: 'граница окон названа в коде' },
    { file: 'scripts/lib/context.mjs', re: /export const CTX_BUDGET/, what: 'бюджеты объявлены явно' },
    { file: 'scripts/lib/context.mjs', re: /budget_\$\{key\}/, what: 'бюджет перекрывается проектом' },
    { file: 'scripts/context-bill.mjs', re: /--json/, what: 'машинный выход' },
    { file: 'commands/firm-help.md', re: /context-bill\.mjs/, what: 'замер назван человеку в справке' },
  ]
  for (const w of want) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!w.re.test(src)) missing.push(`${w.file}: нет «${w.what}»`)
  }
  const lib = existsSync(join(engine, 'scripts', 'lib', 'context.mjs'))
    ? readFileSync(join(engine, 'scripts', 'lib', 'context.mjs'), 'utf8')
    : ''
  // Порог, выраженный в токенах, — это бюджет на невымеренном числе.
  if (/budget[\s\S]{0,200}tokens/.test(lib) || /tokens\s*>\s*budget/.test(lib)) {
    missing.push('scripts/lib/context.mjs: порог находки опирается на токены — это пересчёт, а не замер')
  }
  if (!/НЕ складываются/.test(lib)) {
    missing.push('scripts/lib/context.mjs: вывод не говорит, что окна не складываются — читающий сложит')
  }
  const cli = existsSync(join(engine, 'scripts', 'context-bill.mjs'))
    ? readFileSync(join(engine, 'scripts', 'context-bill.mjs'), 'utf8')
    : ''
  if (/process\.exit\((?!0\))/.test(cli)) {
    missing.push('scripts/context-bill.mjs: ненулевой выход — замер стал бы гейтом по бюджету, который движок сам же и выбрал')
  }
  note(
    'счёт контекста движка: окна раздельно, пороги в замеренном',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без этого замер даёт убедительное и неверное число (ADR-0009, И-12)` : '',
  )
}

// Шаблон, названный внутри шаблона, счёт обязан видеть: иначе «похудевшая» роль выглядит
// дешевле, чем есть. Разбор DevOps 22.10.2026: инструкции режимов уехали в
// `templates/devops-modes.md`, DoD стал называть он, и счёт потерял 2 157 символов молча.
{
  const ctx = readFileSync(join(engine, 'scripts', 'lib', 'context.mjs'), 'utf8')
  note(
    'счёт контекста видит шаблон, названный внутри шаблона',
    /addTemplate\(inner, depth - 1\)/.test(ctx),
    /addTemplate\(inner, depth - 1\)/.test(ctx) ? '' : 'счёт считает только шаблоны, названные телом роли — вынос текста в шаблон занижает стадию молча',
  )
}

// ── 3п. Промпты ролей: ссылка обязана разрешаться, команда — существовать ────
// Разбор стадии Архитектора 21.10.2026. Счёт контекста показал перерасход бюджета, а под
// ним лежали четыре дефекта, и ни один не виден ни линтеру, ни тестам: текст промпта
// ничего не исполняет, поэтому сломанная ссылка в нём молчит.
//
//   • `codegraph module_map` — такой подкоманды в CLI нет (`error: unknown command`), это
//     имя инструмента MCP-сервера. Роль получала ошибку первым же действием и уходила в
//     режим «ответ без графа слабее», хотя граф собран;
//   • `templates/groom-dossier.md` без `$ENGINE/` — роль работает в рабочем дереве, где
//     каталога `templates/` нет вовсе. Формат досье был недостижим у трёх ролей;
//   • блок про доску скопирован в четыре роли побайтово: пока совпадает, но правка в одной
//     копии разойдётся с тремя и будет жить годами;
//   • `CONTEXT.md` писали PM и Архитектор, а стадии сборки о нём не знали.
{
  const missing = []
  const agentsDir = join(engine, 'agents')
  const files = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')) : []
  const bodies = new Map()
  for (const f of files) bodies.set(f, readFileSync(join(agentsDir, f), 'utf8'))

  // Тот же разбор нашёл ссылку без префикса и в промпте СБОРЩИКА (ось безопасности в
  // qaPrompt целила в `templates/standards/common.md`), то есть починка промптов ролей в
  // 0.4.88 была подорвана текстом, который сборщик кладёт в тот же контекст. Проверяем
  // поэтому не только `agents/`.
  for (const rel of ['workflows/firm2-build.js']) {
    const src = existsSync(join(engine, rel)) ? readFileSync(join(engine, rel), 'utf8') : ''
    for (const line of src.split('\n')) {
      if (!/templates\//.test(line)) continue
      if (/\$ENGINE\/templates\/|\$\{ENGINE\}\/templates\//.test(line)) continue
      if (/^\s*\/\//.test(line)) continue // комментарий кода — не ссылка в промпте
      missing.push(`${rel}: ссылка на шаблон без $ENGINE — «${line.trim().slice(0, 60)}»`)
    }
  }

  // Любая ссылка на шаблон движка — только через $ENGINE: без префикса она не разрешается.
  for (const [f, src] of bodies) {
    for (const line of src.split('\n')) {
      if (!/templates\//.test(line)) continue
      if (/\$ENGINE\/templates\//.test(line) || /\$\{ENGINE\}\/templates\//.test(line)) continue
      // Упоминание самого дефекта в объяснении рядом с починкой — не ссылка.
      if (/каталога `templates\/` там нет|`module_map`/.test(line)) continue
      missing.push(`agents/${f}: ссылка на шаблон без $ENGINE — «${line.trim().slice(0, 60)}»`)
    }
  }

  // Подкоманды codegraph, которых нет: имена инструментов MCP в CLI не работают.
  for (const [f, src] of bodies) {
    if (/codegraph\s+module_map/.test(src)) missing.push(`agents/${f}: codegraph module_map — такой подкоманды в CLI нет, она зовётся map`)
  }
  for (const rel of ['commands/firm-discovery.md', 'templates/groom-dossier.md', 'commands/firm-plan.md']) {
    const src = existsSync(join(engine, rel)) ? readFileSync(join(engine, rel), 'utf8') : ''
    if (/codegraph\s+module_map/.test(src)) missing.push(`${rel}: codegraph module_map — в CLI её нет`)
  }

  // Четыре копии правила про доску обязаны быть одним текстом.
  const BOARD = '## Состояние ЧУЖОЙ задачи — только с доски'
  const blocks = new Map()
  for (const [f, src] of bodies) {
    if (!src.includes(BOARD)) continue
    blocks.set(f, src.slice(src.indexOf(BOARD)).split('\n## ')[0])
  }
  const uniq = new Set([...blocks.values()])
  if (blocks.size && uniq.size > 1) {
    missing.push(`блок «состояние чужой задачи» разошёлся между ролями (${[...blocks.keys()].join(', ')}) — правило о доске стало двумя разными правилами`)
  }

  // Глоссарий без читателя — то же, чем был ui.md до 0.4.88.
  for (const f of ['developer.md', 'tester.md', 'reviewer-qa.md']) {
    const src = bodies.get(f) || ''
    if (!/CONTEXT\.md/.test(src)) missing.push(`agents/${f}: не назван CONTEXT.md — живой глоссарий ведут PM и Архитектор, а на стадиях сборки его никто не читает`)
  }

  // Обратная сторона того же: названный глоссарий обязан читаться ГРЕПОМ. Правка 0.4.89
  // («термины бери из CONTEXT.md») на проект-В означала 93 018 символов в окно стадии —
  // мой собственный регресс, пойманный счётом контекста, и у Дизайнера он прожил
  // лишних три версии: роль правили не все разом.
  for (const f of ['developer.md', 'tester.md', 'reviewer-qa.md', 'designer.md']) {
    const src = bodies.get(f) || ''
    const at = src.indexOf('CONTEXT.md')
    if (at < 0) continue
    // Окном, а не строкой: правило «ищи грепом» пишется абзацем, и первая редакция этой
    // проверки требовала грепа в ОДНОЙ строке с именем файла — то есть врала на
    // `agents/tester.md`, где правило стоит двумя строками ниже и действует ровно так же.
    if (!/grep|греп/i.test(src.slice(at, at + 500))) {
      missing.push(`agents/${f}: CONTEXT.md названа без правила «ищи грепом» — целиком этот файл бывает под сто тысяч символов и вытесняет из окна то, по чему роль работает`)
    }
  }

  // Стандарт без читателя — тот же дефект, что у пустой оси Standards, только наоборот:
  // файл есть, объявлен на `*.html`, и роль, которая рисует эти самые экраны, его не
  // открывает (разбор стадии Дизайнера 22.10.2026).
  for (const f of ['developer.md', 'tester.md', 'reviewer-qa.md', 'designer.md']) {
    const src = bodies.get(f) || ''
    if (!/firm-state\.mjs" standards|firm-state\.mjs standards/.test(src)) {
      missing.push(`agents/${f}: роль не спрашивает отбор стандартов — значит судит или рисует по своим представлениям, а файл проекта лежит непрочитанным`)
    }
  }

  // Гатка стадии: у роли с двумя стадиями в одном промпте запрет и подробная инструкция
  // по запрещённому действию лежат рядом.
  for (const f of ['architect.md', 'pm.md', 'designer.md']) {
    const src = bodies.get(f) || ''
    if (/## Процесс на груминге|## На груминге/.test(src) && !/Секция одной стадии/.test(src)) {
      missing.push(`agents/${f}: две стадии в одном промпте без гатки «читай свою секцию» — инструкция, прочитанная не на своей стадии, читается как разрешение (ADR-0012)`)
    }
  }

  note(
    'промпты ролей: ссылки разрешаются, команды существуют, общие правила не разошлись',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — текст промпта ничего не исполняет, поэтому такая поломка молчит до живого прогона` : '',
  )
}

// ── 3р. Пометки-исключения у гвардов устроены одинаково ─────────────────────
// Разбор стадии Тестировщика 21.10.2026. У движка три места, где человек или роль снимает
// защиту пометкой в строке: `firm2: не секрет`, `firm2: стадийная проверка`,
// `firm2: тест оставить`. Правило на все три одно и записано в `common.md` §5: защита,
// снятая без названной причины, хуже отсутствующей, а снятая молча — хуже обеих.
//
// Держалось это правило текстом, и текст разошёлся с кодом: `secret-scan` требовал причину
// и писал событие, `test-criteria-guard` пропускал голую пометку и не писал ничего, а
// разбор тестов пометку вообще не читал. Три обещания, одно исполнение. Шаг сверяет форму
// регулярки (причина обязательна) и наличие записи в журнал там, где защита снимается.
{
  const missing = []
  const waivers = [
    { file: 'scripts/lib/secrets.mjs', name: 'firm2: не секрет', journaled: 'scripts/secret-scan.mjs' },
    { file: 'scripts/test-criteria-guard.mjs', name: 'firm2: стадийная проверка', journaled: 'scripts/test-criteria-guard.mjs' },
    { file: 'scripts/lib/tests.mjs', name: 'firm2: тест оставить', journaled: null },
  ]
  for (const w of waivers) {
    const path = join(engine, w.file)
    const src = existsSync(path) ? readFileSync(path, 'utf8') : ''
    // Причина обязательна: после названия пометки в регулярке обязано стоять тире и хоть
    // что-то за ним. Форма одна на все три намеренно — роль запоминает одну, не три.
    if (!/\[—-\]\\s\*\\S/.test(src)) {
      missing.push(`${w.file}: пометка «${w.name}» принимается без причины — правило обещано текстом и не исполняется (common.md §5)`)
    }
    if (w.journaled) {
      const jsrc = readFileSync(join(engine, w.journaled), 'utf8')
      if (!/writeEvent\(/.test(jsrc)) {
        missing.push(`${w.journaled}: снятие защиты не попадает в журнал — оговорка, о которой никто не узнал, снимает защиту молча`)
      }
      if (/ticketFromBranch\([\s\S]{0,40}\|\|\s*'unknown'/.test(jsrc)) {
        missing.push(`${w.journaled}: событие пишется с ticket: unknown — это дыра привязки (И-7), и она краснит doctor НАВСЕГДА на иммутабельном журнале; вне ветки задачи пишется MR`)
      }
    }
  }
  note(
    'пометки-исключения: причина обязательна, снятие защиты видно в журнале',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — пометка без причины и без следа это снятая молча защита, и дороже всего она стоит там, где все уверены, что она стоит` : '',
  )
}

// ── 3с. Оборванные концы: поле схемы, промпт и потребитель ──────────────────
// Разбор стадии Разработчика 21.10.2026 нашёл класс, которого не видит ни один прежний
// шаг: обе стороны провода написаны, а провода нет.
//
//   • `place()` велел «назови порт в результате», шаг уборки слияния велел «ищи по портам,
//     которые стадии назвали в своих результатах» — а ПОЛЯ для порта в схемах не было.
//     Следствие названо в тех же абзацах: процесс переживает задачу и занимает порт;
//   • `status: ok|fail|blocked` требовался схемой и не читался ни одной ветвью: цикл
//     открывал Тестировщика даже там, где Разработчик сам сказал «не сделал»;
//   • `notes` и `files_changed` Разработчика не доходили ни до Ревьюера, ни до журнала —
//     ровно та болезнь, которую Тестировщику вылечили 04.10.2026.
//
// Шаг проверяет, что у каждого из трёх концов есть вторая сторона. Текстом, потому что
// исполнить сборщик здесь нечем: он идёт только в живом прогоне.
{
  const missing = []
  const build = readFileSync(join(engine, 'workflows', 'firm2-build.js'), 'utf8')
  const ev = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')

  // Проверяем ОБЕ схемы по отдельности, и каждую — ТОЛЬКО в её собственном блоке. Первая
  // редакция этого правила смотрела «в пределах 1200 символов после имени схемы» и
  // пропускала мутацию: поле, удалённое из DEV_SCHEMA, находилось у соседней TEST_SCHEMA.
  // Мутационная проверка на этом и поймала — проверка, видящая чужое поле, не проверяет
  // ничего.
  const blockOf = (name) => {
    const i = build.indexOf(`const ${name} = {`)
    if (i < 0) return ''
    const j = build.indexOf('\nconst ', i + 1)
    return build.slice(i, j < 0 ? build.length : j)
  }
  for (const name of ['DEV_SCHEMA', 'TEST_SCHEMA']) {
    if (!/ports: \{ type: 'array'/.test(blockOf(name))) {
      missing.push(`workflows/firm2-build.js: в ${name} нет поля ports — назвать порт роли негде, а уборка слияния ищет именно названные`)
    }
  }
  // Путь портов стал на одно звено длиннее: слияния идут через очередь (Д-34), и
  // проверять надо всю цепочку, иначе провод оборвётся в её середине молча.
  if (!/mergeTicket\(task, ports/.test(build) || !/mergeQueued\(t, r\.ports\)/.test(build) ||
      !/function mergeQueued\(task, ports\)/.test(build) || !/mergeTicket\(task, ports\)/.test(build)) {
    missing.push('workflows/firm2-build.js: названные порты не доезжают до уборки слияния — поле заполняется впустую')
  }
  if (!/if \(dev && dev\.status === 'blocked'\)/.test(build) || !/if \(dev && dev\.status === 'fail'\)/.test(build)) {
    missing.push('workflows/firm2-build.js: статус стадии разработки не читается — fail и blocked открывают тест и ревью по работе, которой нет')
  }
  // Предъявимый прогон. Три конца: схема просит `runs`, сборщик показывает его Ревьюеру,
  // и Ревьюер знает, что с ним делать. Оборвись любой — правило «не на слово» вернётся к
  // «перегони всё заново», и вернётся МОЛЧА: вердикты останутся теми же, подорожает только
  // поставка. Цена названа замером первой волны проект-В 25.10.2026 — 8,17 ч из 11,09.
  if (!/function runsEvidence/.test(build) || !/runsEvidence\(tested, task\)/.test(build)) {
    missing.push('workflows/firm2-build.js: предъявленный прогон не доходит до Ревьюера — ему нечего сверять, и он перепрогоняет весь набор панелью втроём')
  }
  if (!/runs: \{/.test(blockOf('TEST_SCHEMA'))) {
    missing.push("workflows/firm2-build.js: в TEST_SCHEMA нет поля runs — предъявить прогон с sha Тестировщику негде")
  }
  {
    const qa = readFileSync(join(engine, 'agents', 'reviewer-qa.md'), 'utf8')
    const tst = readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')
    if (!/runs\.base\.sha/.test(qa) || !/merge-base/.test(qa)) {
      missing.push('agents/reviewer-qa.md: роли не сказано сверять sha предъявленного прогона — предъявлять его тогда некому')
    }
    if (!/runs\.base/.test(tst) || !/`sha`/.test(tst)) {
      missing.push('agents/tester.md: роли не сказано заполнять runs с sha — схема просит поле, о котором исполнитель не знает')
    }
    // Прежнее правило целиком, а не по куску: словами «прогони сам обе стороны» новый
    // текст объясняет, что изменилось, и ловить их значило бы запрещать объяснение.
    if (/на слово не принимай: прогони сам обе стороны/.test(qa)) {
      missing.push('agents/reviewer-qa.md: осталось прежнее правило «не принимай на слово: прогони сам обе стороны» — два правила разом, и роль выберет дорогое')
    }
  }
  // Основание сверки «новых красных» (BR-165 проект-В). Пять концов: имя ветки-цели из
  // конфига доезжает до сборщика, движок снимает по ней красные ОДИН раз на прогон,
  // стадия теста получает правило трёх групп, Ревьюер — предъявленное основание, и третья
  // группа («красные поставки») имеет имя в схеме и хозяина в итоге прогона. Оборвись
  // любой — «новых красных нет» вернётся к прежней слепоте и вернётся МОЛЧА: буква отчёта
  // останется верной. Замер: MR-ревью «сменных скинов» 13.10.2026 — 21 красный = 12
  // предсуществующих + 9 своих, три независимые сверки, все три базы внутри поставки.
  {
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    const qa = readFileSync(join(engine, 'agents', 'reviewer-qa.md'), 'utf8')
    const tst = readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')
    if (!/main_branch: baseBranch\(\)/.test(st)) {
      missing.push('scripts/firm-state.mjs: имя ветки-цели не доезжает до сборщика — основание сверки снимать не с чего, и база утверждения приёмки снова ляжет внутрь поставки (BR-165)')
    }
    if (!/const TRUNK_SCHEMA/.test(build) || !/^async function trunkRed/m.test(build)) {
      missing.push('workflows/firm2-build.js: нет зонда основания сверки — красные ветки-цели прогону неизвестны, и «не мои» снова сливается с «предсуществующие»')
    }
    // Половин сравнения ДВЕ, и до стадии обязаны доехать обе: ветка-цель и точка
    // ветвления (0.4.115). Доедет одна — вернётся ровно тот дефект, ради которого правка
    // и делалась: роль добирает вторую сама, холодным деревом, за два часа.
    if (!/^\s*const trunk = await trunkRed\(\)/m.test(build) || !/^\s*trunkRule\(trunk, base\) \+/m.test(build)) {
      missing.push('workflows/firm2-build.js: основание сверки не доходит до стадии теста — Тестировщик делит красные на две группы вместо трёх')
    }
    if (!/^\s*const base = await baseRed\(task\)/m.test(build)) {
      missing.push('workflows/firm2-build.js: точка ветвления не снимается движком — стадия добирает вторую половину сравнения сама, холодным деревом')
    }
    if (!/^\s*trunkEvidence\(tested, task\) \+/m.test(build)) {
      missing.push('workflows/firm2-build.js: основание сверки не доходит до Ревьюера — он судит «новых красных нет» по базе внутри поставки')
    }
    if (!/delivery_red: \{ type: 'array'/.test(blockOf('TEST_SCHEMA'))) {
      missing.push("workflows/firm2-build.js: в TEST_SCHEMA нет delivery_red — третьей группе красных негде появиться, а значит у неё снова нет хозяина")
    }
    if (!/deliveryRed\.add\(/.test(build) || !/КРАСНЫЕ ПОСТАВКИ/.test(build)) {
      missing.push('workflows/firm2-build.js: красные поставки не собираются в итог прогона — названные стадией, они растворятся в логе одной задачи')
    }
    if (!/delivery_red/.test(tst) || !/git cat-file -e/.test(tst)) {
      missing.push('agents/tester.md: роли не сказано ни про третью группу красных, ни про дешёвую проверку `git cat-file -e` — схема просит поле, о котором исполнитель не знает')
    }
    if (!/cat-file -e/.test(qa) || !/ветк[аиу]-цел/.test(qa)) {
      missing.push('agents/reviewer-qa.md: Ревьюеру не названа база утверждения приёмки — остаётся прежнее «новый красный относительно точки ветвления», которое поставку не ловит')
    }
  }
  // Д-14. Добор задачи, вернувшейся в цикл или заведённой по ходу прогона. Четыре конца:
  // замер модели задач в `firm-state settled`, поле в схеме зонда, разбор ответа и сам
  // добор в планировщике. Оборвись любой — прогон вернётся к «этот прогон их не возьмёт»,
  // и вернётся молча: вердикты те же, простаивает только календарь (замер прогона
  // 2026-10-23-game-redesign: занятость 1.73 слота из 3, 5,5 слото-часов при готовой задаче).
  {
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    if (!/function taskRecords/.test(st) || !/workable: taskRecords\(change\)\.tasks/.test(st)) {
      missing.push('scripts/firm-state.mjs: зонд состояния не отдаёт workable — планировщику нечего добирать, и слот простаивает при готовой задаче (Д-14)')
    }
    if (!/const rec = taskRecords\(change\)/.test(st)) {
      missing.push('scripts/firm-state.mjs: build-args считает задачи не той же функцией, что settled — две модели задачи разойдутся молча, и добранная задача приедет урезанной')
    }
    if (!/workable: \{ type: 'array'/.test(blockOf('SETTLED_SCHEMA'))) {
      missing.push("workflows/firm2-build.js: в SETTLED_SCHEMA нет поля workable — зонд не вернёт пригодные задачи, сколько бы их ни нашёл движок (Д-14)")
    }
    if (!/workable: Array\.isArray\(r\.workable\)/.test(build) || !/^\s*absorb\(live\.workable\)/m.test(build)) {
      missing.push('workflows/firm2-build.js: ответ зонда не доходит до планировщика — добора нет, поле заполняется впустую (Д-14)')
    }
    if (!/const PLAN_IDS = new Set/.test(build) || !/PLAN_IDS\.has/.test(build)) {
      missing.push('workflows/firm2-build.js: добор не отличает план от добранного — мандат прогона кончиться не может, и он берёт чужую работу бесконечно (ADR-0009)')
    }
    if (!/\(t\.attempt \|\| 0\) < MAX_ATTEMPTS/.test(build)) {
      missing.push('workflows/firm2-build.js: добор не смотрит на попытки — лимит MAX_ATTEMPTS обнуляется возвратом в цикл')
    }
    if (!/t\.status === 'ready' \|\| t\.status === 'rework'/.test(build)) {
      missing.push('workflows/firm2-build.js: добор не ограничен статусами ready/rework — прогон возьмёт задачу, которая прямо сейчас идёт или ждёт слияния')
    }
  }
  // Чужое время из ожидания движка. Четыре конца: границы паузы попадают в журнал,
  // доска собирает их один раз на прогон и раздаёт задачам, тайминг вычитает ОБЪЕДИНЕНИЕ
  // (а не сумму), и дашборд показывает части врозь. Оборвись любой — время, которым прогон
  // не распоряжается (ADR-0009), снова предъявляется ему: замер проект-В 28.10.2026 давал
  // «168 ч 26 м ожидания», и человек читал это как работу движка.
  {
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    const lib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
    const dash = readFileSync(join(engine, 'scripts', 'dashboard.mjs'), 'utf8')
    if (!/function pauseEvent/.test(st) || !/pauseEvent\('paused'/.test(st) || !/pauseEvent\('resumed'/.test(st)) {
      missing.push('scripts/firm-state.mjs: границы паузы не пишутся в журнал — флаг отвечает только «стоит ли пауза сейчас», и время остановки уходит в ожидание движка (ADR-0009)')
    }
    if (!/export function pauseSpans/.test(lib) || !/const pauses = pauseSpans\(events\)/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: интервалы паузы не считаются по журналу — тайминг вычитать нечего')
    }
    if (!/timing\(s\.events, pauses\)/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: интервалы паузы не доезжают до timing — считаются впустую, и ожидание движка остаётся с чужим временем')
    }
    if (!/waiting_human_ms/.test(lib) || !/waiting_engine_ms/.test(lib) || !/Math\.min\(both, waiting\)/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: ожидание не разложено на части или перекрытие вычитается суммой — «ожидание движка» уйдёт в минус, обрезанный нулём, то есть ошибка будет похожа на успех')
    }
    if (!/waiting_engine_ms/.test(dash) || !/ждут человека/.test(dash) || !/на паузе/.test(dash)) {
      missing.push('scripts/dashboard.mjs: части ожидания не названы врозь — разложение посчитано, а человек по-прежнему видит сумму со чужим временем')
    }
    // Поправка 29.10.2026: шапка отвечает на вопрос «сколько это заняло», и ответ у него
    // один — чистое время. Разбивка осталась, но ниже; вычтенное названо, иначе число
    // нечем проверить.
    if (!/clean_ms: Math\.max\(0, calendar - Math\.min\(both, calendar\)\)/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: чистое время не считается или считается сложением слагаемых — главное число поставки разъедется с календарём на краях')
    }
    if (!/чистое по задачам/.test(dash) || !/без ожидания человека и паузы/.test(dash)) {
      missing.push('scripts/dashboard.mjs: в шапке нет чистого времени — человек видит разбивку ожидания там, где спрашивал цену поставки')
    }
    // И отдельно — время САМОЙ поставки: сумма по задачам больше её календаря (задачи
    // идут параллельно), и на вопрос «сколько поставка идёт» отвечать ею нельзя.
    if (!/export function deliveryTiming/.test(lib) || !/spanMs\(spans\.map\(clip\)\)/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: время поставки как целого не считается или считается суммой стадий — параллельные задачи дадут число больше её календаря')
    }
    if (!/deliveryTiming\(events, pauseSpans\(events\)\)/.test(dash) || !/шла поставка/.test(dash)) {
      missing.push('scripts/dashboard.mjs: в шапке нет времени самой поставки — человек видит только сумму по задачам, а она отвечает на другой вопрос')
    }
    if (!/calendar_ms - \(t\.timing\.clean_ms \|\| 0\)/.test(dash)) {
      missing.push('scripts/dashboard.mjs: вычтенное чужое складывается из частей, а не берётся разницей — части накладываются, и в подсказке окажется больше, чем вычли')
    }
    // Строки графа — волны планировщика (просьба 30.10.2026). Два конца провода, и важен
    // именно второй: правило прокрутки берётся из `waves()`, а не пишется в проекции
    // заново. Доска со своим правилом однажды покажет не тот план, по которому пойдёт
    // прогон, и расхождение будет тихим — ADR-0001, истина не на доске.
    if (!/function planRows\(tasks, parallelism\)/.test(dash) || !/waves\(tasks, \{ parallelism: cap/.test(dash)) {
      missing.push('scripts/dashboard.mjs: строки графа считаются не прокруткой waves() — у доски завелось своё правило плана, и оно разойдётся с планировщиком молча')
    }
    if (!/export function waves\(tasks, \{ parallelism = 3, respectExclusive = true, done = \[\], held = \[\] \}/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: у waves() нет held — заблокированную задачу придётся выбрасывать из списка, а тогда зависимость на неё считается закрытой')
    }
    if (!/идёт сейчас · занято/.test(dash) || !/слот свободен/.test(dash)) {
      missing.push('scripts/dashboard.mjs: текущая волна не подписана занятыми слотами или свободный слот не нарисован — на вопрос «почему не взяли ещё одну» доска опять молчит')
    }
    if (!/Почему в работе именно эти/.test(dash) || !/parallelism — \$\{cap\}/.test(dash)) {
      missing.push('scripts/dashboard.mjs: правило отбора не названо словами — в картинке виден результат, а не три условия, по которым задача взята')
    }
  }
  // Маркер набора инструментов и два разных EPERM (Д-18, проект-В 28.10.2026). Три конца:
  // маркер ищется глубже корня, разрешение не ждёт появления кэша, и роль, упёршаяся в
  // отказ, получает подсказку, чем `EPERM` песочницы отличается от `EPERM` прав. Оборвись
  // первый — у проекта с манифестом в `web/` кэш не разрешён и инструмент не стартует;
  // оборвись третий — роли снова будут объяснять отказ сами, а объясняли они его неверно
  // трижды за три недели, и одна в ответ сняла песочницу.
  {
    const perm = readFileSync(join(engine, 'scripts', 'firm-permissions.mjs'), 'utf8')
    const guard = readFileSync(join(engine, 'scripts', 'bash-guard.mjs'), 'utf8')
    const roleTester = readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')
    const roleQa = readFileSync(join(engine, 'agents', 'reviewer-qa.md'), 'utf8')
    if (!/function markerPaths/.test(perm) || !/ls-files/.test(perm)) {
      missing.push('scripts/firm-permissions.mjs: маркер набора инструментов ищется только в корне — проект с манифестом в web/ или frontend/ останется без разрешения на кэш, и роль получит EPERM, неотличимый от проблемы прав (Д-18)')
    }
    if (!/VENDOR|vendored/.test(perm)) {
      missing.push('scripts/firm-permissions.mjs: при поиске маркера не отсекаются вендорные каталоги — правило сработает на чужом манифесте внутри node_modules')
    }
    if (/if \(!existsSync\(abs\)\) continue/.test(perm)) {
      missing.push('scripts/firm-permissions.mjs: разрешение на кэш снова ждёт существования каталога — на чистой машине оно появится уже после отказа, который его потребовал')
    }
    if (!/ПЕСОЧНИЦА, а не права доступа/.test(guard) || !/ls -ld/.test(guard)) {
      missing.push('scripts/bash-guard.mjs: в отказе нет различения двух EPERM — роль объяснит отказ сама, и это стоило трёх ложных диагнозов «чужие файлы root» (Д-18)')
    }
    // Третий пункт того же разбора, и он дороже первых двух: отказ оснастки закрыл собой
    // нарушение правила проекта. Роль, упёршаяся в запуске инструмента, обязана сперва
    // спросить манифест, её ли это инструмент, — иначе «инструмент X не запустился по
    // причине Y» проходит панель, как прошло пять раз подряд на проект-В.
    for (const [file, src] of [['tester.md', roleTester], ['reviewer-qa.md', roleQa]]) {
      if (!/его ли это инструмент/.test(src) || !/stack\.test_cmd/.test(src)) {
        missing.push(`agents/${file}: роли не сказано спросить проект, его ли это инструмент, и взять команду из stack.test_cmd — отказ оснастки снова закроет собой неверно выбранную команду (Д-18)`)
      }
    }
    // Д-19. Коммит движка после слияния. Хук пишет события в главное дерево и сам кладёт
    // их в индекс — а что с ними делать, движок не предписывал вовсе, и стадия
    // придумывала и команду, и заголовок. проект-В 28.10.2026: коммит «события слияния
    // T-144» содержал один файл `.claude/settings.json` — правку человека, сделанную в ту
    // же минуту. Заголовок коммита движка обязан называть то, что в нём лежит.
    if (!/ШАГ 3а/.test(build) || !/события слияния \$\{task\.id\}/.test(build)) {
      missing.push('workflows/firm2-build.js: коммит событий ПОСЛЕ слияния не предписан — стадия придумает и команду, и заголовок, и увезёт под ним чужие правки (Д-19)')
    }
    if (!/здесь НЕ использовать — ни одну из трёх/.test(build) || !/git add -A/.test(build)) {
      missing.push('workflows/firm2-build.js: в шаге коммита событий нет запрета широкого add — главное дерево это рабочее место человека, и его правки уедут под заголовком движка (Д-19)')
    }
  }
  // Узкий задачный прогон (замер проект-В 28.10.2026: 26 минут стадии теста против девяти,
  // когда мета-тесты механизма установки не гоняются по разу на каждой задаче). Пять
  // концов, и каждый снимает свой способ соврать: ключ доезжает до сборщика; основание
  // сверки снимается ТОЙ ЖЕ командой (иначе две половины сравнения покрывают разные
  // наборы — BR-165 заново); стадия и Ревьюер знают, что зелёный здесь не полный; ворота
  // гоняют полный набор. Оборвись последний — сужение означает не переезд проверок на
  // ворота, а то, что они не гоняются нигде, и узнается это после выпуска.
  {
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    const roleTester = readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')
    const roleQa = readFileSync(join(engine, 'agents', 'reviewer-qa.md'), 'utf8')
    const buildCmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
    if (!/task_test_cmd: \(cfg\.stack/.test(st) || !/task_tests_narrowed: Boolean/.test(st)) {
      missing.push('scripts/firm-state.mjs: узкий задачный прогон не доезжает до сборщика — проект сузит команду, а движок про сужение не узнает и промолчит о нём всем стадиям')
    }
    if (!/const TASK_TEST_CMD/.test(build) || !/функци|const narrowRule/.test(build)) {
      missing.push('workflows/firm2-build.js: сборщик не знает про задачную команду — стадия возьмёт полный набор, и сужение не даст ничего')
    }
    if (!/набор ЗАДАЧНОГО прогона/.test(build)) {
      missing.push('workflows/firm2-build.js: основание сверки снимается НЕ задачной командой — две половины сравнения покрывают разные наборы, и «новых красных нет» становится ложным по построению (BR-165)')
    }
    if (!/narrowRule\(\) \+/.test(build) || !/qaNarrowRule\(\)/.test(build)) {
      missing.push('workflows/firm2-build.js: про сужение не сказано стадии или Ревьюеру — узкий зелёный будет предъявлен как полный')
    }
    for (const [file, src] of [['tester.md', roleTester], ['reviewer-qa.md', roleQa]]) {
      if (!/task_test_cmd/.test(src)) {
        missing.push(`agents/${file}: роль не знает про узкий задачный прогон — схема и промпт говорят о нём, а исполнитель нет`)
      }
    }
    if (!/ПОЛНЫЙ набор, а не то, чем проверялись/.test(buildCmd)) {
      missing.push('commands/firm-build.md: воротам не сказано гнать полный набор — сужение тогда означает, что проверки не гоняются нигде (и узнается это после выпуска)')
    }
  }
  // Д-20 и Д-21 (отчёт проект-В 28.10.2026). Сторож отправки обязан разбирать ПОДКОМАНДУ:
  // подстрока «push» ловила `git stash push` и слово в `echo`, а расписка об отправке —
  // удостоверение (ADR-0014), и поток ложных делает настоящую неотличимой. Карманы шага
  // слияния движок называет, но не снимает: в кармане может лежать единственная копия
  // работы, а `drop` уже уничтожал правки Архитектора молча.
  {
    const eg = readFileSync(join(engine, 'scripts', 'egress.mjs'), 'utf8')
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    // Разбор переехал в `lib/firm.mjs` (Д-22): здесь спрашивается, что сторож им
    // пользуется, а не что носит его копию.
    if (!/gitSubcommands/.test(eg) || /sink: 'push', re:/.test(eg)) {
      missing.push('scripts/egress.mjs: отправка опознаётся подстрокой «push», а не подкомандой — `git stash push` и слово в echo дадут ложную расписку, и настоящая станет неотличимой (Д-20)')
    }
    if (!/function stashLeftovers/.test(st) || !/stashes: o\.stashes/.test(st)) {
      missing.push('scripts/firm-state.mjs: отложенные карманы не называются — они копятся через поставки молча, и `git stash list` перестаёт быть читаемым ровно к тому моменту, когда нужен (Д-21)')
    }
    if (/execFileSync\([^)]*'stash',\s*'(?:drop|clear|pop)'/.test(st)) {
      missing.push('scripts/firm-state.mjs: движок снимает карман сам — в нём может лежать единственная копия работы (ADR-0009), а drop уничтожает молча')
    }
    if (!/stash push -m "firm2:/.test(build)) {
      missing.push('workflows/firm2-build.js: карман кладётся без подписи движка — забытый станет неотличим от кармана человека (Д-21)')
    }
    // Д-32: зона кармана названа путями, и `.firm/config` в неё попадать не должен.
    // Признак содержательный, а не поимённый список регулярок: спрашиваем, что зона
    // сужена до журнала событий И что конфиг назван исключением вслух.
    if (!/Твоя зона — только[^\n]*\.firm\/events\//.test(build)) {
      missing.push('workflows/firm2-build.js: зона кармана шага слияния названа как `.firm/` целиком — вместе с кэшами уедет `.firm/config`, то есть записанная версия движка (Д-32)')
    }
    if (!/\.firm\/config.{0,80}в карман не кладётся/s.test(build)) {
      missing.push('workflows/firm2-build.js: шагу слияния не сказано, что `.firm/config` в карман не кладётся НИКОГДА — правку /firm-adopt унесёт незакоммиченной, и признак смены движка сотрётся (Д-32)')
    }
    // Д-34: карман, не сведённый обратно, останавливает слияния, а не падает на чужом имени.
    if (!/ls-files -u/.test(build)) {
      missing.push('workflows/firm2-build.js: после `stash pop` не проверяется `git ls-files -u` — несведённый карман уронит слияние СЛЕДУЮЩЕЙ задачи, и диагноз укажет не туда (Д-34)')
    }
    if (!/pocket_conflict/.test(build) || !/POCKET = \{ id: task\.id/.test(build)) {
      missing.push('workflows/firm2-build.js: шаг слияния не возвращает pocket_conflict или прогон его не слушает — при несведённом индексе git не начнёт ни одного мержа (Д-34)')
    }
    if (!/let MERGE_CHAIN/.test(build) || !/function mergeQueued/.test(build)) {
      missing.push('workflows/firm2-build.js: слияния идут без очереди — два мержа разом правят индекс ОДНОГО главного дерева, и признак несведённого кармана тогда никого не останавливает (Д-34)')
    }
    if (!/pocket-conflict/.test(build)) {
      missing.push('workflows/firm2-build.js: несведённый карман не уходит событием guard/pocket-conflict — остановка слияний останется только в логе прогона (Д-34)')
    }
    const libSrc = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
    const evSrc = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
    const guardSrc = readFileSync(join(engine, 'scripts', 'bash-guard.mjs'), 'utf8')
    if (!/export function unmergedPaths/.test(libSrc) || !/unmerged_index: unmergedPaths\(root\)/.test(evSrc)) {
      missing.push('scripts: doctor не видит несведённый индекс главного дерева — признак, из-за которого слияние падает с именем чужой задачи, остаётся невидимым до самого прогона (Д-34)')
    }
    // Д-36: сбой канала ответа роли — отказ одной стадии, а не исключение из прогона.
    if (!/async function tryCall/.test(build) || !/async function runOne/.test(build)) {
      missing.push('workflows/firm2-build.js: вызовы стадий не обёрнуты — исчерпание лимита structured output уносит ВЕСЬ прогон, и в журнале об этом не остаётся ничего (Д-36)')
    }
    if (!/stage-call-failed/.test(build) || !/call_failures: CALL_FAILURES/.test(build)) {
      missing.push('workflows/firm2-build.js: сорванный канал ответа не уходит событием guard/stage-call-failed и не попадает в итог прогона — стадия сделала работу, а следа нет (Д-36)')
    }
    if (/\(async \(\) => \{\s*const prep = await prepare/.test(build)) {
      missing.push('workflows/firm2-build.js: тело задачи снова стоит прямо в планировщике — исключение из него уйдёт в Promise.race и унесёт прогон (Д-36)')
    }
    // Д-37: состав работы предъявляет движок, и роль его не объявляет.
    if (!/function taskDiffOf/.test(build) || !/task-diff --ticket/.test(build)) {
      missing.push('workflows/firm2-build.js: дифф задачи не снимается движком — объявление, которое Разработчик пишет о состоянии, меняющемся после него, это утверждение о будущем (Д-37)')
    }
    if (!/const diff = await taskDiffOf\(task\)/.test(build) || !/diffEvidence\(diff\)/.test(build)) {
      missing.push('workflows/firm2-build.js: снятый дифф не доезжает до Ревьюера — зонд отработает впустую (Д-37)')
    }
    if (!/Расхождение объявления с этим списком замечанием НЕ считай/.test(build)) {
      missing.push('workflows/firm2-build.js: Ревьюеру не сказано, что расхождение объявления с диффом не замечание — три захода проект-В сорвались ровно на этом, и ни один не был виной исполнителя (Д-37)')
    }
    if (!/export function taskDiff/.test(libSrc) || !/case 'task-diff'/.test(readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8'))) {
      missing.push('scripts: нет команды task-diff — списку файлов неоткуда взяться машинным (Д-37)')
    }
    // Д-38: файлы задач поставки КОММИТЯТСЯ, а не откладываются карманом. Карман платил
    // дважды: ложной подписью (Д-25/Д-38) и несведённым индексом (Д-34).
    if (!/add \.firm\/events \.firm\/ids docs\/bugs openspec\/changes\/\$\{CHANGE\}\/tasks/.test(build)) {
      missing.push('workflows/firm2-build.js: шаг слияния не коммитит файлы задач поставки — они остаются незакоммиченными ровно на пути мержа, и шаг снова упрётся в выбор между карманом и отказом (Д-38)')
    }
    if (!/В КАРМАН \(git stash\) файлы задач НЕ КЛАДУТСЯ/.test(build)) {
      missing.push('workflows/firm2-build.js: шагу слияния не запрещён карман для файлов задач — подпись «кэши статусов» лгала о содержимом, и работу Архитектора по ней никто не искал (Д-38)')
    }
    // Д-41: событие о сорванном канале пишется и за зонды, а не только за задачу целиком.
    if (!/async function tryCall\(label, thunk, fallback = null, ticket = null\)/.test(build) || !/if \(ticket\) await recordCallFailed/.test(build)) {
      missing.push('workflows/firm2-build.js: tryCall не умеет писать событие — сорванный зонд остаётся только в логе прогона, и обещанного guard/stage-call-failed в журнале нет (Д-41)')
    }
    for (const probe of ['основание: точка ветвления', 'полоса:', 'дифф:', "    task.id,\n  )"]) {
      if (build.includes(probe)) continue
      missing.push(`workflows/firm2-build.js: зонд «${probe}» не передаёт задачу в tryCall — его срыв не попадёт в журнал (Д-41)`)
    }
    if (/смотри `?models`?|на слабой модели это повторится/.test(build)) {
      missing.push('workflows/firm2-build.js: срыв канала ответа объясняется моделью — замерено на haiku И на sonnet, то есть совет ведёт мимо причины (Д-41)')
    }
    // Д-39: разрушение .git отклоняется, и признак стадии не держится на одном cwd.
    if (!/function gitSurgery\(cmd\)/.test(guardSrc) || !/git worktree prune/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: разрушающая команда по .git проходит или отказ идёт без рецепта — снесённая запись реестра деревьев заставляет `git worktree list` врать (Д-39)')
    }
    if (!/git_surgery/.test(guardSrc) || !/event: 'git-surgery'/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: нет осознанного обхода guard.git_surgery с событием — запрет без выхода обходят копированием команды, а не исполняют (Д-39)')
    }
    // Поправка потолка по отчёту проект-В 02.11.2026: признак полного прогона — отсутствие
    // сужения, ворота поставки исключены, отказ по ожиданию пишется событием.
    if (!/function narrowed\(tail\)/.test(guardSrc) || !/const NARROWING = \[/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: полный прогон опознаётся совпадением с командой, а не отсутствием сужения — у проекта с голым префиксом запускателя (uv run pytest) так отклоняется АДРЕСНЫЙ прогон, то есть ровно то, что сторож велит делать соседним правилом (Д-44а)')
    }
    if (!/function atGate\(ticket\)/.test(guardSrc) || (guardSrc.match(/inStage && !gate/g) || []).length < 2) {
      missing.push('scripts/bash-guard.mjs: ворота поставки не исключены из правил стадии — шаг 3б маршрут выполняет подагентом, и потолок запрещает полный прогон ровно там, куда сам отсылает, а правило ожидания отклоняет живой гейт на 62 минуты (Д-44б)')
    }
    if (!/blocked: true/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: отказ по долгому ожиданию не пишется событием — укус правила неизмерим, а порог без замера есть вкус, и для правил движка это верно так же, как для чужих (отчёт проект-В, находка 2)')
    }
    if (!/function ticketOf\(root, cwd, h = null\)/.test(guardSrc) || !/markerFromAgent\(root, h\.session_id, h\.agent_id\)/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: события сторожа берут тикет только по рабочему дереву — полный прогон идёт из главного дерева, значит ticket: unknown ВСЕГДА, и санкционированный обход краснит doctor (отчёт проект-В, находка 1)')
    }
    if (!/function fromSubagent\(h\)/.test(guardSrc) || !/const inStage = Boolean\(worktree\) \|\| fromSubagent\(h\)/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: признак стадии держится на одном cwd — стадия из главного дерева снимает песочницу молча, и за всю волну проект-В нет ни одного guard/sandbox-off (Д-39)')
    }
    // Д-30 (решение человека 02.11.2026): потолок на полный прогон набора в стадии держится
    // ДВУМЯ половинами — сторож отменяет вызов, промпт говорит о запрете заранее. Половина
    // без половины хуже целого: сторож без текста тратит ход роли на отказ, текст без
    // сторожа держится памятью роли.
    if (!/function fullSuite\(cmd, cfg\)/.test(guardSrc) || !/ПОЛНЫЙ ПРОГОН НАБОРА В СТАДИИ ЗАПРЕЩЁН/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: полный прогон набора в стадии не отменяется — проект платит за сужение решением, а держится оно памятью роли (волна проект-В 02.11.2026: 484 полных прогона при 784 стадиях)')
    }
    if (!/full_suite/.test(guardSrc) || !/event: 'full-suite'/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: у потолка на полный прогон нет осознанного обхода guard.full_suite с событием — запрет без выхода обходят, а не исполняют (Д-30)')
    }
    if (!/НАБОР ЦЕЛИКОМ В СТАДИИ НЕ ГОНИ НИ РАЗУ/.test(build) || !/FULL_TEST_CMD !== TASK_TEST_CMD/.test(build)) {
      missing.push('workflows/firm2-build.js: промпт не называет запрет полного прогона — роль узнаёт о нём из отказа сторожа, то есть потратив ход, и идёт искать обход (Д-30, вторая половина)')
    }
    // Замер проект-В 02.11.2026: рецепт отказа сам упал в песочнице. Рецепт, который не
    // работает, не удерживает от обхода — он к нему толкает.
    if (!/рабочего рецепта в сессии НЕТ НИ ОДНОГО/.test(guardSrc) || !/Operation not permitted/.test(guardSrc)) {
      missing.push('scripts/bash-guard.mjs: отказ по .git выдаёт git worktree prune как рабочий рецепт, молча о том, что в песочнице он падает тем же «Operation not permitted» — стадия, у которой рецепт не сработал, пойдёт искать обход, то есть ровно rm -rf (замер проект-В 02.11.2026)')
    }
    // Д-33: кэш статуса догоняет журнал и у задачи, которой слияния не будет.
    if (!/TERMINAL_CACHE_STATUS/.test(evSrc) || !/const terminal = TERMINAL_CACHE_STATUS\.includes\(t\.status\)/.test(evSrc)) {
      missing.push('scripts/firm-event.mjs: sync откладывает правку кэша по признаку «живо дерево» — у снятой человеком задачи слияния не будет никогда, и отсрочка станет вечной (Д-33)')
    }
    if (!/дерево задачи живо, патч отложен до слияния/.test(evSrc)) {
      missing.push('scripts/firm-event.mjs: doctor называет расхождение кэша без причины — вместе с `fixed: []` у sync это читается как «лечить отказался» (Д-33)')
    }
    if (!/blocked\.push/.test(evSrc)) {
      missing.push('scripts/firm-event.mjs: отказ ФС при правке кэша срывает весь sync — один закрытый песочницей файл отменит и события, и доску, и галочки остальных задач (Д-33)')
    }
    if (!/failed_merges_closed/.test(evSrc)) {
      missing.push('scripts/firm-event.mjs: отказ слияния у снятой человеком задачи краснит doctor навсегда — разбирать там нечего, слияния не будет (Д-33)')
    }
    // Д-31: проектирование молчит так же, как адъюдикация.
    if (!/stage === 'design' && ticket === 'unknown'/.test(evSrc)) {
      missing.push('scripts/firm-event.mjs: стадия проектирования без тикета пишет событие с ticket: unknown — привязать его не к чему и никогда не будет чем, а признак поломки привязки обесценивается (Д-31)')
    }
    // Д-35: реплика человека, приехавшая с заданием, называется событием и не исполняется.
    if (!/function humanNoteRule/.test(build) || (build.match(/humanNoteRule\(task\)/g) || []).length < 2) {
      missing.push('workflows/firm2-build.js: правило про реплику человека не стоит в промптах обеих стадий — утечка разговора в промпт останется невидимой (Д-35)')
    }
    if (!/human-note/.test(build)) {
      missing.push('workflows/firm2-build.js: утечке реплики человека не назначено событие guard/human-note — приписка в чужих notes не замеряется (Д-35)')
    }
    for (const role of ['developer', 'tester']) {
      const md = readFileSync(join(engine, 'agents', `${role}.md`), 'utf8')
      if (!/human-note/.test(md) || !/не часть задания/i.test(md)) {
        missing.push(`agents/${role}.md: роли не сказано, что реплика человека, приехавшая с заданием, не часть задания и называется событием (Д-35)`)
      }
    }
  }
  // Д-22 и Д-23 (отчёт проект-В 29.10.2026). Один и тот же дефект разбора ударил по двум
  // сторожам — отправки (Д-20) и расписки о ревью (Д-22), — поэтому разбор теперь один и
  // живёт в `lib/firm.mjs`: сторож, опознающий подкоманду подстрокой, держит читающие
  // команды (`merge-base`, `merge-tree`, `log --merges`) и текст heredoc, а сторож,
  // который держит чтение, обходят целиком. Д-23 про другое: `args` сборщика отдаётся
  // вставкой, он десятки килобайт, и его СОКРАТИЛИ — а `last_verdict.notes` уходит в
  // промпт стадии дословно.
  {
    const rr = readFileSync(join(engine, 'scripts', 'review-receipt.mjs'), 'utf8')
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    const lib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
    const buildCmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
    if (!/gitSubcommands/.test(rr) || /const MERGE = \//.test(rr)) {
      missing.push('scripts/review-receipt.mjs: слияние опознаётся подстрокой «merge», а не подкомандой — сторож отменяет `merge-base`, `merge-tree` и `log --merges`, то есть держит чтение, а не действие (Д-22)')
    }
    if (!/stripHeredoc/.test(rr)) {
      missing.push('scripts/review-receipt.mjs: тикет ищется во всей команде вместе с текстом heredoc — чужое упоминание задачи в теле сообщения подменит тикет слияния (Д-22)')
    }
    if (!/function gitSubcommands/.test(lib) || !/export function stripHeredoc/.test(lib)) {
      missing.push('scripts/lib/firm.mjs: разбор git-команды снова размножен по сторожам — этот дефект уже приезжал дважды (Д-20, Д-22), и починка одного сторожа не починит второй')
    }
    if (!/function argsIntegrity/.test(st) || !/integrity: argsIntegrity\(tasks\)/.test(st)) {
      missing.push('scripts/firm-state.mjs: build-args не печатает отпечаток своего вывода — сокращение входа сборщику нечем обнаружить (Д-23)')
    }
    if (!/ARGS\.integrity/.test(build) || !/ДО первой стадии/.test(build)) {
      missing.push('workflows/firm2-build.js: сборщик не сверяет целостность args и не останавливается до первой стадии — обрезанный вердикт уедет в промпт Разработчика как настоящий (Д-23)')
    }
    if (!/build-args --out/.test(buildCmd)) {
      missing.push('commands/firm-build.md: не названо, как передать args файлом — правило «не сокращать» без исполнимого пути один раз уже обошли (Д-23)')
    }
  }
  // Д-24, Д-25, Д-27, Д-28 (отчёты проект-В 29.10.2026). Три разных конца, но общий корень:
  // шаг сборки распоряжается тем, что ему не принадлежит, или не привозит то, что должен.
  {
    const st = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
    const buildCmd2 = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
    // Д-24: `-B` сбрасывает ветку задачи. Проверяется ОТСУТСТВИЕ ключа у стадии подготовки
    // и присутствие безопасного `-b`: это единственный способ отличить «починено» от
    // «переписан комментарий».
    if (/worktree add -B task\/\$\{task\.id\}/.test(build)) {
      missing.push('workflows/firm2-build.js: стадия подготовки зовёт worktree add -B — ветка задачи сбрасывается на вершину поставки, и своя работа задачи становится недостижимой по имени (Д-24, ADR-0009)')
    }
    if (!/worktree add -b \$\{br\}/.test(build) || !/refs\/firm2\/kept/.test(build)) {
      missing.push('workflows/firm2-build.js: подготовка не различает «ветки нет» и «у ветки есть своя работа» — либо откажет там, где надо создать, либо сбросит там, где надо сохранить (Д-24)')
    }
    if (!/worktree prune/.test(build)) {
      missing.push('workflows/firm2-build.js: битые регистрации деревьев не снимаются перед созданием — ветка числится занятой несуществующим деревом, и стадия падает на «already used by worktree» (Д-24)')
    }
    // Д-28: обратная сторона — существующее дерево надо подтянуть, а не «просто вернуть путь».
    if (!/merge --no-edit \$\{FEATURE_BRANCH\}/.test(build) || !/lagLine/.test(build)) {
      missing.push('workflows/firm2-build.js: повторный заход работает на отставшей ветке и не знает об этом числом — решение разбора до него не доезжает ни полем, ни файлом задачи (Д-28)')
    }
    // Д-25: карман кладётся адресно, подпись честная, чужое названо событием.
    // Образец по СОДЕРЖАНИЮ, без обратных кавычек: в исходнике они экранированы внутри
    // шаблонной строки, и образец с ними не совпадает ни с чем (эти грабли уже били).
    if (!/И ПЕРЕЧИСЛЕНИЕМ ПУТЕЙ/.test(build) || !/guard --event foreign-changes/.test(build)) {
      missing.push('workflows/firm2-build.js: карман шага слияния кладётся широкой сетью или чужие правки не называются — сборка уносит работу человека под подписью, по которой её не станут искать (Д-25)')
    }
    // Д-27: решение разбора доезжает до промпта отдельным полем.
    if (!/function lastArbitration/.test(st) || !/last_arbitration: lastArbitration/.test(st)) {
      missing.push('scripts/firm-state.mjs: решение разбора не отдаётся сборщику — задача возвращается в цикл с той эскалацией, на которой встала, и без решения (Д-27)')
    }
    if (!/task\.last_arbitration/.test(build) || !/РЕШЕНИЕ РАЗБОРА/.test(build)) {
      missing.push('workflows/firm2-build.js: решение разбора не попадает в промпт стадии — главная работа Оркестратора по маршруту до исполнителя не доходит (Д-27)')
    }
    if (!/last_arbitration/.test(buildCmd2)) {
      missing.push('commands/firm-build.md: не сказано, что текст разбора доезжает до исполнителя дословно — его будут писать телеграммой (Д-27)')
    }
  }
  // Д-26 (отчёт проект-В 29.10.2026). Причина остановки стадии обрезалась на 500 символах, и
  // обрезка молчала. Журнал только дописывается (ADR-0006) — дополнить событие задним
  // числом нечем, значит порча необратима, и проверка здесь про оба конца: что предела в
  // 500 больше нет и что сработавший предел помечается.
  {
    const ev2 = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
    if (/notes\)\.trim\(\)\.slice\(0, 5?00\)/.test(ev2)) {
      missing.push('scripts/firm-event.mjs: `notes` события снова режутся сотнями символов — причина эскалации в журнал не доедет, а дополнить его нечем (Д-26, ADR-0006)')
    }
    if (!/const NOTES_LIMIT/.test(ev2) || !/ev\.notes = fitNotes\(ev, notes\)/.test(ev2)) {
      missing.push('scripts/firm-event.mjs: предел на notes не один на все стадии — он снова разъедется по ветвям, и обрежется ровно та стадия, которую не проверяли (Д-26)')
    }
    if (!/notes_truncated = true/.test(ev2) || !/notes_full_chars/.test(ev2)) {
      missing.push('scripts/firm-event.mjs: обрезка не помечается — читатель не отличит её от роли, бросившей фразу на полуслове (Д-26)')
    }
    if (!/truncated_notes: truncated/.test(ev2)) {
      missing.push('scripts/firm-event.mjs: doctor не называет обрезанные события — пометка есть, а смотреть на неё некому (Д-26)')
    }
  }
  // Д-29 (отчёт проект-В 30.10.2026, дефект старше — признак не менялся с 0.4.38).
  // Доказательство «влито» обязано лежать НА ветке поставки, а не быть достижимым от её
  // вершины: слияние внутрь ветки задачи после её слияния доказывало что угодно. Две
  // страховки независимы намеренно — цена ошибки здесь стёртое решение человека.
  {
    const ev3 = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
    if (!/'--merges', '--first-parent'/.test(ev3)) {
      missing.push('scripts/firm-event.mjs: выборка мерж-коммитов не сужена первой родительской цепочкой — слияние ВНУТРЬ ветки задачи снова доказывает влитость, и штатный перенос работы меткой (refs/firm2/kept) гарантированно соврёт (Д-29, ADR-0005)')
    }
    if (!/terminalTs/.test(ev3) || !/\['superseded', 'cancelled'\]\.includes\(e\.event\)/.test(ev3)) {
      missing.push('scripts/firm-event.mjs: сверка дописывает слияние заменённой задаче — у неё слияние не пропущено, его не было, и ложное событие перебивает решение человека (Д-29, ADR-0009)')
    }
  }
  if (!/function devEvidence/.test(build) || !/\$\{devEvidence\(dev\)\}/.test(build)) {
    missing.push('workflows/firm2-build.js: слова Разработчика не доходят до Ревьюера — он судит «правит только своё» вслепую (та же починка, что у Тестировщика 04.10.2026)')
  }
  if (!/stage === 'dev' && so/.test(ev)) {
    missing.push('scripts/firm-event.mjs: structured output стадии разработки не попадает в журнал — после прогона от неё не остаётся ничего, кроме факта финиша')
  }
  // Роль обязана знать про поля, которые с неё спрашивают: схема без промпта — это
  // требование, о котором исполнитель не в курсе. Поимённой сверки здесь больше НЕТ:
  // с 0.4.96 весь этот класс берёт шаг 3у по всем восьми ролям и всем схемам сразу
  // (`lib/roles.mjs`). Список из двух файлов и одного поля отставал от жизни после
  // каждого разбора стадии — его надо было дописывать руками вслед за промптом.
  const devsrc = readFileSync(join(engine, 'agents', 'developer.md'), 'utf8')
  if (!/blocked/.test(devsrc) || !/escalate: true/.test(devsrc)) {
    missing.push('agents/developer.md: роли не сказано, чем отличаются fail, blocked и escalate — а цикл теперь ведёт себя по ним по-разному')
  }

  // Те же три конца у стадии Дизайнера (разбор 22.10.2026). Потребитель здесь не
  // сборщик, а команда планирования: прототип и замер нужны ДО ворот, и читает их
  // Оркестратор, а не код. Поэтому проверяется пара «поле выхода ↔ абзац команды».
  const dessrc = readFileSync(join(engine, 'agents', 'designer.md'), 'utf8')
  const plansrc = readFileSync(join(engine, 'commands', 'firm-plan.md'), 'utf8')
  if (!/measurements/.test(dessrc) || !/measurements/.test(plansrc)) {
    missing.push('стадия Дизайнера: замер некуда положить — роль обещает ключ measured задачи, а канала между её выходом и задачей нет (у Разработчика это был порт)')
  }
  if (!/open_questions/.test(plansrc) || !/status: "fail"|status `fail`|`status: "fail"`/.test(plansrc)) {
    missing.push('commands/firm-plan.md: статус и вопросы Дизайнера не читаются — стадия, промолчавшая про вопрос, промолчала про него навсегда')
  }
  // Концы стадии PM (разбор 22.10.2026): вопросы, статус и номера правил.
  const pmsrc = readFileSync(join(engine, 'agents', 'pm.md'), 'utf8')
  const plan = readFileSync(join(engine, 'commands', 'firm-plan.md'), 'utf8')
  // Только САМА строка схемы, а не абзац после неё. Первая редакция брала весь хвост
  // файла и пропускала мутацию: поле, убранное из схемы, находилось в объяснении под ней.
  // Та же ловушка, что с соседней схемой в DEV_SCHEMA, — проверка, видящая чужой текст,
  // не проверяет ничего.
  const planOut = (pmsrc.split('\n').find((l) => l.includes('Готово на планировании')) || '')
  if (!/open_questions/.test(planOut)) {
    missing.push('agents/pm.md: у выхода планирования нет open_questions — роль обязана перенести открытые вопросы (ADR-0007), а канала к воротам нет')
  }
  if (!/status: "ok"\|"fail"/.test(planOut)) {
    missing.push('agents/pm.md: статус стадии планирования не умеет быть провалом — proposal.md из догадок дальше становится задачами и кодом')
  }
  if (!/next-id --kind br/.test(pmsrc) || !/next-id --kind br/.test(plan)) {
    missing.push('номера BR: аллокатор есть, а роль или команда его не зовёт — «берёшь следующими свободными» снова станет арифметикой по документу')
  }
  // Концы стадии Технического писателя (разбор 22.10.2026). Главный здесь — не поле
  // схемы, а привязка: роль, которой нет в таблице стадий, пишет в журнал НИЧЕГО, и
  // пустая колонка дашборда читается как «стадия не шла».
  const evsrc = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  const buildmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const planmd = readFileSync(join(engine, 'commands', 'firm-plan.md'), 'utf8')
  for (const [role, stage] of [['firm-docwriter', 'docs'], ['firm-designer', 'design']]) {
    if (!new RegExp(`'firm2:${role}': '${stage}'`).test(evsrc)) {
      missing.push(`scripts/firm-event.mjs: ${role} нет в STAGE_BY_AGENT — стадия ${stage} не пишет в журнал ничего, а дашборд держит под неё колонку`)
    }
  }
  // Привязка стадии уровня поставки держится маркером в промпте — иначе событие уйдёт
  // `unknown`, и это дыра на неизменяемом журнале (И-7).
  for (const [rel, src] of [['commands/firm-build.md', buildmd], ['commands/firm-plan.md', planmd]]) {
    if (!/FIRM2-TICKET: MR/.test(src)) {
      missing.push(`${rel}: стадия уровня поставки запускается без маркера FIRM2-TICKET: MR — её событие уйдёт без привязки`)
    }
  }
  const docsrc = readFileSync(join(engine, 'agents', 'docwriter.md'), 'utf8')
  if (!/human_docs/.test(buildmd) || !/validate_specs_ok/.test(buildmd)) {
    missing.push('commands/firm-build.md: выход стадии архива не читается — поставка с несошедшимся архивом закрывается наполовину')
  }
  if (!/firm-human-docs/.test(buildmd) || !/firm-human-docs/.test(readFileSync(join(engine, 'templates', 'definition-of-done.md'), 'utf8'))) {
    missing.push('человеческий слой документации не требует ни команда, ни DoD — самый большой приём движка не зовёт никто')
  }
  if (!/firm-human-docs/.test(docsrc)) {
    missing.push('agents/docwriter.md: приём firm-human-docs не назван — каталог docs/ по Diátaxis не появится')
  }
  // Концы стадии DevOps (разбор 22.10.2026). Класс тот же, но крайний: стадия была
  // объявлена, описана и не вызывалась НИОТКУДА — PR/MR в маршруте не открывал никто,
  // хотя два следующих шага на него ссылаются, а DoD не читал никто, кроме этой роли.
  const devsrc2 = readFileSync(join(engine, 'agents', 'devops.md'), 'utf8')
  const modes = join(engine, 'templates', 'devops-modes.md')
  if (!/firm2:firm-devops/.test(buildmd)) {
    missing.push('commands/firm-build.md: роль закрытия не зовётся — PR/MR не открывает никто, хотя ревью постит вердикт В него, а шаг 6 его мержит')
  }
  if (!existsSync(modes)) {
    missing.push('templates/devops-modes.md: шаблона режимов DevOps нет — тело роли его не содержит, значит рецепт preflight потерян целиком')
  } else {
    const mtext = readFileSync(modes, 'utf8')
    if (!/definition-of-done/.test(mtext)) {
      missing.push('templates/devops-modes.md: DoD не назван — файл definition-of-done.md снова остался без читателя')
    }
    if (!/devops-modes\.md/.test(devsrc2)) {
      missing.push('agents/devops.md: шаблон режимов не назван — роль в режиме preflight пойдёт по памяти модели, а не по рецепту')
    }
    for (const rel of ['commands/firm-setup.md', 'commands/firm-build.md']) {
      const src = readFileSync(join(engine, rel), 'utf8')
      if (!/devops-modes\.md/.test(src)) {
        missing.push(`${rel}: режим DevOps не назван — без названного режима шаблон не читается`)
      }
    }
  }
  // Занижение учёта токенов — выбор, и он обязан быть сказан там, где числа показывают.
  for (const [rel, src] of [['commands/firm-build.md', buildmd], ['scripts/dashboard.mjs', readFileSync(join(engine, 'scripts', 'dashboard.mjs'), 'utf8')]]) {
    if (!/заниже/i.test(src)) {
      missing.push(`${rel}: число токенов показано без оговорки о занижении — механические вызовы DevOps событий не пишут, и их расход в учёт не попадает`)
    }
  }
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const stateSrc = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
  if (!/STAGES\.includes\(ev\.stage\)/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: record принимает любое имя стадии — словарь, не проверяемый на записи, отстаёт от жизни молча (стадия gate уехала в журнал проект-В 12.10.2026)')
  }
  // Д-44 (замер по журналу проект-В 02.11.2026): на старте транскрипт подагента несёт
  // преамбулу рантайма, а не промпт стадии, и маркера в нём ещё нет.
  if (!/export function labelMarkers/.test(firmlib) || !/\.meta\.json/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: на SubagentStart привязка держится только на транскрипте — с 28.10.2026 рантайм пишет первой строкой свою преамбулу, промпт стадии приходит второй, и старт уезжает с ticket: unknown (595 стартов из ~600 на проект-В). Платится этим отказ паузы: он стоит под условием «тикет известен» и не срабатывал ни разу')
  }
  // Поправка к Д-44 по отчёту проект-В 03.11.2026 (находка 2). Ярлык искался ПО ПУТИ
  // транскрипта, а транскрипта на старте нет вовсе: замер по стадии T-291 — событие
  // 13:43:07, мета-файл 13:43:09, транскрипт 14:07:04 (к финишу). Поэтому проверяются
  // обе половины починки: мета-файл ищется САМ и на старте его ЖДУТ.
  if (!/export function agentMetaPath/.test(firmlib) || !/labelFromMeta\(agentMetaPath\(/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: ярлык вызова ищется по пути транскрипта, которого на SubagentStart ещё нет — привязка старта не сработает ни разу (отчёт проект-В 03.11.2026: 1612 событий из 4338 без тикета, и все открывающие)')
  }
  if (!/BIND_WAIT_MS/.test(firmlib) || !/waitMs/.test(firmlib) || !/BIND_WAIT_MS : 0/.test(evsrc)) {
    missing.push('scripts/lib/firm.mjs + firm-event.mjs: мета-файл подагента не ждут на старте — рантайм пишет его на 1–2 с позже хука, и привязка не успевает появиться (замер проект-В: отставание 2 с)')
  }
  if (!/bind_wait_ms/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: ожидание привязки не попадает в событие — порог выражается в замеренном (ADR-0010), а механизм без замера нечем судить')
  }
  if (!/mr \? 'MR' : null/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: ярлык вызова не понимает метку MR — у стадий уровня поставки (MR-ревью, архив спеки, прототип) тикета нет по устройству, и их открытия останутся unknown даже с исправленным поиском мета-файла')
  }
  if (!/export function brFindings/.test(firmlib) || !/out\.push\(\.\.\.brFindings\(root, change\)\)/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: сверка номеров BR не подключена к находкам гейта — один номер на два правила увидит только тот, кто сверит руками')
  }
  // Ревизия основания сверки ДОКАЗЫВАЕТСЯ (разбор проект-В 02.11.2026): зонд называл одну
  // ревизию, а мерить мог другую — тёплое дерево `_base` переиспользуется намеренно.
  if (!/function provenRevision/.test(build) || (build.match(/provenRevision\(/g) || []).length < 3) {
    missing.push('workflows/firm2-build.js: ревизия основания сверки не доказывается — зонд называет sha из merge-base, а набор гонит в тёплом дереве, и непрошедший checkout отдаёт числа ЧУЖОЙ ревизии под верным именем (на проект-В так «красных 0» с ветки-цели уехало стадиям как точка ветвления)')
  }
  if (!/head: \{ type: 'string' \}/.test(build) || !/rev-parse HEAD/.test(build)) {
    missing.push('workflows/firm2-build.js: зонду основания не сказано вернуть head того дерева, где он гнал — доказывать ревизию нечем')
  }
  // Файл аргументов — единственный след входа волны (замер проект-В 02.11.2026).
  if (!/if \(existsSync\(dest\)\)/.test(stateSrc) || !/kept: where === dest \? null : dest/.test(stateSrc)) {
    missing.push('scripts/firm-state.mjs: build-args --out затирает файл прежней волны — вход прогона единственный его след (workflow на диск не пишет, ADR-0002), и разбор по стёртому входу уже уводил в сторону несущего механизма маршрута')
  }
  if (/build-args --out "\$TMPDIR\/args\.json"/.test(readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8'))) {
    missing.push('commands/firm-build.md: рецепт называет фиксированное имя файла аргументов — каждая следующая волна стирает вход предыдущей, и сверка стадии пойдёт с чужими args')
  }
  // Замеры проект-В 02.11.2026: словарь доски знал не все статусы, которые пишет движок, а
  // решение человека снять задачу не закрывало её календарь.
  {
    const dash = readFileSync(join(engine, 'scripts', 'dashboard.mjs'), 'utf8')
    const written = ['superseded', 'cancelled', 'blocked']
    for (const st of written) {
      if (!new RegExp(`^\\s*${st}: \\{ label:`, 'm').test(dash)) {
        missing.push(`scripts/dashboard.mjs: статуса «${st}» нет в STATUS_META, а движок его пишет — задачи с ним висят карточкой «статус вне словаря доски» (замер проект-В: 12 заменённых задач)`)
      }
    }
    if (!/const closed = \[\.\.\.ev\]\.reverse\(\)\.find/.test(firmlib) || !/idle_ms: merged \|\| closed \|\| openStage/.test(firmlib)) {
      missing.push('scripts/lib/firm.mjs: решение человека снять задачу не закрывает её календарь — «без движения» растёт у задачи, по которой постановлено, что движения не будет (замер проект-В: 182 ч из 584 ч на трёх снятых задачах)')
    }
  }
  // Д-15, вторая половина (проект-В, 02.11.2026): между выбором номера темы и появлением её
  // носителей есть работа, и это окно закрывает заявка в журнале — четвёртый источник
  // занятости. Проверяем обе стороны провода: источник и команду, которая его питает.
  if (!/export function groomClaims/.test(firmlib) || !/заявка в журнале/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: заявка на номер темы не считается занятостью — распределитель выдаст тот же номер второму спрашивающему, пока первый заводит дерево (Д-15: два столкновения в проект-В, оба разобраны переномерованием после факта)')
  }
  if (!/function groomClaim\(\)/.test(stateSrc) || !/case 'claim': return groomClaim\(\)/.test(stateSrc)) {
    missing.push('scripts/firm-state.mjs: заявку нечем подать — источник занятости есть, а команды под него нет: обе стороны провода написаны, а провода нет (Д-15)')
  }
  if (!/groom claim --title/.test(readFileSync(join(engine, 'commands', 'firm-discovery.md'), 'utf8'))) {
    missing.push('commands/firm-discovery.md: про заявку на номер не сказано разведке — механизм, о котором не знает единственный его пользователь, не работает (Д-15)')
  }
  // Д-42 (проект-В, 02.11.2026): форма определения BR сужена с двух сторон — отступ и знак
  // после номера. Проверяем содержательно: ведущий \s* в образце определения и наличие
  // спорных строк, которые нельзя выбрасывать молча (номер остался бы свободным).
  if (/const BR_DEF = \/\^\\s\*/.test(firmlib) || !/const BR_MAYBE/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: определением BR считается строка с отступом или без знака после номера — ссылка в теле правила станет «вторым определением», и находка гейта предложит перенумеровать существующие правила (Д-42 проект-В: шесть ложных находок, ни одного дубля)')
  }
  if (!/ambiguous/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: строка не той формы выбрасывается молча — ошибка в эту сторону оставляет номер свободным, и next-id выдаст его второму правилу (Д-42)')
  }
  if (!/export function sliceFindings/.test(firmlib) || !/out\.push\(\.\.\.sliceFindings\(root, change\)\)/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: сверка нарезки не подключена к находкам гейта — требование, закрытое двумя задачами без границы, будет написано кодом дважды (дефект Q, проект-В 3.2)')
  }
  if (!/export function designFindings/.test(firmlib) || !/out\.push\(\.\.\.designFindings\(root, change\)\)/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: находка о макете не подключена к находкам гейта — «прототип нужен человеку на воротах» написано в трёх местах и не проверяется ни одним')
  }
  // Двойной счёт токенов: у одного захода субагента финишей бывает несколько, и каждый
  // несёт полный счёт заново. Защита стоит в ЧИТАТЕЛЕ и держится на трёх проводах сразу —
  // схлопывание по заходу, его использование в сводке стадии и имя находки в `doctor`.
  // Любой из трёх, оборвавшись молча, вернёт завышение в полтора раза (замер проект-В 3.2:
  // 559.6M против 360.8M), и увидеть это будет негде: число останется правдоподобным.
  if (!/function latestPerAgent/.test(firmlib) || !/tokenUse\(allEvents\)\s*\{\s*\n\s*const events = latestPerAgent/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: tokenUse считает по событиям, а не по заходам — второй финиш одного субагента удвоит его расход')
  }
  if (!/const tk = tokenUse\(mine\)\.total/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: сводка стадии складывает токены событий мимо tokenUse — защита от двойного счёта стоит в одном месте и обойдена')
  }
  if (!/duplicate_finishes: duplicateFinishSummary\(/.test(evsrc)) {
    missing.push('scripts/firm-event.mjs: doctor не называет лишние финиши — расхождение дашборда с наивной суммой по файлам останется без имени')
  }
  // Находка 3 отчёта проект-В 03.11.2026: числа без ответа читаются как обвинение. Поле
  // звалось `inflated_by`, и 1,25 млрд прочитали как «учёт раздут», хотя дедупликация
  // стоит в читателе с 25.10.2026. Поэтому имя поля и сказанное вслух — часть механизма.
  if (/inflated_by:/.test(firmlib) && !/would_inflate_by:/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: лишние финиши названы полем inflated_by — оно утверждает, что учёт РАЗДУТ, и было прочитано буквально (отчёт проект-В 03.11.2026: вывод «цена поставки — шум» при работающей дедупликации)')
  }
  if (!/Двойной счёт снят/.test(readFileSync(join(engine, 'scripts', 'dashboard.mjs'), 'utf8'))) {
    missing.push('scripts/dashboard.mjs: про снятый двойной счёт не сказано — дашборд говорит о занижении и молчит о завышении, а соседний инструмент (doctor) называет завышение числом')
  }
  if (!/ui_tasks:/.test(readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8'))) {
    missing.push('scripts/firm-state.mjs: criteria не называет задачи с экраном и путь макета — человеку на воротах нечего открыть')
  }
  // ── Отчёт проект-В 03.11.2026: находки 4, 5, 6, 7 ────────────────────────────
  //
  // Находка 4. Номер бага выдавался «следующим свободным по docs/bugs главного дерева», а
  // пишут баг параллельные стадии, каждая в своём рабочем дереве: файла в главном дереве
  // нет до слияния, и одному номеру доставалось два хозяина. Три случая подряд.
  if (!/export function claimedIds/.test(firmlib) || !/'\.firm\/ids'/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: номер бага выдаётся без брони — файл бага пишется в рабочем дереве роли и в главном дереве невидим, так что «следующий свободный» отвечает одно и то же двум зовущим (отчёт проект-В 03.11.2026: BUG-158, BUG-159, BUG-171)')
  }
  if (!/flag: 'wx'/.test(firmlib)) {
    missing.push('scripts/lib/firm.mjs: броня номера кладётся не флагом wx — проверка «занято ли» обгоняется чужой записью, а атомарность здесь и есть весь механизм')
  }
  if (!/next-id --kind bug/.test(build)) {
    missing.push('workflows/firm2-build.js: адъюдикации не сказано брать номер бага командой — номер из промпта снова станет вторым источником того же номера (находка 4)')
  }
  if (/next_bug_ids: nextIds\(/.test(stateSrc)) {
    missing.push('scripts/firm-state.mjs: build-args снова считает пул номеров багов — пул живёт рядом со вторым источником того же номера, и это ровно столкновение находки 4')
  }
  // Находка 5. Потолок вызова 10 минут против набора в 43: роль уводит прогон в фон и
  // кончает ход. Два захода из двух при дословном запрете — значит держать это должен
  // механизм, а не промпт. Проверяем ВСЕ провода: скрипт, событие, промпты обеих ролей.
  if (!existsSync(join(engine, 'scripts', 'suite-run.mjs'))) {
    missing.push('scripts/suite-run.mjs: механизма долгого прогона нет — запрет «не уводи набор в фон» без исполнимого пути обходят, а не исполняют (отчёт проект-В 03.11.2026: два захода из двух, 43 минуты)')
  } else {
    const suite = readFileSync(join(engine, 'scripts', 'suite-run.mjs'), 'utf8')
    if (!/export function abandonedRuns/.test(suite) || !/suite-abandoned/.test(evsrc)) {
      missing.push('scripts/suite-run.mjs + firm-event.mjs: брошенный прогон не записывается событием — факт, который виден только роли, держится на её послушании (находка 5)')
    }
    if (!/function summarize/.test(suite)) {
      missing.push('scripts/suite-run.mjs: сводку раннера не снимает скрипт — роль назовёт причину красного по строкам из середины лога, как 03.11.2026 (pass 1103/fail 2 стояли в сводке, до которой она не дошла)')
    }
    if (!/import \{ abandonedRuns \} from '\.\/suite-run\.mjs'/.test(evsrc)) {
      missing.push('scripts/firm-event.mjs: признак брошенного прогона не подключён к хуку конца стадии — единственный момент, когда факт ещё можно записать (находка 5)')
    }
    if (!/if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\)/.test(suite)) {
      missing.push('scripts/suite-run.mjs: CLI исполняется при импорте — хук стадии, импортирующий abandonedRuns, упадёт на «неизвестной подкоманде» (защита входа есть в dashboard.mjs и обязана быть здесь)')
    }
  }
  for (const [rel, src] of [
    ['templates/devops-modes.md', readFileSync(join(engine, 'templates', 'devops-modes.md'), 'utf8')],
    ['agents/tester.md', readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')],
    ['commands/firm-build.md', buildmd],
  ]) {
    if (!/suite-run\.mjs/.test(src)) {
      missing.push(`${rel}: про механизм долгого прогона не сказано тому, кто гонит набор — механизм, о котором не знает его единственный пользователь, не работает (находка 5)`)
    }
  }
  // Находка 6. Механическая стадия отказалась работать, рассудив про номер попытки, и
  // приняла релейнутую реплику человека за своё задание. Сиблинги те же шаги выполнили.
  if (!/МЕХАНИЧЕСКАЯ/.test(build) || !/адресован ОРКЕСТРАТОРУ/.test(build)) {
    missing.push('workflows/firm2-build.js: стадии подготовки дерева не сказано, что она механическая и что реплики человека ей не задание — отказ «задание непонятно» уже стоил волны (находка 6, T-283 проект-В)')
  }
  // Находка 7. `codegraph diff-impact` падает `ENOBUFS` на диффе поставки (3245 файлов),
  // то есть шаг маршрута неисполним как написан. `branch-compare` на том же диффе прошёл.
  if (/codegraph diff-impact main\n/.test(buildmd) && !/branch-compare/.test(buildmd)) {
    missing.push('commands/firm-build.md: MR-ревью усиливается только diff-impact — на диффе поставки он падает с ENOBUFS, и шаг остаётся без ответа вовсе (находка 7: 3245 файлов, branch-compare прошёл)')
  }
  note(
    'схема стадии, промпт и потребитель сходятся (оборванных концов нет)',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — обе стороны провода написаны, а провода нет: инструкция выглядит исполняемой и не исполняется` : '',
  )
}

// ── 3т. Внешняя команда в промпте вызывается так, как она существует ─────────
// Разбор стадии PM 22.10.2026. Нашлось худшее из возможного: гейт формата, стоящий ПЕРЕД
// воротами человека, не проверял ничего. Промпт звал `openspec validate --strict --json`
// без имени поставки, а безымянная форма в openspec 1.11.0 отвечает «Nothing to validate…
// Or run in an interactive terminal» и кодом 1 — то есть роль получала отказ, не
// относящийся к документу, и «почини сам» чинило непроверенное.
//
// Это третий случай одного класса за две недели (`codegraph module_map`,
// `mattpocock-skills:verify`, теперь безымянный `validate`), и вывод из всех трёх один:
// текст промпта ничего не исполняет, поэтому неверный вызов молчит до живого прогона.
// Проверяем форму, а не существование команды: что openspec существует, знает шаг 3б.
//
// Второе здесь — ADR-0011. Имя чужого скила обязано жить в ОДНОМ файле, в приёме-адаптере.
// Команда груминга называла `mattpocock-skills:grilling` прямо, то есть точка изоляции
// была не одна, а две — и смена пина правилась бы в одной из них.
{
  const missing = []
  const texts = []
  for (const dir of ['agents', 'commands', 'skills', 'templates']) {
    const base = join(engine, dir)
    if (!existsSync(base)) continue
    const walk = (d) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, f.name)
        if (f.isDirectory()) walk(full)
        else if (/\.(md|example)$/.test(f.name)) texts.push([full.slice(engine.length + 1), readFileSync(full, 'utf8')])
      }
    }
    walk(base)
  }

  // `openspec validate` без имени и без --all/--changes/--specs/--archived не проверяет ничего.
  for (const [rel, src] of texts) {
    for (const line of src.split('\n')) {
      const m = line.match(/openspec validate([^\n`]*)/)
      if (!m) continue
      const rest = m[1]
      if (/--all|--changes|--specs|--archived/.test(rest)) continue
      if (/^\s+(?:<[\w-]+>|[A-Za-z][\w.-]*)/.test(rest)) continue
      missing.push(`${rel}: «openspec validate${rest.trim() ? ' ' + rest.trim() : ''}» без имени поставки — такая форма не проверяет НИЧЕГО (1.11.0: «Nothing to validate», код 1)`)
    }
  }

  // `--specs --all` — не «проверь спеки»: `--all` добавляет к проверке активные поставки
  // (прогнано на 1.11.0), и закрывающая проверка поставки краснеет от чужой работы. Это
  // тот же «чужой красный», который Ревьюеру запрещено считать основанием для отказа,
  // только здесь он приходил не из тестов, а из гейта документации.
  for (const [rel, src] of texts) {
    if (/--specs\s+--all|--all\s+--specs/.test(src)) {
      missing.push(`${rel}: «openspec validate --specs --all» проверяет не спеки, а всё — активная поставка соседа делает проверку красной`)
    }
  }

  // Имя внешнего скила — только в приёме-адаптере (ADR-0011).
  for (const [rel, src] of texts) {
    if (rel.startsWith('skills/')) continue
    if (rel === 'templates/firm-config.example') continue // пин версии набора — это настройка, а не вызов
    for (const line of src.split('\n')) {
      const m = line.match(/\b([a-z][\w-]*-skills):([\w-]+)/)
      if (!m) continue
      // Объяснение самого правила рядом с ним — не вызов: строка про разбор, а не про действие.
      if (/ADR-0011|делегиру|вход оси|не называется|никогда не существовал|поймали с/.test(line)) continue
      missing.push(`${rel}: имя внешнего скила ${m[1]}:${m[2]} названо вне приёма-адаптера — точка изоляции перестала быть одной (ADR-0011)`)
    }
  }

  note(
    'внешние команды в промптах вызываются существующей формой, чужие скилы — только через приём',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — неверный вызов в промпте молчит до живого прогона, а гейт, который ничего не проверяет, выглядит пройденным` : '',
  )
}

// ── 3ц. Вердикт MR-ревью доезжает до журнала ─────────────────────────────────
// Дефект P отчёта проект-В (23.10.2026). Задачное ревью отдаёт вердикт схемой сборщика
// (`VERDICT_SCHEMA`), и хук переводит его в `accepted`/`rejected`. Стадию уровня поставки
// запускает ТЕКСТ команды, схемы у неё нет — значит хуку нечего читать, и он пишет
// `review/finished` с пустыми `notes`. Замер: все семь событий MR-ревью с 03.10.2026 по
// 23.10.2026 легли именно так, то есть за шесть поставок вердикт по диффу целиком не
// попал в журнал ни разу.
//
// Лечится не хуком, а командой: §4 просит у роли четыре поля и пишет событие сам.
// Проверяем оба конца — запрос полей и запись события, плюс сеть под ними в сверке.
{
  const cmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const ev = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  const want = [
    { src: cmd, file: 'commands/firm-build.md', re: /criteria_results[\s\S]{0,1200}--stage review --event accepted/, what: 'команда просит поля вердикта и пишет событие ревью поставки' },
    { src: cmd, file: 'commands/firm-build.md', re: /mr_review_without_verdict/, what: 'сказано, чем отзовётся пропуск (поле сверки)' },
    { src: ev, file: 'scripts/firm-event.mjs', re: /mr_review_without_verdict/, what: 'сверка называет закрытое MR-ревью без вердикта' },
  ]
  const missing = want.filter((w) => !w.re.test(w.src)).map((w) => `${w.file}: нет «${w.what}»`)
  note(
    'вердикт MR-ревью доезжает до журнала',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — дефект P: шесть поставок закрылись без записанного вердикта` : '',
  )
}

// ── 3щ. Стадии разведки привязаны к теме, и привязка одна на весь движок ────
// Заведено 25.10.2026. До этого груминг писал события с `ticket: MR` и `change: null`:
// `doctor` зелёный, но стоимость разведки по темам посчитать было нечем, и ретро проект-В
// 3.2 пришлось спаривать события по `agent_id`.
//
// Четыре конца, и каждый уже был неправдой по ходу работы:
//   1. образец маркера ОДИН на движок. Копий было две — `lib/firm.mjs` и
//      `firm-event.mjs`, — и обе читали один и тот же промпт: правка привязки требовала
//      помнить про вторую, а разойтись они могли молча;
//   2. стадию разведки выдаёт МАРКЕР, а не роль: иначе Архитектор на груминге писал бы
//      `adjudicate`, то есть отдал бы тайминг поставки чужому интервалу;
//   3. маркер стоит во всех ТРЁХ шагах `/firm-discovery`: тема, у которой записан один
//      шаг из трёх, даёт замер, который врёт в меньшую сторону и выглядит правдой;
//   4. номер темы не попадает в занятые номера задач.
{
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const ev = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  const disc = readFileSync(join(engine, 'commands', 'firm-discovery.md'), 'utf8')
  const marks = (disc.match(/FIRM2-GROOM:\s*G-/g) || []).length
  const want = [
    { ok: /export const MARKER_GROOM_RE/.test(firmlib), what: 'lib/firm.mjs: образец маркера темы' },
    { ok: /export function markersIn/.test(firmlib), what: 'lib/firm.mjs: один разбор маркеров на все источники' },
    { ok: !/^const (?:TICKET|GROOM|CHANGE|ATTEMPT)_RE =/m.test(ev), what: 'firm-event.mjs: своих копий образцов нет' },
    { ok: /markersIn/.test(ev), what: 'firm-event.mjs: разбор берётся из lib' },
    { ok: /groomed \? 'groom' : STAGE_BY_AGENT\[agentType\]/.test(ev), what: 'стадию разведки выдаёт маркер, а не роль' },
    { ok: /'groom',/.test(firmlib), what: 'стадия groom в словаре STAGES' },
    { ok: /\/\^G-\/\.test\(e\.ticket\)/.test(firmlib), what: 'номер темы не идёт в занятые номера задач' },
    { ok: /export function groomCost/.test(firmlib), what: 'замер стоимости разведки по темам' },
    { ok: marks >= 3, what: `маркер во всех трёх шагах /firm-discovery (нашлось ${marks})` },
  ]
  const missing = want.filter((w) => !w.ok).map((w) => `нет «${w.what}»`)
  note(
    'стадии разведки привязаны к теме, а образец маркера один',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — разведка снова станет единственной стадией маршрута без цены` : '',
  )
}

// ── 3ш. Объявленные границы модулей сверяются с диффом ──────────────────────
// Замер проект-В 25.10.2026. Вопрос был про связанность — кто следит, чтобы Разработчик не
// наращивал её. Ответ замера: следить не за чем. 24 задачи поставки 3.2 добавили 7 рёбер
// между модулями, все семь — обвязка новых модулей самой поставки; горячие файлы проекта
// (fan-in 117, 98, 87) она не тронула вовсе. Проверка на рост связанности сработала бы на
// пяти задачах из двадцати четырёх законно, то есть была бы шумом.
//
// Нашлось другое, и оно того же класса, что N, O, P и Q: критерий написан, читать его
// некому. Архитектор пишет в `design.md` решение «Границы модулей» — дерево, где у каждой
// строки свой глагол, и «НЕ меняется» / «НЕ затронуты ни одной строкой» это объявление, а
// не пояснение. Сверка с диффом 3.2: из восьми объявлений нарушены два
// (`app/ruleset/schema.py` получил новое поле, `app/game/creation.py` — правку), и обе
// нарушенные границы прошли всю поставку незамеченными.
//
// Проверяем три конца: саму сверку, правило в промпте того, кто границы пишет, и чтение
// находок там, где дифф уже существует, — на ревью ПОСТАВКИ (на планировании диффа нет,
// поэтому в `criteriaFindings` этой сверки нет намеренно).
{
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const state = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
  const arch = readFileSync(join(engine, 'agents', 'architect.md'), 'utf8')
  const cmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const want = [
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /export function boundaryFindings/, what: 'сверка объявленного с диффом' },
    // Кириллица и `\b`: `/\bНЕ/` в JS не совпадает НИ С ЧЕМ, потому что `\w` только ASCII.
    // Первая редакция правила дала ноль находок на документе, где их восемь, — и молчание
    // выглядело как «границы соблюдены». Держим признак в коде: класс Unicode, флаг `u`.
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /\\p\{L\}[\s\S]{0,40}\/iu/, what: 'глагол границы ищется по-юникодному, а не через ASCII-\\b' },
    { src: state, file: 'scripts/firm-state.mjs', re: /case 'boundaries'/, what: 'команда boundaries' },
    { src: arch, file: 'agents/architect.md', re: /Границы модулей — деревом/, what: 'правило в промпте Архитектора' },
    { src: cmd, file: 'commands/firm-build.md', re: /firm-state\.mjs" boundaries/, what: 'ревью поставки читает сверку' },
    // Граница, называющая не путь, диффом не сверяется НИКОГДА — и молчит как соблюдённая.
    // Замер 05.11.2026: 2 из 53 объявленных границ четырёх проектов (CSS-селектор
    // `.game-console-view` и файл, которого нет вовсе) прошли ворота со словами «находок
    // нет». Поэтому отсутствие пути — находка, а не тишина (И-12), и правило об этом стоит
    // в промпте того, кто границы пишет.
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /сверить её диффом НЕЧЕМ/, what: 'граница без существующего пути называется находкой, а не зачитывается молча' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /cat-file', '-e', `\$\{target\}:\$\{f\.path\}`/, what: 'существование границы проверяется в ревизии сверки, а не только в рабочем дереве' },
    { src: arch, file: 'agents/architect.md', re: /назови файл/, what: 'правило «граница — путь файла» сказано Архитектору' },
    // Перенос строки дерева. Отчёт проект-В Д-54: строка не поместилась, пояснение
    // продолжилось ниже под своей колонкой, и хвост переноса стал путём
    // `web/src/screens/player/.game-console-view`. Родня 0.4.126 — разбор не отличал
    // продолжение от записи. Признак переноса — выравнивание, и держать его текстом
    // недостаточно: ниже этот же случай проверяется разбором живой формы.
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /indent >= cont\.col/, what: 'перенос пояснения отличается от новой записи по колонке' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /f\.kind !== 'depends'/, what: 'род границы, не проверяемый диффом, называется своим словом, а не словом неизменности' },
  ]
  const missing = want.filter((w) => !w.re.test(w.src)).map((w) => `${w.file}: нет «${w.what}»`)
  note(
    'объявленные границы модулей сверяются с диффом поставки',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — объявление и код расходятся молча, и следующая поставка режется по неверной карте` : '',
  )

  // Живая форма, снятая с `design.md` проект-В. Текстовая проверка выше зеленела бы и на
  // разборе, который снова склеивает перенос с каталогом: путь выглядит настоящим, а
  // сверка его не найдёт никогда.
  const tree = [
    '```',
    'web/src/',
    '└── screens/player/',
    '    ├── game.css        ПРАВИТСЯ: разрешение не гасить и прокрутка (D15). Правило',
    '    │                   .game-console-view .board-viewctl (:420) НЕ ТРОГАЕТСЯ',
    '    └── LobbyScreen.tsx НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ — органа в лобби нет',
    '```',
  ].join('\n')
  const parsed = declaredFrozen(tree)
  const holes = []
  if (parsed.some((f) => /game-console-view|^\.|[│├└─]/.test(f.path))) {
    holes.push(`хвост переноса или глиф взят за путь: ${parsed.map((f) => f.path).join(', ')}`)
  }
  if (parsed.length !== 1 || parsed[0].path !== 'web/src/screens/player/LobbyScreen.tsx') {
    holes.push(`границей объявлено не то: ${JSON.stringify(parsed.map((f) => f.path))} вместо одного LobbyScreen.tsx`)
  }
  note(
    'перенос строки дерева не становится границей, а дописывается к своей записи',
    holes.length === 0,
    holes.join('; '),
  )
}

// ── 3ч. Граница между задачами, делящими требование ─────────────────────────
// Дефект Q отчёта проект-В (23.10.2026). Выгрузка сущности файлом написана ДВАЖДЫ
// независимо: `T-113` отвечала за способность, `T-116` реализовала её же в каркасе
// раздела, и обе ссылались на одно требование спек-дельты, не называя друг друга.
//
// Проверка смотрит на три конца, потому что находка без инструкции — упрёк без адреса:
// сама сверка в `lib/firm.mjs` (её подключение держит сверка проводов выше), правило в
// промпте Архитектора, который нарезку и делает, и слова на гейте планирования — там,
// где разрез ещё переносят текстом, а не кодом.
//
// Отдельно держится ГРАНИЦА ШУМА. Отчёт предлагал считать находкой само деление
// требования между задачами; замер той же поставки на состоянии ворот дал 11 групп общих
// требований из 26 — то есть такая проверка срабатывала бы почти всегда и не отличалась
// бы от молчания. Поэтому находкой объявлено отсутствие границы (`depends_on` или имя
// другой задачи в тексте), и на том же замере находок стало 3 из 11. Если из кода уйдёт
// любой из двух способов назвать границу, проверка снова станет шумом — это и держит
// последняя строка списка.
{
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const arch = readFileSync(join(engine, 'agents', 'architect.md'), 'utf8')
  const plan = readFileSync(join(engine, 'commands', 'firm-plan.md'), 'utf8')
  const want = [
    { src: arch, file: 'agents/architect.md', re: /Требование, попавшее в две задачи/, what: 'правило нарезки в промпте того, кто режет' },
    { src: plan, file: 'commands/firm-plan.md', re: /границы между ними нет/, what: 'находка названа на гейте планирования' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /depends_on\.includes\(b\.id\)[\s\S]{0,200}names\.has/, what: 'оба способа назвать границу: depends_on и имя задачи в тексте' },
  ]
  const missing = want.filter((w) => !w.re.test(w.src)).map((w) => `${w.file}: нет «${w.what}»`)
  note(
    'требование, делимое задачами, требует названной границы',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — дефект Q: один сценарий написан кодом дважды независимо` : '',
  )
}

// ── 3х. Закрытие поставки: два пути и названная граница шага ────────────────
// Дефект N отчёта проект-В (23.10.2026, `docs/firm2/engine-report-2026-10-23.md` проекта).
// Рецепт закрытия знал ровно один путь — «commit → push → открой PR/MR по `vcs.host`», —
// а `vcs.host` в проекте был снят решением человека. Пункт стал неисполним, границы шага
// нигде не назывались, и роль закрыла пробел тем, что выглядело продолжением: слила
// поставку в main, заархивировала спеку (чужой шаг 5а) и записала `release/finished` на все
// 24 задачи ДО MR-ревью и демо-ворот. Журнал только дописывается — ложные события выпуска
// остались в нём навсегда, git пришлось возвращать переводом указателей.
//
// Класс дефекта тот же, что в восьми разборах стадий: обе стороны провода написаны по
// отдельности. Поле `mode: "local"` в выходе роли есть с 0.4.95, команда его читает — а
// рецепт о локальном пути молчал. Поэтому проверка смотрит на ОБА конца: ветка «host не
// задан» в рецепте и названная граница шага в рецепте, роли и команде.
{
  const modes = readFileSync(join(engine, 'templates', 'devops-modes.md'), 'utf8')
  const role = readFileSync(join(engine, 'agents', 'devops.md'), 'utf8')
  const cmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const want = [
    { src: modes, file: 'templates/devops-modes.md', re: /НЕ задан.*[\s\S]{0,400}mode: "local"/, what: 'ветка «vcs.host не задан» с ответом mode: "local"' },
    { src: modes, file: 'templates/devops-modes.md', re: /ничего не мержи и не\s*архивируй/, what: 'запрет мержа и архива на локальном пути' },
    // Push на локальном пути и цена его провала. Поставлено 23.10.2026 по вопросу человека
    // «почему теперь проект-В сам не может пушить»: правка дефекта N провела границу по чужим
    // шагам (мерж, архив, выпуск), а push попал под «остановись» заодно, без довода. Ветка
    // поставки — своя работа роли, и без push она живёт в одной копии на одной машине ровно
    // там, где PR её наружу не выносит. Вторая строка не менее важна первой: замер того же
    // дня показал, что под песочницей сессии push по https на GitHub падает (учётные данные
    // выдаёт `gh`, а его конфиг песочница не читает) — то есть инструкция «пушить» без
    // «провал это замечание» ронял бы закрытие каждой поставки на этой машине.
    { src: modes, file: 'templates/devops-modes.md', re: /push ветки поставки/, what: 'push ветки поставки на локальном пути' },
    { src: modes, file: 'templates/devops-modes.md', re: /Провал push — замечание в `notes`, а не блокер/, what: 'провал push не роняет закрытие поставки' },
    { src: modes, file: 'templates/devops-modes.md', re: /could not read Username/, what: 'назван замеренный случай провала (песочница и gh-helper)' },
    { src: modes, file: 'templates/devops-modes.md', re: /Где кончается твой шаг/, what: 'граница шага названа отдельным разделом' },
    { src: modes, file: 'templates/devops-modes.md', re: /release\/finished[\s\S]{0,120}post-merge/, what: 'событие выпуска отдано git-хуку, а не роли' },
    { src: role, file: 'agents/devops.md', re: /Чужой шаг не исполняй/, what: 'запрет исполнять чужой шаг в границах роли' },
    { src: cmd, file: 'commands/firm-build.md', re: /где его шаг кончается/, what: 'команда называет границу в промпте стадии' },
  ]
  const missing = want.filter((w) => !w.re.test(w.src)).map((w) => `${w.file}: нет «${w.what}»`)
  note(
    'закрытие поставки знает два пути и свою границу',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — дефект N: роль, которой не дали второго пути, объявила выпуск сама` : '',
  )
}

// ── 3ф. Рецепт закрытых секретов на демо ─────────────────────────────────────
// Д-9 (`docs/pilot-checklist.md`): на демо-воротах 24.09.2026 роль дважды подряд пришла к
// снятию песочницы, потому что инструкция о закрытых секретах молчала вовсе. Текст
// поставили в 0.4.13, а в 0.4.97 у него появилась вторая половина, и она не косметическая:
// падения два, и лечатся они по-разному. «Не пришло значение» лечат одноразовые переменные
// окружения; «не читается сам файл» (`PermissionError` в кадре загрузчика) ими не лечится
// вовсе — замер 22.10.2026: `load_dotenv` на файле с правами `000` бросает `PermissionError`,
// то есть падение случается ДО того, как кто-то смотрит на ключи.
//
// Проверка текстовая, как 3ж–3и: правило обращено к роли и исполняется промптом. Её
// задача одна — чтобы различение двух падений и запрет снимать защиту нельзя было удалить,
// не заметив. Уйдёт различение — роль начнёт перебирать переменные там, где они бессильны,
// и придёт к тому же, к чему пришла на пилоте.
{
  const src = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const want = [
    { re: /PermissionError/, what: 'падение «не читается сам файл» названо тем, что видно в трейсбеке' },
    { re: /пункт 1 пропускается/, what: 'при отказе чтения файла пункт с переменными пропускается' },
    { re: /перезапускаться без песочницы/, what: 'запрет снимать защиту ради демо' },
    { re: /ADR-0009/, what: 'запрет обоснован решением человека, а не наличием команды /sandbox' },
  ]
  const missing = want.filter((w) => !w.re.test(src)).map((w) => `commands/firm-build.md: нет «${w.what}»`)
  note(
    'рецепт закрытых секретов на демо различает два падения',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — Д-9: роль, которой не сказали, приходит к снятию песочницы` : '',
  )
}

// ── 3э. Путь пользователя: вход ворот, видящий ОТСУТСТВИЕ шага ───────────────
// Отчёт проект-В 03.11.2026, запрошено человеком. Поставка прошла ворота со ВСЕМИ зелёными
// гейтами (217 критериев на 25 задач, ноль находок, девять волн при поле девять) и была
// принята — не имея второго шага из четырёх: перехода «создана» → «сбор игроков», который
// по ADR принадлежит другой роли. Ни требования, ни задачи, ни спеки, ни команды пульта.
//
// Почему это новый вход, а не правка старого гейта: все пять сверяют СВЯЗНОСТЬ плана с
// тем, что в плане есть, а отсутствие нельзя найти сверкой с тем, что есть. Таблица шагов
// — единственный артефакт ворот, в котором путь обязан быть непрерывным, то есть
// отсутствие шага в нём ВИДНО.
//
// Проверяются два разных сорта вещей, и по отдельности ни один не достаточен:
//   а) провод целиком — сверка, команда, вход прогона, оба промпта и шаблон. Класс
//      «обе стороны написаны, а провода нет» ловился здесь восемь раз;
//   б) само свойство — живым прогоном по одноразовому каталогу: разорванный путь обязан
//      дать все четыре находки, целый — ни одной. Текстовая проверка пункта «а» зеленела
//      бы и на сверке, которая всегда молчит.
{
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const state = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
  const plan = readFileSync(join(engine, 'commands', 'firm-plan.md'), 'utf8')
  const arch = readFileSync(join(engine, 'agents', 'architect.md'), 'utf8')
  const want = [
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /export function userPathFindings/, what: 'сверка пути' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /BY_DESIGN/, what: 'законный разрыв снимается названной причиной (приём exclusive_why)' },
    // Второй род законного разрыва: назван человеку, решения нет. Без него Архитектору
    // оставалось либо соврать «по замыслу», либо принять находку, велящую ему решить то,
    // что решает человек (против ADR-0009). Случай проект-В 04.11.2026.
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /OPEN_Q/, what: 'нерешённый разрыв уходит вопросом, а не дефектом' },
    { src: plan, file: 'commands/firm-plan.md', re: /вопросов по пути нет/, what: 'ворота называют вопросы пути вслух, включая их отсутствие' },
    { src: state, file: 'scripts/firm-state.mjs', re: /case 'user-path'/, what: 'команда user-path' },
    // Ворота — промпт, и промптом эту проверку держать нельзя: восьмой вход без машинного
    // читателя стал бы восьмой просьбой. Читатель — `build-args`, то есть КОД перед волной.
    { src: state, file: 'scripts/firm-state.mjs', re: /userPathFindings\(root, change\)/, what: 'находки пути едут во вход прогона (build-args)' },
    { src: plan, file: 'commands/firm-plan.md', re: /firm-state\.mjs" user-path/, what: 'гейт планирования зовёт проверку' },
    { src: plan, file: 'commands/firm-plan.md', re: /1\.\s\*\*путь пользователя\*\*/, what: 'путь стоит ПЕРВЫМ входом ворот' },
    { src: arch, file: 'agents/architect.md', re: /user-path\.md/, what: 'правило в промпте Архитектора — он его и пишет' },
  ]
  const missing = want.filter((w) => !w.re.test(w.src)).map((w) => `${w.file}: нет «${w.what}»`)
  if (!existsSync(join(engine, 'templates', 'user-path.example.md'))) {
    missing.push('templates/user-path.example.md: шаблона нет — промпт Архитектора ссылается на него')
  }
  note(
    'путь пользователя: вход ворот 1 проведён целиком',
    missing.length === 0,
    missing.length ? `${missing.join('; ')} — без любого из концов восьмой вход остаётся просьбой в промпте` : '',
  )

  // Живая проверка свойства. Каталог одноразовый: путь роли из трёх шагов, где второй
  // чужой и ничем не сделан, третий опирается на отменённое правило, а задача названа не
  // из этой поставки. Это восстановленный случай проект-В плюс три остальные находки.
  const dir = mkdtempSync(join(tmpdir(), 'firm2-userpath-'))
  try {
    mkdirSync(join(dir, 'openspec', 'changes', 'ch', 'tasks'), { recursive: true })
    writeFileSync(join(dir, 'openspec', 'changes', 'ch', 'tasks', 'T-001.md'), '---\nid: T-001\nstatus: todo\n---\n\n- [ ] критерий\n')
    mkdirSync(join(dir, 'docs', 'product'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'product', 'BRD.md'), '# BRD\n- **BR-7.** Ведущий заводит партию.\n- ~~**BR-23.**~~ Ведущий закрывает вход — superseded by BR-238.\n')
    const head = ['| шаг | кто исполняет | чем разрешено | чем сделано |', '|---|---|---|---|']
    const write = (rows) => writeFileSync(
      join(dir, 'openspec', 'changes', 'ch', 'user-path.md'),
      ['## Путь: ведущий', 'цель: завести партию и начать её', ...head, ...rows].join('\n') + '\n',
    )
    const read = (field) => {
      const r = run(['node', join(engine, 'scripts', 'firm-state.mjs'), 'user-path', '--root', dir, '--change', 'ch', '--json'])
      try {
        return JSON.parse(r.stdout || '{}')[field] || null
      } catch {
        return null
      }
    }
    const ask = () => read('findings')
    const askQuestions = () => read('open_questions')

    write([
      '| завести партию | ведущий | BR-7 | T-001 |',
      '| открыть вход: «создана» → «сбор игроков» | Админ | BR-7 | — |',
      '| закрыть вход | ведущий | BR-23 | T-777 |',
    ])
    const bad = ask()
    const classes = [
      { re: /прерывается на шаге/, what: 'чужая роль посреди пути своей' },
      { re: /ничем не сделан/, what: 'новое поведение без задачи' },
      { re: /ОТМЕНЕНО/, what: 'право по отменённому правилу' },
      { re: /T-777/, what: 'задача не из этой поставки' },
    ]
    const gaps = bad === null
      ? ['команда не ответила разбираемым JSON']
      : classes.filter((c) => !bad.some((f) => c.re.test(f))).map((c) => `не названо: ${c.what}`)

    write([
      '| завести партию | ведущий | BR-7 | T-001 |',
      '| открыть вход | Админ — по замыслу: вход открывает он | BR-7 | существует, не трогаем |',
      '| узнать адрес бота | Админ — ждёт решения: в продукте его нет нигде | BR-7 | вне продукта |',
    ])
    const good = ask()
    if (good === null) gaps.push('на целом пути команда не ответила разбираемым JSON')
    else if (good.length) gaps.push(`целый путь дал ${good.length} находок (${good[0].slice(0, 80)}) — проверка, шумящая на верном пути, будет обойдена`)
    // Нерешённый разрыв обязан быть НАЗВАН, а не просто промолчать: он уходит вопросом
    // человеку. Молчание здесь было бы хуже находки — вопрос исчез бы вместе с ней.
    const q = askQuestions()
    if (!q || !q.length) gaps.push('нерешённый разрыв («ждёт решения: …») не назван ни находкой, ни вопросом — он исчез')
    else if (!q.some((x) => /адрес бота/.test(x))) gaps.push(`вопрос назван без причины автора: ${q[0].slice(0, 80)}`)

    // Оговорка в клетке исполнителя при СВОЕЙ роли. Замер 05.11.2026 на первой живой
    // поставке под этими воротами (проект-В, G-018): «игрок — по замыслу: …» в четырёх
    // клетках превратилось в «исполнителей 4 (игрок, игрок — по замыслу: решение
    // человека…, …)» — число завышено вчетверо, а причины разрывов вывалились целыми
    // фразами в строку, ради краткости которой она и заведена. Вторая половина того же
    // замера: «игрок — ждёт решения: …» уходило в ТИШИНУ, потому что признак нерешённого
    // стоял под `!sameRole`, а клетка начиналась с имени своей роли.
    write([
      '| завести партию | ведущий | BR-7 | T-001 |',
      '| открыть вход | ведущий — по замыслу: вход открывает он сам | BR-7 | T-001 |',
      '| узнать адрес бота | ведущий — ждёт решения: в продукте его нет нигде | BR-7 | T-001 |',
    ])
    const own = run(['node', join(engine, 'scripts', 'firm-state.mjs'), 'user-path', '--root', dir, '--change', 'ch'])
    const gate = (own.stdout || '').split('\n').find((l) => /ведущий: шагов/.test(l)) || ''
    if (!gate) gaps.push('строки ворот «<роль>: шагов N» нет вовсе — человек читает именно её')
    else if (/исполнителей|по замыслу|ждёт решения/.test(gate)) {
      gaps.push(`оговорка в клетке исполнителя сосчитана второй ролью и вывалилась в строку ворот: ${gate.trim().slice(0, 90)}`)
    }
    const ownQ = askQuestions()
    if (!ownQ || !ownQ.some((x) => /адрес бота/.test(x))) {
      gaps.push('нерешённое при СВОЕЙ роли промолчало: «ведущий — ждёт решения: …» не ушло вопросом, и молчание сошло за «решено» (И-12)')
    }
    const ownBad = ask()
    if (ownBad && ownBad.length) gaps.push(`оговорка при своей роли дала находку: ${ownBad[0].slice(0, 80)}`)

    // Оговорка пишется ПРОЗОЙ: между словом и двоеточием стоят слова. Отчёт проект-В Д-54
    // (замер 06.11.2026): признак требовал двоеточия сразу после «решения», а естественный
    // порядок — «ждёт решения ЧЕЛОВЕКА: …». Последствий два, и оба хуже находки: такая
    // клетка в «чем сделано» не давала НИ находки, ни вопроса (шаг, не сделанный ничем,
    // проходил ворота молча), а «по замыслу человека: …» в клетке исполнителя давало
    // ЛОЖНУЮ блокирующую находку, велящую переписать роль.
    write([
      '| завести партию | ведущий | BR-7 | T-001 |',
      '| открыть вход | Админ — по замыслу человека: вход открывает он лично | BR-7 | T-001 |',
      '| узнать адрес бота | ведущий | BR-7 | ждёт решения человека: адреса бота в продукте нет |',
      '| выставить порог | ведущий | ждёт решения человека по Н-8: правила на это нет | T-001 |',
    ])
    const prose = ask()
    const proseQ = askQuestions()
    if (prose === null || proseQ === null) gaps.push('на прозаической форме оговорки команда не ответила разбираемым JSON')
    else {
      if (prose.length) gaps.push(`«по замыслу человека: …» прочтено как разрыв без причины — ложная находка: ${prose[0].slice(0, 90)}`)
      if (proseQ.length !== 2) {
        gaps.push(
          `«ждёт решения человека: …» дало ${proseQ.length} вопрос(ов) вместо двух — ` +
          `оговорка со словом между словом и двоеточием уходит в тишину, а клетка «чем ` +
          `сделано» при этом НЕ пуста, то есть дыру «заявлено, задачи нет» признак тоже не видит`,
        )
      }
    }

    note(
      'путь пользователя: разорванный путь даёт все четыре находки, целый — ни одной, нерешённый — вопрос',
      gaps.length === 0,
      gaps.join('; '),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 3ю. Два слоя сверки секретов и доказанный хозяин красного ────────────────
// Отчёт проект-В 04.11.2026 (Д-47, Д-48 и два следствия). Здесь закрепляется не поведение —
// оно под тестами, — а ПРОВОД: доезжает ли механизм до проекта и сказан ли он той роли,
// которой адресован. Класс «механизм написан, а провода нет» ловился восемь раз.
//
// Четыре вещи, и каждая проваливалась по-своему:
//   а) второй слой сверки — git-хук `pre-commit`. Первый слой (`PreToolUse`) видит только
//      знакомые формы команд, и коммит ушёл через `merge --continue`. Хук доезжает
//      КОПИЕЙ, значит его обязаны копировать и `/firm-setup`, и `/firm-build`, и `adopt`,
//      причём каталогом: поимённый список отстал бы, как отставала копия post-merge;
//   б) каталог шаблонов читается, а не перечисляется (`readdirSync`) — иначе третий хук
//      появится так же незаметно, как второй;
//   в) объявления границ рисуются ASCII-деревом, и разбор обязан знать глифы: на живом
//      `design.md` поставки G-014 все 23 записи имели `path` равным `│`, то есть шаг
//      маршрута оставался без машины ровно на той форме, которой границы и объявляются;
//   в2) у мержа родителей ДВА, и сторож секретов судил его по одному: всё, что пришло со
//      второй ветки, читалось как добавленное этим коммитом. Замер проект-В на мерже
//      `main` → `3d` — 21 блокирующая находка, своих строк ноль при 89 конфликтных
//      файлах. Оговоркой это не лечится по устройству: строки лежат в чужой линии, и в
//      следующий мерж придут снова;
//   г) `delivery_red` сверяется снимками, и Тестировщику это сказано. Имя, не найденное
//      ни на точке ветвления, ни на ветке-цели, уезжает к человеку словами «НЕ
//      ПОДТВЕРЖДЕНО»: иначе красное снимается с себя пустой строкой (класс Д-43).
{
  const hooksDir = join(engine, 'templates', 'git-hooks')
  const setup = readFileSync(join(engine, 'commands', 'firm-setup.md'), 'utf8')
  const build = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const adopt = readFileSync(join(engine, 'commands', 'firm-adopt.md'), 'utf8')
  const state = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
  const secrets = readFileSync(join(engine, 'scripts', 'lib', 'secrets.mjs'), 'utf8')
  const scan = readFileSync(join(engine, 'scripts', 'secret-scan.mjs'), 'utf8')
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const wf = readFileSync(join(engine, 'workflows', 'firm2-build.js'), 'utf8')
  const tester = readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')

  const gaps = []
  const hook = join(hooksDir, 'pre-commit')
  if (!existsSync(hook)) gaps.push('templates/git-hooks/pre-commit: второго слоя сверки нет вовсе')
  else {
    if (!(statSync(hook).mode & 0o111)) gaps.push('templates/git-hooks/pre-commit: не исполняемый — git молча его не позовёт')
    const text = readFileSync(hook, 'utf8')
    if (!/--staged/.test(text)) gaps.push('pre-commit: не зовёт сверку режимом --staged')
    if (!/-u GIT_DIR/.test(text)) gaps.push('pre-commit: окружение git не снято — внутри node оно сильнее ключа -C')
  }
  const want = [
    { src: state, file: 'scripts/firm-state.mjs', re: /readdirSync\(dir\)/, what: 'adopt берёт каталог шаблонов, а не список имён' },
    { src: setup, file: 'commands/firm-setup.md', re: /templates\/git-hooks\/\*/, what: 'настройка копирует все хуки' },
    { src: build, file: 'commands/firm-build.md', re: /templates\/git-hooks\/\*/, what: 'сборка доставляет хуки, которых проект не получил' },
    { src: adopt, file: 'commands/firm-adopt.md', re: /pre-commit/, what: 'adopt говорит про оба хука' },
    { src: scan, file: 'scripts/secret-scan.mjs', re: /CONTINUED/, what: '`merge --continue` считается создающим коммит' },
    { src: scan, file: 'scripts/secret-scan.mjs', re: /--staged/, what: 'режим git-хука' },
    // Д-49: у мержа родителей два, и дифф к одному выдаёт за добавленное содержимое
    // второй ветки. Замер проект-В: 21 блокирующая находка, своих строк НОЛЬ.
    { src: scan, file: 'scripts/secret-scan.mjs', re: /MERGE_HEAD/, what: 'мерж судится за своё, а не за разницу линий' },
    { src: scan, file: 'scripts/secret-scan.mjs', re: /ОТДЕЛЬНЫМ вызовом/, what: 'отказ говорит, что отмена уносит компаунд целиком (и `git add` вместе с ним)' },
    { src: secrets, file: 'scripts/lib/secrets.mjs', re: /JOURNAL/, what: 'журнал движка не кормит сверку собственным протоколом' },
    { src: secrets, file: 'scripts/lib/secrets.mjs', re: /line_no/, what: 'событие называет строку числом вместо цитаты находки' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /TREE_GLYPHS/, what: 'границы читаются и из ASCII-дерева' },
    { src: wf, file: 'workflows/firm2-build.js', re: /function verifyDeliveryRed/, what: 'хозяин красного доказывается снимком' },
    { src: wf, file: 'workflows/firm2-build.js', re: /delivery_red_check/, what: 'итог сверки уезжает в отчёт волны' },
    { src: wf, file: 'workflows/firm2-build.js', re: /НЕ ПОДТВЕРЖДЕНО/, what: 'неподтверждённое названо человеку этими словами' },
    { src: tester, file: 'agents/tester.md', re: /delivery_red_check/, what: 'Тестировщику сказано, что имена сверяются' },
  ]
  for (const w of want) if (!w.re.test(w.src)) gaps.push(`${w.file}: нет «${w.what}»`)

  note(
    'сверка секретов двухслойна, границы читаются из дерева, хозяин красного доказан',
    gaps.length === 0,
    gaps.join('; '),
  )
}

// ── 3я. Номер выдаётся по виду, событие пишется на ветку ─────────────────────
// Отчёт проект-В 05.11.2026, Д-50 и Д-51. Оба — «ответ дан не на тот вопрос», и оба молчали.
//
//   а) `next-id --kind adr` отдавал `{ kind: "task", id: "T-336" }`: неизвестный вид
//      подменялся задачным. Роль читает `id`, значит в решение проекта уехал бы номер
//      задачи. Отказ роль увидит, подмену — нет, поэтому неизвестный вид теперь отказ;
//   б) потолок номеров считался по одному дереву, а продукт живёт двумя линиями: на
//      замере ADR-0037/0038 лежали в дереве темы, и выдача повторила бы 0037 (корень
//      Д-46). Теперь читаются живые линии — дерево, ветка-цель, ветки рабочих деревьев;
//   в) `post-merge` писал событие выпуска в ГЛАВНОЕ дерево, чем бы оно ни было занято: 35
//      записей о выпуске в `main` легли на уже мёртвую ветку поставки. Событие принадлежит
//      ветке, а не дереву, и ветка выгружена ровно в одном дереве.
{
  const firmlib = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const state = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
  const ev = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  const gaps = []
  const want = [
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /FIRM2_UNKNOWN_ID_KIND/, what: 'неизвестный вид номера — отказ, а не подмена' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /export function adrCeiling/, what: 'потолок номеров решений' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /core\.quotepath=false/, what: 'не-ASCII имя файла решения попадает в потолок' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /export function journalRootFor/, what: 'журнал пишется в дерево ветки-владельца' },
    { src: state, file: 'scripts/firm-state.mjs', re: /FIRM2_UNKNOWN_ID_KIND/, what: 'отказ доходит до вызвавшей стороны (exit 2)' },
    { src: state, file: 'scripts/firm-state.mjs', re: /nextAdr/, what: 'вид adr выдаётся тем же распределителем' },
    { src: ev, file: 'scripts/firm-event.mjs', re: /journalHome\(root, \(readConfig/, what: 'выпуск пишется на ветку-цель' },
    { src: ev, file: 'scripts/firm-event.mjs', re: /journalHome\(root, `feature\//, what: 'слияние задачи пишется на ветку поставки' },
    { src: ev, file: 'scripts/firm-event.mjs', re: /выгружена не здесь/, what: 'переезд журнала сказан вслух' },
    // Д-45 (06.11.2026). Тот же корень, что у Д-46 и Д-51: движок смотрел в своё дерево и
    // считал, что видит проект. Для номеров это две разные стороны, и закрепляются обе:
    // потолок читается по живым линиям (номер, занятый файлом на невлитой ветке, занят), а
    // броня кладётся в ОДНО место на проект — номер принадлежит проекту, а не ветке.
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /export function refCeiling/, what: 'потолок номеров задач и багов по живым линиям' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /function mainWorktree/, what: 'броня номера живёт в главном дереве, а не в дереве зовущего' },
    // Обратная сторона выдачи. След нашёлся живым: `BUG-175` в проект-В без файла бага,
    // положенный диагностическим вызовом. Распределитель без освобождения раздувает
    // нумерацию на каждой диагностике, а снять броню можно было только руками — приёмом,
    // нигде не описанным. Отказ при занятом номере важнее самого снятия (И-12).
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /export function releaseId/, what: 'броню с неиспользованного номера можно снять' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /FIRM2_ID_IN_USE/, what: 'номер, которым уже названо, не освобождается' },
    { src: state, file: 'scripts/firm-state.mjs', re: /next-id --release/, what: 'приём назван в подсказке команды — иначе он неизвестен тому, кто номер занял' },
    { src: state, file: 'scripts/firm-state.mjs', re: /FIRM2_ID_IN_USE/, what: 'отказ освобождения доходит кодом 2' },
    // Два следствия брони, названные проект-В 06.11.2026 после того, как он сам в них попался:
    // сверка зовётся тем же `next-id`, то есть проверка результата создаёт бронь ЗАНОВО
    // (выход из петли надо было угадать), и броня из индекса уезжает в чужой коммит первым
    // же `git add -A` — у них она чуть не уехала в коммит плана. Обе подсказки теперь в
    // ответе, а защита от `git clean -fd` перенесена с индекса на игнор.
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /номер ЗАНЯТ этим вызовом/, what: 'выдача с бронью говорит вслух и даёт дорогу назад' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /займёт номер заново/, what: 'петля сверки названа в ответе освобождения' },
    { src: firmlib, file: 'scripts/lib/firm.mjs', re: /function ignoreClaims/, what: 'броня вне индекса: её не унесёт чужой add -A' },
    // Распределитель без потребителя — половина провода: номер ADR до 05.11.2026 роль
    // считала сама, по каталогу одного дерева.
    {
      src: readFileSync(join(engine, 'agents', 'architect.md'), 'utf8'),
      file: 'agents/architect.md',
      re: /next-id --kind adr/,
      what: 'Архитектор спрашивает номер решения, а не считает сам',
    },
  ]
  for (const w of want) if (!w.re.test(w.src)) gaps.push(`${w.file}: нет «${w.what}»`)

  // Живая проверка отказа: вид, которого нет, обязан дать код 2 и НИ ОДНОГО номера в stdout.
  const dir = mkdtempSync(join(tmpdir(), 'firm2-ids-'))
  try {
    writeFileSync(join(dir, 'config-stub'), '')
    mkdirSync(join(dir, '.firm'), { recursive: true })
    writeFileSync(join(dir, '.firm', 'config'), 'engine: firm2\n')
    const r = run(['node', join(engine, 'scripts', 'firm-state.mjs'), 'next-id', '--kind', 'dec', '--root', dir, '--json'])
    if (r.status !== 2) gaps.push(`неизвестный вид дал код ${r.status}, а не 2 — подмена молчит, отказ обязан быть слышен`)
    if ((r.stdout || '').trim()) gaps.push(`на неизвестный вид напечатан ответ: ${String(r.stdout).slice(0, 80)}`)

    // Живая проверка того, что текстом не держится: броня НЕ должна быть видна git. Текст
    // выше зеленел бы и на коде, который кладёт `.firm/.gitignore` и тут же делает `git
    // add` на каждый номер — а именно это и уносило броню в чужой коммит.
    const git = (...a) => run(['git', '-C', dir, ...a])
    git('init', '-q', '.')
    git('config', 'user.email', 'preflight@local')
    git('config', 'user.name', 'preflight')
    writeFileSync(join(dir, 'README.md'), '# сцена\n')
    git('add', '-A')
    git('commit', '-qm', 'сцена')
    const claim = run(['node', join(engine, 'scripts', 'firm-state.mjs'), 'next-id', '--kind', 'bug', '--root', dir, '--json'])
    let got = null
    try {
      got = JSON.parse(claim.stdout || '{}')
    } catch {
      gaps.push('выдача номера бага не ответила разбираемым JSON')
    }
    if (got && got.next) {
      if (!existsSync(join(dir, '.firm', 'ids', `${got.next}.json`))) gaps.push('броня не легла на диск — номер выдан без брони')
      const status = (git('status', '--short').stdout || '')
      if (/\.firm\/ids/.test(status)) {
        gaps.push(`броня видна git (${status.trim().split('\n')[0]}) — первый же «git add -A» унесёт её в чужой коммит, не показав (случай проект-В 06.11.2026)`)
      }
      // Проверяем ИГНОР, а не поведение `git clean`. Предложено проект-В 06.11.2026, и довод
      // у предложения сильный: `git clean` заперт по меньшей мере в двух независимых
      // средах — у меня песочницей, у них правилом доступа, — то есть защиту, опирающуюся
      // на живой вызов `clean`, не может проверить ни одна сторона, и обе ссылаются на
      // документацию. `check-ignore` не заперт ни у кого, и он проверяет ровно посылку:
      // путь действительно ignored. Остальное — документированный контракт git.
      const ign = git('check-ignore', '-v', join('.firm', 'ids', `${got.next}.json`))
      if (!/\.gitignore/.test(`${ign.stdout || ''}${ign.stderr || ''}`)) {
        gaps.push('броня не ignored ни одним правилом — тогда её сносит обычный «git clean -fd», и номер освободится после того, как им назвали баг')
      }
      if (!got.verify || !/--peek/.test(got.verify)) gaps.push('ответ не говорит, чем сверять, — сверка тем же next-id создаёт бронь заново')
      const back = run(['node', join(engine, 'scripts', 'firm-state.mjs'), 'next-id', '--release', got.next, '--root', dir, '--json'])
      let freed = null
      try {
        freed = JSON.parse(back.stdout || '{}')
      } catch {
        gaps.push('освобождение не ответило разбираемым JSON')
      }
      if (freed && freed.released !== true) gaps.push(`броню снять не удалось: ${JSON.stringify(freed).slice(0, 90)}`)
      if (existsSync(join(dir, '.firm', 'ids', `${got.next}.json`))) gaps.push('после освобождения броня осталась на диске — номер занят навсегда')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  note(
    'номер выдаётся по виду (отказ вместо подмены), журнал пишется на ветку-владельца',
    gaps.length === 0,
    gaps.join('; '),
  )
}

// ── 3ж. Исключённое предъявлено, прогон доказан, уборка видит и говорит ──────
// Отчёт проект-В 08.11.2026, Д-55…Д-59. Четыре провода, и у каждого одна и та же болезнь:
// движок знал факт, но не называл его машинно, а роль называла словами — и ошибалась.
//
//   Д-55: сужение задачного набора движок видел, запрет полного прогона в промпты писал,
//         а вопроса «кто прогонит исключённое» не задавал — единственный гейт живых
//         проверок не прогнался за 32 задачи ни разу;
//   Д-56: конфликт файла задачи движок создаёт сам (append-only с двух сторон) и семь раз
//         за поставку останавливал им волну, хотя разрешение — правило, а не суждение;
//   Д-57: `pgrep`/`ps` под песочницей не работают, и `found: []` читалось как «чисто»;
//   Д-59: долгий прогон предъявлялся прозой, а два прогона из одного дерева давали ложный
//         таймаут, объявленный красным поставки.
{
  const state = readFileSync(join(engine, 'scripts', 'firm-state.mjs'), 'utf8')
  const wf = readFileSync(join(engine, 'workflows', 'firm2-build.js'), 'utf8')
  const suite = readFileSync(join(engine, 'scripts', 'suite-run.mjs'), 'utf8')
  const devops = readFileSync(join(engine, 'agents', 'devops.md'), 'utf8')
  const modes = readFileSync(join(engine, 'templates', 'devops-modes.md'), 'utf8')
  const setupmd = readFileSync(join(engine, 'commands', 'firm-setup.md'), 'utf8')
  const buildcmd = readFileSync(join(engine, 'commands', 'firm-build.md'), 'utf8')
  const firmlib2 = readFileSync(join(engine, 'scripts', 'lib', 'firm.mjs'), 'utf8')
  const evSrc = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  const gaps = []
  const want = [
    // Д-55
    { src: state, file: 'scripts/firm-state.mjs', re: /function excludedTests/, what: 'состав исключённого читается из конфига' },
    { src: state, file: 'scripts/firm-state.mjs', re: /function narrowWarnings/, what: 'сужение без объявления состава — предупреждение перед прогоном' },
    { src: wf, file: 'workflows/firm2-build.js', re: /НЕ ПРОГОНЯЕТСЯ НИ ОДНОЙ СТАДИЕЙ/, what: 'исключённое названо непрогнанным в логе волны' },
    { src: wf, file: 'workflows/firm2-build.js', re: /task_tests_not_run/, what: 'состав непрогнанного уезжает в итог прогона — его читают ворота' },
    { src: setupmd, file: 'commands/firm-setup.md', re: /task_tests_presented_by/, what: 'проекту сказано, чем объявляется предъявитель' },
    // Д-56
    { src: wf, file: 'workflows/firm2-build.js', re: /task-merge\.mjs/, what: 'шагу слияния дан машинный разбор конфликта файла задачи' },
    // Д-57 и Д-58
    { src: wf, file: 'workflows/firm2-build.js', re: /lsof -a -d cwd/, what: 'рецепт поиска процессов, работающий под песочницей' },
    { src: wf, file: 'workflows/firm2-build.js', re: /required: \['found', 'checked'\]/, what: '«не проверено» отличимо от «чисто» полем, а не прозой' },
    { src: wf, file: 'workflows/firm2-build.js', re: /worktree_prune_pending/, what: 'недоделанная уборка дерева называет команду человека' },
    // Д-59
    { src: suite, file: 'scripts/suite-run.mjs', re: /function cmdProof/, what: 'ворота спрашивают машину, предъявлен ли прогон' },
    { src: suite, file: 'scripts/suite-run.mjs', re: /allow_parallel/, what: 'второй такой же прогон из того же дерева отклоняется' },
    { src: buildcmd, file: 'commands/firm-build.md', re: /suite-run\.mjs" proof/, what: 'Оркестратору сказано спрашивать машину, а не читать прозу' },
    { src: devops, file: 'agents/devops.md', re: /delivery_red_check/, what: 'роли запрещено утверждать отнесение красного своими словами' },
    { src: modes, file: 'templates/devops-modes.md', re: /exit_code/, what: 'шаг ворот предъявляется id и кодом возврата' },
    // Д-60: служебное дерево движка на не задачной ветке стадией никого не делает — иначе
    // признак ловит Оркестратора, которого маршрут туда и послал (шаг 6 идёт там, где
    // выгружена ветка-цель). Сильный признак остаётся прежним — агентские поля (Д-39).
    { src: readFileSync(join(engine, 'scripts', 'bash-guard.mjs'), 'utf8'), file: 'scripts/bash-guard.mjs', re: /function serviceTree/, what: 'служебное дерево отличается от дерева задачи' },
    { src: readFileSync(join(engine, 'scripts', 'bash-guard.mjs'), 'utf8'), file: 'scripts/bash-guard.mjs', re: /`cd` ВНУТРИ команды его не меняет/, what: 'решающий признак назван в отказе' },
    { src: readFileSync(join(engine, 'scripts', 'bash-guard.mjs'), 'utf8'), file: 'scripts/bash-guard.mjs', re: /gh\/hosts\.yml/, what: 'отказ на пуше называет настоящую причину и выход через человека' },
    // Условные границы: вердикт с оговоркой судится против НАЗВАННЫХ тикетов, а два
    // объявления об одном пути краснеют (дополнение к Д-47, F-048).
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /function conditionOf/, what: 'условие границы читается тикетами, а не прозой' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function declaredBoundaries/, what: 'все объявления видны, а не только «не меняется»' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /вердикты РАЗНЫЕ/, what: 'два вердикта об одном пути — находка' },
    { src: readFileSync(join(engine, 'agents', 'architect.md'), 'utf8'), file: 'agents/architect.md', re: /Условие в границе законно/, what: 'Архитектору сказана проверяемая форма условия' },
    // Д-61: неизвестный флаг отвергается, а не подменяется умолчанием. Сторож один на все
    // CLI — класс уже приходил поимённо (Д-50, `next-id --kind adr`), и поимённая починка
    // держалась ровно до следующей команды.
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function requireKnownFlags/, what: 'сторож неизвестного флага один на весь движок' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /process\.exit\(2\)/, what: 'неизвестный флаг кончается отказом, а не работой' },
    { src: state, file: 'scripts/firm-state.mjs', re: /would_remove/, what: 'у разрушающей команды есть сухой прогон, и он называет, что снесёт' },
    // Д-58, вторая редакция: остаток служебной записи ЧИТАЕТСЯ порселеном, а не выводится
    // из кодов возврата. Замер проект-В 08.11.2026 опроверг объяснение, которое движок писал
    // роли в промпт («каталог снят, запись осталась — песочница закрыла .git»): три прогона
    // дали два отказа и один полный успех, причина не найдена. Объяснение ушло, вопрос остался.
    { src: state, file: 'scripts/firm-state.mjs', re: /function prunableNames/, what: 'остаток служебных записей замеряется, а не предполагается' },
    { src: wf, file: 'workflows/firm2-build.js', re: /registry_left/, what: 'уборке дано поле под замер остатка' },
    { src: wf, file: 'workflows/firm2-build.js', re: /worktree list --porcelain/, what: 'рецепт замера остатка дан дословно' },
    { src: wf, file: 'workflows/firm2-build.js', re: /ПЕРЕМЕЖАЕТСЯ/, what: 'роли сказано, почему правило из кодов возврата не годится' },
  ]
  // Привязка виновника пути НЕ ходит по первому родителю, и это посылка механизма, а не
  // вкус обхода. Замер проект-В 08.11.2026: `--first-parent` на том же диапазоне и том же
  // пути отвечает ОДНИМ мержем поставки, а он тикета не несёт — у маршрута такой мерж один
  // на поставку, значит сверка условия объявила бы себя невыполненной на всём корпусе сразу
  // и выглядело бы это как «механизм не работает».
  {
    const m = firmlib2.match(/\['log'[^\]]*f\.path\]/)
    if (!m) gaps.push('scripts/lib/firm.mjs: вопрос «кто тронул путь» в сверке границ не найден — проверить обход нечем')
    else if (/first-parent/.test(m[0])) {
      gaps.push('scripts/lib/firm.mjs: виновник пути ищется по первому родителю — ответом станет безтикетный мерж поставки, и условие границы не проверится НИ РАЗУ (замер проект-В 08.11.2026)')
    }
  }
  for (const w of want) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // Скрипт разбора конфликта обязан существовать и обязан МОЛЧАТЬ без аргументов: он пишет
  // в рабочее дерево, и «запустил посмотреть» не должно означать «правка случилась».
  const tmPath = join(engine, 'scripts', 'task-merge.mjs')
  if (!existsSync(tmPath)) {
    gaps.push('scripts/task-merge.mjs: разбора конфликта файла задачи нет — класс снова ляжет на Оркестратора по разу на задачу (Д-56)')
  } else {
    const tm = readFileSync(tmPath, 'utf8')
    if (!/!args\.change && !args\.all/.test(tm)) {
      gaps.push('scripts/task-merge.mjs: без аргументов скрипт действует — пишущая команда обязана сначала объяснять себя')
    }
    if (!/unmergedPaths/.test(tm) || !/isTaskFile/.test(tm)) {
      gaps.push('scripts/task-merge.mjs: границы класса нет — разбор пойдёт по чужим файлам, где есть выбор (ADR-0009)')
    }
  }
  // Д-65…Д-71 (отчёт проект-В 09.11.2026, второй прогон G-020). Главная цена — Д-65: машина
  // отнесения красных не ответила ни по одному из восьми имён, при снятом основании
  // ветки-цели; остальные шесть — опоздавший отчёт о слиянии, невозврат к упавшему мержу,
  // конфликт разделов, табличные границы, 86 отмен сторожа ожидания, симлинк руками.
  const tmSrc = existsSync(join(engine, 'scripts', 'task-merge.mjs'))
    ? readFileSync(join(engine, 'scripts', 'task-merge.mjs'), 'utf8')
    : ''
  const wantNov9 = [
    { src: wf, file: 'workflows/firm2-build.js', re: /const onTrunk = t \? redNamed/, what: 'предсуществующее красное опознаётся одним снимком' },
    { src: wf, file: 'workflows/firm2-build.js', re: /delivery_red_unchecked/, what: 'не снятое отнесение названо одной причиной, а не N записями «неизвестно»' },
    { src: wf, file: 'workflows/firm2-build.js', re: /base_snapshots/, what: 'взятый sha точки ветвления виден в итоге' },
    { src: wf, file: 'workflows/firm2-build.js', re: /поле ts называет момент аргументов прогона/, what: 'сказано, что список красных устаревает за прогон, и чем датирован' },
    { src: wf, file: 'workflows/firm2-build.js', re: /accepted_not_merged: acceptedNotMerged/, what: 'принятые и невлитые — свой список в итоге прогона' },
    { src: wf, file: 'workflows/firm2-build.js', re: /merge-retry:/, what: 'к слиянию, упавшему по внешней причине, прогон возвращается' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /status = merged \? 'merged' : 'accepted'/, what: 'опоздавший отчёт о падении попытки влитое не отменяет' },
    { src: evSrc, file: 'scripts/firm-event.mjs', re: /stale_attempt/, what: 'такой отчёт помечается в момент записи' },
    { src: evSrc, file: 'scripts/firm-event.mjs', re: /closed_by: 'слияние состоялось'/, what: 'doctor не считает его находкой' },
    { src: tmSrc, file: 'scripts/task-merge.mjs', re: /function resolveBySections/, what: 'конфликт РАЗНЫХ разделов сводится объединением' },
    { src: tmSrc, file: 'scripts/task-merge.mjs', re: /clashHeads/, what: 'один заголовок с двух сторон — по-прежнему человеку' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /function tableBoundaries/, what: 'границы, записанные таблицей, сверка читает' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /last\.cond && last\.cond\.tickets/, what: 'условное объявление не читается как спор с прежним' },
    { src: wf, file: 'workflows/firm2-build.js', re: /ЦИКЛ ОЖИДАНИЯ СТОРОЖ ОТМЕНИТ/, what: 'запрет ожидания назван в промпте заранее, а не узнаётся из отказа' },
    { src: wf, file: 'workflows/firm2-build.js', re: /WORKTREE_LINKS/, what: 'ссылки дерева кладёт подготовка по объявлению проекта' },
    { src: state, file: 'scripts/firm-state.mjs', re: /function worktreeLinks/, what: 'состав ссылок объявляет проект (stack.worktree_links)' },
    { src: setupmd, file: 'commands/firm-setup.md', re: /worktree_links/, what: 'проекту сказано, чем объявляется состав ссылок' },
  ]
  for (const w of wantNov9) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // Д-72. СОБСТВЕННОГО ВРЕМЕНИ У СКРИПТА ПРОГОНА БЫТЬ НЕ МОЖЕТ: раннер роняет вызов
  // стадии целиком («Date.now() / new Date() are unavailable in workflow scripts (breaks
  // resume)»). Я поставил `new Date()` в 0.4.135 на несущий путь Test → QA, и у проект-В
  // 10.11.2026 каждая из 15 задач потеряла вердикт после пройденных разработки и тестов:
  // 92 вызова агентов, 1 ч 35 мин, влито ноль.
  //
  // Проверка здесь, а не в тестах, и это не предпочтение: тест исполняет тело прогона
  // обычным Node, где `new Date()` работает, — увидеть запрет рантайма он не может в
  // принципе. Текст может только рубеж. Комментарии снимаются: про запрет в них написано.
  for (const f of readdirSync(join(engine, 'workflows')).filter((x) => x.endsWith('.js'))) {
    const code = readFileSync(join(engine, 'workflows', f), 'utf8')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    if (/new Date\b/.test(code) || /Date\.now\s*\(/.test(code)) {
      gaps.push(
        `workflows/${f}: собственное время в скрипте прогона — раннер роняет этим ВЕСЬ вызов ` +
          `стадии (Д-72). Время приходит в args (firm-state build-args, поле now) или ставится ` +
          `после возврата прогона`,
      )
    }
  }
  // Д-72 и Д-73 (два отчёта проект-В 10.11.2026 про один прогон). Круг планировщика и потеря
  // вердикта от диагностики — разные дефекты с одной ценой: прогон час с лишним выглядит
  // работающим и не двигается.
  const wantNov10 = [
    { src: state, file: 'scripts/firm-state.mjs', re: /now: new Date\(\)\.toISOString\(\)/, what: 'время прогону даёт поставщик аргументов — своего у него нет' },
    { src: wf, file: 'workflows/firm2-build.js', re: /const RUN_TS = ARGS\.now/, what: 'прогон берёт момент из args' },
    { src: wf, file: 'workflows/firm2-build.js', re: /function attributeDeliveryRed/, what: 'сверка отнесения отделена от несущего пути' },
    { src: wf, file: 'workflows/firm2-build.js', re: /Вердикт задачи это не отменяет/, what: 'сорванная диагностика не стоит задаче вердикта (И-12)' },
    { src: wf, file: 'workflows/firm2-build.js', re: /const PREP_FAILS = new Map\(\)/, what: 'сорванная подготовка дерева повторяется один раз, а не кругом' },
    { src: wf, file: 'workflows/firm2-build.js', re: /prepare_failed: second/, what: 'причина срыва подготовки уходит в эскалацию, а не только в лог' },
    { src: wf, file: 'workflows/firm2-build.js', re: /!retaken\.has\(t\.id\) && !PREP_FAILS\.has\(t\.id\)/, what: 'возврат из разбора — один на задачу и не для сорванной подготовки' },
    { src: wf, file: 'workflows/firm2-build.js', re: /starts > MAX_ATTEMPTS \+ 1/, what: 'выход из круга назван числом заходов' },
    { src: wf, file: 'workflows/firm2-build.js', re: /unfinished_merges/, what: 'незавершённые слияния в деревьях задач называются поимённо (Д-68)' },
    { src: evSrc, file: 'scripts/firm-event.mjs', re: /stalled_tickets: stalled/, what: 'задача, вставшая на закрытой стадии, видна в doctor' },
    { src: evSrc, file: 'scripts/firm-event.mjs', re: /TERMINAL_STATUS\.has\(statusFromEvents\(evs\)\.status\)/, what: 'терминальность берётся у словаря статусов доски, а не вторым списком имён' },
    { src: evSrc, file: 'scripts/firm-event.mjs', re: /const GUARD_SAYS = new Set/, what: 'сторож не считается закрытой стадией, кроме смерти несущей' },
  ]
  for (const w of wantNov10) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // ПРАВО СНИМАТЬ ТЕСТЫ (решение человека 10.11.2026, первый из двух отложенных шагов
  // уборки). Право без машинной половины — это разрешение снимать по вкусу, а снятая по
  // вкусу защита хуже отсутствующей; право без правила у Ревьюера — это прежний отказ,
  // только теперь молчаливый. Поэтому обе стороны провода проверяются вместе.
  const testsLib = readFileSync(join(engine, 'scripts', 'lib', 'tests.mjs'), 'utf8')
  const auditSrc = readFileSync(join(engine, 'scripts', 'test-audit.mjs'), 'utf8')
  const testerMd = readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')
  const qaMd = readFileSync(join(engine, 'agents', 'reviewer-qa.md'), 'utf8')
  const auditSkill = readFileSync(join(engine, 'skills', 'firm-test-audit', 'SKILL.md'), 'utf8')
  const wantRemoval = [
    { src: testsLib, file: 'scripts/lib/tests.mjs', re: /export function reviewRemovals/, what: 'снятое сверяется машиной по двум снимкам' },
    { src: testsLib, file: 'scripts/lib/tests.mjs', re: /kept_by_human/, what: 'пометка человека даёт исход «запрещено», а не предупреждение' },
    { src: testsLib, file: 'scripts/lib/tests.mjs', re: /INVARIANT_NAMED/, what: 'тест, названный инвариантом, снятию не подлежит (CLAUDE.md)' },
    { src: testsLib, file: 'scripts/lib/tests.mjs', re: /требует карточки/, what: 'нет машинного довода — это «не знаю» с причиной, а не разрешение (И-12)' },
    { src: testsLib, file: 'scripts/lib/tests.mjs', re: /checked: false/, what: '«не проверено» отделено от «ничего не снято» (Д-57)' },
    { src: auditSrc, file: 'scripts/test-audit.mjs', re: /--removed --base/, what: 'режим сверки снятого объявлен в подсказке' },
    { src: testerMd, file: 'agents/tester.md', re: /test-audit\.mjs" --removed --base/, what: 'Тестировщику дана команда сверки, а не просьба быть аккуратным' },
    { src: testerMd, file: 'agents/tester.md', re: /--event tests-removed/, what: 'снятие теста оставляет событие в журнале' },
    { src: qaMd, file: 'agents/reviewer-qa.md', re: /--removed --base/, what: 'Ревьюер судит снятие по сверке, а не по букве «тесты не снимать»' },
    { src: qaMd, file: 'agents/reviewer-qa.md', re: /запрещено/, what: 'и знает, какой исход сверки обязывает отклонить' },
    { src: auditSkill, file: 'skills/firm-test-audit/SKILL.md', re: /Поправка 10\.11\.2026/, what: 'приём назвал поправку, а не оставил прежнее «снимает тест человек»' },
    { src: wf, file: 'workflows/firm2-build.js', re: /function removalEvidence/, what: 'сверку снятого Ревьюеру предъявляет движок, а не его память' },
    { src: wf, file: 'workflows/firm2-build.js', re: /removed_checked: false/, what: 'сорванная сверка снятого — «не проверено», а не «не снято»' },
  ]
  for (const w of wantRemoval) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // Д-74. Защита «нужные слова пришли ДАННЫМИ» обязана накрывать ОБА способа передать текст,
  // иначе одно правило даёт два ответа на один текст — замер проект-В 10.11.2026: строка
  // «git merge … task/T-404» в `--notes "…"` давала отказ, а телом heredoc проходила.
  const rrSrc = readFileSync(join(engine, 'scripts', 'review-receipt.mjs'), 'utf8')
  const evsrc374 = readFileSync(join(engine, 'scripts', 'firm-event.mjs'), 'utf8')
  const wantD74 = [
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function stripTextArgs/, what: 'значения текстовых ключей снимаются перед разбором подкоманд' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /stripTextArgs\(stripHeredoc\(cmd\)\)/, what: 'и снимаются ОБА способа, одним разбором на всех сторожей' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /const TEXT_OPTS = new Set/, what: 'список ключей ИМЕНОВАННЫЙ: «всё кавычечное» пропустило бы bash -c "git push"' },
    // Вторая половина Д-74: кавычки разбирались в форме «ключ пробел значение» и не
    // разбирались в `ключ=значение` — значение снималось до первого пробела, а его хвост
    // снова читался как команда. Чтение значения теперь ОДНО на обе формы, и провод
    // проверяет именно это: разойтись формам негде, пока функция одна.
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /const dropValue = \(from\)/, what: 'значение читается одним кодом для обеих форм ключа' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /\^\(--\?\[A-Za-z\]\[\\w-\]\*\)=/, what: 'ключ формы «ключ=значение» опознаётся ДО чтения токена, иначе кавычки не разберутся' },
    { src: rrSrc, file: 'scripts/review-receipt.mjs', re: /СЛИЯНИЯ В НЕЙ НЕТ/, what: 'рецепт отказа начинается с вопроса «тот ли это случай вообще»' },
    { src: rrSrc, file: 'scripts/review-receipt.mjs', re: /ЛОЖНОЕ guard\/review-stale/, what: 'и говорит, почему обход через FIRM2_STALE_REVIEW здесь записал бы неправду' },
  ]
  for (const w of wantD74) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // Предложение проект-В 10.11.2026 (разбор T-374) — три механизма, взятые по решению
  // человека. Это НЕ дефекты: движок своих правил не нарушал, таких правил у него не было.
  // Каждый держится проводом, потому что каждый — опциональный ключ или необязательное
  // поле, то есть именно тот класс, который исчезает молча: ничего не краснеет, просто
  // перестаёт работать обещанное.
  const wantT374 = [
    // Полоса одновременности. Опциональна, и ровно поэтому проверяется обе стороны: сам
    // потолок И то, что без ключа поведение прежнее (`lanesOf` возвращает пусто — значит
    // `laneFull` не держит никого).
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function laneCaps/, what: 'потолки полос читаются из конфига одним кодом' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /Number\.isInteger\(n\) && n > 0/, what: 'годность потолка — ОДИН предикат на применение и на находку (иначе два ответа на одно правило, Д-74)' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function laneWarnings/, what: 'негодный потолок — находка ворот, а не тихое «ключа нет»' },
    { src: state, file: 'scripts/firm-state.mjs', re: /const laneUse = new Map\(\)/, what: 'вид планировщика человеку считает занятость полос' },
    { src: state, file: 'scripts/firm-state.mjs', re: /lanes: LANE_CAPS/, what: 'потолки доезжают до сборщика через build-args (у workflow нет доступа к ФС)' },
    { src: wf, file: 'workflows/firm2-build.js', re: /const LANE_USE = new Map\(\)/, what: 'потолок полосы держит САМ сборщик — он и пускает задачи' },
    { src: wf, file: 'workflows/firm2-build.js', re: /ждёт полосу/, what: 'и говорит вслух, кого держит полоса: иначе ожидание читается как простой зря' },
    // Инвентарь. Поле без промпта — бухгалтерия: три захода T-374 добирали множество
    // грепом именно потому, что прочитать его было негде.
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /inventory: toArray\(data\.inventory\)/, what: 'инвентарь читается из карточки задачи' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /const QUANTIFIER = /, what: 'квантор без названного множества — находка ворот планирования' },
    { src: state, file: 'scripts/firm-state.mjs', re: /inventory: f\.inventory \|\| \[\]/, what: 'инвентарь не теряется по пути в прогон (Д-1: урезанная модель задачи)' },
    { src: wf, file: 'workflows/firm2-build.js', re: /function inventoryRule/, what: 'перечень уезжает в промпт стадии' },
    { src: wf, file: 'workflows/firm2-build.js', re: /ДОБИРАТЬ ЕГО ГРЕПОМ ТЫ НЕ ВПРАВЕ/, what: 'и сказано, что перечень ЗАКРЫТ: расширение объёма — решение человека' },
    // Одновременность в событии. Считается из ЖУРНАЛА, а не из рантайма: хук на каждого
    // подагента свой и про соседние стадии не знает ничего.
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function concurrencyAt/, what: 'число одновременных стадий считается из журнала' },
    { src: evsrc374, file: 'scripts/firm-event.mjs', re: /ev\.concurrent_stages = c\.stages/, what: 'и ставится на закрывающее событие стадии — иначе отказ «красное от нагрузки» непредъявим' },
  ]
  // Сочинённый снимок основания. Найдено 10.11.2026 по второму отчёту проект-В: ответ зонда
  // «уже измерено» с НЕузнанным sha проваливался мимо ветки дедупликации и мимо сверки
  // ревизии в общую запись, где пустой `red` становился измерением «красных 0» — снимком
  // коммита, которого никто не делал (класс Д-43 без чужой ревизии). Учил этому
  // собственный промпт: список известных коммитов показывался в 12 знаков.
  // Карточка задачи — документ планирования (второй отчёт проект-В 10.11.2026, п.2). Класс
  // создавал сам движок: он двумя инструкциями посылал стадию и арбитраж дописывать в
  // конец ОДНОГО файла с двух разных ветвей, хотя машинное место есть у обоих. 23 отказа
  // слияния из 90 (26%), четыре поставки подряд. Провод держит обе половины: инструкций
  // больше нет И протокол не потерялся — у него есть поле, событие и место в промпте надзора.
  // Имя сироты — отдельный ответ от «что видел» (находка проект-В 10.11.2026). Признак был
  // один и смотрел на рабочий каталог внутри `worktrees_dir`; стадия замера вправе завести
  // дерево в `$TMPDIR`, и шесть живых браузеров оттуда попали в список без имени. Провод
  // держит и второй признак, и ГРАНИЦУ: процессы человека сиротами называть нельзя.
  // Поправка сторожа квантора в день его выпуска (замер проект-В по 49 карточкам: сторож
  // видел 29 находок из 59, и все тридцать пропущенных заглушены НОМЕРОМ ССЫЛКИ — голое
  // `\d` в NAMES_SET читало цифру `BR-241` как названное множество). Провод держит и
  // лекарство, и его границу: прочие цифры остаются называнием множества, иначе сторож
  // ослепнет к законным перечням.
  // Закрытая задача — одно понятие и одно место (дефект 10.11.2026, Архитектор проект-В).
  // Предикат «не пойдёт никогда» был выписан литеральным списком трижды, и `superseded` не
  // было ни в одном: форма плана считалась по мёртвым (у них 10 задач против 6 живых и
  // лишняя треть волн), `phase` звал прогон на снятую задачу, дерево снятой не было
  // сиротой. Провод держит и набор, и то, что литеральных копий больше нет.
  // Копии ищем в ОБОИХ файлах: четвёртая копия жила в `lib/firm.mjs`, в выборе активной
  // поставки, и она была хуже трёх — по ней движок решает, какая поставка идёт, и
  // поставка со снятыми остатками числилась бы активной навсегда (класс Д-1).
  const closedCopies = ((state + firmlib2).match(/\['merged', 'released', 'cancelled'\]/g) || []).length
  const wantClosed = [
    { ok: /export const TASK_CLOSED = new Set/.test(firmlib2), file: 'scripts/lib/firm.mjs', what: 'набор закрытых статусов назван один раз' },
    { ok: /TASK_CLOSED = new Set\(\['merged', 'released', 'cancelled', 'superseded'\]\)/.test(firmlib2), file: 'scripts/lib/firm.mjs', what: 'и снятая задача в нём есть — она терминальна как отменённая' },
    { ok: /const BUILD_SKIP = \[\.\.\.TASK_CLOSED, 'blocked'\]/.test(state), file: 'scripts/firm-state.mjs', what: 'кого не отдавать прогону считается ОТ набора, а не вторым списком' },
    { ok: closedCopies === 0, file: 'scripts/firm-state.mjs', what: `литеральных копий списка закрытых статусов быть не должно (нашлось ${closedCopies})` },
  ]
  for (const w of wantClosed) {
    if (!w.ok) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  const wantQuantFix = [
    { ok: /const REF_ID = /.test(firmlib2), file: 'scripts/lib/firm.mjs', what: 'номера ссылок снимаются ДО вопроса «названо ли множество»' },
    { ok: /NAMES_SET\.test\(l\.replace\(REF_ID, ''\)\)/.test(firmlib2), file: 'scripts/lib/firm.mjs', what: 'и снимаются именно в этом вопросе, а не во всей находке' },
    { ok: /if \(open && \/\^\\s\{2,\}\\S\//.test(firmlib2), file: 'scripts/lib/firm.mjs', what: 'критерий склеивается из переноса: находка не зависит от места Enter' },
  ]
  for (const w of wantQuantFix) {
    if (!w.ok) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  const wantOrphanName = [
    { ok: /orphans: \{ type: 'array'/.test(wf), file: 'workflows/firm2-build.js', what: 'названные сироты — отдельное поле схемы уборки' },
    { ok: /ДВУМЯ ПРИЗНАКАМИ/.test(wf), file: 'workflows/firm2-build.js', what: 'признаков сироты два, и второй не смотрит на рабочий каталог' },
    { ok: /процессы ЧЕЛОВЕКА сиротами не называй/.test(wf), file: 'workflows/firm2-build.js', what: 'граница названа: рабочее окно человека не мусор' },
    { ok: /НАЗВАНЫ СИРОТАМИ/.test(wf), file: 'workflows/firm2-build.js', what: 'сироты печатаются поимённо, а не числом' },
    { ok: /НЕ НАЗВАНЫ и не опровергнуты/.test(wf), file: 'workflows/firm2-build.js', what: 'ответ без поля — «не знаю», а не «чужие» (И-12)' },
  ]
  for (const w of wantOrphanName) {
    if (!w.ok) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  const wantCardAnchor = [
    { ok: !/впиши в файл задачи/.test(wf), file: 'workflows/firm2-build.js', what: 'стадии больше не велено дописывать протокол в карточку' },
    { ok: !/допиши в \$\{task\.path\}/.test(wf), file: 'workflows/firm2-build.js', what: 'арбитражу больше не велено дописывать предписание в карточку' },
    { ok: /protocol: \{ type: 'string' \}/.test(wf), file: 'workflows/firm2-build.js', what: 'у протокола есть поле в схеме стадии теста' },
    { ok: /Протокол стадии, как она его предъявила/.test(wf), file: 'workflows/firm2-build.js', what: 'и он доходит до промпта надзора — иначе запрет отобрал бы предмет проверки' },
    { ok: /протокол: \$\{String\(so\.protocol\)/.test(evsrc374), file: 'scripts/firm-event.mjs', what: 'протокол уходит в закрывающее событие стадии' },
    { ok: /документ ПЛАНИРОВАНИЯ/.test(readFileSync(join(engine, 'agents', 'tester.md'), 'utf8')), file: 'agents/tester.md', what: 'правило названо Тестировщику' },
    { ok: /документ ПЛАНИРОВАНИЯ/.test(readFileSync(join(engine, 'agents', 'developer.md'), 'utf8')), file: 'agents/developer.md', what: 'правило названо Разработчику' },
    { ok: /ФАЙЛ ЗАДАЧИ ты не правишь/.test(readFileSync(join(engine, 'agents', 'architect.md'), 'utf8')), file: 'agents/architect.md', what: 'правило названо арбитражу' },
    { ok: /Протокол стадии ищи в предъявленном/.test(readFileSync(join(engine, 'agents', 'reviewer-qa.md'), 'utf8')), file: 'agents/reviewer-qa.md', what: 'надзор знает, где теперь протокол' },
    // Седьмой прогон проект-В: правка выше НЕ РАБОТАЛА, потому что один текст правила уходил
    // в два промпта с разными схемами и обеим называл `protocol`. Имя поля берётся по
    // стадии, незнакомая стадия останавливает сборку промпта, а пустой протокол на
    // браузерной задаче НАЗЫВАЕТСЯ надзору, а не опускается (И-12).
    { ok: /const PROTO_FIELD = \{ dev: 'notes', test: 'protocol' \}/.test(wf), file: 'workflows/firm2-build.js', what: 'место протокола названо по стадии, а не одним именем на две схемы' },
    { ok: /верни ПОЛЕМ \\`\$\{field\}\\`/.test(wf), file: 'workflows/firm2-build.js', what: 'правило подставляет поле стадии, а не литерал' },
    { ok: /browserRule: у стадии «\$\{stage\}» не названо поле протокола/.test(wf), file: 'workflows/firm2-build.js', what: 'незнакомая стадия останавливает сборку, а не получает умолчание (ADR-0007)' },
    { ok: /browserRule\(task, 'dev'\)/.test(wf) && /browserRule\(task, 'test'\)/.test(wf), file: 'workflows/firm2-build.js', what: 'оба вызова называют свою стадию' },
    { ok: /ПРОТОКОЛ СТАДИИ НЕ ПРЕДЪЯВЛЕН/.test(wf), file: 'workflows/firm2-build.js', what: 'пустой протокол при метке браузера звучит отдельным ответом' },
    // Доставка движка меняет `scripts/` под идущей волной (они читаются по `engine_root`
    // живьём). Граница версий внутри одной попытки обязана оставлять улику, и ТОЛЬКО когда
    // расхождение есть: поле на каждом событии читалось бы как «механизм работает».
    { ok: /if \(evs\.drift\) ev\.engine_drift = \{ recorded: evs\.recorded, actual: evs\.actual \}/.test(evsrc374), file: 'scripts/firm-event.mjs', what: 'стадия на разошедшейся версии оставляет улику в событии, и только тогда' },
  ]
  for (const w of wantCardAnchor) {
    if (!w.ok) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // ГРАНИЦА СБОРЩИКА — СЕССИЯ, И СКАЗАНО ЭТО В ТРЁХ МЕСТАХ СРАЗУ. Замер проект-В 10.11.2026:
  // в одной сессии прошли три волны, версия приехала в кэш между первой и второй, и все три
  // шли по СТАРОМУ сборщику. Факт стоит в ADR (решение), в доке adopt (порядок действий) и
  // в выводе доставки (единственное место, которое читают в момент выпуска) — три копии
  // одного понятия неизбежны, и потому их держит один провод: расходятся они молча.
  const wantWfSession = [
    { ok: /workflow-сборщик\*\* подтягиваются \*\*в новой сессии\*\*/.test(readFileSync(join(engine, 'docs', 'adr', '0008-версия-плагина-это-доставка.md'), 'utf8')), file: 'docs/adr/0008', what: 'решение называет сборщик наравне с командами' },
    { ok: /роли и workflow-сборщик загружаются при старте/.test(readFileSync(join(engine, 'commands', 'firm-adopt.md'), 'utf8')), file: 'commands/firm-adopt.md', what: 'порядок действий называет сборщик' },
    { ok: /WORKFLOW-СБОРЩИК/.test(readFileSync(join(engine, 'scripts', 'release.mjs'), 'utf8')), file: 'scripts/release.mjs', what: 'вывод доставки говорит это в момент выпуска' },
  ]
  for (const w of wantWfSession) {
    if (!w.ok) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  const wantBaseDedup = [
    { src: wf, file: 'workflows/firm2-build.js', re: /sha возвращай ПОЛНОСТЬЮ/, what: 'зонду сказано вернуть полный sha, а список известных показан полным' },
    { src: wf, file: 'workflows/firm2-build.js', re: /if \(r\.state === 'same'\) \{/, what: 'путь дедупликации разбирается ЦЕЛИКОМ, а не условием «и sha известен»' },
    { src: wf, file: 'workflows/firm2-build.js', re: /сочинить «красных нет» — тем более/, what: 'неразрешённый ответ — «не знаю», а не нуль (И-12)' },
  ]
  for (const w of wantBaseDedup) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  for (const w of wantT374) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  // Д-75. Бронь номера — запись О номере, а не место, им названное: иначе штатный исход
  // своей же команды (`next-id --claim` плюс карточка этим номером) краснил сверку, а
  // выхода у проекта не было — `--release` на названном номере отказывает по делу.
  if (!/w !== '\.firm\/ids'/.test(firmlib2)) {
    gaps.push(
      'scripts/lib/firm.mjs: бронь номера считается местом, им названным — `doctor` краснеет ' +
        'на штатном исходе `next-id --claim` (Д-75), и снять это проекту нечем',
    )
  }
  // Сторож флагов обязан стоять в КАЖДОМ CLI, который что-то делает: цена пропуска
  // замерена — `firm-state.mjs prune --help` снёс у проект-В два рабочих дерева, потому что
  // неизвестный флаг прочитался как «аргументов нет, работай» (Д-61).
  for (const cli of ['firm-state.mjs', 'firm-event.mjs', 'suite-run.mjs', 'task-merge.mjs', 'firm-permissions.mjs', 'test-audit.mjs']) {
    const src = readFileSync(join(engine, 'scripts', cli), 'utf8')
    if (!/requireKnownFlags\(/.test(src)) {
      gaps.push(`scripts/${cli}: сторожа неизвестного флага нет — опечатка в флаге исполнится как умолчание (Д-61)`)
    }
  }
  // Д-63 и Д-64 (отчёт проект-В 09.11.2026). Первая стоила 30 задач из 40: разбор эскалации,
  // сделанный по ходу прогона, до прогона не доходил, потому что фильтр добора снимал всё,
  // что уже есть в плане, — включая задачу, которую прогон сам эскалировал. Вторая — отказ
  // сторожа расписки был прав, но называл 249 файлов там, где своей рукой написано двадцать
  // строк в одном файле.
  const wantNew = [
    { src: state, file: 'scripts/firm-state.mjs', re: /function returnedFromEscalation/, what: 'признак «вернулась разбором эскалации» считается по журналу' },
    { src: state, file: 'scripts/firm-state.mjs', re: /returned_from_escalation: returnedFromEscalation/, what: 'признак уезжает прогону в рабочем наборе' },
    { src: wf, file: 'workflows/firm2-build.js', re: /const retake = /, what: 'прогон возвращает в очередь свою разобранную задачу' },
    { src: wf, file: 'workflows/firm2-build.js', re: /escalatedHere/, what: 'подхватывается только своя эскалация, не чужая' },
    { src: firmlib2, file: 'scripts/lib/firm.mjs', re: /export function staleReviewSplit/, what: 'расхождение расписки делится на своё и подтянутое' },
    { src: readFileSync(join(engine, 'scripts', 'review-receipt.mjs'), 'utf8'), file: 'scripts/review-receipt.mjs', re: /СУДИТЬ НАДО ПЕРВЫЙ СПИСОК/, what: 'отказ называет, какой из двух списков судить' },
    { src: readFileSync(join(engine, 'scripts', 'review-receipt.mjs'), 'utf8'), file: 'scripts/review-receipt.mjs', re: /ТОЛЬКО ЧЕЛОВЕК, РОЛИ ЭТОТ ХОД НЕДОСТУПЕН/, what: 'человеческий выход помечен — роль примеряет к себе все четыре' },
    { src: buildcmd, file: 'commands/firm-build.md', re: /дереве задачи, подтянув/, what: 'Оркестратору назван путь разрешения конфликта при идущем прогоне' },
  ]
  for (const w of wantNew) {
    if (!w.re.test(w.src)) gaps.push(`${w.file}: ${w.what} — провода нет`)
  }
  note('исключённое названо, прогон предъявлен машиной, уборка видит, служебное дерево — не стадия, условие границы читается тикетами', gaps.length === 0, gaps.join('; '))
}

// ── 3у. Таблица ролей сходится сама с собой ──────────────────────────────────
// Шаг берёт один класс находок целиком и снимает его с шага 3с, где он стоял поимённо:
// «у Разработчика и Тестировщика в промпте есть `ports`». Список из двух файлов и одного
// поля надо было дописывать РУКАМИ вслед за каждым разбором стадии — то есть защита от
// забытого поля держалась на памяти. Остальные проверки 3с остаются: они про потребителя
// (кто ЧИТАЕТ поле), а потребителя из текста не вывести — его видно только по смыслу.
//
// Теперь находки выводит `lib/roles.mjs` из исходника: ключ схемы, не названный в
// промпте; стадия, которую зовут без маркера и без сказанной причины; приём или шаблон
// по несуществующему пути; роль, которую не зовёт никто; имя в карте `A`, которое ничего
// не зовёт. Добавил роль или поле — проверяется само.
//
// Судит рубеж, а не сам скрипт: `roles.mjs` всегда выходит нулём, потому что из него
// собирается схема «вход-выход восьми ролей» и читают его руками (замер, который падает,
// перестают звать).
{
  const table = rolesTable(engine)
  note(
    `таблица ролей сходится (${table.roles.length} ролей)`,
    table.findings.length === 0,
    table.findings.length ? `${table.findings.join('; ')}` : '',
  )
}

// ── 3а. Тесты на инварианты ──────────────────────────────────────────────────
// Отдельно от прогона ниже, и порядок намеренный: прогон проверяет, что движок РАБОТАЕТ,
// тесты — что он работает ВЕРНО. Первое дешевле и падает понятнее, поэтому идёт раньше;
// но версия не поднимается ни без того, ни без другого.
//
// Каталог позиционным аргументом node не принимает: с Node 23 аргумент `--test` трактуется
// как glob, и `node --test firm2/tests/` падает с `Cannot find module`. Поэтому список
// файлов собираем сами — заодно видно, если тестов нет вовсе.
const testsDir = join(engine, 'tests')
const testFiles = existsSync(testsDir)
  ? readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(testsDir, f))
  : []
if (testFiles.length) {
  // Потолок — защита от зависшего теста, а не бюджет производительности, и 180 с в этой
  // роли оказались впритык. 21.10.2026 рубеж упал на нём при живых 464 тестах: на свободной
  // машине набор идёт ~22 с, а под нагрузкой (load average 18, две сессии разом) — 457 с.
  // Провал гейта из-за чужой загрузки учит обходить гейт, а не чинить тест.
  const r = run(['node', '--test', ...testFiles], { cwd: join(engine, '..'), timeout: 900000 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const fails = (out.match(/^.?\s*fail (\d+)/m) || [])[1]
  note(`тесты на инварианты (${testFiles.length} файлов)`, r.status === 0, fails ? `провалено ${fails}` : firstLine(r.stderr))
  if (r.status !== 0 && !json) {
    process.stdout.write(out.split('\n').filter((l) => /^(✖|not ok|ℹ (pass|fail|todo))/.test(l)).join('\n') + '\n')
  }
} else {
  note('тесты на инварианты — ПРОПУЩЕНЫ (нет firm2/tests)', true)
}

// ── 4. Прогон по синтетическому проекту ──────────────────────────────────────
// Репозиторий одноразовый и собирается с нуля: проверка не должна зависеть ни от одного
// настоящего проекта — иначе она однажды начнёт падать из-за чужого состояния, и ей
// перестанут верить.
const root = mkdtempSync(join(tmpdir(), 'firm2-preflight-'))
// Ошибку git пересказываем вместе с её stderr: без этого провал синтетического прогона
// показывает только команду, а причина («local changes would be overwritten») молчит.
const git = (...a) => {
  try {
    return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const why = firstLine(String(e.stderr || '') + String(e.stdout || '')) || String(e.message).split('\n')[0]
    throw new Error(`git ${a.join(' ')}: ${why}`, { cause: e })
  }
}
const ev = (...a) => run(['node', join(engine, 'scripts', 'firm-event.mjs'), ...a], { cwd: root })
const st = (...a) => run(['node', join(engine, 'scripts', 'firm-state.mjs'), ...a], { cwd: root })
try {
  mkdirSync(join(root, '.firm', 'events'), { recursive: true })
  mkdirSync(join(root, 'openspec', 'changes', 'ch', 'tasks'), { recursive: true })
  writeFileSync(
    join(root, '.firm', 'config'),
    `engine: firm2\nengine_root: "${engine}"\nactive_change: ch\nparallelism: 3\n` +
      'stack:\n  language: "python"\n  package_manager: "uv"\n',
  )
  // pyproject нужен не для красоты: разбор питонового окружения в firm-state.mjs — это
  // как раз та ветка, где сегодня жил `devGroup is not defined`.
  writeFileSync(
    join(root, 'pyproject.toml'),
    '[project]\nname = "p"\nversion = "0"\n\n[dependency-groups]\ndev = ["pytest", "ruff"]\n',
  )
  for (const t of ['T-001', 'T-002']) {
    writeFileSync(
      join(root, 'openspec', 'changes', 'ch', 'tasks', `${t}.md`),
      `---\nid: ${t}\ntitle: ${t}\nstatus: todo\n---\n\nПроверочная задача.\n`,
    )
  }
  git('init', '-q', '.')
  git('config', 'user.email', 'preflight@firm2')
  git('config', 'user.name', 'preflight')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-q', '-b', 'feature/ch')

  // T-001 проходит цикл целиком и вливается слиянием, ЗАВЕРШЁННЫМ ПОСЛЕ КОНФЛИКТА, —
  // то есть ровно тем путём, на котором git не зовёт post-merge (дефект E).
  ev('record', '--ticket', 'T-001', '--stage', 'dev', '--event', 'started', '--actor', 'preflight')
  git('checkout', '-q', '-b', 'task/T-001')
  writeFileSync(join(root, 'f.txt'), 'задача\n')
  git('add', '-A')
  git('commit', '-qm', 'T-001')
  git('checkout', '-q', 'feature/ch')
  writeFileSync(join(root, 'f.txt'), 'поставка\n')
  git('add', '-A')
  git('commit', '-qm', 'parallel')
  try {
    git('merge', '--no-ff', '--no-edit', 'task/T-001')
  } catch {
    writeFileSync(join(root, 'f.txt'), 'разрешено\n')
    git('add', '-A')
    git('commit', '-qm', 'merge T-001 (конфликт разрешён)')
  }
  ev('record', '--ticket', 'T-001', '--stage', 'dev', '--event', 'finished', '--actor', 'preflight')

  const cases = [
    ['phase', st('phase', '--json')],
    ['stack', st('stack', '--json')],
    ['sync', ev('sync', '--json')],
    ['dashboard', ev('dashboard', '--json')],
    ['doctor', ev('doctor', '--json')],
    ['prune', st('prune', '--json')],
  ]
  for (const [name, r] of cases) {
    const out = `${r.stdout || ''}${r.stderr || ''}`
    note(`прогон ${name}`, r.status === 0 && !TRACE.test(out), firstLine(r.stderr) || `код ${r.status}`)
  }

  // Сверка дописала слияние, завершённое после конфликта? Это дефект E, и проверять его
  // надо на каждой доставке: он возвращается тихо.
  const doctor = JSON.parse(ev('doctor', '--json').stdout || '{}')
  const merged = readdirSync(join(root, '.firm', 'events')).filter((f) => /T-001-merge-finished/.test(f))
  note('сверка дописала слияние после конфликта', merged.length === 1, `нашлось ${merged.length}`)
  note('журнал чист на честных данных', doctor.ok === true, JSON.stringify(doctor.impossible_events || []))

  // А теперь — ложь в журнале. T-002 не делала ни одного коммита, вливать было нечего.
  ev('record', '--ticket', 'T-002', '--stage', 'merge', '--event', 'finished', '--actor', 'preflight')
  git('branch', '-q', 'task/T-002', 'feature/ch')
  const lying = JSON.parse(ev('doctor', '--json').stdout || '{}')
  note(
    'инварианты ловят ложное «влито»',
    lying.ok === false && (lying.impossible_events || []).some((i) => i.ticket === 'T-002'),
    `ok=${lying.ok}, найдено ${(lying.impossible_events || []).length}`,
  )

  // Аннулирование должно снимать находку — иначе починить журнал нечем.
  const file = readdirSync(join(root, '.firm', 'events')).find((f) => /T-002-merge-finished/.test(f))
  ev('record', '--ticket', 'T-002', '--stage', 'merge', '--event', 'retracted', '--corrects', file,
    '--notes', 'проверка рубежа: вливать было нечего')
  const healed = JSON.parse(ev('doctor', '--json').stdout || '{}')
  note('аннулирование снимает находку', healed.ok === true, `ok=${healed.ok}`)

  // ── Сверка не пишет ЛИШНЕГО ──────────────────────────────────────────────
  // До 30.10.2026 рубеж спрашивал у сверки только «дописала ли она пропущенное» — и это
  // половина вопроса. Вторая половина дороже: не дописала ли она того, чего не было.
  // Два дефекта из девяти разобранных движок внёс САМ, починив предыдущий (Д-29 вырос из
  // `refs/firm2/kept/` в Д-24, Д-25 остался от половинчатой починки Д-21), и оба раза
  // ловил человек замером живого журнала, а не рубеж.
  //
  // Сцена — ровно та, в которой движок соврал: заменённая задача, её работа перенесена
  // МЕТКОЙ в заменяющую (штатный ход с 0.4.114), заменяющая влита. Мерж-коммит с меткой
  // достижим от вершины поставки, но лежит внутри ветки заменяющей задачи. Ложное
  // «влито» здесь стоит дороже пропущенного: оно перебивает решение человека о замене.
  for (const t of ['T-003', 'T-004']) {
    writeFileSync(
      join(root, 'openspec', 'changes', 'ch', 'tasks', `${t}.md`),
      `---\nid: ${t}\ntitle: ${t}\nstatus: todo\n---\n\nПроверочная задача.\n`,
    )
  }
  // Коммитим ТОЛЬКО названные пути и события: `add -A` затянул бы в обе ветки
  // сгенерированный `.firm/dashboard.html` и развёл их на пустом месте.
  const commitWork = (msg, ...paths) => {
    const add = [...paths, '.firm/events'].filter((f) => git('status', '--short', f).trim())
    if (!add.length) return
    git('add', ...add)
    git('commit', '-qm', msg)
  }
  ev('record', '--ticket', 'T-003', '--stage', 'dev', '--event', 'started', '--actor', 'preflight')
  git('checkout', '-q', '-b', 'task/T-003')
  writeFileSync(join(root, 'перенос.txt'), 'работа заменённой задачи\n')
  commitWork('feat(T-003): работа, которую потом перенесут', 'перенос.txt')
  // Вершину сохраняет сам движок (стадия подготовки, Д-24) — здесь воспроизводим ссылку.
  git('update-ref', 'refs/firm2/kept/T-003', 'task/T-003')
  git('checkout', '-q', 'feature/ch')
  ev('record', '--ticket', 'T-003', '--stage', 'lifecycle', '--event', 'superseded',
    '--actor', 'human', '--notes', 'проверка рубежа: заменена T-004')
  commitWork('chore(firm2): события замены')
  ev('record', '--ticket', 'T-004', '--stage', 'dev', '--event', 'started', '--actor', 'preflight')
  git('checkout', '-q', '-b', 'task/T-004')
  writeFileSync(join(root, 'своё.txt'), 'работа заменяющей задачи\n')
  commitWork('feat(T-004): своя работа', 'своё.txt')
  git('merge', '-q', '--no-ff', '--no-edit', '-m', "Merge tag 'kept/T-003' into task/T-004",
    'refs/firm2/kept/T-003')
  git('checkout', '-q', 'feature/ch')
  commitWork('chore(firm2): события T-004')
  git('merge', '-q', '--no-ff', '--no-edit', '-m', 'merge T-004', 'task/T-004')
  ev('sync', '--json')
  const evFiles = readdirSync(join(root, '.firm', 'events'))
  const falseMerge = evFiles.filter((f) => /T-003-merge-finished/.test(f))
  note(
    'сверка не записала слияние заменённой задаче',
    falseMerge.length === 0,
    `нашлось ${falseMerge.length}: перенос работы меткой снова читается как влитость (Д-29)`,
  )
  note(
    'и настоящее слияние заменяющей записала',
    evFiles.some((f) => /T-004-merge-finished/.test(f)),
    'страховка затянута слишком сильно: сверка перестала делать свою работу',
  )
  const board = JSON.parse(st('board', '--json').stdout || '{}')
  const t003 = (board.tasks || []).find((x) => x.id === 'T-003')
  note(
    'решение человека о замене не перебито',
    t003 && t003.status === 'superseded',
    `статус T-003: ${t003 ? t003.status : 'задачи нет на доске'}`,
  )

  // ── Событие, записанное ИЗ СВЯЗАННОГО ДЕРЕВА (отчёт проект-В 03.11.2026, находка 1) ──
  //
  // Выпуск поставки делается в том дереве, где выгружена ветка-цель, а главное дерево в
  // это время стоит на ветке поставки. Git зовёт хук с выставленными `GIT_DIR` и
  // `GIT_INDEX_FILE`, и они СИЛЬНЕЕ ключа `-C`: на проект-В 139 событий выпуска легли файлами
  // в главное дерево, а в индекс — чужого дерева, записями `AD`. Защита от `git clean -fd`,
  // ради которой `git add` там и стоит, не сработала, и `catch` молчал: `add` вернул успех.
  //
  // Воспроизводим ровно это: зовём запись события с окружением связанного дерева и
  // спрашиваем ДВЕ вещи — лежит ли файл на диске в главном дереве и стоит ли он в индексе
  // ГЛАВНОГО дерева. Проверка живая, а не по тексту: имя переменной окружения в исходнике
  // ничего не доказывает, доказывает ответ git.
  {
    const wtPath = join(root, '..', `${basename(root)}-trunk`)
    git('worktree', 'add', '-q', '-b', 'trunk-probe', wtPath, 'feature/ch')
    const gitDir = execFileSync('git', ['-C', wtPath, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const r = spawnSync(process.execPath, [
      join(engine, 'scripts', 'firm-event.mjs'), 'record',
      '--root', root, '--ticket', 'T-004', '--stage', 'guard', '--event', 'worktree-probe',
      '--actor', 'preflight', '--notes', 'запись события из связанного дерева',
    ], {
      encoding: 'utf8',
      cwd: wtPath,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: wtPath,
        GIT_INDEX_FILE: join(gitDir, 'index'),
      },
    })
    const probe = readdirSync(join(root, '.firm', 'events')).filter((f) => /T-004-guard-worktree-probe/.test(f))
    note(
      'событие из связанного дерева записано в главное',
      r.status === 0 && probe.length === 1,
      `код ${r.status}, файлов ${probe.length}: ${firstLine(r.stderr)}`,
    )
    if (probe.length === 1) {
      const rel = join('.firm', 'events', probe[0])
      // `ls-files --error-unmatch` отвечает кодом: 0 — файл в индексе ГЛАВНОГО дерева,
      // иначе он там неотслеживаемый, то есть беззащитен перед `git clean -fd`.
      const inIndex = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], {
        encoding: 'utf8',
      }).status === 0
      // И обратная половина: в индексе ЧУЖОГО дерева его быть не должно — именно там на
      // проект-В стояли 139 записей `AD`, файлов под которыми не существовало.
      const inForeign = spawnSync('git', ['-C', wtPath, 'diff', '--cached', '--name-only'], {
        encoding: 'utf8',
      }).stdout || ''
      note(
        'и в индекс того же дерева, а не чужого',
        inIndex && !inForeign.includes('.firm/events'),
        `в индексе главного: ${inIndex}; в индексе связанного: ${inForeign.trim().split('\n').filter(Boolean).length} путей (ожидалось 0 из .firm/events)`,
      )
    }
    git('worktree', 'remove', '--force', wtPath)
  }
} catch (e) {
  note('прогон по синтетическому проекту', false, String(e && e.message).split('\n')[0])
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (json) {
  process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, steps }, null, 1)}\n`)
} else {
  process.stdout.write(
    fails.length === 0
      ? `\n[firm2] рубеж пройден: ${steps.length} проверок\n`
      : `\n[firm2] НЕ ПРОЙДЕНО, ${fails.length} из ${steps.length}:\n${fails.map((f) => `  · ${f}`).join('\n')}\n`,
  )
}
process.exit(fails.length === 0 ? 0 : 1)
