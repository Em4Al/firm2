#!/usr/bin/env node
// firm-state — чтение состояния поставки. Ничего не меняет, кроме уборки worktree
// по явной команде. Команды маршрута (firm-setup / firm-discovery / firm-plan / firm-build)
// выводят фазу отсюда, а не из отдельного state.json: второй источник истины
// однажды разойдётся с файлами (§3).

import { existsSync, readdirSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import {
  repoRoot, readConfig, projectSignals, computeBoard, listBugs,
  worktreesDir, listWorktrees, ticketFromBranch, humanDuration, listEvents,
  nextIds, duplicateIds, activeChange as activeChangeOf, pauseFilePath, pauseState, planShape, vcsFindings,
  inFlightTickets, activeChangeFindings, engineVersionState, engineVersionFindings,
  criteriaFindings, criteriaLines, listTasks, standardsState, standardsFindings, designFile,
  nextBr, nextAdr, brFindings, releaseId,
  designDoc, declaredFrozen, boundaryFindings,
  userPathState, userPathFindings, userPathLines,
  groomCost, groomCostLines,
  standardsFor, standardsForLines,
  shortLaneState, taskDiff, SHORT_LANE_LABEL, massState, massLines,
  groomView, groomFindings, groomWorktreesDir, groomFromBranch, groomBranch,
  readGroom, writeGroom, nextGroomId, usedGroomIds, groomClaims, GROOM_STATUSES,
  writeEvent, stageBudget, isEngineTree, requireKnownFlags, laneCaps, lanesOf, laneWarnings,
  TASK_CLOSED, isClosedTask } from './lib/firm.mjs'

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
// Текст подсказки — один на `--help` и на вызов без подкоманды.
function usageText() {
  return [
        'firm-state — состояние поставки firm2 (только чтение, кроме prune)',
        '',
        '  phase     [--change X]   признаки проекта, артефакты, какая команда следующая',
        '  board     [--change X]   доска задач со статусами из событий',
        '  next      [--change X]   какие задачи можно запускать прямо сейчас',
        '  orphans                  worktree, оставшиеся от закрытых задач',
        '  prune     [--dry-run]    снести осиротевшие worktree (сухой прогон — только назвать)',
        '  config                   разобранный .firm/config',
        '  models                   модели ролей после разбора секции models:',
        '  dep <имя>                пин версии зависимости из секции dependencies',
        '  build-args [--change X]  готовый args для Workflow сборки (передать как есть)',
        '  next-id [--kind task|bug|br|adr] [--count N] [--peek] [--claim] [--by кто]',
        '  next-id --release BUG-175   снять броню с номера, которым ничего не названо',
        '                 вид, которого движок не распределяет, — ОТКАЗ (exit 2), а не номер задачи',
        '                           свободные номера, сквозные по всему проекту;',
        '                           br — номера бизнес-правил из docs/product/ (их берёт PM);',
        '                           номер БАГА выдаётся с бронью в .firm/ids/ — второму',
        '                           зовущему он уже не достанется; --peek смотрит без брони,',
        '                           --claim бронирует и номера задач',
        '  pause [--reason "..."]   доработать начатое и не брать новых задач',
        '  resume                   снять паузу',
        '  plan-shape [--change X]  за сколько волн пройдёт поставка и чего это стоит',
        '  criteria   [--change X]  проверяемы ли критерии приёмки: числа без замера, стенд',
        '  user-path  [--change X]  путь пользователя по шагам: непрерывен ли он и чем',
        '                           каждый шаг разрешён и сделан. Восьмой вход ворот 1 и',
        '                           единственный, видящий ОТСУТСТВИЕ шага',
        '  boundaries [--change X] [--base ref --branch ref]',
        '                           объявленные в тех-спеке неизменными файлы против диффа',
        '                           поставки: что сказано «НЕ меняется», то не тронуто',
        '  settled    [--change X]  какие задачи в поставке есть и какие влиты СЕЙЧАС',
        '                           (зовёт идущий прогон: его список снят на старте)',
        '  mass                     масса репозитория: строки продукта против строк проверок,',
        '                           доля скопированных строк, медианы стадий по журналу',
        '  standards [--ticket T-XXX | --files a,b]',
        '                           какие файлы docs/standards/ относятся к этой правке:',
        '                           отбор по paths во frontmatter против файлов диффа',
        '  task-diff --ticket T-XXX   дифф задачи от точки ветвления, снятый машиной:',
        '                             файлы с числами строк и незакоммиченное в её дереве',
        '  lane-check --ticket T-XXX  заслужила ли задача короткую полосу: метка плюс',
        '                           настоящий дифф ветки против путей short_lane.paths',
        '  paused                   стоит ли пауза сейчас',
        '  adopt                    принять текущую версию движка в .firm/config',
        '  groom list               темы в разборе: статус, дерево, досье, расхождения',
        '  groom cost               во что обошлась разведка по темам: заходы, токены, время',
        '  groom new --title "..." [--slug x] [--release 3.2]',
        '                           выдать номер, завести ветку и дерево груминга от main',
        '  groom set G-XXX [--status grooming|groomed|planned] [--release ...] [--title ...]',
        '  groom land G-XXX         влить ветку груминга в базу и отдать дерево (на /firm-plan)',
        '  groom retire G-XXX       отдать дерево груминга, не вливая (статус planned)',
        '',
        'Флаг --json — машинный вывод.',
      ].join('\n') + '\n'
}

// Подсказка команды. Её же печатает `--help`, и это не удобство: вызов, которым спрашивают
// «что ты умеешь», обязан отвечать подсказкой, а не делать работу по умолчанию. 08.11.2026
// на проект-В `prune --help` снёс два рабочих дерева (Д-61).
// Неизвестный флаг — отказ, а не умолчание: правило одно на все CLI движка (lib/firm.mjs).
requireKnownFlags(process.argv.slice(2), ['actor', 'base', 'branch', 'by', 'change', 'claim', 'count', 'dry_run', 'files', 'id', 'kind', 'out', 'peek', 'reason', 'release', 'slug', 'status', 'ticket', 'title'], { cmd: 'firm-state.mjs', usage: usageText() })
const root = args.root ? String(args.root) : repoRoot()
const cfg = readConfig(root) || {}
const parallelism = Number(cfg.parallelism) > 0 ? Number(cfg.parallelism) : 3
// Потолки полос одновременности: «метка → сколько стадий этой полосы вести разом».
// Ключа нет — пусто, и планировщик работает как раньше (lib/firm.mjs, laneCaps).
const LANE_CAPS = laneCaps(cfg)

function out(obj, text) {
  if (args.json || !text) process.stdout.write(JSON.stringify(obj, null, 1) + '\n')
  else process.stdout.write(text + '\n')
}

function activeChange() {
  if (args.change) return String(args.change)
  return activeChangeOf(root, { parallelism })
}

// Фаза выводится из наличия артефактов, а не хранится (§3).
// Версия движка. Пишется в `.firm/config` на preflight и до 22.09.2026 никем не читалась —
// то есть была украшением. Толк от неё ровно один: показать расхождение между тем, на какой
// версии проект заводили, и той, что фактически его ведёт. Расхождение не ошибка (обкатка
// как раз и означает, что движок меняется под проектом), но человек должен его видеть —
// иначе разбор дефекта начинается с вопроса «а на какой версии это было».
// Считается в lib (`engineVersionState`): с 0.4.74 о расхождении говорят ещё `doctor` и
// `build-args`, а три копии одного вычисления однажды разойдутся.
function engineVersion() {
  return engineVersionState(root, cfg)
}

// Принять новую версию движка: вписать фактическую в `.firm/config` и показать, что
// изменилось между записанной и текущей. Почему не автоматически при каждом запуске:
// автозапись стёрла бы единственный сигнал «движок сменился под проектом» — расхождение
// исчезало бы раньше, чем человек его увидит. Но и заставлять править файл руками глупо,
// это лишняя обрядность. Поэтому — явная команда: решение остаётся человеческим, труд
// механическим.
// Git-хук обновляется ЗДЕСЬ же, и это не попутная услуга, а закрытая дыра доставки.
// Хук не читается из движка по `engine_root` — он КОПИРУЕТСЯ в `.git/hooks/post-merge`
// один раз, на настройке проекта. Значит исправление хука не доезжало до проектов ничем:
// ни `/plugin update` (кэш плагина к `.git/hooks` отношения не имеет), ни подъёмом версии.
// 01.10.2026 ревью нашло в хуке нарушение И-4 — он писал «влито» по тексту рефлога, — и
// выяснилось, что во всех четырёх живых проектах лежит старая копия, и лежала бы вечно.
//
// Поэтому `adopt` сверяет копию с шаблоном и обновляет её. Прежняя сохраняется рядом
// (`post-merge.было-<версия>`): хук мог быть дописан под проект руками, и затирать чужую
// правку молча нельзя (И-12 — сказать, а не решить за человека).
// Хуков с 0.4.126 не один, а столько, сколько лежит в `templates/git-hooks/`, и список
// тут НЕ перечисляется поимённо намеренно: второй хук (`pre-commit`, второй слой сверки
// секретов — Д-48) добавился через месяц после первого, и поимённый список отстал бы
// ровно так же, как отставала копия самого хука.
function syncGitHooks() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const dir = join(here, '..', 'templates', 'git-hooks')
  let names = []
  try {
    names = readdirSync(dir).filter((f) => !f.startsWith('.')).sort()
  } catch {
    return { ok: false, reason: `не читается каталог шаблонов ${dir}` }
  }
  const per = names.map((name) => ({ name, ...syncOneHook(join(dir, name), join(root, '.git', 'hooks', name)) }))
  const bad = per.filter((h) => !h.ok)
  return {
    ok: bad.length === 0,
    changed: per.some((h) => h.changed),
    hooks: per,
    reason: bad.length ? bad.map((h) => `${h.name}: ${h.reason}`).join('; ') : undefined,
    note: bad.length ? undefined : per.map((h) => `${h.name}: ${h.note}`).join('; '),
  }
}

function syncOneHook(tpl, dst) {
  let want
  try {
    want = readFileSync(tpl, 'utf8')
  } catch {
    return { ok: false, reason: `не читается шаблон ${tpl}` }
  }
  let have = null
  try {
    have = readFileSync(dst, 'utf8')
  } catch { /* хука нет — поставим */ }
  if (have === want) return { ok: true, changed: false, note: 'хук совпадает с шаблоном' }
  const { recorded } = engineVersion()
  let backup = null
  if (have !== null) {
    backup = `${dst}.было-${recorded || 'неизвестно'}`
    try {
      writeFileSync(backup, have)
    } catch {
      backup = null
    }
  }
  try {
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(dst, want)
    chmodSync(dst, 0o755)
  } catch (e) {
    return { ok: false, reason: `не записался ${dst}: ${e.message}` }
  }
  return { ok: true, changed: true, path: dst, backup, note: have === null ? 'хук поставлен' : 'хук обновлён' }
}

// Ключи конфига, которые новая версия движка понимает иначе, чем старая. Сам конфиг
// `adopt` НЕ правит: он принадлежит проекту, и молча менять поведение проекта движок
// права не имеет (ADR-0007). Он называет расхождение — решает человек.
function configNotes() {
  const notes = []
  const long = Number(cfg && cfg.monitor && cfg.monitor.long_stage_min)
  if (long > 0) {
    notes.push(
      `monitor.long_stage_min: ${long} — с 0.4.57 движок считает порог «долгой стадии» отдельно ` +
      'для каждой стадии по журналу этого проекта, а этот ключ перекрывает расчёт для всех ' +
      'стадий сразу. Если он не ставился осознанно (в шаблоне конфига до 0.4.57 стояло 25) — убрать.',
    )
  }
  // Ключ, который до 0.4.72 не читался вовсе. Если он где-то стоит с тех времён — человек
  // имеет право знать, что теперь он СИЛЬНЕЕ расчёта движка: пока там имя закрытой или
  // переименованной поставки, активная поставка не определена, и доска будет пустой.
  const pin = cfg && cfg.active_change
  if (pin) {
    notes.push(
      `active_change: ${pin} — с 0.4.72 ключ ЧИТАЕТСЯ и перекрывает расчёт активной поставки ` +
      '(до этой версии он не делал ничего). Нужен только когда живых поставок больше одной; ' +
      'при одной — убрать. Имя, которого нет среди живых поставок, краснит doctor.',
    )
  }
  return notes
}

function adopt() {
  const { recorded, actual } = engineVersion()
  if (!actual) return { ok: false, reason: 'не читается plugin.json движка' }
  const hook = syncGitHooks()
  const config_notes = configNotes()
  if (recorded === actual) {
    return {
      ok: true, changed: hook.changed, version: actual, git_hook: hook,
      config_notes, note: 'версия уже совпадает',
    }
  }
  const file = join(root, '.firm', 'config')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: `не читается ${file}` }
  }
  const line = `engine_version: "${actual}"`
  const next = /^engine_version:\s*.*$/m.test(text)
    ? text.replace(/^engine_version:\s*.*$/m, line)
    : text.replace(/^(engine:\s*.*)$/m, `$1\n${line}`)
  writeFileSync(file, next)
  return {
    ok: true, changed: true, from: recorded, to: actual, git_hook: hook,
    config_notes,
    entries: changelogBetween(recorded, actual),
  }
}

// Заголовки разделов CHANGELOG движка между двумя версиями — чтобы «обновился до 0.4.14»
// читалось как «приехало вот это», а не как смена числа. Не читается — не беда: версия
// важнее списка, и отсутствие файла не повод отказывать в записи.
function changelogBetween(from, to) {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const lines = readFileSync(join(here, '..', 'CHANGELOG.md'), 'utf8').split('\n')
    const heads = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim())
    const idxTo = heads.findIndex((h) => h.startsWith(to))
    const idxFrom = heads.findIndex((h) => h.startsWith(from))
    if (idxTo < 0) return []
    return heads.slice(idxTo, idxFrom < 0 ? idxTo + 5 : idxFrom)
  } catch {
    return []
  }
}

function phase() {
  const sig = projectSignals(root)
  const change = activeChange()
  const dir = change ? join(root, 'openspec', 'changes', change) : null
  const has = (p) => (dir ? existsSync(join(dir, p)) : false)
  const brd = existsSync(join(root, 'docs', 'product')) &&
    readdirSync(join(root, 'docs', 'product')).some((f) => /^BRD-/.test(f))
  const tasks = change ? computeBoard(root, change, { parallelism }).tasks : []

  let next = 'firm-discovery'
  // Настройка выделена в отдельную команду (0.4.23): вопросы про окружение и вопросы
  // про бизнес-задачу — два разных разговора, и вперемежку они портят оба.
  if (!sig.firm_initialized) next = 'firm-setup'
  else if (!brd) next = 'firm-discovery'
  else if (!tasks.length || !has('design.md')) next = 'firm-plan'
  else if (tasks.some((t) => !isClosedTask(t))) next = 'firm-build'
  else next = 'поставка закрыта'

  const codegraph = existsSync(join(root, '.codegraph', 'graph.db'))
  return {
    root,
    ...sig,
    engine: cfg.engine || null,
    engine_version: engineVersion(),
    change,
    // Откуда взялась поставка: объявил человек или посчитал движок. Вопрос не
    // праздный — при двух живых поставках именно он отвечает, почему доска такая.
    change_from: cfg.active_change ? 'active_change из конфига' : 'расчёт движка',
    active_change_findings: activeChangeFindings(root),
    artifacts: { brd, design: has('design.md'), proposal: has('proposal.md'), tasks: tasks.length },
    codegraph_built: codegraph,
    // Стандарты кода проекта — вход оси Standards код-ревью. Здесь, рядом с остальными
    // признаками проекта: `phase` читают на настройке и перед каждой сессией маршрута,
    // то есть в те моменты, когда пустую ось ещё можно наполнить до прогона.
    standards: standardsState(root),
    standards_findings: standardsFindings(root),
    // Раньше всех: `phase` читает `/firm-build` на старте, а шаг выдачи — последний.
    // Пустой список значит «секции vcs нет или она сходится с репозиторием».
    vcs: vcsFindings(root, cfg || {}),
    next_command: next,
  }
}

// Форма плана: за сколько заходов конвейера пройдёт поставка. Команда нужна на воротах
// планирования — человеку и Архитектору, — потому что до неё ни один из них не видел
// разницы между «семьдесят пять задач» и «пятьдесят четыре захода по одной».
//
// Влитые задачи исключаются из счёта: на планировании их нет вовсе, а на сборке вопрос
// звучит «сколько ОСТАЛОСЬ», и ответ про уже сделанное был бы неверным.
function planShapeCmd() {
  const change = args.change || activeChange()
  if (!change) return { ok: false, reason: 'нет активной поставки' }
  const board = computeBoard(root, change, { parallelism })
  // Снятая задача — такая же закрытая, как отменённая: форма плана, посчитанная по ней,
  // отвечает про календарь, которого не будет (дефект 10.11.2026, проект-В).
  const done = board.tasks.filter(isClosedTask).map((t) => t.id)
  const shape = planShape(board.tasks, { parallelism, done })
  // ИМЯ ОБЯЗАНО ГОВОРИТЬ ПРАВДУ ПОСЛЕ ВЕРНОЙ ПРАВКИ. Поле звалось `merged` и считало
  // влитое — пока предикат был уже, имя совпадало со смыслом. После лечения выше оно
  // стало считать ЗАКРЫТОЕ ВООБЩЕ, и на живом проекте дало `merged: 43` при 39 влитых
  // (четыре снятых). На воротах поставки число влитых называют вслух, и такое расхождение
  // читается как сбой учёта (находка проект-В 10.11.2026, в тот же вечер).
  //
  // Отдаём ТРИ числа вместо переименования одного: «влито», «закрыто вообще» и «снято» —
  // это три разных вопроса, и на воротах звучат все три. Класс тот же, что у литеральных
  // копий: верная правка расходится не только с кодом рядом, но и с ИМЕНАМИ рядом.
  const mergedIds = board.tasks.filter((t) => ['merged', 'released'].includes(t.status))
  const supersededIds = board.tasks.filter((t) => t.status === 'superseded')
  return {
    ok: true,
    change,
    ...shape,
    merged: mergedIds.length,
    closed: done.length,
    superseded: supersededIds.length,
    note: 'волны считаются равными по времени, а они не равны: волна из одной ' +
      'исключительной задачи дешевле волны из трёх. Число отвечает на «где теряется ' +
      'календарь», а не «когда будет готово». `merged` — влито, `closed` — закрыто вообще ' +
      '(влитое плюс снятое и отменённое), и в волны не идёт ни одно из closed',
  }
}

function board() {
  const change = activeChange()
  if (!change) return { change: null, tasks: [], note: 'изменений (changes) нет' }
  const b = computeBoard(root, change, { parallelism })
  return {
    ...b,
    bugs: listBugs(root).filter((x) => !x.change || x.change === change),
    events: listEvents(root, { change }).length,
    tasks: b.tasks.map((t) => ({
      id: t.id, title: t.title, status: t.status, attempt: t.attempt,
      depends_on: t.depends_on, waiting_for: t.waiting_for, parallel_safe: t.parallel_safe,
      ui: t.ui, labels: t.labels, epic: t.epic, rel: t.rel, cache_stale: t.cache_stale,
      calendar: humanDuration(t.timing.calendar_ms), active: humanDuration(t.timing.active_ms),
      waiting: humanDuration(t.timing.waiting_ms),
      // «Без движения» — отдельное поле, а не часть ожидания: задача не влита, стадий по
      // ней не идёт, и это время ничем не занято. Внутри ожидания оно росло бы само.
      idle: t.timing.idle_ms ? humanDuration(t.timing.idle_ms) : null,
    })),
  }
}

// Какие задачи можно запускать прямо сейчас: зависимости в merged, свободны слоты,
// потолок parallelism. Не-parallel_safe задача занимает поток одна.
function next() {
  const b = board()
  if (!b.tasks || !b.tasks.length) return { change: b.change, start: [], reason: 'задач нет' }
  const active = b.tasks.filter((t) => ['in_progress', 'in_test', 'in_review', 'rework'].includes(t.status))
  const free = Math.max(0, parallelism - active.length)
  const ready = b.tasks.filter((t) => t.status === 'ready')
  const start = []
  if (!active.length) {
    const solo = ready.find((t) => !t.parallel_safe)
    if (solo && (!ready.length || ready[0].id === solo.id)) {
      // Не-parallel_safe задача идёт одна, чтобы не толкаться в общем дереве.
      start.push(solo)
      return { change: b.change, free_slots: free, start, exclusive: true }
    }
  }
  // Занятость полос считается по ИДУЩИМ задачам, и к ней дописываются взятые в этой же
  // волне: иначе потолок 1 пропустил бы сразу всех готовых — они ещё не активны.
  const laneUse = new Map()
  for (const t of active) for (const l of lanesOf(t, LANE_CAPS)) laneUse.set(l, (laneUse.get(l) || 0) + 1)
  const laneFull = (t) => lanesOf(t, LANE_CAPS).find((l) => (laneUse.get(l) || 0) >= LANE_CAPS[l]) || null
  const held = []
  for (const t of ready) {
    if (start.length >= free) break
    if (!t.parallel_safe) continue
    // Полоса — третье состояние между «со всеми» и «одна»: общий слот свободен, а место в
    // полосе может быть занято. Задача не отбрасывается, а ЖДЁТ: её берёт следующая волна,
    // когда полоса освободится (предложение проект-В 10.11.2026, разбор T-374).
    const busy = laneFull(t)
    if (busy) { held.push({ id: t.id, lane: busy, cap: LANE_CAPS[busy] }); continue }
    for (const l of lanesOf(t, LANE_CAPS)) laneUse.set(l, (laneUse.get(l) || 0) + 1)
    start.push(t)
  }
  // Последний запасной путь: слоты свободны, идущих нет, а взять нечего. Полоса его НЕ
  // отменяет — иначе потолок полосы превратился бы в тупик планировщика на задаче, которая
  // одна во всей поставке. Один в полосе при пустой машине — это ровно то, что потолок 1 и
  // разрешает.
  if (!start.length && !active.length && ready.length) start.push(ready[0])
  const res = { change: b.change, free_slots: free, start, exclusive: false }
  if (held.length) res.lane_held = held
  return res
}

// ── Модели ролей ──────────────────────────────────────────────────────────────
// Секция models: в .firm/config переопределяет модель, заданную во frontmatter роли.
// Ключ пропущен или 'inherit' — роль идёт на своей модели; так проект может поднять
// Разработчика на Opus целиком, не трогая общий промпт роли.

const MODEL_TIERS = new Set(['opus', 'sonnet', 'haiku'])
// Полное имя модели (`claude-sonnet-5-5`) допустимо наравне с алиасом: алиас `sonnet`
// рантайм разрешает в ту версию, которую считает текущей, и закрепить роль на другой —
// скажем, на следующей минорной, чтобы сравнить задержки, — иначе нельзя. Проверено
// 05.10.2026: `claude --model claude-sonnet-5-5` отвечает, предупреждая лишь, что id нет в
// таблице CLI. Форма проверяется строго (префикс `claude-`, суффикс `[1m]` допустим), а
// существование модели — нет: его знает только API, и опечатка в имени даст отказ там.
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]*(\[1m\])?$/
const ROLE_KEYS = [
  'pm', 'architect', 'designer', 'developer', 'developer_high_complexity',
  // `tester_high_complexity` — эскалация Тестировщика на метке high-complexity, по тому же
  // доводу, что у Разработчика: проверяющий не должен быть слабее проверяемого там, где
  // сложность объявлена явно. Умолчания у него нет (в отличие от `developer_high_complexity`
  // ниже) — это выбор проекта, и без ключа ничего не дорожает молча.
  'tester', 'tester_high_complexity', 'reviewer_qa', 'docwriter', 'devops',
]

function models() {
  const raw = (cfg && cfg.models) || {}
  const out = {}
  const warnings = []
  for (const [k, v] of Object.entries(raw)) {
    if (!ROLE_KEYS.includes(k)) {
      warnings.push(`models.${k}: нет такой роли — ключ проигнорирован`)
      continue
    }
    if (v === null || v === 'inherit' || v === '') continue
    if (!MODEL_TIERS.has(String(v)) && !MODEL_ID.test(String(v))) {
      // Плохое значение лучше отбросить здесь, чем получить отказ API на середине сборки.
      warnings.push(`models.${k}: "${v}" — не opus/sonnet/haiku и не полное имя claude-…, оверрайд отброшен`)
      continue
    }
    out[k] = String(v)
  }
  // Метка high-complexity поднимает Разработчика на Opus (§4). Проект может
  // переопределить и это, но по умолчанию правило действует.
  if (!out.developer_high_complexity) out.developer_high_complexity = 'opus'
  return { models: out, warnings }
}

// Рабочее дерево задачи заводится `git worktree add`, а значит получает ровно то, что
// лежит под версией. Неверсионируемое окружение — `.env` и его родня — туда не попадает,
// и перенести его движок не может: под песочницей файл с секретами намеренно нечитаем
// (на пилоте это стоило прогона тестов во всех деревьях сразу, BUG-011). Поэтому здесь
// не чиним, а предупреждаем: проект должен уметь подниматься без этих файлов —
// умолчаниями в `conftest.py`, фикстурами, версионируемым `.env.example`.
function envWarnings() {
  const out = []
  const names = ['.env', '.env.local', '.env.dev.local', 'secrets.json', '.secrets']
  for (const n of names) {
    const abs = join(root, n)
    if (!existsSync(abs)) continue
    let tracked = ''
    try {
      tracked = execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', n], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      tracked = ''
    }
    if (!tracked.trim()) {
      out.push(
        `${n} не под версией — в рабочих деревьях задач его не будет. Тесты и запуск стадий ` +
          `должны обходиться без него, иначе прогон в дереве упадёт на сборе тестов.`,
      )
    }
  }
  return out
}

// Готовый args для Workflow: команде остаётся передать это как есть, ничего не собирая
// руками. Задачи, уже дошедшие до merged/released/cancelled, в прогон не попадают.
// Последняя претензия к задаче — из журнала, а не из памяти прогона. Внутри одного
// прогона workflow передаёт её сам (`last.notes`), но на перезапуске `last` пуст, и в
// промпт Разработчика уходит прочерк: он видит непустую ветку с зелёными тестами и
// заключает, что работа сделана (Д-11 разбора 24.09.2026). Журнал претензию хранит —
// событие ревью несёт `notes` и разбор по критериям, который кладёт хук из structured
// output роли. Берём последнее отклонение или эскалацию.
function lastVerdict(t) {
  const evs = (t.events || []).filter((e) => !e._broken && (e.event === 'rejected' || e.event === 'escalated'))
  const e = evs[evs.length - 1]
  if (!e) return null
  return {
    event: e.event,
    ts: e.ts,
    attempt: e.attempt || null,
    notes: e.notes || null,
    criteria: (e.criteria || []).filter((c) => String(c.s || '').toLowerCase() !== 'выполнено'),
  }
}

// Решение разбора — отдельным полем, рядом с претензией (Д-27 проект-В 29.10.2026).
// Маршрут `/firm-build`, шаг 3, велит Оркестратору записать разбор затыка событием
// `lifecycle/arbitrated` — и это единственное штатное место текста решения. В выбор
// `lastVerdict` оно не входило: там только вердикты стадий. То есть Разработчик,
// взявший задачу ПОСЛЕ разбора, получал в промпте ту самую эскалацию, на которой
// остановился, и ни слова о том, что решили. На проект-В так сгорел заход у T-178: ворота
// решили, КАК читать спорную формулировку, второй заход решения не увидел и привёл
// доводы ровно в ту сторону, которую ворота отклонили.
//
// Отдельным полем, а не примесью к `lastVerdict`: претензия и решение — разные вещи с
// разными авторами, и промпту нужны обе, в порядке «сначала за что остановили, потом
// что решили». Смешай их — и на задаче с двумя заходами нельзя будет сказать, какой
// текст чей.
//
// `superseded` и `cancelled` здесь не нужны: такие задачи в прогон не отдаются вовсе
// (BUILD_SKIP), и решение по ним исполнять некому.
// Вернулась ли задача в цикл разбором эскалации — и вернулась ли ПОСЛЕ той эскалации, на
// которой встала. Признак машинный, и ответ здесь, а не в промпте: у промпта нет часов.
//
// Отчёт проект-В 09.11.2026 (Д-63). `T-388` — узел графа, на неё опирались семь задач —
// эскалировала с находкой про нарезку; Архитектор разобрал, Оркестратор записал
// `lifecycle/arbitrated` штатной командой, доска показала `ready`, `sync` и `doctor` зелены.
// Идущий прогон задачу больше не взял и не мог: список задач он получает в `args` на старте,
// а зонд состояния добирал только то, чего в списке НЕТ ВОВСЕ. Задача из плана, вернувшаяся
// в цикл, под это условие не попадала. Цена: полтора часа на двух слотах из восьми,
// 26 задач с нулём попыток и ещё одни ворота человека.
//
// Поэтому поле отдельное, а не вывод из статуса: `ready` у задачи плана прогон видит и
// без него, а вот «эта готовность — результат разбора МОЕЙ эскалации» из статуса не
// следует. Попытки при этом не обнуляются: их считает `dev/started` за всю жизнь задачи
// (Д-11), и разбор лишнего захода не дарит — это обещано документацией.
function returnedFromEscalation(t) {
  let esc = null
  let arb = null
  for (const e of (t && t.events) || []) {
    if (e._broken) continue
    // Новая эскалация обнуляет найденный разбор: решение прошлого круга ответом на текущий
    // затык не является (та же оговорка, что у `after_verdict` ниже).
    if (e.event === 'escalated') { esc = e; arb = null; continue }
    if (e.event === 'arbitrated' && esc) arb = e
  }
  if (!esc || !arb) return null
  return { escalated_ts: esc.ts, arbitrated_ts: arb.ts, actor: arb.actor || null }
}

function lastArbitration(t, verdictTs = null) {
  const evs = (t.events || []).filter((e) => !e._broken && e.event === 'arbitrated')
  const e = evs[evs.length - 1]
  if (!e) return null
  return {
    ts: e.ts,
    actor: e.actor || null,
    notes: e.notes || null,
    // Разбор МОЖЕТ быть старее последней эскалации: задача эскалировала снова уже после
    // него. Тогда это решение прошлого круга, и выдавать его за ответ на текущий затык
    // нельзя. Судит признак, а не промпт: у промпта нет часов.
    after_verdict: verdictTs ? e.ts >= verdictTs : true,
  }
}

// Цена исключительности, названная вслух. Задача без `parallel_safe` идёт ОДНА: пока она
// работает, остальные слоты стоят. Поведение правильное — параллельная правка общего
// файла стоит конфликта слияния, — но до 05.10.2026 оно было УМОЛЧАНИЕМ: поле не
// заполнено значит исключительная, и сказать об этом было некому.
//
// Замер обкатки проект-В: 43 задачи из 72 исключительные, и машина 82% рабочего времени
// вела ОДНУ стадию при трёх настроенных слотах (три слота заняты — 11% времени). Те же
// 50.8 часа стадий при реальных трёх полосах уложились бы часов в двадцать вместо
// тридцати восьми. Чек-лист советовал «сомневаетесь — ставьте false: цена ошибки здесь
// конфликт слияния, а не потерянный час»; совет давался без замера, а цена оказалась не
// потерянным часом, а удвоением календарного срока поставки.
//
// Движок НЕ меняет поведение и не решает за Архитектора: он требует причину и считает
// долю. Решение остаётся человеческое, но перестаёт быть молчаливым (ADR-0007).
function exclusivityWarnings(tasks) {
  const out = []
  const exclusive = tasks.filter((t) => !t.parallel_safe)
  if (!exclusive.length) return out
  const silent = exclusive.filter((t) => !t.exclusive_why).map((t) => t.id)
  if (silent.length) {
    out.push(
      `исключительные задачи без причины (${silent.length}): ${silent.join(', ')} — ` +
        'такая задача занимает собой все слоты; назови причину полем exclusive_why ' +
        '(какой общий файл, миграция, общая настройка) или сними исключительность',
    )
  }
  // Доля исключительных задач сама по себе НИЧЕГО не говорит, и прежнее предупреждение
  // по ней было честно названо бесполезным на обкатке: цепочка бывает последовательной по
  // существу — все задачи правят один файл, — и тогда 60% исключительных не стоят ничего.
  // Стоимость меряется в волнах: на сколько заходов конвейера длиннее становится поставка
  // от пометок. Это число и показываем, когда оно есть.
  const shape = planShape(tasks, { parallelism })
  if (shape.cost_of_exclusive > 0) {
    out.push(
      `пометки exclusive стоят ${shape.cost_of_exclusive} волн: поставка пройдёт за ` +
        `${shape.waves} заходов вместо ${shape.waves_without_exclusive}, а форма графа ` +
        `допускает ${shape.floor}. Средняя ширина волны ${shape.avg_width} из ${parallelism}`,
    )
  }
  return out
}

// Модель задачи для сборщика — ОДНО определение на два потребителя: `build-args` (список
// на старте прогона) и `settled` (то же самое, спрошенное ПО ХОДУ). Разъехаться им нельзя:
// задача, выданная прогону по ходу, обязана быть той же формы, иначе планировщик будет
// обходиться с ней иначе, чем с задачей из плана, и разница будет тихой.
function taskRecords(change) {
  const b = board()
  const full = computeBoard(root, change, { parallelism })
  const byId = new Map(full.tasks.map((t) => [t.id, t]))
  const tasks = b.tasks.filter((t) => !BUILD_SKIP.includes(t.status))
  return {
    tasks: tasks.map((t) => {
      const f = byId.get(t.id) || {}
      return {
        id: t.id,
        path: t.rel,
        title: t.title,
        depends_on: t.depends_on,
        parallel_safe: t.parallel_safe,
        ui: t.ui,
        labels: t.labels,
        epic: t.epic,
        worktree: f.worktree || null,
        fixes: f.fixes || null,
        br_refs: f.br_refs || [],
        status: t.status,
        attempt: t.attempt || 0,
        last_verdict: lastVerdict(f),
        last_arbitration: lastArbitration(f, (lastVerdict(f) || {}).ts || null),
        // Признак Д-63: разбор эскалации случился ПОСЛЕ неё, и задача снова пригодна к
        // работе. Читает идущий прогон — чтобы вернуть в очередь то, что сам же эскалировал.
        returned_from_escalation: returnedFromEscalation(f),
        exclusive_why: f.exclusive_why || null,
        // Инвентарь — то, над чем квантован критерий, и то, что исполнитель НЕ ВПРАВЕ
        // добирать сам (Д-1 буквально: урезать модель задачи по пути значит потерять
        // поле молча). Перечень идёт в промпт стадии, иначе поле осталось бы
        // бухгалтерией: три захода T-374 добирали его грепом ровно потому, что его
        // негде было прочитать.
        inventory: f.inventory || [],
      }
    }),
    skipped: b.tasks.filter((t) => BUILD_SKIP.includes(t.status)).map((t) => `${t.id}: ${t.status}`),
    skipped_by_id: Object.fromEntries(
      b.tasks.filter((t) => BUILD_SKIP.includes(t.status)).map((t) => [t.id, t.status]),
    ),
    // Полная модель рядом с урезанной: предупреждения об исключительности судят по полям,
    // которых в сборочной записи нет.
    by_id: byId,
  }
}

// `blocked` и `superseded` — терминальные для цикла: первая ждёт арбитража человека
// (firm-build.md §3), вторая заменена другими задачами. Отдать их workflow значит прогнать
// заново то, что уже решено не прогонять; на пилоте так заменённая задача попала на вход
// третий раз.
const BUILD_SKIP = [...TASK_CLOSED, 'blocked']

// Замер объёма и целостности переданного `args` (Д-23 проект-В 29.10.2026). Вывод этой
// команды на живой поставке — 47 КБ при 44 задачах, а передать его в Workflow можно только
// вставкой в вызов: путь к файлу инструмент не принимает. Маршрут при этом велит «руками
// ничего не составляй» — правило без исполнимого пути, то есть приглашение сократить.
//
// И сократили: на проект-В Оркестратор обрезал `last_verdict.notes` у трёх задач и обнулил
// список из двадцати критериев у одной. Прогон запустился и выглядел нормальным — а
// `last_verdict.notes` уходит в промпт стадии ДОСЛОВНО: Разработчик получил бы пересказ
// вместо вердикта Ревьюера на задаче, которую за эти критерии и эскалировали. Обошлось
// потому, что человек пошёл читать скрипт, а не потому, что что-нибудь предупредило.
//
// Поэтому счёт, а не доверие. Считаются ровно те величины, которые обрезка меняет:
// сколько задач, сколько всего критериев в их вердиктах, сколько символов в пояснениях.
// Проверяет их сам сборщик и падает ДО первой стадии. Хеш здесь был бы строже, но его
// пришлось бы считать дважды — в скрипте и в сборщике, — и две реализации одного хеша
// разъедутся молча, дав ложный отказ посреди волны. Счётчики так разъехаться не могут.
function argsIntegrity(tasks) {
  let criteria = 0
  let verdictChars = 0
  for (const t of tasks || []) {
    const v = t && t.last_verdict
    if (!v) continue
    criteria += Array.isArray(v.criteria) ? v.criteria.length : 0
    verdictChars += String(v.notes || '').length
  }
  // Текст РЕШЕНИЯ разбора считается отдельным счётчиком (Д-27): он приезжает из другого
  // события и в промпт идёт отдельной строкой, а значит и сократить его можно отдельно.
  let arbChars = 0
  for (const t of tasks || []) {
    if (t && t.last_arbitration) arbChars += String(t.last_arbitration.notes || '').length
  }
  return {
    tasks: (tasks || []).length,
    verdict_criteria: criteria,
    verdict_chars: verdictChars,
    arbitration_chars: arbChars,
  }
}

// Объявленный проектом состав исключённого из задачного прогона. Форма — список строк
// («путь») или объектов («{ path, by }»): `by` — ПРЕДЪЯВИТЕЛЬ, то есть кто и когда это
// прогонит, если стадии задач не прогоняют. Нормализуем к одной форме: у двух потребителей
// (сборщик и ворота) разъехаться в разборе не должно (тот же довод, что у `taskRecords`).
// Пути, которые в дереве задачи связываются с главным деревом вместо установки заново
// (Д-71). Список строк в `stack.worktree_links`; относительные — от корня репозитория.
function worktreeLinks(conf) {
  const raw = (conf && conf.stack && conf.stack.worktree_links) || []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((x) => String(x || '').trim()).filter(Boolean)
}

function excludedTests(conf) {
  const stackCfg = (conf && conf.stack) || {}
  const raw = stackCfg.task_tests_excluded || []
  const list = Array.isArray(raw) ? raw : [raw]
  // Предъявитель объявляется отдельным отображением «путь → кто предъявит»: разбор конфига
  // в движке списков объектов не знает (`parseYaml`, два уровня — и этого хватает всему
  // остальному), а тащить сюда внешний разбор YAML нельзя (ADR-0010).
  const byPath = stackCfg.task_tests_presented_by && typeof stackCfg.task_tests_presented_by === 'object'
    ? stackCfg.task_tests_presented_by
    : {}
  const out = []
  for (const item of list) {
    if (!item) continue
    const path = typeof item === 'string' ? item : (item.path || item.file || null)
    if (!path) continue
    const inline = typeof item === 'string' ? null : (item.by || null)
    const by = inline || byPath[String(path)] || null
    out.push({ path: String(path), by: by ? String(by) : null })
  }
  return out
}

// Сужение без объявления состава — это слепое пятно, и сказать о нём надо В ТОТ момент,
// когда его ещё можно снять: `build-args` читают перед прогоном (тот же довод, что у
// расхождения версии движка).
function narrowWarnings(conf) {
  const narrowed = Boolean(
    conf && conf.stack && conf.stack.task_test_cmd && conf.stack.task_test_cmd !== conf.stack.test_cmd,
  )
  if (!narrowed) return []
  const ex = excludedTests(conf)
  if (!ex.length) {
    return [
      'задачный прогон сужен (stack.task_test_cmd), а состав исключённого не объявлен: ' +
        'stack.task_tests_excluded пуст. Значит ни одна стадия исключённое не прогонит, и до ' +
        'ворот его не предъявит НИКТО — формула «новых красных нет» будет значить «нет в том, ' +
        'что мы смотрим». Перечисли выпавшие файлы, а предъявителя каждого — отображением ' +
        'stack.task_tests_presented_by: замер проект-В 08.11.2026 — 32 задачи, семь волн, гейт из 164 живых проверок ' +
        'не прогнан ни разу, пять красных на воротах',
    ]
  }
  const orphan = ex.filter((e) => !e.by).map((e) => e.path)
  if (!orphan.length) return []
  return [
    `исключённое из задачного прогона без предъявителя (${orphan.length}): ${orphan.join(', ')} — ` +
      'эти файлы не гоняет ни одна стадия задачи, и первым их увидят ворота поставки. ' +
      'Назови предъявителя в stack.task_tests_presented_by (например, «ворота 3б» или «сторож равенства способов ' +
      'запуска в задачном наборе») — либо перенеси проверку в задачный набор, и тогда она ' +
      'краснеет в каждой волне, а не раз в поставку',
  ]
}

function buildArgs() {
  const b = board()
  const change = b.change
  if (!change) return { error: 'изменений (changes) нет' }
  const m = models()
  // `blocked` и `superseded` — терминальные для цикла: первая ждёт арбитража человека
  // (firm-build.md §3), вторая заменена другими задачами. Отдать их workflow значит
  // прогнать заново то, что уже решено не прогонять; на пилоте так заменённая задача
  // попала на вход третий раз.
  const rec = taskRecords(change)
  const tasks = rec.tasks
  const byId = rec.by_id
  return {
    change,
    // Время сборки аргументов. Это ЕДИНСТВЕННЫЙ способ назвать момент внутри прогона
    // сборки: раннер Workflow запрещает скрипту `new Date()` и `Date.now()` («breaks
    // resume») и роняет этим весь вызов стадии — так в 0.4.135 я сломал переход Test → QA
    // у каждой задачи проект-В (Д-72). Время живёт в args, то есть переживает resume, и
    // прогон штампует им свои снимки — например отнесение красных тестов (Д-65).
    //
    // Это время НАЧАЛА волны, а не «сейчас»: прогон идёт часами и в несколько заходов.
    // Поэтому в отчёте оно подписано как момент аргументов, а не как момент факта.
    now: new Date().toISOString(),
    feature_branch: `feature/${change}`,
    // Ветка-цель слияния. Нужна стадиям как БАЗА утверждения «новых красных нет»: база
    // внутри поставки это утверждение не доказывает (BR-165 проект-В, MR-ревью 13.10.2026 —
    // три независимые сверки, все три базы внутри поставки, все три слепы к девяти своим
    // красным). Имя берётся из конфига (`main_branch`), иначе по факту — `main`/`master`.
    main_branch: baseBranch(),
    // Две команды прогона, а не одна. `test_cmd` — полный набор проекта, эталон; он же
    // идёт на ворота. `task_test_cmd` — то, чем проверяется ЗАДАЧА, и он может быть уже:
    // проект вправе не гонять на каждой задаче проверки, которые судят не её (замер
    // проект-В 28.10.2026: мета-тесты механизма установки — 26 минут стадии против девяти
    // без них). Ключа нет — обе команды одна и та же, и это умолчание намеренно: сужение
    // должно быть явным согласием, иначе оно случится молча и заодно на воротах.
    test_cmd: (cfg.stack && cfg.stack.test_cmd) || null,
    task_test_cmd: (cfg.stack && (cfg.stack.task_test_cmd || cfg.stack.test_cmd)) || null,
    // Сужен ли задачный прогон — считает ДВИЖОК, а не стадия сравнением строк: по этому
    // признаку меняются и промпты, и то, что сказано на доске.
    task_tests_narrowed: Boolean(
      cfg.stack && cfg.stack.task_test_cmd && cfg.stack.task_test_cmd !== cfg.stack.test_cmd,
    ),
    // Что именно выпало из задачного прогона и КТО это предъявит. Отчёт проект-В 08.11.2026
    // (Д-55): среди четырёх файлов, исключённых из задачной команды, оказался единственный
    // в проекте гейт живых браузерных проверок — 164 проверки одним подпроцессом. За 32
    // задачи и семь волн он не прогнался НИ РАЗУ, а на воротах дал пять красных, из них три
    // настоящих, и ни одно не было видно изнутри задачи.
    //
    // Сужение при этом верно и движком же поощряется (×22 по замеру проекта, 0.4.121 полный
    // прогон в стадии отклоняет). Неверно другое: исключённое не предъявляется НИЧЕМ до
    // ворот, и вопроса «кто и когда его прогонит» не задавал никто — ни `build-args`,
    // который про сужение знает, ни промпты, которым запрет полного набора в них и пишут.
    // Движок не умеет вывести состав исключённого из двух строк команд (это чужой раннер с
    // чужими флагами), поэтому состав ОБЪЯВЛЯЕТ проект, а движок требует объявления и
    // называет исключённое непрогнанным везде, где говорит про сужение.
    task_tests_excluded: excludedTests(cfg),
    // Что в рабочем дереве задачи надо СВЯЗАТЬ с главным, а не ставить заново. Отчёт проект-В
    // 09.11.2026 (Д-71): в деревьях задач нет `web/node_modules` (он в .gitignore, и
    // `worktree add` его не копирует), поэтому первый прогон стадии падает «Cannot find
    // package 'vite'». Три роли за вечер поставили симлинк на главное дерево руками,
    // одинаково, и одна из них забыла его снять до коммита.
    //
    // Знать про `node_modules` движку неоткуда — это свойство проекта, а не маршрута
    // (ADR-0009), поэтому состав ОБЪЯВЛЯЕТ проект ключом `stack.worktree_links`, а движок
    // кладёт объявленное в промпт подготовки дерева, где это место и есть. Ключа нет —
    // поведение прежнее, и ни одной новой строки в промпте.
    worktree_links: worktreeLinks(cfg),
    worktrees_dir: worktreesDir(root, cfg),
    parallelism,
    // Потолки полос одновременности. Сборщику — чтобы он держал их САМ: он и есть
    // настоящий планировщик (`firm-state.mjs next` — вид человеку), а доступа к ФС у
    // workflow-скрипта нет, то есть конфиг он может получить только через args.
    lanes: LANE_CAPS,
    plugin_root: (cfg && cfg.engine_root) || null,
    models: m.models,
    // Д-1 (обкатка проект-А 29.09.2026). Модель задачи отдаётся ЦЕЛИКОМ, а что из неё
    // нужно — решает сборщик: `worktree`, `fixes` и `br_refs` поставщик аргументов когда-то
    // молча отрезал, и задача, назначенная Архитектором в чужое дерево, уезжала в новое без
    // всякой ошибки — худший вид дефекта. Теперь форма одна на два потребителя
    // (`taskRecords`), и разъехаться им негде.
    tasks,
    // Считается ПОСЛЕ сборки списка и от него же: иначе сверялось бы не то, что уехало.
    integrity: argsIntegrity(tasks),
    skipped: rec.skipped,
    // То же самое машинно. Нужно планировщику сборки, чтобы отличать «зависимость уже
    // влита» от «зависимости нет вовсе»: первое — норма и повод промолчать, второе —
    // почти всегда опечатка в depends_on. Без этого обе ситуации выглядели одинаково
    // («не входит в прогон — считаю выполненной»), и на проект-В 03.10.2026 агент вычистил
    // влитые задачи из depends_on, лишь бы убрать четыре строки из лога. Это потеря:
    // история зависимостей задачи — такая же часть задачи, как её критерии приёмки.
    skipped_by_id: rec.skipped_by_id,
    // Номера багов прогону больше НЕ выдаются пулом, и это правка по отчёту проект-В
    // 03.11.2026 (находка 4). Пул выдавался на старте волны и расходился внутри прогона
    // честно (`shift`), но жил рядом с другим источником того же номера: Оркестратор в
    // главном дереве спрашивал `next-id`, и обоим отвечал один и тот же максимум — файла
    // бага ни в одном дереве ещё не было. Так столкнулись BUG-158, BUG-159 и BUG-171.
    //
    // Теперь номер берёт тот, кто его пишет, в момент записи, и берёт С БРОНЬЮ:
    // `firm-state.mjs next-id --kind bug` кладёт файл в `.firm/ids/` флагом `wx`. Здесь
    // остаётся только адрес команды — промпт стадии зовёт её, а не подставляет номер.
    // Пустой пул в прогоне теперь штатен: ветка «номер не выдан» в сборщике и была
    // предусмотрена под это.
    next_bug_ids: [],
    next_bug_id_cmd: 'firm-state.mjs next-id --kind bug --json',
    // Путь общего стенда браузерной проверки — чтобы стадия его НЕ ИСКАЛА. Промпт велит
    // использовать готовый, а поиск grep-ом по каталогу проверок — это лишние вызовы и
    // тридцать шансов не найти. Ключа нет — в промпте останется правило без адреса.
    browser_harness: (cfg && cfg.browser_harness) ? String(cfg.browser_harness) : null,
    // Бинарь браузера — тем же приёмом, что стенд: адрес держит движок, чтобы стадия его
    // не искала. 11.10.2026 замерено, что системный Chrome под песочницей не поднимается
    // вовсе (`ProcessSingleton` требует unix-сокета), а `chrome-headless-shell` с
    // `--single-process` поднимается. Рецепт роль получает промптом, а ПУТЬ к бинарю из
    // промпта не выведешь: он машинный, с версией в имени каталога.
    browser_binary: (cfg && cfg.browser_binary) ? String(cfg.browser_binary) : null,
    // Пути короткой полосы — сборщику, чтобы он знал, настроено ли правило, ДО первой
    // задачи с меткой. Пустой список значит «метка не работает», и сказать это надо в
    // логе один раз на прогон, а не тихо вести задачу полным циклом, пока человек ждёт
    // обещанного ускорения.
    short_lane: ((cfg && cfg.short_lane && cfg.short_lane.paths) || []).map(String),
    // Бюджет стадии в минутах. Движком он не исполняется принуждением — прервать идущего
    // подагента нечем, — но называется стадии в промпте и проверяется замером на финише.
    // Пустой объект значит «проект снял бюджет», и это видно в конфиге.
    stage_budget: stageBudget(cfg),
    warnings: m.warnings.concat(envWarnings()).concat(narrowWarnings(cfg)).concat(
      // Полные задачи, а не строки доски: `board()` — вид для человека, и `exclusive_why`
      // он не несёт. Та же ловушка, что в Д-1 про `worktree`, и по той же причине.
      exclusivityWarnings(tasks.map((t) => byId.get(t.id) || t)),
      // Расхождение версии движка. Здесь, а не только в `phase`, потому что `build-args`
      // читают ПЕРЕД прогоном — то есть в тот единственный момент, когда расхождение
      // ещё можно снять (Д-7, разбор проект-В 11.10.2026).
      engineVersionFindings(root, cfg),
      // Критерии, которые нельзя проверить. Здесь — потому что `build-args` читают перед
      // прогоном: это последний момент, когда непроверяемый критерий ещё стоит правки
      // текста, а не стадии, встающей на нём (разбор поставки 3.1 на проект-В, 11.10.2026).
      criteriaFindings(root, change, cfg),
      // Негодный потолок полосы. Здесь же, где критерии: последний момент перед прогоном,
      // когда «полоса не работает» ещё можно заметить, а не ждать обещанного ограничения.
      laneWarnings(cfg),
      // Пустая ось Standards. Здесь по той же причине, что критерии: `build-args` читают
      // ПЕРЕД прогоном, и это последний момент, когда стандарты ещё можно разложить
      // раньше, чем по ним вынесут девять невоспроизводимых вердиктов.
      standardsFindings(root),
      // Путь пользователя. Здесь — по той же причине, по которой здесь критерии: ворота
      // человека это промпт, а `build-args` читает КОД перед каждой волной. Отчёт проект-В
      // 03.11.2026: пакет ворот был полон по всем семи входам, и дыра в пути прошла
      // мимо, потому что проверять её было нечем. Восьмой вход без машинного читателя
      // стал бы восьмой просьбой.
      userPathFindings(root, change),
    ),
  }
}

// Пин версии внешней зависимости из секции dependencies. Нужен командам, чтобы ставить
// ровно ту версию, на которую проект пинован, а не «последнюю из интернета».
function dep(name) {
  const deps = (cfg && cfg.dependencies) || {}
  const v = deps[name]
  return v ? String(v) : ''
}

// Осиротевшие worktree: задача уже merged/released, каталог висит (§9).
// Что поставка знает о себе СЕЙЧАС. Нужно идущему прогону, и это не дубль `build-args`:
// тот снимается ОДИН раз на старте, а планировщик живёт часами. Разбор проект-В 12–13.10.2026
// дал три дефекта одного корня (Д-8.2, Д-8.4): задача, заведённая во время прогона, для
// планировщика не существует, а зависимость на неё считается выполненной; задача, слияние
// которой человек довёл руками, навсегда остаётся вне `done`, и зависимые не стартуют молча.
//
// Истина о поставке — журнал (ADR-0001), и спросить его прогон может только командой: у
// workflow-скрипта нет доступа к ФС. Поэтому ответ максимально узкий — два списка
// идентификаторов, никакой интерпретации.
function settled() {
  const change = activeChange()
  if (!change) return { change: null, exists: [], merged: [], workable: [] }
  const full = computeBoard(root, change, { parallelism })
  const tasks = full.tasks || []
  return {
    change,
    exists: tasks.map((t) => t.id),
    // `released` сюда же: выпущенная задача влита по построению, и зависимость на неё
    // выполнена. Пропустить это значило бы держать зависимых в ожидании навсегда.
    merged: tasks.filter((t) => ['merged', 'released'].includes(t.status)).map((t) => t.id),
    // Задачи, пригодные к работе СЕЙЧАС — полной моделью, той же, что на старте прогона.
    //
    // Без этого поля прогон знал только имена (`exists`), а по имени задачу не запустишь:
    // нужны путь, зависимости, исключительность, метки, номер попытки. Поэтому всё, что
    // появилось или вернулось в цикл по ходу, он называл вслух и не брал — а слоты при
    // этом простаивали. Замер первой волны проект-В 25.10.2026 (Д-14): 5,5 слото-часа
    // простоя при потолке 3 и окне 6,8 ч, то есть почти целый слот впустую. Из них
    // большая часть — на задачах, которые завёл САМ прогон: T-172 родилась 09:16 из
    // арбитража T-134, T-176 — в 10:39. Остальное — T-150, чью эскалацию в 12:32 сняли
    // как необоснованную: попытки у неё не кончились (2 из 3), блокера больше не было,
    // три слота стояли свободными до 13:55, и никто её не подобрал.
    workable: taskRecords(change).tasks,
  }
}

// Масса репозитория: во что он превратился за все поставки. Не про идущую работу —
// про накопленное, и потому без `--change`.
function mass() {
  return massState(root, cfg)
}

// Заслужила ли задача короткую полосу. Зовёт идущий прогон ПОСЛЕ стадии разработки:
// метка — заявка планирования, а судит её настоящий дифф ветки задачи (см.
// `shortLaneState`). Отдельная команда, а не поле `build-args`, по той же причине, что
// `settled`: `build-args` снимается на старте, а диффа тогда ещё нет.
// Дифф задачи машиной (Д-37). Своего суждения здесь нет совсем: ни «много файлов», ни
// «не объявлено» — только факт о ветке. Судит его Ревьюер, а объявлять руками больше не
// нужно никому.
function taskDiffCmd() {
  const change = activeChange()
  const ticket = args.ticket ? String(args.ticket) : null
  if (!change || !ticket) {
    return { ticket, files: null, why: 'не указан --ticket или нет активной поставки' }
  }
  return taskDiff(root, change, ticket, cfg)
}

function laneCheck() {
  const change = activeChange()
  const ticket = args.ticket ? String(args.ticket) : null
  if (!change || !ticket) {
    return { ticket, verdict: 'не подтверждена', labeled: false, configured: false,
      why: 'не указан --ticket или нет активной поставки' }
  }
  const task = listTasks(root, change).find((t) => t.id === ticket) || null
  const labeled = !!(task && (task.labels || []).includes(SHORT_LANE_LABEL))
  if (!labeled) {
    return { ticket, verdict: 'нет метки', labeled: false, configured: true, outside: [], files: [],
      why: `на задаче нет метки «${SHORT_LANE_LABEL}» — полный цикл` }
  }
  return { ticket, labeled: true, ...shortLaneState(root, change, ticket, cfg) }
}

// Какие стандарты читать на ЭТОЙ правке. Отбор по `paths` во frontmatter против файлов
// диффа — см. `standardsFor`. Без `--ticket` и `--files` отбор не делается и об этом
// сказано вслух: умолчание «применимо всё» безопаснее умолчания «ничего не применимо».
function standardsCmd() {
  let files = null
  if (args.files) {
    files = String(args.files).split(',').map((x) => x.trim()).filter(Boolean)
  } else if (args.ticket) {
    const change = activeChange()
    const ticket = String(args.ticket)
    // Дифф ветки задачи против ветки поставки — та же база, по которой судится полоса.
    let raw = null
    try {
      raw = change
        ? execFileSync('git', ['-C', root, 'diff', '--name-only', `feature/${change}...task/${ticket}`], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        : null
    } catch {
      raw = null
    }
    files = raw === null ? null : raw.split('\n').map((x) => x.trim()).filter(Boolean)
  }
  const st = standardsFor(root, files)
  // Отказ git читается открыто, а не закрыто, и это осознанно: закрытая трактовка здесь
  // означала бы «ни один стандарт не применим», то есть молча снятую ось (И-12 требует
  // остановиться на неизвестном, а не сэкономить на нём).
  if (args.ticket && !args.files && files === null) {
    st.why = 'дифф ветки задачи прочитать не удалось — отбор не делался, читать всё'
  }
  return st
}

// Размер каталога — человеку, чтобы он понимал, о чём речь: «чужой каталог» и «чужой
// каталог на 150 МБ» требуют разных решений. Отказ `du` трактуется закрыто (И-12): не
// узнали — `null`, а не 0.
function dirSizeMb(path) {
  try {
    const out = execFileSync('du', ['-sk', path], { encoding: 'utf8', timeout: 20000 })
    const kb = Number(String(out).trim().split(/\s+/)[0])
    return Number.isFinite(kb) ? Math.round((kb / 1024) * 10) / 10 : null
  } catch {
    return null
  }
}

function orphans() {
  const b = board()
  const byId = new Map((b.tasks || []).map((t) => [t.id, t]))
  const abandonedTickets = abandonedNow()
  const wt = listWorktrees(root).filter((w) => w.path !== root)
  const res = []
  // Чужие деревья. Правило «движку принадлежит только то, что он сам создал» в этом файле
  // уже сформулировано — четыре условия перед `unregisteredDirs`, — но применялось оно к
  // одному из двух списков: к каталогам, потерянным git-ом. Зарегистрированные деревья
  // проверялись иначе: «тикет из ветки не разобрался» значило «нет такой задачи», то есть
  // сирота, то есть под снос. Дерево человека на ветке `docs/…` даёт ровно это, и `prune`
  // (его зовёт предстартовая проверка `/firm-build`) сносил его молча — без `--force`, но
  // чистое дерево сносится и так, а чистым оно становится сразу после коммита.
  //
  // Это не только дефект уборки. Параллельная работа рядом со сборкой — нормальный режим:
  // сборка идёт часами, а груминг следующего задания от неё не зависит. Главное дерево
  // занято веткой поставки, значит человеку нужно своё дерево, и оно обязано быть
  // безопасным. Находка прогона проект-В 11.10.2026 (Д-3).
  const wtDir = worktreesDir(root, cfg)
  const ours = (p) => !!wtDir && (p === wtDir || String(p).startsWith(wtDir + sep))
  const foreign = []
  // Деревья груминга (ADR-0012) движок знает по учётной записи, поэтому называет их по
  // имени темы, а не «чужое дерево». Это и есть разница между «не трогаю, потому что не
  // моё» и «не трогаю, потому что знаю, что здесь идёт»: второе человек может проверить,
  // первое — только принять на слово.
  const groomDir0 = groomWorktreesDir(root, cfg)
  const inGroomDir = (pth) => pth === groomDir0 || String(pth).startsWith(groomDir0 + sep)
  const groom = []
  // Дерево основания сверки одно на проект, поэтому это объект, а не список: два таких
  // дерева означали бы два разных ответа на вопрос «что красно на ветке-цели».
  // Деревьев движка теперь два (`_trunk`, `_base`), поэтому список, а не одно поле: при
  // одном поле второе дерево молча затирало первое и выглядело пропавшим. Ключ `trunk`
  // остаётся прежним — его читают команды и тесты, — но несёт массив.
  const trunk = []
  for (const w of wt) {
    const gid = groomFromBranch(w.branch) || (inGroomDir(w.path) ? (basename(w.path).match(/^(G-\d+)/) || [])[1] || null : null)
    if (gid || inGroomDir(w.path)) {
      const rec = gid ? readGroom(root, gid) : null
      groom.push({
        path: w.path,
        branch: w.branch,
        id: gid,
        status: rec && !rec._broken ? rec.status || null : null,
        reason: rec
          ? `груминг ${gid}${rec.status ? ` (${rec.status})` : ''} — уборка поставки его не касается`
          : `дерево груминга без учётной записи — завести её командой groom set, иначе тема видна только в git`,
      })
      continue
    }
    // Дерево ОСНОВАНИЯ СВЕРКИ: его заводит сам движок на ветке-цели, чтобы снять красные,
    // с которыми сверяется утверждение приёмки (BR-165, 0.4.109). Имени задачи у него нет
    // по построению, и до этой ветви оно попадало в `foreign` с объяснением «не наше
    // дерево» — то есть движок врал про своё собственное. Разница та же, что у деревьев
    // груминга выше: «не трогаю, потому что знаю, что здесь» человек может проверить,
    // «не трогаю, потому что не моё» — только принять на слово.
    if (ours(w.path) && isEngineTree(basename(w.path))) {
      // Их два, и у каждого своя половина сравнения: `_trunk` — красные на ветке-цели,
      // `_base` — красные на точке ветвления волны (0.4.115). Признак общий — имя с
      // подчёркивания: третье такое дерево не должно требовать правки здесь.
      trunk.push({
        path: w.path,
        branch: w.branch || null,
        reason: basename(w.path) === '_base'
          ? 'дерево основания задач (красные на точке ветвления волны) — заводит движок, ' +
            'уборка задач его не касается; прогрев в нём переиспользуется намеренно'
          : `дерево основания сверки (красные на «${w.branch || baseBranch()}») — заводит движок, уборка задач его не касается`,
      })
      continue
    }
    const ticket = ticketFromBranch(w.branch) || (/^T-[\w.]+$/.test(basename(w.path)) ? basename(w.path) : null)
    // Два признака своего дерева, и нужны оба: место (внутри `worktrees_dir`) и имя
    // (ветка `task/T-XXX` или каталог `T-XXX`). Дерево движка имеет оба по построению —
    // `worktree add -B task/T-XXX <worktrees_dir>/T-XXX`, — а чужое не имеет ни одного.
    if (!ours(w.path) || !ticket) {
      foreign.push({
        path: w.path,
        branch: w.branch,
        reason: !ours(w.path) ? 'вне worktrees_dir — дерево человека, не трогаем' : 'ветка не про задачу — не наше дерево',
      })
      continue
    }
    const t = byId.get(ticket)
    const done = isClosedTask(t)
    if (done || !t) {
      res.push({ path: w.path, branch: w.branch, ticket, reason: done ? 'задача закрыта' : 'нет такой задачи' })
      continue
    }
    // Дерево брошенной стадии. После `abandon` задача снова «не начата», но дерево
    // остаётся — и `orphans` его не видел: по статусу задача живая, значит дерево при
    // деле. Дефект обкатки на проект-В 01.10.2026: три дерева висели при пустых ветках.
    //
    // Снести можно ТОЛЬКО пустое: ни коммитов поверх ветки поставки, ни изменений в
    // рабочем каталоге. Иначе это не уборка, а потеря работы — а работа в брошенном
    // дереве бывает: стадию могли снять на середине, уже что-то написав. Такое дерево
    // называем и оставляем человеку.
    //
    // Признак «брошена» берём из ЖУРНАЛА, а не из статуса на доске: `computeBoard`
    // подставляет вместо пустого статуса `ready`/`todo`, и «не начиналась вовсе» от
    // «стадию бросили» по доске не отличить. В журнале отличие есть — событие
    // `abandoned`, и оно последнее по этой задаче.
    if (abandonedTickets.has(ticket) && isEmptyWorktree(w.path)) {
      res.push({ path: w.path, branch: w.branch, ticket, reason: 'стадия брошена, работы в дереве нет' })
    }
  }
  // Каталоги, которые git уже не считает рабочими деревьями, а они остались.
  // Наблюдено на проект-В 01.10.2026 у ВЛИТОЙ задачи: `git worktree remove` снёс
  // отслеживаемые файлы, а каталог выжил из-за служебной папки рантайма внутри
  // (`.claude/.cc-writes`). Для git дерева больше нет, поэтому `listWorktrees` его не
  // видит, и до сих пор такие каталоги накапливались по одному на задачу.
  for (const d of unregisteredDirs()) res.push(d)
  // `foreign` в выводе не для красоты: человек должен видеть, что движок про его дерево
  // знает и намеренно его не трогает. Молчание тут читалось бы как «не заметил».
  // Чужие КАТАЛОГИ (не деревья git) внутри `worktrees_dir`. Д-8.5, разбор проект-В
  // 13.10.2026: прогон отчитался «чисто, ничего не требует очистки», а в каталоге лежало
  // 377 МБ — из них 150 МБ копия репозитория `_t101-probe`, которую роль сделала ради
  // замера. `git worktree prune` её не видит (это не дерево), `unregisteredDirs` тоже:
  // он смотрит только имена вида `T-XXX` и только пустые скорлупы.
  //
  // Называем и НЕ сносим. Та же осторожность, что у `unregisteredDirs`: каталог сносится,
  // а не переименовывается, и внутри может быть работа человека. Решает человек, а движок
  // обязан перестать молчать — молчание уборки читается как «там чисто».
  return {
    worktrees_dir: wtDir, groom_dir: groomDir0, orphans: res, foreign, groom, trunk,
    strays: strayDirs(res), stashes: stashLeftovers(),
  }
}

// Отложенные карманы, оставшиеся от шага слияния (Д-21 проект-В 28.10.2026: 27 записей
// через шесть поставок, самая старая — с `feature/cartographers-online`). Движок велит
// стадии класть правку в карман перед мержем и ОБЯЗАТЕЛЬНО доставать её потом `pop`-ом
// (`drop` молча уничтожает правки Архитектора в файлах задач — так на проект-В 05.10.2026
// пропало около десяти файлов). Но `pop` может и не случиться: конфликт на нём стадия по
// правилу НЕ разбирает, а возвращает человеку, — и карман остаётся лежать.
//
// Поэтому здесь ЗАМЕР, а не уборка: движок не снимает чужой карман даже свой собственный
// на вид (ADR-0009), потому что в нём может лежать единственная копия работы. Сказать —
// обязан: `git stash list` человеку нужен ровно тогда, когда что-то пошло не так, и
// нечитаемым он становится молча.
function stashLeftovers() {
  let out = ''
  try {
    out = execFileSync('git', ['-C', root, 'stash', 'list', '--format=%gd%x09%ci%x09%gs'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return { count: 0, mine: 0, oldest: null, items: [], note: null }
  }
  const items = out.split('\n').filter(Boolean).map((line) => {
    const [ref, ts, subject = ''] = line.split('\t')
    // «Наш на вид» — тот, что подписан движком или снят с ветки поставки. Признак
    // нестрогий намеренно: он решает, что НАЗВАТЬ, а не что снять.
    const mine = /firm2:/.test(subject) || /\bon feature\//.test(subject) || /chore\(firm2\)/.test(subject)
    return { ref, ts: ts || null, subject: subject.slice(0, 160), mine }
  })
  const mine = items.filter((i) => i.mine).length
  const oldest = items.length ? items[items.length - 1].ts : null
  return {
    count: items.length,
    mine,
    oldest,
    items: items.slice(0, 20),
    note: items.length
      ? `Карманов ${items.length}${mine ? `, похожих на оставленные движком — ${mine}` : ''}. ` +
        'Движок их НЕ снимает: в кармане может лежать единственная копия работы (ADR-0009). ' +
        'Смотреть — `git stash list` и `git stash show -p <ref>`; достать — `git stash pop <ref>`; ' +
        'выбросить разобранный — `git stash drop <ref>`, и это решение человека.'
      : null,
  }
}

// Осторожность здесь важнее полноты: каталог сносится, а не переименовывается. Поэтому
// четыре условия, и каждое отсекает свой способ ошибиться:
//   1. лежит внутри worktrees_dir — чужих каталогов не трогаем вовсе;
//   2. имя похоже на тикет (`T-XXX`) — значит создавал его движок, а не человек;
//   3. внутри НЕТ `.git` — если есть, это настоящее дерево, которое git потерял, и
//      разбираться с ним человеку, а не нам;
//   4. внутри нет ничего, кроме служебных каталогов рантайма, — то есть сносить нечего,
//      кроме пустой скорлупы. Любой файл поимённо оставляет каталог человеку.
const RUNTIME_ONLY = new Set(['.claude', '.DS_Store'])

// Каталоги в `worktrees_dir`, которые не являются ни деревьями git, ни сиротами под снос.
// `known` — пути, про которые движок уже сказал в своих списках: о них не повторяем.
function strayDirs(already) {
  const dir = worktreesDir(root, cfg)
  if (!dir || !existsSync(dir)) return []
  const known = new Set([
    ...listWorktrees(root).map((w) => w.path),
    ...(already || []).map((o) => o.path),
  ])
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = join(dir, e.name)
    if (known.has(full)) continue
    out.push({
      path: full,
      size_mb: dirSizeMb(full),
      reason:
        'каталог в worktrees_dir, который движок не создавал и git не считает рабочим деревом — ' +
        'чаще всего копия репозитория, сделанная стадией ради замера; движок его не трогает',
    })
  }
  return out.sort((a, b) => (b.size_mb || 0) - (a.size_mb || 0))
}

function unregisteredDirs() {
  const dir = worktreesDir(root, cfg)
  if (!dir || !existsSync(dir)) return []
  const known = new Set(listWorktrees(root).map((w) => w.path))
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!/^T-[\w.]+$/.test(e.name)) continue
    const full = join(dir, e.name)
    if (known.has(full)) continue
    if (existsSync(join(full, '.git'))) continue
    let inside = []
    try {
      inside = readdirSync(full)
    } catch {
      continue
    }
    if (inside.some((n) => !RUNTIME_ONLY.has(n))) continue
    out.push({
      path: full,
      branch: null,
      ticket: e.name,
      reason: inside.length
        ? 'каталог без регистрации в git, внутри только служебные файлы рантайма'
        : 'пустой каталог без регистрации в git',
    })
  }
  return out
}

// Пустое ли дерево: нет своих коммитов относительно ветки поставки и нет правок.
// Проверяем обоими способами, потому что отвечают они на разные вопросы: `log` — про
// сохранённое, `status` — про несохранённое. Любое сомнение (команда не отработала,
// ветка не определилась) трактуем как «не пусто»: ошибиться здесь можно только в одну
// сторону, и эта сторона — оставить.
// Задачи, у которых ПОСЛЕДНЕЕ событие — `abandoned`. Именно последнее: задача могла
// быть брошена в прошлом прогоне и перезапущена в этом, и тогда её дерево при деле.
function abandonedNow() {
  const change = activeChange()
  const last = new Map()
  for (const e of listEvents(root, { change })) {
    if (e._broken || !e.ticket || e.ticket === 'unknown') continue
    last.set(e.ticket, e.event)
  }
  return new Set([...last].filter(([, ev]) => ev === 'abandoned').map(([tk]) => tk))
}

function isEmptyWorktree(path) {
  // База — ветка поставки: деревья задач отводятся от неё (`worktree add -B task/T-XXX
  // <wt> feature/<change>`), и upstream у них не выставлен, поэтому спрашивать
  // `HEAD@{upstream}` бессмысленно — он не определён и ответ был бы «не пусто» всегда.
  const change = activeChange()
  const base = change ? `feature/${change}` : null
  if (!base) return false
  try {
    const dirty = execFileSync('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (dirty.trim()) return false
    const ahead = execFileSync('git', ['-C', path, 'rev-list', '--count', `${base}..HEAD`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return ahead === '0'
  } catch {
    return false
  }
}

function prune() {
  const o = orphans()
  const removed = []
  const kept = []
  // Сухой прогон — потому что осторожность не должна стоить удаления (Д-61). Стадия, которая
  // перед разрушающей командой хочет посмотреть, что та снесёт, получала саму команду:
  // спрашивать было нечем. Теперь есть чем, и ответ тот же, что у `orphans`, только названный
  // словами действия: вот это я снесу, а вот это оставлю человеку.
  if (args.dry_run) {
    return {
      dry_run: true,
      would_remove: o.orphans.map((w) => w.path),
      kept: [],
      left: o.orphans.length,
      stashes: o.stashes && o.stashes.count ? o.stashes : null,
      note:
        'ничего не тронуто. Дерево с незакоммиченной работой prune не сносит и без сухого ' +
        'прогона: сначала он пробует `worktree remove` без силы, и git сам отказывается — ' +
        'силой давится только пустое (правило движка себе не мягче, чем роли). Снести на ' +
        'самом деле: та же команда без --dry-run.',
    }
  }
  for (const w of o.orphans) {
    // `--force` только там, где доказано, что терять нечего. Промпт слияния запрещает
    // стадии `worktree remove --force` прямым текстом — потому что там дерево может
    // держать незакоммиченную работу, и сила означает её потерю. Движок не вправе
    // держать для себя правило мягче, чем для роли (находка обкатки проект-В 01.10.2026).
    //
    // Поэтому сначала пробуем без силы: git сам откажется сносить дерево с правками.
    // Отказал — смотрим, пусто ли, и давим только пустое. Не пусто — оставляем человеку
    // и говорим, почему.
    try {
      execFileSync('git', ['-C', root, 'worktree', 'remove', w.path], { stdio: 'ignore' })
      removed.push(w.path)
      continue
    } catch { /* ниже разберёмся, можно ли силой */ }
    if (!isEmptyWorktree(w.path) && existsSync(join(w.path, '.git'))) {
      kept.push(`${w.path} — в дереве есть работа, снести без потери нельзя`)
      continue
    }
    try {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', w.path], { stdio: 'ignore' })
      removed.push(w.path)
    } catch {
      try {
        rmSync(w.path, { recursive: true, force: true })
        removed.push(w.path + ' (rm)')
      } catch {
        kept.push(`${w.path} — удалить не удалось, разобрать человеку`)
      }
    }
  }
  try {
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'ignore' })
  } catch { /* не критично */ }
  // Осталась ли служебная запись — ЧИТАЕМ, а не выводим из кодов возврата (замер проект-В
  // 08.11.2026 по Д-58). Исход сноса дерева из сессии перемежается: дважды `worktree remove`
  // падал на `failed to delete '.git/worktrees/<имя>': Operation not permitted`, а на свежем
  // дереве тот же вызов снёс всё, включая запись, и до силы с `rmSync` дело не дошло. Причина
  // не найдена ни одной из трёх точек замера — и правило, выведенное из кодов возврата, было
  // бы догадкой. Вопрос «что осталось» догадки не требует: git отвечает на него прямо.
  // Карманы `prune` НЕ трогает — он их только передаёт дальше. Уборка worktree и уборка
  // стэшей это разные по риску действия: пустой каталог движок создавал сам и знает, что
  // в нём ничего нет, а в кармане может лежать единственная копия работы.
  const registryLeft = prunableNames(root)
  return {
    removed, kept, left: o.orphans.length - removed.length,
    registry_left: registryLeft.length > 0,
    registry_left_names: registryLeft,
    registry_note: registryLeft.length
      ? 'служебные записи остались: каталога нет, а git про дерево помнит (prunable). Ветка ' +
        'числится занятой, и `git branch -d` откажет даже при влитой работе. Доделать: ' +
        '`git -C <корень> worktree prune` вне сессии — записи внутри `.git` песочница ' +
        'закрывает на запись НЕ всегда, но когда закрывает, доделать может только человек.'
      : null,
    stashes: o.stashes && o.stashes.count ? o.stashes : null,
  }
}

// Деревья, о которых git помнит, а каталога нет. Спрашивается порселеном, а не грепом по
// человеческому выводу: `prunable` в нём отдельная строка признака.
function prunableNames(dir) {
  let out = null
  try {
    out = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  } catch {
    return []
  }
  const left = []
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9).trim()
    else if (line.startsWith('prunable') && cur) left.push(cur)
  }
  return left
}



function textBoard(b) {
  if (!b.tasks || !b.tasks.length) return `change: ${b.change || '—'} — задач нет`
  // Связь «баг → задача» в данных односторонняя: у бага есть fix_task, у задачи ссылки
  // на баги нет. Но обращается она чистым отображением, без нового поля и нового
  // источника истины, — и в дашборде это давно сделано (fixMap в dashboard.mjs рисует
  // метку «исправление BUG-…» на узле графа и в таблице). В текстовой доске этого не
  // было, из-за чего связь выглядела односторонней у того, кто смотрит в терминал.
  const fixes = new Map()
  for (const bug of listBugs(root)) {
    if (!bug.fix_task) continue
    if (b.change && bug.change && bug.change !== b.change) continue
    if (!fixes.has(bug.fix_task)) fixes.set(bug.fix_task, [])
    fixes.get(bug.fix_task).push(bug.id)
  }
  const lines = [`change: ${b.change} · слотов ${b.slots_used}/${b.parallelism} · событий ${b.events}`]
  for (const t of b.tasks) {
    const why = t.waiting_for.length ? ` (${t.waiting_for.join(', ')})` : ''
    const fix = fixes.has(t.id) ? ` [чинит ${fixes.get(t.id).join(', ')}]` : ''
    lines.push(
      `  ${t.id.padEnd(8)} ${String(t.status).padEnd(12)}${why.padEnd(22)} ` +
      `${t.parallel_safe ? '∥' : ' '}${t.ui ? ' UI' : '   '} ${t.title}${fix}`,
    )
  }
  // Отставший кэш статусов — ДВА разных состояния, и доска их смешивала (Д-4 разбора
  // прогона проект-В 11.10.2026). У задачи, чьё рабочее дерево живо, `sync` правку
  // откладывает НАМЕРЕННО: запись в файл задачи из главного дерева стоит отказа слияния
  // «Your local changes would be overwritten». То есть доска советовала команду, которая
  // по замыслу ничего не сделает, — и повторный запуск читается как «команда не работает».
  // Предикат тот же, которым пользуется сам `sync`: `inFlightTickets`. Молчание git-а
  // (`null`) там означает «отложить всё», значит и здесь.
  const stale = b.tasks.filter((t) => t.cache_stale)
  if (stale.length) {
    const inFlight = inFlightTickets(root)
    const held = inFlight ? stale.filter((t) => inFlight.has(t.id)) : stale
    const fixable = inFlight ? stale.filter((t) => !inFlight.has(t.id)) : []
    if (fixable.length) lines.push(`  ⚠ кэш статусов отстал у ${fixable.length} задач — firm-event.mjs sync`)
    if (held.length) {
      lines.push(
        `  · кэш статусов отстал у ${held.length} задач в работе — правка отложена до слияния, истина в журнале`,
      )
    }
  }
  return lines.join('\n')
}

// ── Пауза сборки ──────────────────────────────────────────────────────────────
// Остановить прогон на полуслове — значит бросить задачи в работе: дерево останется
// грязным, стадия не допишет событие, а следующая сессия увидит непонятное. Пауза
// делает иначе: запущенные задачи доводятся до конца, новые не начинаются.
//
// Флаг лежит в .firm/current/ — каталоге, который уже в .gitignore: это состояние
// одного прогона на одной машине, в репозитории ему не место.
// Чтение флага — из lib: читателей два (эта команда и хук SubagentStart, который паузу
// держит), и два чтения одного файла двумя способами дали бы два разных ответа.
const pauseFile = () => pauseFilePath(root)

// Флага мало: он отвечает «стоит ли пауза СЕЙЧАС» и ничего не говорит о том, сколько она
// стояла. А время паузы — чужое: прогон им не распоряжается (ADR-0009) и отвечать за него
// в замерах не должен. Поэтому границы паузы уезжают в журнал событиями `paused`/`resumed`,
// и тайминг вычитает их из ожидания (`waiting_pause_ms` в timing).
// Событие по прогону, не по задаче: `ticket: 'MR'` — тот же приём, что у стадий разведки.
// Статуса задач эти события не меняют (statusFromEvents их пропускает) — только время.
function pauseEvent(kind, reason) {
  try {
    writeEvent(root, {
      ticket: 'MR',
      stage: 'lifecycle',
      event: kind,
      actor: 'human',
      change: activeChange(),
      notes: reason || null,
    })
    return true
  } catch {
    // Журнал молчит только в одном случае — когда записать не вышло (ADR-0007 оставляет
    // журналу это право). Пауза при этом ставится всё равно: отказать человеку в остановке
    // прогона из-за неудачной записи было бы хуже, чем потерять замер. Но сказать надо.
    return false
  }
}

function pause(reason) {
  mkdirSync(join(root, '.firm', 'current'), { recursive: true })
  const payload = { ts: new Date().toISOString(), reason: reason || null }
  writeFileSync(pauseFile(), JSON.stringify(payload, null, 1) + '\n')
  const journaled = pauseEvent('paused', reason)
  return {
    ok: true,
    paused: true,
    ...payload,
    journaled,
    note: 'Задачи в работе будут доведены до конца, новые не начнутся. Снять — firm-state.mjs resume'
      + (journaled ? '' : ' (ВНИМАНИЕ: событие паузы в журнал не записалось — время паузы уйдёт в ожидание движка)'),
  }
}

function resume() {
  const p = pauseFile()
  if (!existsSync(p)) return { ok: true, paused: false, note: 'паузы не было' }
  rmSync(p)
  const journaled = pauseEvent('resumed', null)
  return {
    ok: true,
    paused: false,
    journaled,
    note: 'пауза снята — можно запускать /firm-build'
      + (journaled ? '' : ' (ВНИМАНИЕ: событие снятия в журнал не записалось — пауза в замерах останется открытой)'),
  }
}

// Номера задач и багов сквозные по проекту (см. nextIds в lib/firm.mjs).
function nextId() {
  const count = Number(args.count) > 0 ? Number(args.count) : 1
  // Номера бизнес-правил выдаются той же командой, что номера задач, и это решение, а не
  // удобство: у PM должно быть одно место, где спрашивают свободный номер. Своя
  // арифметика по документу — ровно то, из-за чего два параллельных груминга берут один
  // номер (разбор стадии PM 22.10.2026).
  if (args.kind === 'br') {
    const r = nextBr(root, count)
    const f = brFindings(root)
    return f.length ? { ...r, findings: f } : r
  }
  // Освобождение брони — обратная сторона выдачи, и без неё распределитель раздувает
  // нумерацию на каждой диагностике: броня у багов ставится по умолчанию (это лечило три
  // столкновения подряд), а дороги назад не было вовсе. След нашёлся живым — `BUG-175` в
  // проект-В без файла бага, положенный диагностическим вызовом 05.11.2026.
  if (args.release) return releaseId(root, String(args.release))
  // Номера решений проекта — тот же распределитель, и по тому же доводу, что у правил:
  // одно место, где спрашивают свободный номер. Своя арифметика по каталогу — ровно то,
  // из-за чего два груминга берут один номер (Д-50, проект-В 05.11.2026).
  if (args.kind === 'adr') return nextAdr(root, count)
  // Вид, которого распределитель не знает, до 05.11.2026 МОЛЧА становился задачным:
  // `--kind adr` отдавал `{ kind: "task", id: "T-336" }`. Теперь отказ — и отказ этот
  // печатается в stderr, а код возврата 2, потому что ответа на заданный вопрос нет.
  const kind = args.kind === undefined || args.kind === null || args.kind === '' ? 'task' : String(args.kind)
  // Номер БАГА выдаётся с бронью по умолчанию, номер задачи — нет, и это не
  // непоследовательность, а разные способы применения (отчёт проект-В 03.11.2026, находка 4).
  //
  // Баг заводят ПАРАЛЛЕЛЬНО идущие стадии, каждая в своём рабочем дереве, и каждая по
  // одному номеру за раз: броня здесь — единственное, что разводит их, потому что файла
  // бага в главном дереве ещё нет, а ветку задачи не читает никто. Три столкновения
  // подряд (BUG-158, BUG-159, BUG-171) — это не невезение, а отсутствие механизма.
  //
  // Задачи режет Архитектор на планировании, один, и сразу десятками: там спрашивают «с
  // какого номера начинать» и тут же пишут файлы — бронь на двадцать номеров вперёд
  // только оставит мусор, если нарезка сменится. Нужна броня и там — `--claim`.
  //
  // Посмотреть без брони — `--peek`: `max_used` для сверки, список для разговора.
  const claim = args.peek ? false : (args.claim ? true : kind === 'bug')
  const r = nextIds(root, { kind, count, claim, by: args.by || null })
  const dups = duplicateIds(root)
  return dups.length ? { ...r, duplicates: dups } : r
}

// ── Груминг: темы в разборе, каждая в своём дереве (ADR-0012) ────────────────
//
// Разведка не материализует поставку: папку в `openspec/changes/` заводит планирование.
// До него тема живёт досье в бэклоге и учётной записью в `.firm/groom/`, а работа идёт в
// отдельном дереве от `main` — поэтому груминг не мешает идущей сборке и может идти в
// нескольких сессиях разом.
//
// Дерево заводит КОД, а не промпт команды: три шага (номер → ветка → дерево) человек или
// роль сделают по-разному, а дальше движок не найдёт ни дерева, ни досье там, где их ищет.

// На какой ветке стоит проект. `main` не универсален: часть репозиториев живёт на
// `master`, и заводить ветку груминга от несуществующей базы значит падать на первом шаге.
function baseBranch() {
  const named = cfg && cfg.main_branch
  if (named) return String(named)
  for (const b of ['main', 'master']) {
    try {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { stdio: 'ignore' })
      return b
    } catch { /* пробуем следующую */ }
  }
  return 'HEAD'
}

// Слаг идёт в имя ветки и каталога досье, поэтому он латинский (кириллица в путях и
// именах ветвей — это та же приписка не туда, что дефект Д-6). Из русского заголовка он
// не выводится, и выдумывать транслитерацию движок не станет: не вывелся — спросить.
function slugFromTitle(title) {
  const s0 = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s0 || null
}

// Учётные записи НЕ коммитятся, и это не экономия, а защита поставки. Главное дерево всю
// сборку стоит на ветке поставки: любой новый файл в нём попадает в её коммиты и в MR-дифф
// — ровно та беда, из-за которой `.firm/dashboard.html` пришлось выносить в .gitignore.
// Поэтому запись прячется в `.git/info/exclude` — он локальный и сам никуда не уезжает,
// то есть и правка `.gitignore` в дифф не попадёт.
//
// Потерять запись не страшно: истина — досье в git и ветка груминга, а номер защищён
// каталогом досье (см. `usedGroomIds`). Запись лишь говорит движку, что тема существует.
function hideGroomRegistry() {
  const path = join(root, '.git', 'info', 'exclude')
  const line = '.firm/groom/'
  try {
    const was = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (was.split('\n').some((l) => l.trim() === line)) return { hidden: true, added: false }
    mkdirSync(join(root, '.git', 'info'), { recursive: true })
    writeFileSync(path, `${was}${was && !was.endsWith('\n') ? '\n' : ''}# firm2: учётные записи груминга локальные (ADR-0012)\n${line}\n`)
    return { hidden: true, added: true }
  } catch (e) {
    return { hidden: false, added: false, note: `не смог спрятать .firm/groom/ в .git/info/exclude: ${e.message}` }
  }
}

function groomList() {
  const view = groomView(root, cfg)
  // Заявки, по которым темы ещё нет. Это не находка (заявка — штатный шаг), но видеть их
  // надо: номер занят, а работы за ним пока нет, и человек вправе спросить почему.
  const known = new Set(view.map((g) => g.id))
  const claimed = [...groomClaims(root)].filter(([id]) => !known.has(id)).map(([id, c]) => ({ id, ts: c.ts, actor: c.actor, notes: c.notes }))
  return { groom_dir: groomWorktreesDir(root, cfg), count: view.length, groom: view, claimed, findings: groomFindings(root, cfg) }
}

// Заявка на номер темы. Нужна там, где между «номер выбран» и «каталог, файл и ветка
// заведены» есть работа: распределитель читает носители, а их ещё нет. Замер проект-В
// 02.11.2026: два столкновения, оба здесь, оба разобраны переномерованием после факта.
//
// Заявка НЕ заводит тему: ни дерева, ни записи, ни досье. Она занимает номер и называет,
// подо что — без `--title` заявка говорит следующему спрашивающему ровно ничего, то есть
// не отличается от молчания (тот же довод, что у `groom new`).
function groomClaim() {
  const title = args.title ? String(args.title) : null
  if (!title) return { ok: false, error: 'нужен --title "подо что номер": заявка без предмета не отличима от молчания' }
  const want = args.id ? String(args.id).toUpperCase() : null
  const used = usedGroomIds(root)
  if (want && !/^G-\d+$/.test(want)) return { ok: false, error: `номер темы должен быть вида G-015, а пришёл «${want}»` }
  if (want && used.has(want)) {
    return { ok: false, error: `${want} уже занят (${used.get(want).join(', ')}) — номера не переиспользуются, возьми следующий свободный без --id` }
  }
  const id = want || nextGroomId(root)
  writeEvent(root, {
    ticket: id,
    change: null,
    stage: 'groom',
    event: 'number-claimed',
    actor: args.actor ? String(args.actor) : 'human',
    notes: `номер заявлен подо что: ${title}`,
  })
  return {
    ok: true,
    id,
    title,
    // Поле называется `actor` ровно потому, что утверждать «заявку подал человек» движок не
    // может: команду зовут и руками, и оркестратором сессии. Что записано в журнал, то и
    // показано; кто именно — передаётся ключом `--actor` (находка проект-В 02.11.2026).
    actor: args.actor ? String(args.actor) : 'human',
    note: `номер ${id} занят заявкой в журнале. Темы ещё нет: заводит её groom new --id ${id} --title "${title}" — ` +
      `ключ --id ОБЯЗАТЕЛЕН, без него тема возьмёт следующий свободный номер, а заявленный останется висеть. ` +
      `Записано actor: ${args.actor ? String(args.actor) : 'human'} — если заявку подаёт механизм, передай --actor. ` +
      'Заявка ошибочна — снимается аннулированием события (firm-event.mjs record --event retracted --corrects <файл заявки>), ' +
      'своей команды отмены нет намеренно: второй способ отменять события — это второй источник истины',
  }
}

function groomNew() {
  const title = args.title ? String(args.title) : null
  if (!title) return { ok: false, error: 'нужен --title "о чём тема": без него учётная запись ничего не говорит человеку' }
  const slug = args.slug ? String(args.slug) : slugFromTitle(title)
  if (!slug) {
    return {
      ok: false,
      error: `из заголовка «${title}» слаг не вывелся — передать --slug латиницей (он идёт в имя ветки и каталога досье)`,
    }
  }
  const used = usedGroomIds(root)
  for (const [id, where] of used) {
    const rec = readGroom(root, id)
    if (rec && rec.slug === slug) return { ok: false, error: `слаг «${slug}» уже занят темой ${id} (${where.join(', ')})` }
  }
  // Номер, занятый СВОЕЙ ЖЕ заявкой, темой и забирается — ради этого заявка и заведена.
  // Берётся он только явным `--id`: угадывать, какая из заявок «та самая», движку не по
  // чему (заголовок — текст человека, и совпадать он не обязан), а угаданная заявка
  // склеила бы две темы в одном номере — ровно то, против чего всё это стоит.
  const want = args.id ? String(args.id).toUpperCase() : null
  if (want && !/^G-\d+$/.test(want)) return { ok: false, error: `номер темы должен быть вида G-015, а пришёл «${want}»` }
  if (want) {
    const where = used.get(want) || []
    const onlyClaim = where.every((w) => String(w).startsWith('заявка в журнале'))
    if (!onlyClaim) {
      return { ok: false, error: `${want} уже занят (${where.join(', ')}) — номера не переиспользуются, заводи тему без --id` }
    }
  }
  const id = want || nextGroomId(root)
  const branch = groomBranch(id, slug)
  const base = args.base ? String(args.base) : baseBranch()
  const path = join(groomWorktreesDir(root, cfg), `${id}-${slug}`)
  mkdirSync(groomWorktreesDir(root, cfg), { recursive: true })
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', branch, path, base], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    // Запись не пишется: тема без дерева — это тема, которую некуда грумить, а номер,
    // выданный впустую, занят навсегда (переиспользование номеров запрещено).
    return { ok: false, error: `не смог завести дерево ${path} от ${base}: ${String(e.stderr || e.message).trim()}` }
  }
  const hidden = hideGroomRegistry()
  const rec = writeGroom(root, {
    id, slug, title, status: 'grooming', branch, worktree: path, base,
    release: args.release ? String(args.release) : null,
  })
  return {
    ok: true,
    ...rec,
    registry_hidden: hidden,
    dossier: join('docs', 'backlog', `${id}-${slug}`),
    note: `грумить в ${path} (ветка ${branch} от ${base}); досье коммитить там же, в главное дерево оно приедет на /firm-plan --from ${id}`,
  }
}

function groomSet() {
  const id = args._[2] ? String(args._[2]) : null
  if (!id) return { ok: false, error: 'нужен номер темы: groom set G-001 --status groomed' }
  const was = readGroom(root, id)
  if (!was) return { ok: false, error: `темы ${id} движок не знает — firm-state.mjs groom list покажет, что есть` }
  if (args.slug) {
    return {
      ok: false,
      error: 'слаг не меняется: его уже носят ветка и каталог досье, и переименование тут означало бы перенос обоих руками',
    }
  }
  const patch = { id }
  if (args.status) patch.status = String(args.status)
  if (args.release) patch.release = String(args.release)
  if (args.title) patch.title = String(args.title)
  if (Object.keys(patch).length === 1) {
    return { ok: false, error: `нечего менять: --status (${GROOM_STATUSES.join(' | ')}), --release или --title` }
  }
  try {
    return { ok: true, ...writeGroom(root, patch), findings: groomFindings(root, cfg) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Дерево отдаётся после того, как работа груминга влита. Силы здесь нет намеренно: git
// сам откажется сносить дерево с правками, и отказ — это ответ «работа ещё там», а не
// помеха. Ветку не удаляем: она уже влита, и её удаление — решение человека.
function groomRetire() {
  const id = args._[2] ? String(args._[2]) : null
  if (!id) return { ok: false, error: 'нужен номер темы: groom retire G-001' }
  const rec = readGroom(root, id)
  if (!rec || rec._broken) return { ok: false, error: `темы ${id} движок не знает${rec && rec._broken ? `: ${rec._broken}` : ''}` }
  const path = rec.worktree || null
  let removed = null
  let kept = null
  if (path && existsSync(path)) {
    try {
      execFileSync('git', ['-C', root, 'worktree', 'remove', path], { stdio: ['ignore', 'ignore', 'pipe'] })
      removed = path
    } catch (e) {
      kept = `${path} — ${String(e.stderr || e.message).trim()}`
    }
  }
  const next = writeGroom(root, { id, status: 'planned' })
  return { ok: !kept, ...next, removed, kept, findings: groomFindings(root, cfg) }
}

// Тема уезжает на планирование: ветка груминга вливается в базу, дерево отдаётся.
//
// Это единственное место во всём груминге, где движок меняет историю, и поэтому здесь
// четыре отказа вперёд одного слияния. Каждый отсекает свой способ потерять работу:
// слияние не в ту ветку, слияние поверх незакоммиченных правок человека, слияние,
// теряющее правки в самом дереве груминга, и слияние пустоты (грумить забыли, а тему
// закрывают). Конфликт откатывается `merge --abort`: разбирать его руками человек будет
// в чистом дереве, а не в недомёрженном.
function groomLand() {
  const id = args._[2] ? String(args._[2]) : null
  if (!id) return { ok: false, error: 'нужен номер темы: groom land G-001' }
  const rec = readGroom(root, id)
  if (!rec || rec._broken) return { ok: false, error: `темы ${id} движок не знает${rec && rec._broken ? `: ${rec._broken}` : ''}` }
  const branch = rec.branch || (rec.slug ? groomBranch(id, rec.slug) : null)
  if (!branch) return { ok: false, error: `${id}: в записи нет ни ветки, ни слага — вливать нечего` }
  const base = args.base ? String(args.base) : rec.base || baseBranch()
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  let head = null
  try {
    head = git('rev-parse', '--abbrev-ref', 'HEAD')
  } catch (e) {
    return { ok: false, error: `git не ответил, где стоит главное дерево: ${String(e.stderr || e.message).trim()}` }
  }
  if (head !== base) {
    return { ok: false, error: `главное дерево стоит на «${head}», а тему надо влить в «${base}» — переключить и повторить` }
  }
  let dirty = ''
  try {
    dirty = git('status', '--porcelain')
  } catch { dirty = '' }
  if (dirty) return { ok: false, error: `в главном дереве есть незакоммиченные правки — слияние их перезапишет:\n${dirty}` }
  if (rec.worktree && existsSync(rec.worktree)) {
    let left = ''
    try {
      left = execFileSync('git', ['-C', rec.worktree, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    } catch { left = '' }
    if (left) return { ok: false, error: `в дереве груминга есть незакоммиченная работа — закоммитить её там же:\n${left}` }
  }
  let commits = null
  try {
    commits = Number(git('rev-list', '--count', `${base}..${branch}`))
  } catch (e) {
    return { ok: false, error: `не смог сравнить ${branch} с ${base}: ${String(e.stderr || e.message).trim()}` }
  }
  if (!commits) {
    return { ok: false, error: `на ветке ${branch} нет коммитов поверх ${base} — досье не написано, вливать нечего` }
  }
  try {
    git('merge', '--no-ff', '--no-edit', branch)
  } catch (e) {
    try {
      git('merge', '--abort')
    } catch { /* нечего откатывать */ }
    return { ok: false, error: `слияние ${branch} в ${base} не прошло и откачено: ${String(e.stdout || e.stderr || e.message).trim()}` }
  }
  const retired = groomRetire()
  const slug = rec.slug || ''
  return {
    ok: true,
    id,
    merged: branch,
    into: base,
    commits,
    dossier: slug ? join('docs', 'backlog', `${id}-${slug}`) : null,
    change_name: slug ? `${new Date().toISOString().slice(0, 10)}-${slug}` : null,
    removed: retired.removed,
    kept: retired.kept,
    status: retired.status,
    note: 'папку поставки заводит планирование: openspec new change <change_name>, дальше PM раскладывает досье в proposal.md',
  }
}

function groom() {
  const sub = args._[1] ? String(args._[1]) : 'list'
  switch (sub) {
    case 'list': return groomList()
    case 'new': return groomNew()
    case 'claim': return groomClaim()
    case 'set': return groomSet()
    case 'retire': return groomRetire()
    case 'land': return groomLand()
    case 'cost': return groomCost(root)
    default: return { ok: false, error: `не знаю подкоманду «${sub}»: list | claim | new | set | land | retire | cost` }
  }
}

// Критерии приёмки поставки: проверяемы ли они. Отдельной командой, потому что зовёт её
// гейт планирования — до ворот человека, когда критерий ещё правится текстом.
function criteria() {
  const change = activeChange()
  const tasks = listTasks(root, change)
  return {
    change,
    tasks: tasks.length,
    browser_tasks: tasks.filter((t) => t.labels.includes('требует-браузера')).map((t) => t.id),
    // Задачи с триггером безопасности — перечнем, на ворота планирования. Находки по
    // ним движок не выдумывает: назвать триггер может только тот, кто читал замысел,
    // а признака в диффе на планировании ещё нет (дифф не существует). Поэтому здесь
    // счёт, а не суд: человек видит, сколько задач поставки пойдёт панелью и за что.
    security_tasks: tasks.filter((t) => t.labels.includes('чувствительный-к-безопасности')).map((t) => t.id),
    browser_harness: (cfg && cfg.browser_harness) || null,
    browser_binary: (cfg && cfg.browser_binary) || null,
    measured: Object.fromEntries(tasks.filter((t) => t.measured).map((t) => [t.id, t.measured])),
    // Задачи с экраном и файл макета — названными, а не только находкой. Человек на
    // воротах утверждает экраны; чтобы он мог их открыть, путь надо сказать вслух, а
    // не оставить его в тексте команды (разбор стадии Дизайнера 22.10.2026).
    ui_tasks: tasks.filter((t) => t.ui).map((t) => t.id),
    design_file: tasks.some((t) => t.ui) ? designFile(change) : null,
    criteria_count: Object.fromEntries(tasks.map((t) => [t.id, criteriaLines(t.body).length])),
    findings: criteriaFindings(root, change, cfg),
  }
}

// Объявленные границы модулей против настоящего диффа поставки.
//
// Отдельной командой, а не полем `criteria`, по одной причине: на планировании диффа ещё
// нет. Эту сверку читает ревью ПОСТАВКИ — там дифф `feature → main` уже существует, и
// именно там видно, что объявление и код разошлись. Замер проект-В 3.2: две находки из
// восьми объявлений (`app/ruleset/schema.py` получил новое поле, `app/game` — правку),
// и обе прошли всю поставку незамеченными.
function boundaries() {
  const change = args.change || activeChange()
  const refs = (args.base || args.branch)
    ? { base: args.base ? String(args.base) : null, branch: args.branch ? String(args.branch) : null }
    : null
  const doc = change ? designDoc(root, change) : null
  const declared = doc && existsSync(doc) ? declaredFrozen(readFileSync(doc, 'utf8')) : []
  return {
    change,
    design: doc ? doc.slice(root.length + 1) : null,
    declared: declared.map((d) => ({ path: d.path, why: d.why })),
    findings: boundaryFindings(root, change, cfg, refs),
  }
}

// Проверка стека: выполняются ли на самом деле `lint_cmd` и `test_cmd` из .firm/config.
//
// Движок на линтер РАССЧИТЫВАЕТ: DoD объявляет линт-ошибку провалом сборки, а
// firm-rename-dir.mjs гоняет lint_cmd после замены и при красном откатывает всё через
// reset --hard. Линтера в проекте нет — команда падает с «command not found», и скрипт
// откатывает КОРРЕКТНОЕ переименование, сообщив, что проверка красная. Человек идёт
// искать ошибку в замене, которой нет. Поэтому команду надо проверить один раз на
// настройке, а не выяснять это посреди отката.
//
// Проверяем вхолостую — `--version`, а не прогон: нам нужно «исполняется ли», а не
// «зелено ли». Полный прогон на настройке был бы долгим и красным по делу, что для
// этого вопроса шум.
function probeCmd(cmd) {
  if (!cmd) return { configured: false }
  // Берём первое слово: `uv run pytest` проверяется по `uv`, `ruff check .` — по `ruff`.
  // Обёртка вроде uv сама разберётся со своим окружением; нас интересует, есть ли вход.
  const bin = String(cmd).trim().split(/\s+/)[0]
  try {
    execFileSync(bin, ['--version'], { cwd: root, stdio: 'ignore', timeout: 20000 })
    return { configured: true, cmd, bin, available: true }
  } catch (e) {
    return { configured: true, cmd, bin, available: false, error: e.code || 'ошибка запуска' }
  }
}

// Линтер по языку. Список короткий и намеренно не претендует на полноту: он отвечает на
// вопрос «что предложить, если не настроено», а не «чем обязан пользоваться проект».
const DEFAULT_LINTERS = {
  python: { cmd: 'ruff check .', install: 'uv add --dev ruff  (или pipx install ruff)' },
  javascript: { cmd: 'npx eslint .', install: 'npm i -D eslint' },
  typescript: { cmd: 'npx eslint .', install: 'npm i -D eslint' },
}

// Окружение Python: чем проект управляет зависимостями и доступно ли это движку.
//
// Почему движку не всё равно. Стадии идут в ОТДЕЛЬНЫХ рабочих деревьях, до трёх
// одновременно (§9). `uv run pytest` поднимает окружение из `pyproject.toml` + `uv.lock`
// в том дереве, где его запустили, и агенту не надо ни активировать venv, ни знать, где
// он лежит. С venv+pip каждое новое дерево — отдельная ручная установка, и получается
// худший вид поломки: команда есть в одном дереве и нет в соседнем, то есть стадия
// краснеет через раз и выглядит как флакающий тест.
//
// Это довод, а не требование: poetry и pip движок обслуживает — ему нужны лишь рабочие
// `lint_cmd` и `test_cmd`. Поэтому здесь ни одного «нельзя», только названная цена.
//
// pyproject читаем ТЕКСТОМ, по заголовкам секций: парсера TOML в зависимостях нет и
// тянуть его ради двух строк незачем. Поэтому ответ честно называет себя признаком, а
// не разбором — «похоже, dev-инструменты в optional-dependencies», а не «они там».
function pythonEnv() {
  const has = (f) => existsSync(join(root, f))
  const pyproject = has('pyproject.toml')
  const applies = pyproject || has('manage.py') || has('requirements.txt') ||
    String((cfg && cfg.stack && cfg.stack.language) || '').toLowerCase() === 'python'
  if (!applies) return { applies: false }

  let toml = ''
  if (pyproject) {
    try {
      toml = readFileSync(join(root, 'pyproject.toml'), 'utf8')
    } catch {
      toml = ''
    }
  }

  let manager = null
  if (has('uv.lock')) manager = 'uv'
  else if (has('poetry.lock') || /^\[tool\.poetry\]/m.test(toml)) manager = 'poetry'
  else if (has('requirements.txt')) manager = 'pip'
  else if (pyproject) manager = 'pyproject без локфайла'

  const uvAvailable = (() => {
    try {
      execFileSync('uv', ['--version'], { cwd: root, stdio: 'ignore', timeout: 20000 })
      return true
    } catch {
      return false
    }
  })()

  // Кэш uv. Находка обкатки проект-Г 01.10.2026: `~/.cache/uv` закрыт песочницей,
  // и на этой машине ЛЮБОЙ `uv run` падает на инициализации кэша. Поломка самого
  // неприятного вида — краснеет каждая стадия, а выглядит это как флакающий тест.
  //
  // Лечится РАЗРЕШЕНИЕМ, а не переносом: два каталога uv в `allowWrite` проектного
  // `.claude/settings.json`. Так сделано на проект-А и проект-В, и это верный путь —
  // кэш остаётся общим и на своём месте.
  //
  // Перенос кэша внутрь репозитория (`UV_CACHE_DIR: ".uv-cache"`) выглядит аккуратнее,
  // но хуже по трём причинам, и предлагать его не надо: десятки мегабайт и сотни файлов
  // попадают в дерево, которое индексирует codegraph (ровно та причина, по которой сами
  // рабочие деревья держат снаружи); относительный путь разрешается в каждом дереве
  // задачи по-своему, так что кэш из общего становится тройным и пакеты качаются заново
  // на каждую задачу; и каталог приходится держать в `.gitignore` вечно.
  //
  // Здесь важна разница с каталогом по имени (`config`, §1b): ТОТ запрет снять
  // настройками нельзя, песочница собирает список имён при старте. Кэш закрыт не по
  // имени, а потому что лежит вне рабочего каталога, — и `allowWrite` на него действует.
  // Путать эти два случая легко, а выводы у них противоположные.
  const cache = uvCacheState(uvAvailable)

  const devGroup = /^\[dependency-groups\]/m.test(toml)
  const optionalDev = /^\[project\.optional-dependencies\]/m.test(toml) &&
    /(^|\n)\s*(dev|test)\s*=/.test(toml)

  const notes = []
  if (!manager) {
    notes.push(
      'Менеджер зависимостей не опознан. Для нового проекта предложи uv: стадии идут в ' +
        'отдельных рабочих деревьях, и `uv run` поднимает окружение в каждом сам.',
    )
  } else if (manager !== 'uv') {
    notes.push(
      `Зависимости ведутся через ${manager}. Движку этого достаточно — переезжать ради ` +
        'firm2 не надо. Знать стоит одно: окружение в каждом рабочем дереве задачи ' +
        'человек обеспечивает сам, движок его не создаёт.',
    )
  }
  if (manager === 'uv' && !uvAvailable) {
    notes.push('Проект на uv (есть uv.lock), но `uv` не запускается — ни одна стадия не пройдёт.')
  }
  if (cache.blocked) {
    notes.push(
      `Кэш uv (${cache.dir}) закрыт на запись (${cache.error}) — на этой машине упадёт ` +
        'любой uv run, то есть каждая стадия, и выглядеть это будет как флакающий тест. ' +
        'Разреши запись в два каталога uv в sandbox.filesystem.allowWrite проектного ' +
        `.claude/settings.json: ${cache.allow.join(', ')}. ` +
        'Кэш при этом остаётся общим и на своём месте. ' +
        'Переносить его внутрь репозитория (UV_CACHE_DIR: ".uv-cache") НЕ надо: сотни ' +
        'файлов попадут в дерево, которое индексирует codegraph, относительный путь даст ' +
        'свой кэш в каждом рабочем дереве задачи с повторным скачиванием пакетов, а ' +
        'каталог придётся держать в .gitignore вечно.',
    )
  }
  if (manager === 'uv' && optionalDev && !devGroup) {
    notes.push(
      'Похоже, dev-инструменты лежат в [project.optional-dependencies], а не в ' +
        '[dependency-groups] dev. При uv это ловушка: `uv run pytest` и `uv run ruff` их ' +
        'не поставят, и стадия упадёт на «command not found» при полном pyproject. ' +
        'Проверь руками — читаем текстом, а не разбором TOML.',
    )
  }
  return {
    applies: true, manager, uv_available: uvAvailable,
    dev_group: devGroup, optional_dev: optionalDev, cache, notes,
  }
}

// Пишется ли кэш uv. Спрашиваем сам uv, где он его держит, а не угадываем по
// переменной: `UV_CACHE_DIR` может быть уже выставлен, и тогда проверять надо новое
// место, а не домашнее.
function uvCacheState(uvAvailable) {
  if (!uvAvailable) return { blocked: false, dir: null }
  let dir = null
  try {
    dir = execFileSync('uv', ['cache', 'dir'], { cwd: root, encoding: 'utf8', timeout: 20000 }).trim()
  } catch {
    return { blocked: false, dir: null }
  }
  // Два каталога, а не один: в `cache dir` лежит кэш загрузок, а установленные
  // интерпретаторы и инструменты uv держит в `~/.local/share/uv`. Разрешить только
  // первый — получить тот же отказ шагом позже.
  const allow = [dir, join(homedir(), '.local', 'share', 'uv')]
  const probe = join(dir, '.firm-probe')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, 'x')
    rmSync(probe)
    return { blocked: false, dir, allow }
  } catch (e) {
    return { blocked: true, dir, allow, error: e.code || 'ошибка записи' }
  }
}

function stack() {
  const st = (cfg && cfg.stack) || {}
  const lint = probeCmd(st.lint_cmd)
  const test = probeCmd(st.test_cmd)
  const notes = []
  if (!lint.configured) {
    const d = DEFAULT_LINTERS[String(st.language || '').toLowerCase()]
    notes.push(
      d
        ? `lint_cmd не задан. Для языка ${st.language} предложи ${d.cmd} (${d.install}) и запиши в .firm/config.`
        : 'lint_cmd не задан — DoD требует чистого линта, а проверять нечем.',
    )
  } else if (!lint.available) {
    notes.push(
      `lint_cmd задан (${lint.cmd}), но ${lint.bin} не запускается. Это ловушка: ` +
        'firm-rename-dir.mjs при красном линте откатывает переименование через reset --hard, ' +
        'и отсутствие линтера выглядит как поломка замены.',
    )
  }
  if (test.configured && !test.available) {
    notes.push(`test_cmd задан (${test.cmd}), но ${test.bin} не запускается.`)
  }
  if (!test.configured) notes.push('test_cmd не задан — критериальное покрытие проверять нечем.')
  // Узкий задачный прогон — признаётся ЗДЕСЬ, иначе он существует только в головах.
  // Умолчание — «тот же, что полный»: сужение это согласие проекта, а не поведение движка.
  const taskTest = probeCmd(st.task_test_cmd || st.test_cmd)
  const narrowed = Boolean(st.task_test_cmd && st.task_test_cmd !== st.test_cmd)
  if (narrowed) {
    notes.push(
      `Задачный прогон СУЖЕН: задачи проверяются «${st.task_test_cmd}», ворота — «${st.test_cmd}». ` +
        'Зелёный на задаче в этом случае не означает зелёный на воротах, и утверждать полноту ' +
        'по нему нельзя. Этой же командой снимается основание сверки красных: две стороны ' +
        'сравнения обязаны покрывать один набор.',
    )
    if (taskTest.configured && !taskTest.available) {
      notes.push(`task_test_cmd задан (${taskTest.cmd}), но ${taskTest.bin} не запускается.`)
    }
    // Состав исключённого — часть ответа про сужение, а не отдельный вопрос (Д-55).
    const ex = excludedTests(cfg)
    notes.push(
      ex.length
        ? `Исключено из задачного прогона (${ex.length}): ` +
          ex.map((e) => `${e.path}${e.by ? ` → предъявляет: ${e.by}` : ' → ПРЕДЪЯВИТЕЛЯ НЕТ'}`).join('; ') +
          '. Файл без предъявителя не гоняет ни одна стадия: первыми его увидят ворота.'
        : 'Состав исключённого НЕ ОБЪЯВЛЕН (stack.task_tests_excluded пуст) — то есть неизвестно, ' +
          'что именно перестало гоняться по задачам и кто это предъявит до ворот.',
    )
  }
  // Политика разбора находок лежит рядом с DoD: движок говорит не только «красный»,
  // но и что с этим делать. Без неё каждый проект решает заново и решает по-разному.
  notes.push('Политика разбора находок линтера — templates/lint-policy.md.')
  const python = pythonEnv()
  if (python.applies) notes.push(...python.notes)
  return {
    ok: lint.available === true && test.available === true,
    language: st.language || null, lint, test, task_test: taskTest, task_tests_narrowed: narrowed,
    task_tests_excluded: excludedTests(cfg),
    python, notes,
  }
}

const cmd = args._[0] || 'phase'
switch (cmd) {
  case 'phase': out(phase()); break
  case 'board': { const b = board(); out(b, args.json ? null : textBoard(b)); break }
  case 'next': out(next()); break
  case 'orphans': out(orphans()); break
  case 'prune': out(prune()); break
  case 'config': out(cfg); break
  case 'models': out(models()); break
  case 'stack': out(stack()); break
  case 'dep': process.stdout.write(dep(args._[1] || '') + '\n'); break
  case 'build-args': {
    const a = buildArgs()
    // `--out <файл>`: вывод кладётся на диск и в терминал идёт только сводка. Вставлять
    // 47 КБ из прокрутки терминала — тот самый путь, на котором и случилась обрезка.
    if (args.out) {
      // Файл аргументов — ЕДИНСТВЕННЫЙ след того, что волна видела на входе. Промпты
      // стадий собирает workflow из `args`, на диск он ничего не пишет (ADR-0002), и
      // восстановить вход прогона потом нечем. Поэтому существующий файл НЕ
      // перезаписывается: рецепт в `firm-build.md` называл фиксированное имя
      // (`$TMPDIR/args.json`), и каждая следующая волна стирала вход предыдущей.
      //
      // Цена этого была замерена на проект-В 02.11.2026, и платил её не движок: разбор
      // сверил стадию одной волны с `args` ДРУГОЙ, на шесть часов старше, и предъявил
      // дефект «стадия несёт тикет, которого не было на входе» — разбор пошёл в сторону
      // самого несущего механизма маршрута (маркер кладёт код, взяться он может только из
      // `args`). Находка снялась сверкой происхождения файлов, но стоила хода обеим
      // сторонам. Молча затирать единственный след — это и есть источник такой ошибки.
      const dest = String(args.out)
      let where = dest
      if (existsSync(dest)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
        const dot = dest.lastIndexOf('.')
        const slash = Math.max(dest.lastIndexOf('/'), dest.lastIndexOf('\\'))
        where = dot > slash ? `${dest.slice(0, dot)}-${stamp}${dest.slice(dot)}` : `${dest}-${stamp}`
      }
      writeFileSync(where, JSON.stringify(a, null, 1) + '\n')
      out({
        wrote: where,
        kept: where === dest ? null : dest,
        bytes: JSON.stringify(a).length,
        integrity: a.integrity || null,
        note: 'Передай в args СОДЕРЖИМОЕ этого файла целиком, ничего не сокращая: сборщик '
          + 'сверит integrity и остановится до первой стадии, если приехало не всё.'
          + (where === dest ? '' : ` Файл «${dest}» от прежней волны оставлен на месте: вход прогона — единственный его след, и затирать его молча нельзя.`),
      })
      break
    }
    out(a)
    break
  }
  case 'next-id': {
    // Отказ печатается человеку словами и возвращает 2: вызвавшая сторона обязана
    // УВИДЕТЬ, что ответа нет. Молчаливая подмена задачным номером была дефектом Д-50.
    let r
    try {
      r = nextId()
    } catch (e) {
      // Те же правила, что у неизвестного вида: отказ слышен, кода возврата 2, ответа
      // в stdout нет. Снять броню с номера, которым уже НАЗВАН файл, — отказ по существу,
      // а не ошибка вызова (И-12: снятие читалось бы как «номер свободен»).
      if (e && ['FIRM2_UNKNOWN_ID_KIND', 'FIRM2_BAD_ID', 'FIRM2_ID_IN_USE', 'FIRM2_RELEASE_FAILED'].includes(e.code)) {
        process.stderr.write(`[firm2] next-id: ${e.message}\n`)
        process.exit(2)
      }
      throw e
    }
    out(r)
    break
  }
  case 'pause': out(pause(args.reason)); break
  case 'resume': out(resume()); break
  case 'plan-shape': out(planShapeCmd()); break
  case 'paused': out(pauseState(root)); break
  case 'adopt': out(adopt()); break
  case 'groom': {
    const g = groom()
    // У `cost` есть человеческий вид: это замер, и читает его человек. У остальных
    // подкоманд его нет намеренно — они про состояние, и там JSON и есть ответ.
    out(g, args._[1] === 'cost' && !args.json ? groomCostLines(g).join('\n') + '\n' : null)
    break
  }
  case 'criteria': out(criteria()); break
  case 'user-path': {
    const up = userPathState(root, activeChange())
    out(up, args.json ? null : userPathLines(up).join('\n') + '\n')
    break
  }
  case 'boundaries': out(boundaries()); break
  case 'settled': out(settled()); break
  case 'lane-check': out(laneCheck()); break
  case 'task-diff': out(taskDiffCmd()); break
  case 'mass': { const m = mass(); out(m, args.json ? null : massLines(m).join('\n') + '\n'); break }
  case 'standards': { const st = standardsCmd(); out(st, args.json ? null : standardsForLines(st).join('\n') + '\n'); break }
  default:
    process.stdout.write(usageText())
}
