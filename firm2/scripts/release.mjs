#!/usr/bin/env node
// Доставка версии одной командой: рубеж → версия → запись в CHANGELOG → коммит → push →
// синхронизация кэша плагина → чистка старых версий из кэша.
//
// Поставлен 09.10.2026 по ретро сессии, в которой этот ритуал прогнали трижды руками.
// Каждый раз одинаково и каждый раз заново: bump-version, потом одноразовый python-врез в
// CHANGELOG по строке-якорю, потом commit/push, потом две команды `claude plugin`. Пятый
// шаг — чистку кэша — не вспомнил никто, пока человек не показал, что версий там десяток.
//
// Почему это один скрипт, а не пять строк в CLAUDE.md: четыре из шести шагов
// детерминированы целиком, а забытый последний шаг стоит дороже всех — прогон уходит по
// старому сборщику из кэша, и это самый дорогой вид отставания.
//
//   node scripts/release.mjs --notes <файл|-> --message <файл|->
//   node scripts/release.mjs minor --notes notes.md --message msg.txt
//   node scripts/release.mjs --notes - --message msg.txt --dry-run
//
// --notes    тело записи CHANGELOG: markdown БЕЗ заголовка версии, его пишет скрипт.
// --message  полное сообщение коммита (тема, пустая строка, тело, трейлеры).
// `-` читает из stdin; дважды `-` нельзя — поток один.
//
// Рубеж живёт там же, где и раньше, — внутри bump-version.mjs; `--no-preflight`
// пробрасывается в него без изменения смысла.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { heldCacheVersions, CACHE_HOLD_HOURS } from './lib/firm.mjs'

// Маркетплейс и плагин заданы здесь, а не выведены из окружения, намеренно: это имена
// локальной установки (`firm2@firm2` в installed_plugins.json), и если они
// изменятся, то вместе с этим скриптом, а не втихую.
const MARKETPLACE = 'firm2'
const PLUGIN = 'firm2'
// Сколько версий оставлять в кэше. Три, а не две, и причина не в ностальгии: пока в
// каком-то проекте идёт сборка, её сессия держит workflow той версии, на которой
// запускалась, и БЕРЁТ ЕГО ИЗ КЭША — обойти кэш нечем (`Workflow({scriptPath})` рантайм
// отклоняет). Хуки в этом смысле безопасны: они заданы через `${CLAUDE_PLUGIN_ROOT}` и
// разрешаются на каждый вызов (проверено на идущей сборке проект-В 11.10.2026).
//
// Трёх версий, однако, мало: 11.10.2026 пятая за день доставка снесла 0.4.73 — ту, на
// которой в этот момент шёл прогон. Поэтому к счёту добавлено ОКНО ПО ВОЗРАСТУ
// (`heldCacheVersions`): версия, установленная меньше суток назад, не удаляется, сколько бы
// версий ни вышло поверх. Установленная сейчас не удаляется ни при каких условиях.
const KEEP = 3

const here = fileURLToPath(new URL('.', import.meta.url))
const engine = join(here, '..')
const root = join(engine, '..')
const manifest = join(engine, '.claude-plugin', 'plugin.json')
const changelog = join(engine, 'CHANGELOG.md')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry-run')
// Шаги 5–6 отдельно от остальных. Нужны ровно тогда, когда доставка оборвалась на push-е
// или на `claude plugin`: коммит уже сделан, версия поднята, повторять их нельзя — а кэш
// синхронизировать всё ещё надо. Раньше скрипт в этом случае советовал две команды руками,
// то есть возвращал человека к тому, из-за чего и писался.
const syncOnly = argv.includes('--sync-only')
// Доставка без подъёма версии. Нужна для правок в одном `scripts/`: их читают по
// `engine_root`, то есть прямо из исходника, и версии они не ждут. А версию живые проекты
// видят — `engine_version` в `.firm/config` сверяется с фактической, расхождение показывает
// `firm-state phase` и снимает `/firm-adopt`. Поэтому лишняя версия — это запрос на
// действие во все проекты под firm2, и выбор «версия, которой никто не просил» против
// «коммит мимо рубежа» был ложным: рубеж здесь идёт и без подъёма.
const noBump = argv.includes('--no-bump')
const kind = argv.find((a) => /^(patch|minor|major)$/i.test(a)) || 'patch'

function opt(name) {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1] || null
}

// Первая строка сообщения об ошибке: вывод git-а многострочный, а в сводку шага нужна
// причина, а не простыня.
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || ''

function die(msg) {
  process.stderr.write(`\n[release] ${msg}\n`)
  process.exit(1)
}

const notesArg = opt('--notes')
const messageArg = opt('--message')
const needNotes = !syncOnly && !noBump
if (noBump && notesArg) {
  die('--no-bump и --notes вместе не работают: без новой версии у записи CHANGELOG нет\n'
    + '          заголовка, под который её класть. Запись к уже выпущенной версии правится руками.')
}
if ((needNotes && !notesArg) || (!syncOnly && !messageArg)) {
  process.stdout.write(
    'Доставка версии одной командой.\n\n' +
      '  node scripts/release.mjs [patch|minor|major] --notes <файл|-> --message <файл|->\n' +
      '                           [--no-preflight] [--dry-run]\n\n' +
      '  --notes    тело записи CHANGELOG (markdown без заголовка версии)\n' +
      '  --message  сообщение коммита целиком\n' +
      '  `-` читает из stdin, но только для одного из двух.\n\n' +
      '  --no-bump    доставка без подъёма версии (правка только в scripts/): рубеж, коммит,\n' +
      '               push, кэш — но без записи в CHANGELOG, ей не на что опереться\n' +
      '  --sync-only  повторить только шаги с кэшем после оборвавшейся доставки\n',
  )
  process.exit(notesArg || messageArg ? 1 : 0)
}
if (!syncOnly && notesArg === '-' && messageArg === '-') {
  die('stdin один: `-` можно отдать либо --notes, либо --message')
}

function readInput(arg, what) {
  if (arg === '-') {
    const text = readFileSync(0, 'utf8')
    if (!text.trim()) die(`${what}: stdin пуст`)
    return text.trim()
  }
  if (!existsSync(arg)) die(`${what}: файла нет — ${arg}`)
  const text = readFileSync(arg, 'utf8')
  if (!text.trim()) die(`${what}: файл пуст — ${arg}`)
  return text.trim()
}

const notes = needNotes ? readInput(notesArg, '--notes') : ''
const message = syncOnly ? '' : readInput(messageArg, '--message')

const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })

// Выпускать нечего — это не успех с нулём изменений, а почти наверняка забытый `git add`
// или не тот каталог. Останавливаемся до рубежа: он идёт минуту с лишним.
const dirty = syncOnly ? '' : git('status', '--porcelain').trim()
if (!syncOnly && !dirty) die('в рабочем дереве нет изменений — выпускать нечего')

let version = JSON.parse(readFileSync(manifest, 'utf8')).version
let pushed = true

const TOTAL = syncOnly ? 2 : noBump ? 5 : 6
let at = 0
const step = (text) => process.stdout.write(`\n[release ${++at}/${TOTAL}] ${text}\n`)

if (dry) {
  const plan = syncOnly
    ? [`claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${PLUGIN}`, `чистка кэша: оставить ${KEEP} последних`]
    : [
        noBump
          ? `рубеж${argv.includes('--no-preflight') ? ' — ПРОПУЩЕН' : ''}, версия остаётся ${version}`
          : `рубеж${argv.includes('--no-preflight') ? ' — ПРОПУЩЕН' : ''} + версия (${kind})`,
        ...(noBump ? [] : [`запись в CHANGELOG, ${notes.split('\n').length} строк`]),
        `git add -A && git commit (${message.split('\n')[0]})`,
        'git push',
        `claude plugin marketplace update ${MARKETPLACE} && claude plugin update ${PLUGIN}`,
        `чистка кэша: оставить ${KEEP} последних`,
      ]
  process.stdout.write(
    '[release] --dry-run, ничего не меняю. План:\n' +
      plan.map((s, i) => `  ${i + 1}. ${s}\n`).join('') +
      (syncOnly ? '\n' : `\nФайлов в изменениях: ${dirty.split('\n').length}\n`),
  )
  process.exit(0)
}

if (!syncOnly) {
// ── 1. Рубеж и версия ────────────────────────────────────────────────────────
// Своей формулы подъёма версии здесь нет намеренно: она одна, и живёт в bump-version.mjs.
// Новую версию узнаём чтением манифеста после подъёма, а не повторным вычислением, —
// иначе две копии правила разошлись бы на первом же `minor`.
if (noBump) {
  step(`рубеж (версия остаётся ${version})`)
  if (argv.includes('--no-preflight')) {
    process.stdout.write('        ПРОПУЩЕН по --no-preflight\n')
  } else {
    const r = spawnSync('node', [join(here, 'preflight.mjs')], { stdio: 'inherit' })
    if (r.status !== 0) die('рубеж не пройден — ничего не тронуто')
  }
} else {
  step(`рубеж и версия (${kind})`)
  const bump = spawnSync('node', [join(here, 'bump-version.mjs'), kind, ...argv.filter((a) => a === '--no-preflight')], {
    stdio: 'inherit',
  })
  if (bump.status !== 0) die('версия не поднята (см. вывод выше) — ничего не тронуто')
  version = JSON.parse(readFileSync(manifest, 'utf8')).version
}

// ── 2. Запись в CHANGELOG ────────────────────────────────────────────────────
// Вставка по первому `^## ` — то есть перед самой свежей записью, какой бы она ни была.
// Строку-якорь (`## 0.4.68 — 2026-10-09`) искать не надо: прошлая версия для этого скрипта
// не нужна, а угадывание её номера руками и было половиной ручной работы.
if (!noBump) {
step(`запись ${version} в CHANGELOG`)
const head = `## ${version} — ${new Date().toISOString().slice(0, 10)}`
const text = readFileSync(changelog, 'utf8')
if (text.includes(`## ${version} `)) {
  process.stdout.write(`        запись про ${version} уже есть — не дублирую\n`)
} else {
  const cut = text.search(/^## /m)
  if (cut === -1) die(`в CHANGELOG нет ни одной записи вида "## версия" — вставлять некуда`)
  writeFileSync(changelog, `${text.slice(0, cut)}${head}\n\n${notes}\n\n${text.slice(cut)}`)
}
}

// ── 3–4. Коммит и push ───────────────────────────────────────────────────────
// Сообщение отдаётся файлом, а не аргументом: в нём многострочное тело и трейлеры.
step('коммит')
const msgFile = join(mkdtempSync(join(tmpdir(), 'firm2-release-')), 'message.txt')
writeFileSync(msgFile, `${message}\n`)
try {
  git('add', '-A')
  git('commit', '-F', msgFile)
  process.stdout.write(`        ${git('log', '--oneline', '-1').trim()}\n`)
} catch (e) {
  die(`коммит не прошёл: ${e.message}\n          версия уже ${version} и запись в CHANGELOG уже сделана — поправить и коммитить руками`)
}

// Отказ push-а — предупреждение, а не провал, и это не снисходительность. Запущенный из
// песочницы Claude Code push падает закономерно: git берёт креденшлы через `gh`, а читать
// его конфиг песочница не даёт. Коммит при этом на месте, а шаги 5–6 работают с локальным
// репозиторием и от origin не зависят, — валиться здесь значило бы бросать доставку на
// середине из-за того, что чинится одной командой снаружи песочницы.
step('push')
try {
  git('push')
  process.stdout.write(`        ${git('status', '-sb').split('\n')[0]}\n`)
} catch (e) {
  pushed = false
  process.stdout.write(`        НЕ ВЫШЛО — ${firstLine(e.message)}\n`)
}
}

// ── 5. Кэш плагина ───────────────────────────────────────────────────────────
// Отсюда и до конца отказ — это предупреждение, а не провал: коммит уже в origin, а
// синхронизацию кэша можно повторить в любой момент. Падать здесь значило бы врать про
// состояние репозитория.
step('синхронизация кэша плагина')
let synced = true
for (const a of [['marketplace', 'update', MARKETPLACE], ['update', PLUGIN]]) {
  const r = spawnSync('claude', ['plugin', ...a], { encoding: 'utf8' })
  const ok = r.status === 0
  synced = synced && ok
  process.stdout.write(`        ${ok ? 'ok  ' : 'НЕ ВЫШЛО'} claude plugin ${a.join(' ')}\n`)
  if (!ok) process.stdout.write(`             ${(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || ''}\n`)
}

// ── 6. Чистка кэша ───────────────────────────────────────────────────────────
// Кэш плагина растёт на каждую версию и сам не убирается: за две недели обкатки там
// набралось десять каталогов. Установленную версию не трогаем ни при каких условиях —
// её путь прописан в installed_plugins.json, и удалить его значит сломать установку.
step('чистка кэша')
const cache = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE, PLUGIN)
const semver = (v) => v.split('.').map((n) => parseInt(n, 10) || 0)
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]
  return 0
}
let installed = null
try {
  const reg = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'))
  installed = (reg.plugins[`${PLUGIN}@${MARKETPLACE}`] || []).map((e) => e.version)
} catch {
  installed = null
}
if (!existsSync(cache)) {
  process.stdout.write('        кэша нет — нечего чистить\n')
} else if (installed === null) {
  // Не знаем, что установлено, — значит не знаем, что безопасно удалить. Молча оставить
  // лишнее дешевле, чем молча снести рабочую версию.
  process.stdout.write('        installed_plugins.json не прочитан — чистку пропускаю\n')
} else {
  const versions = readdirSync(cache).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(newer)
  // Возраст каталога в кэше = время установки: его создаёт `claude plugin update`, копируя
  // версию. Версия, поставленная меньше суток назад, могла быть загружена идущей сессией в
  // чужом проекте, а рантайм берёт workflow именно из кэша — см. `heldCacheVersions`.
  const held = new Set(heldCacheVersions(versions.map((d) => {
    let installed = null
    try {
      installed = statSync(join(cache, d)).mtimeMs
    } catch {
      installed = null
    }
    return { version: d, installed }
  })))
  const keep = new Set([...versions.slice(0, KEEP), ...installed, ...held])
  // Отказ удаления — предупреждение, а не падение, и причина тут та же, что у push-а:
  // песочница Claude Code не даёт писать в `~/.claude/plugins`, и вываливаться стеком на
  // последнем шаге после уже сделанной доставки — худшее из возможных поведений.
  const dropped = []
  const stuck = []
  for (const d of readdirSync(cache)) {
    if (keep.has(d)) continue
    try {
      rmSync(join(cache, d), { recursive: true, force: true })
      dropped.push(d)
    } catch (e) {
      stuck.push(`${d} (${e.code || firstLine(e.message)})`)
    }
  }
  // Задержанные показываем отдельно от просто оставленных: иначе человек видит в кэше
  // лишние версии и не понимает, почему чистка их не взяла.
  const warm = [...held].filter((d) => !versions.slice(0, KEEP).includes(d)).sort(newer)
  process.stdout.write(
    `        оставлено: ${[...keep].sort(newer).join(', ')}` +
      (dropped.length ? `; снесено: ${dropped.sort(newer).join(', ')}` : '; сносить нечего') +
      (warm.length
        ? `\n        задержано как возможно работающие: ${warm.join(', ')} — моложе ${CACHE_HOLD_HOURS} ч;` +
          ` снесёт следующая доставка, когда остынут`
        : '') +
      (stuck.length ? `\n        НЕ УДАЛИЛОСЬ: ${stuck.join(', ')} — повторить снаружи песочницы` : '') +
      '\n',
  )
}

process.stdout.write(
  `\n[release] ${version}${noBump ? ' (версия не менялась)' : ''} ${pushed && synced ? 'доставлена' : 'доставлена не до конца'}.\n` +
    (pushed ? '' : '          PUSH НЕ ПРОШЁЛ — коммит только локально: git push (из песочницы он не выйдет).\n') +
    (synced ? '' : '          Кэш синхронизировать не удалось — повторить две команды claude plugin вручную.\n') +
    // Сборщик назван тут отдельно по замеру проект-В 10.11.2026: в одной сессии прошли три
    // волны подряд, новая версия приехала в кэш между первой и второй, и все три шли по
    // старому сборщику. «Новая волна» не равно «новый сборщик» — граница у него сессия.
    '          Команды, роли И WORKFLOW-СБОРЩИК новая версия отдаёт в НОВОЙ сессии: в текущей\n' +
    '          остались описания со старта, и новая волна сборщик НЕ подхватит — граница сессия.\n',
)
