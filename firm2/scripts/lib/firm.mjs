// Общая библиотека firm2. Node ≥ 20, БЕЗ внешних зависимостей (см. §7 замысла:
// Node гарантирован, потому что его требует OpenSpec; Python в плагин тянуть нельзя).
//
// Здесь живёт всё, что читает и вычисляет состояние поставки:
//   - где корень проекта и что в нём уже инициализировано (§2);
//   - разбор .firm/config и frontmatter задач/багов;
//   - чтение журнала событий (файл-на-событие, ADR-0003);
//   - вывод статуса задачи ИЗ СОБЫТИЙ (события авторитетны, §6);
//   - тайминг: календарное и активное время (§4).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'

// ── Окружение git: снимается ОДИН раз, на весь процесс ────────────────────────
//
// Отчёт проект-В 03.11.2026, находка 1. Выпуск поставки сделан в связанном дереве
// (`проект-В.worktrees/_trunk`, там выгружена ветка-цель; главное дерево стоит на ветке
// поставки — обычное состояние во время сборки). Хук `post-merge` записал 139 событий
// `release/finished`, и каждое легло ДВАЖДЫ не туда: файл — в главное дерево (верно), а
// `git add` — в индекс дерева слияния. Снаружи это 139 записей `AD` в `_trunk` (в индексе
// добавлено, на диске нет) и 139 НЕОТСЛЕЖИВАЕМЫХ файлов в главном дереве.
//
// Причина — ровно та, о которой предупреждает сам хук, только на этаж ниже: git запускает
// хук с выставленным `GIT_DIR` (в связанном дереве — `.git/worktrees/<имя>`) и
// `GIT_INDEX_FILE`, а переменная окружения СИЛЬНЕЕ ключа `-C`. Хук эту ловушку обошёл для
// своих вопросов и передал `--root` в node; внутри node все вызовы `git -C root …`
// получили путь из `root`, а дерево и индекс — из окружения хука.
//
// Поэтому окружение снимается здесь, в единственном месте, которое импортируют все
// скрипты движка, и снимается ЦЕЛИКОМ, а не у одного вызова. Довод за «целиком»: вызовов
// git в движке сорок один, и КАЖДЫЙ из них адресует дерево явным `-C` — то есть ни одному
// из них унаследованное окружение не нужно по построению, а любому оно отвечает про чужое
// дерево. Чинить по одному значит оставить следующий такой же дефект в сорока местах.
//
// Чего это НЕ меняет: вопросы, которые хук задаёт сам (ветка слияния, рефлог, ORIG_HEAD),
// заданы в bash до node и обязаны остаться с окружением — им нужно ТЕКУЩЕЕ дерево. Правило
// после трёх промахов 02.10.2026 то же: ответ берётся у того же дерева, которому задан
// вопрос. Здесь вопрос всегда задан через `-C`, значит и ответ должен быть оттуда.
//
// `git add` молчал и при полном провале: он честно поставил файл в индекс, просто в чужой,
// и `catch` не сработал. Поэтому проверка на место — не try/catch, а шаг рубежа 3ц:
// слияние в связанном дереве, после которого файл события обязан быть и на диске в `root`,
// и в индексе ТОГО ЖЕ `root`.
for (const v of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]) delete process.env[v]

// ── Корень проекта ────────────────────────────────────────────────────────────

// Внимание: вызов может прийти ИЗ WORKTREE задачи (§9), а журнал событий и дашборд
// обязаны быть общими. Поэтому корень — главное рабочее дерево: у worktree
// --git-common-dir указывает на .git основного репозитория.
export function repoRoot(start = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const git = (...a) => execFileSync('git', ['-C', start, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  try {
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
    if (common && basename(common) === '.git') return dirname(common)
  } catch {
    // старый git без --path-format — падаем на show-toplevel ниже
  }
  try {
    return git('rev-parse', '--show-toplevel')
  } catch {
    return resolve(start)
  }
}

// ── Куда писать журнал: дерево, где выгружена ветка-владелец события ──────────
//
// Отчёт проект-В 05.11.2026 (Д-51). Вливание `3d` → `main` сделано в связанном дереве
// `проект-В.worktrees/_trunk` (там выгружен `main`), а главное дерево стояло на уже
// выпущенной `feature/2026-11-03-host-self-serve-game`. Хук записал 35 событий
// `release-finished` по задачам редизайна в ГЛАВНОЕ дерево и там же проиндексировал — то
// есть журнальные записи о выпуске в `main` легли на ветку, к `main` отношения не имеющую.
// Не разбери человек каталог руками, 35 событий не доехали бы никуда, и замер стоимости
// поставки потерял бы весь выпуск целиком.
//
// Почему прежнее правило («корень — всегда главное дерево») было неполным, а не неверным.
// Оно поставлено 01.10.2026 против обратного промаха: событие, записанное в дерево ЗАДАЧИ,
// уезжало на ветку задачи, и журнал поставки раздваивался. Оба промаха — один вопрос,
// заданный неточно. Событие принадлежит не дереву, а ВЕТКЕ: слияние задачи — ветке
// поставки, выпуск — ветке-цели. Писать его надо туда, где эта ветка выгружена, а это ровно
// одно дерево: git не даёт выгрузить одну ветку дважды.
//
// Снятие окружения git (выше) этого не лечило и лечить не могло: файл и так писался в
// главное дерево, а на какой ветке оно стоит, не спрашивал никто.
export function worktreeBranches(root) {
  const out = []
  let listed = ''
  try {
    listed = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return out
  }
  let path = null
  for (const raw of listed.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
      continue
    }
    const m = /^branch refs\/heads\/(.+)$/.exec(line)
    if (m && path) out.push({ path, branch: m[1] })
  }
  return out
}

/**
 * Корень журнала для события, принадлежащего ветке `branch`.
 *
 * Возвращает `{ root, moved, branch, why }`. `moved: true` — ветка выгружена не здесь, и
 * писать надо в другое дерево; это ОБЯЗАНО быть сказано вслух, иначе человек ищет события
 * там, где их нет. Ветка не выгружена нигде — остаёмся на месте: выдумывать дерево хуже,
 * чем записать туда, откуда позвали, и сказать об этом.
 */
export function journalRootFor(root, branch) {
  const want = String(branch || '').trim()
  if (!want) return { root, moved: false, branch: null, why: 'ветка-владелец не названа' }
  const trees = worktreeBranches(root)
  const here = trees.find((w) => w.path === root)
  if (here && here.branch === want) return { root, moved: false, branch: want, why: 'ветка выгружена здесь' }
  const owner = trees.find((w) => w.branch === want)
  if (!owner) {
    return { root, moved: false, branch: want, why: `ветка ${want} не выгружена ни в одном дереве` }
  }
  return {
    root: owner.path,
    moved: owner.path !== root,
    branch: want,
    why: `ветка ${want} выгружена в ${owner.path}`,
  }
}

// ── Мини-YAML (подмножество: то, что реально встречается в .firm/config и frontmatter) ──
// Поддержано: вложенные отображения по отступам, скаляры, булевы, null, числа,
// инлайн-списки [a, b], блочные списки "- item", комментарии.
// Не поддержано намеренно: якоря, многострочные литералы, сложные ключи.

function parseScalar(raw) {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true' || s === 'false') return s === 'true'
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((x) => parseScalar(x))
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

// ── Неизвестный флаг — отказ, а не поведение по умолчанию ─────────────────────
//
// Отчёт проект-В 08.11.2026 (Д-61). Стадия хотела узнать, есть ли у разрушающей команды сухой
// прогон, и спросила `firm-state.mjs prune --help`. Флаг не распознан, не отвергнут — и
// `prune` СНЁС два рабочих дерева. Повезло: работа была влита. Вызов, которым спрашивают
// «что ты умеешь», выполнил удаление каталогов.
//
// Класс ровно тот же, что у Д-50 (`next-id --kind adr` молча отдавал номер задачи):
// неизвестный вход не отвергается, а молча заменяется поведением по умолчанию. Урок там был
// записан прямо — ПОДМЕНА МОЛЧИТ, ОТКАЗ ВИДНО, — и жил он в одном месте, при одном виде
// номера. Поэтому правило переезжает сюда, в единственную библиотеку движка: решение,
// живущее поимённо, отстаёт от следующего скрипта.
//
// Что делает: `--help`/`-h` печатает подсказку и выходит нулём; неизвестный флаг — `exit 2`
// с перечнем известных. Строгость по СКРИПТУ, а не по подкоманде: флаг, законный у соседней
// подкоманды, отказа не вызывает, и это честнее, чем обещать точность, которую пришлось бы
// дописывать руками вслед за каждой правкой.
export function requireKnownFlags(argv, known, { cmd = 'firm2', usage = null } = {}) {
  const list = [...new Set(['root', 'json', ...known])].sort()
  const raw = (argv || []).filter((a) => String(a).startsWith('-') && a !== '-' && a !== '--')
  const help = raw.some((a) => a === '--help' || a === '-h')
  if (help) {
    process.stdout.write(
      usage ||
        `${cmd}: известные флаги — ${list.map((k) => `--${k.replace(/_/g, '-')}`).join(', ')}\n`,
    )
    process.exit(0)
  }
  const unknown = []
  for (const a of raw) {
    const name = String(a).replace(/^--?/, '').split('=')[0].replace(/-/g, '_')
    if (!list.includes(name)) unknown.push(a)
  }
  if (!unknown.length) return
  process.stderr.write(
    `[firm2] ${cmd}: неизвестный флаг ${unknown.join(', ')} — вызов отменён.\n` +
      `Известные: ${list.map((k) => `--${k.replace(/_/g, '-')}`).join(', ')}\n` +
      'Выполнять по умолчанию я не стану: неизвестный вход, молча замененный умолчанием, ' +
      'однажды уже обошёлся удалением — `prune --help` снёс два рабочих дерева (проект-В, Д-61). ' +
      'Подмена молчит, отказ видно.\n',
  )
  process.exit(2)
}

export function parseYaml(text) {
  const root = {}
  // Стек «отступ → контейнер». Список хранится вместе с ключом-владельцем.
  const stack = [{ indent: -1, value: root }]
  let pendingListKey = null
  let pendingListIndent = -1

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    const trimmed = line.trim()

    if (trimmed.startsWith('- ')) {
      if (pendingListKey && indent > pendingListIndent) {
        // Владелец списка — контейнер, в котором объявлен ключ, а не пустое отображение,
        // заведённое под него. До 13.10.2026 здесь брался `value`, и список вложенного
        // ключа ложился сам в себя: `short_lane: paths: [-a]` читался как
        // `{ short_lane: { paths: { paths: [a] } } }`. В конфиге списков тогда не было
        // вовсе, поэтому никто не спотыкался; первый же список (пути короткой полосы)
        // уткнулся в это сразу.
        const top = stack[stack.length - 1]
        const owner = top.listOwner || top.value
        if (!Array.isArray(owner[pendingListKey])) owner[pendingListKey] = []
        owner[pendingListKey].push(parseScalar(trimmed.slice(2)))
      }
      continue
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const container = stack[stack.length - 1].value

    const m = trimmed.match(/^([^:]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const rest = m[2]

    if (rest === '') {
      // Либо вложенное отображение, либо блочный список — решится следующей строкой.
      const child = {}
      container[key] = child
      stack.push({ indent, value: child })
      pendingListKey = key
      pendingListIndent = indent
      // Владелец списка — контейнер уровнем выше, поэтому запомним его отдельно.
      stack[stack.length - 1].listOwner = container
      continue
    }

    container[key] = parseScalar(rest)
    pendingListKey = null
  }

  // Починка: ключи, объявленные как {} но заполненные как список, уже списки —
  // parseYaml пишет список в owner[key], затирая пустой объект. Здесь чистим остатки.
  const prune = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        prune(v)
        if (Object.keys(v).length === 0) o[k] = null
      }
    }
  }
  prune(root)
  return root
}

// Списки внутри вложенных отображений ложатся в тот контейнер, где объявлен их ключ:
// `short_lane: { paths: [...] }`. Глубже двух уровней формат не идёт и не нужен —
// ни конфигу, ни frontmatter задачи.

export function parseFrontmatter(text) {
  const s = String(text)
  if (!s.startsWith('---')) return { data: {}, body: s }
  const end = s.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: s }
  const head = s.slice(s.indexOf('\n') + 1, end)
  const body = s.slice(s.indexOf('\n', end + 1) + 1)
  return { data: parseYaml(head), body }
}

export function stringifyFrontmatterValue(v) {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map((x) => stringifyFrontmatterValue(x)).join(', ')}]`
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return String(v)
}

// Точечная правка одного ключа frontmatter без переписывания файла целиком:
// комментарии и порядок ключей человека сохраняются.
export function patchFrontmatter(path, key, value) {
  const text = readFileSync(path, 'utf8')
  const { data } = parseFrontmatter(text)
  const line = `${key}: ${stringifyFrontmatterValue(value)}`
  const re = new RegExp(`^${key}:.*$`, 'm')
  let out
  if (key in data && re.test(text)) {
    out = text.replace(re, line)
  } else {
    const end = text.indexOf('\n---', 3)
    if (end === -1) return false
    out = text.slice(0, end) + '\n' + line + text.slice(end)
  }
  if (out !== text) writeFileSync(path, out)
  return out !== text
}

// ── Конфигурация и признаки проекта (§2) ──────────────────────────────────────

export function configPath(root) {
  return join(root, '.firm', 'config')
}

export function readConfig(root) {
  const p = configPath(root)
  if (!existsSync(p)) return null
  return parseYaml(readFileSync(p, 'utf8'))
}

const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.kt',
  '.rb', '.php', '.cs', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.scala', '.ex', '.exs',
])
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.codegraph',
  '.firm', 'openspec', '.claude', '.idea', 'target', 'vendor',
])

// has_code: дерево ИСХОДНИКОВ непусто. Каталоги движка и окружения не считаются кодом
// проекта — иначе признак был бы истинным всегда.
export function hasCode(root) {
  let found = false
  const walk = (dir, depth) => {
    if (found || depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (found) return
      if (e.name.startsWith('.') && e.name !== '.') {
        if (SKIP_DIRS.has(e.name)) continue
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(dir, e.name), depth + 1)
      } else {
        const dot = e.name.lastIndexOf('.')
        if (dot > 0 && CODE_EXT.has(e.name.slice(dot))) {
          found = true
          return
        }
      }
    }
  }
  walk(root, 0)
  return found
}

export function firmInitialized(root) {
  return existsSync(configPath(root)) && existsSync(join(root, 'openspec'))
}

export function projectSignals(root) {
  return { firm_initialized: firmInitialized(root), has_code: hasCode(root) }
}

// ── Изменения (changes) и задачи (§4) ─────────────────────────────────────────

export function changesDir(root) {
  return join(root, 'openspec', 'changes')
}

export function listChanges(root) {
  const dir = changesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive')
    .map((e) => e.name)
    .sort()
}

// Задачи поставки лежат в `openspec/changes/<change>/tasks`, пока поставка живая.
// Техписатель архивирует спеку ДО мержа в main, и каталог уезжает в
// `changes/archive/<дата>-<change>`. Git-хук post-merge приходит после и ищет задачи
// по имени поставки — не найдя, он молча выпускал ноль задач, и календарная метрика
// обрывалась на merged (находка пилота 23.09.2026). Поэтому: нет живого каталога —
// ищем архивный, он отличается только датой в начале имени.
export function tasksDir(root, change) {
  if (!change) return null
  const live = join(changesDir(root), change, 'tasks')
  if (existsSync(live)) return live
  const arch = join(changesDir(root), 'archive')
  if (!existsSync(arch)) return live
  const hit = readdirSync(arch, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === change || e.name.endsWith(`-${change}`)))
    .map((e) => e.name)
    .sort()
    .pop()
  return hit ? join(arch, hit, 'tasks') : live
}

export function listTasks(root, change) {
  const dir = tasksDir(root, change)
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^T-[\w.-]+\.md$/.test(f))
    .sort()
    .map((f) => {
      const path = join(dir, f)
      const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'))
      return {
        id: data.id || basename(f, '.md'),
        path,
        rel: path.slice(root.length + 1),
        title: data.title || '',
        epic: data.epic || null,
        cached_status: data.status || 'todo',
        depends_on: toArray(data.depends_on),
        parallel_safe: data.parallel_safe === true,
        // Почему задача идёт ОДНА. Поле объявлено 05.10.2026 по замеру обкатки проект-В:
        // 43 задачи из 72 были исключительными, и машина 82% рабочего времени вела одну
        // стадию при трёх настроенных слотах. Исключительность стоит не «потерянного
        // часа», как было написано в чек-листе, а удвоения календарного срока поставки,
        // поэтому молчание тут больше не нейтрально: причину называют словами.
        exclusive_why: data.exclusive_why || null,
        ui: data.ui === true,
        // Чем ПОДТВЕРЖДЕНЫ числа в критериях: живым прогоном или арифметикой. Поле
        // объявлено 11.10.2026 по разбору T-086 на проект-В: планирование посчитало чип
        // имени в 199,03 px, живой прогон дал 278,89 — и вся схема задачи развалилась на
        // стадии dev. Поле той же семьи, что `exclusive_why`: движок не запрещает число,
        // он требует назвать его источник. Пусто при числах в критериях — находка.
        measured: data.measured || null,
        // ЗАКРЫТЫЙ перечень, над которым квантован критерий. Поле объявлено 10.11.2026 по
        // разбору T-374 на проект-В: критерий «ни один тест экрана не покраснел» квантован по
        // множеству «тесты экрана», которого карточка не перечисляла, — и три захода добирали
        // это множество каждый своим грепом, каждый раз не тем. Замер отчёта: три задачи
        // поставки (T-374, T-404, T-414) отклонены ИМЕННО за самодельный признак инвентаря,
        // две (T-374, T-209) исчерпали на этом по три попытки.
        //
        // Поле той же семьи, что `measured` и `exclusive_why`, и по тому же правилу: движок
        // не запрещает квантор, он требует назвать множество. Второе, что оно даёт помимо
        // находки: инвентарь — то, что исполнитель НЕ ВПРАВЕ добирать сам, и это теперь
        // сказано полем один раз, а не прозой в каждой рискованной карточке.
        inventory: toArray(data.inventory),
        labels: toArray(data.labels),
        br_refs: toArray(data.br_refs),
        fixes: data.fixes || null,
        // Чем задача заменена. Не статус (тот принадлежит журналу), а ссылка — из той же
        // семьи, что `depends_on` и `fixes`. Нужна, чтобы `doctor` мог предложить, на
        // какую задачу перевесить баги с заменённой.
        superseded_by: toArray(data.superseded_by),
        worktree: data.worktree || null,
        body,
      }
    })
}

// ── Обещания конфига про систему контроля версий ─────────────────────────────
//
// Секция `vcs` до 0.4.63 не читалась КОДОМ ни разу: слово `vcs` встречалось только в
// промпте DevOps и в `firm-build.md`. То есть конфиг мог обещать github и `origin`, а
// удалённого репозитория не существовать вовсе — и узнавал об этом DevOps на шаге выдачи,
// когда вся поставка уже сделана и остаётся оформить PR. Самый поздний момент из
// возможных. Случай проект-В 05.10.2026: `host: github`, `remote: origin`, `git remote` пуст.
//
// Это то же семейство, что запрет на снятие песочницы (Д-16): заявление, за которым никто
// не следит. Разница в направлении — там защита без исполнителя, тут обещание без проверки.
//
// Чего здесь намеренно НЕТ: сетевых проверок. Права на пуш, существование репозитория на
// той стороне, годность токена — всё это узнаётся только запросом, а `doctor` и `phase`
// зовут из хуков и монитора, и ставить их в зависимость от интернета нельзя. Проверяется
// ровно то, что видно локально, — и этого хватает на случай «remote не настроен вовсе».
export function vcsFindings(root, cfg) {
  const vcs = (cfg && cfg.vcs) || null
  if (!vcs || !vcs.host) return [] // секции нет — проект ведёт выдачу руками, и это законно
  const out = []
  const git = (...a) => {
    try {
      return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const remotes = (git('remote') || '').split('\n').map((x) => x.trim()).filter(Boolean)
  const want = String(vcs.remote || 'origin')
  if (!remotes.length) {
    out.push(
      `vcs.host: ${vcs.host} заявлен, но удалённого репозитория нет вовсе — PR оформить ` +
        'будет нечем, и выяснится это на шаге выдачи, когда поставка уже сделана. ' +
        `Завести: git remote add ${want} <url>`,
    )
  } else if (!remotes.includes(want)) {
    out.push(
      `vcs.remote: ${want} — такого удалённого нет. Есть: ${remotes.join(', ')}. ` +
        'Либо поправь ключ, либо заведи этот remote',
    )
  }
  const target = vcs.target_branch ? String(vcs.target_branch) : null
  if (target) {
    // Ветка годится и локальная, и удалённая: поставка вливается в локальную, а PR
    // открывается против удалённой, и на разных стадиях верны разные ответы.
    const local = git('rev-parse', '--verify', '--quiet', `refs/heads/${target}`)
    const remote = remotes.length ? git('rev-parse', '--verify', '--quiet', `refs/remotes/${want}/${target}`) : null
    if (!local && !remote) {
      out.push(
        `vcs.target_branch: ${target} — такой ветки нет ни локально, ни на ${want}. ` +
          'Поставке некуда вливаться',
      )
    }
  }
  return out
}

// ── Форма плана ──────────────────────────────────────────────────────────────
//
// Отвечает на вопрос, которого Архитектор не видел вовсе: «за сколько заходов эта поставка
// пройдёт конвейер». Не «сколько задач» — задач может быть семьдесят пять, а идти они будут
// по одной. Календарный срок задаёт число ВОЛН: волна — это то, что запускается
// одновременно, и каждая стоит полного такта dev → test → review.
//
// Считаются три числа, и смысл в их разнице:
//
//   plan   — как спланировано: зависимости плюс пометки `exclusive` плюс потолок;
//   free   — то же без `exclusive`: сколько было бы, если исключительность снять;
//   floor  — минимум по форме графа: max(глубина зависимостей, задач / потолок).
//            Ниже этого не опускает ничто: либо цепочка длинная, либо слотов мало.
//
// `plan − free` — цена пометок, `free − floor` — цена формы резки. Замер 05.10.2026:
// проект-В 54 / 27 / 25, проект-Г 34 / 20 / 15. То есть граф у обоих почти оптимален
// (27 против 25), а половина календаря уходит на `exclusive` — и это не было видно ничем.
//
// Прогноз нарочно считает волны РАВНЫМИ по времени, а они не равны: волна из одной
// исключительной задачи дешевле волны из трёх. Для вопроса «где я теряю календарь» этого
// достаточно, для обещания срока — нет, и так и сказано в выводе команды.
export function dependencyDepth(tasks) {
  const ids = new Set(tasks.map((t) => t.id))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const depth = new Map()
  const visit = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id)
    if (seen.has(id)) return 0 // цикл в depends_on — не зацикливаемся (как в дашборде)
    seen.add(id)
    const t = byId.get(id)
    const deps = t ? t.depends_on.filter((d) => ids.has(d)) : []
    const d = deps.length ? Math.max(...deps.map((x) => visit(x, seen))) + 1 : 0
    depth.set(id, d)
    return d
  }
  tasks.forEach((t) => visit(t.id))
  return depth
}

// Прокрутка вперёд от уже сделанного. `done` — задачи, которых ждать не нужно (влитые):
// так одна и та же функция отвечает и на «сколько всего» (пустой done, на планировании),
// и на «сколько осталось» (влитые переданы, на сборке).
// `held` — задачи, которые прокрутка НЕ берёт и НЕ закрывает: заблокированные и снятые.
// Передавать их всё равно нужно, и это не формальность: зависимость на заблокированную
// задачу не исчезает от того, что прогон её не трогает. Выброси такую задачу из списка —
// и её идентификатор пропадёт из `ids`, то есть зависимость на неё станет считаться
// выполненной, а зависимые задачи уедут в волны, в которые они не пойдут. Держим в
// списке, не пускаем в волну, и зависимые честно оказываются в `stuck`.
export function waves(tasks, { parallelism = 3, respectExclusive = true, done = [], held = [] } = {}) {
  const ids = new Set(tasks.map((t) => t.id))
  const closed = new Set(done)
  const stopped = new Set(held)
  let rest = tasks.filter((t) => !closed.has(t.id) && !stopped.has(t.id))
  const out = []
  // Предел оборотов НЕДОСТИЖИМ при нынешнем теле цикла, и это проверено мутацией: снятие
  // предела не роняет ни одного теста. Каждый виток либо возвращает `stuck` (готовых нет),
  // либо берёт хотя бы одну задачу — `Math.max(1, parallelism)` и `exclusive[0]` не дают
  // взять ноль, — то есть `rest` строго убывает. Оставлен намеренно и описан как мёртвый:
  // «прокрутка вперёд по графу» — ровно тот алгоритм, который при следующей правке легко
  // сделать зависающим, а зависший хук или команда диагностируются дороже всего. Убрать
  // его можно, но тогда и тест на цикл перестанет что-либо гарантировать.
  while (rest.length && out.length <= tasks.length + 1) {
    const ready = rest.filter((t) => t.depends_on.filter((d) => ids.has(d)).every((d) => closed.has(d)))
    if (!ready.length) return { waves: out, stuck: rest.map((t) => t.id) }
    const exclusive = respectExclusive ? ready.filter((t) => !t.parallel_safe) : []
    // Исключительная задача забирает волну себе целиком — ровно так её пускает планировщик.
    const take = exclusive.length ? [exclusive[0]] : ready.slice(0, Math.max(1, parallelism))
    out.push(take.map((t) => t.id))
    take.forEach((t) => closed.add(t.id))
    rest = rest.filter((t) => !take.includes(t))
  }
  return { waves: out, stuck: rest.length ? rest.map((t) => t.id) : null }
}

export function planShape(tasks, { parallelism = 3, done = [] } = {}) {
  const closed = new Set(done)
  const live = tasks.filter((t) => !closed.has(t.id))
  if (!live.length) return { tasks: 0, parallelism, waves: 0, waves_without_exclusive: 0, floor: 0 }
  // Глубина считается по ОСТАВШЕМУСЯ подграфу: зависимость на уже влитую задачу ждать не
  // заставляет, и учитывать её в длине цепочки значит завышать минимум. Иначе на проект-В
  // выходила бессмыслица — «минимум 11 волн» при десяти оставшихся задачах и прогнозе 10.
  const depth = dependencyDepth(live.map((t) => ({ ...t, depends_on: t.depends_on.filter((d) => !closed.has(d)) })))
  const deepest = Math.max(0, ...live.map((t) => depth.get(t.id) || 0)) + 1
  const plan = waves(tasks, { parallelism, done })
  const free = waves(tasks, { parallelism, done, respectExclusive: false })
  const exclusive = live.filter((t) => !t.parallel_safe)
  const widths = plan.waves.map((w) => w.length)
  return {
    tasks: live.length,
    parallelism,
    depth: deepest,
    floor: Math.max(deepest, Math.ceil(live.length / parallelism)),
    waves: plan.waves.length,
    waves_without_exclusive: free.waves.length,
    avg_width: widths.length ? Number((widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(1)) : 0,
    exclusive: exclusive.length,
    exclusive_without_why: exclusive.filter((t) => !t.exclusive_why).length,
    cost_of_exclusive: plan.waves.length - free.waves.length,
    stuck: plan.stuck || null,
    first_waves: plan.waves.slice(0, 5),
  }
}

// ── Пауза прогона ────────────────────────────────────────────────────────────
//
// Флаг лежит в `.firm/current/` — каталоге из .gitignore: это состояние одного прогона на
// одной машине, в репозитории ему не место. Отсюда важное следствие, на котором спотыкались:
// каталога нет в рабочих деревьях задач. Читать его поэтому можно только от КОРНЯ ПОСТАВКИ,
// а корень `repoRoot()` выводит из общего `.git` (`--git-common-dir`) — то есть из рабочего
// дерева задачи он всё равно разрешается в главное. Проверено 05.10.2026 из
// проект-В.worktrees/T-059: пауза читается верно.
//
// Живёт здесь, а не в `firm-state.mjs`, потому что читателей стало два: команда `paused`
// и хук `SubagentStart`, который паузу ТЕПЕРЬ И ДЕРЖИТ. Два чтения одного файла двумя
// способами — это уже два разных ответа на один вопрос.
export function pauseFilePath(root) {
  return join(root, '.firm', 'current', 'pause.json')
}

export function pauseState(root) {
  const p = pauseFilePath(root)
  if (!existsSync(p)) return { paused: false }
  try {
    return { paused: true, ...JSON.parse(readFileSync(p, 'utf8')) }
  } catch {
    // Файл есть, но нечитаем — это пауза. Неизвестность здесь останавливает (ADR-0007),
    // и цена ошибок несимметрична: лишняя остановка стоит одной команды `resume`.
    return { paused: true, reason: null }
  }
}

// ── Порог «стадия идёт слишком долго» ─────────────────────────────────────────
//
// Один порог на все стадии был неверен с обеих сторон. Поставленный 24.09.2026 на 25
// минут, он считался по журналу, где медиана стадии была 3.9 минуты, а p90 — 9.8. Через
// десять дней замер по четырём пилотам (628 законченных стадий) выглядит так:
//
//   dev     медиана  9  p90 29  p95 38  макс 141
//   test    медиана  5  p90 16  p95 20
//   review  медиана  4  p90 12  p95 16
//
// То есть 25 минут для `dev` — это уже норма (десятая часть стадий дольше), а для
// `review` — втрое выше его же p95. Сигнал одновременно шумел на разработке и молчал на
// ревью. Разброс между проектами ещё больше: p95 стадии `dev` — 52 минуты на проект-В и
// 21 на проект-Б, и один вшитый в движок номер не может быть верен для обоих.
//
// Поэтому порог считается из ЖУРНАЛА САМОГО ПРОЕКТА: p95 его собственных законченных
// стадий этого типа, округлённый вверх до пяти минут. Пока статистики мало (меньше
// двадцати стадий), берётся зашитое значение по замеру пилотов — не выдумка, но и не
// знание о конкретном проекте. Человеческая настройка `monitor.long_stage_min` сильнее
// любого расчёта и применяется ко всем стадиям: если её поставили руками, значит знают
// про этот проект больше движка.
// ── Бюджет стадии ────────────────────────────────────────────────────────────
//
// Порог «долгой стадии» выше отвечает на вопрос «долго ли по меркам ЭТОГО проекта» и
// ничего не запрещает. Бюджет отвечает на другой вопрос — «сколько стадия имеет право
// идти», — и он не наблюдение, а правило: его называют стадии в промпте, и перерасход
// помечается на событии.
//
// Тридцать минут — не вкус. Замер проект-В 30.10.2026 по 62 стадиям последней волны:
// медиана стадии разработки 15.3 минуты, теста 17.3; средние 21.9 и 23.7; максимумы 135.9
// и 154.8. То есть бюджет вдвое выше медианы — он не трогает нормальную работу вовсе и
// бьёт только по хвосту, а хвост в той волне был не работой: 7.3 часа из 15.1 стадии
// провели в циклах ожидания собственных прогонов.
//
// Проект может поставить своё (`stage_budget: { dev: 45 }`) или снять вовсе
// (`stage_budget: off`) — тогда перерасход не считается ни для одной стадии. Снятие
// честнее тихого завышения: «бюджета нет» видно в конфиге.
export const STAGE_BUDGET_DEFAULTS = { dev: 30, test: 30 }

export function stageBudget(cfg) {
  const raw = cfg && cfg.stage_budget
  if (raw === false || String(raw) === 'off' || String(raw) === 'none') return {}
  const out = { ...STAGE_BUDGET_DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const [stage, v] of Object.entries(raw)) {
      const n = Number(v)
      if (String(v) === 'off' || v === false) delete out[stage]
      else if (n > 0) out[stage] = n
    }
  }
  return out
}

// ── Сколько стадий шло одновременно ─────────────────────────────────────────
//
// Заведено 10.11.2026 по предложению проект-В (разбор T-374, п.4). Заход 3 отказался
// выдавать свои 40 красных за вердикт — отказ правильный, — но обоснован он был ПРОЗОЙ
// («нагрузка была высокой, прогон шёл втрое дольше»), и проверить это постфактум было
// нечем: ни стадия, ни оркестратор, ни `doctor` не знали, сколько стадий шло разом.
//
// проект-В просил взять числа у рантайма. Их там НЕТ: закрывающее событие пишет хук
// `SubagentStop` — отдельный процесс на подагента, про соседние стадии он не знает
// ничего. Зато знает ЖУРНАЛ: открытая стадия — это `started` по `agent_id`, у которого
// нет ни одного события кроме старта. Источник от этого только лучше — он append-only
// и перепроверяется чтением файлов, а не доверяется рантайму (ADR-0006).
//
// Отсечка в восемь часов — та же, что у перерасхода бюджета: без неё брошенная стадия
// числилась бы открытой вечно и надувала число на каждом следующем событии. `agent_id`
// обязателен: без него старт с финишем не связать, и ответом будет `null` — «не знаю»,
// а не нуль (И-12).
export function concurrencyAt(events, self, { taskById = null, caps = null } = {}) {
  if (!self || !self.agent_id || !self.ts) return null
  const at = Date.parse(self.ts)
  if (!Number.isFinite(at)) return null
  const STALE_MS = 8 * 3600 * 1000
  const started = new Map()
  const closed = new Set()
  for (const e of events || []) {
    if (e._broken || !e.agent_id) continue
    if (e.event === 'started') { if (!started.has(e.agent_id)) started.set(e.agent_id, e) }
    else closed.add(e.agent_id)
  }
  const open = []
  for (const [id, ev] of started) {
    if (id === self.agent_id || closed.has(id)) continue
    const t = Date.parse(ev.ts)
    if (!Number.isFinite(t) || t > at || at - t > STALE_MS) continue
    open.push(ev)
  }
  const out = { stages: open.length + 1 }
  // Полоса считается только если потолки названы: иначе «сколько из них той же полосы» —
  // вопрос без определения, и нуль в этом поле читался бы как замер.
  const mine = taskById && caps ? lanesOf(taskById.get(self.ticket), caps) : []
  if (mine.length) {
    const mineSet = new Set(mine)
    const same = open.filter((e) => lanesOf(taskById.get(e.ticket), caps).some((l) => mineSet.has(l)))
    out.lane = same.length + 1
  }
  return out
}

// ── Полосы одновременности ───────────────────────────────────────────────────
//
// Третье состояние между «идёт со всеми» и «идёт одна». Заведено 10.11.2026 по
// предложению проект-В (разбор T-374): планировщик знал ровно два, и поэтому `parallelism: 8`
// означал «восемь браузеров одновременно», чего на машине не бывает. Метка
// `требует-браузера` при этом читалась движком в восьми местах и ни в одном не
// ограничивала одновременность.
//
// Почему потолок живёт в КОНФИГЕ, а не в задаче: это свойство машины, а не задачи (цена
// одновременности у проект-В замерена своим бегунком — concurrency 4 даёт 2,59×, и
// покупается это тремя мигающими красными). Задача про себя говорит меткой, которая у
// неё уже есть, — нового реквизита полоса не требует.
//
// Цена отсутствия среднего состояния, замеренная: единственный рычаг проекта —
// `parallel_safe: false`, и T-415 пришлось объявить исключительной, хотя ей нужно было
// «не одновременно с другой БРАУЗЕРНОЙ задачей». Теперь она блокирует собой задачу про
// документы. Тот же перерасход календаря, под который заведён `exclusive_why`.
//
// Ключа нет — поведение прежнее, то есть ни один чужой проект не меняется.
//
//   lanes:
//     требует-браузера: 1
export function laneCaps(cfg) {
  const raw = cfg && cfg.lanes
  const out = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [label, v] of Object.entries(raw)) {
      const n = Number(v)
      // ЦЕЛОЕ, а не округление дробного: округление дало бы второй ответ на то же
      // правило — `laneWarnings` ниже зовёт дробный потолок непримененным, и при
      // `Math.floor` эти двое расходились бы на `lanes: {х: 1.5}` (полоса работает, а
      // ворота говорят, что нет). Один и тот же предикат на оба ответа.
      if (Number.isInteger(n) && n > 0) out[String(label)] = n
    }
  }
  return out
}

// Полосы, в которые попадает задача: пересечение её меток с названными потолками. Задача
// может быть сразу в нескольких — тогда её держит самая узкая из них.
export function lanesOf(task, caps) {
  const labels = new Set((task && task.labels) || [])
  return Object.keys(caps || {}).filter((l) => labels.has(l))
}

// Негодный потолок полосы — находка, а не молчаливое игнорирование: `lanes: {требует-браузера: 0}`
// читается человеком как «запретить вовсе», а значил бы «ключа нет». Разница между этими
// двумя ответами — остановка прогона против полной одновременности, и угадывать её движок
// не вправе (ADR-0007).
export function laneWarnings(cfg) {
  const raw = cfg && cfg.lanes
  const out = []
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    out.push('lanes в .firm/config — не отображение «метка: потолок»; полосы не применяются ни одна')
    return out
  }
  for (const [label, v] of Object.entries(raw)) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      out.push(
        `lanes.${label} = ${JSON.stringify(v)} — потолок полосы должен быть целым больше нуля. ` +
        `Полоса не применяется, то есть задачи с этой меткой идут БЕЗ ограничения; если ` +
        `нужно «не одновременно ни с кем» — это parallel_safe: false у задачи, а не нуль здесь`,
      )
    }
  }
  return out
}

// Несведённый индекс ГЛАВНОГО дерева (Д-34). Пока он есть, git отказывается НАЧИНАТЬ
// любое слияние — и падает оно с именем следующей задачи, а не того, кто оставил после
// себя конфликт. Чаще всего это карман шага слияния, который не свёлся обратно на `pop`.
//
// `null` — честное «не знаю» (git не ответил, не репозиторий): направление открытое, это
// не дыра в журнале и ничего не блокирует, но назвать его надо ДО запуска сборки.
export function unmergedPaths(root) {
  let out
  try {
    out = execFileSync('git', ['-C', root, 'ls-files', '-u'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const paths = new Set()
  for (const line of out.split('\n')) {
    // Формат: «<режим> <sha> <стадия>\t<путь>». Нужен только путь, и стадий у одного
    // пути до трёх — поэтому множество, а не список: человеку важны файлы, не стадии.
    const tab = line.indexOf('\t')
    if (tab > 0) paths.add(line.slice(tab + 1))
  }
  return [...paths]
}

// Деревья движка: он заводит их сам, они не про задачу, и уборка задач их не касается.
// `_trunk` — красные на ветке-цели, `_base` — красные на точке ветвления волны. Признак
// один (имя с подчёркивания), чтобы третье такое дерево не потребовало правки в четырёх
// местах: до 0.4.115 `_trunk` был выписан поимённо, и `_base` пришлось бы вписывать туда же.
export function isEngineTree(name) {
  return /^_[a-z][a-z0-9-]*$/.test(String(name || ''))
}

export const LONG_STAGE_DEFAULTS = { dev: 45, test: 25, review: 20, adjudicate: 30, design: 45, docs: 30, merge: 15 }
export const LONG_STAGE_FALLBACK = 30
const LONG_STAGE_MIN_FLOOR = 15
const LONG_STAGE_MAX_CAP = 120
const LONG_STAGE_SAMPLE = 20

export function stageDurations(events) {
  const by = new Map()
  for (const e of events) {
    if (e._broken || !e.agent_id) continue
    if (!by.has(e.agent_id)) by.set(e.agent_id, [])
    by.get(e.agent_id).push(e)
  }
  const out = new Map()
  for (const list of by.values()) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    const s = list.find((e) => e.event === 'started')
    const f = [...list].reverse().find((e) => e.event !== 'started')
    if (!s || !f || !s.ts || !f.ts) continue
    const stage = s.stage || f.stage
    const mins = (Date.parse(f.ts) - Date.parse(s.ts)) / 60000
    // Отрицательное и многочасовое — не длительность стадии, а след брошенного старта
    // или рассогласованных часов. Такие в расчёт порога не берём: порог должен отвечать
    // на вопрос «долго ли по меркам этого проекта», а не «бывала ли авария».
    if (!(mins > 0 && mins < 480)) continue
    if (!out.has(stage)) out.set(stage, [])
    out.get(stage).push(mins)
  }
  return out
}

export function stageThresholds(events, cfg) {
  const override = Number(cfg && cfg.monitor && cfg.monitor.long_stage_min)
  const byStage = stageDurations(events || [])
  const out = {}
  const stages = new Set([...Object.keys(LONG_STAGE_DEFAULTS), ...byStage.keys()])
  for (const stage of stages) {
    if (override > 0) {
      out[stage] = { min: override, source: 'конфиг' }
      continue
    }
    const v = (byStage.get(stage) || []).slice().sort((a, b) => a - b)
    if (v.length >= LONG_STAGE_SAMPLE) {
      const p95 = v[Math.min(v.length - 1, Math.floor(0.95 * v.length))]
      const rounded = Math.ceil(p95 / 5) * 5
      out[stage] = {
        min: Math.max(LONG_STAGE_MIN_FLOOR, Math.min(LONG_STAGE_MAX_CAP, rounded)),
        source: `p95 журнала, ${v.length} стадий`,
      }
    } else {
      out[stage] = {
        min: LONG_STAGE_DEFAULTS[stage] || LONG_STAGE_FALLBACK,
        source: 'замер пилотов',
      }
    }
  }
  out._default = override > 0
    ? { min: override, source: 'конфиг' }
    : { min: LONG_STAGE_FALLBACK, source: 'замер пилотов' }
  return out
}

// ── Области кода и сверка их с пометками задачи ───────────────────────────────
//
// Замер обкатки проект-В 05.10.2026, 66 влитых задач, классифицированных по ФАКТИЧЕСКОМУ
// диффу ветки задачи, а не по флагу `ui`:
//
//   смешанная (экран + сервер) — 20 задач, 1.95 бага на задачу, 77% найдены поздно;
//   только экран               —  9 задач, 1.44 бага,           77% поздно;
//   только сервер              — 23 задачи, 1.09 бага,          40% поздно.
//
// Серверные дефекты ловит автоматический контур; экранные до него не доходят вовсе —
// их находит человек на демо. А флаг `ui` расходился с диффом у 13 задач из 66, в обе
// стороны: T-001 правил 14 файлов экрана при `ui: false` (значит, к Дизайнеру не ходил
// и в макет не попал — это потом всплыло как «сверка с макетом односторонняя»), а
// T-052 стоял `ui: true`, не тронув экран ни разу.
//
// Поэтому движок сверяет пометки с диффом. Не запрещает и не правит — называет.
// Области он знать не может (они свои в каждом проекте), поэтому берёт их из конфига и
// МОЛЧИТ, когда их там нет: выдумать «web/ — это экран» за проект значит соврать в
// половине проектов (ADR-0007).
//
//   areas:
//     ui: "web/"              # область экрана; имя `ui` особенное — с ним сверяется флаг
//     server: "app/, api/"    # остальные имена произвольны, перечисление через запятую
export function areaRules(cfg) {
  const a = cfg && cfg.areas
  if (!a || typeof a !== 'object') return []
  const out = []
  for (const [name, raw] of Object.entries(a)) {
    const prefixes = String(raw || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    if (prefixes.length) out.push({ name, prefixes })
  }
  return out
}

export function areasOfFiles(files, rules) {
  const hit = new Set()
  for (const f of files) {
    for (const r of rules) {
      if (r.prefixes.some((p) => f === p || f.startsWith(p))) hit.add(r.name)
    }
  }
  return hit
}

// Какие файлы правила каждая задача поставки. Один вызов git на всю поставку, а не по
// вызову на задачу: дашборд пересобирается на каждом событии, и шестьдесят процессов git
// на сборку — это не проверка, а налог.
//
// Привязка по имени коммита. Это не догадка о чужих привычках: формат задаёт сам движок
// (`commitRule` в сборщике велит ролям `feat(T-XXX): …`), поэтому номер задачи в заголовке
// есть у каждого коммита, который делала стадия. Мерж-коммиты git не показывает по
// умолчанию, и это правильно — их содержимое уже посчитано по исходным коммитам.
export function filesByTask(root, change) {
  const out = new Map()
  if (!change) return out
  const branch = `feature/${change}`
  let lines = []
  try {
    lines = execFileSync('git', ['-C', root, 'log', branch, '--name-only', '--format=\x01%s'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    }).split('\n')
  } catch {
    return out
  }
  let current = null
  for (const line of lines) {
    if (line.startsWith('\x01')) {
      const m = line.slice(1).match(/\(?(T-[\w.]+)[,)]/)
      current = m ? m[1] : null
      continue
    }
    const f = line.trim()
    if (!current || !f) continue
    if (!out.has(current)) out.set(current, new Set())
    out.get(current).add(f)
  }
  return out
}

// Что сказать про задачу, у которой дифф расходится с пометками. Возвращает строки —
// решение остаётся человеку, движок только не молчит.
export function areaFindings(task, files, rules) {
  if (!rules.length || !files || !files.size) return []
  const hit = areasOfFiles(files, rules)
  const hasUi = rules.some((r) => r.name === 'ui')
  const touchedUi = hit.has('ui')
  const other = [...hit].filter((n) => n !== 'ui')
  const out = []
  if (hasUi && touchedUi && !task.ui) {
    out.push(
      `${task.id}: правит экран, но стоит ui: false — задача не ходила к Дизайнеру и в макет не попала`,
    )
  }
  if (hasUi && !touchedUi && task.ui) {
    out.push(`${task.id}: помечена ui: true, но ни одного файла экрана не тронула`)
  }
  if (hasUi && touchedUi && !(task.labels || []).includes('требует-браузера')) {
    out.push(`${task.id}: правит экран без метки «требует-браузера» — живой проверки не было`)
  }
  if (hasUi && touchedUi && other.length) {
    out.push(
      `${task.id}: смешанная — правит и экран, и ${other.join(', ')}; ` +
        'у такого класса на обкатке вдвое больше дефектов и 77% из них находит человек на демо',
    )
  }
  return out
}

export function toArray(v) {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== '')
  return [v]
}

// ── Журнал событий (ADR-0003: один файл на событие) ───────────────────────────

// `lifecycle` — не стадия работы, а решение о СУДЬБЕ задачи: заменена, отменена. По
// ADR-0001 истина о задачах — журнал, значит решение, не попавшее в журнал, для движка
// не существует: на пилоте 24.09.2026 задача с `superseded_by` во frontmatter вышла на
// вход сборки третий раз, а ближайший `sync` затёр бы это поле статусом из журнала.
// Словарь стадий — один на движок. Доска, тайминг, дашборд и doctor обязаны брать имена
// отсюда: проекция, не знающая стадии, молча теряет её время. Так уже было — стадия
// `adjudicate` не числилась в таблице «роль → стадия», и самая долгая стадия цикла
// (34 минуты на прогоне 24.09.2026) не существовала для тайминга вовсе: её время уходило
// в «ожидание человека», то есть в метрику, по которой судят о работе ЧЕЛОВЕКА.
//
// До 01.10.2026 этот список был объявлен, не использовался нигде и успел отстать от
// жизни: в нём не было ни `adjudicate`, ни `design`, ни `docs`, хотя события с такими
// стадиями в журналах есть. Словарь, который ничего не проверяет, перестаёт быть
// словарём, поэтому теперь на него опирается дашборд (см. STAGE_ORDER).
export const STAGES = [
  'dev', // разработка
  'test', // тесты
  'review', // ревью-QA
  'adjudicate', // арбитраж Архитектора, когда панель QA разошлась
  'design', // ворота дизайна (человек)
  'docs', // SDD-документация
  'merge', // слияние ветки задачи в поставку
  'demo', // демо-ворота (человек)
  'release', // выпуск поставки
  'lifecycle', // судьба задачи: заменена, отменена, вернулась из эскалации
  'guard', // защита движка сработала: снятие песочницы, запись мимо дерева
  // `gate` — ворота человека ВНУТРИ задачи: он утвердил содержимое, без которого стадия
  // идти не может (тексты, макет, список правил). Добавлено 22.10.2026 по факту: событие
  // такой стадии уже лежало в журнале проект-В (T-095, 12.10.2026), потому что `record`
  // принимал любое имя. Словарь отстал от жизни молча — ровно то, что здесь уже было с
  // `adjudicate`, `design` и `docs`. Теперь имя стадии проверяется на записи
  // (`firm-event.mjs record`), и отстать так же тихо он больше не может.
  'gate',
  // `groom` — стадия РАЗВЕДКИ темы: PM собирает требования, Дизайнер — перечень экранов,
  // Архитектор — решения и влияние на код (`/firm-discovery`). Заведена 25.10.2026, до
  // того эти стадии писались с `ticket: MR` и `change: null` — дырой это не было, но
  // стоило замера: сказать «разведка темы G-007 стоила столько-то» было нечем. Стадия
  // одна на три роли намеренно: «кто именно» лежит в `actor`, а разведка как работа —
  // одна, и мерить её надо целиком. Привязка — номер темы (`FIRM2-GROOM: G-XXX`).
  'groom',
]
// `failed` — исход стадии, который до 23.09.2026 просто не записывался: слияние
// отказывало, событие не писал никто, и задача оставалась в журнале с открытой
// стадией merge. Снаружи это выглядело как зависшая стадия, а doctor отвечал ok.
// `abandoned` — стадия, которая не кончилась ни успехом, ни провалом: прогон сняли
// (TaskStop, падение сессии, Ctrl+C), субагента убили, финиша не будет никогда.
// Отдельный вид нужен потому, что три состояния здесь содержательно разные: `finished` —
// работа сделана, `failed` — сделана и не прошла, `abandoned` — не делалась вовсе.
// Сочинить вместо этого `finished` нельзя: тайминг тогда получит интервал работы,
// которой не было, а это хуже открытого интервала — ложь вместо пробела.
// `retracted` — аннулирование. Единственный вид события, который НИЧЕГО не добавляет к
// состоянию: он лишь называет в `corrects` файл неверного события, и при чтении тот
// исключается из расчёта. Нужен потому, что исправлять ошибку «того же вида» нельзя:
// `merge/finished --corrects X` остаётся ещё одним `merge/finished`, а события «развлито»
// в маршруте нет и быть не должно. Отличается от `abandoned` намеренно: брошенная стадия
// — это событие, которое ПРОИЗОШЛО (прогон сняли), а аннулирование говорит, что прежнее
// событие не происходило вовсе. Поэтому в `statusFromEvents` для него нет ветки: убрать
// лишнее и есть вся его работа.
// `paused`/`resumed` — решение человека остановить и продолжить прогон. Появились
// 28.10.2026, когда понадобилось считать время БЕЗ ожидания: пауза жила только файлом в
// `.firm/current/` — состоянием одной машины, которого нет ни в git, ни в журнале, — и
// вопрос «сколько поставка стояла на паузе» машинного ответа не имел вовсе. Это та же
// дыра, что Д-12: решение человека без представления в журнале. Флаг остаётся флагом
// (он про «сейчас»), а журнал получает факт (он про «что было).
export const EVENT_KINDS = ['started', 'finished', 'accepted', 'rejected', 'escalated', 'arbitrated', 'failed', 'superseded', 'cancelled', 'abandoned', 'retracted', 'paused', 'resumed']

export function eventsDir(root) {
  return join(root, '.firm', 'events')
}

// Отбор по поставке идёт ПОСЛЕ достройки привязки, а не до неё. Порядок здесь не
// стилистический: привязка события к тикету и к поставке держится на паре start/stop
// одного agent_id, и у старта ни тикета, ни поставки ещё нет (см. resolveTickets).
// Отфильтровав раньше, мы выбрасывали финиш (у него поставка уже проставлена) и
// оставляли старт (`change: null` проходит любой фильтр) — восстанавливать привязку
// становилось не из чего. На пилоте так вышло, что MR-ревью чужой поставки оставило
// в текущей три вечно открытых `review/started` без тикета: доска считала их занятыми
// слотами и показывала «6/3» (находка 23.09.2026).
// Исправление ошибочного события (поле `corrects`).
//
// Журнал иммутабелен (ADR-0003): записанное не правится и не удаляется. Но запись бывает
// неверной — на обкатке проект-В 01.10.2026 стадия слияния записала `merge/failed` по
// задаче, которая влилась успешно, и поправить это было нечем: доска считала поставку
// сломанной по событию, про которое все знали, что оно врёт.
//
// Поэтому исправление — это НОВОЕ событие, которое называет файл неверного:
//   firm-event.mjs record --ticket T-009 --stage merge --event finished \
//     --corrects 2026-10-01T15-50-41-362Z-T-009-merge-failed.json --notes "почему"
//
// При чтении журнала исправленное событие исключается из расчёта, но из журнала не
// исчезает: `doctor` показывает обе записи. След ошибки остаётся — он часть истории
// проекта, и именно по нему потом видно, что движок однажды соврал и как это заметили.
export function listEvents(root, { change = null, includeCorrected = false } = {}) {
  const dir = eventsDir(root)
  if (!existsSync(dir)) return []
  const all = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      e._file = f
      all.push(e)
    } catch {
      // Битый файл не должен ронять дашборд: он виден в doctor.
      all.push({ _file: f, _broken: true, ts: '' })
    }
  }
  all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a._file).localeCompare(String(b._file)))
  resolveTickets(all)
  // Что не закрылось парой старт/финиш — достраиваем по транскрипту субагента. Это как
  // раз идущие прямо сейчас стадии, ради которых доска и читается.
  if (all.some((e) => !e._broken && e.agent_id && !isBoundTicket(e.ticket))) resolveFromTranscripts(root, all)
  // Помечаем исправленные. Делаем это ДО фильтра по поставке: исправляющее событие могло
  // лечь с другой поставкой или без неё, а пометить надо всё равно.
  const corrected = new Set()
  for (const e of all) {
    if (e._broken || !e.corrects) continue
    for (const f of toArray(e.corrects)) corrected.add(String(f))
  }
  if (corrected.size) for (const e of all) if (corrected.has(e._file)) e._corrected = true
  const live = includeCorrected ? all : all.filter((e) => !e._corrected)
  if (!change) return live
  return live.filter((e) => !e.change || e.change === change)
}

// Достройка привязки по agent_id.
//
// На SubagentStart собственного транскрипта у субагента ещё нет — читать маркер
// FIRM2-TICKET неоткуда, и событие старта пишется с ticket: "unknown". Это структурное
// свойство момента, а не сбой привязки: к SubagentStop маркер уже на месте.
//
// Пара старт/финиш одного субагента несёт общий agent_id, и финиш тикет знает. Так что
// старт восстанавливается арифметически, без догадок. Делаем это при чтении журнала, а
// не правкой файлов: журнал — запись того, что было известно в тот момент, и переписывать
// его задним числом значило бы терять след.
// `T-XXX` — не тикет, а заглушка из шаблонов и промптов («заведи docs/bugs/BUG-XXX.md
// для задачи T-XXX»). Маркер ищется по всей полезной нагрузке хука, поэтому заглушка в
// тексте матчилась наравне с настоящим тикетом, и событие уезжало в журнал привязанным
// к задаче, которой нет. Считаем такое непривязанным — тогда обычная достройка по
// agent_id находит настоящую привязку сама (находка пилота 23.09.2026).
const PLACEHOLDER_TICKET = /^T-X+f?$/i

export function isBoundTicket(t) {
  return !!t && t !== 'unknown' && !PLACEHOLDER_TICKET.test(t)
}

// ── Привязка по СОБСТВЕННОМУ транскрипту субагента ────────────────────────────
//
// Третий источник привязки, и единственный, который работает ВО ВРЕМЯ стадии.
//
// Почему понадобился. Маркер `FIRM2-TICKET` хук читает из транскрипта субагента, а на
// SubagentStart в полезной нагрузке транскрипта нет — событие старта ложится с
// `ticket: unknown`. Достройка по `agent_id` (resolveTickets) чинит это задним числом,
// когда придёт финиш, — то есть всё время, пока стадия ИДЁТ, доска не знает, что задача
// в работе, и показывает её как «ждёт слота», а таблица событий — как `unknown`.
// Запасная линия `claim` этот зазор не закрыла: рантайм не даёт субагенту собственный
// идентификатор (проверено на прогоне 29.09.2026 — `.firm/current/` пуст, все три
// параллельных `dev/started` остались непривязанными).
//
// Что работает. Рантайм кладёт транскрипт субагента в файл с ИМЕНЕМ ИЗ `agent_id`:
//   <projects>/<проект>/<session_id>/subagents/[workflows/<wf>/]agent-<agent_id>.jsonl
// Первая строка этого файла — промпт стадии, написанный кодом workflow, с маркером.
// Значит привязка выводится из двух полей, которые в событии УЖЕ есть (`session_id`,
// `agent_id`), без догадок и без участия модели — ровно то, чего требует ADR-0002.
//
// Читаем только начало файла: маркер стоит первыми байтами, а транскрипт стадии к концу
// работы бывает в мегабайты.

// Образцы маркеров — ОДНО определение на весь движок, и экспортируются они ради этого.
// До 0.4.105 их было две копии, здесь и в `firm-event.mjs`, и обе читали один и тот же
// промпт: правка привязки требовала помнить про вторую, а разойтись они могли молча.
// `T-XXX` из маркера не берётся намеренно — это заглушка шаблонов, и она уже уезжала в
// журнал привязкой к несуществующей задаче.
export const MARKER_TICKET_RE = /FIRM2-TICKET:\s*(T-(?!X+f?\b)[\w.]+|MR)/
// Тема разведки: у груминга ни задачи, ни поставки нет по устройству (ADR-0012), а
// стадии он ведёт — и привязываются они к номеру темы. Заглушка `G-XXX` тем же правилом
// отсекается, что и `T-XXX`.
export const MARKER_GROOM_RE = /FIRM2-GROOM:\s*(G-(?!X+\b)[\w.]+)/
// Имя поставки — имя каталога, а не slug: `[\w.-]` обрывал его на первой не-ASCII букве,
// и `2026-10-10-черновик` уезжал в журнал как `2026-10-10-`. Обрезанное имя не совпадает
// ни с одной поставкой, то есть это та же приписка не туда, что Д-1, только незаметнее.
// Через `\S+` нельзя: в транскрипте маркеры лежат внутри JSON-строки, где перевод строки
// записан двумя символами `\` + `n`, и жадный класс утащил бы в имя весь остаток блока.
export const MARKER_CHANGE_RE = /FIRM2-CHANGE:\s*([^\s"'\\]+)/
export const MARKER_ATTEMPT_RE = /FIRM2-ATTEMPT:\s*(\d+)/

function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'projects')
}

// Каталог сессии. Имя проекта рантайм получает из пути заменой не-буквенно-цифровых
// символов на дефис; на случай, если правило поменяется, есть обход по всем проектам.
function sessionDir(root, sessionId) {
  if (!sessionId) return null
  const projects = claudeProjectsDir()
  const direct = join(projects, String(root).replace(/[^A-Za-z0-9]/g, '-'), sessionId)
  if (existsSync(direct)) return direct
  if (!existsSync(projects)) return null
  try {
    for (const p of readdirSync(projects)) {
      const c = join(projects, p, sessionId)
      if (existsSync(c)) return c
    }
  } catch {
    return null
  }
  return null
}

export function agentTranscriptPath(root, sessionId, agentId) {
  if (!agentId) return null
  const dir = sessionDir(root, sessionId)
  if (!dir) return null
  const name = `agent-${agentId}.jsonl`
  const flat = join(dir, 'subagents', name)
  if (existsSync(flat)) return flat
  // Стадии сборки запускает workflow, и их транскрипты лежат на уровень глубже.
  const wf = join(dir, 'subagents', 'workflows')
  if (!existsSync(wf)) return null
  try {
    for (const d of readdirSync(wf)) {
      const c = join(wf, d, name)
      if (existsSync(c)) return c
    }
  } catch {
    return null
  }
  return null
}

function headOfFile(path, bytes = 65536) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.slice(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* закрыть не вышло — не наша беда */ }
  }
}

// ── Привязка по МЕТА-ФАЙЛУ подагента: label вызова ────────────────────────────
//
// Четвёртый источник, и единственный, который работает в МОМЕНТ СТАРТА (Д-44, замер по
// журналу проект-В 02.11.2026).
//
// Что случилось. Привязка по собственному транскрипту (выше) читает первые байты файла и
// ищет там маркер. С 28.10.2026 рантайм пишет ПЕРВОЙ строкой свою преамбулу
// («[Workflow harness — user request] …»), а промпт стадии с маркером приходит ВТОРОЙ
// строкой, следующим ходом. На `SubagentStart` в файле лежит только преамбула — маркера
// нет, и старт уезжает с `ticket: "unknown"`. Замер: 595 стартов из ~600 с 28.10 против
// 3 из 27 до неё; финиши при этом привязаны (29 непривязанных из 1472), поэтому задним
// числом всё сходится и глазами дыра не видна.
//
// Чем это платится. Отказ паузы на старте `dev` (`guard/pause-held`) стоит под условием
// «тикет известен» — то есть не сработал ни разу за пять дней: в журнале проект-В ноль таких
// событий. Пауза держалась одной линией вместо двух. Плюс доска всё время стадии
// показывает задачу как «ждёт слота» — ровно тот зазор, ради которого третий источник и
// заводился.
//
// Что работает. Рядом с транскриптом рантайм пишет `agent-<agent_id>.meta.json`, и его
// поле `description` — это НАШ СОБСТВЕННЫЙ `label` вызова: `"test:T-264#1 [модель]"`,
// `"worktree:T-263"`, `"основание: точка ветвления T-264"`. Файл есть в момент запуска,
// а значит привязка выводится из двух полей, которые в событии уже есть (`session_id`,
// `agent_id`), без догадок и без участия модели — ровно то, чего требует ADR-0002.
//
// Почему это не «разбор строки на удачу». Label пишет код движка, а не модель, и рубеж
// держит его форму: в каждом ярлыке стадии стоит `${task.id}`. Номер попытки берётся
// только из `#<цифры>` — `#call-failed` и `#pocket` в ярлыках служебных записей цифрами
// не кончаются и попыткой не станут.
// ЧТО ОКАЗАЛОСЬ НЕВЕРНО в редакции 0.4.122 (отчёт проект-В 03.11.2026, находка 2).
//
// Привязка по ярлыку была написана верно и не сработала ни разу: ярлык искался ПО ПУТИ
// ТРАНСКРИПТА (`agent-<id>.jsonl` → `agent-<id>.meta.json`), а на `SubagentStart`
// транскрипта нет вовсе. Замер по стадии теста T-291 (одна из 1612 непривязанных):
//
//   событие `test/started`           13:43:07 (локально)
//   `agent-aa3f…bd5c.meta.json`      13:43:09  — на ДВЕ СЕКУНДЫ позже хука
//   `agent-aa3f…bd5c.jsonl`          14:07:04  — на 24 МИНУТЫ позже, то есть к финишу
//
// То есть `agentTranscriptPath` отдавала null, функция выходила первой же строкой, и до
// ярлыка дело не доходило. Цена этой ошибки на одной поставке: 1612 событий из 4338 (37 %)
// без тикета, и теряются ровно открывающие (`review/started` 755, `dev/started` 440,
// `test/started` 368) — у закрывающих тикет есть. Следствия: `doctor` отдаёт `ok: false`
// на закрытой и выпущенной поставке, его восемь «брошенных стадий» — это открытия,
// которым нечем найти закрытия, а длительность стадии и `over_budget` (0.4.115) считались
// по тем парам, которые нашлись.
//
// Отсюда два исправления, и оба нужны:
//
//   1. мета-файл ищется САМ, а не рядом с транскриптом: он появляется первым и живёт
//      в том же каталоге (`subagents/` или `subagents/workflows/<прогон>/`);
//   2. на СТАРТЕ движок ждёт его появления — ограниченно и с замером. Две секунды
//      задержки рантайма нечем обойти, кроме ожидания: события пишутся в момент хука, а
//      хук приходит раньше файла. Ожидание стоит только там, где привязки нет, длится не
//      больше `BIND_WAIT_MS` и попадает в событие полем `bind_wait_ms` — порог выражен в
//      замеренном, и цена механизма видна в журнале, а не на слово (ADR-0010).
export function labelMarkers(label) {
  const s = String(label || '')
  const t = s.match(/\b(T-(?!X+f?\b)[\w.]+?)(?=#|\s|$|\])/)
  const g = s.match(/\b(G-(?!X+\b)[\w.]+?)(?=#|\s|$|\])/)
  const a = s.match(/#(\d+)\b/)
  // `MR` — привязка стадии уровня ПОСТАВКИ (MR-ревью всего диффа, архив спеки, прототип):
  // тикета у неё нет по устройству, а событие она пишет. В промпте такую стадию помечает
  // `FIRM2-TICKET: MR`, но промпта на старте ещё нет — значит метку обязан нести ярлык
  // вызова, и команды его так и называют (`review:MR`, `docs:MR`). Без этой строки
  // открытия стадий поставки оставались `unknown` даже с исправленным поиском мета-файла:
  // в журнале проект-В за 03.11.2026 это `review/started` и `docs/started` на выпуске.
  // Ищем с границей слова и ТОЛЬКО как отдельное слово: `MR` внутри `MR-ревью` годится,
  // внутри `проект-В` — нет.
  const mr = /(^|[^A-Za-z0-9])MR([^A-Za-z0-9]|$)/.test(s)
  return {
    ticket: t ? t[1] : (g ? g[1] : (mr ? 'MR' : null)),
    change: null,
    attempt: a ? Number(a[1]) : null,
  }
}

// Мета-файл подагента — там, где его пишет рантайм. Ищется НЕЗАВИСИМО от транскрипта:
// на старте транскрипта ещё нет, а мета уже есть (или появится через секунду-две).
export function agentMetaPath(root, sessionId, agentId) {
  if (!agentId) return null
  const dir = sessionDir(root, sessionId)
  if (!dir) return null
  const name = `agent-${agentId}.meta.json`
  const flat = join(dir, 'subagents', name)
  if (existsSync(flat)) return flat
  // Стадии сборки запускает workflow, и их файлы лежат на уровень глубже.
  const wf = join(dir, 'subagents', 'workflows')
  if (!existsSync(wf)) return null
  try {
    for (const d of readdirSync(wf)) {
      const c = join(wf, d, name)
      if (existsSync(c)) return c
    }
  } catch {
    return null
  }
  return null
}

function labelFromMeta(path) {
  if (!path || !existsSync(path)) return ''
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'))
    return typeof d.description === 'string' ? d.description : ''
  } catch {
    return '' // чужой формат — не наша забота и не повод падать
  }
}

// Сколько ждать мета-файл на старте. Замер проект-В: отставание 2 с (13:43:07 → 13:43:09).
// Пять секунд — четверть запаса сверху; больше брать незачем, потому что ожидание держит
// запуск стадии, а меньше — значит снова писать `unknown` на штатной задержке рантайма.
export const BIND_WAIT_MS = 5000
const BIND_WAIT_STEP_MS = 100

// Пауза без таймеров: ожидание идёт в хуке, то есть в коротком процессе, и `await` здесь
// потребовал бы сделать асинхронной всю цепочку вызовов хука. `Atomics.wait` на буфере,
// которого никто не разделяет, — стандартная библиотека и ровно одна строка (ADR-0010).
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function markerFromAgent(root, sessionId, agentId, { waitMs = 0 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs)
  const started = Date.now()
  for (;;) {
    // Транскрипт — лучший источник: в нём лежит промпт стадии с маркером, то есть и
    // поставка, и номер попытки. На старте его обычно нет; к финишу есть всегда.
    const tp = agentTranscriptPath(root, sessionId, agentId)
    const m = tp ? markersIn(headOfFile(tp)) : {}
    if (m.ticket) return m
    // Транскрипт молчит — значит мы на старте, до промпта стадии. Тогда ярлык вызова.
    const byLabel = labelMarkers(labelFromMeta(agentMetaPath(root, sessionId, agentId)))
    if (byLabel.ticket) {
      // Поставку ярлык не несёт, и выдумывать её нельзя: что нашлось в транскрипте — то и
      // остаётся (на старте это обычно ничего, и поставку достроит чтение журнала).
      return {
        ...byLabel,
        change: m.change || null,
        attempt: byLabel.attempt || m.attempt || null,
        bind_wait_ms: Date.now() - started,
      }
    }
    if (Date.now() >= deadline) {
      // Ничего не нашлось. Ожидание было — значит его длительность и есть ответ на вопрос
      // «почему событие ушло без тикета»: файла не было и через пять секунд.
      return waitMs > 0 ? { ...m, bind_wait_ms: Date.now() - started } : m
    }
    sleepMs(BIND_WAIT_STEP_MS)
  }
}

// Разбор маркеров — одной функцией на все источники: нагрузку хука, собственный
// транскрипт субагента и транскрипт, найденный по `agent_id`. Маркер темы берётся только
// когда маркера задачи нет: стадия разведки чужого тикета не несёт, а если вдруг несёт
// оба — задача конкретнее темы, и привязка идёт к ней.
export function markersIn(text) {
  const t = String(text || '').match(MARKER_TICKET_RE)
  const g = String(text || '').match(MARKER_GROOM_RE)
  const c = String(text || '').match(MARKER_CHANGE_RE)
  const a = String(text || '').match(MARKER_ATTEMPT_RE)
  return {
    ticket: t ? t[1] : (g ? g[1] : null),
    change: c ? c[1] : null,
    attempt: a ? Number(a[1]) : null,
  }
}

// Хвост файла. Зеркало `headOfFile`: маркер стадии стоит в начале транскрипта, а
// результат стадии — в конце. Первую строку выбрасываем: чтение с середины файла почти
// всегда разрезает строку, а половина JSON не парсится и молча считалась бы «нет данных».
function tailOfFile(path, bytes = 1048576) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const from = Math.max(0, size - bytes)
    const len = size - from
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, from)
    const text = buf.slice(0, n).toString('utf8')
    return from === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } catch {
    return ''
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* закрыть не вышло — не наша беда */ }
  }
}

// Structured output стадии — из её собственного транскрипта.
//
// 02.10.2026: вердикт ревью не доезжал до журнала ВООБЩЕ. На четыре пилотных проекта
// 328 событий `review/finished` и ровно одно `review/accepted` — последнее от 22.09.2026,
// то есть со времён прежнего движка. Причина: хук читал `last_assistant_message`, а
// structured output роли приходит НЕ текстом — рантайм кладёт его отдельным блоком
// `tool_use` с именем `StructuredOutput`, и последним текстом ассистента оказывается
// реплика вида «All claims verified» перед вызовом. Поле не пустое и не сломано — просто
// отвечает не на тот вопрос, поэтому молчание выглядело как «ревью ничего не сказало».
//
// Следствие на проектах: `last_verdict` в аргументах сборки всегда null, и следующая
// попытка начиналась, не зная, за что отклонили предыдущую; на проект-В вердикт дважды
// вписывали в задачу руками.
//
// Ищем с конца: structured output — последний ход стадии. Имя инструмента проверяем
// мягко, а решает всё равно форма полезной нагрузки (verdict/escalate/status), чтобы
// переименование инструмента в рантайме не воскресило ту же тишину.
export function structuredOutputFromTranscript(path) {
  if (!path || !existsSync(path)) return null
  const text = tailOfFile(path)
  if (!text) return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line.indexOf('tool_use') === -1) continue
    let rec = null
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const msg = rec && rec.message
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const b = msg.content[j]
      if (!b || b.type !== 'tool_use') continue
      const o = b.input
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue
      // Имя инструмента здесь нужнее, чем в `verdictOf`. Там нагрузка одна, а тут мы
      // идём по всем ходам стадии, и `status` — слишком частое поле, чтобы по одному ему
      // опознавать вердикт: чужой инструмент с таким полем стал бы вердиктом стадии.
      // Поэтому `status` засчитываем только у инструмента structured output, а `verdict`
      // и `escalate` — как есть: эти два поля в движке больше нигде не встречаются, и
      // переименование инструмента в рантайме не должно вернуть прежнюю тишину.
      const named = String(b.name || '').toLowerCase() === 'structuredoutput'
      if (!('verdict' in o) && !('escalate' in o) && !(named && 'status' in o)) continue
      return o
    }
  }
  return null
}

export function structuredOutputFromAgent(root, sessionId, agentId) {
  return structuredOutputFromTranscript(agentTranscriptPath(root, sessionId, agentId))
}

// Вторая ступень достройки: события, которым пара по agent_id ещё не пришла (стадия
// ИДЁТ прямо сейчас). Кэшируем по agent_id — на одну стадию приходится одно чтение.
export function resolveFromTranscripts(root, events) {
  const cache = new Map()
  for (const e of events) {
    if (e._broken || isBoundTicket(e.ticket) || !e.agent_id) continue
    if (!cache.has(e.agent_id)) cache.set(e.agent_id, markerFromAgent(root, e.session_id, e.agent_id))
    const hit = cache.get(e.agent_id)
    if (!hit || !isBoundTicket(hit.ticket)) continue
    e.ticket = hit.ticket
    if (!e.change && hit.change) e.change = hit.change
    e._ticket_from = 'transcript'
  }
  return events
}

export function resolveTickets(events) {
  const byAgent = new Map()
  for (const e of events) {
    if (e._broken || !e.agent_id) continue
    if (isBoundTicket(e.ticket) && !byAgent.has(e.agent_id)) {
      byAgent.set(e.agent_id, { ticket: e.ticket, change: e.change })
    }
  }
  for (const e of events) {
    if (e._broken || isBoundTicket(e.ticket) || !e.agent_id) continue
    const hit = byAgent.get(e.agent_id)
    if (!hit) continue
    e.ticket = hit.ticket
    if (!e.change && hit.change) e.change = hit.change
    e._ticket_from = 'agent_id'
  }
  return events
}

// Имя файла: <fs-ts>-<ticket>-<stage>-<event>.json. Двоеточия ISO в именах файлов
// заменены на дефисы — иначе имя ломается на части файловых систем и в URL.
// ── Разбор команды git: подкоманда, а не подстрока ───────────────────────────
//
// Один и тот же дефект успел случиться в ДВУХ сторожах, и это главный довод за то, чтобы
// разбор жил здесь, а не копией в каждом. Д-20 (28.10.2026): сторож отправки опознавал
// пуш образцом `\bgit\b…\bpush\b` и записывал расписку на `git stash push` и на слово
// `push` внутри `echo`. Д-22 (29.10.2026): тем же способом сторож расписки о ревью
// опознавал слияние — и отклонял `git merge-base`, читающую команду, которой как раз и
// смотрят, что изменилось после вердикта. То есть отказ запрещал ровно ту диагностику, к
// которой подталкивал сам.
//
// Правило разбора: токен `git`, затем пропуск ГЛОБАЛЬНЫХ ключей (`-C <путь>`, `-c k=v`,
// `--git-dir=…`), и первое оставшееся слово — подкоманда. `merge-base`, `merge-tree`,
// `stash push` подкомандами `merge`/`push` не являются, и сравнение идёт на равенство.
const GIT_OPTS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
])

// Содержимое heredoc'а командой НЕ является (Д-22, второй случай): запись файла
// `cat > f <<EOF … EOF` отклонялась сторожем из-за слов в ТЕКСТЕ файла — то есть сторож
// мешал работе, не имеющей к git отношения вовсе.
//
// Вырезается РОВНО тело — от метки до закрывающей строки, — а не всё до конца строки.
// Разница не косметическая: после тела может идти настоящая команда, и сторож, обрезавший
// хвост, её не увидит. Направление ошибки здесь несимметрично (пропустить слияние хуже,
// чем задержать чтение), поэтому хвост сохраняется. Метка не найдена закрытой — тело
// считается незакрытым и обрезается до конца: так ведёт себя и сам shell.
export function stripHeredoc(cmd) {
  let s = String(cmd)
  for (let guard = 0; guard < 20; guard++) {
    const m = s.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
    if (!m) return s
    const end = s.slice(m.index).search(new RegExp(`\\n[ \t]*${m[2]}[ \t]*(?:\\n|$)`))
    if (end < 0) return s.slice(0, m.index)
    const tail = s.slice(m.index + end + 1)
    s = s.slice(0, m.index) + tail.slice(tail.indexOf('\n') + 1 || tail.length)
  }
  return s
}

// Значения ключей, которые по смыслу несут ТЕКСТ, а не команду. Снимаются перед разбором
// подкоманд — ровно по тому же доводу, что и heredoc выше, только для второго способа
// передать данные (Д-74, отчёт проект-В 10.11.2026).
//
// Замер их отчёта: один и тот же текст «git merge --no-edit task/T-404» в `--notes "…"`
// давал ОТКАЗ сторожа расписки, а телом heredoc'а проходил. То есть защита у движка была и
// работала, но накрывала один способ из двух, и запись решения человека о замене задачи
// (`record --stage lifecycle --event superseded --notes "<разбор на 4 КБ>"`) дважды
// отклонялась как «команда слияния» — при том что ни строки по git в ней нет.
//
// Класс узкий и злой: это `firm-event record --notes`, то есть запись РЕШЕНИЙ И РАЗБОРОВ.
// Чем подробнее разбор и чем точнее он называет исполнителю шаг — а называть точный шаг
// требуют наши же правила нарезки, — тем вероятнее был отказ. Разбор начинал писаться с
// оглядкой на сторожа, а не на читателя.
//
// Почему снимаем значения ключей, а не всё кавычечное: `bash -c "git push"` — настоящая
// отправка, и пропустить её хуже, чем задержать чтение (несимметричность та же, что у
// heredoc). Поэтому список ИМЕНОВАННЫЙ: ключ объявляет, что за ним данные.
const TEXT_OPTS = new Set([
  '--notes', '--note', '--notes-file', '--message', '-m', '--reason', '--why',
  '--text', '--body', '--title', '--summary', '--comment', '--description',
])

// Снять значения текстовых ключей, сохранив всё остальное дословно — включая разделители
// составной команды ПОСЛЕ значения. Разбор идёт с учётом кавычек: иначе значение с
// пробелами кончалось бы на первом из них, то есть снималось бы наполовину.
export function stripTextArgs(cmd) {
  const s = String(cmd)
  let out = ''
  let i = 0
  // Токен: либо кавычечная строка целиком, либо слово до пробела.
  const readToken = (from) => {
    const q = s[from]
    if (q === '"' || q === "'" || q === '`') {
      for (let k = from + 1; k < s.length; k++) {
        if (s[k] === '\\') { k++; continue }
        if (s[k] === q) return { text: s.slice(from, k + 1), end: k + 1, quoted: true }
      }
      return { text: s.slice(from), end: s.length, quoted: true }
    }
    let k = from
    while (k < s.length && !/\s/.test(s[k])) k++
    return { text: s.slice(from, k), end: k, quoted: false }
  }
  // Значение — ОДИН токен, прочитанный с учётом кавычек. Выделено в шаг потому, что форм
  // передачи две («ключ пробел значение» и `ключ=значение`), и первая редакция разбирала
  // кавычки только в первой: `--notes="a git merge …"` снималось до первого пробела, то
  // есть наполовину, и хвост значения снова читался как команда. Замер проект-В 10.11.2026,
  // независимая проверка краёв: 8 случаев из 10, и оба расхождения — про это.
  //
  // Фигура дефекта та же, в которой описан весь Д-74: ОДНО ПРАВИЛО С ДВУМЯ ОТВЕТАМИ. В
  // первый раз это были heredoc против кавычек, во второй — две формы одного ключа. Поэтому
  // чтение значения живёт в одном месте, и разойтись формам больше негде.
  const dropValue = (from) => {
    const v = readToken(from)
    // Следом другой ключ — значит значения у этого нет, и снимать нечего.
    if (!v.quoted && v.text.startsWith('-')) return from
    return v.end
  }
  while (i < s.length) {
    if (/\s/.test(s[i])) { out += s[i]; i++; continue }
    // `--notes=<текст>` — та же передача текста, только одним токеном. Ключ опознаём ДО
    // чтения токена: иначе слово кончится на первом пробеле внутри кавычек.
    const kv = s.slice(i).match(/^(--?[A-Za-z][\w-]*)=/)
    if (kv && TEXT_OPTS.has(kv[1])) {
      out += kv[0]
      i = dropValue(i + kv[0].length)
      continue
    }
    const t = readToken(i)
    out += t.text
    i = t.end
    if (!TEXT_OPTS.has(t.text)) continue
    // Ключ опознан: пропускаем пробелы и СНИМАЕМ следующий токен целиком.
    while (i < s.length && /[ \t]/.test(s[i])) { out += s[i]; i++ }
    if (i >= s.length) break
    i = dropValue(i)
  }
  return out
}

// Все вызовы git в команде: `{ sub, rest }` на каждый. Отрезки составной команды
// разбираются ПО ОТДЕЛЬНОСТИ, иначе `git branch -r && echo "push"` читается как пуш.
// Кавычки со слов снимаются: `bash -c "git push"` — настоящая отправка, и пропустить её
// хуже, чем записать лишнюю расписку.
export function gitSubcommands(cmd) {
  const out = []
  // Снимаются ОБА способа передать текст данными — тело heredoc'а и значение текстового
  // ключа. До 10.11.2026 снимался только первый, и одно правило давало два ответа на один
  // текст в зависимости от способа передачи (Д-74).
  for (const part of stripTextArgs(stripHeredoc(cmd)).split(/&&|\|\||[;|\n]/)) {
    const tok = part.split(/\s+/).map((w) => w.replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean)
    for (let i = 0; i < tok.length; i++) {
      if (tok[i] !== 'git') continue
      let j = i + 1
      while (j < tok.length) {
        const t = tok[j]
        if (t.startsWith('--') && t.includes('=')) { j++; continue }
        if (GIT_OPTS_WITH_VALUE.has(t)) { j += 2; continue }
        if (t.startsWith('-')) { j++; continue }
        break
      }
      if (j < tok.length) out.push({ sub: tok[j], rest: tok.slice(j + 1) })
    }
  }
  return out
}

// Есть ли в команде вызов git с ровно такой подкомандой.
export function gitRuns(cmd, sub) {
  return gitSubcommands(cmd).some((g) => g.sub === sub)
}

export function fsStamp(iso) {
  return String(iso).replace(/:/g, '-').replace(/\./g, '-')
}

export function writeEvent(root, ev) {
  const dir = eventsDir(root)
  mkdirSync(dir, { recursive: true })
  const ts = ev.ts || new Date().toISOString()
  // `ts` из `ev` выкидываем намеренно: спред с явным `ts: undefined` ПЕРЕБИВАЕТ вычисленное
  // выше время, и событие уезжает в журнал вообще без `ts` — имя файла со штампом, а
  // внутри пусто. Так 0.4.38 записала два события в проект-Г: читатель журнала
  // падал на обращении к полю. Время у события должно быть всегда.
  const { ts: _given, ...rest } = ev
  // Сторожевое событие без привязки — это `MR`, а НЕ `unknown`, и решается это ЗДЕСЬ, в
  // одном месте на весь движок (отчёт проект-В 05.11.2026, дефект 1).
  //
  // Решение само не новое: `unknown` в журнале означает дыру привязки (И-7) и краснит
  // `doctor` НАВСЕГДА, потому что журнал неизменяем (ADR-0003/0006), а снимается такая
  // находка только исправляющим событием — то есть угадыванием тикета человеком. Для
  // расписок об отправке это решено в 0.4.84, для сверки секретов — 21.10.2026, и каждый
  // раз поимённо, в своём файле. `bash-guard.mjs` этого не получил: `guard/long-wait` писал
  // ticket как есть, и на проект-В одно событие продержало `doctor` красным 48 часов.
  //
  // Третий случай одного решения — это уже не забывчивость, а место: сторожа пишут события
  // из пяти разных файлов, и правило, живущее поимённо, отстаёт от шестого. Сторож судит
  // ВЫЗОВ, а вызов принадлежит поставке даже тогда, когда стадия не названа: `MR` — честный
  // ответ, `unknown` — выдуманная дыра. Стадий работы это не касается: там отсутствие
  // привязки и есть находка, и такие ветки молчат (см. `design`/`adjudicate` в firm-event).
  if (rest.stage === 'guard' && (!rest.ticket || rest.ticket === 'unknown')) rest.ticket = 'MR'
  const full = { ts, ...rest }
  // Имя события — время, тикет, стадия, исход. Этого НЕ хватает, чтобы имя было
  // уникальным, и ADR-0003 утверждал обратное: «коллизии имён исключены». Для разных
  // тикетов и стадий это верно, но не для состязательной панели — три ревьюера пишут
  // `review/started` по одному тикету, и попадание в одну миллисекунду давало ОДИН файл
  // вместо трёх. Молча: последний вошедший затирал предыдущих, в журнале не оставалось ни
  // следа, и `doctor` ничего не находил, потому что находить было нечего.
  //
  // Занято — дописываем номер. Флаг `wx` здесь обязателен и заменяет проверку
  // существования: события пишут РАЗНЫЕ процессы (у каждого ревьюера свой), и между
  // `existsSync` и `writeFileSync` помещается чужая запись. `wx` создаёт файл или падает
  // с EEXIST, и это единственная проверка, которую нельзя обогнать.
  //
  // Имена файлов нигде не разбираются обратно: `listEvents` фильтрует по `.json`, читает
  // содержимое и сортирует по полю `ts`, а имя берёт лишь как ключ исправления
  // (`corrects`) и запасной признак порядка. Поэтому суффикс ничего не ломает.
  const base = `${fsStamp(ts)}-${ev.ticket || 'unknown'}-${ev.stage}-${ev.event}`
  const body = JSON.stringify(full, null, 1) + '\n'
  let path = join(dir, `${base}.json`)
  for (let n = 2; ; n += 1) {
    try {
      writeFileSync(path, body, { flag: 'wx' })
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      path = join(dir, `${base}-${n}.json`)
    }
  }
  // Сразу в индекс. Событие пишет хук в главное рабочее дерево, и до коммита файл
  // остаётся неотслеживаемым — то есть беззащитным: `git clean -fd` на шаге уборки
  // сносит его молча, а вместе с ним и всю статистику поставки. Так на обкатке
  // 2026-09-22 из тринадцати событий уцелело одно. Файл в индексе `git clean` не трогает.
  // Неудачу НЕ глушим, хотя и не роняем запись: журнал важнее, чем удача с git. Но молчать
  // здесь нельзя — это и была дыра. Весь смысл `git add` в том, что неотслеживаемый файл
  // сносит `git clean -fd`; значит неудача `add` возвращает событие ровно в то состояние,
  // от которого эта строка защищает, — и делает это бесшумно. Потом видно только следствие:
  // событий нет, а `doctor` не отличает «стадия не записала» от «стадия не запускалась».
  // Поэтому говорим в stderr (ADR-0007: неопределённость требует вопроса, молчит только
  // журнал) и называем файл, который теперь под угрозой.
  try {
    execFileSync('git', ['-C', root, 'add', '--', path], { stdio: 'ignore' })
  } catch (e) {
    process.stderr.write(
      `[firm2] событие записано, но НЕ попало в индекс git: ${path}\n` +
        `        причина: ${e.message.split('\n')[0]}\n` +
        `        Неотслеживаемый файл сносит \`git clean -fd\` на шаге уборки — так на\n` +
        `        обкатке 22.09.2026 из тринадцати событий уцелело одно. Добавить руками:\n` +
        `        git -C ${root} add -- ${path}\n`,
    )
  }
  return path
}

// ── Вывод статуса из событий (§4, §6) ─────────────────────────────────────────


// Последнее событие определяет статус; зависимости добавляют различие todo/ready.
// ЗАКРЫТАЯ ЗАДАЧА — одно понятие и ОДНО место. Заведено 10.11.2026 по дефекту, найденному
// Архитектором проект-В: `plan-shape` считал форму плана по мёртвым задачам, потому что
// предикат «задача не пойдёт никогда» был выписан литеральным списком, и `superseded` в нём
// не было — при четырёх снятых задачах незакрытых на доске было шесть, а в форме плана
// десять, первой волной планировалась СНЯТАЯ задача, и `waves` завышалось на число
// поколений замен (у них — две волны из шести, треть календаря).
//
// Цена дефекта не в числе, а в том, что по этому числу принимают решения: поднятие
// `parallelism` с 3 до 8 в их конфиге подписано человеком дословно «замер формы плана дал
// 15 волн при глубине графа 6» — и если в тех 15 были фиктивные, решение принято по
// завышенному.
//
// Список был в ТРЁХ местах, и `superseded` не было ни в одном: форма плана, следующий шаг
// в `phase` (поставка, где всё влито кроме снятых, предлагала `firm-build`) и `orphans`
// (дерево снятой задачи сиротой не считалось и висело). Это ровно тот класс, который я уже
// записывал себе уроком: второй словарь для одного понятия расходится с первым в первый же
// день. Теперь слово одно.
//
// `blocked` сюда НЕ входит и это решение: задача ждёт арбитража человека и вернётся
// (`arbitrated`), то есть для цикла она терминальна, а для календаря — нет. Поэтому
// `BUILD_SKIP` (кого не отдавать прогону) считается ОТ этого набора плюс `blocked`, а не
// наоборот.
export const TASK_CLOSED = new Set(['merged', 'released', 'cancelled', 'superseded'])

export const isClosedTask = (t) => Boolean(t) && TASK_CLOSED.has(t.status)

export function statusFromEvents(events) {
  let status = null
  let attempt = 0
  // Было ли слияние. Нужно, чтобы опоздавший отчёт о падении попытки не отменял влитое
  // (Д-67): состоявшееся слияние доказано вторым родителем, а не последним словом журнала.
  let merged = false
  for (const e of events) {
    if (e._broken) continue
    const k = `${e.stage}/${e.event}`
    if (e.event === 'escalated') {
      status = 'blocked'
      continue
    }
    // Эскалация разобрана — задача возвращается в цикл. До 02.10.2026 записать это было
    // нечем: у «заменена» и «отменена» события есть, а у самого частого исхода эскалации —
    // нет. Человек разбирал затык, задача шла дальше, и на дашборде между `dev/finished` с
    // эскалацией и следующей волной оставался необъяснённый провал в несколько часов
    // (наблюдение сессии проект-В 02.10.2026). Писать «ничего не произошло» там, где человек
    // принял решение, — та же дыра, что молчание о брошенной стадии.
    //
    // Статус становится null — ровно как после `abandoned`, и по той же причине: следующий
    // прогон ведёт задачу с начала цикла (dev → test → review), а не продолжает с середины.
    // Число попыток при этом не обнуляется: оно считается по `dev/started` за всю жизнь
    // задачи (Д-11), так что разбор эскалации не дарит задаче лишний заход.
    if (e.event === 'arbitrated') {
      status = null
      continue
    }
    // Пауза — факт о ПРОГОНЕ, а не о задаче: её события пишутся с `ticket: MR`. Ветка
    // здесь стоит на случай события, приписанного задаче ошибочно или исправлением: пауза
    // не должна двигать статус ни в какую сторону, иначе остановка прогона читалась бы как
    // смена стадии.
    if (e.event === 'paused' || e.event === 'resumed') continue
    switch (k) {
      case 'dev/started':
        status = 'in_progress'
        attempt += 1
        break
      case 'dev/finished':
        status = 'in_progress'
        break
      case 'test/started':
      case 'test/finished':
        status = 'in_test'
        break
      case 'review/started':
        status = 'in_review'
        break
      case 'review/accepted':
        status = 'accepted'
        break
      case 'review/rejected':
        status = 'rework'
        break
      // Адъюдикация расхождения панели — продолжение ревью, а не отдельный исход:
      // `blocker` возвращает задачу разработчику ровно так же, как отклонение
      // ревьюером, `not_blocker` пропускает её к слиянию. Статусы поэтому те же, и
      // заводить для них третью пару имён значило бы завести второе место, где
      // решается одно и то же.
      case 'adjudicate/rejected':
        status = 'rework'
        break
      case 'adjudicate/accepted':
        status = 'accepted'
        break
      // Короткая полоса: задача принята ПРАВИЛОМ движка, а не ревьюером. Отдельное имя
      // события, а не подложное `review/accepted`: ревью не было, и журнал обязан это
      // говорить. Статус тот же, потому что состояние задачи то же — готова к слиянию;
      // расходиться с `accepted` значило бы заводить второй словарь статусов для доски,
      // планировщика и doctor ради одного слова.
      case 'guard/short-lane':
        status = 'accepted'
        break
      case 'merge/finished':
        status = 'merged'
        merged = true
        break
      // Отказ слияния возвращает задачу туда, где она была: принята, но не влита.
      // Отдельного статуса не заводим — состояние задачи от этого не меняется,
      // меняется состояние ПОСТАВКИ, и о нём кричит doctor.
      //
      // НО: отчёт о ПОПЫТКЕ, пришедший после состоявшегося слияния, не разливает влитое
      // обратно. Отчёт проект-В 09.11.2026 (Д-67), трижды за вечер: шаг слияния упирался в
      // конфликт, Оркестратор сводил его и закрывал мерж коммитом, а шаг дописывал свой
      // отчёт ПОСЛЕ этого — и журнал читал последним словом «НЕ влито» при влитой задаче.
      // Чинилось исправляющим событием трижды, хотя оба события правдивы: попытка падала,
      // слияние состоялось.
      //
      // Решает не время записи, а ADR-0005: «влито» подтверждается вторым родителем
      // мерж-коммита, и отчёт о неудачной попытке этого не отменяет. Порядок событий здесь
      // не порядок решений — это гонка двух перьев.
      case 'merge/failed':
        status = merged ? 'merged' : 'accepted'
        break
      case 'release/finished':
        status = 'released'
        break
      // Терминальные решения человека. Идут последними по времени и потому побеждают —
      // специальной защиты не нужно, порядок событий и есть порядок решений.
      case 'lifecycle/superseded':
        status = 'superseded'
        break
      case 'lifecycle/cancelled':
        status = 'cancelled'
        break
      default:
        // Брошенная стадия возвращает задачу в «не начата»: статус становится null, и
        // доска пересчитывает ready/todo по зависимостям, а слот освобождается.
        // Именно null, а не «предыдущий статус»: следующий прогон ведёт тикет с начала
        // цикла (dev → test → review), и показывать его «в ревью» значило бы обещать
        // продолжение с середины, которого не будет. Число попыток при этом НЕ
        // обнуляется — оно считается по `dev/started`, и предел трёх заходов цел.
        if (e.event === 'abandoned') status = null
        break
    }
  }
  // Ровно столько `dev/started`, сколько их было, — ноль у ни разу не начатой задачи.
  // Было `Math.max(attempt, 1)`, и это стоило задаче трети её попыток: сборщик берёт
  // пришедшее число и ПРИБАВЛЯЕТ к нему (`attempt++` в начале цикла), поэтому первый заход
  // нумеровался вторым, а `while (attempt < MAX_ATTEMPTS)` при пределе 3 давал два прохода
  // вместо трёх. Видно это было только по меткам прогона: первая волна на проект-В пошла как
  // `dev:T-011#2`. Найдено на прогоне 02.10.2026.
  //
  // Единица тут стояла ради вида — чтобы на доске не было «попытка 0». Но доска и так
  // печатает номер лишь при `> 1`, а счётчик — факт, а не подпись: ноль попыток и есть ноль.
  // Д-11 («попытки считаются по всей жизни задачи, а не по жизни прогона») это не трогает:
  // считаются они всё так же по `dev/started` за всю историю.
  return { status, attempt }
}

// todo — ждёт зависимости; ready — ждёт слот. Разделение существует потому, что
// эти два состояния лечатся противоположными действиями (§4).
// Активная поставка — одна на движок, и до 01.10.2026 её вычисляли три разных места
// немного по-разному: `firm-event.mjs` пропускал поставку без задач, `firm-state.mjs` —
// считал её активной, а `dashboard.mjs` не вычислял вовсе и при запуске без аргумента
// молча собирал ПУСТУЮ доску поверх настоящей (поймано на проект-В: 22 задачи, 11 слияний,
// и «ещё ни одна задача не начиналась» на дашборде).
//
// Порядок проверок таков, и каждая отвечает на свой случай:
//   1. `active_change` из `.firm/config` — человек объявил, и это сильнее любого расчёта;
//   2. поставка одна — она и активна (так почти всегда, и ключа в конфиге тогда не нужно);
//   3. первая, в которой есть НЕзакрытые задачи, — работа идёт именно там;
//   4. первая, в которой задач ещё НЕТ, — её только что завели на планировании, и
//      события должны идти в неё, а не в предыдущую;
//   5. иначе последняя.
//
// Правило 1 до 0.4.72 было написано здесь, записывалось в синтетический конфиг рубежа — и
// НЕ ЧИТАЛОСЬ НИ ОДНОЙ СТРОКОЙ кода. То есть «закрепить живую поставку руками» движок
// обещал и не умел; обнаружено разбором вопроса «а не держать ли всегда одну поставку»
// 11.10.2026. Обещание конфига, которое некому сдержать, хуже отсутствующего ключа:
// по нему строят решения.
//
// Имя, которого среди живых поставок нет, НЕ лечится тихим откатом к расчёту. Человек
// назвал поставку — значит у него есть знание, которого у движка нет, и расходиться с ним
// молча движок не вправе (ADR-0007). Поэтому такой случай даёт `null` и жалобу в stderr,
// а `doctor` и `phase` называют его прямо: красный ответ с понятной причиной полезнее
// зелёного по чужому правилу.
//
// Явный `--change` всегда сильнее: его проверяют на стороне вызова, до обращения сюда.
// Закреплённая поставка, которой нет. Отдельной функцией, а не внутри `activeChange`,
// потому что читателей двое и им нужно разное: расчёту — ответ (`null`), человеку —
// причина. Форма та же, что у `vcsFindings`: пустой список значит «претензий нет».
export function activeChangeFindings(root) {
  const pinned = (readConfig(root) || {}).active_change
  if (!pinned) return []
  const name = String(pinned).trim()
  const changes = listChanges(root)
  if (changes.includes(name)) return []
  return [
    `active_change: ${name} — такой поставки среди живых нет (есть: ${changes.join(', ') || 'ни одной'}); ` +
      'активная поставка не определена, пока ключ не поправлен или не убран',
  ]
}

// Жалоба печатается один раз на процесс: `activeChange` зовут и доска, и дашборд, и хуки
// — по нескольку раз за запуск, и десять одинаковых строк в stderr перестают читаться.
let pinWarned = false

export function activeChange(root, opts = {}) {
  const changes = listChanges(root)
  const pinned = (readConfig(root) || {}).active_change
  if (pinned) {
    const name = String(pinned).trim()
    if (changes.includes(name)) return name
    if (!pinWarned) {
      pinWarned = true
      process.stderr.write(
        `[firm2] .firm/config: active_change: ${name} — такой поставки среди живых нет ` +
          `(есть: ${changes.join(', ') || 'ни одной'}). Активная поставка НЕ определена: ` +
          'либо поправить ключ, либо убрать его и дать движку считать самому.\n',
      )
    }
    return null
  }
  if (changes.length <= 1) return changes[0] || null
  const parallelism = Number(opts.parallelism) > 0 ? Number(opts.parallelism) : undefined
  // Проходов ДВА, и это не стилистика. Один цикл проверял оба правила на каждой поставке
  // по очереди — то есть правило 3 для первой поставки срабатывало раньше правила 2 для
  // второй, и порядок, описанный выше, выполнялся с точностью до наоборот. На проект-В
  // 11.10.2026 это стоило дорого: поставку 3.2 завели на разведке и задач в неё ещё не
  // положили, она же первая по алфавиту — и активной стала она, пока сборка шла по 3.1.
  // Следствия разошлись по всему движку: события стадий уезжали в чужую поставку (Д-1),
  // `board()` в `firm-state` собирался пустым, а раз пуст — все рабочие деревья задач
  // читались как «нет такой задачи», то есть сироты. Два чистых дерева живых задач
  // (T-078, T-083) снёс бы `prune` на следующем старте сборки.
  //
  // Работа перевешивает план: поставка с НЕзакрытыми задачами активнее пустой всегда,
  // в каком бы порядке они ни лежали. Пустая остаётся в правилах — но только когда
  // открытой работы нет ни в одной.
  const boards = changes.map((c) => [c, computeBoard(root, c, parallelism ? { parallelism } : {})])
  for (const [c, board] of boards) {
    // Снятая задача открытой работой НЕ является (дефект 10.11.2026): иначе поставка, в
    // которой живого не осталось, а снятое осталось, навсегда числилась бы активной — и
    // события следующей уезжали бы в неё, ровно как в Д-1 выше.
    if (board.tasks.some((t) => !isClosedTask(t))) return c
  }
  for (const [c, board] of boards) if (!board.tasks.length) return c
  return changes[changes.length - 1] || null
}

export function computeBoard(root, change, { parallelism = 3 } = {}) {
  const tasks = listTasks(root, change)
  const events = listEvents(root, { change })
  // Пауза — факт о ПРОГОНЕ, и в событиях одной задачи её не видно: интервалы считаются
  // один раз по всему журналу и раздаются всем задачам. Считать их внутри `timing` было
  // бы вторым проходом по журналу на каждую задачу.
  const pauses = pauseSpans(events)
  const byTicket = new Map()
  for (const e of events) {
    if (!e.ticket) continue
    if (!byTicket.has(e.ticket)) byTicket.set(e.ticket, [])
    byTicket.get(e.ticket).push(e)
  }

  const state = new Map()
  for (const t of tasks) {
    const evs = byTicket.get(t.id) || []
    const { status, attempt } = statusFromEvents(evs)
    state.set(t.id, { task: t, events: evs, status, attempt })
  }

  const isDone = (id) => {
    const s = state.get(id)
    return s ? s.status === 'merged' || s.status === 'released' : false
  }

  const activeStatuses = new Set(['in_progress', 'in_test', 'in_review', 'rework'])
  // Слот — это ЗАДАЧА, а не агент: потолок parallelism меряет, сколько задач ведётся
  // одновременно, каждая в своём worktree (§9). Задач в активных статусах столько,
  // сколько их есть, — они уже сгруппированы по тикету.
  //
  // Отдельно считаются стадии, которые начались, но ещё не привязаны к задаче: на
  // старте маркера тикета взять неоткуда (см. resolveTickets), а слот такая стадия
  // уже занимает — иначе доска показывала бы «0 из 3» при работающей сборке.
  //
  // Из них берём ТОЛЬКО `dev` — первую стадию задачи. `test` и `review` идут по
  // задаче, у которой dev уже закрылся и привязку дал: такая задача уже в активном
  // статусе и уже посчитана, а её незакрытые агенты — второй счёт той же задачи.
  // Состязательная панель — три ревьюера на один тикет — давала из-за этого +3 к
  // занятым слотам на каждую панель, откуда и бралось «6/3» (находка пилота 23.09.2026).
  const unboundAgents = new Set()
  const closedAgents = new Set()
  for (const e of events) {
    if (e._broken || !e.agent_id) continue
    if (e.event !== 'started') closedAgents.add(e.agent_id)
  }
  for (const e of events) {
    if (e._broken || e.ticket !== 'unknown' || e.event !== 'started') continue
    if (e.stage !== 'dev') continue
    if (e.agent_id && !closedAgents.has(e.agent_id)) unboundAgents.add(e.agent_id)
  }
  const slotsUsed =
    [...state.values()].filter((s) => activeStatuses.has(s.status)).length + unboundAgents.size

  const board = []
  for (const s of state.values()) {
    const t = s.task
    let status = s.status
    let waiting_for = []
    if (!status) {
      const unmet = t.depends_on.filter((d) => !isDone(d))
      if (unmet.length) {
        status = 'todo'
        waiting_for = unmet
      } else {
        status = 'ready'
        // Д-4 (обкатка 29.09.2026): «слоты заняты» писалось на любую готовую задачу при
        // полных слотах — в том числе на ту, которая сама один из них и занимает, и на ту,
        // что ждёт вовсе не слота. Обе подписи читались как «не начата, ждёт очереди».
        // Где причина известна — называем её; где нет — говорим, что не знаем, а не гадаем.
        if (!t.parallel_safe && slotsUsed > 0) {
          waiting_for = ['parallel_safe: false — ждёт, чтобы идти одной']
        } else if (slotsUsed >= parallelism) {
          waiting_for = unboundAgents.size
            ? ['слоты заняты; есть непривязанная стадия — возможно, эта задача уже в работе']
            : ['слоты заняты']
        }
      }
    }
    board.push({
      ...t,
      status,
      attempt: s.attempt,
      waiting_for,
      events: s.events,
      timing: timing(s.events, pauses),
      tokens: tokenUse(s.events),
      cache_stale: t.cached_status !== status,
    })
  }
  return { change, parallelism, slots_used: slotsUsed, in_flight_unbound: unboundAgents.size, tasks: board }
}

// Календарное время: от первого dev/started до merge/finished.
// Активное: сумма интервалов in_progress + in_test + in_review.
// Разница — ожидание, в первую очередь человека на воротах; это главный
// диагностический сигнал, поэтому показываются обе метрики (§4).
//
// ТРИ СОСТОЯНИЯ ЗАДАЧИ, А НЕ ДВА, и от этого зависит, где кончается её календарь.
// Правка 28.10.2026 по находке человека на доске проект-В: «ожидание всего 168 ч» росло
// само, пока на него смотрят, и читалось как «столько прождали».
//
//   влита — календарь кончается слиянием. Факт, он больше не изменится;
//   стадия ИДЁТ — календарь идёт до «сейчас», и активное тоже: работа происходит прямо
//     сейчас, и показывать её нулём значило бы врать в опасную сторону (И-11);
//   стадий не идёт, слияния нет — календарь кончается ПОСЛЕДНИМ СОБЫТИЕМ. Это остановленная
//     или брошенная задача, и тянуть её календарь до «сейчас» значит складывать в ожидание
//     время, в котором с задачей ничего не происходило, — а потом складывать такие хвосты
//     по всем задачам поставки и получать число, растущее само.
//
// Хвост до «сейчас» при этом НЕ выбрасывается: он возвращается отдельным полем `idle_ms`
// («без движения столько»). Это то же решение, что `open_runs` в замере груминга и что
// `null` вместо нуля в И-12: открытый интервал — не ноль и не факт, и называть его надо
// своим именем, а не прятать внутрь суммы.
//
// ОЖИДАНИЕ РАЗНОЕ, И СКЛАДЫВАТЬ ЕГО В ОДНО ЧИСЛО НЕЛЬЗЯ (решение человека 28.10.2026:
// «время учитывать без ожидания — если ждут человека или стоит пауза, это не считаем»).
// Разделяется ровно по тому, кто в это время мог что-то сделать:
//
//   ждут ЧЕЛОВЕКА — задача эскалирована: до разбора эскалации движок не вправе ничего
//     предпринять (ADR-0009), и ставить это время в счёт прогону значит считать чужое;
//   стоит ПАУЗА — человек остановил прогон. Интервалы приходят извне (`pauses`): пауза
//     это факт о прогоне, и в событиях ОДНОЙ задачи её не видно;
//   остальное — ожидание самого ДВИЖКА: слоты заняты, зависимости не влиты, накладные
//     между стадиями. Вот за это прогон и отвечает, и именно это надо уменьшать.
//
// Интервалы человека и паузы могут пересекаться (пауза во время эскалации — обычное
// дело), поэтому вычитаются они из ожидания ОБЪЕДИНЕНИЕМ, а не суммой: иначе одно и то
// же время вычлось бы дважды и «ожидание движка» ушло бы в минус, обрезанный нулём, —
// худший вид ошибки, потому что похож на успех.
// Длина ОБЪЕДИНЕНИЯ интервалов: пересекающиеся куски считаются один раз. Нужна и
// человеку, и паузе — два окна «ждали не мы» часто накладываются.
function spanMs(spans) {
  const list = spans
    .filter((s) => s && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0])
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let from = null
  let to = null
  for (const [a, b] of list) {
    if (to === null || a > to) {
      if (to !== null) total += to - from
      from = a
      to = b
    } else if (b > to) {
      to = b
    }
  }
  if (to !== null) total += to - from
  return total
}

// Интервалы паузы прогона из журнала. Пауза, не снятая до сих пор, тянется до «сейчас» —
// это не предположение: флаг действует, новые стадии не открываются.
export function pauseSpans(events) {
  const ev = events
    .filter((e) => !e._broken && e.ts && (e.event === 'paused' || e.event === 'resumed'))
    .sort((a, b) => a.ts.localeCompare(b.ts))
  const out = []
  let from = null
  for (const e of ev) {
    if (e.event === 'paused') {
      if (from === null) from = Date.parse(e.ts)
    } else if (from !== null) {
      out.push([from, Date.parse(e.ts)])
      from = null
    }
  }
  if (from !== null) out.push([from, Date.now()])
  return out
}

// Время ПОСТАВКИ как целого — другая величина, чем сумма по задачам, и путать их нельзя.
// Сумма по задачам отвечает «сколько поставка стоила»: задачи идут параллельно, их
// интервалы накладываются, и сумма законно больше календаря (на проект-В 29.10.2026 —
// 226 ч 46 м чистого по задачам при 170 ч календаря поставки). Здесь ответ на другой
// вопрос — «сколько поставка шла», — и единица измерения тут одна: сама поставка.
//
// Чистое время поставки есть ОБЪЕДИНЕНИЕ интервалов открытых стадий: время, в которое
// шла хоть одна стадия. Вычитать из него что-либо не нужно, и это не упрощение:
//   · ожидание человека на уровне поставки неотличимо от простоя — пока идёт хоть одна
//     стадия, поставка работает, даже если другая задача эскалирована и ждёт разбора;
//   · пауза в простой попадает сама: в паузу новые стадии не открываются. А вот уже
//     открытую стадию пауза не прерывает — она доигрывает, и это время было РАБОТОЙ.
//     Вычитать паузу из активного поэтому нельзя: на проект-В так пропало бы 2 часа
//     стадий, которые честно шли (34,4 ч против 36,4 ч).
// Остаток календаря — простой: ожидание человека, пауза и промежутки между волнами.
export function deliveryTiming(events, pauses = []) {
  const ev = events.filter((e) => !e._broken && e.ts).sort((a, b) => a.ts.localeCompare(b.ts))
  if (!ev.length) {
    return { calendar_ms: 0, clean_ms: 0, pause_ms: 0, idle_ms: 0, started: null, last: null }
  }
  const startTs = Date.parse(ev[0].ts)
  const released = [...ev].reverse().find((e) => e.stage === 'release' && e.event === 'finished')
  // Поставка выпущена — календарь кончился выпуском; нет — тянется до «сейчас» (И-11:
  // открытый интервал не ноль и не факт, но время идёт, и показывать его нулём нельзя).
  const endTs = released ? Date.parse(released.ts) : Date.now()
  const calendar = Math.max(0, endTs - startTs)

  // Интервалы открытых стадий — по каждой ЗАДАЧЕ отдельно, иначе старт одной закрывал бы
  // стадию другой. Закрывают интервал все исходы, а не только удачные (ADR-0009).
  const spans = []
  const open = new Map()
  for (const e of ev) {
    const t = Date.parse(e.ts)
    const key = e.ticket || 'MR'
    if (e.event === 'started' && ['dev', 'test', 'review'].includes(e.stage)) {
      if (open.has(key)) spans.push([open.get(key), t])
      open.set(key, t)
    } else if (open.has(key) && e.event !== 'started') {
      spans.push([open.get(key), t])
      open.delete(key)
    }
  }
  for (const from of open.values()) spans.push([from, endTs])

  const clip = ([from, to]) => [Math.max(from, startTs), Math.min(to === null ? endTs : to, endTs)]
  const clean = spanMs(spans.map(clip))
  return {
    calendar_ms: calendar,
    clean_ms: clean,
    pause_ms: spanMs((pauses || []).map(clip)),
    idle_ms: Math.max(0, calendar - clean),
    started: ev[0].ts,
    last: ev[ev.length - 1].ts,
  }
}

export function timing(events, pauses = []) {
  const ev = events.filter((e) => !e._broken && e.ts).sort((a, b) => a.ts.localeCompare(b.ts))
  if (!ev.length) {
    return {
      calendar_ms: 0, active_ms: 0, waiting_ms: 0, waiting_human_ms: 0, waiting_pause_ms: 0,
      waiting_engine_ms: 0, clean_ms: 0, idle_ms: 0, open_stage: null, started: null, merged: null, last: null,
    }
  }
  const start = ev.find((e) => e.stage === 'dev' && e.event === 'started')
  const merged = [...ev].reverse().find((e) => e.stage === 'merge' && e.event === 'finished')
  // Решение человека снять или заменить задачу закрывает её календарь так же, как слияние.
  // До 02.11.2026 закрытием считалось только слияние, и у снятой задачи `idle_ms` рос
  // вечно: замер проект-В дал «584 ч 38 м без движения», из них три снятые задачи несли
  // 182 часа и продолжали набирать. Это не пробел в журнале, а решение, которое в нём
  // ЕСТЬ, — и считать его простоем значит требовать движения от задачи, по которой
  // человек постановил, что движения не будет (ADR-0009).
  const closed = [...ev].reverse().find((e) => e.stage === 'lifecycle' && ['superseded', 'cancelled'].includes(e.event))
  const startTs = start ? Date.parse(start.ts) : Date.parse(ev[0].ts)
  const lastTs = Date.parse(ev[ev.length - 1].ts)

  let active = 0
  let openStage = null
  let openTs = 0
  for (const e of ev) {
    const t = Date.parse(e.ts)
    if (e.event === 'started' && ['dev', 'test', 'review'].includes(e.stage)) {
      if (openStage) active += t - openTs
      openStage = e.stage
      openTs = t
      // Закрывают интервал ВСЕ исходы стадии, а не только удачные. `abandoned` введён
      // ADR-0009 затем, чтобы тайминг не получал выдуманную работу, — а здесь его не было,
      // и брошенная стадия «работала» бесконечно: `active_ms` считался от старта до
      // Date.now() и рос сутками. То же давал `merge/failed` после `dev/started`.
      // Ошибка была тихой: `statusFromEvents` про `abandoned` знал, и на доске всё
      // выглядело верно — врал только тайминг, то есть метрика, по которой человек решает,
      // сколько задач брать в прогон. Найдено ревью по инвариантам 01.10.2026.
    } else if (openStage && e.event !== 'started') {
      active += t - openTs
      openStage = null
    }
  }
  const now = Date.now()
  if (openStage) active += now - openTs

  // Интервалы, когда задача ждала ЧЕЛОВЕКА: от эскалации до следующего события по этой
  // задаче (разбор эскалации — `arbitrated`, но закрыть ожидание вправе любое следующее
  // событие: человек мог и просто продолжить работу).
  const humanSpans = []
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].event !== 'escalated') continue
    const from = Date.parse(ev[i].ts)
    const next = ev[i + 1] ? Date.parse(ev[i + 1].ts) : null
    humanSpans.push([from, next])
  }

  // Конец календаря по трём состояниям (см. врезку выше).
  const endTs = merged ? Date.parse(merged.ts) : closed ? Date.parse(closed.ts) : openStage ? now : lastTs
  const calendar = Math.max(0, endTs - startTs)
  const activeMs = Math.min(active, calendar)
  const waiting = Math.max(0, calendar - activeMs)
  // Обрезаем оба вида по календарю задачи: эскалация, снятая после слияния, и пауза,
  // поставленная при закрытой задаче, к её времени не относятся.
  const clip = ([from, to]) => [Math.max(from, startTs), Math.min(to === null ? endTs : to, endTs)]
  const human = spanMs(humanSpans.map(clip))
  const pause = spanMs((pauses || []).map(clip))
  const both = spanMs([...humanSpans, ...(pauses || [])].map(clip))
  return {
    calendar_ms: calendar,
    active_ms: activeMs,
    waiting_ms: waiting,
    // Ждут человека и стоит пауза — чужое время, прогон им не распоряжается (ADR-0009).
    waiting_human_ms: Math.min(human, waiting),
    waiting_pause_ms: Math.min(pause, waiting),
    // Ожидание, за которое отвечает движок. Вычитается ОБЪЕДИНЕНИЕ, а не сумма.
    waiting_engine_ms: Math.max(0, waiting - Math.min(both, waiting)),
    // ЧИСТОЕ время задачи: календарь без чужого — без ожидания человека и без паузы.
    // Главный ответ на вопрос «сколько это заняло»: разбивка ожидания нужна, чтобы
    // уменьшать накладные, а чистое время — чтобы знать цену. Считается вычитанием из
    // календаря, а не сложением активного с ожиданием движка: слагаемые обрезаны по
    // календарю каждое по отдельности, и их сумма в краевых случаях разъехалась бы с
    // разницей на несколько миллисекунд.
    clean_ms: Math.max(0, calendar - Math.min(both, calendar)),
    // Без движения: сколько прошло с последнего события у задачи, которую не влили и
    // стадий по которой не идёт. У влитой и у идущей — ноль: там календарь определён.
    idle_ms: merged || closed || openStage ? 0 : Math.max(0, now - lastTs),
    open_stage: openStage,
    started: start ? start.ts : null,
    merged: merged ? merged.ts : null,
    closed: closed ? closed.ts : null,
    last: ev[ev.length - 1].ts,
  }
}

// Расход токенов задачи — сумма по стадиям, которые его записали (`tokens` в событии
// финиша, см. tokensOf в firm-event.mjs). Считается только то, что сделал субагент:
// работа оркестратора, команд и слияния идёт в сессии человека и к задаче не относится.
// Поэтому число отвечает на вопрос «сколько стоила задача фирме», а не «сколько
// токенов прошло через машину за вечер» — второе тут и не нужно.
//
// Разбивка по стадиям важнее общей суммы: она показывает, кто именно жжёт контекст —
// Разработчик на Opus, трёхголовая панель ревью или перезапуск попытки. Без неё
// оптимизировать нечего: видно только, что дорого.
// Один субагент — один счёт. Рантайм умеет прислать `SubagentStop` по одной стадии
// НЕСКОЛЬКО раз, и движок честно пишет событие на каждый: журнал только дописывается и
// записывает то, что ему сообщили (ADR-0003, ADR-0006). Складывать такие события нельзя —
// счёт в них не частичный, а ПОЛНЫЙ и каждый раз заново, просто снятый чуть позже и
// потому чуть больший.
//
// Замер проект-В 25.10.2026: 808 субагентов, у 37 из них финишей больше одного, лишних
// событий 91. Наивная сумма по поставке 3.2 давала **481,6M токенов**, честная —
// **352,3M**: завышение на 26,9%. По журналу целиком повторно посчитано 870,9M.
//
// Чиним ЧИТАТЕЛЯ, а не писателя, и это решение. Второй `Stop` — не выдумка движка, а
// факт рантайма, и прятать его записью «не пишем» значило бы потерять след; к тому же
// прошлые журналы такая правка не лечит, а их уже не переписать. Берём МАКСИМУМ по
// субагенту: поздний снимок полнее раннего, он снят с того же транскрипта.
function latestPerAgent(events) {
  const best = new Map()
  const loose = []
  for (const e of events) {
    if (!e || e._broken || !e.tokens) continue
    if (!e.agent_id) { loose.push(e); continue } // событие без агента дублем быть не может
    const had = best.get(e.agent_id)
    if (!had || (e.tokens.total || 0) > (had.tokens.total || 0)) best.set(e.agent_id, e)
  }
  return [...best.values(), ...loose]
}

// Двойной счёт токенов: у одного захода субагента финишей бывает несколько.
//
// Замер 25.10.2026 по журналу проект-В: 808 заходов с финишем, у 37 из них финишей больше
// одного, лишних событий 91. Каждое лишнее несёт ПОЛНЫЙ счёт заново (и чуть больший —
// транскрипт к тому моменту дорос), поэтому наивная сумма по событиям завышает расход:
// по поставке 3.2 — 559.6M против 360.8M, то есть в полтора раза.
//
// Чиним ЧИТАТЕЛЯ, а не писателя: второй финиш — настоящий факт рантайма, и запрещать его
// записывать значило бы терять то, что было (ADR-0006, журнал только дописывается). К
// тому же правка писателя не чинит уже написанные журналы, а правка читателя чинит.
export function duplicateFinishes(allEvents) {
  const byAgent = new Map()
  for (const e of allEvents) {
    if (!e || e._broken || !e.agent_id || e.event === 'started' || !e.tokens) continue
    if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, [])
    byAgent.get(e.agent_id).push(e)
  }
  const rows = []
  for (const [agent_id, list] of byAgent) {
    if (list.length < 2) continue
    const sum = list.reduce((a, e) => a + (e.tokens.total || 0), 0)
    const max = list.reduce((a, e) => Math.max(a, e.tokens.total || 0), 0)
    rows.push({
      agent_id,
      ticket: String(list[0].ticket || '?'),
      stage: String(list[0].stage || '?'),
      extra: list.length - 1,
      counted: max,
      // Имя поля — `would_inflate_by`, а не `inflated_by`, и это правка по отчёту проект-В
      // 03.11.2026 (находка 3). Прежнее имя утверждало, что учёт РАЗДУТ, — и было прочитано
      // буквально: 57 записей, сумма 1 246 699 766, вывод в отчёте «цена поставки по
      // дашборду не оценка, а шум». Но двойной счёт в метриках уже снят читателем
      // (`tokenUse` → `latestPerAgent` берёт по заходу максимум), то есть число отвечает
      // на вопрос «сколько было бы при наивной сумме по файлам», а не «на сколько врёт
      // дашборд». Поле, которое читают как обвинение дашборду, обязано называться так,
      // чтобы его нельзя было так прочесть.
      would_inflate_by: sum - max,
      files: list.map((e) => e._file).filter(Boolean),
    })
  }
  return rows.sort((a, b) => b.would_inflate_by - a.would_inflate_by)
}

// Сводка по двойным финишам — ОДНИМ объектом, с ответом внутри.
//
// Голый массив строк отвечал только на «где», а читался как «на сколько врёт учёт».
// Поэтому рядом с числами стоит их смысл: сколько заходов задето, сколько лишних событий,
// что было бы при наивной сумме и что сделано вместо этого. Пустой массив даёт `rows: []`
// и те же нули — «не найдено», а не отсутствие ответа.
export function duplicateFinishSummary(allEvents) {
  const rows = duplicateFinishes(allEvents)
  return {
    agents: rows.length,
    extra_events: rows.reduce((a, r) => a + r.extra, 0),
    would_inflate_by: rows.reduce((a, r) => a + r.would_inflate_by, 0),
    counted: rows.reduce((a, r) => a + r.counted, 0),
    note: rows.length
      ? 'двойной счёт в метриках УЖЕ снят читателем (tokenUse берёт по заходу максимум, ' +
        'а не сумму): would_inflate_by — это чего СТОИЛА БЫ наивная сумма по файлам, а не ' +
        'ошибка дашборда. Лишний финиш — настоящее событие рантайма, и удалять его нельзя ' +
        '(ADR-0006, журнал только дописывается), поэтому чинится чтение, а не журнал.'
      : 'двойных финишей не найдено',
    rows,
  }
}

export function tokenUse(allEvents) {
  const events = latestPerAgent(allEvents)
  const out = {
    in: 0, out: 0, cache_read: 0, cache_write: 0, thinking: 0, total: 0, calls: 0,
    // Пиковый контекст — МАКСИМУМ по стадиям, а не сумма: он отвечает на вопрос
    // «насколько тяжёлым стал самый тяжёлый ход задачи», и складывать пики двух стадий
    // так же бессмысленно, как складывать два роста.
    ctx_peak: 0,
    // Время модели и инструментов — суммы по стадиям (см. tokensOf), самая долгая пауза —
    // максимум. Старые события их не несут и дают нули: «неизвестно» не равно «мгновенно»,
    // поэтому дашборд показывает прочерк, когда обе суммы нулевые.
    wait_ms: 0, tool_ms: 0, wait_max_ms: 0,
    by_stage: {}, by_model: {},
  }
  // `fresh` считается здесь, а не у каждого потребителя: иначе «свежее» в двух местах
  // разойдётся в определении, и спорить будут уже про определение, а не про число.
  for (const e of events) {
    const t = e && !e._broken && e.tokens
    if (!t) continue
    out.in += t.in || 0
    out.out += t.out || 0
    out.cache_read += t.cache_read || 0
    out.cache_write += t.cache_write || 0
    out.thinking += t.thinking || 0
    out.calls += t.calls || 0
    out.total += t.total || 0
    if ((t.ctx_peak || 0) > out.ctx_peak) out.ctx_peak = t.ctx_peak
    out.wait_ms += t.wait_ms || 0
    out.tool_ms += t.tool_ms || 0
    if ((t.wait_max_ms || 0) > out.wait_max_ms) out.wait_max_ms = t.wait_max_ms
    const st = e.stage || '?'
    // По стадиям держим ДВА числа: с кэшем и свежее (вход + выход). Одного числа здесь
    // хватало, пока оно не стало читаться как «работа»: 94% суммы — перечитывание уже
    // посланного контекста (замер проект-В 28.10.2026), и вопрос «какая стадия дорогая»
    // по нему отвечается неверно — дорогой выглядит самая длинная, а не самая работающая.
    const b = (out.by_stage[st] = out.by_stage[st] || { total: 0, fresh: 0 })
    b.total += t.total || 0
    b.fresh += (t.in || 0) + (t.out || 0)
    for (const [m, v] of Object.entries(modelSplit(t))) {
      const b = (out.by_model[m] = out.by_model[m] ||
        { in: 0, out: 0, cache_read: 0, cache_write: 0, thinking: 0, calls: 0, total: 0 })
      b.in += v.in || 0
      b.out += v.out || 0
      b.cache_read += v.cache_read || 0
      b.cache_write += v.cache_write || 0
      b.thinking += v.thinking || 0
      b.calls += v.calls || 0
      b.total += v.total || 0
    }
  }
  out.fresh = out.in + out.out
  return out
}

// Разбивка расхода события по моделям. События до 0.4.28 её не несут — там есть только
// поле `model`, иногда со списком через запятую. Журнал переживает смену версии движка
// (он же и есть история проекта), поэтому старые события читаем как умеем, а не теряем:
// одна модель — весь расход ей, список — в «смешанные», нет поля — в «без модели».
// Делить старое число между моделями поровну было бы выдумыванием данных.
function modelSplit(t) {
  if (t.by_model && Object.keys(t.by_model).length) return t.by_model
  const one = { in: t.in || 0, out: t.out || 0, cache_read: t.cache_read || 0,
    cache_write: t.cache_write || 0, thinking: t.thinking || 0, calls: t.calls || 0,
    total: t.total || 0 }
  const m = t.model ? String(t.model) : ''
  if (!m) return { 'без модели': one }
  if (m.includes(',')) return { 'смешанные (старое событие)': one }
  return { [m]: one }
}

// Имя модели для таблицы. `claude-sonnet-5` читается как `sonnet-5`: префикс одинаков у
// всех и в узкой колонке занимает место, которое нужно числам. Полное имя остаётся в
// журнале и в подсказке ячейки.
export function shortModel(m) {
  return String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

// Токены читают глазами и сравнивают между задачами, поэтому точность до единицы
// вредна: 1 203 847 хуже, чем 1.2M. Полное число остаётся в журнале.
// Ворота поставки — то, во что упираются ВСЕ задачи: MR-ревью всего диффа и демо человеку.
// На доске их не было, и это искажало картину целиком: поставка выглядела законченной,
// когда влита последняя задача, хотя впереди оставались два шага, и один из них —
// ожидание человека, то есть обычно самый долгий интервал всего маршрута.
//
// Тикета у ворот нет по устройству (они про поставку, а не про задачу), поэтому события
// им пишутся с тикетом `MR` — та же метка, что уже придумана для MR-ревью в firm-event.mjs.
// Стадии две: `review` (субагент, у события есть tokens) и `demo` (человек, токенов нет
// и быть не может — это и есть содержательная разница между воротами).
export function gates(events) {
  const ev = events.filter((e) => !e._broken && e.ticket === 'MR' && e.ts).sort((a, b) => a.ts.localeCompare(b.ts))
  const build = (stage) => {
    const mine = ev.filter((e) => e.stage === stage)
    if (!mine.length) return { stage, state: 'не начаты', ms: 0, tokens: 0, started: null, ended: null }
    const start = mine.find((e) => e.event === 'started')
    const end = [...mine].reverse().find((e) => e.event !== 'started')
    const startTs = start ? Date.parse(start.ts) : Date.parse(mine[0].ts)
    const endTs = end ? Date.parse(end.ts) : Date.now()
    // Через `tokenUse`, а не суммой по событиям: у одного субагента финишей бывает
    // несколько, и каждый несёт ПОЛНЫЙ счёт заново (см. latestPerAgent).
    const tk = tokenUse(mine).total
    // Исход берём из последнего события: у ревью это accepted/rejected, у демо —
    // finished/rejected. Пересказывать его словами не надо, это и так enum журнала.
    return {
      stage,
      state: end ? end.event : 'идут',
      ms: Math.max(0, endTs - startTs),
      tokens: tk,
      started: start ? start.ts : mine[0].ts,
      ended: end ? end.ts : null,
      attempts: mine.filter((e) => e.event === 'started').length,
    }
  }
  return { review: build('review'), demo: build('demo') }
}

export function humanTokens(n) {
  if (!n || n < 0) return '—'
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

export function humanDuration(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}с`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}м`
  const h = Math.floor(m / 60)
  return `${h}ч ${m % 60}м`
}

// ── Баги (§5) ─────────────────────────────────────────────────────────────────

// Живые состояния бага. Остальные (resolved, deferred, wont_fix, а также прижившиеся на
// практике fixed и closed) означают, что решение принято и в тревогу они не идут.
export const BUG_OPEN = new Set(['open', 'fixing'])

// Заголовок бага. В шаблоне поля title нет, а без названия список багов нечитаем —
// «BUG-003 · dissent · blocker» не говорит ни о чём. Поэтому берём поле, если оно есть,
// иначе первую содержательную строку тела: по соглашению там раздел «Что наблюдалось».
function firstLineOfBody(body) {
  for (const line of String(body || '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('---')) continue
    return t.length > 110 ? t.slice(0, 107) + '…' : t
  }
  return ''
}

export function listBugs(root) {
  const dir = join(root, 'docs', 'bugs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^BUG-[\w.-]+\.md$/.test(f))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8')
      const { data, body } = parseFrontmatter(raw)
      return {
        id: data.id || basename(f, '.md'),
        title: data.title || firstLineOfBody(body),
        rel: join('docs', 'bugs', f),
        source: data.source || 'manual',
        change: data.change || null,
        tickets: toArray(data.tickets),
        verdict: data.verdict || 'pending',
        status: data.status || 'open',
        fix_task: data.fix_task || null,
        open: BUG_OPEN.has(String(data.status || 'open')),
      }
    })
}

// ── Нумерация задач и багов ───────────────────────────────────────────────────
//
// На одном проекте поставок несколько, и номера задач сквозные по проекту, а не по
// поставке. Причина не в эстетике: тикет — ключ, по которому журнал событий связывает
// стадию с задачей (§6). Журнал один на проект и живёт дольше поставки, поэтому T-003
// из второй поставки склеился бы в статистике с T-003 из первой — доска показала бы
// чужие стадии, а `doctor` не увидел бы в этом дыры: с его точки зрения всё привязано.
//
// До 23.09.2026 номер выбирал Архитектор «следующим свободным», видя только свою
// поставку, и на втором прогоне начинал с T-001 заново; человеку пришлось вручную
// просить «прибавь 100». Раз ошибка вида «номер занят» молчалива, номер выдаёт код.
//
// Занятым считается номер, встреченный ГДЕ УГОДНО: в живых поставках, в архиве и в
// журнале событий. Журнал обязателен: каталог задачи могли переименовать или снести,
// а события с её тикетом остались — и переиспользовать такой номер нельзя.
const NUM_ID_RE = /^(T|BUG)-(\d+)$/

function idNumber(id, prefix) {
  const m = NUM_ID_RE.exec(String(id || '').trim())
  return m && m[1] === prefix ? Number(m[2]) : null
}

// Все каталоги задач проекта: живые поставки + архив.
function allTasksDirs(root) {
  const dirs = []
  const base = changesDir(root)
  if (!existsSync(base)) return dirs
  for (const name of listChanges(root)) {
    const d = join(base, name, 'tasks')
    if (existsSync(d)) dirs.push(d)
  }
  const arch = join(base, 'archive')
  if (existsSync(arch)) {
    for (const e of readdirSync(arch, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const d = join(arch, e.name, 'tasks')
      if (existsSync(d)) dirs.push(d)
    }
  }
  return dirs
}

// Кто занял номер — нужно, чтобы отличить «номер из архива» от настоящего дубля
// в двух живых поставках (последнее чинить обязательно, первое — норма).
export function usedIds(root) {
  const tasks = new Map()
  const bugs = new Map()
  const note = (map, id, where) => {
    if (!id) return
    if (!map.has(id)) map.set(id, [])
    if (!map.get(id).includes(where)) map.get(id).push(where)
  }
  for (const dir of allTasksDirs(root)) {
    const where = dir.slice(root.length + 1)
    for (const f of readdirSync(dir)) {
      if (!/^T-[\w.-]+\.md$/.test(f)) continue
      note(tasks, basename(f, '.md'), where)
    }
  }
  for (const b of listBugs(root)) note(bugs, b.id, 'docs/bugs')
  // Занятые ЗАБРОНИРОВАННЫМ номером — четвёртый источник, и единственный, который виден
  // в момент выдачи (отчёт проект-В 03.11.2026, находка 4; третье столкновение подряд —
  // BUG-158, BUG-159, BUG-171). Файл бага пишет роль В СВОЁМ рабочем дереве, значит в
  // главном дереве его нет до слияния, а ветки задачи никто не читает; `next-id`
  // спрашивал «какой номер занят по `docs/bugs` главного дерева» и честно отвечал один и
  // тот же номер двум зовущим в одну минуту.
  for (const { id, kind } of claimedIds(root)) note(kind === 'bug' ? bugs : tasks, id, '.firm/ids')
  for (const e of listEvents(root, {})) {
    // `MR` и `G-XXX` — привязки не к задаче: первая к поставке, вторая к теме разведки.
    // В перечне занятых номеров задач им места нет, иначе `next-id` считал бы их задачами.
    if (e._broken || !e.ticket || e.ticket === 'unknown' || e.ticket === 'MR') continue
    if (/^G-/.test(e.ticket)) continue
    note(tasks, e.ticket, 'journal')
  }
  return { tasks, bugs }
}

// ── Брони номеров: каталог `.firm/ids/` ───────────────────────────────────────
//
// Один файл на номер, создаётся флагом `wx` — тем же приёмом, которым пишется событие
// (ADR-0003). Это и есть вся атомарность: `wx` создаёт файл или падает с `EEXIST`, и
// обогнать его нельзя, сколько бы ролей ни спрашивало номер в одну миллисекунду. Проверки
// «а не занято ли» тут нет намеренно — между `existsSync` и записью помещается чужая броня.
//
// Почему каталог в ГЛАВНОМ дереве, а не в дереве задачи: роли работают каждая в своём
// рабочем дереве, и файл, написанный там, виден только ей до слияния. `root` здесь всегда
// главное дерево (`repoRoot` идёт через `--git-common-dir`), поэтому броня видна всем
// сразу — ровно там же, где журнал.
//
// Почему не событием журнала: событий на выдачу номера было бы по одному на каждый
// спрошенный номер, а журнал читают целиком на каждой сверке. Броня — это не факт о
// поставке, а служебная расписка; её место рядом с журналом, но не в нём.
// Броня номера живёт в ОДНОМ месте на проект — в главном рабочем дереве. Отчёт проект-В
// Д-45, замер 06.11.2026 по тринадцати деревьям проект-В: броней в главном дереве 40, в
// `_base` 38, в `_merge3d` 40, в восьми деревьях груминга — НОЛЬ. То есть броня, взятая
// ролью в своём дереве, не видна ни одному другому, и защита от столкновения, ради которой
// она и заведена (находка 4 от 03.11.2026, три столкновения подряд), в связанном дереве не
// работает вовсе.
//
// Почему главное дерево, а не ветка (ср. И-9а, где событие принадлежит ветке): НОМЕР
// принадлежит проекту, а не ветке. Два груминга, идущие параллельно, обязаны видеть броню
// друг друга — иначе они возьмут один номер, и это ровно то, что чинилось броней.
function mainWorktree(root) {
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // `<главное дерево>/.git` — нормальный случай; bare-репозиторий или `.git` файлом
    // оставляем как есть: тогда общего дерева нет, и единственное место — своё.
    if (common.endsWith(`${sep}.git`)) return dirname(common)
  } catch {
    // не git-репозиторий — работаем в своём дереве
  }
  return root
}

function idsDir(root) {
  return join(mainWorktree(root), '.firm', 'ids')
}

export function claimedIds(root) {
  const dir = idsDir(root)
  if (!existsSync(dir)) return []
  const out = []
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(T|BUG|BR)-([\w.-]+)\.json$/.exec(f)
      if (!m) continue
      out.push({ id: basename(f, '.json'), kind: m[1] === 'BUG' ? 'bug' : (m[1] === 'BR' ? 'br' : 'task') })
    }
  } catch {
    return out
  }
  return out
}

// Следующие `count` свободных номеров. Выдаются подряд от максимума, а не по дыркам:
// дырка обычно означает отменённую задачу, и переиспользование её номера смешает в
// журнале отменённое с новым.
//
// `claim: true` — не «посмотреть», а ВЗЯТЬ: на каждый выданный номер кладётся броня, и
// второму зовущему тот же номер уже не достанется. Выдача без брони осталась (`claim`
// по умолчанию выключен) и нужна там, где спрашивают из любопытства — `max_used` для
// сверки, план на двадцать задач вперёд глазами человека.
export const ID_KINDS = ['task', 'bug', 'br', 'adr']

// Освобождение брони. Поставлено 06.11.2026 по следу, оставленному самим механизмом: в
// проект-В нашлась броня `BUG-175` без бага — её положил ДИАГНОСТИЧЕСКИЙ вызов `next-id
// --kind bug` (у багов броня по умолчанию, и это правильно: три столкновения подряд
// лечились именно ею). Но дороги назад не было вовсе: номер занят навсегда, а снять его
// можно только удалением файла руками — приёмом, который нигде не описан, то есть
// неизвестен тому, кто номер занял.
//
// Почему это не «просто уборка»: распределитель, у которого нет освобождения, монотонно
// раздувает нумерацию на каждой диагностике, а человек читает номер бага как счётчик
// найденного. Отказ здесь важнее самого снятия: если номером уже НАЗВАН файл, задача или
// событие, броня — последнее, что о нём помнит, и снимать её нельзя (И-12: молчаливое
// снятие выглядело бы как «номер свободен»).
// Броня не должна попадать в индекс — и при этом должна выживать `git clean -fd`.
// До 06.11.2026 это решалось `git add` на каждый номер, и у решения была цена, которую
// назвал проект-В: броня появлялась в `git status` между двумя коммитами планирования и
// уезжала в чужой коммит первым же `git add -A` — невидимо для того, кто коммитит. Это
// правка чужого коммита в обратную сторону, и она хуже того, от чего защищались.
//
// Теперь защита — ИГНОР в отслеживаемом файле `.firm/.gitignore`: ignored-файл не виден
// ни `git status`, ни `git add -A` (проверено), а `git clean -fd` ignored-файлы не трогает
// по документированной семантике git — их сносит только `-x`.
//
// Что проверяется, а что взято с документации, и почему именно так (замер 06.11.2026,
// предложение проект-В): рубеж проверяет ПОСЫЛКУ — что путь действительно ignored
// (`git check-ignore -v`), — а не поведение `git clean`. Живой вызов `clean` заперт по
// меньшей мере в двух независимых средах (здесь песочницей, у проект-В правилом доступа),
// то есть ни одна сторона не может его прогнать, и обе ссылались бы на документацию.
// `check-ignore` не заперт нигде и проверяется везде.
//
// Цена названа и невелика по существу: `git clean -fdx` броню снесёт. Но броня — это
// СТОРОЖ ОКНА между выдачей номера и записью файла, а не запись о занятости: потолок
// считается по файлам и живым линиям (`refCeiling`), и потерянная броня стоит не
// забытого номера, а лишь возможного столкновения двух выдач внутри этого окна.
// Файл игнора один на проект и кладётся в индекс один раз — это видимая, объяснимая
// правка, в отличие от файла на каждый выданный номер.
function ignoreClaims(root) {
  const dir = join(mainWorktree(root), '.firm')
  const file = join(dir, '.gitignore')
  let text = ''
  try {
    text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return
  }
  if (/^\s*ids\/?\s*$/m.test(text)) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      `${text}${text && !text.endsWith('\n') ? '\n' : ''}` +
      '# Броня номеров — учёт выдачи, а не содержимое проекта: файл на каждый выданный\n' +
      '# номер не должен попадать в чужой коммит первым же `git add -A` (случай проект-В\n' +
      '# 06.11.2026). Игнор держит её вне индекса и при этом спасает от `git clean -fd`:\n' +
      '# ignored-файлы сносит только `git clean -fdx`. Если это всё же случится — беда\n' +
      '# невелика: броня сторожит ОКНО между выдачей номера и записью файла, а занятость\n' +
      '# номера движок считает по файлам и живым ветвям, а не по ней.\n' +
      'ids/\n',
    )
    execFileSync('git', ['-C', mainWorktree(root), 'add', '--', file], { stdio: 'ignore' })
  } catch {
    // Не git-репозиторий или запись запрещена — броня всё равно на диске и работает.
  }
}

export function releaseId(root, id) {
  const want = String(id || '').trim().toUpperCase()
  if (!/^(T|BUG|BR)-[\w.-]+$/.test(want)) {
    const e = new Error(
      `«${id}» не похож на номер, который движок распределяет (T-NNN, BUG-NNN, BR-N). ` +
      'Освобождать нечего: броня лежит под именем номера',
    )
    e.code = 'FIRM2_BAD_ID'
    throw e
  }
  const kind = want.startsWith('BUG') ? 'bugs' : 'tasks'
  const used = usedIds(root)[kind]
  const where = (used.get(want) || []).filter((w) => w !== '.firm/ids')
  if (where.length) {
    const e = new Error(
      `номером ${want} уже названо: ${where.join(', ')}. Броню снимать НЕЛЬЗЯ — она ` +
      'последнее, что помнит о занятости номера, и её снятие читалось бы как «номер свободен»',
    )
    e.code = 'FIRM2_ID_IN_USE'
    throw e
  }
  const file = join(idsDir(root), `${want}.json`)
  const verify = {
    verify: `next-id --kind ${kind === 'bugs' ? 'bug' : 'task'} --peek`,
    note: 'проверять снятие надо --peek. Тот же next-id БЕЗ --peek займёт номер заново, ' +
      'и уборка за собой приведёт туда, откуда начали (случай проект-В 06.11.2026)',
  }
  if (!existsSync(file)) {
    return { id: want, released: false, why: 'брони с таким номером нет', file: null, ...verify }
  }
  // Снимаем и из индекса: броня в индекс кладётся при выдаче (иначе её сносит `git clean`),
  // и оставить её там значит освободить номер на диске, но закоммитить занятым.
  try {
    execFileSync('git', ['-C', root, 'rm', '-q', '-f', '--', file], { stdio: 'ignore' })
  } catch {
    try {
      rmSync(file, { force: true })
    } catch {
      const e = new Error(`броню ${want} снять не удалось: ${file}`)
      e.code = 'FIRM2_RELEASE_FAILED'
      throw e
    }
  }
  return { id: want, released: true, file: file.slice(mainWorktree(root).length + 1), ...verify }
}

// Потолок номера по живым линиям.// Потолок номера по живым линиям. Для багов читается `docs/bugs/`, для задач — файлы
// задач в `openspec/changes/**/tasks/`; обе формы движок и так знает, здесь они только
// читаются из РЕВИЗИИ, а не из рабочего дерева.
//
// `core.quotepath=false` — по тому же доводу, что в потолке ADR: по умолчанию git
// экранирует не-ASCII в путях, и файл с русским именем в потолок не попадает вовсе.
const ID_FILE = {
  bug: { dir: 'docs/bugs', re: /(?:^|\/)BUG-(\d+)/ },
  task: { dir: 'openspec', re: /\/tasks\/T-(\d+)/ },
}

export function refCeiling(root, kind = 'bug', config = null) {
  const shape = ID_FILE[kind === 'bug' ? 'bug' : 'task']
  const refs = liveRefs(root, config)
  let max = 0
  let where = null
  for (const ref of refs) {
    let listed = ''
    try {
      listed = execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', ref, '--', shape.dir], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      continue
    }
    for (const path of listed.split('\n')) {
      if (!path.endsWith('.md')) continue
      const m = path.match(shape.re)
      if (!m) continue
      const n = Number(m[1])
      if (n > max) {
        max = n
        where = ref
      }
    }
  }
  return { max_used: max, where, refs }
}

export function nextIds(root, { kind = 'task', count = 1, claim = false, by = null } = {}) {
  // Неизвестный вид — ОТКАЗ, а не задачный номер. Молчаливая подмена хуже отказа: отказ
  // роль увидит, подмену нет (Д-50, проект-В 05.11.2026 — `--kind adr` отдавал `T-336`).
  if (!ID_KINDS.includes(kind)) {
    const e = new Error(
      `неизвестный вид номера «${kind}». Движок распределяет: ${ID_KINDS.join(', ')}. ` +
      'Номер другого рода движок не выдаёт — и не подменяет задачным: ответ с чужим ' +
      'номером читается как ответ на заданный вопрос',
    )
    e.code = 'FIRM2_UNKNOWN_ID_KIND'
    throw e
  }
  const prefix = kind === 'bug' ? 'BUG' : 'T'
  const used = usedIds(root)[kind === 'bug' ? 'bugs' : 'tasks']
  let max = 0
  let where = 'дерево'
  for (const id of used.keys()) {
    const n = idNumber(id, prefix)
    if (n !== null && n > max) max = n
  }
  // Потолок считается по ЖИВЫМ ЛИНИЯМ, а не по одному дереву (Д-45). Замер 06.11.2026 по
  // деревьям проект-В: в главном дереве файлов багов до `BUG-174`, а в дереве груминга
  // `G-010` — до `BUG-081`. Роль, работающая в таком дереве, получала `BUG-082` — номер,
  // занятый девяносто багов назад, и выдавался он молча. Это тот же корень, что у Д-46
  // (потолок ADR) и Д-51 (ветка события): движок смотрел в своё дерево и считал, что видит
  // проект.
  const ceiling = refCeiling(root, kind)
  if (ceiling.max_used > max) {
    max = ceiling.max_used
    where = ceiling.where
  }
  const pad = (n) => `${prefix}-${String(n).padStart(3, '0')}`
  const want = Math.max(1, count)
  const ids = []
  if (!claim) {
    for (let i = 1; i <= want; i++) ids.push(pad(max + i))
    return { kind, prefix, max_used: max, next: ids[0], ids, used_count: used.size, claimed: false, ceiling_from: where, refs: ceiling.refs }
  }
  mkdirSync(idsDir(root), { recursive: true })
  ignoreClaims(root)
  // Идём от максимума вверх и берём первые `want` номеров, которые удалось занять. Предел
  // на число попыток — защита от бесконечного цикла, если каталог брони вдруг окажется
  // нечитаемым-но-записываемым: лучше вернуть меньше номеров и сказать об этом, чем
  // крутиться молча (ADR-0007).
  for (let n = max + 1; ids.length < want && n <= max + want + 1000; n++) {
    const id = pad(n)
    try {
      writeFileSync(
        join(idsDir(root), `${id}.json`),
        JSON.stringify({ id, kind, ts: new Date().toISOString(), by: by || null }, null, 1) + '\n',
        { flag: 'wx' },
      )
    } catch (e) {
      if (e.code === 'EEXIST') continue // номер взят другим — берём следующий
      throw e
    }
    ids.push(id)
  }
  return {
    kind,
    prefix,
    max_used: max,
    next: ids[0] || null,
    ids,
    used_count: used.size,
    claimed: true,
    short: ids.length < want ? want - ids.length : 0,
    ceiling_from: where,
    refs: ceiling.refs,
    // Выдача с бронью ЗАНИМАЕТ номер, и ответ обязан сказать это вслух вместе с дорогой
    // назад. Случай проект-В 06.11.2026: сверка номера зовётся тем же `next-id`, значит
    // проверка результата создаёт бронь ЗАНОВО — уборка за собой приводит туда, откуда
    // начал, и выход из петли надо было угадать. Поэтому обе подсказки едут в ответе.
    verify: `next-id --kind ${kind} --peek`,
    release: ids.length ? `next-id --release ${ids[0]}` : null,
    note: 'номер ЗАНЯТ этим вызовом. Смотреть, не занимая, — только --peek: повторный ' +
      'next-id без --peek займёт следующий номер, а не покажет прежний',
  }
}

// ── Номера бизнес-правил: аллокатор и сверка ─────────────────────────────────
//
// Разбор стадии PM 22.10.2026. Промпт сам называл риск и сам же оставлял его без
// механизма: «номера `BR-N` берёшь следующими свободными... два груминга идут параллельно
// и способны взять один номер, а назван он — расхождение видно до слияния». Видно чем?
// У задач ровно это закрыто двумя механизмами — `next-id` выдаёт номер и `doctor`
// возвращает `duplicate_ids`; у бизнес-правил не было ни первого, ни второго, хотя
// `br_refs` задач на эти номера ссылаются, а шаблон BRD объявляет их непереиспользуемыми.
//
// Отмена номер НЕ освобождает: правило помечается `superseded by BR-12` и остаётся в
// документе (`templates/BRD.example.md`). Поэтому номера выдаются от максимума, как у
// задач, а не по дыркам: дырка — это отменённое правило, и ссылка из архивной задачи на
// переиспользованный номер разрешится не туда.
//
// Определение правила — ЭЛЕМЕНТ СПИСКА: `- **BR-7.** ...` (формат шаблона), `- BR-7:` или
// `- **BR-7** (отменено ...)`. Упоминание в тексте определением не считается: иначе абзац
// «см. BR-7» объявил бы правило дважды, и сверка дублей шумела бы на каждом живом BRD.
//
// Маркер списка ОБЯЗАТЕЛЕН, и это правка 23.10.2026 по разбору проект-В. В первой редакции
// (0.4.93) необязательным было всё — и маркер, и звёздочки, и точка, — так что условие
// сводилось к «строка начинается с номера правила». А правило, упомянутое в конце абзаца,
// при переносе оказывается первым в своей строке: `  BR-45.` — это хвост фразы «Следствие
// для конца сезона — BR-45.», а не второе определение. Сверка выдавала пять ложных
// находок на живом BRD проект-В (BR-45, 63, 83, 95, 103) — то есть механизм, поставленный
// против дублей номеров, сам же был источником шума и отменял собственный сигнал.
//
// Замер по шести проектам (`docs/product/*.md`, 376 определений): маркер списка есть у
// ВСЕХ настоящих определений, и его требование снимает ровно шесть строк — пять в проект-В
// и одну в проект-А, — все шесть перенесённые ссылки. Точка после номера при этом
// остаётся необязательной: `- **BR-115** (отменено 2026-09-29, superseded by BR-121)` в
// проект-Б — настоящее определение отменённого правила, и терять его нельзя, иначе
// номер освободится и уедет в `next-id`.
// Форма определения сужена дважды — 02.11.2026, по разбору проект-В (Д-42 проекта). Редакция
// 23.10.2026 требовала маркера списка и этим сняла пять ложных находок, но оставила два
// допущения, и каждого из них хватает:
//
//   1. `^\s*` разрешал ОТСТУП, то есть вложенный пункт считался определением наравне с
//      пунктом верхнего уровня;
//   2. `[.:)]?` делал знак после номера необязательным, поэтому
//      `- **BR-134 — не трогается:**` проходило так же, как `- **BR-134.** Потолок ширины…`.
//
// Замер: `build-args` проект-В выдал шесть находок «номер определён дважды» (BR-105, 134,
// 183, 201, 228 и BR-227 четырежды). Дублей не было ни одного — все «вторые определения»
// это восемь строк-ссылок внутри тела ОДНОГО правила BR-237, в его списке «что этим
// меняется в уже принятом». Цена такой находки не косметическая: гейт по назначению
// требует времени человека, и человек поставил по ней отдельный заход на перенумерацию —
// то есть находка предлагала завести НОВЫЕ номера существующим правилам и порвать `br_refs`
// трёх задач, шедших в этот момент в волне.
//
// Теперь определение — пункт БЕЗ отступа, у которого сразу за номером стоит либо знак
// (`.`, `:`, `)`), либо закрывающая пара звёздочек: `- **BR-7.** …`, `- BR-7: …`,
// `- **BR-115** (отменено 2026-09-29, superseded by BR-121)`. Последняя форма — настоящее
// определение отменённого правила из проект-Б, и терять его нельзя: номер
// освободится и уедет в `next-id`.
//
// Замер по пяти живым BRD (413 определений): ни одного определения с отступом нет вовсе, а
// сужение снимает ровно восемь строк — те самые ссылки проект-В. Проверено и на тексте ДО
// обхода, принятого проектом (`67eb2344` подставил слово «правило» перед номером): 230
// находок становятся 222, и все восемь снятых — ссылки.
//
// Та же болезнь уже разбиралась в самом проект-В: его собственный тест свода
// (`tests/test_t176_br_provenance_convention.py`) с тех пор требует `^- \*\*BR-(\d+)\.` и
// на тех же 4336 строках зелёный. Повторение в копии разбора — довод за сужение, а не
// против: один и тот же документ два разборщика читают по-разному, и расходиться им негде.
const BR_DEF = /^[-*]\s+\*{0,2}BR-(\d+)(?:[.:)]\*{0,2}|\*{2})(?:\s|$)/

// Строка верхнего уровня, похожая на определение, но формы не той. Таких в пяти живых BRD
// ноль, и именно поэтому они не выбрасываются молча: ошибка в эту сторону (определение
// принято за ссылку) освобождает номер, и `next-id` выдаст его второму правилу — то есть
// ровно тот вред, против которого стоит вся эта сверка. Вложенные пункты сюда НЕ попадают:
// их восемь в одном проект-В, и все восемь — законные ссылки.
const BR_MAYBE = /^[-*]\s+\*{0,2}BR-(\d+)\b/

// Отменённое правило. Для `next-id` разница неважна — номер занят в обоих случаях, — а
// для ссылки важна дословно: «такого правила нет» и «это правило отменено» человек на
// воротах лечит по-разному. Поставка проект-В 03.11.2026 отменила BR-23 целиком через час
// после принятых ворот, то есть ссылка на отменённое — не теория.
//
// Форм две, и вторую пришлось снять с живого BRD. Шаблон движка предлагает одну строку
// (`- ~~**BR-3.**~~ … — superseded by BR-12`), а проект-В пишет отмену СЛЕДУЮЩЕЙ строкой
// после определения, абзацем на пол-экрана: «**Отменено 03.11.2026** решением человека
// …». Первая редакция этой сверки читала только одну строку и на 214 правилах живого
// свода нашла ноль отменённых при фактически отменённом BR-23 — то есть молчала бы ровно
// там, где нужна.
//
// Отсюда признак: отмена читается в БЛОКЕ правила (до следующего определения), и только
// со строки, которая отменой НАЧИНАЕТСЯ С ЗАГЛАВНОЙ. Оба сужения стоят на замере по тому
// же своду (214 правил, 6 срабатываний против 3 верных у широкой редакции):
//
//   - «где-то в блоке встретилось слово» объявило бы отменённым живое правило: свод
//     говорит «BR-23 отменён целиком» внутри текста ДРУГОГО правила, пунктом списка;
//   - без заглавной буквы отменёнными оказались BR-28, BR-134 и BR-179 — у всех трёх
//     строка переноса абзаца НАЧИНАЕТСЯ со слова «отменён» посреди фразы («отменённое
//     правило отдавало запас…», «**отменена**)»).
//
// Заглавная здесь не стиль, а признак: отмена — утверждение, с которого начинается
// фраза, и в живом своде все три настоящие отмены записаны «**Отменено <дата>**
// решением человека …». Строка переноса начинается со строчной всегда.
const BR_RETIRED_SAME = /^[-*]\s+(?:~~)?\*{0,2}BR-(\d+)\b[^\n]*(?:superseded|Отменено|отменено|Отменён|отменён)/
//
// Конец слова здесь НЕ через `\b`, и это та же ловушка, что в сверке границ модулей: в JS
// `\w` только ASCII, поэтому после кириллической «о» граница слова не возникает вовсе и
// правило молчит на всём корпусе. Поймано прогоном по живому своду: ноль срабатываний там,
// где их три. Отсюда `(?!\p{L})` и флаг `u`.
const BR_RETIRED_LINE = /^\s*(?:\*\*|~~)*(?:Отменено|Отменён|Отменен|Снято|superseded)(?!\p{L})/u

export function brState(root) {
  const defs = new Map() // номер → [где]
  const dir = join(root, 'docs', 'product')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    files = []
  }
  const ambiguous = []
  const retired = new Map()
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8')
    // Номер правила, в чьём блоке мы сейчас находимся: отмену пишут строкой после
    // определения, и приписать её нужно именно этому правилу, а не следующему.
    let block = null
    text.split('\n').forEach((line, i) => {
      const where = `docs/product/${f}:${i + 1}`
      // Отмена в одной строке с номером. Проверяется ДО разбора определения, потому что
      // зачёркнутая форма шаблона (`- ~~**BR-3.**~~ … superseded by BR-12`) определением
      // не считается вовсе: номер она держит, а правила уже не даёт.
      const same = line.match(BR_RETIRED_SAME)
      if (same && !retired.has(Number(same[1]))) retired.set(Number(same[1]), where)
      const m = line.match(BR_DEF)
      if (!m) {
        if (/^#/.test(line)) block = null
        if (block !== null && BR_RETIRED_LINE.test(line) && !retired.has(block)) retired.set(block, where)
        if (BR_MAYBE.test(line)) ambiguous.push({ where, line: line.trim().slice(0, 120) })
        return
      }
      const n = Number(m[1])
      block = n
      if (!defs.has(n)) defs.set(n, [])
      defs.get(n).push(where)
    })
  }
  const nums = [...defs.keys()].sort((a, b) => a - b)
  return { files, defined: nums, max_used: nums.length ? nums[nums.length - 1] : 0, where: defs, ambiguous, retired }
}

export function nextBr(root, count = 1) {
  const st = brState(root)
  const ids = []
  for (let i = 1; i <= Math.max(1, count); i++) ids.push(`BR-${st.max_used + i}`)
  return { kind: 'br', prefix: 'BR', max_used: st.max_used, next: ids[0], ids, used_count: st.defined.length }
}

// Две находки, и обе про ссылку, которая не разрешится: номер, определённый дважды, и
// `br_refs` задачи, указывающий на правило, которого в BRD нет. Вторая не запрещает
// работу: BRD живёт в главном дереве, а задача может прийти из груминга, где правило
// ещё не слито. Поэтому это находка гейта — то есть вопрос человеку до утверждения.
export function brFindings(root, change = null) {
  const st = brState(root)
  if (!st.files.length) return []
  const out = []
  for (const n of st.defined) {
    const where = st.where.get(n)
    if (where.length > 1) {
      out.push(`BR-${n} определён ${where.length} раза (${where.join(', ')}) — два груминга взяли один номер, и ссылка br_refs теперь означает два разных правила`)
    }
  }
  for (const a of st.ambiguous) {
    out.push(`${a.where}: строка похожа на определение правила, но форма не та — «${a.line}». Определение это пункт верхнего уровня, у которого сразу за номером стоит знак или закрывающие звёздочки (\`- **BR-7.** …\`, \`- BR-7: …\`, \`- **BR-7** (отменено …)\`). Если это определение — номер не занят, и next-id выдаст его второму правилу; если ссылка — поставьте её вложенным пунктом или словом перед номером`)
  }
  const known = new Set(st.defined)
  for (const t of listTasks(root, change)) {
    const orphan = (t.br_refs || []).filter((r) => {
      const n = Number(String(r).replace(/^BR-/i, ''))
      return Number.isFinite(n) && n > 0 && !known.has(n)
    })
    if (orphan.length) {
      out.push(`${t.id}: br_refs ссылается на ${orphan.join(', ')}, а такого правила в docs/product/ нет — критерий приёмки опирается на правило, которого человек не утверждал`)
    }
  }
  return out
}

// ── Объявленные границы модулей: что сказано неизменным, то не тронуто ────────
//
// Замер проект-В 25.10.2026, поставка 3.2. Вопрос человека был про связанность: кто следит,
// что Разработчик не наращивает её. Замер ответил, что следить не за чем — 24 задачи
// добавили 7 рёбер между модулями, все семь обвязка новых модулей самой поставки, а
// горячие файлы проекта (`playerApi.ts` fan-in 117, `sqlite/__init__.py` 98) поставка не
// тронула вовсе. Проверка на рост связанности сработала бы на 5 задачах из 24 законно,
// то есть была бы шумом.
//
// Нашлось другое. У Архитектора в `design.md` есть решение «Границы модулей» (у проект-В —
// D9), и это ГОТОВЫЙ машинный критерий, написанный той ролью, которая за границы и
// отвечает:
//
//   app/ruleset/schema.py   НЕ меняется: ни нового поля, ни происхождения сущности
//   app/game/, rules/,
//   store/                  НЕ затронуты ни одной строкой: партия держит снимок (BR-82)
//
// Сверка с тем, что вышло: `schema.py` получил +37 строк и новое поле (T-128, T-110),
// `app/game/creation.py` — +19/−2 (T-132). Четыре других объявления соблюдены. То есть
// критерий был, предъявим был, и не прочитал его никто: ни `openspec validate`, ни
// `criteria`, ни ревью поставки.
//
// Почему это находка РЕВЬЮ ПОСТАВКИ, а не задачи. Отдельная задача вправе упереться в
// объявленную границу и это обнаружить — тогда решение пересматривают, и D9 правят. Факт
// в том, что границу тронули, а объявление осталось прежним: расходятся они молча, и
// увидеть расхождение можно только на полном диффе.
//
// Что НЕ объявляется находкой. Файл, названный «правится» или «НОВЫЙ», — обычная работа;
// отсутствие блока границ в `design.md` — тоже молчание, а не находка: решение «границы
// не называю» законно (ADR-0009), и ругаться на каждую поставку без D9 значит превратить
// проверку в шум ещё до первой настоящей находки.
// Граница слова здесь НЕ через `\b`, и это не стиль. В JS `\w` — только ASCII, поэтому
// `\bНЕ` требует перед «Н» латинской буквы или цифры: на строке «НЕ меняется» граница не
// возникает вовсе, и правило молчит на всём корпусе. Поймано первым же прогоном по живому
// design.md проект-В — ноль находок там, где их шесть. Отсюда `\p{L}` и флаг `u`.
const FREEZE = /(?:^|[^\p{L}])не\s+(?:меня|затрон|трога|прав)/iu

// Знаки ASCII-дерева. Архитектор рисует состав пакетов именно так — `├── admin.py`, — и
// до 0.4.126 разбор этого не знал: головой строки оказывался глиф `│`, а настоящее имя
// файла уезжало в пояснение. Замер на живом `design.md` проект-В (поставка G-014, 23 записи):
// `path` равен `│` во ВСЕХ, то есть шаг 4 маршрута оставался без машины ровно на той
// форме, которой состав пакетов и объявляется. Цена замерена там же: объявление пакета
// `app/telegram/` лгало четырьмя способами одновременно (два несуществующих имени, шесть
// неназванных модулей, файл в чужом пакете, «пятый файл» при одиннадцати) и дожило до ворот.
//
// Чиним разбор, а не форму записи: форма стоит в живых документах четырёх проектов, и
// менять её дороже, чем читать.
const TREE_GLYPHS = /^[\s│├└┌┬─]*/u

// Головой строки считается ТОЛЬКО перечень путей: имя файла или каталога, возможно
// несколько через запятую. Всё остальное — проза, и она пропускается целиком.
//
// Это второе лечение той же болезни, и без него первое ломает разбор: сняв глифы, мы
// открываем продолжения пояснений («ПЕРЕСМОТРЕНА 04.11.2026 …» на колонке примечания), а
// прежний код складывал такую строку в накопитель перечня и приписывал её следующей
// записи. Кириллица здесь отсеивается сама: `\w` в JS — только ASCII, и имя файла в этих
// документах всегда латиницей.
// Внутренние косые в имени разрешены — корнем блока бывает `web/src/`, и без этого он
// молча не опознавался, а вложенные файлы наследовали префикс ПРЕДЫДУЩЕГО корня: четыре
// границы фронтенда проект-В прочлись как `app/ui`, `app/skins` вместо `web/src/…`. Ошибка
// такого рода хуже отсутствия разбора: путь выглядит настоящим и сверяется с диффом.
const NAME = '[\\w@.+-]+(?:\\/[\\w@.+-]+)*\\/?'
const NAME_LIST = new RegExp(`^(${NAME}(?:\\s*,\\s*${NAME})*),?(?:\\s+(.*))?$`)

// Граница о ЗАВИСИМОСТИ. Отдельный род, и диффом он не проверяется по построению:
// «player.py не зависит от телеграма» — утверждение о графе, а не о наборе строк.
// На G-014 объявление «player.py НЕ меняется ни одной строкой» было выполнено буквально, а
// независимость отменил импорт в соседнем файле (BUG-101). Движок такие границы НАЗЫВАЕТ
// непроверенными — выдавать молчание за «соблюдено» он не вправе (ADR-0007).
const DEPENDS = /(?:^|[^\p{L}])не\s+(?:зависи|импортир)|независим/iu

// ── Условная граница: вердикт, область которого названа тикетами ─────────────
//
// Отчёт проект-В 08.11.2026, дополнение к Д-47. Семь «расхождений» сверки оказались
// артефактами ФОРМЫ объявления, и живой корпус (четыре поставки, шесть архивов) показал,
// что форма эта не редкая, а ГОСПОДСТВУЮЩАЯ в самых содержательных местах:
//
//   screens/admin/**              — НЕ меняется, кроме образца типа в редакторе (T-188)
//   web/src/, app/                НЕ ЗАТРОНУТЫ НИ ОДНОЙ СТРОКОЙ тремя задачами починки
//
// Запрещать такие объявления нельзя: безусловные границы покрывают каталоги целиком, а
// интересные места — всегда с условием, и заменить условие нечем. Понимать прозу движок
// тоже не станет (тот же довод, что у переноса строки в Д-54). Между запретом и пониманием
// есть третий путь, и он машинный: условие обязано НАЗВАТЬ ТИКЕТЫ, и тогда сверка судит
// границу против них, а не против диффа всей поставки.
//
// Два живых смысла, и различаются они одним словом, а не замыслом:
//
//   «кроме … (T-188)»             — ИСКЛЮЧЕНИЕ: правка от T-188 законна, от прочих нет;
//   «не затронуты … (T-365…367)»  — ОБЛАСТЬ: обещание дано про эти задачи, и нарушить его
//                                   может только одна из них; правка от прочих обещания
//                                   не касается вовсе.
//
// Слово-признак исключения — закрытый список («кроме», «за исключением», «помимо»), а не
// разбор смысла. Условие без названных тикетов проверить нечем: это находка, и она говорит,
// чего не хватает — ровно того единственного места у проект-В, где сверка встала бы («тремя
// задачами починки» — число вместо имён).
const COND_EXCEPT = /(?:^|[^\p{L}])(кроме|за\s+исключением|помимо)(?:[^\p{L}]|$)/iu
// Слово, по которому вердикт опознаётся УСЛОВНЫМ, даже когда тикеты не названы. Список
// закрытый и короткий: «кроме», «помимо», «за исключением», «только» и творительный падеж
// «задачами/задачей» — та самая живая форма «НЕ ЗАТРОНУТЫ … ТРЕМЯ ЗАДАЧАМИ ПОЧИНКИ», где
// область названа числом вместо имён. Без этого признака такое объявление читается
// безусловным, и правка названных задач объявляется нарушением общего обещания, которого
// автор не давал.
const COND_WORD = /(?:^|[^\p{L}])(кроме|за\s+исключением|помимо|только|задач(?:ами|ей))(?:[^\p{L}]|$)/iu
const TICKET_IN_TEXT = /\bT-[\w.]+/g

function conditionOf(note) {
  const text = String(note || '')
  if (!COND_WORD.test(text) && !TICKET_IN_TEXT.test(text)) return null
  // Тикеты условия берутся ИЗ САМОГО УСЛОВИЯ, а не из всей строки. Замер на живом
  // `design.md` проект-В 09.11.2026: строка «НЕ ЗАТРОНУТ НИ ОДНОЙ СТРОКОЙ задачами T-412,
  // T-413: счёт запаса и его вход «рисунок» сделаны T-399» давала условию три тикета — и
  // сверка честно находила нарушение «T-399 трогает путь», хотя T-399 упомянута в
  // ПОЯСНЕНИИ, как автор правки прошлой поставки. Ложная находка на ровном месте стоит
  // дороже молчания: шум обесценивает проверку надёжнее, чем её отсутствие.
  //
  // Поэтому область условия — от слова-условия до конца предложения (двоеточие, точка или
  // тире-пояснение), а если слова-условия нет вовсе, то первое предложение строки.
  const m = text.match(COND_WORD)
  const from = m ? text.indexOf(m[0]) : 0
  const scope = text.slice(from).split(/[:.]|\s—\s/)[0]
  const tickets = [...new Set((scope.match(TICKET_IN_TEXT) || []))]
  if (!tickets.length && !COND_WORD.test(text)) return null
  return { kind: COND_EXCEPT.test(text) ? 'except' : 'scoped', tickets }
}

// Разбор блока границ. Формат — дерево с отступами, как его пишет Архитектор: строка,
// кончающаяся на `/`, открывает уровень; строка с именем файла и пояснением — лист;
// запятая в конце означает, что перечень продолжается следующей строкой и пояснение у
// них общее (`app/game/, rules/,` + `store/   НЕ затронуты...`).
// Все объявления блока границ, как они написаны: и «не меняется», и «правится». Второе
// нужно не для сверки, а для вопроса «сколько раз сказано про ОДИН путь»: отчёт проект-В
// 08.11.2026 (пункт F-048) — `design.md` называет экраны итогов дважды с противоречащим
// вердиктом («правится сужением» и «не затронут ни строкой»), и машина читала хвост дерева.
// Два объявления об одном пути с разными вердиктами — находка, проверяемая без всякого
// понимания прозы; решает ПОСЛЕДНЕЕ (так же, как читает человек, и так же, как пересмотр
// границы оформлен в живом документе: «ПЕРЕСМОТРЕНА 03.11.2026 и перенесена сюда»).
export function declaredBoundaries(text) {
  const out = []
  const push = (rec) => {
    out.push(rec)
    return rec
  }
  for (const block of String(text || '').split(/^```.*$/m).filter((_, i) => i % 2 === 1)) {
    const stack = [] // [{ indent, prefix }]
    let group = []   // накопленный перечень без пояснения
    // Перенос пояснения на вторую строку: колонка, с которой пояснение началось, и записи,
    // к которым оно относится. Признак переноса — ВЫРАВНИВАНИЕ: продолжение стоит под
    // пояснением, а не под именем. Отчёт проект-В Д-54 (замер 06.11.2026): строка
    //     │   ├── game.css        ПРАВИТСЯ: разрешение не гасить (D15). Правило
    //     │   │                   .game-console-view .board-viewctl (:420) НЕ ТРОГАЕТСЯ
    // читалась ДВУМЯ записями, и вторая давала границу `web/src/screens/player/.game-console-view`
    // — путь, которого нет нигде. Это родня 0.4.126 (глифы дерева): разбор по-прежнему не
    // отличал продолжение от новой записи, и автор тут не виноват — файл он назвал, просто
    // строка не поместилась. Глиф `─` в отступе отличает настоящую запись от продолжения в
    // деревьях с глифами; в деревьях из одних пробелов решает колонка.
    let cont = null // { col, paths, frozen, note }
    for (const raw of block.split('\n')) {
      if (!raw.trim()) continue
      // Отступ считается ПО КОЛОНКЕ: глифы дерева занимают те же места, что пробелы, и
      // уровень вложенности в них и записан. Отсюда же берётся голова строки.
      const lead = raw.match(TREE_GLYPHS)[0]
      const indent = lead.length
      const body = raw.slice(indent)
      if (cont && indent >= cont.col && !/─/.test(lead)) {
        // Продолжение пояснения. Записям предыдущей строки оно дописывается целиком:
        // человек читает правило, а не его половину.
        for (const rec of cont.paths) rec.why = `${rec.why} ${body.trim()}`.trim()
        // Что здесь намеренно НЕ делается: глагол из переноса не читается как новое
        // объявление. Соблазн был — у проект-В в переносе стоит «правило .board-viewctl
        // (:420) НЕ ТРОГАЕТСЯ», то есть обещание про область ВНУТРИ правимого файла. Такой
        // признак написан и выброшен в тот же час: на первой же оснастке он объявил
        // границей строку «ПЕРЕСМОТРЕНА 04.11.2026: прежнее „НЕ меняется“ было шире» —
        // продолжение, которое говорит про ОТМЕНУ прежнего обещания. Отличить одно от
        // другого значит прочитать замысел из прозы, а это ровно тот род признака, который
        // я считаю дефектом у других. Движок обещает сверять ФАЙЛЫ и сверяет файлы;
        // область внутри файла он называть границей не берётся, и сказано это Архитектору
        // в промпте («граница — путь файла, особенность — пояснением строки»).
        continue
      }
      const m = body.match(NAME_LIST)
      if (!m) continue // проза: продолжение пояснения, заголовок, комментарий
      const head = m[1]
      const note = (m[2] || '').trim()
      // Запятая на конце строки — признак ПРОДОЛЖЕНИЯ перечня, и смотреть его надо на
      // исходной строке: разбор головы её съедает. Без этого `game/, rules/,` открывал
      // уровень с префиксом `app/game/, rules/` вместо того, чтобы лечь в накопитель, и
      // две границы живого `design.md` терялись молча. Поймано прогоном нового разбора по
      // СТАРОМУ корпусу (поставка content-editor: было 8 границ, стало 6).
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      // Префикс уже накопленный: каждая запись стека несёт полный путь своего уровня.
      // Складывать записи между собой нельзя — получится `app/app/ruleset/`.
      const prefix = stack.length ? stack[stack.length - 1].prefix : ''
      const names = head.split(',').map((x) => x.trim()).filter(Boolean)
      const paths = names.map((n) => (prefix + n).replace(/\/+$/, ''))
      if (!note) {
        // Каталог без пояснения либо ОТКРЫВАЕТ УРОВЕНЬ (`ruleset/`), либо продолжает
        // перечень, у которого пояснение будет ниже (`game/, rules/,`). Отличает их
        // запятая, и отдельного признака под это не нужно: с запятой строка не кончается
        // на `/`. Проверено мутацией — флаг `continues` здесь выживал как мёртвый.
        if (/,\s*$/.test(body)) group.push(...paths)
        else if (/\/$/.test(head)) stack.push({ indent, prefix: prefix + head })
        else group.push(...paths)
        continue
      }
      const all = [...group, ...paths]
      group = []
      // Глагол ищется в НАЧАЛЕ пояснения, а не где угодно в нём. Иначе строка
      // «sqlite/store.py правится: … load_snapshot НЕ трогается» объявляется неизменной,
      // хотя сама говорит «правится»: ложная граница даёт ложную находку на ровном месте,
      // а шум обесценивает проверку надёжнее молчания. Замер на четырёх живых design.md —
      // в конце этого файла, тестом.
      const frozen = FREEZE.test(note.slice(0, 48))
      const verdict = frozen ? 'frozen' : (DEPENDS.test(note.slice(0, 64)) ? 'depends' : 'changes')
      const cond = conditionOf(note)
      // Пишем КАЖДОЕ объявление, включая «правится»: без него не ответить на вопрос, сколько
      // раз сказано про один путь. Сверка берёт из этого только своё (`declaredFrozen`).
      const pushed = all.map((p) => push({ path: p, why: note, verdict, ...(cond ? { cond } : {}) }))
      // Запись переноса ведётся и для НЕ объявленных границами строк: продолжение бывает
      // именно у них (случай проект-В — головная строка говорит «ПРАВИТСЯ»).
      cont = { col: indent + body.indexOf(note, head.length), frozen, paths: pushed }
      if (/\/$/.test(head) && !frozen) stack.push({ indent, prefix: prefix + head })
    }
  }
  // Табличная форма — вторая живая запись границ, и до 0.4.135 сверка её не видела вовсе
  // (Д-69, замер Архитектора проект-В 09.11.2026: две строки добавлены в таблицу «Границы,
  // обещанные всей поставкой», а `declared` остался 15). То есть часть объявленных границ не
  // охранялась ничем, и узнать об этом можно было только так, как узнали они — добавив
  // строку и посмотрев на счётчик.
  //
  // Это та же болезнь, что Д-47 (сверка не читала ASCII-дерево): признак требовал ОДНОЙ
  // формы записи, а документ писал человек. Читаются обе; третьей формы не изобретаем —
  // появится, будет видно тем же способом, счётчиком.
  for (const rec of tableBoundaries(text)) out.push(rec)
  return out
}

// Границы, записанные таблицей. Берём строку с двумя и более ячейками, где первая похожа на
// путь (есть `/` или расширение), а остальные несут вердикт и пояснение. Шапку и строку из
// дефисов пропускаем: в них путей нет по определению.
function tableBoundaries(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    if (/^\|[\s|:-]+\|?$/.test(line)) continue // разделитель шапки
    const cells = line.replace(/^\||\|$/g, '').split('|').map((x) => x.trim())
    if (cells.length < 2) continue
    const name = cells[0].replace(/^[`*_]+|[`*_]+$/g, '').trim()
    if (!name || /\s/.test(name)) continue // «Файл», «Путь», фраза — это шапка или проза
    if (!(name.includes('/') || /\.[A-Za-z0-9]+$/.test(name))) continue
    const note = cells.slice(1).join(' — ').trim()
    if (!note) continue
    const frozen = FREEZE.test(note.slice(0, 48))
    const verdict = frozen ? 'frozen' : (DEPENDS.test(note.slice(0, 64)) ? 'depends' : 'changes')
    const cond = conditionOf(note)
    out.push({ path: name.replace(/\/+$/, ''), why: note, verdict, form: 'таблица', ...(cond ? { cond } : {}) })
  }
  return out
}

// Объявления, которые СВЕРКА судит: «не меняется» и «не зависит». Про путь, объявленный
// дважды, берётся ПОСЛЕДНЕЕ объявление — пересмотр границы внутри поставки законен
// (решение человека на воротах, ADR-0009) и в живых документах оформляется именно так.
// Расхождение двух объявлений при этом не прячется: его называет `boundaryFindings`.
export function declaredFrozen(text) {
  const all = declaredBoundaries(text)
  const last = new Map()
  for (const rec of all) last.set(rec.path, rec)
  const out = []
  for (const rec of all) {
    if (last.get(rec.path) !== rec) continue // не последнее объявление этого пути
    if (rec.verdict === 'frozen') out.push({ path: rec.path, why: rec.why, ...(rec.cond ? { cond: rec.cond } : {}) })
    else if (rec.verdict === 'depends') out.push({ path: rec.path, why: rec.why, kind: 'depends', ...(rec.cond ? { cond: rec.cond } : {}) })
  }
  return out
}

// Путь к тех-спеке поставки. Живая лежит рядом с задачами, архивная — там же, куда её
// увёз Техписатель; `tasksDir` уже умеет обе, и повторять правило незачем.
export function designDoc(root, change) {
  const dir = tasksDir(root, change)
  return dir ? join(dirname(dir), 'design.md') : null
}

// Сверка: объявленное неизменным против настоящего диффа поставки.
//
// База — точка ветвления, а не вершина main (`main...feature/<change>`): за время поставки
// в main приезжают чужие слияния, и двухточечный дифф приписал бы поставке их файлы.
// Поставка уже слита (ветки нет) — сверяем от точки ветвления текущей HEAD.
//
// Отказ git трактуется ЗАКРЫТО (И-12): не прочитали дифф — говорим это вслух, а не
// выдаём молчание за «границы соблюдены».
export function boundaryFindings(root, change, config = null, refs = null) {
  if (!change) return []
  const doc = designDoc(root, change)
  let text = null
  try {
    text = readFileSync(doc, 'utf8')
  } catch {
    text = null
  }
  // Тех-спеки нет или границы в ней не названы — молчим. Решение «границы не называю»
  // законно (ADR-0009), и находка на каждой поставке без блока границ была бы шумом
  // раньше первой настоящей находки.
  if (text === null) return []
  const frozen = declaredFrozen(text)
  if (!frozen.length) return []
  const cfg = config || readConfig(root) || {}
  // Пара ссылок берётся из настройки, но её можно назвать и руками: закрытую поставку
  // перепроверяют по её точке ветвления и коммиту слияния, ветки под неё уже нет.
  const target = (refs && refs.base) || (cfg.vcs && cfg.vcs.target_branch) || 'main'
  const branch = (refs && refs.branch) ||
    (gitLine(root, ['rev-parse', '--verify', '--quiet', `feature/${change}`]) ? `feature/${change}` : 'HEAD')
  const raw = gitLine(root, ['diff', '--name-only', `${target}...${branch}`])
  if (raw === null) {
    return [
      `границы модулей в «${doc.slice(root.length + 1)}» объявлены (${frozen.length}), а дифф ` +
      `поставки (${target}...${branch}) прочитать не удалось — сверка НЕ выполнена, и молчание ` +
      `тут значит «не знаю», а не «соблюдено» (И-12)`,
    ]
  }
  const files = raw.split('\n').map((x) => x.trim()).filter(Boolean)
  const out = []
  // Граница, названная путём, которого в ветке-цели НЕТ, не проверяется ничем и проходит
  // всегда: сверка ищет совпадение в списке изменённых файлов, а с чем совпадать — нечего.
  // Замер на живых поставках (53 объявленные границы четырёх проектов): таких 2 —
  // `web/src/screens/player/.game-console-view` (это селектор CSS, а не файл) и
  // `web/src/board/coinMark.tsx` (файла нет вовсе). Обе прошли ворота со словами
  // «findings: []», то есть обещание было принято, не будучи проверено ни разу.
  //
  // Это тот же род, что `kind: depends`: граница, которую диффом не проверить, обязана
  // быть НАЗВАНА, а не молча зачтена (И-12 — молчание значит «не знаю», а не «соблюдено»).
  // Шума признак не даёт: 2 из 53, и обе находки настоящие.
  for (const f of frozen) {
    const exists = gitLine(root, ['cat-file', '-e', `${target}:${f.path}`]) !== null ||
      existsSync(join(root, f.path))
    if (!exists) {
      out.push(
        `граница «${f.path}» объявлена в тех-спеке («${f.why.slice(0, 60)}»), но такого пути в ` +
        `${target} нет — сверить её диффом НЕЧЕМ, и молчание сверки тут значит «не проверено», ` +
        `а не «соблюдено» (И-12). Если это селектор, класс или область внутри файла — назовите ` +
        `файл: границу проверяет дифф, а он знает только файлы`,
      )
    }
  }
  // Границы, которые дифф проверить НЕ МОЖЕТ по построению, судит человек, и назвать их
  // обязательно: до 06.11.2026 они шли в ту же сверку, что обычные, и давали находку со
  // ЧУЖИМ словом — «объявлен неизменным, а дифф его трогает» про файл, который сам себя
  // объявил правящимся. Это не просто неверная формулировка: такую находку нельзя снять,
  // не соврав, а находку, которую нельзя снять честно, снимают молчанием.
  for (const f of frozen) {
    if (f.kind !== 'depends') continue
    out.push(
      `граница «${f.path}» объявлена как НЕЗАВИСИМОСТЬ («${f.why.slice(0, 70)}») — это ` +
      `утверждение о графе вызовов, а не о наборе строк, и диффом оно не проверяется ` +
      `никак. Сверка его НЕ выполняла: судит ревью поставки (графом, codegraph fn-impact), ` +
      `и молчание тут значило бы «соблюдено» (И-12)`,
    )
  }
  // ── Один путь объявлен дважды с разными вердиктами ────────────────────────
  //
  // Отчёт проект-В 08.11.2026, F-048: `design.md` называет экраны итогов дважды —
  // «правится сужением» и «не затронут ни строкой», — и машина читала то, что стоит ниже.
  // Пересмотр границы внутри поставки ЗАКОНЕН (решение человека на воротах) и в живом
  // документе оформляется прямо: «граница ПЕРЕСМОТРЕНА 03.11.2026 и перенесена сюда».
  // Незаконно другое — оставить два вердикта об одном пути и молчать: читатель возьмёт тот,
  // на который наткнётся, а сверка — последний. Поэтому последнее объявление решает (так
  // читает и человек), а расхождение называется.
  {
    const byPath = new Map()
    for (const rec of declaredBoundaries(text)) {
      if (!byPath.has(rec.path)) byPath.set(rec.path, [])
      byPath.get(rec.path).push(rec)
    }
    for (const [path, recs] of byPath) {
      if (recs.length < 2) continue
      const verdicts = [...new Set(recs.map((r) => r.verdict))]
      if (verdicts.length < 2) continue
      const last = recs[recs.length - 1]
      // Условное объявление, стоящее последним, прежнее НЕ ОПРОВЕРГАЕТ, а сужает: «правится»
      // про весь дифф поставки и «не затронут задачами T-412, T-413» — два разных
      // утверждения, и оба могут быть верны. Замер на живом `design.md` проект-В 09.11.2026:
      // из трёх «разных вердиктов» все три были этой парой, то есть находка была бы шумом на
      // ровном месте — а Архитектор именно так и обязан писать границу задачи (Д-69).
      // Судит такую границу не эта находка, а сверка по названным тикетам ниже.
      if (last.cond && last.cond.tickets && last.cond.tickets.length) continue
      const say = (r) => `«${r.why.slice(0, 50)}» (${r.verdict === 'frozen' ? 'не меняется' : r.verdict === 'depends' ? 'независимость' : 'правится'})`
      out.push(
        `о пути «${path}» в тех-спеке сказано ${recs.length} раза, и вердикты РАЗНЫЕ: ` +
        `${recs.map(say).join(' → ')}. Сверка взяла ПОСЛЕДНЕЕ (${last.verdict === 'frozen' ? 'не меняется' : last.verdict === 'depends' ? 'независимость' : 'правится'}), ` +
        `потому что так читает и человек, и так же оформляется законный пересмотр границы. ` +
        `Но два живых вердикта об одном пути — это карта, по которой нельзя резать следующую ` +
        `поставку: либо снимите прежнее объявление, либо назовите его пересмотренным`,
      )
    }
  }
  for (const f of frozen) {
    if (f.kind) continue
    const hit = files.filter((x) => x === f.path || x.startsWith(`${f.path}/`))
    if (!hit.length) continue
    // Кто именно тронул — из сообщений коммитов: номер задачи в них уже есть (`feat(T-128)`),
    // и без него находка заставляет человека искать виновника руками.
    const log = gitLine(root, ['log', '--format=%s', `${target}..${branch}`, '--', f.path]) || ''
    const who = [...new Set([...log.matchAll(/\bT-[\w.]+/g)].map((m) => m[0]))]
    const where = `${hit.slice(0, 4).join(', ')}${hit.length > 4 ? ` и ещё ${hit.length - 4}` : ''}`
    // ── Условная граница судится против НАЗВАННЫХ тикетов ───────────────────
    if (f.cond) {
      if (!f.cond.tickets.length) {
        out.push(
          `граница «${f.path}» объявлена С УСЛОВИЕМ («${f.why.slice(0, 70)}»), но условие не ` +
          `называет ни одного тикета — проверить его нечем, и дифф поставки тут не ответ: он ` +
          `трогает ${where}, а обещание дано не про всю поставку. Назовите тикеты в скобках ` +
          `(«кроме образца типа в редакторе (T-188)»): тогда сверка судит границу против них, ` +
          `а не против всех задач. Число вместо имён («тремя задачами починки») не годится`,
        )
        continue
      }
      if (!who.length) {
        out.push(
          `граница «${f.path}» условна и названа тикетами (${f.cond.tickets.join(', ')}), но ` +
          `установить, КАКАЯ задача тронула ${where}, не удалось: в сообщениях коммитов номера ` +
          `задач нет. Сверка условия НЕ выполнена — молчание тут значило бы «соблюдено» (И-12)`,
        )
        continue
      }
      const named = new Set(f.cond.tickets)
      if (f.cond.kind === 'except') {
        // «не меняется, КРОМЕ … (T-188)»: правка от названного тикета законна, от прочих нет.
        const strangers = who.filter((t) => !named.has(t))
        if (!strangers.length) continue
        out.push(
          `${f.path} объявлен неизменным, кроме названного исключения (${f.cond.tickets.join(', ')}), ` +
          `а трогают его ЕЩЁ и другие задачи: ${strangers.join(', ')} (${where}). Исключение ` +
          `названо одно, правок больше — либо исключение надо расширить, либо правка вышла за границу`,
        )
        continue
      }
      // Обещание дано ПРО названные задачи («не затронуты … (T-365, T-366)»): нарушить его
      // может только одна из них, правка от прочих обещания не касается.
      const breakers = who.filter((t) => named.has(t))
      if (!breakers.length) continue
      out.push(
        `${f.path} объявлен неизменным для задач ${f.cond.tickets.join(', ')} («${f.why.slice(0, 70)}»), ` +
        `и ровно они его трогают: ${breakers.join(', ')} (${where}). Обещание нарушено своей же ` +
        `областью — либо правка вышла за границу, либо объявление пора переписать`,
      )
      continue
    }
    out.push(
      `${f.path} объявлен неизменным в тех-спеке («${f.why.slice(0, 70)}»), а дифф поставки его ` +
      `трогает: ${where}` +
      `${who.length ? ` (${who.join(', ')})` : ''}. Либо правка вышла за объявленную границу, ` +
      `либо решение пересмотрели и забыли переписать тех-спеку — расходятся они молча, и ` +
      `следующая поставка будет резаться по неверной карте`,
    )
  }
  return out
}

// ── Нарезка: сценарий, закрытый двумя задачами без границы между ними ─────────
//
// Дефект Q поставки проект-В 3.2 (23.10.2026). Выгрузка сущности файлом написана ДВАЖДЫ
// независимо: `T-113` отвечала за способность, `T-116` реализовала её же заново в каркасе
// раздела. Нарезку делает Архитектор на планировании, и проверить её движку было нечем:
// `criteria` умел сказать «у задачи нет критериев», но не «этот сценарий закрыт двумя
// задачами». Сами задачи при этом ссылались на одно и то же требование спек-дельты —
// то есть след дефекта лежал в файлах задач, просто никто его не сверял.
//
// Что НЕ находка, и это главное решение здесь. Отчёт по дефекту предлагал считать
// находкой сам факт: «один сценарий спеки, названный в двух файлах задач». Замер той же
// поставки показал, что предложение неверно: требование названо двумя-тремя задачами в
// 11 случаях из 26, и почти все законны — серверная часть и экран, каркас и формы,
// способность и органы, которые её предъявляют. Проверка, срабатывающая на 11 группах из
// 11, не отличается от молчания (тот же довод, что у единицы измерения в DECIMAL).
//
// Находка — ОТСУТСТВИЕ ГРАНИЦЫ между двумя задачами, делящими требование. Граница
// предъявима двумя способами, и оба уже в языке движка:
//   1. `depends_on` — одна задача объявила другую условием: порядок назван;
//   2. имя задачи В ТЕКСТЕ — «органы на экранах ставят `T-118`, `T-119`, `T-120`»
//      (настоящая строка `T-113`), «признак живёт в формах сущностей (`T-119`)»
//      (настоящая строка `T-116`). Это и есть то, чего между `T-113` и `T-116` не было
//      ни в одну сторону — и ровно это место разошлось.
//
// Замер на состоянии ВОРОТ (коммит плана `6d2452f`, до правок стадий): 11 групп общих
// требований, находок 3 — `T-113`+`T-116` (настоящий дефект), `T-128`+`T-131` (сервер и
// блок ввода текстов под скины) и `T-125` против `T-112`/`T-116` (словарь подписей против
// каркаса раздела). Две последние — законные разрезы без названной границы, то есть
// вопрос на одну строку ответа, а не переделка. Трёх вопросов на воротах против
// написанной дважды выгрузки — обмен, который стоит делать.
//
// Ссылка на требование берётся из текста задачи, а не из спеки: сверять с `specs/`
// нечем — дельта живёт в дереве груминга, а задача может прийти оттуда же, и
// рассогласование имён дало бы находку на ровном месте. Формат — `требование «…»` и
// `требования «…», «…»`, как пишет шаблон задачи и как пишут все 24 задачи замера.
const REQ_REF = /требовани[ея]\s+((?:«[^»]{3,160}»\s*(?:,|и)?\s*)+)/g

export function requirementRefs(body) {
  const out = new Set()
  for (const m of String(body || '').matchAll(REQ_REF)) {
    for (const q of m[1].matchAll(/«([^»]{3,160})»/g)) out.add(q[1].replace(/\s+/g, ' ').trim())
  }
  return [...out]
}

export function sliceFindings(root, change) {
  if (!change) return []
  const tasks = listTasks(root, change).map((t) => ({
    id: t.id,
    depends_on: t.depends_on || [],
    reqs: requirementRefs(t.body),
    // Имена задач, названные в тексте. Своё имя отсюда не вычищается, и это не упущение:
    // граница сверяется между РАЗНЫМИ задачами, поэтому ссылка задачи на свой же файл
    // проверки ничего не отменяет. Проверено мутацией: фильтр `x !== t.id` выживал.
    names: new Set([...String(t.body || '').matchAll(/\bT-[\w.]+/g)].map((m) => m[0])),
  }))
  const byReq = new Map()
  for (const t of tasks) {
    for (const r of t.reqs) {
      if (!byReq.has(r)) byReq.set(r, [])
      byReq.get(r).push(t)
    }
  }
  const fenced = (a, b) => a.depends_on.includes(b.id) || b.depends_on.includes(a.id) ||
    a.names.has(b.id) || b.names.has(a.id)
  const out = []
  for (const [req, group] of byReq) {
    // Отдельной проверки `group.length < 2` здесь нет: у одиночной группы пар не
    // образуется, и выход даёт следующая строка. Мутация с `< 1` выживала — значит
    // проверка была не границей, а её видимостью.
    const pairs = []
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!fenced(group[i], group[j])) pairs.push(`${group[i].id} и ${group[j].id}`)
      }
    }
    if (!pairs.length) continue
    out.push(
      `требование «${req.slice(0, 80)}» закрывают ${group.map((t) => t.id).join(', ')}, ` +
      `а границы между ${pairs.join(', ')} нет: ни depends_on, ни строки «что делает другая». ` +
      `Либо назвать границу словами в тексте задачи, либо объявить порядок — иначе один ` +
      `сценарий будет написан дважды независимо (случай проект-В 3.2: выгрузка сущности файлом ` +
      `в T-113 и T-116)`,
    )
  }
  return out
}

// Один и тот же номер в двух ЖИВЫХ поставках — дефект: журнал склеит их стадии.
// Совпадение с архивом сюда не попадает: архив закрыт, новых событий не будет.
//
// МЕСТО, НАЗВАННОЕ НОМЕРОМ, — это карточка задачи, и только она. `journal` и `.firm/ids`
// исключены по одному доводу: это записи О номере, а не предметы, им названные. Событие,
// упомянувшее тикет, вторым называнием не является — и бронь ровно того же класса.
//
// Д-75 (отчёт проект-В 10.11.2026, предпусковая проверка четвёртого прогона G-020). Бронь
// исключена не была, и штатный исход СВОЕЙ ЖЕ команды давал `doctor ok: false`: `T-414` —
// замена исчерпавшей попытки `T-404`, номер взят через `next-id --claim`, карточка им
// названа, и вот уже `duplicate_ids` называет «дубль» с местами `[…/tasks, .firm/ids]`.
// Выхода у проекта не было: `--release` на названном номере правильно отказывает (бронь —
// последнее, что помнит о занятости), а снести файл брони руками значит обойти защиту.
//
// Какая из двух веток ошибалась, сказал их же замер, и это главное в находке: условие
// выполнялось у 40 номеров (1 задача + 39 багов), а названа была одна задача — потому что
// багов `duplicateIds` не перебирает вовсе. Молчащая ветка месяц работала на живых данных
// и ни разу не помешала; значит ошибка в задачной, а не в молчании багов. Правило с двумя
// ответами на один вопрос всегда разрешается в сторону той ветки, которая выдержала живые
// данные (та же фигура, что в Д-74).
export function duplicateIds(root) {
  const { tasks } = usedIds(root)
  const out = []
  for (const [id, where] of tasks) {
    const live = where.filter(
      (w) => w !== 'journal' && w !== '.firm/ids' && !w.includes(`${sep}archive${sep}`),
    )
    if (live.length > 1) out.push({ id, where: live })
  }
  return out
}

// ── Что сейчас «в полёте» ─────────────────────────────────────────────────────
//
// Задача считается в полёте, пока её ветка `task/T-XXX` существует и ещё не влита в
// текущую. Это нужно ровно для одного: не писать в файл задачи ГЛАВНОГО дерева, пока
// ту же строку правит стадия в своём worktree.
//
// Почему это несущая проверка, а не предосторожность. Файл задачи правят двое: движок
// (кэш `status:` и галочки критериев) — в главном дереве, и сама стадия (протокол,
// отметки выполненного) — у себя. Слияние после этого встаёт с «Your local changes to
// the following files would be overwritten by merge», и так на КАЖДОЙ задаче: на пилоте
// 23.09.2026 не всплывало только потому, что стадии успевали закоммитить раньше, а на
// T-105 не успели. Статус — производный кэш (ADR-0001), и отложить его запись до слияния
// ничего не стоит: `post-merge` зовёт `sync` сразу после мержа.
//
// Git недоступен или ответил ошибкой — считаем задачу в полёте. Пропущенная строчка
// кэша восстанавливается следующим `sync`, а сорванное слияние человек разбирает руками.
export function inFlightTickets(root) {
  // «В полёте» = по задаче есть РАБОЧЕЕ ДЕРЕВО. Ничего другого спрашивать не надо: мы
  // защищаем файл задачи от правки в главном дереве, пока над ним работает стадия в своём,
  // а живёт стадия ровно в рабочем дереве. Дерево убирают последним шагом слияния — значит
  // его наличие и есть ответ.
  //
  // До 01.10.2026 здесь стоял `merge-base --is-ancestor task/T-XXX HEAD`, то есть смысловой
  // двойник `git branch --merged`, запрещённого ADR-0005 «нигде — ни в коде, ни в промптах».
  // И он врал ровно так же: ветку задачи заводят на вершине поставки, поэтому ПОКА СТАДИЯ
  // НЕ СДЕЛАЛА КОММИТ, задача считалась влитой и «не в полёте». То есть защита отключалась
  // именно в тот момент, ради которого написана: движок правил файл задачи в главном дереве,
  // а дальше слияние падало с «Your local changes would be overwritten by merge» (случай
  // T-105, под который в промпте слияния до сих пор лежит обходной `stash push`).
  //
  // Отказ git трактуется ЗАКРЫТО (И-12): не смогли узнать — считаем в полёте ВСЁ, то есть
  // ничего не правим. Прежний код возвращал пустое множество, то есть «в полёте никого», и
  // в песочнице с закрытым каталогом движок пошёл бы править файлы всех задач сразу —
  // прямая инверсия того, что требует ADR-0007. Прежний комментарий обещал как раз
  // правильное поведение, а код делал обратное.
  const trees = listWorktrees(root)
  // Пустой список означает именно отказ git: в рабочем репозитории `worktree list` всегда
  // перечисляет хотя бы главное дерево. Значит `null` здесь — честное «не знаю».
  if (!trees.length) return null
  const out = new Set()
  for (const w of trees) {
    const id = w.branch && w.branch.startsWith('task/') ? w.branch.slice(5) : null
    if (id) out.add(id)
  }
  return out
}

// ── Worktree (§9) ─────────────────────────────────────────────────────────────

export function worktreesDir(root, config) {
  const fromConfig = config && config.worktrees_dir
  if (fromConfig) return resolve(root, String(fromConfig))
  return resolve(dirname(root), `${basename(root)}.worktrees`)
}

export function listWorktrees(root) {
  let out = ''
  try {
    out = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  } catch {
    return []
  }
  const res = []
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).trim(), branch: null }
      res.push(cur)
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7).trim().replace('refs/heads/', '')
    }
  }
  return res
}

export function ticketFromBranch(branch) {
  if (!branch) return null
  const m = String(branch).match(/(?:^|\/)(T-[\w.]+)$/)
  return m ? m[1] : null
}

// Каноническое содержимое расписки об отправке — то, по чему считается `digest` (ADR-0014).
// Порядок полей фиксирован и менять его нельзя: сменишь — и все прежние цепочки разойдутся,
// то есть `doctor` объявит подделкой весь честный журнал.
//
// Живёт здесь, а не в `egress.mjs`, по той же причине, по которой `preflight` запрещает
// импортировать CLI: `egress.mjs` зовёт `main()` на верхнем уровне, и импорт его из
// `firm-event.mjs` ради одной функции означал бы, что `doctor` при старте читает stdin и
// пишет расписку. Поймано при реализации 21.10.2026 — зависанием на первом же запуске.
export function receiptDigest(r) {
  const canon = [r.prev || '', r.ts || '', r.ticket || '', r.sink || '', r.host || '', r.ref || '', r.tree || ''].join('\n')
  return createHash('sha256').update(canon).digest('hex').slice(0, 12)
}

// ── Отпечаток содержимого: чем удостоверяется вердикт (ADR-0013) ──────────────
//
// Вердикт ревью отвечал на вопрос «какую ЗАДАЧУ приняли» и не отвечал на вопрос «какое
// СОДЕРЖИМОЕ приняли». Между `accepted` и слиянием ветка задачи уезжает законными
// способами — следующая попытка, правка руками, `commit --amend`, — и движок этого не
// замечал ничем: ADR-0005 проверяет, что влили именно эту ВЕТКУ, а не что в ней лежало то
// же, что судило ревью.
//
// Отпечаток берём у ДЕРЕВА, а не у коммита, и это существо решения. Переписанная история
// с тем же содержимым (rebase, amend, переподписанный коммит) расписку не протухает —
// судили содержимое; одна изменённая строка протухает её в любом коммите.
//
// Длина 12 знаков — столько же, сколько git печатает в `--abbrev-commit` на больших
// репозиториях; короткий `git_sha` (7) рядом в том же событии отвечает на другой вопрос —
// «где стоял репозиторий», а не «что судили».
const TREE_LEN = 12

function gitOne(root, argv) {
  try {
    return execFileSync('git', ['-C', root, ...argv], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

// Отпечаток вершины ветки задачи. `null` — честное «не знаю»: ветки нет, репозитория нет,
// git отказал. Молчание здесь правильнее выдумки (И-12): по пустому отпечатку сверка не
// срабатывает вовсе, а по выдуманному — срабатывает неверно.
export function taskTree(root, ticket) {
  if (!root || !isBoundTicket(ticket)) return null
  const t = gitOne(root, ['rev-parse', `task/${ticket}^{tree}`])
  return t && /^[0-9a-f]{7,}$/.test(t) ? t.slice(0, TREE_LEN) : null
}

export function treeOfCommit(root, sha) {
  if (!root || !sha) return null
  const t = gitOne(root, ['rev-parse', `${sha}^{tree}`])
  return t && /^[0-9a-f]{7,}$/.test(t) ? t.slice(0, TREE_LEN) : null
}

// Чем задача принята и под каким отпечатком. Принятием считаются три исхода, и это не
// расширение смысла, а перечисление всех путей, которыми задача доходит до слияния:
// вердикт ревью, вердикт Архитектора по расхождению панели и короткая полоса (принятие
// БЕЗ стадии ревью — без неё правило имело бы ровно одну дыру, и именно ту, через
// которую проходит самый быстрый путь в поставку).
//
// Берём ПОСЛЕДНЕЕ по времени: вторая попытка судит содержимое заново, и расписка первой
// к слиянию отношения уже не имеет.
export function acceptedReceipt(events, ticket) {
  if (!Array.isArray(events) || !isBoundTicket(ticket)) return null
  const mine = events.filter(
    (e) =>
      !e._broken && !e._corrected && e.ticket === ticket &&
      ((e.stage === 'review' && e.event === 'accepted') ||
        (e.stage === 'adjudicate' && e.event === 'accepted') ||
        (e.stage === 'guard' && e.event === 'short-lane')),
  )
  if (!mine.length) return null
  mine.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
  const e = mine[mine.length - 1]
  return {
    tree: e.tree || null, stage: e.stage, event: e.event, ts: e.ts || null, file: e._file || null,
    // Поставка нужна сторожу расписки, чтобы отделить свою работу ветки от подтянутого
    // основания (Д-64): без неё остаётся один общий список, пугающий числом.
    change: e.change || null,
  }
}

// Расхождение расписки, разделённое на своё и подтянутое (Д-64, отчёт проект-В 09.11.2026).
//
// Отпечаток берётся у ДЕРЕВА целиком, поэтому отказ сторожа называл всё, что изменилось в
// ветке после вердикта: 249 файлов и +10 839 строк, из которых почти всё — восемь уже
// отсуженных и влитых задач плюс журнал событий, а своей рукой написано двадцать строк в
// одном файле. Сторож был ПРАВ (содержимое изменилось, и вливать непросмотренное нельзя), но
// первое движение читателя при виде 249 файлов неверное: выглядит как «переписана половина
// поставки», а судить надо один файл. Разделять приходилось руками.
//
// Работа эта у движка уже написана — `taskDiff` отделяет работу ветки от подтянутого
// основания трёхточечным диапазоном, — и здесь используется тот же вопрос: файл, которого
// нет в диффе ветки против точки ветвления, в ветку ПРИШЁЛ, а не написан в ней.
export function staleReviewSplit(root, ticket, fromTree, change = null) {
  if (!root || !isBoundTicket(ticket) || !fromTree) return null
  const changed = gitLine(root, ['diff', '--name-only', fromTree, `task/${ticket}^{tree}`])
  if (changed === null) return null
  const all = changed.split('\n').map((x) => x.trim()).filter(Boolean)
  const ch = change || activeChange(root)
  const ownRaw = ch ? gitLine(root, ['diff', '--name-only', `feature/${ch}...task/${ticket}`]) : null
  if (ownRaw === null) {
    // Разделить не удалось — говорим это прямо, а не выдаём общий список за свой (И-12).
    return {
      change: ch || null,
      files: all,
      own: null,
      pulled: null,
      why: ch
        ? `дифф feature/${ch}...task/${ticket} не читается — разделить своё и подтянутое нечем`
        : 'активная поставка не определена — разделить своё и подтянутое нечем',
    }
  }
  const own = new Set(ownRaw.split('\n').map((x) => x.trim()).filter(Boolean))
  return {
    change: ch,
    files: all,
    own: all.filter((f) => own.has(f)),
    pulled: all.filter((f) => !own.has(f)),
    why: null,
  }
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function fileMtime(p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

// ── Критерии приёмки: проверяемы ли они вообще ────────────────────────────────
//
// Разбор поставки 3.1 на проект-В 11.10.2026. Поставка трогала ТОЛЬКО интерфейс: 605 строк
// продуктового кода против 8530 строк проверок (14:1). День стоил 10 ч 59 м машинного
// времени, и 1 ч 20 м из них не дали ни строки кода — две стадии dev кончились
// эскалацией, обе на критериях, которые нельзя было проверить:
//
//   T-086: «чип имени при 20 широких знаках = 199,03 px» — число посчитано арифметикой на
//          планировании, живой прогон дал 278,89. Схема задачи развалилась на стадии dev.
//   T-082: критерий требовал замерить состояние, которое НЕ НАСТУПАЕТ нигде (`min-content`
//          колонки равен уже нарисованной карте). Код был зелёный, непроверяем был критерий.
//
// Отсюда две находки, и они закрывают разные половины. Эта — механическая: дробное число
// в критерии без названного источника замера. Вторую (механизм, которого не бывает)
// регулярка не увидит никогда, её закрывает правило промпта «на планировании мерить
// прогоном, а не считать».
//
// Почему именно ДРОБНОЕ число С ЕДИНИЦЕЙ. Целое в критерии бывает правилом продукта
// («20 знаков имени» — это BR-16) или допуском («≤ 1 px»), и жаловаться на него значило
// бы залить находку шумом — а шум убивает сигнал надёжнее молчания. Дробное число
// правилом продукта не бывает: 1125,54 px — всегда результат вычисления вёрстки.
//
// Единица обязательна, и это не украшение образца: без неё первый же прогон по живому
// проекту выдал восемь находок из восьми, и все восемь — на слове «граница объёма 3.1»,
// то есть на НОМЕРЕ ПОСТАВКИ. Проверка, которая срабатывает всегда, не отличается от
// проверки, которая молчит всегда.
const DECIMAL = /\d+[.,]\d+\s*(?:px|пикс(?:ел\w*)?|rem|em|pt)\b/i

// Кванторный оборот в критерии: «ни один», «каждый», «все», «любой». Ищется с границей
// слева, потому что `\b` на кириллице в JS не работает вовсе (проверено на И-7: класс
// \w ASCII-only, и граница слова находится не там, где кажется).
const QUANTIFIER = /(?:^|[^A-Za-zА-Яа-яЁё0-9])(ни одного|ни одна|ни один|ни одно|каждый|каждая|каждое|каждого|всякий|всякая|любой|любая|любое|все|всех)(?![A-Za-zА-Яа-яЁё])/i

// Назвал ли критерий множество В СЕБЕ: путь с расширением, имя в обратных кавычках или
// число. Это и есть граница находки: квантор над названным множеством проверяем чтением
// самого критерия, квантор над неназванным — нет, и добирать его будет стадия, грепом.
const NAMES_SET = /[\w.@-]+\/[\w./@-]+|`[^`]+`|\d/

// НОМЕР ССЫЛКИ МНОЖЕСТВА НЕ НАЗЫВАЕТ. Поправка 10.11.2026, в день выпуска сторожа, по
// замеру проект-В: `NAMES_SET` принимает любую цифру, а в том проекте критерий по соглашению
// начинается ссылкой на правило — `BR-241: ни один из четырёх файлов…`, — и цифра номера
// глушила находку. Замер по 49 карточкам поставки: квантованных критериев 75, находками
// стали 29, а должны были 59; из тридцати пропущенных ВСЕ заглушены только номером
// ссылки. Слепое пятно не случайное: оно ровно там, где проект дисциплинирован ссылками.
//
// Снимаем ссылки ДО вопроса, а не усложняем сам вопрос: альтернатива — третья ветка в
// регулярке, которая должна была бы отличать «цифру не из номера», и читать её стало бы
// нельзя. Прочие цифры остаются называнием множества намеренно: «ни один из 4 файлов»
// перечень называет числом элементов, и это вторая сторона замера (у проект-В — 16
// критериев, которые обязаны молчать как раньше).
const REF_ID = /(?:BR|ADR|T|BUG|F|E|D|G|MR)-\d+/g


// КРИТЕРИЙ — ЛОГИЧЕСКАЯ СТРОКА, А НЕ ФИЗИЧЕСКАЯ. Продолжения переноса приклеиваются к
// своему пункту (поправка 10.11.2026 по второй находке проект-В того же дня). До неё
// продолжения выбрасывались, и следствий было два: находка зависела от того, где автор
// нажал Enter — путь, стоящий на второй строке, читался как «множество не названо», а
// цифра, попавшая на первую, как названное, — и цитаты в находках рвались на полуслове
// («ни один не остался зелёным «пото»).
//
// Продолжение опознаётся отступом: `  ещё текст` после пункта. Строка без отступа пункт
// закрывает — иначе склеился бы весь абзац под списком.
export function criteriaLines(body) {
  const out = []
  let open = false
  for (const raw of String(body || '').split('\n')) {
    if (/^\s*-\s*\[[ xX]\]/.test(raw)) {
      out.push(raw.replace(/^\s*-\s*\[[ xX]\]\s*/, '').trim())
      open = true
      continue
    }
    if (open && /^\s{2,}\S/.test(raw)) {
      out[out.length - 1] = `${out[out.length - 1]} ${raw.trim()}`.trim()
      continue
    }
    open = false
  }
  return out
}

export function criteriaFindings(root, change, config = null) {
  const cfg = config || readConfig(root) || {}
  const out = []
  const tasks = listTasks(root, change)
  for (const t of tasks) {
    const numeric = criteriaLines(t.body).filter((l) => DECIMAL.test(l))
    if (!numeric.length || t.measured) continue
    out.push(
      `${t.id}: критерий назван вычисленным числом, а чем мерили — не сказано: «${
        numeric[0].slice(0, 90)
      }»${numeric.length > 1 ? ` (и ещё ${numeric.length - 1})` : ''}. Либо переписать свойством ` +
      `(«не меньше, чем при 1024»), либо поставить measured: <чем и когда мерили> — число ` +
      `из арифметики проверить нечем, и стадия встанет на нём, а не на коде`,
    )
  }
  // КВАНТОР БЕЗ МНОЖЕСТВА. Находка 10.11.2026 по разбору T-374 на проект-В (предложение, не
  // дефект: движок правил не нарушал — такого правила у него не было). Критерий «ни один
  // тест экрана не покраснел» выглядит проверяемым и им не является: множество «тесты
  // экрана» в карточке не перечислено, поэтому исполнитель не может ЗНАТЬ, когда он
  // закончил, и каждый заход добирает инвентарь своим признаком. На той карточке
  // `criteria --json` дал `findings: []` — и честно: ни числа, ни битой ссылки BR, ни
  // пересечения с соседним тикетом в ней не было, а признака «квантор без множества» не
  // было у движка.
  //
  // Это НАХОДКА, а не запрет (ADR-0009): проект вправе оставить квантор открытым, но
  // пусть это будет решением, а не умолчанием. Сказано на воротах планирования — то есть
  // в единственный момент, когда критерий ещё правится текстом, а не стадией, встающей
  // на нём.
  for (const t of tasks) {
    if (t.inventory && t.inventory.length) continue
    const open = criteriaLines(t.body).filter(
      (l) => QUANTIFIER.test(l) && !NAMES_SET.test(l.replace(REF_ID, '')),
    )
    if (!open.length) continue
    out.push(
      `${t.id}: критерий квантован по множеству, которого карточка не называет: «${
        open[0].slice(0, 90)
      }»${open.length > 1 ? ` (и ещё ${open.length - 1})` : ''}. Либо перечислить множество ` +
      `поимённо в inventory, либо назвать его в самом критерии (путь, шаблон имён) — иначе ` +
      `исполнитель не может знать, когда закончил, и каждый заход доберёт перечень своим ` +
      `грепом (замер проект-В 10.11.2026: три задачи отклонены за самодельный признак ` +
      `инвентаря, две исчерпали по три попытки). Запрета нет: открытый квантор — решение, ` +
      `но решение человека`,
    )
  }
  // Общий стенд браузерной проверки. Движок его НЕ пишет: он знает про стек и экраны
  // проекта, а движок ведёт проекты с разными стеками. Движку принадлежит указатель
  // (ключ конфига) и правило: две и более браузерные задачи без общего стенда — это
  // не экономия, а тридцать копий обвязки. Замер проект-В: 30 проверок, 12 010 строк,
  // ноль импортов общего модуля — и один из тридцати положил профиль Chrome внутрь
  // репозитория, что и уехало в коммит соседней задачи (Д-5).
  const browser = tasks.filter((t) => t.labels.includes('требует-браузера'))
  const harness = cfg.browser_harness ? String(cfg.browser_harness) : null
  if (harness && !existsSync(resolve(root, harness))) {
    out.push(`browser_harness в .firm/config указывает на «${harness}», а файла нет — стенд либо не завели, либо переименовали`)
  } else if (!harness && browser.length >= 2) {
    out.push(
      `задач с меткой «требует-браузера» — ${browser.length} (${browser.map((t) => t.id).join(', ')}), ` +
      `а общего стенда нет: ключ browser_harness в .firm/config не назван. Без него каждая задача ` +
      `пишет обвязку заново (на проект-В 30 проверок и 12 010 строк, из них ~400 строк на задачу — ` +
      `одна обвязка). Стенд — ПЕРВАЯ задача поставки, остальные браузерные зависят от неё`,
    )
  }
  // Бинарь браузера. Названный, но отсутствующий — обещание конфига, за которым никто не
  // следит: стадия получит путь в промпте, пойдёт по нему и упрётся. Путь абсолютный
  // (бинарь машинный, вне репозитория), поэтому `resolve` от корня здесь не нужен.
  //
  // ОТСУТСТВИЕ ключа находкой НЕ делаем, и это не забывчивость. Рецепт роль получает
  // промптом; бинарь на машине может быть не нужен вовсе — в сессии бывают браузерные
  // инструменты. Находка на пустом ключе шумела бы на каждом проекте, а шум убивает
  // сигнал надёжнее молчания (тот же довод, что у единицы измерения в DECIMAL).
  const binary = cfg.browser_binary ? String(cfg.browser_binary) : null
  if (binary && !existsSync(binary.startsWith('/') ? binary : resolve(root, binary))) {
    out.push(
      `browser_binary в .firm/config указывает на «${binary}», а файла нет — бинарь либо не ` +
      `поставили, либо обновили (в имени каталога стоит версия). Поставить заново: ` +
      `npx -y @puppeteer/browsers install chrome-headless-shell@stable`,
    )
  }
  // Макет поставки. Здесь, а не отдельной командой, по той же причине, по которой здесь
  // стоят критерии: находки этой функции читает гейт планирования — последний момент,
  // когда отсутствующий экран ещё рисуется, а не утверждается не глядя.
  out.push(...designFindings(root, change))
  // Номера бизнес-правил. Тот же канал и по той же причине: ссылка на правило, которого
  // нет, и один номер на два правила — это вопросы ДО утверждения, а не после.
  out.push(...brFindings(root, change))
  // Нарезка: два тикета на одно требование без границы между ними. Канал тот же, и момент
  // тот же: после утверждения разрез уже не переносят — его переписывают кодом дважды.
  out.push(...sliceFindings(root, change))
  return out
}

// ── Макет поставки: показан ли человеку экран, который он утверждает ──────────
//
// Разбор стадии Дизайнера 22.10.2026. «Прототип нужен человеку НА ВОРОТАХ» было написано
// в трёх местах — в описании роли, в `/firm-plan` §3 и в документе замысла, — и ни одно
// из трёх ничего не проверяло: гейт планирования сверял `openspec validate`, критерии,
// журнал и доску, а про макет молчал.
//
// Молчание здесь стоит дороже пропущенной стадии. `templates/standards/ui.md` отводит
// «консистентность стиля» человеку на воротах планирования, «где он смотрит прототип
// Дизайнера»: нет прототипа — тихо отменяется и эта проверка, причём отменяется она
// ссылкой на файл, который сам же её и отводил.
//
// Три предиката, и каждый предъявим файлом, а не вкусом:
//   1. в поставке есть задачи `ui: true`, а файла макета нет;
//   2. макет есть, но секции задачи в нём нет — человек не найдёт её экран, а Дизайнер
//      обязан был дать «секцию на задачу» (пункт 4 его процесса);
//   3. макет тянет ресурс из сети — открытый на воротах без интернета, он покажет не то,
//      что утверждали, и роль это себе уже запрещает.
//
// Суждения о самом рисунке здесь нет и быть не может: «удобно ли» решает человек
// (ADR-0009). Движок отвечает на единственный машинный вопрос — есть ли что смотреть.
export function designFile(change) {
  return join('docs', 'design', change, 'ui.html')
}

export function designFindings(root, change) {
  if (!change) return []
  const ui = listTasks(root, change).filter((t) => t.ui)
  if (!ui.length) return []
  const rel = designFile(change)
  let html = null
  try {
    html = readFileSync(resolve(root, rel), 'utf8')
  } catch {
    html = null
  }
  if (html === null) {
    return [
      `задач с ui: true — ${ui.length} (${ui.map((t) => t.id).join(', ')}), а макета «${rel}» нет: ` +
      `человек на воротах утвердит экраны, которых не видел, и «консистентность стиля» из ` +
      `docs/standards/ui.md не проверит никто — этот стандарт отводит её ровно на ворота, к прототипу`,
    ]
  }
  const out = []
  const missing = ui.filter((t) => !html.includes(t.id))
  if (missing.length) {
    out.push(
      `макет «${rel}» есть, но секций задач ${missing.map((t) => t.id).join(', ')} в нём нет — ` +
      `человек на воротах не найдёт их экраны, а разбивка по задачам и есть то, чем макет полезен`,
    )
  }
  const net = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']{0,80}|@import\s+url\(\s*["']?https?:\/\/[^"')]{0,80}/i)
  if (net) {
    out.push(
      `макет «${rel}» тянет ресурс из сети («${net[0].slice(0, 60)}») — открытый на воротах ` +
      `без интернета он покажет не то, что утверждают; файл обязан быть самодостаточным`,
    )
  }
  return out
}

// ── Путь пользователя: складывается ли спланированное в проходимый путь ───────
//
// Отчёт проект-В 03.11.2026 («путь пользователя на воротах планирования»), запрошено
// человеком. Поставка `2026-11-03-host-self-serve-game` прошла ворота 1 со ВСЕМИ зелёными
// гейтами — `openspec validate --strict` valid, `criteria` ноль находок при 217 критериях
// на 25 задач, `boundaries` ноль, `doctor` чист, `plan-shape` девять волн при поле девять
// и нуле исключительных задач (лучшая форма плана за историю проекта), — и была человеком
// принята. При этом она не работала как замысел: тема «ведущий заводит партию сам, без
// Админа» не содержала второго шага из четырёх — перехода «создана» → «сбор игроков»,
// который по ADR-0008 принадлежит исключительно Админу. Ни требования, ни задачи, ни
// спеки, ни команды пульта: грепом по `requirements.md`, `design.md` и всем 25 файлам
// задач — ноль вхождений. Ведущий заводил партию без Админа и шёл к Админу открывать к
// ней вход.
//
// Почему это не дефект гейтов. Все пять проверяют СВЯЗНОСТЬ плана: схему спеки,
// проверяемость критериев, параллельность графа, уникальность номеров, объявленные
// границы. Связность — не полнота: плана из двадцати пяти внутренне безупречных задач
// может не хватать на один шаг, и отсутствующего шага нет ни в одном артефакте, с которым
// гейты сверяются. Отсутствие нельзя найти сверкой с тем, что есть.
//
// Поэтому вход новый, а не правка старого: таблица шагов — единственный артефакт ворот, в
// котором отсутствие шага ВИДНО, потому что путь в ней обязан быть непрерывным. Нашёл
// дыру человек — вопросом, за минуту, по таблице в четыре строки.
//
// Цена отсутствия, замеренная в тот же день: после ПРИНЯТЫХ ворот понадобились новое
// правило BR-238, отмена BR-23 целиком, расширение BR-210/BR-217, приписка-ревизия к
// утверждённому ADR-0008, три новые задачи, +37 критериев и +1 волна календаря (9 → 10).
// Не будь вопроса — дыра вскрылась бы на демо-воротах готовой поставки, то есть
// переделкой темы после сборки. Класс дефекта в том же проекте уже назван самим ADR-0008
// («серверная возможность есть, пути к ней из браузера нет») и ловился живой проверкой
// ПОСЛЕ сборки (BUG-012).
//
// Что здесь судит машина, а что человек. Машина проверяет разрешимость ссылок и
// НЕПРЕРЫВНОСТЬ пути: чужая роль посреди пути своей, пустая клетка «чем сделано» при новом
// поведении, номер правила или ADR, которого нет либо который отменён, задача не из этой
// поставки. «Доходит ли путь до цели» машине не принадлежит — она не знает предметной
// области (ADR-0007, ADR-0009); механическая часть этой находки — требование объявить
// цель словами, а судит её человек, которому цель и последний шаг кладут рядом строкой.
// Остальное смысловое остаётся ему же — как «консистентность стиля» у прототипа.
const USER_PATH_HEAD = /^#{2,4}\s*Пут[ьи]\s*(?:роли)?\s*[:—–-]\s*(.+?)\s*$/i
const USER_PATH_GOAL = /^\s*\*{0,2}цель\*{0,2}\s*[:—–-]\s*(.+?)\s*$/i
const CELL_EMPTY = /^(?:[—–-]+|\?+|нет|tbd|n\/a|)$/i
const CELL_EXISTS = /существует|не трогаем|не меняется/i
// Оговорка в клетке — три слова и свободный порядок после них ───────────────────────────
// Все формы законной оговорки («по замыслу», «ждёт решения», «без правила») строятся ОДНИМ
// выражением, и это не вкус: до 06.11.2026 каждая из трёх жила своей регуляркой, а четвёртое
// место — `roleName` — повторяло их список четвёртый раз. Решение, живущее в каждом файле
// отдельно, отстаёт от следующего файла; место такого решения — одно.
//
// Что чинится вместе с переносом в одно место (замер 06.11.2026, отчёт проект-В Д-54): между
// словом оговорки и двоеточием человек ставит слова. «ждёт решения ЧЕЛОВЕКА: адреса бота в
// продукте нет» — естественный порядок слов, а признак требовал двоеточия СРАЗУ после
// «решения». Последствия измерены прогоном, и их два, оба хуже находки:
//   - «ждёт решения человека: …» в столбце «чем сделано» не давало НИ находки, ни вопроса:
//     клетка не пуста, значит дыру «поведение заявлено, задачи нет» признак не видит, а
//     вопросом она не стала. Шаг, не сделанный ничем, проходил ворота молча;
//   - «по замыслу человека: …» в клетке исполнителя давало ЛОЖНУЮ блокирующую находку,
//     которая велит автору переписать роль — то есть признак причины требовал ритуальной
//     формы вместо смысла, ровно то, против чего он и заведён.
// Поэтому между словом оговорки и разделителем разрешены до трёх слов («человека»,
// «человека по Н-8»), а разделителем считается и запятая: человек пишет прозой.
const CLAUSE_TAIL = '(?:[\\s\\u00a0]+[\\p{L}\\p{N}.§-]+){0,3}[\\s\\u00a0]*[:—–,-][\\s\\u00a0]*\\S'
const clauseRe = (word) => new RegExp(word + CLAUSE_TAIL, 'iu')

// Имя исполнителя без оговорки: ячейка «кто исполняет» несёт и роль, и причину законного
// разрыва («Админ — по замыслу: …», «Админ — ждёт решения человека: …»). Для сверки ролей
// нужна только роль; причина читается отдельно и целиком.
const CLAUSE_WORDS = 'по замыслу|ждёт решения|без правила'
const CLAUSE_SPLIT = new RegExp(`[\\s\\u00a0]*[—–][\\s\\u00a0]*(?:${CLAUSE_WORDS})(?=${CLAUSE_TAIL})`, 'iu')
// Хвост оговорки целиком — «по замыслу человека: сам текст» → «сам текст». Нужен строке
// вопроса на воротах: человек читает причину, а не форму, в которой она записана.
const CLAUSE_HEAD = new RegExp(`^.*?(?:${CLAUSE_WORDS})(?:[\\s\\u00a0]+[\\p{L}\\p{N}.§-]+){0,3}[\\s\\u00a0]*[:—–,-][\\s\\u00a0]*`, 'iu')
function roleName(cell) {
  const raw = String(cell || '').trim()
  if (!raw) return null
  return raw.split(CLAUSE_SPLIT)[0].trim() || null
}

const BY_DESIGN = clauseRe('по замыслу')
const NO_RULE = clauseRe('без правила')
// Разрыв, который НАЗВАН человеку и решения пока не получил. Поставлено 04.11.2026 по
// случаю проект-В, и это поправка к моему же признаку причины: «по замыслу» годится, только
// когда разрыв задуман, а у них разрыв был законен иначе — «по недосмотру, который
// человеку назван и решения пока не получил» (первый контакт с ботом происходит ВНЕ
// продукта: адреса бота в продукте нет нигде, ссылку даёт Админ лично).
//
// Без второй формы у Архитектора оставалось два выхода, и оба плохие: написать «по
// замыслу» — то есть соврать, — либо принять блокирующую находку, которая велит ему решить
// то, что решает человек. Второе прямо против ADR-0009, а первое превращает признак
// причины в ритуал.
//
// Поэтому такой шаг — НЕ дефект и НЕ молчание: он уходит открытым вопросом пути, а
// открытые вопросы на воротах планирования уже имеют адресата — человека (та же дорога,
// что у `open_questions` PM). Силенсером это не станет по той же причине: вопрос не
// снимает шаг с ворот, а ставит его перед человеком, и путь, набитый вопросами, читается
// как незаконченный план — ровно то, чем он и является.
const OPEN_Q = clauseRe('ждёт решения')
const REF_T = /\bT-[0-9][\w.-]*/g
const REF_BR = /\bBR-(\d+)/g
const REF_ADR = /\bADR-(\d+)/g

function cleanCell(s) {
  return String(s || '').replace(/`/g, '').replace(/\*\*/g, '').replace(/~~/g, '').trim()
}

// Имя роли сравнивается по сути, а не по написанию: «Админ», «админ», «**Админ**»,
// «Админ (пульт)» — одна роль. Иначе находка срабатывала бы на оформлении, а это ровно
// тот шум, который обесценивает блокирующую проверку.
function roleKey(s) {
  return cleanCell(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function sameRole(a, b) {
  const x = roleKey(a)
  const y = roleKey(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}

export function userPathDoc(root, change) {
  const dir = tasksDir(root, change)
  return dir ? join(dirname(dir), 'user-path.md') : null
}

// Разбор файла: секции «## Путь: <роль>», в каждой строка «цель:» и таблица шагов.
// Строка-заголовок таблицы снимается не по словам, а по следующему за ней разделителю —
// иначе проверка зависела бы от того, как Архитектор назвал столбцы.
export function parseUserPath(text) {
  const paths = []
  let cur = null
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = line.match(USER_PATH_HEAD)
    if (h) {
      cur = { role: cleanCell(h[1]), goal: null, line: i + 1, steps: [] }
      paths.push(cur)
      continue
    }
    if (!cur) continue
    const g = line.match(USER_PATH_GOAL)
    if (g && !cur.goal) {
      cur.goal = cleanCell(g[1])
      continue
    }
    if (!/^\s*\|/.test(line)) continue
    const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cleanCell)
    if (cells.length < 4) continue
    if (/^[-:\s]+$/.test(cells.join(''))) {
      cur.steps.pop()
      continue
    }
    cur.steps.push({ line: i + 1, step: cells[0], who: cells[1], allowed: cells[2], done: cells[3] })
  }
  return paths
}

export function userPathState(root, change) {
  const doc = change ? userPathDoc(root, change) : null
  const exists = Boolean(doc && existsSync(doc))
  const paths = exists ? parseUserPath(readFileSync(doc, 'utf8')) : []
  const audit = userPathAudit(root, change)
  return {
    change: change || null,
    file: doc ? doc.slice(root.length + 1) : null,
    exists,
    paths: paths.map((p) => ({
      role: p.role,
      goal: p.goal,
      steps: p.steps.length,
      // Цель и последний шаг — рядом. Это и есть машинная часть находки «путь не доходит
      // до цели»: сравнить две строки движок не может, а положить их в одну строку перед
      // человеком — может, и именно этого на воротах не было.
      last_step: p.steps.length ? p.steps[p.steps.length - 1].step : null,
      // Исполнитель — ИМЯ роли, без приписанной к ячейке причины разрыва. Замер на первой
      // живой поставке под этими воротами (проект-В, G-018, 05.11.2026): у пути игрока
      // строка читалась «исполнителей 4 (игрок, игрок — по замыслу: решение человека …,
      // игрок — по замыслу: …, игрок — по замыслу: …)» — то есть число было вчетверо
      // завышено, а причины разрывов вывалились целыми фразами в строку, которую человек
      // читает на воротах. Один исполнитель с тремя оговорками — это один исполнитель.
      roles_involved: [...new Set(p.steps.map((s) => roleName(s.who)).filter(Boolean))],
    })),
    findings: audit.findings,
    // Открытые вопросы пути — отдельным полем, а не находками: это не дефект плана, а
    // работа человека на воротах. Пустой список говорит «вопросов нет», и сказать это
    // вслух так же важно, как назвать вопрос: у PM ровно это правило стоит в `/firm-plan`.
    open_questions: audit.open_questions,
  }
}

export function userPathFindings(root, change) {
  return userPathAudit(root, change).findings
}

export function userPathQuestions(root, change) {
  return userPathAudit(root, change).open_questions
}

export function userPathAudit(root, change) {
  if (!change) return { findings: [], open_questions: [] }
  const doc = userPathDoc(root, change)
  const rel = doc ? doc.slice(root.length + 1) : `openspec/changes/${change}/user-path.md`
  if (!doc || !existsSync(doc)) {
    return { open_questions: [], findings: [
      `пути пользователя нет (${rel}) — это обязательный вход ворот 1, и человеку он ` +
      `показывается ПЕРВЫМ: остальные семь входов проверяют связность плана, а не то, ` +
      `складываются ли спланированные поведения в путь, который человек может пройти. ` +
      `Замер проект-В 03.11.2026: пять зелёных гейтов при отсутствующем шаге из четырёх, ` +
      `и после принятых ворот — новое правило, отмена другого, ревизия ADR, три задачи, ` +
      `+37 критериев и +1 волна календаря. Пишет Архитектор, шаблон — ` +
      `$ENGINE/templates/user-path.example.md`,
    ] }
  }
  const paths = parseUserPath(readFileSync(doc, 'utf8'))
  if (!paths.length) {
    return { open_questions: [], findings: [
      `${rel}: файл есть, а путей в нём нет. Ждётся секция «## Путь: <роль>» на каждую ` +
      `роль, которую тема затрагивает, строка «цель: …» и таблица из четырёх столбцов ` +
      `(шаг | кто исполняет | чем разрешено | чем сделано). Шаблон — ` +
      `$ENGINE/templates/user-path.example.md`,
    ] }
  }
  const out = []
  const ask = []
  const tasks = new Set(listTasks(root, change).map((t) => t.id))
  const br = brState(root)
  const adr = adrState(root)
  for (const p of paths) {
    if (!p.goal) {
      out.push(
        `${rel}:${p.line} путь роли «${p.role}» не объявил цель. Строка «цель: …» здесь не ` +
        `оформление: доходит ли путь до цели темы — вопрос смысловой, движку он не ` +
        `принадлежит (ADR-0009), и человек на воротах судит его сравнением цели с ` +
        `последним шагом. Не названа цель — сравнивать нечего`,
      )
    }
    if (!p.steps.length) {
      out.push(`${rel}:${p.line} у пути роли «${p.role}» нет ни одного шага — таблица пуста либо столбцов меньше четырёх`)
      continue
    }
    for (const s of p.steps) {
      const where = `${rel}:${s.line}`
      const what = s.step ? `«${s.step.slice(0, 70)}»` : '(шаг без названия)'
      if (!s.step) out.push(`${where} шаг без названия: столбец «шаг» пуст, а он и есть то, что человек читает`)
      // 1. Чужая роль посреди пути своей. Ровно случай проект-В: тема про ведущего,
      //    исполнитель второго шага — Админ.
      //    Нерешённое в клетке исполнителя спрашивается независимо от того, своя роль или
      //    чужая: до 05.11.2026 условие стояло под `!sameRole`, и «игрок — ждёт решения: …»
      //    уходило в тишину — клетка начиналась с имени своей роли, и признак молчал. Молчание
      //    тут значило «решено», хотя человек написал ровно обратное (И-12, ADR-0007).
      if (OPEN_Q.test(s.who)) {
        ask.push(
          `${where} шаг ${what} исполняет «${s.who}» — разрыв назван, решения нет. ` +
          `Человеку на воротах: ${s.who.replace(CLAUSE_HEAD, '')}`,
        )
      } else if (!sameRole(s.who, p.role) && !BY_DESIGN.test(s.who)) {
        out.push(
          `${where} путь роли «${p.role}» прерывается на шаге ${what}: исполнитель — ` +
          `«${s.who || 'не назван'}». Либо шаг принадлежит этой роли (и тогда у него есть ` +
          `право и задача), либо разрыв назван причиной в той же клетке: ` +
          `«${s.who || '<роль>'} — по замыслу: <почему тут нужна другая роль>», а если решения ` +
          `ещё нет — «${s.who || '<роль>'} — ждёт решения: <что решает человек>»: это не дефект, ` +
          `а вопрос на ворота. Это тот самый ` +
          `случай 03.11.2026: тема про самостоятельного ведущего, а шаг 2 из 4 исполнял Админ`,
        )
      }
      // 2. Поведение заявлено, задачи нет.
      if (OPEN_Q.test(s.done)) {
        ask.push(`${where} шаг ${what} ещё ничем не сделан, и это названо вопросом: ${s.done}`)
      } else if (CELL_EMPTY.test(s.done)) {
        out.push(
          `${where} шаг ${what} ничем не сделан: столбец «чем сделано» пуст. Либо назови ` +
          `задачи этой поставки (T-XXX), либо «существует, не трогаем» — пустая клетка и ` +
          `есть дыра этого класса: поведение в пути заявлено, а в плане его нет. Решение ещё ` +
          `не принято — «ждёт решения: <что решает человек>», и шаг уйдёт вопросом на ворота`,
        )
      } else {
        // 4. Задача названа, но она не из этой поставки.
        for (const id of s.done.match(REF_T) || []) {
          if (!tasks.has(id)) {
            out.push(
              `${where} шаг ${what} сделан задачей ${id}, а такой задачи в поставке ` +
              `«${change}» нет — ссылка не разрешается, и шаг фактически не сделан ничем`,
            )
          }
        }
      }
      // 3. Чем разрешено: номер правила или ADR, и он обязан разрешаться.
      const brs = [...s.allowed.matchAll(REF_BR)].map((m) => Number(m[1]))
      const adrs = [...s.allowed.matchAll(REF_ADR)].map((m) => Number(m[1]))
      if (!brs.length && !adrs.length && OPEN_Q.test(s.allowed)) {
        ask.push(`${where} шаг ${what} ничем ещё не разрешён, и это названо вопросом: ${s.allowed}`)
      } else if (!brs.length && !adrs.length) {
        if (CELL_EMPTY.test(s.allowed)) {
          out.push(
            `${where} шаг ${what} ничем не разрешён: столбец «чем разрешено» пуст. Право ` +
            `на шаг даёт номер правила (BR-N) или решения (ADR-NNNN); права нет вовсе — ` +
            `скажи это словами: «без правила: <почему шаг законен и так>»`,
          )
        } else if (!NO_RULE.test(s.allowed) && !CELL_EXISTS.test(s.allowed)) {
          out.push(
            `${where} шаг ${what} разрешён текстом «${s.allowed.slice(0, 60)}» без номера. ` +
            `Ссылка без номера не проверяется ничем: поставь BR-N или ADR-NNNN, а если ` +
            `правила нет — «без правила: <почему>»`,
          )
        }
      }
      if (br.files.length) {
        for (const n of brs) {
          if (br.retired.has(n)) {
            out.push(`${where} шаг ${what} опирается на BR-${n}, а оно ОТМЕНЕНО (${br.retired.get(n)}) — право на шаг отозвано вместе с правилом`)
          } else if (!br.where.has(n)) {
            out.push(`${where} шаг ${what} опирается на BR-${n}, а такого правила в docs/product/ нет — человек его не утверждал`)
          }
        }
      }
      if (adr.known.size) {
        for (const n of adrs) {
          const rec = adr.known.get(n)
          const num = String(n).padStart(4, '0')
          if (!rec) {
            out.push(`${where} шаг ${what} опирается на ADR-${num}, а такого решения в ${adr.dir}/ нет — ссылка не разрешается`)
          } else if (rec.retired) {
            out.push(`${where} шаг ${what} опирается на ADR-${num}, а оно ОТМЕНЕНО (${rec.file}) — решение больше не действует`)
          }
        }
      }
    }
  }
  return { findings: out, open_questions: ask }
}

export function userPathLines(st) {
  const lines = []
  lines.push(`Путь пользователя — ${st.change || '(поставка не определена)'}`)
  lines.push(st.exists ? `Файл: ${st.file}` : `Файла нет: ${st.file || 'openspec/changes/<change>/user-path.md'}`)
  for (const p of st.paths) {
    lines.push('')
    lines.push(`  ${p.role}: шагов ${p.steps}${p.roles_involved.length > 1 ? `, исполнителей ${p.roles_involved.length} (${p.roles_involved.join(', ')})` : ''}`)
    lines.push(`    цель:         ${p.goal || '— НЕ НАЗВАНА'}`)
    lines.push(`    последний шаг: ${p.last_step || '—'}`)
  }
  if (st.findings.length) {
    lines.push('')
    lines.push(`Находки (${st.findings.length}) — к человеку с этим не идём:`)
    for (const f of st.findings) lines.push(`  - ${f}`)
  } else if (st.exists) {
    lines.push('')
    lines.push('Находок нет. Сходится ли последний шаг с целью — судит человек: машина предметной области не знает.')
  }
  // Вопросы называются и тогда, когда их нет: «вопросов нет» и «вопросы не спросили» для
  // человека выглядят одинаково, а значат разное (то же правило у открытых вопросов PM).
  if (st.exists) {
    lines.push('')
    if (st.open_questions.length) {
      lines.push(`Открытые вопросы пути (${st.open_questions.length}) — это НЕ дефекты: их решает человек на воротах:`)
      for (const q of st.open_questions) lines.push(`  - ${q}`)
    } else {
      lines.push('Открытых вопросов пути нет.')
    }
  }
  return lines
}

// Решения проекта (`docs/adr/`) — для разрешимости ссылок «чем разрешено». Номер берётся
// из имени файла: ADR нумеруются им и только им. Отмена читается из шапки: статус стоит
// в первых строках и пишется словами («**Статус:** **отменено 10.10.2026**»).
export function adrState(root) {
  const dir = join('docs', 'adr')
  let files = []
  try {
    files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    files = []
  }
  const known = new Map()
  for (const f of files) {
    const m = f.match(/^(\d{1,4})[-_.]/)
    if (!m) continue
    let head = ''
    try {
      head = readFileSync(join(root, dir, f), 'utf8').split('\n').slice(0, 15).join('\n')
    } catch {
      head = ''
    }
    known.set(Number(m[1]), {
      file: `${dir}/${f}`,
      retired: /Статус[^\n]{0,60}?(отмен|заменен|заменён|superseded)/i.test(head),
    })
  }
  return { dir, files, known }
}

// ── Номера решений проекта (ADR) ──────────────────────────────────────────────
//
// Отчёт проект-В 05.11.2026 (Д-50). `next-id --kind adr` отдавал `{ kind: "task", id: "T-336" }`:
// неизвестный вид не отвергался, а подменялся задачным. Ответ внутренне честен — поле `kind`
// говорит «task», — но роль спрашивала про ADR и читает `id`, то есть PM записал бы в
// решение номер задачи. Это ровно тот класс, от которого распределитель номеров и
// существует, и он прошёл насквозь, потому что подмена МОЛЧИТ: отказ роль увидит, подмену —
// нет. Поэтому неизвестный вид теперь отказ (`nextIds` бросает), а `adr` — настоящий вид.
//
// Потолок считается не по одному дереву, и это второе лечение в той же правке. Класс назван
// самим проектом как Д-46: «потолок номеров принадлежит продукту, а считается по дереву».
// У проект-В две живые линии и односторонние мержи `main` → `3d`, и на замере 04.11.2026
// `BR-*` занижался на 14, а `DEC-*` — до нуля, потому что файл лежал только на `3d`.
// Поэтому смотрим ЖИВЫЕ линии: дерево, ветку-цель (`vcs.target_branch`) и ветки, выгруженные
// в рабочих деревьях. Все 293 локальные ветки не читаем намеренно — это 2,4 с на вызов и
// мусор заброшенных веток задач; занятые ими номера держит каталог брони `.firm/ids/`.
const ADR_NUM = /(?:^|\/)(\d{1,4})[-_.]/

export function liveRefs(root, config = null) {
  const cfg = config || readConfig(root) || {}
  const out = []
  const add = (name) => {
    const n = String(name || '').trim()
    if (n && n !== 'HEAD' && !out.includes(n)) out.push(n)
  }
  const ask = (a) => {
    try {
      return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return ''
    }
  }
  add(ask(['rev-parse', '--abbrev-ref', 'HEAD']).trim())
  add((cfg.vcs && cfg.vcs.target_branch) || 'main')
  for (const line of ask(['worktree', 'list', '--porcelain']).split('\n')) {
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim())
    if (m) add(m[1])
  }
  // Ветка, которой нет, молчит: свежий проект стоит без `main`, и падать на этом нечему.
  return out.filter((r) => ask(['rev-parse', '--verify', '--quiet', r]).trim())
}

// Потолок номеров ADR по живым линиям: имена файлов `docs/adr/NNNN-*.md`. Возвращает и
// откуда взят максимум — число без адреса читается как обвинение (урок `inflated_by`).
export function adrCeiling(root, config = null) {
  const seen = new Map()
  for (const f of adrState(root).files) {
    const m = f.match(ADR_NUM)
    if (m) seen.set(Number(m[1]), 'дерево')
  }
  for (const ref of liveRefs(root, config)) {
    let listed = ''
    try {
      // `core.quotepath=false` обязателен: по умолчанию git ЭКРАНИРУЕТ не-ASCII в путях
      // (`"docs/adr/0038-\321\200..."`), такой путь не кончается на `.md`, и решение с
      // русским именем файла не попадает в потолок вовсе. Поймано тестом на кириллице —
      // на латинских именах проект-В дефект не виден.
      listed = execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', ref, '--', 'docs/adr'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      continue
    }
    for (const path of listed.split('\n')) {
      if (!path.endsWith('.md')) continue
      const m = path.slice('docs/adr/'.length).match(ADR_NUM)
      if (!m) continue
      const n = Number(m[1])
      if (!seen.has(n)) seen.set(n, ref)
    }
  }
  const nums = [...seen.keys()].sort((a, b) => a - b)
  const max = nums.length ? nums[nums.length - 1] : 0
  return { max_used: max, used_count: nums.length, where: seen.get(max) || null, refs: liveRefs(root, config) }
}

export function nextAdr(root, count = 1) {
  const c = adrCeiling(root)
  const pad = (n) => `ADR-${String(n).padStart(4, '0')}`
  const ids = []
  for (let i = 1; i <= Math.max(1, count); i++) ids.push(pad(c.max_used + i))
  return {
    kind: 'adr',
    prefix: 'ADR',
    max_used: c.max_used,
    next: ids[0],
    ids,
    used_count: c.used_count,
    // Чем считан потолок — часть ответа, а не украшение: если максимум пришёл не из дерева,
    // роль смотрит в `docs/adr/` и номера там не видит.
    ceiling_from: c.where,
    lines_read: c.refs,
    file_hint: `docs/adr/${String(c.max_used + 1).padStart(4, '0')}-<краткое-имя-решения>.md`,
  }
}

// ── Стандарты кода проекта: вход оси Standards код-ревью ──────────────────────
//
// Поставлено 15.10.2026 по разбору ECC (`docs/ecc-ingest.md`, пункт 1). Приём
// `firm-review` делегирует в `mattpocock-skills:code-review`, который судит по двум осям,
// и первая из них — «does the code follow this repo's DOCUMENTED coding standards?».
// Документа в проектах не было: ось существовала, вход был пуст, и Ревьюер каждый раз
// изобретал критерий сам. Вердикт по такой оси невоспроизводим — две стадии на одном
// диффе дают разные замечания, и ни одно нельзя оспорить ссылкой.
//
// Это тот же класс дефекта, что поймали с `mattpocock-skills:verify` (адаптер целил в
// скил, которого не существовало): шаг 3в рубежа сверяет НАЛИЧИЕ набора, а не наличие
// того, что набор читает.
//
// Находка — предупреждение, а не блок, и это решение, а не мягкость: проект вправе не
// иметь стандартов (`ADR-0009` — движок не распоряжается чужим временем), но молчать об
// этом нельзя. Роль, получившая пустую ось, обязана объявить её непроверенной
// (`agents/reviewer-qa.md`, пункт 4) — по тому же правилу, по которому `firm-verify`
// объявляет себя непройденным (ADR-0007).
export const STANDARDS_DIR = join('docs', 'standards')

export function standardsState(root) {
  const dir = join(root, STANDARDS_DIR)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    files = []
  }
  return { dir: STANDARDS_DIR, files, present: files.some((f) => f === 'common.md') }
}

export function standardsFindings(root) {
  const st = standardsState(root)
  if (st.present) return []
  if (st.files.length) {
    return [
      `стандарты кода в ${STANDARDS_DIR}/ есть (${st.files.join(', ')}), но общей части ` +
      `common.md среди них нет — ось Standards код-ревью читает именно её. Разложить: ` +
      `/firm-setup, шаг стандартов`,
    ]
  }
  return [
    `стандартов кода в проекте нет (${STANDARDS_DIR}/common.md): ось Standards код-ревью ` +
    `останется пустой, и Ревьюер будет изобретать критерий сам — вердикт по такой оси ` +
    `невоспроизводим. Разложить шаблоны: /firm-setup, шаг стандартов. Это предупреждение, ` +
    `а не блок: проект вправе их не иметь, но тогда ревью обязано называть ось непроверенной`,
  ]
}

// Какие файлы стандартов относятся к ЭТОЙ правке.
//
// У каждого файла в `docs/standards/` во frontmatter объявлены пути, на которые он
// действует (`**/*.py`, `**/*.tsx`). До 0.4.88 это объявление не читал никто: ни код, ни
// промпт роли. Два следствия, и шумное хуже дорогого:
//
//   • `ui.md` вообще не попадал в ось Standards. Ревьюеру сказано «common.md плюс файл
//     ЯЗЫКА», а `ui.md` кладётся по признаку «есть экраны» и файлом языка не является —
//     то есть 4908 символов правил интерфейса уезжали в проекты и не читались никогда;
//   • норма, не относящаяся к правке, лежит в окне и приглашает замечание «по вкусу» —
//     ровно то, против чего эти файлы и писались.
//
// Отбор идёт тем же сопоставлением, что и короткая полоса (`laneAllows`): один механизм
// на оба случая, иначе они разойдутся в том, что считают совпадением.
//
// ГРАНИЦА. Экономия здесь — побочный эффект, а не цель, поэтому любое «не знаю»
// трактуется В СТОРОНУ ЧТЕНИЯ (И-12): нет frontmatter — файл применим; файлы правки не
// названы — применимо всё. Пропущенная норма стоит дороже лишних символов в окне.
export const STANDARDS_ALWAYS = ['common.md', 'lint-policy.md']

export function standardsFor(root, files = null) {
  const st = standardsState(root)
  const list = Array.isArray(files) ? files.map(String).filter(Boolean) : null
  const applicable = []
  const skipped = []
  for (const name of st.files) {
    let paths = []
    try {
      const fm = parseFrontmatter(readFileSync(join(root, STANDARDS_DIR, name), 'utf8'))
      const raw = fm.data && fm.data.paths
      paths = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
    } catch {
      paths = []
    }
    if (STANDARDS_ALWAYS.includes(name)) {
      applicable.push({
        file: name,
        paths,
        why: name === 'lint-policy.md'
          ? 'политика линта: по ней разбирается красный линт, а не по вкусу стадии'
          : 'общая часть: действует на любую правку',
      })
      continue
    }
    if (!paths.length) {
      applicable.push({ file: name, paths, why: 'в файле не объявлены paths — читается как общий (И-12)' })
      continue
    }
    if (list === null) {
      applicable.push({ file: name, paths, why: 'файлы правки не названы — отбор не делался' })
      continue
    }
    const hit = list.filter((f) => laneAllows(paths, f))
    if (hit.length) {
      applicable.push({ file: name, paths, why: `правка трогает ${hit.length} файл(ов) из его путей: ${hit.slice(0, 3).join(', ')}` })
    } else {
      skipped.push({ file: name, paths, why: `ни один файл правки не попал в ${paths.join(', ')}` })
    }
  }
  return {
    dir: STANDARDS_DIR,
    files_checked: list,
    applicable,
    skipped,
    findings: standardsFindings(root),
  }
}

export function standardsForLines(s) {
  const out = []
  out.push(
    s.files_checked === null
      ? 'файлы правки не названы — перечислены ВСЕ стандарты проекта'
      : `правка: ${s.files_checked.length} файл(ов)`,
  )
  out.push('')
  if (s.applicable.length) {
    out.push('читать (ось Standards судит по ним, и замечание обязано назвать файл и правило):')
    for (const a of s.applicable) out.push(`  ${s.dir}/${a.file} — ${a.why}`)
  } else {
    out.push(`читать нечего: в ${s.dir}/ стандартов нет`)
  }
  if (s.skipped.length) {
    out.push('')
    out.push('не читать (к этой правке не относятся):')
    for (const k of s.skipped) out.push(`  ${s.dir}/${k.file} — ${k.why}`)
  }
  if (s.findings.length) {
    out.push('')
    for (const f of s.findings) out.push(`• ${f}`)
  }
  return out
}

// ── Версия движка: записанная против фактической ──────────────────────────────
//
// Жило в `firm-state.mjs` и отвечало только на прямой вопрос `phase`. Разбор проект-В
// 11.10.2026 (Д-7): расхождение 0.4.70 против 0.4.73 висело всю сборку, а узнать о нём
// можно было лишь спросив — ни `doctor`, ни `board`, ни `build-args` о нём не говорили.
// Между этими версиями лежали исправления привязки событий, то есть расходилось не
// украшение, а поведение. Переехало в lib, чтобы о нём мог сказать каждый, кто читает
// состояние.
export function engineVersionState(root, config = null) {
  const cfg = config || readConfig(root) || {}
  const recorded = cfg.engine_version || null
  let actual = null
  try {
    // `fileURLToPath`, а не `URL.pathname`: во втором пробел в пути приедет как `%20`,
    // и манифест не найдётся на машине, где проект лежит в «Моих документах».
    const here = dirname(fileURLToPath(import.meta.url))
    actual = JSON.parse(readFileSync(join(here, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || null
  } catch {
    actual = null
  }
  return { recorded, actual, drift: !!(recorded && actual && recorded !== actual) }
}

// Находка о расхождении — текстом, одной строкой. Сборку не блокирует: расхождение само
// по себе не ошибка (обкатка как раз и означает, что движок меняется под проектом). Но
// `/firm-adopt` обновляет ещё и git-хуки, скопированные в `.git/hooks`, — значит при
// расхождении прогон может идти на новом движке со СТАРЫМИ хуками, а это уже поведение, и
// узнать о нём человек должен до прогона, а не после. С 0.4.126 хуков два, и второй
// (`pre-commit`, второй слой сверки секретов) в проектах не лежит ВОВСЕ, пока adopt не
// позван: в проект-В 05.11.2026 он так и приехал, и до него коммит из обычного терминала шёл
// без сверки секретов совсем. Поэтому формулировка «обновит копию post-merge» тут и была
// неверной — она называла один хук из двух, то есть молчала о том, которого нет.
export function engineVersionFindings(root, config = null) {
  const v = engineVersionState(root, config)
  if (!v.drift) return []
  return [
    `движок записан как ${v.recorded}, фактически ${v.actual} — /firm-adopt снимет расхождение ` +
    `и поставит git-хуки движка в .git/hooks (их не доставляет ни одна другая команда): ` +
    `post-merge — события слияния и выпуска, pre-commit — второй слой сверки секретов`,
  ]
}

// ── Груминг: учётные записи прогрумленных тем (ADR-0012) ──────────────────────
//
// Разведка больше не заводит папку в `openspec/changes/` — её заводит планирование.
// Прогрумленная тема до планирования живёт двумя вещами: ДОСЬЕ в бэклоге
// (`docs/backlog/G-XXX-<слаг>/`, бизнес-требования, решения Архитектора, влияние на код)
// и УЧЁТНОЙ ЗАПИСЬЮ `.firm/groom/G-XXX.json` в главном дереве.
//
// Почему учётная запись, а не событие журнала. Событие без поставки попадает в выборку
// ЛЮБОЙ поставки (`listEvents`: `!e.change || e.change === change`) — свойство нужное,
// на нём держится достройка привязки идущих стадий. Значит журнал груминга проступал бы
// на доске поставки, по которой груминг не идёт. Файл в `.firm/groom/` не проступает
// нигде, кроме своего блока на дашборде.
//
// Почему в ГЛАВНОМ дереве, хотя груминг идёт в своём. `repoRoot()` из любого связанного
// дерева возвращает главное (`--git-common-dir`), и `.firm/` в `.gitignore` проекта:
// запись видна всем сессиям сразу и ни в одну ветку не попадает. Досье — наоборот,
// коммитится на ветке груминга и приезжает в `main` слиянием на планировании.
//
// Статус объявлен человеком и движком, состояние выводится из git. Это разные вещи, и
// склеивать их нельзя: «прогрумлено» — решение, «дерево живо» — факт.

export const GROOM_STATUSES = ['grooming', 'groomed', 'planned']
const GROOM_ID_RE = /^G-(\d+)$/
const GROOM_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export function groomDir(root) {
  return join(root, '.firm', 'groom')
}

// Каталог деревьев груминга — СОСЕД репозитория, как и `worktrees_dir`, но отдельный:
// `prune` считает своим всё внутри `worktrees_dir`, и смешивать два вида деревьев в одном
// каталоге значило бы отдать деревья груминга уборке поставки.
export function groomWorktreesDir(root, config) {
  const fromConfig = config && config.groom_dir
  if (fromConfig) return resolve(root, String(fromConfig))
  return resolve(dirname(root), `${basename(root)}.groom`)
}

export function groomFromBranch(branch) {
  const m = String(branch || '').match(/(?:^|\/)(G-\d+)(?:-|$)/)
  return m ? m[1] : null
}

export function groomBranch(id, slug) {
  return `groom/${id}-${slug}`
}

export function groomDossierDir(root, { id, slug }) {
  return join(root, 'docs', 'backlog', `${id}-${slug}`)
}

export function groomPath(root, id) {
  return join(groomDir(root), `${id}.json`)
}

// Битый файл НЕ пропускается молча: учётная запись — единственное место, где движок
// знает про тему, и «не разобрал» означает «потерял тему», а не «темы нет» (ADR-0007).
export function readGroom(root, id) {
  const path = groomPath(root, id)
  if (!existsSync(path)) return null
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8'))
    return { ...rec, id: rec.id || id }
  } catch (e) {
    return { id, _broken: `не разобрался как JSON: ${e.message}` }
  }
}

export function listGroom(root) {
  const dir = groomDir(root)
  if (!existsSync(dir)) return []
  const ids = []
  for (const f of readdirSync(dir)) {
    const m = /^(G-\d+)\.json$/.exec(f)
    if (m) ids.push(m[1])
  }
  ids.sort((a, b) => Number(GROOM_ID_RE.exec(a)[1]) - Number(GROOM_ID_RE.exec(b)[1]))
  return ids.map((id) => readGroom(root, id)).filter(Boolean)
}

export function writeGroom(root, rec) {
  const id = String(rec && rec.id || '')
  if (!GROOM_ID_RE.test(id)) throw new Error(`номер груминга должен быть вида G-001, а пришёл «${id}»`)
  const was = readGroom(root, id)
  if (was && was._broken) throw new Error(`${id}: ${was._broken} — поправить файл руками, перезапись потеряет содержимое`)
  const now = new Date().toISOString()
  const next = { ...(was || {}), ...rec, id }
  if (next.slug !== undefined && !GROOM_SLUG_RE.test(String(next.slug))) {
    throw new Error(`слаг «${next.slug}» не годится для имени каталога: нужны строчные латинские буквы, цифры и дефис`)
  }
  if (next.status !== undefined && !GROOM_STATUSES.includes(next.status)) {
    throw new Error(`статус «${next.status}» не из списка: ${GROOM_STATUSES.join(', ')}`)
  }
  if (!next.created) next.created = now
  next.updated = now
  mkdirSync(groomDir(root), { recursive: true })
  writeFileSync(groomPath(root, id), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

// Номер занят, если его знает учётная запись ИЛИ досье в бэклоге ИЛИ ветка груминга.
// Учётная запись обязательна не одна по той же причине, по которой `usedIds` смотрит в
// журнал: `.firm/` не под git, запись могли снести, а досье осталось в истории — и
// переиспользовать такой номер значило бы склеить две темы в одном каталоге.
//
// Д-15 (разбор проект-В 27.10.2026). До этой правки в бэклоге считались только КАТАЛОГИ, и
// тема, заведённая руками файлом `G-XXX-<слаг>.md`, была для распределителя невидима:
// `G-012` выдан дважды (провенанс 25.10 и планшет 26.10), `G-013` дважды (запасной путь
// BR-144 и самообслуживание 27.10). `groom list` при этом молчал — он сверяет только свой
// реестр. Форма досье остаётся каталогом, и это не отменяется; но ЗАНЯТОСТЬ НОМЕРА — не
// вопрос формы: номер, уже названный человеком в бэклоге, занят, как бы ни был оформлен
// носитель. Движок, выдающий занятый номер, молча склеивает две темы.
//
// Ветки — третий источник, и он закрывает дыру, которой не закрывают первые два: досье
// темы, которую сейчас грумят, лежит в ЕЁ ветке и в главное дерево приезжает только на
// `/firm-plan`. Пока оно там, в `docs/backlog` главного дерева его нет вовсе.
export function usedGroomIds(root) {
  const used = new Map()
  const note = (id, where) => {
    if (!used.has(id)) used.set(id, [])
    if (!used.get(id).includes(where)) used.get(id).push(where)
  }
  for (const rec of listGroom(root)) note(rec.id, '.firm/groom')
  const backlog = join(root, 'docs', 'backlog')
  if (existsSync(backlog)) {
    for (const e of readdirSync(backlog, { withFileTypes: true })) {
      // Каталог `G-012-slug`, файл `G-012-slug.md`, файл `G-012.md` — всё это носители
      // одного и того же: человек уже назвал этот номер.
      const m = /^(G-\d+)(?:[-.]|$)/.exec(e.name)
      if (m) note(m[1], e.isDirectory() ? 'docs/backlog' : `docs/backlog (файлом: ${e.name})`)
    }
  }
  for (const b of groomBranches(root)) note(b.id, `ветка ${b.branch}`)
  for (const [id, c] of groomClaims(root)) note(id, `заявка в журнале от ${String(c.ts).slice(0, 16)}`)
  return used
}

// Заявка на номер темы — четвёртый источник занятости, и он про ДРУГОЕ время, чем первые
// три (Д-15 проект-В, вторая половина; закрыта 02.11.2026).
//
// Первые три источника — запись, досье, ветка — отвечают на вопрос «тема существует?».
// Все три появляются ВМЕСТЕ с работой, и между «номер выбран» и «каталог заведён» остаётся
// окно, в котором распределитель выдаёт тот же номер второму спрашивающему. Замер проект-В
// 02.11.2026: два столкновения за историю проекта, оба в темах и оба разобраны
// переномерованием ПОСЛЕ факта — `G-012 → G-015` (`c98e03fd`) и `G-013 → G-014`
// (`d71b0007`). В остальных пространствах (`T-NNN`, `BUG-NNN`, `BR-N`) столкновений нет
// ни одного, и это не случайность: там номер появляется ВМЕСТЕ с текстом, а у темы он
// занимает каталог, файл и ветку сразу — то есть работа между выбором и записью есть.
//
// Поэтому заявка заведена только здесь, а не во всех трёх пространствах: механизм ставится
// под замеренную болезнь, а не под симметрию.
//
// Форма — событие журнала (`groom/number-claimed`), а не файл: журнал только дописывается
// и он истина (ADR-0001, ADR-0006), поэтому заявка переживает снос `.firm/` и видна в
// истории. Ошибочная заявка снимается тем же способом, что всякое неверное событие, —
// аннулированием (`record --event retracted --corrects <файл>`): `listEvents` исключает
// аннулированное, и номер освобождается. Своей команды отмены нет намеренно: второй способ
// отменять события — это второй источник истины.
export function groomClaims(root) {
  const out = new Map()
  for (const e of listEvents(root, {})) {
    if (e._broken || e.stage !== 'groom' || e.event !== 'number-claimed') continue
    const id = String(e.ticket || '')
    if (!GROOM_ID_RE.test(id)) continue
    if (!out.has(id)) out.set(id, { ts: e.ts, actor: e.actor || null, notes: e.notes || '' })
  }
  return out
}

// Ветки груминга в репозитории — локальные и удалённые. Номер темы, которую кто-то уже
// грумит, занят, даже если ни записи, ни досье в главном дереве ещё нет.
function groomBranches(root) {
  const out = []
  const line = gitLine(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/groom/', 'refs/remotes/*/groom/'])
  if (!line) return out
  for (const ref of line.split('\n')) {
    const m = /(?:^|\/)groom\/(G-\d+)(?:[-/]|$)/.exec(ref.trim())
    if (m) out.push({ id: m[1], branch: ref.trim() })
  }
  return out
}

export function nextGroomId(root) {
  let max = 0
  for (const id of usedGroomIds(root).keys()) {
    const n = Number(GROOM_ID_RE.exec(id)[1])
    if (n > max) max = n
  }
  return `G-${String(max + 1).padStart(3, '0')}`
}

function gitLine(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

// Состояние одной темы: объявленное человеком — из записи, фактическое — из git и ФС.
// `null` в поле означает «не смог узнать», а не «нет»: git в песочнице отказывает, и
// выдавать отказ за ноль нельзя (И-12).
export function groomState(root, rec, config = null) {
  const branch = rec.branch || (rec.slug ? groomBranch(rec.id, rec.slug) : null)
  const path = rec.worktree || (rec.slug ? join(groomWorktreesDir(root, config), `${rec.id}-${rec.slug}`) : null)
  const trees = listWorktrees(root)
  const worktree_alive = trees.length
    ? trees.some((w) => (path && w.path === path) || (branch && w.branch === branch))
    : null
  const branch_exists = branch ? gitLine(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null : false
  const base = rec.base || 'main'
  let commits_ahead = null
  if (branch_exists) {
    const n = gitLine(root, ['rev-list', '--count', `${base}..${branch}`])
    commits_ahead = n === null || n === '' ? null : Number(n)
  }
  // Досье ищется СНАЧАЛА в дереве груминга и только потом в главном, и порядок тут
  // несущий: пока тема не ушла на планирование, досье живёт на ветке груминга и в главном
  // дереве его нет вовсе. Смотреть только в главное значило бы считать ненаписанным всё,
  // что ещё не влито, — то есть ровно всю работу груминга.
  const rel = rec.slug ? join('docs', 'backlog', `${rec.id}-${rec.slug}`) : null
  let dossier = null
  let dossier_in = null
  if (rel && path && existsSync(join(path, rel))) {
    dossier = rel
    dossier_in = 'дерево груминга'
  } else if (rel && existsSync(join(root, rel))) {
    dossier = rel
    dossier_in = 'главное дерево'
  }
  return {
    ...rec,
    branch,
    worktree: path,
    worktree_alive,
    branch_exists,
    commits_ahead,
    dossier,
    dossier_in,
  }
}

export function groomView(root, config = null) {
  return listGroom(root).map((rec) => (rec._broken ? rec : groomState(root, rec, config)))
}

// ── Стоимость разведки по темам ───────────────────────────────────────────────
//
// Четвёртый замер движка, и он того же устройства, что три прежних: код возврата ноль
// всегда, порогов нет, находка замера — кандидат, решение за человеком (ADR-0009).
//
// Зачем. Разведка — единственная стадия маршрута, про которую нельзя было сказать, во что
// она обошлась. События её стадий до 0.4.105 писались с `ticket: MR` и `change: null`:
// дырой это не было (`doctor` зелёный, привязка достраивалась по `agent_id`), но мерить
// было нечего — ретро поставки проект-В 3.2 пришлось спаривать события по `agent_id`,
// потому что спаривать больше было не по чему. Теперь привязка есть (`FIRM2-GROOM`), и
// замер читает её напрямую.
//
// Пары считаем по `agent_id`, а не по (теме, стадии): у темы три роли пишут ОДНУ стадию
// `groom`, и пара «старт-финиш» различается только субагентом. Это тот же довод, по
// которому так считает `stageDurations`.
//
// Чего здесь нет намеренно. Числа по моделям, разбивки по приёмам и доли кэша: счёт
// контекста ведёт `context-bill.mjs`, и дублировать его тут значило бы иметь два ответа
// на один вопрос. Здесь — сколько стоила ТЕМА: заходы, токены, календарь, работа, кто
// вёл. Порога «дорогая тема» нет и не будет без замера, который его предъявит.
export function groomCost(root) {
  const events = listEvents(root, {}).filter((e) => !e._broken && /^G-/.test(String(e.ticket || '')))
  const byAgent = new Map()
  for (const e of events) {
    if (!e.agent_id) continue
    if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, [])
    byAgent.get(e.agent_id).push(e)
  }
  const themes = new Map()
  const take = (id) => {
    if (!themes.has(id)) {
      themes.set(id, {
        id, runs: 0, open_runs: 0, tokens: 0, ctx_peak: 0, calls: 0,
        work_ms: 0, wait_ms: 0, tool_ms: 0, first: null, last: null, actors: {},
      })
    }
    return themes.get(id)
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    const s = list.find((e) => e.event === 'started')
    const f = [...list].reverse().find((e) => e.event !== 'started')
    const any = s || f
    const t = take(String(any.ticket))
    const actor = String((f || any).actor || 'неизвестно')
    t.actors[actor] = (t.actors[actor] || 0) + 1
    t.runs += 1
    // Токены несёт финиш: на старте транскрипта ещё нет, и счёта в нём быть не может.
    // Финишей у одного захода бывает несколько, и каждый несёт ПОЛНЫЙ счёт заново —
    // поэтому берём самый большой, а не сумму и не последний по времени (см.
    // latestPerAgent: это та же защита от двойного счёта, здесь в своей сетке).
    const tk = list.reduce((best, e) => {
      if (e.event === 'started' || !e.tokens) return best
      return !best || (e.tokens.total || 0) > (best.total || 0) ? e.tokens : best
    }, null)
    if (tk) {
      t.tokens += Number(tk.total) || 0
      t.calls += Number(tk.calls) || 0
      t.wait_ms += Number(tk.wait_ms) || 0
      t.tool_ms += Number(tk.tool_ms) || 0
      t.ctx_peak = Math.max(t.ctx_peak, Number(tk.ctx_peak) || 0)
    }
    // Незакрытый заход считаем отдельно, а не нулём работы: открытый интервал — это
    // «идёт сейчас» или «сессию сняли», и выдавать его за ноль значит занижать замер.
    if (s && f && s.ts && f.ts) {
      const ms = Date.parse(f.ts) - Date.parse(s.ts)
      if (ms > 0) t.work_ms += ms
    } else {
      t.open_runs += 1
    }
    for (const e of list) {
      if (!e.ts) continue
      if (!t.first || e.ts < t.first) t.first = e.ts
      if (!t.last || e.ts > t.last) t.last = e.ts
    }
  }
  const rows = [...themes.values()].sort((a, b) => b.tokens - a.tokens)
  for (const r of rows) {
    r.calendar_ms = r.first && r.last ? Date.parse(r.last) - Date.parse(r.first) : 0
    // Сколько записи о теме знает сам бэклог: заголовок полезнее номера, а статус
    // отвечает на вопрос «за что уже заплачено» — брошенная тема стоит столько же.
    const rec = readGroom(root, r.id)
    r.title = rec && rec.title ? rec.title : null
    r.status = rec && rec.status ? rec.status : null
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  return {
    themes: rows.length,
    runs: sum('runs'),
    tokens: sum('tokens'),
    work_ms: sum('work_ms'),
    wait_ms: sum('wait_ms'),
    tool_ms: sum('tool_ms'),
    per_theme: rows,
  }
}

// Человеческий вид замера. Числа те же, порядок тот же; «—» означает, что события стадий
// разведки в журнале нет вовсе, а не что она была бесплатной.
export function groomCostLines(c) {
  const h = (ms) => `${(ms / 3600000).toFixed(1)} ч`
  const m = (n) => `${(n / 1e6).toFixed(1)}M`
  if (!c.themes) {
    return [
      'разведка: событий стадий в журнале нет',
      '  это не «бесплатно», а «не записано»: маркер FIRM2-GROOM кладёт /firm-discovery,',
      '  и у тем, прогрумленных до 0.4.105, его в промптах не было',
    ]
  }
  const out = [
    `разведка: тем ${c.themes}, заходов ${c.runs}, токенов ${m(c.tokens)}, ` +
    `работа ${h(c.work_ms)}, ожидание ${h(c.wait_ms)}, инструменты ${h(c.tool_ms)}`,
    '',
  ]
  for (const r of c.per_theme) {
    out.push(
      `  ${r.id}${r.status ? ` (${r.status})` : ''} ${r.title ? `— ${r.title}` : ''}`.trimEnd(),
      `    заходов ${r.runs}${r.open_runs ? ` (незакрытых ${r.open_runs})` : ''}, ` +
      `токенов ${m(r.tokens)}, пик окна ${r.ctx_peak || '—'}, работа ${h(r.work_ms)}, ` +
      `календарь ${h(r.calendar_ms)}`,
      `    кто вёл: ${Object.entries(r.actors).map(([a, n]) => `${a}×${n}`).join(', ') || '—'}`,
    )
  }
  return out
}

// Расхождения объявленного с фактическим. Молчать о них нельзя ровно по тому же доводу,
// по которому не молчит `active_change_findings`: человек объявил одно, движок видит
// другое, и дальше оба действуют по своей версии.
export function groomFindings(root, config = null) {
  const out = []
  for (const g of groomView(root, config)) {
    if (g._broken) {
      out.push(`${g.id}: ${g._broken}`)
      continue
    }
    if (!g.slug) out.push(`${g.id}: в записи нет слага — ни ветки, ни каталога досье не посчитать`)
    if (g.status === 'groomed' && !g.dossier) {
      out.push(`${g.id} объявлен прогрумленным, а досье нет: ждём ${g.slug ? `docs/backlog/${g.id}-${g.slug}` : 'каталог досье'}`)
    }
    if (g.status === 'planned' && g.worktree_alive) {
      out.push(`${g.id} уже на планировании, а дерево груминга живо: ${g.worktree} — снести, когда работа влита`)
    }
    if (g.status === 'grooming' && g.worktree_alive === false) {
      out.push(`${g.id} в работе, а дерева нет: ${g.worktree} — груминг продолжать некуда`)
    }
  }
  // Номер занят, а учётной записи нет — тему завели мимо `groom new` (Д-15). Выдавать его
  // движок больше не станет, но сказать об этом надо: `groom list` такую тему не покажет,
  // стадии разведки не привяжутся к ней маркером, и в замер `groom cost` она не попадёт.
  // Молчание здесь — это ровно то, из-за чего два номера в проект-В разошлись по две темы.
  const known = new Set(listGroom(root).map((r) => r.id))
  for (const [id, where] of usedGroomIds(root)) {
    if (known.has(id)) continue
    out.push(
      `${id}: номер занят (${where.join(', ')}), а учётной записи нет — тема заведена мимо ` +
        `\`groom new\`. Номер движок переиспользовать не станет, но темы он не знает: её нет ` +
        `в \`groom list\`, стадии к ней не привяжутся и в замер \`groom cost\` она не войдёт`,
    )
  }
  return out
}

// ——— Браузерный критерий не закрывается пропуском ———
//
// Разбор проект-В 11.10.2026, T-089. Коммит стадии назывался «живой прогон не выполнен,
// браузер недоступен», и это было написано честно — а стадия всё равно закрылась зелёной:
// браузерная проверка делает `t.skip("окно не поднялось")`, набор выходит с кодом 0.
// То есть критерий, который по метке `требует-браузера` закрывается ТОЛЬКО живым прогоном,
// на стадии не проверил никто.
//
// Чего эта находка НЕ спасает, и это стоит знать, чтобы не переоценивать её: гейт поставки
// в том же проекте пропуск уже ловит (`test_no_live_check_passed_without_running` требует
// «пропущено 0» и своих условий пропуска не имеет). Непроверенное не уезжало и не уедет.
// Выигрыш — в месте: гейт краснеет ПОСЛЕ ВСЕХ СТАДИЙ, а находка возвращает стадию в работу
// сразу, на тридцать девятой секунде вместо конца прогона. Проект без такого гейта получает
// заодно и защиту, но рассчитывать надо на первое.
//
// Проверка про пропуски у движка уже есть (`firm-event.mjs`, разбор 04.10.2026), но она
// требует лишь ОБЪЯСНЕНИЯ, и объяснение здесь было: «браузера на машине нет». Для обычной
// задачи этого достаточно — пропуск бывает законным. Для задачи с меткой `требует-браузера`
// он не бывает законным никогда: вся метка про то, что текстовый разбор за проверку не
// считается. Поэтому находка узкая — пересечение метки и пропуска по браузерной причине.
//
// Почему признак — слово в `skipped_why`, а не число. Пропуски бывают и чужие: на точке
// ветвления этой же поставки их пять, и они к браузеру отношения не имеют. Требовать от
// браузерной задачи ноль пропусков значило бы гнать роль снимать чужие пометки.
const BROWSER_SKIP_WHY = /браузер|browser|chrome|chromium|headless|окно не подня|display|дисплей/i

// Рецепт — замер этой же машины 11.10.2026, и он важнее запрета: без выхода роль пропустит
// проверку снова, просто опишет это другими словами.
//
//   системный Chrome 154 под песочницей не поднимается ни в одном режиме `--headless`:
//     `ProcessSingleton` требует unix-сокета, а `bind()` песочница отвечает «Operation not
//     permitted», и Chrome прекращает работу сам («Aborting now to avoid profile corruption»);
//   `chrome-headless-shell` с `--single-process` поднимается, и CDP через
//     `--remote-debugging-pipe` работает целиком: `Runtime.evaluate` отдал живой
//     `getBoundingClientRect` (144,83 px), `Page.captureScreenshot` — PNG;
//   `--no-sandbox` добавлять НЕЛЬЗЯ: с ним снова падение (`mach_port_rendezvous`).
export const BROWSER_RECIPE =
  'chrome-headless-shell с флагом --single-process — единственный замеренный способ поднять ' +
  'браузер под песочницей (CDP через --remote-debugging-pipe работает, Runtime.evaluate и ' +
  'Page.captureScreenshot тоже). Системный Chrome не поднимается ни в одном режиме --headless: ' +
  'ему нужен unix-сокет для ProcessSingleton, и песочница его запрещает. --no-sandbox не ' +
  'добавлять — с ним падает. Бинаря нет на машине — доустановку не делай сам (сеть закрыта), ' +
  'попроси человека выполнить один раз: npx -y @puppeteer/browsers install chrome-headless-shell@stable'

export function browserSkipFinding(task, so) {
  if (!task || !(task.labels || []).includes('требует-браузера')) return null
  const rep = (so && so.report) || null
  if (!rep || !(Number(rep.skipped) > 0)) return null
  const why = String((so && so.skipped_why) || '').trim()
  if (!BROWSER_SKIP_WHY.test(why)) return null
  return (
    `пропущено ${Number(rep.skipped)} тест(ов) по браузерной причине: «${why.slice(0, 120)}». ` +
    `Задача помечена «требует-браузера», и у этой метки один смысл: её критерии закрываются ` +
    `только живым прогоном. Пропуск оставляет критерий непроверенным, а стадию — зелёной. ` +
    BROWSER_RECIPE
  )
}

// ——— Чистка кэша плагина не трогает версию, на которой кто-то работает ———
//
// 11.10.2026: пятая за день доставка оставила в кэше три последних версии и снесла 0.4.73 —
// ту, на которой в этот момент шла сборка в проект-В. Рантайм берёт workflow плагина ИЗ КЭША
// (`Workflow({scriptPath})` отклоняется, обойти кэш нечем), значит удаление каталога под
// идущим прогоном — это удаление сборщика на ходу. Цена ошибки в эту сторону — прогон на
// миллионы токенов; цена в обратную — два мегабайта на диске.
//
// Чего движок знать НЕ может: на какой версии стартовала сессия в чужом проекте. В конфиге
// записана та, которую поставил последний `/firm-adopt` (у проект-В — 0.4.75), а прогон шёл
// на 0.4.73, так что конфиг здесь не ответ. Надёжен только возраст: версия, установленная
// недавно, могла быть загружена идущей сессией.
//
// Окно — сутки, и это не круглое число для красоты: самый долгий замеренный прогон занял
// 6 ч 33 м календарного времени (поставка 3.1 на проект-В), то есть запас примерно
// трёхкратный. Задержанные версии не остаются навсегда: следующая доставка после того, как
// они остынут, снесёт их сама.
export const CACHE_HOLD_HOURS = 24

// Отказ `stat` трактуется ЗАКРЫТО (И-12): не узнали возраст — не знаем, что версия холодная,
// значит держим. «Не знаю» здесь не «можно удалять».
export function heldCacheVersions(entries, now = Date.now(), hours = CACHE_HOLD_HOURS) {
  const ms = Number(hours) * 3600000
  const out = []
  for (const e of entries || []) {
    if (!e || !e.version) continue
    // `Number(null)` — это 0, то есть «возраст неизвестен» прочиталось бы как «поставлена в
    // 1970-м, можно сносить»: ровно та инверсия, от которой предостерегает И-12. Поймано
    // тестом при первом же прогоне.
    const t = e.installed === null || e.installed === undefined || e.installed === '' ? NaN : Number(e.installed)
    if (!Number.isFinite(t) || now - t < ms) out.push(e.version)
  }
  return out
}

// ——— Короткая полоса: правка, которой стадии надзора не нужны ———
//
// Замер двух поставок проект-В: T-088 снимала одну строку пояснения вместе с ключом словаря —
// разработка 41 секунда, −12 строк в трёх файлах; тестирование 24 минуты 36 секунд, +175
// строк в двух новых файлах. На поставке скинов то же повторилось на T-101. Проект завёл
// своё правило (BR-138) и исполняет его РУКАМИ, в обход движка: стадии не открываются,
// событий нет, и в журнале такая работа выглядит пропавшей.
//
// Отсюда метка. Два решения в ней важнее самого ускорения:
//
//   1. МЕТКУ СТАВИТ ПЛАНИРОВАНИЕ, а не исполнитель на стадии. Исполнитель классифицирует
//      работу ДО того, как её сделал, — это та же классификация на глазок, из-за которой
//      «сдвинуть поле» становится задачей на день.
//   2. МЕТКА — ЗАЯВКА, КОТОРУЮ ПРОВЕРЯЕТ КОД. После стадии разработки движок смотрит
//      настоящий дифф ветки задачи: вышел за разрешённые пути — полоса отменяется, задача
//      идёт полным циклом. Иначе короткая полоса стала бы четвёртым способом пройти
//      проверку, не выполнив её, — рядом с пропуском теста, ожидаемым падением и маской
//      запуска, которые проект уже запретил своим BR-106.
//
// Разрешённые пути знает ПРОЕКТ: движок ведёт проекты с разными стеками и не может знать,
// что словарь лежит в `web/src/texts/`. Поэтому ключ `short_lane.paths` в `.firm/config`.
// Ключа нет — метка не делает ничего, и `lane-check` говорит об этом прямо: тихо
// пропускать стадии по ненастроенному правилу хуже, чем не пропускать вовсе.
export const SHORT_LANE_LABEL = 'короткая-полоса'

// Сколько строк можно удалить ВНЕ путей полосы и остаться мелкой правкой. Замер: T-088 —
// 12 строк в трёх файлах. Сорок — тот же порядок с запасом на «снять блок вместе с его
// стилями»; проект может сказать своё число ключом `short_lane.max_deleted_lines`.
export const SHORT_LANE_MAX_DELETED = 40

// Образец пути из конфига → регулярное выражение. Поддерживаются `*` (в пределах сегмента)
// и `**` (через сегменты); больше ничего не нужно, а каждый лишний приём образца — это
// лишний способ ошибиться в конфиге и получить незаслуженно короткую полосу.
const DOUBLE_STAR = '@@ANY@@'
export function laneGlob(pattern) {
  const p = String(pattern || '').trim()
  if (!p) return null
  const rx = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .split(DOUBLE_STAR)
    .join('.*')
  return new RegExp(`^${rx}$`)
}

export function laneAllows(paths, file) {
  for (const pat of paths || []) {
    const rx = laneGlob(pat)
    if (rx && rx.test(String(file))) return true
  }
  return false
}

// Состояние полосы по ЖИВОМУ диффу ветки задачи против ветки поставки.
//
// Отказ git трактуется закрыто (И-12): не смогли прочесть дифф — полоса не подтверждена.
// «Не знаю» здесь не «можно короче»: цена ошибки в эту сторону — принятая без надзора
// правка логики, в обратную — одна лишняя пара стадий.
// Дифф задачи, снятый МАШИНОЙ (Д-37). Список файлов — не утверждение исполнителя, а
// факт о ветке, и единственный, кто может назвать его верно, — тот, кто смотрит на ветку
// последним.
//
// Повод — три захода проект-В 31.10–01.11.2026, и ни один не был виной исполнителя. Маршрут
// просит Разработчика объявить файлы диффа в протоколе; после него по тому же дереву идёт
// Тестировщик и дописывает свои файлы проверок, иногда шаг слияния подтягивает чужую
// работу. Дифф растёт, объявление — нет, и Ревьюер сверяет объявление с КОНЕЧНЫМ
// состоянием ветки: `T-242` объявила восемь файлов при десяти (дописал Тестировщик,
// коммит b0ce342e) и получила блокирующий BUG-130; у `T-224` на этом кончились попытки,
// и задачу пришлось заменять при целой работе. Тестировщик расхождение ВИДЕЛ и записал
// находкой, но править чужой раздел не вправе — то есть роль, нашедшая ошибку, не могла
// её исправить. Повторение критерия словами проверено и не работает.
//
// `null` в поле означает «не смог узнать» (И-12): git в песочнице отказывает, и выдавать
// отказ за пустой дифф нельзя — пустой дифф это утверждение, а молчание git нет.
export function taskDiff(root, change, ticket, config = null) {
  const cfg = config || readConfig(root) || {}
  const range = `feature/${change}...task/${ticket}`
  const base = gitLine(root, ['merge-base', `feature/${change}`, `task/${ticket}`])
  const raw = gitLine(root, ['diff', '--numstat', range])
  if (raw === null) {
    return {
      ticket, base: base || null, files: null, added: null, deleted: null, uncommitted: null,
      why: `дифф ${range} прочитать не удалось: нет ветки задачи, нет поставки или git отказал`,
    }
  }
  const files = []
  let added = 0
  let deleted = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // Формат numstat: «<добавлено>\t<удалено>\t<путь>», а у двоичного файла вместо чисел
    // стоит «-». Прочерк читается как «не знаю», а не как ноль: двоичный файл изменён.
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    const a = m[1] === '-' ? null : Number(m[1])
    const d = m[2] === '-' ? null : Number(m[2])
    files.push({ path: m[3], added: a, deleted: d })
    if (a) added += a
    if (d) deleted += d
  }
  // Незакоммиченное в дереве задачи — отдельный ответ, а не часть диффа: Ревьюер судит
  // ветку, и файл, лежащий в дереве, для него не существует (agents/developer.md, шаг 4).
  // Но молчать о нём нельзя: четыре бага обкатки 01.10.2026 были ровно «написал и не
  // закоммитил», и выглядело это для Ревьюера как «тестов нет».
  let uncommitted = null
  const wt = join(worktreesDir(root, cfg), ticket)
  if (existsSync(wt)) {
    const dirty = gitLine(wt, ['status', '--porcelain'])
    uncommitted = dirty === null
      ? null
      : dirty.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^\S+\s+/, ''))
  }
  return { ticket, base: base || null, files, added, deleted, uncommitted, why: null }
}

export function shortLaneState(root, change, ticket, config = null) {
  const cfg = config || readConfig(root) || {}
  const paths = ((cfg.short_lane && cfg.short_lane.paths) || []).map(String)
  if (!paths.length) {
    return {
      configured: false, verdict: 'не настроена', outside: [], files: [],
      why:
        `метка «${SHORT_LANE_LABEL}» стоит, а ключа short_lane.paths в .firm/config нет — ` +
        'движок не знает, какие пути считать текстом, и полосу не даёт',
    }
  }
  const raw = gitLine(root, ['diff', '--name-only', `feature/${change}...task/${ticket}`])
  const out = raw === null ? null : raw.split('\n').map((x) => x.trim()).filter(Boolean)
  if (out === null || !out.length) {
    return {
      configured: true, verdict: 'не подтверждена', outside: [], files: [],
      why:
        'дифф ветки задачи против ветки поставки прочитать не удалось или он пуст — ' +
        'полоса не подтверждена (И-12: «не знаю» это не «можно короче»)',
    }
  }
  const files = out.filter(Boolean)
  let outside = files.filter((f) => !laneAllows(paths, f))
  // Файлы вне путей, у которых в диффе ТОЛЬКО удаления, полосу не отменяют.
  //
  // Замер по истории проект-В (13.10.2026): из последних сорока диффов стадии разработки под
  // пути текста, стилей и документации целиком не попал НИ ОДИН, а T-088 — та правка, из
  // которой короткая полоса и выросла, — упиралась в один `.tsx`. Правило о путях покупало
  // одну задачу из сорока, то есть почти ничего.
  //
  // Удаление — единственная правка кода, которой НЕЛЬЗЯ ввести логику: можно только убрать.
  // Поэтому «снять пояснение вместе с ключом словаря и осиротевшим стилем» (ровно BR-138
  // проекта) полоса теперь берёт, а «поправить условие» — по-прежнему нет, потому что
  // поправка это строка добавленная.
  //
  // Три границы, и каждая закрывает свой способ обойти правило:
  //   • хотя бы один файл диффа лежит ВНУТРИ путей. Иначе полосой уехало бы удаление
  //     целого модуля, не имеющее к тексту никакого отношения;
  //   • у каждого внешнего файла ноль добавленных строк. Двоичный файл git показывает как
  //     `-`, и это читается закрыто (И-12): не знаю — значит не полоса;
  //   • всего удалено не больше `short_lane.max_deleted_lines` строк вне путей (по
  //     умолчанию столько, сколько измерено у мелкой правки с запасом). Снос на тысячу
  //     строк — не мелкая правка, чем бы он ни был.
  let admitted = []
  if (outside.length) {
    const cap = Number((cfg.short_lane && cfg.short_lane.max_deleted_lines)) > 0
      ? Number(cfg.short_lane.max_deleted_lines)
      : SHORT_LANE_MAX_DELETED
    const stat = gitLine(root, ['diff', '--numstat', `feature/${change}...task/${ticket}`])
    const nums = new Map()
    if (stat !== null) {
      for (const line of stat.split('\n')) {
        const m = line.split('\t')
        if (m.length < 3) continue
        nums.set(m[2].trim(), { added: m[0].trim(), deleted: m[1].trim() })
      }
    }
    const inside = files.length - outside.length
    let deleted = 0
    const stays = []
    for (const f of outside) {
      const n = nums.get(f)
      const addedOnlyZero = n && n.added === '0' && /^\d+$/.test(n.deleted)
      if (addedOnlyZero) {
        deleted += Number(n.deleted)
        admitted.push(f)
      } else stays.push(f)
    }
    if (!inside || stays.length || deleted > cap) {
      // Хоть одна граница не выдержала — внешние файлы снова все внешние. Полумеры здесь
      // опаснее отказа: «часть файлов прошла» означало бы полосу для диффа, который её
      // не заслужил ни по одному из трёх условий.
      admitted = []
    } else {
      outside = []
    }
  }
  return {
    configured: true,
    verdict: outside.length ? 'отменена' : 'подтверждена',
    files,
    outside,
    deletions_only: admitted,
    why: outside.length
      ? `дифф вышел за пути короткой полосы (${outside.slice(0, 5).join(', ')}` +
        `${outside.length > 5 ? ` и ещё ${outside.length - 5}` : ''}) — задача идёт полным циклом`
      : admitted.length
        ? `дифф в путях короткой полосы, а вне них только удаления ` +
          `(${admitted.slice(0, 5).join(', ')}) — ввести логику удалением нельзя`
        : `дифф целиком в путях короткой полосы (${files.length} файл(ов)) — стадии надзора не нужны`,
  }
}

// ——— Масса репозитория: во что он превратился за двадцать поставок ———
//
// Маршрут движка целиком про НОВОЕ поведение и назад не смотрит никогда: ни одна команда
// до 13.10.2026 не отвечала на вопрос «сколько проверок накопилось и сколько из них
// копии». Бардак становился виден только когда человек случайно замечал, что разработка
// идёт 41 секунду, а проверка — 24 минуты (проект-В, T-088). Решение об уборке при этом
// оставалось спором о впечатлениях: чисел не было ни у кого.
//
// Поэтому — замер. Он НЕ судит проект и ничего не чинит: он даёт четыре числа, по которым
// человек решает, пора ли заводить поставку-уборку.
//
// Что намеренно НЕ делается:
//   • не считается покрытие. Покрытие отвечает на «много ли проверено», а вопрос здесь
//     обратный — «не платим ли мы за одно и то же тридцать раз»;
//   • не анализируется смысл тестов. Признак копии — буквально одинаковые строки в трёх
//     и более файлах проверок: это механически, объяснимо человеку и не врёт про
//     намерение автора.
export const MASS_RATIO_LOUD = 2 // тестов во столько раз больше продукта → сказать
export const MASS_COPIED_LOUD = 25 // процент скопированных строк проверок → сказать
export const MASS_STAGE_LOUD = 3 // медиана стадии test во столько раз дольше dev → сказать
const MASS_MIN_FILES = 3 // в скольких файлах строка должна встретиться, чтобы быть копией
const MASS_MIN_LEN = 20 // короткие строки копиями не считаем: это скобки и отступы

// Файл проверок или продукта. Проект может сказать прямо — `mass.test_paths` в
// `.firm/config` (образцы как у короткой полосы); не сказал — решает признак в пути.
// Признак нарочно грубый и один на все стеки: `tests/`, `test_x.py`, `x_test.go`,
// `x.test.ts`, `x.spec.rb`, `__tests__/`, `e2e/`. Движок ведёт проекты с разными
// стеками, и угадывать тоньше значило бы угадывать неверно по-разному в каждом.
const TEST_HINT = /(^|[/_.-])(tests?|specs?|__tests__|e2e)([/_.-]|$)/i
export function isTestPath(rel, config = null) {
  const pats = ((config && config.mass && config.mass.test_paths) || []).map(String)
  if (pats.length) return laneAllows(pats, rel)
  return TEST_HINT.test(String(rel))
}

// Значимая строка: та, за копирование которой действительно платят. Импорты, комментарии
// и закрывающие скобки повторяются в любом здоровом проекте, и находкой они быть не
// должны — иначе замер кричит там, где всё в порядке, и его перестают читать.
const MASS_NOISE = /^(import\b|from\b|#|\/\/|\/\*|\*|@|}|\)|\]|else\b|try:|pass\b|package\b|use\b|require\b)/
function significant(line) {
  const t = String(line).trim()
  if (t.length < MASS_MIN_LEN) return null
  if (MASS_NOISE.test(t)) return null
  return t
}

// Файлы кода проекта, относительными путями. Экспортируется ради разбора набора тестов
// (`lib/tests.mjs`): обход один на оба замера — массу репозитория и окупаемость тестов, —
// иначе они разошлись бы в том, что считают кодом.
export function listCodeFiles(root) {
  return walkCode(root)
}

function walkCode(root) {
  const out = []
  const walk = (dir, rel, depth) => {
    if (depth > 12) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue
      const next = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(join(dir, e.name), next, depth + 1)
        continue
      }
      const dot = e.name.lastIndexOf('.')
      if (dot > 0 && CODE_EXT.has(e.name.slice(dot))) out.push(next)
    }
  }
  walk(root, '', 0)
  return out
}

export function massState(root, config = null, events = null) {
  const cfg = config || readConfig(root) || {}
  const files = walkCode(root)
  const product = { files: 0, lines: 0 }
  const tests = { files: 0, lines: 0 }
  const heaviest = []
  // Строка → в скольких файлах проверок встретилась. Множество, а не счётчик: тридцать
  // повторов внутри ОДНОГО файла — это таблица случаев, нормальный приём, а не копия.
  const seen = new Map()
  const perFile = new Map()
  for (const rel of files) {
    let text
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    const n = lines.length
    if (!isTestPath(rel, cfg)) {
      product.files++
      product.lines += n
      continue
    }
    tests.files++
    tests.lines += n
    heaviest.push({ path: rel, lines: n })
    const own = new Set()
    for (const line of lines) {
      const sig = significant(line)
      if (sig) own.add(sig)
    }
    perFile.set(rel, own)
    for (const sig of own) {
      if (!seen.has(sig)) seen.set(sig, 0)
      seen.set(sig, seen.get(sig) + 1)
    }
  }
  heaviest.sort((a, b) => b.lines - a.lines)
  const copiedSet = new Set()
  for (const [sig, cnt] of seen) if (cnt >= MASS_MIN_FILES) copiedSet.add(sig)
  let copiedLines = 0
  const copiedByFile = []
  for (const [rel, own] of perFile) {
    let c = 0
    for (const sig of own) if (copiedSet.has(sig)) c++
    if (c) copiedByFile.push({ path: rel, copied: c })
    copiedLines += c
  }
  copiedByFile.sort((a, b) => b.copied - a.copied)
  const significantTotal = [...perFile.values()].reduce((s, x) => s + x.size, 0)
  const repeated = [...seen.entries()]
    .filter(([, c]) => c >= MASS_MIN_FILES)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([text, filesCount]) => ({ text: text.slice(0, 120), files: filesCount }))

  // Стадии из журнала: сравнение dev и test в минутах — то самое наблюдение, из которого
  // всё началось, только посчитанное, а не замеченное. Журнала нет — поля null, и это
  // честнее нуля (И-12).
  const evs = events || listEvents(root, {})
  const byStage = stageDurations(evs)
  const median = (xs) => {
    if (!xs || !xs.length) return null
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const stages = {}
  for (const st of ['dev', 'test', 'review']) {
    const xs = byStage.get(st) || []
    stages[st] = { n: xs.length, median_min: median(xs) === null ? null : Math.round(median(xs) * 10) / 10 }
  }

  const ratio = product.lines ? Math.round((tests.lines / product.lines) * 100) / 100 : null
  const copiedShare = significantTotal ? Math.round((copiedLines / significantTotal) * 1000) / 10 : null
  const findings = []
  if (ratio !== null && ratio >= MASS_RATIO_LOUD) {
    findings.push(
      `проверок в ${ratio} раза больше продукта (${tests.lines} строк против ${product.lines}) — ` +
        'каждая следующая задача гоняет всё накопленное, и её стадия платит проценты по предыдущим',
    )
  }
  if (copiedShare !== null && copiedShare >= MASS_COPIED_LOUD) {
    findings.push(
      `${copiedShare}% значимых строк проверок встречаются в трёх и более файлах — ` +
        'это обвязка и утверждения, скопированные вместо общего места',
    )
  }
  const d = stages.dev.median_min
  const t = stages.test.median_min
  if (d && t && t / d >= MASS_STAGE_LOUD) {
    findings.push(
      `медиана стадии test — ${t} мин против ${d} мин у dev (в ${Math.round((t / d) * 10) / 10} раза): ` +
        'надзор дороже работы, и это повод не за тесты, а за их устройство',
    )
  }
  return {
    product,
    tests,
    ratio,
    copied: { lines: copiedLines, significant: significantTotal, share_pct: copiedShare },
    heaviest: heaviest.slice(0, 10),
    copied_files: copiedByFile.slice(0, 10),
    repeated,
    stages,
    findings,
  }
}

export function massLines(m) {
  const out = []
  out.push(`продукт: ${m.product.lines} строк в ${m.product.files} файлах`)
  out.push(`проверки: ${m.tests.lines} строк в ${m.tests.files} файлах` + (m.ratio === null ? '' : ` (×${m.ratio})`))
  if (m.copied.share_pct !== null) {
    out.push(`скопировано: ${m.copied.share_pct}% значимых строк проверок (${m.copied.lines} из ${m.copied.significant})`)
  }
  const s = m.stages
  out.push(
    `стадии по журналу (медиана): dev ${s.dev.median_min === null ? '—' : s.dev.median_min + ' мин'}` +
      `, test ${s.test.median_min === null ? '—' : s.test.median_min + ' мин'}` +
      `, review ${s.review.median_min === null ? '—' : s.review.median_min + ' мин'}`,
  )
  if (m.heaviest.length) {
    out.push('', 'самые тяжёлые файлы проверок:')
    for (const h of m.heaviest.slice(0, 5)) out.push(`  ${h.lines} строк  ${h.path}`)
  }
  if (m.repeated.length) {
    out.push('', 'строки, повторённые в трёх и более файлах проверок:')
    for (const r of m.repeated.slice(0, 5)) out.push(`  ×${r.files}  ${r.text}`)
  }
  if (m.findings.length) {
    out.push('', 'находки:')
    for (const f of m.findings) out.push(`  • ${f}`)
  } else {
    out.push('', 'находок нет: масса проверок в пределах измеренного')
  }
  return out
}
