#!/usr/bin/env node
// firm-event — запись событий переходов и производного состояния (§6, ADR-0002, ADR-0003).
//
// Кто вызывает:
//   hook         — хуки SubagentStart/SubagentStop (их запускает РАНТАЙМ Claude Code, не модель:
//                  у модели в этом месте нет хода, поэтому пропустить событие она не может);
//   record       — git-хук post-merge и команды маршрута на границах, до которых хуки не дотягиваются
//                  (ворота человека, ручной мерж, отмена задачи);
//   claim        — запасная привязка «агент → тикет», если маркера в промпте не нашлось;
//   sync/doctor  — пересчёт производного кэша и поиск дыр в журнале.
//
// Привязка события к тикету (по убыванию надёжности):
//   1. маркер `FIRM2-TICKET: T-XXX` в промпте — его туда кладёт КОД workflow-скрипта,
//      хук лишь ищет точную строку в машинно-сгенерированном тексте (это не разбор
//      поведения агента, от которого отказывался ADR-0002);
//   2. тот же маркер в СОБСТВЕННОМ транскрипте субагента, найденном по `agent_id`
//      (lib/firm.mjs, markerFromAgent) — единственный источник, доступный на старте;
//   3. `.firm/current/<agent_id>.json` — если стадию заявили командой claim;
//   4. ветка рабочего дерева `task/T-XXX`;
//   5. ничего не нашлось → событие пишется с ticket: "unknown" и exit 2. Дыра в
//      статистике обязана быть громкой, иначе метрике нельзя верить.
//      Непривязанный СТАРТ при этом не дыра: пока стадия идёт, привязку достраивает
//      чтение журнала (resolveFromTranscripts), а к финишу маркер уже на месте.

import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  repoRoot, readConfig, writeEvent, computeBoard,
  patchFrontmatter, listEvents, ticketFromBranch, ensureDir, worktreesDir, listBugs,
  duplicateIds, inFlightTickets, markerFromAgent, markersIn, eventsDir, listTasks, activeChange, listChanges,
  unmergedPaths,
  isBoundTicket, activeChangeFindings, engineVersionFindings, browserSkipFinding,
  structuredOutputFromTranscript, structuredOutputFromAgent,
  areaRules, filesByTask, areaFindings, stageThresholds, pauseState, vcsFindings,
  taskTree, treeOfCommit, acceptedReceipt,
  receiptDigest, STAGES, duplicateFinishSummary, stageBudget, BIND_WAIT_MS,
  journalRootFor, statusFromEvents, requireKnownFlags, concurrencyAt, laneCaps,
  engineVersionState,} from './lib/firm.mjs'
import { buildDashboard } from './dashboard.mjs'
import { abandonedRuns } from './suite-run.mjs'

// Каталог скриптов движка — чтобы команда в отказе была ИСПОЛНИМОЙ, а не шаблоном с
// `$ENGINE`: роль, получившая отказ на `SubagentStop`, переменной из промпта человека не
// видит, а путь к себе скрипт знает точно.
const ENGINE_SCRIPTS = dirname(fileURLToPath(import.meta.url))

// ── Разбор аргументов ─────────────────────────────────────────────────────────

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

// ── Соответствие «роль → стадия» (детерминированное, без разбора транскрипта) ──

// Имена с префиксом `agent-dev-firm:` остаются в таблице после переезда ролей в firm2
// (0.3.0): журнал проекта переживает смену движка, и события старых прогонов должны
// читаться той же таблицей — иначе доска задним числом потеряет стадии.
const STAGE_BY_AGENT = {
  'firm2:firm-developer': 'dev',
  'firm2:firm-tester': 'test',
  'firm2:firm-reviewer-qa': 'review',
  'agent-dev-firm:firm-developer': 'dev',
  'agent-dev-firm:firm-tester': 'test',
  'agent-dev-firm:firm-reviewer-qa': 'review',
  'firm-developer': 'dev',
  'firm-tester': 'test',
  'firm-reviewer-qa': 'review',
  // Адъюдикация: панель QA разошлась, Архитектор заводит баг и выносит вердикт
  // (firm2-build.js, adjudicate). Раньше этой роли в таблице не было, и стадия молчала
  // целиком: прогон 24.09.2026 дал 34 минуты тишины на самой долгой стадии цикла.
  // Невидима она была не только для /firm-monitor и doctor — её время уходило в
  // «ожидание» тайминга, то есть в метрику ожидания человека, которая диагностическая.
  'firm2:firm-architect': 'adjudicate',
  'agent-dev-firm:firm-architect': 'adjudicate',
  'firm-architect': 'adjudicate',
  // Архив спеки и прототип: те же 34 минуты тишины, только дольше — замер 22.10.2026 по
  // четырём живым журналам дал 0 событий `docs/*` и 0 событий `design/*` на 2 511 событий
  // при 213 закрытых поставках. То есть стадия документации не записалась НИ РАЗУ, хотя
  // словарь `STAGES` держит `docs` и `design`, а дашборд держит под них колонки: пустая
  // колонка читается как «стадия не шла», и отличить её от «стадия невидима» было нечем.
  //
  // Тикета у обеих нет по устройству (архив и прототип принадлежат поставке, а не задаче),
  // поэтому промпт получает маркер `FIRM2-TICKET: MR` — так же, как MR-ревью: без него
  // событие уйдёт `unknown`, а это вечная краснота `doctor` на неизменяемом журнале.
  'firm2:firm-docwriter': 'docs',
  'agent-dev-firm:firm-docwriter': 'docs',
  'firm-docwriter': 'docs',
  'firm2:firm-designer': 'design',
  'firm-designer': 'design',
}

// Кроме задач, привязку имеет стадия уровня ПОСТАВКИ — MR-ревью всего диффа
// (firm-build.md §4). Тикета у неё по устройству нет, а событие она пишет, и без
// метки каждый прогон гарантированно оставлял в журнале `unknown` — то есть
// закрытую стадию без привязки, неотличимую от настоящей дыры (BUG-017 пилота).
// Метка `MR` на доску не попадает: computeBoard читает задачи из файлов.
// `T-XXX` из маркера НЕ берём: это заглушка шаблонов, и она уже уезжала в журнал
// привязкой к несуществующей задаче. Без неё срабатывает достройка по agent_id.
// Образцы маркеров и их разбор живут в `lib/firm.mjs` (`markersIn`): их читает и хук, и
// достройка привязки по `agent_id`, и держать два определения одного промпта нельзя —
// до 0.4.105 копий было две, и правка привязки требовала помнить про вторую.

// Транскрипт — jsonl; промпт стадии написан кодом workflow, маркер ищем точным поиском.
//
// Берём ТОЛЬКО собственный транскрипт субагента (`agent_transcript_path`). Проверено
// зондом 2026-09-21: маркер лежит в нём на позиции ~1.5 КБ, тогда как в транскрипте
// РОДИТЕЛЬСКОЙ сессии (`transcript_path`) он же оказался на 563-й тысяче байт —
// и это при трёх параллельных задачах был бы ещё и чужой маркер. Родительский
// транскрипт как источник привязки негоден принципиально, а не по размеру окна.
// Маркер прямо из полезной нагрузки хука. На старте это единственный источник, который
// уже существует: промпт стадии субагенту передали, а транскрипта ещё нет. Поле, в котором
// рантайм приносит промпт, может называться по-разному, поэтому смотрим нагрузку целиком —
// путей к файлам она содержит, а их содержимого нет, так что лишнего не зацепим.
function fromPayload(h) {
  let text = ''
  try {
    text = JSON.stringify(h)
  } catch {
    return {}
  }
  return markersIn(text)
}

// Разбор маркеров — ОДНОЙ функцией на оба источника. До 0.4.105 он стоял двумя копиями, в
// `fromPayload` и `fromTranscript`, и любая правка привязки требовала помнить про вторую.
function fromTranscript(h) {
  const path = h.agent_transcript_path
  if (!path || !existsSync(path)) return {}
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  return markersIn(text)
}

// Расход токенов стадии. Источник — СОБСТВЕННЫЙ транскрипт субагента: каждая строка с
// ответом модели несёт `message.usage`, то есть счёт, предъявленный API. Спрашивать о
// расходе саму модель нельзя (она его не знает), а в payload хука рантайм его не кладёт —
// транскрипт единственное место, где число существует машинно.
//
// Дедупликация по requestId обязательна: один вызов API пишется в транскрипт несколькими
// строками (по блоку контента), и `usage` в них ОДИН И ТОТ ЖЕ. Суммировать как есть —
// завысить расход кратно числу блоков, то есть получить метрику хуже, чем никакой.
//
// Кэш считаем отдельно от свежего ввода: у стадий firm2 на кэш приходится основная масса
// токенов, и смешать их в одно число значит потерять разницу между «стадия думала много»
// и «стадии подали большой контекст».
// Предел на `notes` события — ОДИН на все стадии и выражен в замеренном (Д-26 проект-В
// 29.10.2026, ADR-0010).
//
// Было 500 символов и только у стадии разработки. За одну волну так пропали причины трёх
// эскалаций из трёх: у T-156 от 3158 символов доехало 523, у T-149 от 3750 — 522, то есть
// 83% и 86% текста. Обрыв приходился на середину предложения и ничем не помечался, так что
// отличить обрезку от роли, бросившей фразу на полуслове, было нельзя. А журнал — истина о
// задачах (ADR-0001) и только дописывается (ADR-0006): дополнить событие задним числом
// невозможно, значит портился именно тот источник, который объявлен авторитетным. Причины
// восстановились лишь потому, что две роли по своей воле продублировали замеры в файлы
// задач, а третья — через журнал волны, который живёт в каталоге сессии.
//
// Новый предел — 60 000 символов, и это НЕ «много на всякий случай», а шестнадцать самых
// длинных наблюдавшихся разборов (3750). Ноль тоже не годится: `notes` приходит из вывода
// роли, пишется в журнал, который нельзя почистить, и уходит ДОСЛОВНО в промпт следующей
// стадии — то есть собственная болтливость роли становится и весом журнала, и ценой
// контекста (её считает `context-bill.mjs`). Предел здесь — защита от патологии, а не
// бюджет на разбор: нормальный разбор в него не упирается.
//
// Упёрся — значит это и есть патология, и она ПОМЕЧАЕТСЯ: `notes_truncated` и полная
// длина. Молчащая обрезка была половиной дефекта, а журнал, сказавший «знаю не всё»,
// честен. Полный текст рядом файлом не кладётся намеренно: ADR-0003 держит один файл на
// событие, и второй файл был бы артефактом, которого не читает ни один потребитель.
const NOTES_LIMIT = 60000

function fitNotes(ev, text) {
  const str = String(text)
  if (str.length <= NOTES_LIMIT) return str
  ev.notes_truncated = true
  ev.notes_full_chars = str.length
  return str.slice(0, NOTES_LIMIT) + `\n[обрезано движком: было ${str.length} символов]`
}

function tokensOf(h) {
  const path = h.agent_transcript_path
  if (!path || !existsSync(path)) return null
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const models = new Set()
  // `ctx_peak` — самый большой контекст, с которым стадия обращалась к модели: ввод плюс
  // прочитанный и записанный кэш одного запроса. Это не ещё одна метрика расхода, а
  // объяснение ВРЕМЕНИ: каждый ход перечитывает весь накопленный контекст, и цена хода
  // растёт вместе с ним. Разбор T-058 на проект-В 05.10.2026: стадия шла 141 минуту, из них
  // внутри инструментов — 8; контекст вырос с 22k до 341k, и медиана паузы на ход поднялась
  // с 4.8 секунды (при 104k) до 10.3 (при 295k), а последняя треть стадии съела больше
  // половины её времени. Сумма токенов этого не показывает — она растёт и у быстрой стадии.
  const t = { in: 0, out: 0, cache_read: 0, cache_write: 0, thinking: 0, calls: 0, ctx_peak: 0,
    wait_ms: 0, tool_ms: 0, wait_max_ms: 0 }
  // Разбивка по моделям. Стадии фирмы идут на РАЗНЫХ моделях нарочно (Разработчик —
  // Sonnet, на high-complexity и в надзорном слое — Opus), а цена токена у них разная в
  // разы. Одно суммарное число поэтому отвечает на вопрос «много ли», но не отвечает на
  // «дорого ли»: миллион токенов Sonnet и миллион Opus — это не одно и то же событие.
  // Цен движок не знает и знать не должен (они меняются без него), но разбивку даёт —
  // из неё стоимость считается умножением.
  const byModel = {}
  const bucket = (m) => (byModel[m] = byModel[m] ||
    { in: 0, out: 0, cache_read: 0, cache_write: 0, thinking: 0, calls: 0, total: 0 })
  // Первый проход: записи в порядке файла. Для каждого запроса запоминаем запись с
  // НАИБОЛЬШИМ output_tokens, а не первую. Рантайм пишет запрос по блокам контента, и в
  // первом блоке `output_tokens` — потоковая заглушка (2–5), итог стоит в последнем. Разбор
  // T-053 на проект-В 05.10.2026: по первым записям вывод стадии выходил 9 817, по итоговым
  // 56 635 — занижение в шесть раз, и вместе с ним занижалась «цена» стадии на дашборде.
  // Остальные поля usage (ввод, кэш) у блоков одного запроса совпадают, так что берём всё
  // из одной и той же, самой полной записи.
  const best = new Map()
  const order = []
  // Время модели и время инструментов — по метке времени соседних записей. Интервал,
  // КОНЧАЮЩИЙСЯ записью ответа модели, — время модели: очередь API, скрытое мышление,
  // повторы рантайма и сама генерация. Интервал, кончающийся результатом инструмента, —
  // работа инструмента. Вместе они дают всю длительность стадии без остатка. Это ответ на
  // вопрос, который задают, увидев долгую стадию: агент работал или ждал. Разбор T-053
  // (проект-В, 05.10.2026, 80 минут): 75 из них — время модели, шесть пауз по 4–17 минут
  // давали по 140–1000 токенов вывода, инструменты заняли 5 минут.
  let prevTs = null
  let lastRid = null
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || (o.type !== 'user' && o.type !== 'assistant')) continue
    const ts = Date.parse(o.timestamp)
    if (Number.isFinite(ts)) {
      if (prevTs != null && ts >= prevTs) {
        const d = ts - prevTs
        if (o.type === 'assistant') {
          t.wait_ms += d
          // Самая долгая пауза — только перед ПЕРВЫМ блоком ответа: паузы между блоками
          // одного запроса — это стрим, а не ожидание очереди.
          const rid = o.requestId || o.uuid
          if (rid !== lastRid && d > t.wait_max_ms) t.wait_max_ms = d
        } else {
          t.tool_ms += d
        }
      }
      prevTs = ts
    }
    if (o.type === 'assistant') lastRid = o.requestId || o.uuid
    const u = o.message && o.message.usage
    if (o.type !== 'assistant' || !u) continue
    const key = o.requestId || o.uuid
    if (!key) {
      order.push(o)
      continue
    }
    const had = best.get(key)
    if (!had) {
      best.set(key, o)
      order.push(key)
    } else if ((u.output_tokens || 0) >= (had.message.usage.output_tokens || 0)) {
      best.set(key, o)
    }
  }
  for (const k of order) {
    const o = typeof k === 'string' ? best.get(k) : k
    const u = o.message.usage
    t.in += u.input_tokens || 0
    t.out += u.output_tokens || 0
    t.cache_read += u.cache_read_input_tokens || 0
    t.cache_write += u.cache_creation_input_tokens || 0
    t.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0
    t.calls += 1
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    if (ctx > t.ctx_peak) t.ctx_peak = ctx
    // Модель у каждого вызова своя: `<synthetic>` рантайм ставит на служебные ответы
    // (их в транскрипте немало), и валить их в общую кучу с настоящей моделью значит
    // портить разбивку. Имени нет — пишем так и не гадаем.
    const m = (o.message.model || 'без модели').trim() || 'без модели'
    models.add(m)
    const b = bucket(m)
    b.in += u.input_tokens || 0
    b.out += u.output_tokens || 0
    b.cache_read += u.cache_read_input_tokens || 0
    b.cache_write += u.cache_creation_input_tokens || 0
    b.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0
    b.calls += 1
    b.total = b.in + b.out + b.cache_read + b.cache_write
  }
  if (!t.calls) return null
  t.total = t.in + t.out + t.cache_read + t.cache_write
  if (models.size) t.model = [...models].join(',')
  t.by_model = byModel
  return t
}

function currentDir(root) {
  return join(root, '.firm', 'current')
}

function readCurrent(root, agentId) {
  if (!agentId) return {}
  const p = join(currentDir(root), `${agentId}.json`)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

function branchTicket(dir) {
  try {
    const b = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return ticketFromBranch(b)
  } catch {
    return null
  }
}

function gitSha(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}


// ── Производный кэш статусов (§6: авторитетны события, frontmatter — кэш) ─────

// Сверка журнала с РЕПОЗИТОРИЕМ: что влито на самом деле.
//
// Дефект E обкатки проект-В 01.10.2026, структурный. Событие слияния пишет git-хук
// `post-merge`, и git зовёт его только тогда, когда `git merge` завершился сам. При
// КОНФЛИКТЕ merge останавливается, а завершает его `git commit` — на этот путь
// `post-merge` не вешается в принципе, ни одним хуком git. Значит слияние после
// разрешённого человеком конфликта не попадает в журнал вовсе.
//
// Вместе с дефектом A это давало худший случай: стадия пишет `merge/failed`, хук молчит,
// человек конфликт разрешает — и задача НАВСЕГДА читается `accepted`. Причём молча:
// `doctor` отвечает `ok`, открытых стадий ведь нет, дыр в журнале формально тоже.
//
// Лечится не доработкой хука, а сменой источника истины. Влита задача или нет — знает
// git, и спросить его можно в любой момент: есть ли на ветке поставки мерж-коммит, среди
// родителей которого стоит вершина ветки задачи. Есть, а события слияния нет —
// дописываем его сами, здесь, кодом (ADR-0002: событие пишет код оркестратора, а не
// пересказ роли). Нет — молчим; чем именно спрашивать git, разобрано ниже, и ошибка в
// этом вопросе стоила отдельного дефекта.
//
// Время берём НЕ текущее, а коммита слияния: журнал — это история, и «влито в 16:05»
// против «замечено в 19:30» дало бы тайминг, в котором поставка длилась на три часа
// дольше, чем было.
function gitLines(root, argv) {
  try {
    return execFileSync('git', ['-C', root, ...argv], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// Признак «влито» — мерж-коммит, среди родителей которого стоит вершина ветки задачи.
// И ТОЛЬКО он.
//
// Дефект 0.4.38, найденный в тот же день сразу на двух проектах. Сначала признаком было
// `git branch --merged <ветка поставки>`, и это неверно в самом основании: команда
// перечисляет ветки, чья вершина — ПРЕДОК вершины поставки, а стадия Prepare создаёт
// ветку задачи ровно на вершине поставки (`worktree add -B task/T-XXX <дерево>
// feature/<change>`). Своих коммитов у неё ещё нет — значит она «влита» тривиально, и так
// выглядит КАЖДАЯ только что созданная задача.
//
// Вторая половина дефекта была хуже первой: не найдя мерж-коммита, код писал событие всё
// равно — с текущим временем и оговоркой «мерж мог быть fast-forward». Оговорка
// противоречит самому движку: он требует `--no-ff`, значит у настоящего слияния
// мерж-коммит есть ВСЕГДА. Отсюда события вида «слияние завершилось за секунду до начала
// разработки» (проект-Г, T-001) и «влито в момент создания рабочего дерева»
// (проект-В, T-010 — через 104 мс после `dev/started`).
//
// Правило теперь одно, и оно следует из дисциплины `--no-ff`: мерж-коммита нет — события
// нет. Никаких «мог быть», никаких оговорок: там, где движок не может доказать слияние,
// он молчит. Ложное событие в журнале дороже отсутствующего — отсутствие видно `doctor`,
// а ложь ломает и доску, и тайминг, и список задач следующего прогона.
// Общий запас для сравнений «раньше, чем физически возможно»: см. разбор у страховки в
// `reconcileMerges`. Одно число на оба места — сверку и инварианты `doctor`, — чтобы они
// не разошлись в трактовке одного и того же вопроса.
const IMPOSSIBLE_SLACK_MS = 60000

function mergedTips(root, featureBranch) {
  const map = new Map()
  // `--first-parent` — и это не ускорение обхода, а сам признак (Д-29 проект-В 30.10.2026).
  // Без него в выборку шли ВСЕ мерж-коммиты, достижимые от вершины поставки, то есть и
  // слияния, сделанные ВНУТРИ ветки задачи: как только такая задача влита, её внутренние
  // мержи становятся достижимы и начинают доказывать что угодно. ADR-0005 словами говорит
  // «мерж-коммит НА ВЕТКЕ ПОСТАВКИ», а код реализовывал «достижимый от ветки поставки» —
  // другое утверждение, и признак не менялся с 0.4.38.
  //
  // Замер: 47 событий сверки в поставке, два ложных, и оба про задачи, которые не
  // вливались вовсе, потому что были заменены. Дороги к ошибке две, и первую проложил сам
  // движок: с 0.4.114 вершина ветки сохраняется меткой `refs/firm2/kept/T-XXX`, а
  // заменяющая задача обязана внести работу заменённой — то есть слить эту метку в свою
  // ветку, чем и создаёт «доказательство». Чем правильнее работает замена, тем надёжнее
  // врала сверка. Вторая — осадок от `-B` (Д-24): ветка, оставленная стоять на коммите
  // поставки, превращала любое слияние поставки куда угодно в доказательство своей влитости.
  //
  // Слияние в поставку лежит на первой родительской цепочке ВСЕГДА — в том числе доведённое
  // человеком руками после конфликта, ради которого сверка и существует. Слияние внутрь
  // ветки задачи не лежит на ней никогда.
  for (const line of gitLines(root, ['log', featureBranch, '--merges', '--first-parent', '--format=%H %cI %P'])) {
    const [sha, ts, ...parents] = line.split(/\s+/)
    // В UTC с `Z`, как все остальные события. `%cI` отдаёт время со смещением
    // (`+03:00`), а журнал сортируется сравнением СТРОК `ts` — смешать форматы значит
    // поехать порядком событий и получить отрицательные интервалы в тайминге.
    let iso = ts
    try {
      iso = new Date(ts).toISOString()
    } catch { /* нераспознанное время лучше, чем никакое */ }
    // ТОЛЬКО второй родитель и дальше — первый отбрасывается намеренно. Первый родитель
    // мерж-коммита — это сама ветка поставки до слияния, то есть её прежняя вершина; а
    // ветку задачи стадия Prepare создаёт ровно на вершине поставки. Значит вершина
    // свежей ветки задачи РАНО ИЛИ ПОЗДНО окажется первым родителем — у следующего же
    // слияния. Разбирая дефект 0.4.38, я сузил признак до «вершина среди родителей
    // мерж-коммита» и этот путь оставил открытым: задача, созданная сразу после
    // предыдущего мержа и ещё не сделавшая ни одного коммита, получала ложное
    // `merge/finished`, как только в поставку вливали СОСЕДНЮЮ задачу. Второй родитель —
    // это именно «что влили», и спрашивать надо только его.
    for (const psha of parents.slice(1)) if (!map.has(psha)) map.set(psha, { sha, ts: iso })
  }
  return map
}

export function reconcileMerges(root, change) {
  if (!change) return []
  const featureBranch = `feature/${change}`
  if (!gitLines(root, ['rev-parse', '--verify', featureBranch]).length) return []
  const byParent = mergedTips(root, featureBranch)
  if (!byParent.size) return []

  // Исправленные события читаем ТОЖЕ, и это принципиально. Сверка молчит, пока последнее
  // событие слияния — `finished`; аннулирование убирает его из расчёта, признак исчезает, и
  // сверка пишет событие заново — по тому же мерж-коммиту, с тем же временем. То есть
  // решение человека «это событие неверно» отменялось следующим же `sync`.
  //
  // Поэтому помним аннулированные слияния отдельно: если по этому мерж-коммиту событие уже
  // писали и его сняли, второй раз не пишем. Человек видит в git больше, чем движок
  // (например, что мерж-коммит относится к другой поставке), и его «нет» сильнее нашего
  // доказательства. Найдено ревью по инвариантам 01.10.2026.
  const events = listEvents(root, { change, includeCorrected: true })
  const mergedTickets = new Set()
  const firstDevStart = new Map()
  const retractedMergeTs = new Set()
  const terminalTs = new Map()
  for (const e of events) {
    if (e._broken || !e.ticket) continue
    if (e.stage === 'merge' && e.event === 'finished' && e._corrected && e.ts) {
      retractedMergeTs.add(`${e.ticket}@${e.ts}`)
    }
    if (e._corrected) continue
    // Признак «уже записано» — НАЛИЧИЕ непогашенного `merge/finished`, а не «последнее
    // событие стадии merge». Разница стоила трёх дублей на живых проектах, и ошибку внёс
    // сам исход `retracted`: аннулирование принадлежит стадии `merge`, значит оно
    // становилось последним её событием, признак «finished» исчезал — и сверка писала
    // слияние заново, рядом с уже существующим настоящим. Задачу нельзя влить дважды,
    // поэтому спрашивать надо именно так.
    if (e.stage === 'merge' && e.event === 'finished') mergedTickets.add(e.ticket)
    // Задача заменена или отменена решением человека. Сверка дописывает ПРОПУЩЕННОЕ, а у
    // такой задачи слияние не пропущено — его не было и не будет (Д-29). Страховка вторая и
    // НЕЗАВИСИМАЯ от `--first-parent`: она закрыла бы оба ложных события и сама по себе, а
    // две независимые нужны потому, что цена ошибки здесь — стёртое решение человека.
    // Запоминается ВРЕМЯ решения: доказательство, пришедшее после него, молчит, а пришедшее
    // раньше — законное событие прошлого (задачу могли влить, а потом заменить её предмет).
    if (e.stage === 'lifecycle' && ['superseded', 'cancelled'].includes(e.event) && e.ts) {
      if (!terminalTs.has(e.ticket) || e.ts < terminalTs.get(e.ticket)) terminalTs.set(e.ticket, e.ts)
    }
    if (e.stage === 'dev' && e.event === 'started' && !firstDevStart.has(e.ticket)) {
      firstDevStart.set(e.ticket, e.ts)
    }
  }

  const written = []
  for (const t of listTasks(root, change)) {
    if (mergedTickets.has(t.id)) continue
    const tip = gitLines(root, ['rev-parse', `task/${t.id}`])[0]
    if (!tip) continue
    const mc = byParent.get(tip)
    if (!mc) continue
    // Страховка от целого класса ошибок: слияние не может завершиться раньше, чем
    // началась разработка. Если вычисленное время оказалось раньше первого `dev/started`,
    // значит сверка опознала не тот коммит — и тогда она молчит, а не пишет невозможное.
    //
    // Запас в минуту — не вольность, а разница точности. `%cI` отдаёт время с точностью до
    // секунды, события журнала — до миллисекунды; слияние, попавшее в ту же секунду, что
    // и событие, оказывается «раньше» на доли секунды и невиновно отбрасывалось. Поймано
    // этим же рубежом на синтетическом прогоне, где весь цикл задачи укладывается в
    // секунду. Страховка нацелена на грубую невозможность — часы, а не округление.
    const dev = firstDevStart.get(t.id)
    if (dev && Date.parse(mc.ts) < Date.parse(dev) - IMPOSSIBLE_SLACK_MS) continue
    // И симметрично к страховке выше: доказательство, пришедшее ПОСЛЕ решения о замене или
    // отмене, — это чужое слияние. На проект-В такое событие записалось через семь минут
    // после `lifecycle/superseded` и перебило его: заменённая задача читалась как влитая, и
    // в головное число доски «46 влито» попала задача, которой там нет места (Д-29).
    const term = terminalTs.get(t.id)
    if (term && Date.parse(mc.ts) >= Date.parse(term) - IMPOSSIBLE_SLACK_MS) continue
    if (retractedMergeTs.has(`${t.id}@${mc.ts}`)) continue
    const ev = {
      ts: mc.ts,
      change,
      ticket: t.id,
      stage: 'merge',
      event: 'finished',
      actor: 'reconcile',
      attempt: 1,
      git_sha: String(mc.sha).slice(0, 7),
      source: 'reconcile',
      notes:
        `ветка task/${t.id} влита в ${featureBranch} коммитом ${String(mc.sha).slice(0, 7)}, ` +
        'а события слияния в журнале не было — дописано сверкой с репозиторием ' +
        '(post-merge не вешается на мерж, завершённый git commit после конфликта)',
    }
    written.push({ ticket: t.id, path: writeEvent(root, ev), ts: ev.ts })
  }
  return written
}

// Статусы, после которых стадий у задачи не будет: влито и выпущено (слияние состоялось),
// снято и отменено (решение человека, задача в план не вернётся). Для них кэш правится
// сразу — см. довод в `syncStatuses`.
const TERMINAL_CACHE_STATUS = ['merged', 'released', 'superseded', 'cancelled']

export function syncStatuses(root, change) {
  // Сверка ПЕРЕД расчётом доски: дописанное событие должно попасть в тот же расчёт,
  // иначе кэш статусов догонит журнал только со второго вызова sync.
  const reconciled = reconcileMerges(root, change)
  const board = computeBoard(root, change, { parallelism: parallelismOf(root) })
  const fixed = []
  // Чего записать НЕ удалось: отказ ФС называется, а не прячется под «нечего чинить».
  const blocked = []
  const ticked = []
  const unmatched = []
  const deferred = []
  // Файл задачи, которая ещё не влита, правит её же стадия в своём worktree. Писать в
  // него из главного дерева — гарантированный отказ слияния «Your local changes would be
  // overwritten» (см. inFlightTickets). Откладываем до мержа: `post-merge` зовёт sync
  // сразу после него, и кэш догонит журнал тогда же.
  const inFlight = inFlightTickets(root)
  // Архивный снимок не трогаем НИКОГДА (Д-14 разбора 24.09.2026). `tasksDir` намеренно
  // ищет задачи в архиве, когда живого каталога уже нет — иначе выпуск не нашёл бы их
  // после архивации. Но найти и переписать — разные вещи: архив иммутабелен (замысел §11),
  // а статус по ADR-0001 принадлежит журналу, и кэш в снимке никому не нужен. На пилоте
  // `release` после мержа переписал `merged → released` в 27 файлах внутри снимка, и
  // правки пришлось откатывать вручную.
  const archived = []
  for (const t of board.tasks) {
    if (t.path.includes(`${sep}archive${sep}`)) {
      if (t.cache_stale) archived.push(`${t.id}: ${t.cached_status} (снимок, не трогаем)`)
      continue
    }
    // Терминальный статус патчится, НЕ ГЛЯДЯ на рабочее дерево (Д-33).
    //
    // Отсрочка ниже обещает «до слияния», и для влитой задачи это обещание выполнимо: её
    // дерево убирают последним шагом слияния. А у задачи, СНЯТОЙ решением человека
    // (`superseded`, `cancelled`), слияния не будет НИКОГДА — значит отсрочка вечная, и
    // кэш расходится навсегда. Замер проект-В 31.10.2026: 17 отложенных патчей, из них семь
    // по снятым задачам; `T-212` стояла `ready` при записанном `lifecycle/superseded`.
    //
    // Предикат отсрочки спрашивал «есть ли каталог», а защищать надо от другого — от
    // правки файла под РАБОТАЮЩЕЙ стадией, из-за которой падает слияние («Your local
    // changes would be overwritten»). У терминальной задачи работающей стадии нет по
    // определению: влитая уже слита, снятая не пойдёт в работу. Поэтому для них правка
    // безопасна, а молчание — нет.
    const terminal = TERMINAL_CACHE_STATUS.includes(t.status)
    // `null` — git не ответил, и тогда откладываем ВСЁ: неизвестно, кто в полёте, а правка
    // файла задачи под работающей стадией стоит отказа слияния (И-12, ADR-0007).
    if (!terminal && (!inFlight || inFlight.has(t.id))) {
      if (t.cache_stale) {
        // Формулировка важна ровно настолько, насколько важен тот, кто её прочтёт.
        // Прежняя — «T-058: ready → merged (после слияния)» — читалась как «уже
        // применено»: стрелка выглядит как сделанное действие. На этом споткнулся
        // Архитектор 05.10.2026: прочитал у влитой T-058 `status: ready` в файле и неверно
        // определил объём задачи. Теперь сказано, что В ФАЙЛЕ СЕЙЧАС старое значение.
        deferred.push(
          inFlight
            ? `${t.id}: в файле СТАРОЕ значение «${t.cached_status}», в журнале «${t.status}» — ` +
              'патч ОТЛОЖЕН до слияния (дерево задачи живо). Истина в журнале'
            : `${t.id}: в файле СТАРОЕ значение «${t.cached_status}», в журнале «${t.status}» — ` +
              'git не ответил про рабочие деревья, отложено всё. Истина в журнале',
        )
      }
      continue
    }
    if (t.cache_stale) {
      // Отказ ФС здесь НЕ срывает сверку целиком. Песочница закрывает каталоги на запись
      // (замер 01.11.2026: `EPERM` на файле задачи в соседнем проекте), и до 0.4.117 такой
      // отказ вылетал исключением из `sync` — то есть один закрытый файл отменял и запись
      // событий, и пересчёт доски, и галочки по критериям у всех остальных задач.
      try {
        patchFrontmatter(t.path, 'status', t.status)
        fixed.push(`${t.id}: ${t.cached_status} → ${t.status}`)
      } catch (e) {
        blocked.push(`${t.id}: ${t.cached_status} → ${t.status} — записать не удалось (${
          (e && e.code) || (e && e.message) || 'без кода'
        }). Истина в журнале; правка кэша остаётся несделанной`)
      }
    }
    // Галочки приёмки. Источник — разбор ревьюера по критериям, сохранённый в событии,
    // а не догадка по статусу задачи: «принято» означает вердикт целиком, а квадратик
    // напротив критерия должен означать, что проверяли именно его.
    const met = new Set()
    for (const e of t.events || []) {
      // Строго равенство: «не выполнено» содержит «выполнено» как подстроку, и проверка
      // на вхождение поставила бы галочку ровно там, где её ставить нельзя.
      for (const c of e.criteria || []) if (norm(c.s) === 'выполнено') met.add(norm(c.c))
    }
    if (met.size) {
      let marked
      try {
        marked = tickCriteria(t.path, met)
      } catch (e) {
        blocked.push(`${t.id}: галочки по критериям не поставлены — ${(e && e.code) || 'отказ ФС'}`)
        marked = { n: 0, left: [] }
      }
      const { n, left } = marked
      if (n) ticked.push(`${t.id}: +${n}`)
      // Критерий, который ревьюер признал выполненным, а в файле задачи такой строки нет —
      // это расхождение формулировок, и молчать о нём нельзя: галочка не встанет, а причина
      // будет невидима. Сообщаем, но ничего не додумываем: похожесть не повод ставить отметку.
      if (left.length) unmatched.push(`${t.id}: ${left.length} критериев без строки в задаче`)
    }
  }
  const bugs = syncBugs(root, board)
  return { change, reconciled, fixed, blocked, deferred, archived, ticked, unmatched, bugs, tasks: board.tasks.length }
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[«»"'`]/g, '').trim()

// Галочку ставит только точное совпадение формулировки критерия. Похожесть здесь
// опаснее пропуска: закрытый по ошибке критерий никто уже не перечитает.
function tickCriteria(path, met) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { n: 0, left: [...met] }
  }
  const seen = new Set()
  let n = 0
  const out = text.split('\n').map((line) => {
    const m = line.match(/^(\s*)- \[([ x])\] (.+)$/)
    if (!m) return line
    const key = norm(m[3])
    if (!met.has(key)) return line
    seen.add(key)
    if (m[2] === 'x') return line
    n++
    return `${m[1]}- [x] ${m[3]}`
  })
  if (n) writeFileSync(path, out.join('\n'))
  return { n, left: [...met].filter((k) => !seen.has(k)) }
}

// Баг закрывает не роль, а факт: задача-исправление влита. Пока её нет или она не
// влита, баг остаётся открытым, сколько бы ролей ни считали иначе.
function syncBugs(root, board) {
  const byId = new Map(board.tasks.map((t) => [t.id, t]))
  const done = (id) => {
    const t = byId.get(id)
    return !!t && (t.status === 'merged' || t.status === 'released')
  }
  const closed = []
  for (const b of listBugs(root)) {
    if (b.change && board.change && b.change !== board.change) continue
    if (!b.open) continue // open|fixing — живые; остальные уже решены
    // Связь баг→исправление либо проставлена Архитектором, либо выводится по соглашению
    // об именовании T-XXXf. Второе — не догадка: имя задаётся движком в §8.
    let fix = b.fix_task
    if (!fix) fix = b.tickets.map((t) => `${t}f`).find((id) => byId.has(id)) || null
    if (!fix || !done(fix)) continue
    const path = join(root, b.rel)
    if (b.fix_task !== fix) patchFrontmatter(path, 'fix_task', fix)
    // Словарь состояний берём из шаблона бага: resolved, а не выдуманное fixed.
    patchFrontmatter(path, 'status', 'resolved')
    closed.push(`${b.id}: ${b.status} → resolved (${fix})`)
  }
  return closed
}

function parallelismOf(root) {
  const cfg = readConfig(root) || {}
  const p = Number(cfg.parallelism)
  return Number.isFinite(p) && p > 0 ? p : 3
}

function refresh(root, change) {
  const res = syncStatuses(root, change)
  let dash = null
  try {
    dash = buildDashboard(root, change)
  } catch (e) {
    process.stderr.write(`[firm-event] дашборд не пересобран: ${e.message}\n`)
  }
  return { ...res, dashboard: dash }
}

// ── Команды ───────────────────────────────────────────────────────────────────

function cmdRecord(root, args) {
  // Поставка подставляется активная — кроме событий ТЕМЫ. Разведка поставки не
  // материализует (ADR-0012), и приписать её стадию к той поставке, которая случайно
  // открыта сейчас, значит записать неправду в поле, по которому потом считают её цену.
  // Тема живёт в бэклоге и кончается досье; поставка у неё появится позже и другая.
  const groomTicket = /^G-/.test(String(args.ticket || ''))
  const change = args.change || (groomTicket ? null : activeChange(root))
  const ev = {
    change,
    epic: args.epic || null,
    ticket: args.ticket || 'unknown',
    stage: args.stage,
    event: args.event,
    actor: args.actor || null,
    attempt: args.attempt ? Number(args.attempt) : 1,
    run_id: args.run_id || null,
    git_sha: args.git_sha || gitSha(root),
  }
  if (args.notes) ev.notes = fitNotes(ev, args.notes)
  // Время события можно задать явно, и это не прихоть. Событие о ПРОШЛОМ — брошенная ночью
  // стадия, слияние, доведённое руками, ворота, закрытые вчера, — обязано нести время того,
  // что произошло, а не время записи (И-5). Без `--ts` человек мог только записать
  // сегодняшнее время на вчерашний факт, и тайминг получал часы ожидания, которых не было.
  if (args.ts) {
    const t = Date.parse(String(args.ts))
    if (!Number.isFinite(t)) {
      process.stderr.write(`[firm-event] --ts "${args.ts}" не разбирается как время (нужен ISO: 2026-10-01T19:30:00Z)\n`)
      process.exit(1)
    }
    ev.ts = new Date(t).toISOString()
  }
  if (!ev.stage || !ev.event) {
    process.stderr.write('[firm-event] нужны --stage и --event\n')
    process.exit(1)
  }
  // Тикет обязателен. Прежде `record` молча писал `ticket: unknown` и выходил нулём — то
  // есть создавал ту самую дыру, которую `doctor` потом ищет как поломку (И-7). Путь `hook`
  // на том же месте выходит с кодом 2 и объясняет, чего не хватило; у `record` этого не
  // было, хотя он обслуживает именно границы, куда хуки не достают: ворота, ручной мерж,
  // отмену. Канал «сказать» должен срабатывать в момент записи, а не через полдня в
  // `doctor` (ADR-0007). Найдено ревью по инвариантам 01.10.2026.
  if (!args.ticket) {
    process.stderr.write(
      '[firm-event] нужен --ticket: событие без тикета не попадает ни на доску, ни в тайминг.\n' +
        '             Стадия уровня поставки (ревью всего диффа) — это --ticket MR.\n',
    )
    process.exit(1)
  }
  // Имя стадии — из словаря, и проверяется это здесь, в момент записи. `record` принимал
  // любое имя, и 12.10.2026 в журнал проект-В уехало событие стадии `gate`, которой в
  // словаре нет: на дашборде его не видно (он читает STAGE_CYCLE), а журнал неизменяем —
  // событие останется таким навсегда. Словарь, который не проверяется на записи, отстаёт
  // от жизни молча, и это уже случалось: до 01.10.2026 в нём не было ни `adjudicate`, ни
  // `design`, ни `docs`.
  //
  // Отказ, а не предупреждение: опечатка в имени стадии неотличима от новой стадии, а
  // спросить дешевле, чем разбирать потом (ADR-0007). Новая стадия — правка словаря.
  if (!STAGES.includes(ev.stage)) {
    process.stderr.write(
      `[firm-event] стадии «${ev.stage}» нет в словаре движка.\n` +
        `             Известны: ${STAGES.join(', ')}.\n` +
        '             Это опечатка — исправь; это новая стадия — добавь её в STAGES\n' +
        '             (scripts/lib/firm.mjs) тем же коммитом, иначе её не покажет дашборд.\n',
    )
    process.exit(1)
  }
  // Отчёт о падении слияния, пришедший ПОСЛЕ состоявшегося слияния, помечается в момент
  // записи (Д-67, отчёт проект-В 09.11.2026). Трижды за вечер шаг слияния дописывал своё
  // «не влито» уже после того, как Оркестратор довёл мерж руками, — и каждый раз это
  // чинилось исправляющим событием, хотя исправлять нечего: падение попытки было, слияние
  // состоялось, оба события правдивы.
  //
  // Событие пишется как есть — выбрасывать правдивый отчёт движок не станет, — но несёт
  // признак, и запись говорит вслух. Читатели (статус, doctor) держатся ADR-0005: влито
  // доказано вторым родителем мерж-коммита, а не последним словом журнала.
  if (ev.stage === 'merge' && ev.event === 'failed' && isBoundTicket(ev.ticket)) {
    const mergedEv = listEvents(root, { includeCorrected: false })
      .find((e) => e.ticket === ev.ticket && e.stage === 'merge' && e.event === 'finished' && !e._broken)
    if (mergedEv) {
      ev.stale_attempt = true
      ev.notes = fitNotes(ev, `${ev.notes ? ev.notes + ' | ' : ''}ПОПЫТКА УСТАРЕЛА: слияние ` +
        `состоялось ${mergedEv.ts} (событие merge/finished). Отчёт о падении попытки влитое не отменяет (ADR-0005).`)
      process.stderr.write(
        `[firm-event] ${ev.ticket}: слияние УЖЕ состоялось (${mergedEv.ts}), а записывается отчёт о ` +
          'падении попытки. Событие записано с признаком stale_attempt: оно правдиво, но итог задачи\n' +
          '             не меняет — исправляющего события не нужно (Д-67).\n',
      )
    }
  }
  // Исправление ошибочного события. Журнал не правится и не чистится (ADR-0003), поэтому
  // исправление — новое событие, называющее файл неверного; при чтении тот исключается
  // из расчёта, но в журнале остаётся, и doctor показывает обе записи.
  //
  // Две проверки, и обе существенные. Файл должен существовать — иначе опечатка в имени
  // даёт событие, которое НИЧЕГО не исправляет, а выглядит как исправление. И причина
  // обязательна: запись «это событие неверно» без объяснения читателю через полгода
  // бесполезна, а спорить с журналом она уже позволяет.
  if (args.corrects) {
    // Файлов может быть несколько: читатель уже умеет список (`toArray(e.corrects)`), а
    // жизнь даёт его пачками. Повод замерен 25.10.2026: одна стадия разведки проект-В
    // оставила 31 событие с `ticket: unknown` — все одного захода, все по одной причине.
    // Тридцать одно исправляющее событие на один факт — это не журнал, а эхо.
    const targets = String(args.corrects).split(',').map((x) => x.trim()).filter(Boolean)
    const absent = targets.filter((t) => !existsSync(join(eventsDir(root), t)))
    if (!targets.length || absent.length) {
      process.stderr.write(
        `[firm-event] ${absent.join(', ') || '—'} — нет в журнале, исправлять нечего.\n` +
          'Имена берутся как есть, из .firm/events (ls .firm/events | grep <тикет>).\n',
      )
      process.exit(1)
    }
    if (!ev.notes) {
      process.stderr.write('[firm-event] --corrects требует --notes: почему прежнее событие неверно\n')
      process.exit(1)
    }
    ev.corrects = targets.length === 1 ? targets[0] : targets
    ev.source = ev.source || 'correction'
    // Исправление привязки НЕ должно стирать замер. Исправляемое событие несёт счёт
    // токенов, агента и сессию — то, чего у `record` взяться неоткуда (транскрипта он не
    // читает), и без переноса починка тикета покупалась бы потерей расхода: было
    // «неизвестно чьё, но посчитанное», стало бы «чьё известно, но нулевое». И-12
    // говорит обратное: «не знаю» не равно «нет».
    //
    // Счёт берётся МАКСИМУМОМ, а не суммой: у одного захода финишей бывает несколько, и
    // каждый несёт полный счёт заново (см. duplicateFinishes).
    const olds = targets
      .map((t) => { try { return JSON.parse(readFileSync(join(eventsDir(root), t), 'utf8')) } catch { return null } })
      .filter(Boolean)
    if (!ev.tokens) {
      const best = olds.reduce((a, o) => (o.tokens && (!a || (o.tokens.total || 0) > (a.total || 0)) ? o.tokens : a), null)
      if (best) ev.tokens = best
    }
    for (const k of ['agent_id', 'session_id', 'model']) {
      if (!ev[k]) { const got = olds.find((o) => o[k]); if (got) ev[k] = got[k] }
    }
  }
  // Отпечаток содержимого (ADR-0013). Стемпливаем на ЛЮБОМ событии с привязанным тикетом,
  // у которого есть ветка: это один вызов `git`, а журнал от него становится сверяемым —
  // видно не только «что произошло с задачей», но и «над каким содержимым». Для `record`
  // это существенно ещё и потому, что короткая полоса принимает задачу именно отсюда
  // (`guard/short-lane`), а она идёт в слияние без стадии ревью вовсе.
  if (!ev.tree) {
    const tr = taskTree(root, ev.ticket)
    if (tr) ev.tree = tr
  }
  const path = writeEvent(root, ev)
  const res = change ? refresh(root, change) : null
  print(args, { ok: true, event: ev, path, sync: res })
}

// abandon — закрыть стадию, которая не кончится.
//
// Зачем отдельная команда, а не `record --event finished`. Прогон, снятый `TaskStop`-ом
// или упавший вместе с сессией, оставляет в журнале `started` без пары. Интервал открыт
// навсегда: доска держит задачу в работе и считает слот занятым, а тайминг по ней не
// определён. Сочинить финиш нельзя — тайминг получит интервал работы, которой не было,
// и это хуже пробела: пробел видно, а ложь нет. Поэтому своё событие: `abandoned` в
// журнале отличается и от успеха, и от провала.
//
// Писать его может человек (или роль по его просьбе) — это единственное место, где
// иначе нельзя: оборванную стадию по определению не наблюдал никакой код. ADR-0002 это и
// предусматривает третьим механизмом — `record` с границ, куда хуки не достают.
//
// Защита от выдумывания одна, но существенная: закрыть можно ТОЛЬКО стадию, которая в
// журнале действительно открыта. Нет открытой — отказ с перечислением того, что открыто.
function openStagesOf(root, change, ticket) {
  const events = listEvents(root, { change })
  const open = []
  const byTicket = new Map()
  for (const e of events) {
    if (e._broken || !e.ticket || e.ticket === 'unknown') continue
    if (ticket && e.ticket !== ticket) continue
    if (!byTicket.has(e.ticket)) byTicket.set(e.ticket, [])
    byTicket.get(e.ticket).push(e)
  }
  for (const [tk, evs] of byTicket) {
    let stage = null
    let ts = null
    let attempt = 1
    for (const e of evs) {
      if (e.event === 'started') {
        stage = e.stage
        ts = e.ts
        attempt = Number(e.attempt) || 1
      } else if (stage === e.stage) {
        stage = null
        ts = null
      }
    }
    if (stage) open.push({ ticket: tk, stage, ts, attempt })
  }
  return open
}

function cmdAbandon(root, args) {
  const change = args.change || activeChange(root)
  const ticket = args.ticket
  if (!ticket) {
    print(args, { ok: false, reason: 'нужен --ticket' })
    process.exit(1)
  }
  const open = openStagesOf(root, change, ticket)
  const hit = args.stage ? open.find((o) => o.stage === args.stage) : open[0]
  if (!hit) {
    print(args, {
      ok: false,
      reason: args.stage
        ? `у ${ticket} нет открытой стадии ${args.stage} — закрывать нечего`
        : `у ${ticket} нет открытых стадий — закрывать нечего`,
      open_stages: openStagesOf(root, change, null),
      note: 'событие о стадии, которой не было, испортило бы журнал сильнее, чем открытый интервал',
    })
    process.exit(1)
  }
  const ev = {
    change,
    ticket,
    stage: hit.stage,
    event: 'abandoned',
    actor: args.actor || 'human',
    attempt: hit.attempt,
    git_sha: gitSha(root),
    source: 'command',
  }
  ev.notes = args.notes ? fitNotes(ev, args.notes) : 'прогон снят, финиша не будет'
  // Время по умолчанию — время записи, и это ЧЕСТНО, а не точно: когда именно оборвалась
  // стадия, движок не знает (§2 модели), и выдумывать не вправе. Но человек, снявший
  // прогон, обычно знает — для него `--ts`. Разница существенна: событие о стадии,
  // оборвавшейся ночью, с утренним временем даёт тайминг с многочасовой «работой» (И-5).
  if (args.ts) {
    const t = Date.parse(String(args.ts))
    if (!Number.isFinite(t)) {
      process.stderr.write(`[firm-event] --ts "${args.ts}" не разбирается как время\n`)
      process.exit(1)
    }
    if (t < Date.parse(hit.ts)) {
      process.stderr.write(
        `[firm-event] --ts ${args.ts} раньше начала стадии ${hit.ts} — стадия не могла оборваться до старта\n`,
      )
      process.exit(1)
    }
    ev.ts = new Date(t).toISOString()
  }
  const path = writeEvent(root, ev)
  const res = change ? refresh(root, change) : null
  print(args, {
    ok: true,
    event: ev,
    started_at: hit.ts,
    path,
    sync: res,
    note: 'задача вернулась в «не начата»; слот освободился. Число попыток не обнулено — ' +
      'оно считается по dev/started, и предел трёх заходов цел.',
  })
}

function cmdClaim(root, args) {
  const dir = ensureDir(currentDir(root))
  const agentId = args.agent_id || process.env.CLAUDE_AGENT_ID || null
  // Без идентификатора агента заявка бессмысленна: хук ищет файл по `agent_id` из своей
  // полезной нагрузки, и `unknown.json` не совпадёт ни с чем. Писать такой файл хуже,
  // чем не писать: он выглядит как работающая привязка. Отказ НЕ фатальный — стадия
  // из-за него встать не должна; движок просто остаётся на сегодняшнем поведении, когда
  // тикет привязывается на финише.
  if (!agentId) {
    print(args, {
      ok: false,
      reason: 'нет идентификатора агента: ни --agent-id, ни CLAUDE_AGENT_ID в окружении',
      effect: 'привязка стадии останется отложенной — тикет станет известен на финише',
    })
    return
  }
  const payload = {
    ticket: args.ticket || null,
    stage: args.stage || null,
    change: args.change || activeChange(root),
    attempt: args.attempt ? Number(args.attempt) : 1,
    ts: new Date().toISOString(),
  }
  writeFileSync(join(dir, `${agentId}.json`), JSON.stringify(payload, null, 1) + '\n')
  print(args, { ok: true, claimed: payload, agent_id: agentId })
}

// Хук: читает payload рантайма со stdin. Никаких решений модели здесь нет.
// Ловушка на засорение главного дерева.
//
// Рабочий каталог субагента — корень проекта, а не worktree задачи, поэтому файл,
// записанный по относительному пути, уходит мимо дерева задачи и остаётся в корне
// неотслеживаемым. Ветка потом не может лечь поверх: git не затирает неотслеживаемое,
// и слияние падает на «untracked working tree files would be overwritten by merge».
//
// Признак берём без догадок: файл неотслеживаем в корне И существует в дереве задачи по
// тому же относительному пути. Совпадение обоих условий означает, что стадия записала
// его дважды — туда и не туда.
function strayFiles(root, ticket, cfg) {
  if (!ticket || ticket === 'unknown') return []
  const wt = join(worktreesDir(root, cfg), ticket)
  if (!existsSync(wt)) return []
  let out = ''
  try {
    out = execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }
  return out
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((f) => f && existsSync(join(wt, f)))
}

// Незакоммиченная работа в дереве задачи. Разбор 04.10.2026 по 30 отклонённым заходам
// четырёх пилотов: примерно седьмая часть отклонений — не про продукт, а про `git add`.
// Ревьюер пишет «функционально сильно», и отклоняет, потому что тестовый файл остался
// untracked и при слиянии исчезнет: в поставку уезжает КОММИТ, а не рабочее дерево.
// Стоило это каждый раз полного второго захода dev → test → review (медиана 59 минут
// против 24 у задачи, принятой с первого раза), хотя чинится одной командой.
//
// Проверяем на финише стадий, которые артефакт ПРОИЗВОДЯТ (dev и test), и не трогаем
// ревью: Ревьюер читает, а его временные пробники — его дело, про них ему сказано
// отдельно. Отвечает за ответ то же дерево, которому задан вопрос: `git -C wt`, а не
// `-C root` (урок post-merge, 02.10.2026). Переменные окружения git снимать не нужно —
// хук стадии запускает рантайм, а не git, и `GIT_DIR` в нём не выставлен.
//
// `core.quotepath=false` обязателен: по умолчанию git отдаёт не-ASCII имена в октальных
// escape-последовательностях (`"\320\272..."`), и тогда движок печатает роли имя, которого
// в дереве нет, а собранная из него команда `git add` не находит файл. Тот же разряд
// ошибки, что Д-6 в 0.4.71: кириллица, обрезанная образцом, уехала не туда молча.
//
// `.firm/` из ответа убираем: журнал и доску ведёт движок в ГЛАВНОМ дереве, и их следы
// в дереве задачи — не работа роли. Задача с собственным `worktree` в конфиге сюда не
// попадёт (каталога по имени тикета нет) — ровно так же ведёт себя соседняя strayFiles.
function uncommittedInTaskWorktree(root, ticket, cfg) {
  if (!ticket || ticket === 'unknown') return []
  const wt = join(worktreesDir(root, cfg), ticket)
  if (!existsSync(wt)) return []
  let out = ''
  try {
    out = execFileSync('git', ['-C', wt, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 3)
    .map((l) => ({ mark: l.slice(0, 2).trim() || '??', file: l.slice(3).trim().replace(/^"|"$/g, '') }))
    .filter((e) => e.file && !e.file.startsWith('.firm/'))
    .map((e) => ({ ...e, junk: isRunArtifact(e.file), bytes: e.mark === '??' ? sizeOf(join(wt, e.file)) : 0 }))
}

// Артефакты прогона: каталоги, которые создаёт САМА проверка и которым место в `$TMPDIR`,
// а не в репозитории. Образцы нарочно узкие и перечислены поимённо — широкий образец
// однажды проглотит результат роли, а это дороже, чем пропущенный мусор.
//
// Разбор проект-В 11.10.2026 (Д-5): браузерная проверка задачи T-079 оставила в дереве
// профиль Chrome — 296 файлов, 4,1 МБ, — и он уехал в коммит стадии СОСЕДНЕЙ задачи
// T-086, где настоящих правок было четыре файла. Отфильтрованное здесь не исчезает:
// оно называется отдельным разделом сообщения, потому что «молча убрал из списка»
// однажды скроет от роли её же результат.
const RUN_ARTIFACT = [
  /(^|\/)\.?browser[-_a-z0-9]*check[-_a-z0-9]*(\/|$)/i, // .browser-check-t079-qa/
  /(^|\/)profile-[A-Za-z0-9]{4,}(\/|$)/,                 // временный профиль Chrome
  /(^|\/)(playwright-report|test-results)(\/|$)/,
  /(^|\/)(screenshot|screenshots|snapshot|snapshots)(\/|$)/,
  /(^|\/)(node_modules|__pycache__|\.pytest_cache|\.ruff_cache|\.vite|\.cache|\.venv)(\/|$)/,
  /(^|\/)\.DS_Store$/,
]

function isRunArtifact(file) {
  return RUN_ARTIFACT.some((re) => re.test(file))
}

function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// Сколько файлов и байт untracked считать «это не работа, а свалка». Порог нужен для
// случая, когда образцы выше не узнали мусор: тридцать неизвестных файлов на стадии,
// которая правила четыре, — признак того, что роль собирается закоммитить не работу.
// Тогда готовой команды НЕ даём вовсе: предписание здесь и было механизмом дефекта.
const BULK_FILES = 20
const BULK_BYTES = 1048576

// Короткое имя места, где скопились файлы: по первым двум сегментам пути. Нужно, чтобы
// вместо 296 строк показать одну — «web/.browser-check-t079-qa/ — 296 файлов, 4.1 МБ».
function groupByDir(entries) {
  const by = new Map()
  for (const e of entries) {
    const parts = e.file.split('/')
    const key = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') + '/' : '.'
    const cur = by.get(key) || { files: 0, bytes: 0 }
    by.set(key, { files: cur.files + 1, bytes: cur.bytes + (e.bytes || 0) })
  }
  return [...by.entries()].sort((a, b) => b[1].bytes - a[1].bytes || b[1].files - a[1].files)
}

const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`)

// Путь в команде: кавычки там, где без них команда развалится.
const shq = (f) => (/^[A-Za-z0-9._/-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`)

// Сообщение о незакоммиченной работе. Собирается здесь, а не в хуке, по одной причине:
// порядок частей в нём — несущий. До 0.4.74 сообщение начиналось с готовой команды
// `git add -A`, а оговорка «если что-то из списка не должно попасть в поставку» шла
// ПОСЛЕ неё — и роль выполняла команду дословно, не дочитав. Теперь сначала разбор
// списка, потом команда, и в команде перечислены имена, а не `-A`.
function notCommittedText(root, ticket, cfg, dirty) {
  const wt = join(worktreesDir(root, cfg), ticket)
  const junk = dirty.filter((e) => e.junk)
  const work = dirty.filter((e) => !e.junk)
  const untracked = work.filter((e) => e.mark === '??')
  const bytes = untracked.reduce((n, e) => n + (e.bytes || 0), 0)
  const head = `[firm2] Стадия задачи ${ticket} закончена, но работа НЕ закоммичена:\n`
  const junkBlock = junk.length
    ? `Похоже на артефакты прогона — в коммит они не идут:\n` +
      groupByDir(junk).map(([d, v]) => `  ${d} — ${v.files} файл(ов), ${mb(v.bytes)}\n`).join('') +
      `Их место в $TMPDIR, а не в репозитории: один такой каталог уже уехал в поставку\n` +
      `чужой задачи (296 файлов, 4,1 МБ). Убери их или допиши в .gitignore. Если что-то\n` +
      `из них на самом деле ТВОЙ результат — добавь его в команду ниже руками.\n`
    : ''
  const why =
    `В поставку уезжает коммит ветки task/${ticket}, а не рабочее дерево: всё, что\n` +
    `перечислено выше, при слиянии исчезнет — вместе с тестами, если они здесь.\n`

  // Свалка: имён не перечисляем и команды не даём. Роль обязана сначала понять, что это.
  if (untracked.length > BULK_FILES || bytes > BULK_BYTES) {
    return (
      head +
      work.filter((e) => e.mark !== '??').map((e) => `  ${e.mark} ${e.file}\n`).join('') +
      `Плюс ${untracked.length} неотслеживаемых файлов (${mb(bytes)}), и это слишком много\n` +
      `для результата одной стадии:\n` +
      groupByDir(untracked).slice(0, 8).map(([d, v]) => `  ${d} — ${v.files} файл(ов), ${mb(v.bytes)}\n`).join('') +
      junkBlock +
      why +
      `Готовой команды тут не будет НАМЕРЕННО: \`git add -A\` на таком списке закоммитит\n` +
      `не работу. Разберись, что это, убери лишнее (артефакты прогона — в $TMPDIR или в\n` +
      `.gitignore) и добавь СВОИ файлы поимённо:\n` +
      `  git -C ${wt} add -- <файл> <файл> …\n` +
      `  git -C ${wt} commit -m "<что сделано>"\n`
    )
  }

  const list = work.map((e) => `  ${e.mark} ${e.file}\n`).join('')
  const names = work.map((e) => shq(e.file)).join(' ')
  // Работы нет вовсе — только мусор. Стадию за это не останавливаем (коммит роли на
  // месте), но говорим вслух: иначе каталог так и останется в дереве до чужого `add -A`.
  if (!work.length) {
    return junkBlock + `Своей незакоммиченной работы у стадии нет — стадию не держу.\n`
  }
  return (
    head + list + junkBlock + why +
    `Закоммить в дереве задачи и закончи стадию заново:\n` +
    `  git -C ${wt} add -- ${names}\n` +
    `  git -C ${wt} commit -m "<что сделано>"\n` +
    `Файлы перечислены поимённо нарочно: \`add -A\` втягивает всё, что лежит рядом,\n` +
    `включая чужие артефакты прогона.\n`
  )
}

// Громкий стоп стадии — и защита от петли. `exit 2` на `SubagentStop` возвращает роль
// в работу: это и есть смысл проверок гигиены (починить дешевле внутри уже идущей
// стадии, чем вердиктом ревью через полный заход). Но если роль не чинит, тот же код 2
// вернёт её снова, и так без конца. Рантайм на второй заход выставляет
// `stop_hook_active` — тогда говорим то же самое и отпускаем: держать стадию дальше
// значит жечь токены на повторение, а сообщение уже сказано и осталось в stderr.
function stageStop(h, text) {
  process.stderr.write(text)
  if (h && h.stop_hook_active) {
    process.stderr.write('[firm2] Роль уже возвращали в работу этим сообщением — стадию дальше не держу.\n')
    process.exit(0)
  }
  process.exit(2)
}

function cmdHook(root, args) {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }
  let h = {}
  try {
    h = raw ? JSON.parse(raw) : {}
  } catch {
    h = {}
  }

  const agentType = h.agent_type || ''

  // Хуки плагина видны во ВСЕХ проектах, а журнал нужен только там, где поставку ведёт
  // этот движок. Иначе firm2 писал бы события проектам, которые о нём не просили. Эта
  // проверка стоит ПЕРВОЙ намеренно: ниже читается транскрипт субагента, и платить за
  // чтение файла в чужом проекте не за что.
  const cfg = readConfig(root)
  if (!cfg || cfg.engine !== 'firm2') process.exit(0)

  const hookEvent = h.hook_event_name || args.event_name || ''
  const marker = fromTranscript(h)
  const payload = fromPayload(h)
  const current = readCurrent(root, h.agent_id)
  const cwd = h.cwd || root

  // Стадия выводится из роли — кроме разведки, где её выдаёт МАРКЕР.
  //
  // Роль на груминге и в сборке одна и та же, а работа разная: Архитектор в сборке ведёт
  // арбитраж (`adjudicate`), на груминге — пишет решения темы; Дизайнер в поставке рисует
  // прототип (`design`), на груминге даёт перечень экранов. Различить их по `agent_type`
  // нельзя принципиально, а записать груминг стадией сборки значило бы соврать: `doctor`
  // такую ложь не ловит, зато тайминг поставки получил бы чужой интервал.
  //
  // Признак — `FIRM2-GROOM: G-XXX` в промпте, и он того же устройства, что carve-out
  // адъюдикации ниже: маркер кладёт код команды, и только он. Роли, которой в таблице нет
  // вовсе (PM), это и даёт стадию: на груминге она есть, в сборке PM не участвует.
  // Третий источник — транскрипт субагента, найденный по `agent_id`. На SubagentStart
  // рантайм не кладёт в нагрузку ни промпт, ни путь к транскрипту, а файл с маркером
  // к этому моменту уже может быть создан. Смотрим только когда первые два молчат:
  // на финише это лишнее чтение диска.
  //
  // Для РАЗВЕДКИ этот источник единственный на старте, и потому он читается до вывода
  // стадии: маркер темы кладёт команда в промпт субагента, в нагрузку хука он не попадает
  // вовсе. Без этого стадия груминга на старте не выводилась, и тесты показали ноль
  // событий там, где их два.
  //
  // На СТАРТЕ этот источник ждёт мета-файл подагента: рантайм пишет его на 1–2 с позже
  // хука, и без ожидания привязка не успевала появиться (отчёт проект-В 03.11.2026,
  // находка 2 — 1612 событий из 4338 без тикета, и все открывающие). Ожидание платное,
  // поэтому стоит ровно там, где без него будет `unknown`: на финише транскрипт уже есть,
  // и ждать нечего.
  const own = marker.ticket || payload.ticket
    ? {}
    : markerFromAgent(root, h.session_id, h.agent_id, {
      waitMs: (h.hook_event_name || args.event_name || '') === 'SubagentStart' ? BIND_WAIT_MS : 0,
    })

  // Стадия кончила ход, а запущенный ею долгий прогон идёт. Отчёт проект-В 03.11.2026
  // (находка 5): роль упаковки так потеряла полный прогон набора — 43 минуты, и во второй
  // раз при дословном запрете в промпте. Запрет держать нечем, а ФАКТ — можно: прогон
  // запускается через `suite-run.mjs`, и его расписка на диске помнит `agent_id` того,
  // кто запустил. Поэтому здесь не просьба, а две вещи, которые работают без послушания:
  // событие в журнале (его видно замером и на доске) и возврат роли в работу — на
  // `SubagentStop` это ровно то, что заставляет её дождаться своего прогона.
  if (hookEvent !== 'SubagentStart' && h.agent_id) {
    const left = abandonedRuns(root, h.agent_id)
    if (left.length) {
      for (const r of left) {
        writeEvent(root, {
          change: r.change || (listChanges(root).length === 1 ? listChanges(root)[0] : null),
          ticket: isBoundTicket(r.ticket) ? r.ticket : 'unknown',
          stage: 'guard',
          event: 'suite-abandoned',
          actor: agentType || 'unknown',
          agent_id: h.agent_id || null,
          session_id: h.session_id || null,
          source: 'hook',
          notes: `стадия кончила ход при идущем прогоне ${r.id}: ${r.cmd}`,
        })
      }
      stageStop(
        h,
        `[firm2] Ты кончаешь ход, а запущенный тобой прогон ИДЁТ (${left.length}):\n` +
          left.map((r) => `  ${r.id}: ${r.cmd}\n`).join('') +
          'Его итог существует только пока его кто-то снимет — кончишь ход, и снимать его\n' +
          'будет некому: ровно так 03.11.2026 потерялся прогон набора на 43 минуты, и во\n' +
          'второй раз это случилось при дословном запрете в промпте.\n' +
          'Дождись каждого, вызов за вызовом (один ждёт до 540 с, это внутри потолка):\n' +
          left.map((r) => `  node "${ENGINE_SCRIPTS}/suite-run.mjs" wait --id ${r.id}\n`).join('') +
          'Пришёл state: "finished" — в отчёте называй ЧИСЛА из его `summary`, а не строки,\n' +
          'выбранные глазами из середины лога. Прогон не нужен вовсе — сними его сам и\n' +
          'скажи это в notes; молча бросать нельзя.\n',
      )
    }
  }

  const groomed = /^G-/.test(marker.ticket || payload.ticket || own.ticket || current.ticket || '')
  const stage = groomed ? 'groom' : STAGE_BY_AGENT[agentType]
  if (!stage) process.exit(0) // не роль цикла сборки и не разведка — движок молчит

  // Вид события нужен ДО разбора тикета: от него зависит, законен ли последний запасной путь.
  let kind = hookEvent === 'SubagentStart' ? 'started' : 'finished'

  // Ветка рабочего каталога — запасной путь, и только для ФИНИША. На старте он хуже, чем
  // его отсутствие, и это не рассуждение: на проект-В 02.10.2026 рабочий каталог сессии
  // остался в дереве T-023 после ручного слияния, запустилась QA-панель по T-016 — и три
  // события `review/started` записались на T-023, с чужим номером попытки.
  //
  // Почему хуже отсутствия. Без него старт ушёл бы как `unknown` — дыра, про которую
  // `doctor` говорит прямо и которую на финише закрывает привязка по `agent_id`
  // (`resolveTickets`). С ним получается НЕПРАВДА, которую `doctor` не ловит вовсе: `ok`
  // остаётся true, стадия приписана чужой задаче, её тайминг и счётчик попыток испорчены.
  // Дыра лечится, ложь — нет: по ней потом принимают решения.
  //
  // На старте маркера в промпте ещё нет и собственного транскрипта тоже (см. ниже), так что
  // `unknown` здесь — штатный путь, а не сбой. На финише дерево задачи действительно её
  // собственное, и ветка каталога — честный источник.
  const fallbackTicket = kind === 'started' ? null : branchTicket(cwd)
  const ticket = marker.ticket || payload.ticket || own.ticket || current.ticket || fallbackTicket || 'unknown'
  // Поставку хук НЕ угадывает, и это тот же довод, что строкой выше про `fallbackTicket`:
  // ложь хуже дыры. Пока поставка одна, `listChanges` даёт её без всякой догадки; как только
  // живых поставок две, `activeChange` выбирает по правилу «первая, в которой задач ещё нет»
  // (lib/firm.mjs:1207) — то есть ровно ту, по которой сборка НЕ идёт: папку заводят на
  // разведке, задач в ней нет, и она же первая по алфавиту. Так и вышло на проект-В 11.10.2026
  // (Д-1): восемь событий стадий уехали в поставку 3.2, пока сборка шла по 3.1.
  //
  // Пустое поле при этом не теряется, а ДОСТРАИВАЕТСЯ. Читатель журнала берёт событие без
  // поставки в выборку любой (`listEvents`: `!e.change || e.change === change`), а обе
  // достройки привязки — по `agent_id` и по собственному транскрипту субагента —
  // заполняют `change` из того же источника, что и тикет, но ТОЛЬКО если поле пусто
  // (`if (!e.change && hit.change)`). То есть догадка не просто врала: она блокировала
  // починку, которая в движке уже есть.
  const changes = listChanges(root)
  const change = marker.change || payload.change || own.change || current.change || (changes.length === 1 ? changes[0] : null)
  const attempt = marker.attempt || payload.attempt || own.attempt || current.attempt || 1

  // Архитектор работает не только в адъюдикации: он же режет задачи на /firm-plan, и там
  // маркера тикета в промпте нет по устройству. Без этой проверки каждое планирование
  // засыпало бы журнал событиями с ticket: unknown, которые doctor показывает как дыры.
  // Признак адъюдикации — именно маркер: его кладёт workflow, и только он.
  if (stage === 'adjudicate' && ticket === 'unknown') process.exit(0)
  // То же и у проектирования (Д-31). Архитектор и Дизайнер работают не только в задаче:
  // на `/firm-plan` они режут поставку, а на груминге ведут тему, и маркера тикета в
  // промпте там нет ПО УСТРОЙСТВУ. Замер проект-В 31.10.2026: 29 закрывающих
  // `design-finished` легли с `ticket: unknown` — то есть событий, которые привязать не
  // к чему и никогда не будет чем, потому что задачи на том шаге ещё не существует.
  // Привязка по `agent_id` их не спасает: ей нужен парный старт с тикетом, а его нет.
  //
  // Молчать правильнее, чем писать дыру: `doctor` показывает `unknown` как поломку
  // привязки, а здесь привязки нет не по поломке, а по предмету шага.
  if (stage === 'design' && ticket === 'unknown') process.exit(0)

  let notes = null
  let criteria = null

  // Structured output стадии разбираем ОДИН раз: на финише он нужен трём ветвям разом,
  // а стоит чтения файла в мегабайты. На старте его не существует — там и не читаем.
  const so = kind === 'started' ? null : verdictFrom(root, h)

  // Вердикт ревью — не догадка: это structured output роли, машинный JSON.
  if (kind === 'finished' && stage === 'review') {
    const v = so
    if (v) {
      kind = v.verdict === 'принято' ? 'accepted' : 'rejected'
      if (v.escalate) kind = 'escalated'
      notes = v.notes || null
      // Разбор по критериям кладём в событие: это единственное место, где связь
      // «критерий приёмки → проверен» существует машинно. Без неё галочки в задаче
      // никто не проставит, и человек на воротах смотрит на пустые квадратики при
      // принятой задаче. Храним коротко — формулировку и исход, без доказательств.
      if (Array.isArray(v.criteria_results)) {
        criteria = v.criteria_results
          .filter((c) => c && c.criterion)
          .map((c) => ({ c: String(c.criterion).trim(), s: String(c.status || '').trim() }))
      }
    }
  } else if (kind === 'finished' && stage === 'adjudicate') {
    // Адъюдикация — тот же вердикт, только другими словами: `blocker` возвращает задачу
    // разработчику, `not_blocker` пропускает её дальше. До 02.10.2026 этот путь не писал
    // в журнал НИЧЕГО, кроме `finished`, и `last_verdict` следующего прогона оказывался
    // пустым именно там, где он нужнее всего: задачу отклонили не за формальный критерий,
    // а по разбору расхождения панели. На проект-В (T-034, T-047) текст вердикта пришлось
    // вписывать в задачу руками — подпорка, которая держится на памяти человека.
    const v = so
    if (v && v.verdict === 'blocker') kind = 'rejected'
    else if (v && v.verdict === 'not_blocker') kind = 'accepted'
    // Эскалация бьёт вердикт и здесь — как на всех прочих финишах. В схеме адъюдикации
    // поля `escalate` нет, так что путь этот умозрительный; но «на одном финише
    // эскалация значит эскалацию, а на соседнем ничего» — ровно тот вид расхождения,
    // который потом ищут полдня.
    if (v && v.escalate) kind = 'escalated'
    if (v) {
      const parts = []
      if (v.notes) parts.push(String(v.notes).trim())
      if (v.bug_path) parts.push(`баг: ${String(v.bug_path).trim()}`)
      notes = parts.length ? parts.join(' ') : null
    }
  } else if (kind === 'finished') {
    if (so && so.escalate) kind = 'escalated'
  }

  // Что сказал Разработчик. До 0.4.91 его structured output не читал НИКТО: ни сборщик
  // (он брал одно поле `escalate`), ни журнал, ни промпт Ревьюера. Та же болезнь, что была
  // у Тестировщика до 04.10.2026, только дожившая до разбора стадии 21.10.2026. В журнал
  // кладём коротко: статус, если он не `ok`, объявленный объём правки и занятые порты —
  // по ним уборка после слияния ищет процессы, переживающие задачу.
  if (kind !== 'started' && stage === 'dev' && so) {
    const parts = []
    if (so.status && so.status !== 'ok') parts.push(`статус ${String(so.status).trim()}`)
    const files = Array.isArray(so.files_changed) ? so.files_changed.filter(Boolean) : []
    if (files.length) parts.push(`объявлено файлов: ${files.length}`)
    const ports = Array.isArray(so.ports) ? so.ports.filter((x) => Number.isFinite(Number(x))) : []
    if (ports.length) parts.push(`порты: ${ports.join(', ')}`)
    // Без обрезки: это причина остановки стадии, и событие — её единственное штатное
    // место. Общий предел применяется ниже, одним правилом на все стадии.
    if (so.notes) parts.push(String(so.notes).trim())
    if (parts.length) notes = parts.join(' | ')
  }

  // Чем Тестировщик доказал, что его тесты могут упасть, и сколько прогон пропустил.
  // Кладём в событие, потому что внутри прогона это живёт ровно до конца стадии, а
  // вопрос «адекватны ли тесты» — вторая по частоте причина отклонений ревью (разбор
  // 04.10.2026: ~6 заходов из 30). Пусть ответ на него остаётся в журнале.
  if (kind !== 'started' && stage === 'test' && so) {
    const parts = []
    const rep = so.report && typeof so.report === 'object' ? so.report : {}
    if (Number(rep.skipped) > 0) parts.push(`пропущено ${Number(rep.skipped)}: ${String(so.skipped_why || 'без объяснения').trim()}`)
    const mc = so.mutation_check && typeof so.mutation_check === 'object' ? so.mutation_check : null
    if (mc && mc.done && mc.evidence) parts.push(`мутация: ${String(mc.evidence).trim()}`)
    else if (mc && mc.why_not) parts.push(`без мутации: ${String(mc.why_not).trim()}`)
    const tports = Array.isArray(so.ports) ? so.ports.filter((x) => Number.isFinite(Number(x))) : []
    if (tports.length) parts.push(`порты: ${tports.join(', ')}`)
    // ПРОТОКОЛ СТАДИИ. С 0.4.140 он приезжает полем ответа, а не дописывается в файл
    // задачи: в конец карточки писали две руки с двух ветвей, и 23 отказа слияния из 90 у
    // проект-В (26%, четыре поставки подряд) были об этот файл. Событие — его штатное место,
    // как `lifecycle/arbitrated` для текста решения арбитража.
    //
    // Ставится ПОСЛЕДНИМ и целиком: общий предел длины применяется ниже одним правилом
    // (`fitNotes`), и если обрезать придётся, обрежется хвост протокола, а не числа
    // прогона перед ним.
    if (so.protocol) parts.push(`протокол: ${String(so.protocol).trim()}`)
    if (parts.length) notes = parts.join(' | ')
  }

  const ev = {
    change,
    ticket,
    stage,
    event: kind,
    actor: agentType,
    attempt: Number(attempt) || 1,
    agent_id: h.agent_id || null,
    session_id: h.session_id || null,
    git_sha: gitSha(cwd),
    source: 'hook',
  }
  // Сколько движок ждал привязку. Поле пишется ТОЛЬКО когда ожидание было, то есть на
  // старте без маркера в нагрузке: иначе оно стояло бы нулём у каждого события и читалось
  // как «механизм работает», ничего при этом не меря. Ненулевое значение при известном
  // тикете — цена привязки (замер проект-В: отставание мета-файла 2 с); значение у события
  // с `ticket: unknown` — доказательство, что файла не было и через пять секунд, а не
  // догадка о том, почему привязка не нашлась (ADR-0007).
  if (Number(own.bind_wait_ms) > 0) ev.bind_wait_ms = Number(own.bind_wait_ms)
  // НА КАКОМ КОДЕ ШЛА ЭТА СТАДИЯ. Наблюдение проект-В 10.11.2026, седьмой прогон: `scripts/`
  // читаются по `engine_root` ЖИВЬЁМ, то есть доставка движка меняет код под идущей волной,
  // и на одну попытку может прийтись смешанный код — стадии до пуша на старом, после на
  // новом. Само это не дефект (обкатка и значит, что движок меняется под проектом), но
  // когда попытка даёт странное, граница версий остаётся ПОДОЗРЕНИЕМ без улики: роль своей
  // версии не знает, а журнал её не помнил.
  //
  // Поле пишется ТОЛЬКО при расхождении — ровно по тому же правилу, что `bind_wait_ms`
  // выше: одинаковое значение у каждого события читалось бы как «механизм работает», ничего
  // при этом не меря, а шум убивает сигнал надёжнее молчания. Расхождение же само себе
  // новость: волну начали на одной версии, стадия прошла на другой.
  const evs = engineVersionState(root, cfg)
  if (evs.drift) ev.engine_drift = { recorded: evs.recorded, actual: evs.actual }
  if (notes) ev.notes = fitNotes(ev, notes)
  if (criteria && criteria.length) ev.criteria = criteria
  // Перерасход бюджета стадии. Движок не прерывает идущего подагента — прервать его
  // нечем, — поэтому бюджет держится тремя вещами: он назван стадии в промпте, здесь он
  // ИЗМЕРЯЕТСЯ, и дальше он виден на доске. Отметка ставится на событии, а не считается
  // потом по журналу, по той же причине, что и расход токенов: событие иммутабельно
  // (ADR-0003), и факт о стадии живёт в её собственном событии.
  //
  // Начало берётся по `agent_id` — единственная связь старта с финишем, которая верна и
  // при неразобранном тикете (на старте он сплошь и рядом `unknown`, см. выше).
  const budget = kind !== 'started' ? Number(stageBudget(cfg)[stage]) || 0 : 0
  if (budget && ev.agent_id) {
    const started = listEvents(root, { change })
      .find((e) => !e._broken && e.event === 'started' && e.agent_id === ev.agent_id)
    const ms = started ? Date.parse(ev.ts || new Date().toISOString()) - Date.parse(started.ts) : NaN
    const mins = Number.isFinite(ms) ? Math.round(ms / 60000) : NaN
    // Отрицательное и неправдоподобно большое не записываем: это не перерасход, а
    // испорченное время (тот же порог, что у замера долгих стадий, — восемь часов).
    if (Number.isFinite(mins) && mins > budget && mins < 480) {
      ev.over_budget = { minutes: mins, budget }
    }
  }
  // СКОЛЬКО СТАДИЙ ШЛО ОДНОВРЕМЕННО (предложение проект-В 10.11.2026, разбор T-374, п.4).
  // Без этого числа `over_budget` выше говорит «стадия вышла за 30 минут» и не говорит,
  // одна ли она шла, а отказ стадии «это красное про нагрузку» остаётся заявленным, а не
  // предъявимым. Считается из журнала (lib/firm.mjs, concurrencyAt) — рантайм этих чисел
  // не знает: хук на каждого подагента свой.
  //
  // Только на финишах: на старте стадия сама ещё не началась, и «одновременно с ней» —
  // вопрос про другой момент. Поле пишется ТОЛЬКО когда посчиталось: `null` от замера
  // значит «связать старт с финишем нечем», и нуль вместо него был бы ложью (И-12).
  if (kind !== 'started' && ev.agent_id) {
    if (!ev.ts) ev.ts = new Date().toISOString()
    const caps = laneCaps(cfg)
    const byId = new Map()
    if (Object.keys(caps).length) for (const t of listTasks(root, change)) byId.set(t.id, t)
    const c = concurrencyAt(listEvents(root, { change }), ev, { taskById: byId, caps })
    if (c) {
      ev.concurrent_stages = c.stages
      if (c.lane) ev.concurrent_lane = c.lane
    }
  }
  // Отпечаток содержимого, которое судила стадия (ADR-0013). Только на финишах вердикта:
  // `review` обоими исходами (отклонение тоже вынесено по конкретному содержимому, и
  // следующая попытка должна быть с ним сравнима) и `adjudicate`. На старте стемплить
  // нечего — судить ещё не начинали.
  //
  // Спрашиваем ветку из ГЛАВНОГО дерева, а не `cwd`: ссылка `task/T-XXX` видна оттуда
  // всегда, а рабочий каталог стадии ревью движок не задаёт и полагаться на него нельзя.
  if (kind !== 'started' && ['review', 'adjudicate'].includes(stage) && isBoundTicket(ticket)) {
    const tr = taskTree(root, ticket)
    if (tr) ev.tree = tr
  }
  // Только на финише: на старте транскрипта субагента ещё нет, считать нечего.
  // Событие иммутабельно (ADR-0003), поэтому расход стадии пишется один раз — здесь.
  if (kind !== 'started') {
    const tok = tokensOf(h)
    if (tok) ev.tokens = tok
  }

  // ПАУЗУ ДЕРЖИТ КОД, а не субагент-зонд (Д-17 разбора 05.10.2026).
  //
  // Что случилось. Пауза стояла с 13:45:48, задача T-024f законно доработала начатое и
  // влилась в 14:30:40 — а в 14:32:44 прогон взял НОВУЮ задачу T-059. Зонд паузы в
  // планировщике — это субагент: он выполняет команду и возвращает `state`. Правило «не
  // смог проверить — считаем паузой» закрывает случай «команда не отработала» и не
  // закрывает «отработала, а агент ответил running». Движок спрашивал у модели факт,
  // который умеет проверить сам, и верил ответу на слово.
  //
  // Почему именно здесь. `SubagentStart` видит КАЖДУЮ стадию и исполняется кодом — это
  // ADR-0002 буквально. Зонд в планировщике остаётся (он экономит заведение рабочего
  // дерева), но перестаёт быть единственной защитой.
  //
  // Что считается новой задачей: старт `dev`, у которого в журнале нет прежних событий
  // `dev` по этому тикету. Доработка (вторая и дальше попытка) ПРОХОДИТ — пауза по
  // замыслу значит «доработать начатое и не брать новых», и остановить доработку значило
  // бы бросить рабочее дерево на середине, то есть сделать ровно то, от чего пауза спасает.
  if (kind === 'started' && stage === 'dev' && ticket !== 'unknown') {
    const ps = pauseState(root)
    if (ps.paused) {
      const evs = listEvents(root, { change }).filter((e) => !e._broken && e.ticket === ticket)
      const started = evs.some((e) => e.stage === 'dev')
      if (!started) {
        // Событие пишем ОДИН раз на тикет: рантайм может пробовать старт повторно, а
        // журнал — история поставки, а не лог попыток. Один отказ отвечает на вопрос
        // «почему эта задача не начата» полностью.
        if (!evs.some((e) => e.stage === 'guard' && e.event === 'pause-held')) {
          writeEvent(root, {
            change,
            ticket,
            stage: 'guard',
            event: 'pause-held',
            actor: 'stage-hook',
            notes: `новая задача не начата: стоит пауза${ps.reason ? ` (${ps.reason})` : ''}`,
            agent_id: h.agent_id || null,
            session_id: h.session_id || null,
            source: 'hook',
          })
        }
        // Не через `stageStop`: тот умеет пропустить отказ при `stop_hook_active` — это
        // верно для гигиенических проверок на финише (роль уже возвращали в работу), и
        // неверно здесь. Паузу ставит человек, и обойти её флагом рантайма нельзя.
        process.stderr.write(
          `[firm2] стоит ПАУЗА — новая задача ${ticket} не начинается.\n` +
            (ps.reason ? `Причина паузы: ${ps.reason}\n` : '') +
            'Это не ошибка стадии и не твой промах: человек остановил набор новых задач.\n' +
            'Доработка уже начатых задач паузой не отменяется и идёт как обычно.\n' +
            'Снять паузу: firm-state.mjs resume — это делает человек, не ты.\n',
        )
        process.exit(2)
      }
    }
  }

  const path = writeEvent(root, ev)
  if (change) refresh(root, change)

  // Старт без тикета — не дыра: собственного транскрипта у субагента в этот момент ещё нет,
  // а agent_id свяжет это событие с финишем, который тикет уже знает (resolveTickets).
  // Кричать здесь значило бы кричать на каждой стадии и обесценить сигнал.
  if (ticket === 'unknown' && kind === 'started' && ev.agent_id) process.exit(0)

  // Стадия закончилась — проверяем, не насорила ли она в главном дереве. Сообщаем громко
  // (exit 2), потому что тихое предупреждение здесь ничего не даёт: слияние упадёт позже,
  // когда разбирать уже дороже, а исправить может только тот, кто эти файлы написал.
  if (kind !== 'started' && ['dev', 'test', 'review'].includes(stage)) {
    const stray = strayFiles(root, ticket, cfg)
    if (stray.length) {
      process.stderr.write(
        `[firm2] Стадия ${stage} задачи ${ticket} оставила файлы в ГЛАВНОМ дереве репозитория:\n` +
          stray.map((f) => `  ${f}\n`).join('') +
          `Они же есть в дереве задачи — значит записаны по относительному пути мимо него.\n` +
          `Пока они там лежат, ветка task/${ticket} не сольётся: git не затирает неотслеживаемое.\n` +
          `Сверь каждый с версией в ${join(worktreesDir(root, cfg), ticket)} и удали копию из корня.\n`,
      )
      process.exit(2)
    }
  }

  // Артефакт стадии — это коммит. Говорим громко (exit 2): на SubagentStop это
  // возвращает роль в работу, то есть она закоммитит сама, прямо сейчас — вместо того
  // чтобы узнать об этом вердиктом ревью и потратить на `git add` целый второй заход.
  if (kind !== 'started' && ['dev', 'test'].includes(stage)) {
    const dirty = uncommittedInTaskWorktree(root, ticket, cfg)
    if (dirty.length) {
      const text = notCommittedText(root, ticket, cfg, dirty)
      // Незакоммиченного своего нет — только артефакты прогона. Стадию не держим:
      // возвращать роль в работу незачем, её коммит на месте. Но сказать обязаны, иначе
      // каталог доживёт до чужого `add -A` — ровно так и случилось на проект-В (Д-5).
      if (dirty.every((e) => e.junk)) process.stderr.write(text)
      else stageStop(h, text)
    }
  }

  // Пропущенные тесты. Разбор 04.10.2026: на проект-В T-036 браузерный гейт возвращал ноль,
  // пропустив тесты через `pytest.skip` при отсутствии `node_modules` — «2 passed, 1
  // skipped», код возврата 0, и все прочли это как «зелено». Ревьюер поймал это рукой,
  // унеся `node_modules` за пределы дерева; движок может поймать сам, потому что число
  // назвала сама роль.
  //
  // Требуем не «ноль пропусков», а ОБЪЯСНЕНИЕ: пропуск бывает законным (нет браузера, нет
  // внешней службы), и запрет гнал бы роль снимать пометки вместо честного ответа. Молчим,
  // когда structured output нет вовсе: роль со старым промптом числа не вернёт, а стадия
  // из-за рассинхрона версий встать не должна — `scripts/` доезжают в проекты сразу, а
  // промпты только после обновления плагина.
  if (kind !== 'started' && stage === 'test' && so && so.report && Number(so.report.skipped) > 0) {
    const why = String(so.skipped_why || '').trim()
    if (!why) {
      stageStop(
        h,
        `[firm2] Стадия test задачи ${ticket}: прогон пропустил ${Number(so.report.skipped)} тест(ов), ` +
          `и почему — не сказано.\n` +
          `Пропущенный тест ничего не проверил, а прогон при этом зелёный: именно так на проект-В\n` +
          `браузерный гейт возвращал ноль без единой проверки экрана.\n` +
          `Либо сделай пропуски исполнимыми, либо верни skipped_why: что пропущено и почему\n` +
          `это законно (нет браузера, нет внешней службы, тест для другой платформы).\n`,
      )
    }
    // Объяснение есть — но для задачи с меткой `требует-браузера` объяснение «браузера
    // нет» законным не бывает: вся метка про то, что критерий закрывается живым прогоном.
    // Разбор проект-В 11.10.2026 (T-089): стадия закрылась зелёной с коммитом «живой прогон
    // не выполнен, браузер недоступен». Поэтому здесь отказ, и вместе с ним — рецепт:
    // без выхода роль пропустит проверку снова, просто другими словами.
    else {
      const task = listTasks(root, activeChange(root)).find((t) => t.id === ticket) || null
      const finding = browserSkipFinding(task, so)
      if (finding) stageStop(h, `[firm2] Стадия test задачи ${ticket}: ${finding}\n`)
    }
  }

  // Мутационная проверка. Намеренно НЕ блокирует: мутировать бывает нечего (документный
  // тикет), а «докажи, что тест может упасть» — суждение, а не факт, и движку его не
  // выносить. Наше дело — чтобы доказательство не пропадало: оно уходит в событие (выше)
  // и в промпт Ревьюера, который и судит адекватность тестов.
  if (kind !== 'started' && stage === 'test' && so && !so.mutation_check) {
    process.stderr.write(
      `[firm2] Стадия test задачи ${ticket}: mutation_check не возвращён.\n` +
        `Ревьюер будет судить адекватность тестов без доказательства, что они могут упасть,\n` +
        `а это вторая по частоте причина отклонений. Верни mutation_check: { done, evidence }\n` +
        `или { done: false, why_not: "..." }, если мутировать в этой задаче нечего.\n`,
    )
  }

  if (ticket === 'unknown') {
    process.stderr.write(
      `[firm2] Событие ${stage}/${kind} записано БЕЗ тикета (${path}).\n` +
        `Ни маркера FIRM2-TICKET в промпте, ни .firm/current/<agent_id>.json, ни ветки task/T-XXX.\n` +
        'Статистика по этой задаче будет дырявой — почини привязку, прежде чем продолжать.\n',
    )
    process.exit(2)
  }
  process.exit(0)
}

// Откуда берётся вердикт стадии. Три источника, и порядок между ними не вкусовой:
//
// 1. `last_assistant_message` из нагрузки хука — дёшево и не требует диска, но
//    structured output туда НЕ попадает (разбор 02.10.2026, см. комментарий у
//    `structuredOutputFromTranscript`). Оставлен первым: если рантайм когда-нибудь
//    начнёт класть JSON и сюда, лишнего чтения файла не будет.
// 2. собственный транскрипт стадии по пути ИЗ нагрузки — основной путь на финише;
// 3. тот же транскрипт, найденный по `agent_id`, — когда пути в нагрузке нет.
//
// Молчание всех трёх — законный ответ: роль без схемы structured output не возвращает,
// и выдумывать вердикт за неё нельзя (ADR-0007).
function verdictFrom(root, h) {
  return (
    verdictOf(h.last_assistant_message) ||
    structuredOutputFromTranscript(h.agent_transcript_path) ||
    structuredOutputFromAgent(root, h.session_id, h.agent_id)
  )
}

function verdictOf(msg) {
  if (!msg) return null
  const s = String(msg)
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    if (typeof o !== 'object' || o === null) return null
    if (!('verdict' in o) && !('escalate' in o) && !('status' in o)) return null
    return o
  } catch {
    return null
  }
}

// Релиз: событие ставится ВСЕМ задачам поставки разом — так его и пишет git-хук
// post-merge, когда ветка поставки влита в main.
// Сказать вслух, если журнал пишется не туда, откуда позвали: иначе человек ищет события
// в главном дереве, а они в связанном, и «событий нет» читается как «хук не сработал».
function journalHome(root, branch, what) {
  const home = journalRootFor(root, branch)
  if (home.moved) {
    process.stderr.write(
      `[firm2] ${what}: событие принадлежит ветке ${home.branch}, а она выгружена не здесь — ` +
      `пишу в ${home.root}\n` +
      `        (в ${root} сейчас ${headBranchOf(root) || '?'}, и запись туда легла бы на чужую ветку)\n`,
    )
  }
  return home.root
}

function headBranchOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function cmdRelease(root, args) {
  const change = args.change || activeChange(root)
  if (!change) {
    process.stderr.write('[firm-event] не понял, какой change выпущен\n')
    process.exit(1)
  }
  // Событие выпуска принадлежит ветке-ЦЕЛИ, и писать его надо туда, где она выгружена
  // (Д-51). Главное дерево во время сборки обычно стоит на ветке поставки, а вливают в
  // связанном дереве: 05.11.2026 на проект-В так ушли 35 записей на уже мёртвую ветку.
  root = journalHome(root, (readConfig(root)?.vcs || {}).target_branch || 'main', 'выпуск')
  // Только те задачи, что реально дошли до слияния. Замысел говорил «всем задачам
  // разом», но это верно лишь когда поставка целиком принята; проставить released
  // задаче, которая стоит blocked или todo, значит записать в журнал неправду.
  const board = computeBoard(root, change, { parallelism: parallelismOf(root) })
  // Выпуск идемпотентен. Команду зовёт git-хук post-merge, но позвать её может и человек —
  // например, после того как починили поиск задач в архиве. Без этой проверки второй вызов
  // писал второе событие выпуска той же задаче: на пилоте так вышло 20 файлов на 14 задач,
  // и календарная метрика получила два момента выпуска вместо одного.
  const already = new Set(
    listEvents(root)
      .filter((e) => !e._broken && e.stage === 'release' && e.event === 'finished' && e.change === change)
      .map((e) => e.ticket),
  )
  const tasks = board.tasks.filter((t) => t.status === 'merged' && !already.has(t.id))
  const written = []
  for (const t of tasks) {
    written.push(writeEvent(root, {
      change,
      ticket: t.id,
      epic: t.epic,
      stage: 'release',
      event: 'finished',
      // Кто позвал, тот и записан. Умолчанием тут стоял `git-post-merge`, и событие,
      // записанное человеком руками, выглядело записанным хуком: на пилоте это увело
      // разбор в сторону (23.09.2026). Хук называет себя сам, флагом --actor.
      actor: args.actor || 'manual',
      attempt: 1,
      git_sha: args.git_sha || gitSha(root),
      source: 'git-hook',
    }))
  }
  refresh(root, change)
  const skipped = board.tasks
    .filter((t) => t.status !== 'merged' || already.has(t.id))
    .map((t) => `${t.id}: ${already.has(t.id) ? 'уже выпущена' : t.status}`)
  if (skipped.length) {
    process.stderr.write(`[firm2] не выпущены: ${skipped.join(', ')}\n`)
  }
  print(args, { ok: true, change, released: written.length, skipped })
}

function cmdSync(root, args) {
  const change = args.change || activeChange(root)
  if (!change) {
    print(args, { ok: false, reason: 'нет ни одного change' })
    return
  }
  // Событие слияния задачи принадлежит ветке ПОСТАВКИ — там же лежат файлы задач, пометки
  // которых сверка правит. Тот же Д-51 с другой стороны: прежде корень был всегда главным
  // деревом, и при главном дереве на посторонней ветке правки уезжали на неё.
  root = journalHome(root, `feature/${change}`, 'слияние задачи')
  const res = refresh(root, change)
  // Сверка пометок задачи с её фактическим диффом. Говорим только про задачи, слияние
  // которых записала ИМЕННО ЭТА сверка: на поставке в шесть десятков задач полный список
  // расхождений — это сорок строк на каждом слиянии, то есть шум, который перестают
  // читать. Полный список живёт на дашборде, где его смотрят, когда он нужен.
  const fresh = (res.reconciled || []).map((r) => r.ticket).filter(Boolean)
  if (fresh.length) {
    const cfg = readConfig(root)
    const rules = areaRules(cfg)
    if (rules.length) {
      const files = filesByTask(root, change)
      const tasks = listTasks(root, change)
      const lines = []
      for (const id of fresh) {
        const t = tasks.find((x) => x.id === id)
        if (t) lines.push(...areaFindings(t, files.get(id), rules))
      }
      if (lines.length) {
        process.stderr.write(
          '[firm2] Пометки задачи расходятся с тем, что она на самом деле правила:\n' +
            lines.map((l) => `  ${l}\n`).join('') +
            'Это не отменяет слияния — задача влита. Но на воротах поставки это надо знать:\n' +
            'макет мог остаться несверенным, а живой проверки экрана могло не быть вовсе.\n',
        )
      }
    }
  }
  print(args, { ok: true, ...res })
}

function cmdDashboard(root, args) {
  const change = args.change || activeChange(root)
  const path = buildDashboard(root, change)
  print(args, { ok: true, dashboard: path })
}

// doctor — ищет дыры: события без тикета, started без парного finished,
// расхождение кэша с журналом, битые файлы событий.
// ── Инварианты журнала: чего в нём быть НЕ МОЖЕТ ─────────────────────────────
//
// Отдельный рубеж, появился 01.10.2026 после трёх дефектов одного дня. Все три прошли и
// синтаксис, и мои собственные проверки, и доехали до четырёх проектов — потому что
// проверялось «работает ли код», а не «возможно ли то, что он записал».
//
// Разница в источнике правды. Остальной `doctor` ищет ДЫРЫ: старт без финиша, тикет без
// привязки, кэш против журнала. Здесь же журнал сверяется с тем, что физически возможно:
// с git и с порядком времени. Такую проверку не заменить тестом — тест знает лишь те
// входные данные, которые я сумел выдумать, а эта работает на живых прогонах, где
// входные данные выдумывает реальность.
//
// Три инварианта — ровно по трём дефектам, и каждый поймал бы свой за минуты:
//
//  1. «влито» без мержа. `merge/finished` по задаче, чья ветка жива, но её вершина не
//     стоит вторым родителем ни у одного мерж-коммита поставки, И своих коммитов
//     относительно поставки у ветки нет. Значит вливать было нечего и слияния не было.
//     Условие про «нет своих коммитов» — защита от ложной тревоги: если задачу влили, а
//     потом в ветке продолжили работу, вершина уехала с мерж-коммита законно.
//  2. событие без времени. Журнал сортируется по `ts`; событие без него необратимо
//     ломает и порядок, и тайминг, и читателя.
//  3. слияние раньше начала работы. `merge/finished` с временем до первого `dev/started`
//     по той же задаче — такого порядка в природе нет.
//
// Инварианты влияют на `ok`: это не «повод посмотреть», а доказанная неправда в журнале.
// Чинится она не правкой файлов (ADR-0003, журнал иммутабелен), а аннулированием:
// `record --event retracted --corrects <файл> --notes "почему"`. Поэтому к каждой находке
// движок печатает готовую команду.
function journalInvariants(root, change, events) {
  if (!change) return []
  const found = []
  const featureBranch = `feature/${change}`
  const hasFeature = gitLines(root, ['rev-parse', '--verify', featureBranch]).length > 0
  const tips = hasFeature ? mergedTips(root, featureBranch) : new Map()
  const firstDev = new Map()
  for (const e of events) {
    if (e._broken) continue
    if (e.stage === 'dev' && e.event === 'started' && e.ticket && !firstDev.has(e.ticket)) {
      firstDev.set(e.ticket, e.ts)
    }
  }
  const fix = (e, why) => ({
    file: e._file,
    ticket: e.ticket,
    why,
    fix:
      `firm-event.mjs record --ticket ${e.ticket} --stage ${e.stage} --event retracted ` +
      `--corrects ${e._file} --notes "<почему событие неверно>"`,
  })
  // Больше одного «влито» по задаче. Инварианты выше спрашивают «есть ли мерж под
  // событием»; этот — «не больше ли событий, чем мержей». Дубль давал хук, писавший событие
  // по тексту рефлога: слияние ветки-зависимости внутри дерева задачи записывало вторую
  // `merge/finished` той же задаче, и `timing` брал по последней — то есть по чужому
  // слиянию. Хук исправлен, но проверка остаётся: инвариант не должен держаться на том,
  // что единственный известный путь к его нарушению закрыт.
  const mergeFinished = new Map()
  for (const e of events) {
    if (e._broken || e.stage !== 'merge' || e.event !== 'finished' || !e.ticket) continue
    if (!mergeFinished.has(e.ticket)) mergeFinished.set(e.ticket, [])
    mergeFinished.get(e.ticket).push(e)
  }
  for (const [ticket, list] of mergeFinished) {
    if (list.length < 2) continue
    for (const e of list.slice(1)) {
      found.push(
        fix(
          e,
          `по ${ticket} уже есть событие слияния (${list[0]._file}) — влить задачу дважды нельзя; ` +
            'лишнее событие сдвигает тайминг и могло прийти от слияния в чужую ветку',
        ),
      )
    }
  }
  for (const e of events) {
    if (e._broken) continue
    if (!e.ts) {
      found.push(fix(e, 'событие без времени: журнал сортируется по ts, а его нет'))
      continue
    }
    if (!(e.stage === 'merge' && e.event === 'finished') || !e.ticket || e.ticket === 'unknown') continue
    const dev = firstDev.get(e.ticket)
    if (dev && Date.parse(e.ts) < Date.parse(dev) - IMPOSSIBLE_SLACK_MS) {
      found.push(fix(e, `слияние ${e.ts} раньше начала разработки ${dev} — такого порядка не бывает`))
      continue
    }
    if (!hasFeature) continue
    const tip = gitLines(root, ['rev-parse', `task/${e.ticket}`])[0]
    if (!tip) continue // ветки нет — судить не по чему, история задачи могла быть удалена
    if (tips.has(tip)) continue
    const own = gitLines(root, ['rev-list', '--count', `${featureBranch}..task/${e.ticket}`])[0]
    if (own && own !== '0') continue // после слияния в ветке продолжили работу — вершина уехала законно
    found.push(
      fix(
        e,
        `в ${featureBranch} нет мерж-коммита с вершиной task/${e.ticket} вторым родителем, ` +
          'и своих коммитов у ветки нет — вливать было нечего',
      ),
    )
  }
  return found
}

// И-13: влито то самое содержимое, которое принимали (ADR-0013).
//
// Вторая половина правила, зеркальная гварду `review-receipt.mjs`. Гвард предотвращает —
// он стоит на `git merge` и отказывает до слияния; эта проверка отвечает на тот же вопрос
// ЗАДНИМ ЧИСЛОМ, по истории, и потому ловит ровно те пути, куда гвард не достаёт:
// слияние, доведённое `git commit` после конфликта (на него не вешается даже post-merge,
// см. ADR-0005), и слияние руками в обычном Терминале.
//
// Сравниваем дерево ВЛИТОГО коммита с отпечатком расписки. Молчим в трёх случаях, и все
// три — честное «судить не по чему», а не снисхождение: расписки нет вовсе (задачу влили
// непринятой — это другой дефект, и прятать два вопроса за одним ответом нельзя), у
// расписки нет отпечатка (событие записано движком старше 0.4.83), влитую вершину уже не
// опознать (ветка уехала после слияния).
function staleReceipts(root, change, events) {
  if (!change) return []
  const featureBranch = `feature/${change}`
  if (!gitLines(root, ['rev-parse', '--verify', featureBranch]).length) return []
  const tips = mergedTips(root, featureBranch)
  if (!tips.size) return []
  const out = []
  const seen = new Set()
  for (const e of events) {
    if (e._broken || e.stage !== 'merge' || e.event !== 'finished' || !isBoundTicket(e.ticket)) continue
    if (seen.has(e.ticket)) continue
    seen.add(e.ticket)
    const receipt = acceptedReceipt(events, e.ticket)
    if (!receipt || !receipt.tree) continue
    const tip = gitLines(root, ['rev-parse', `task/${e.ticket}`])[0]
    if (!tip || !tips.has(tip)) continue
    const mergedTree = treeOfCommit(root, tip)
    if (!mergedTree || mergedTree === receipt.tree) continue
    out.push({
      ticket: e.ticket,
      accepted_tree: receipt.tree,
      merged_tree: mergedTree,
      receipt: receipt.file,
      why:
        `принято было дерево ${receipt.tree} (${receipt.stage}/${receipt.event}, ${receipt.ts}), ` +
        `а влито ${mergedTree} — в поставку уехало содержимое, которого надзор не видел`,
      fix:
        `пересмотреть влитое и записать решение: firm-event.mjs record --ticket ${e.ticket} ` +
        `--stage review --event accepted --actor human --notes "влитое содержимое проверено после вердикта"`,
    })
  }
  return out
}

// И-14: цепочка расписок об отправке цела (ADR-0014).
//
// Журнал только дописывается (И-2), и у расписок эта дисциплина проверяема арифметически:
// каждая несёт `digest` по своему содержимому и `prev` — digest предыдущей расписки ТОЙ ЖЕ
// задачи. Удалили расписку — следующая ссылается в никуда; правили — её `digest` не сходится
// с содержимым. И то, и другое здесь находится, и на `ok` влияет: это не вопрос без ответа,
// а переписанная история.
//
// Цепочка по задаче, а не по проекту, потому что порядка по проекту у нас нет: стадии идут
// параллельно, и две отправки выбрали бы одного предшественника — вилка читалась бы как
// разрыв на ровном месте (И-8: слот занимает задача).
//
// ПОПРАВКА 05.11.2026, и она отменяет линейность внутри задачи. Довод выше верен, но
// исполнен был наполовину: цепочка по задаче требовала СТРОГО одного следующего за каждым
// предшественником, а задача `MR` — это вся поставка, и расписки ей пишут все параллельные
// деревья и обе живые линии продукта. Вилка внутри `MR` так же неизбежна, как вилка между
// задачами. Замер на журнале проект-В (134 расписки, из них 120 у `MR`): развилок 4, ссылок
// на несуществующую расписку — НОЛЬ. То есть все четыре находки сверки были ложными, а
// снять их нечем: журнал неизменяем (ADR-0006), и `doctor` краснел бы навсегда.
//
// Что на самом деле доказывает цепочка — не порядок, а ДОСТИЖИМОСТЬ: `prev` обязан назвать
// расписку той же задачи, которая существует и старше. Удалённую расписку это ловит так же
// (ссылка указывает в пустоту), а параллельную запись больше не обвиняет. Отдельно считаем
// развилки и показываем их как наблюдение: на `ok` они не влияют, но знать о них полезно —
// это карта того, сколько линий писали одновременно.
//
// Урок общий, и он дороже самой правки: «цепочка» в журнале, который пишут параллельно,
// обязана быть ДЕРЕВОМ. Линейность здесь — требование, которого реальность не исполняет, и
// первое же живое сравнение превращает его в четыре ложных обвинения.
function egressChain(root, change, events) {
  const byTicket = new Map()
  for (const e of events) {
    if (e._broken || e.stage !== 'guard' || e.event !== 'egress') continue
    if (!e.ticket) continue
    if (!byTicket.has(e.ticket)) byTicket.set(e.ticket, [])
    byTicket.get(e.ticket).push(e)
  }
  const found = []
  const forks = []
  for (const [ticket, list] of byTicket) {
    list.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    const digests = new Set(list.map((e) => e.digest).filter(Boolean))
    let expected = null
    for (const e of list) {
      const own = receiptDigest({
        prev: e.prev, ts: e.ts, ticket: e.ticket,
        sink: (e.egress || {}).sink, host: (e.egress || {}).host, ref: (e.egress || {}).ref, tree: e.tree,
      })
      if (!e.digest) {
        found.push({ ticket, file: e._file, why: 'расписка без digest — по ней нельзя проверить ни её саму, ни следующую' })
      } else if (own !== e.digest) {
        found.push({ ticket, file: e._file, why: `содержимое расписки не сходится с её digest (${e.digest}, посчитано ${own}) — запись правили после создания` })
      }
      // Первая расписка задачи ссылки не имеет — это норма, а не разрыв. Дальше спрашиваем
      // достижимость, а не порядок: `prev` обязан назвать существующую расписку этой же
      // задачи. Пусто там, где предшественник был, — вот это и есть находка.
      if (expected !== null) {
        if (!e.prev) {
          found.push({
            ticket,
            file: e._file,
            why: `расписка без prev, хотя предыдущие расписки задачи есть (${expected}) — цепочку начали заново, и всё, что было до неё, больше ничем не связано`,
          })
        } else if (!digests.has(e.prev)) {
          found.push({
            ticket,
            file: e._file,
            why: `prev=${e.prev} не принадлежит ни одной расписке этой задачи — предыдущую удалили`,
          })
        } else if (e.prev !== expected) {
          // Развилка: предшественник на месте, просто следом за ним пишут несколько.
          // Так работают параллельные деревья и две живые линии продукта. Это НЕ находка.
          forks.push({
            ticket,
            file: e._file,
            why: `prev=${e.prev} — та же расписка, за которой уже писали: параллельная запись, не разрыв`,
          })
        }
      }
      expected = e.digest || expected
    }
  }
  return { findings: found, forks }
}

function cmdDoctor(root, args) {
  const change = args.change || activeChange(root)
  const events = listEvents(root, { change })
  const broken = events.filter((e) => e._broken).map((e) => e._file)
  // listEvents уже достроил привязку по agent_id, так что сюда попадает только то,
  // что не восстанавливается вовсе. Восстановленное показываем отдельно: это норма,
  // но знать, сколько событий держится на этой связи, полезно.
  // Событие старта без тикета — дыра только если стадия УЖЕ закончилась и привязка так и
  // не восстановилась. Пока стадия идёт, тикет взять неоткуда по устройству момента
  // (см. resolveTickets), и кричать об этом — ложная тревога на каждом прогоне.
  const closedAgents = new Set(events.filter((e) => e.event !== 'started' && e.agent_id).map((e) => e.agent_id))
  const raw = events.filter((e) => e.ticket === 'unknown' && !e._broken)
  const pending = raw.filter((e) => e.event === 'started' && e.agent_id && !closedAgents.has(e.agent_id))
  // «Идёт сейчас» и «оборвалось» выглядят в журнале одинаково: старт без парного финиша.
  // Разделить их можно только по времени — парный финиш приходит минутами позже, а не
  // часами. Поэтому старт старше порога считаем оборванным: сессия упала, финиша не
  // будет никогда, и запись останется в списке навсегда. Это не ошибка и не повод
  // чистить журнал (он иммутабелен, ADR-0003) — но человек должен видеть разницу,
  // иначе «одна стадия висит» читается как «сборка идёт», хотя она давно кончилась.
  // Порог намеренно щедрый: стадия Разработчика на Opus идёт десятки минут, и объявлять
  // её оборванной раньше времени хуже, чем показать лишний час.
  // Вторая граница, мягкая. Шесть часов отвечают на вопрос «кончится ли это вообще»;
  // человеку нужен и другой ответ — «не застряла ли стадия прямо сейчас». Порог тут не
  // один на всех: он СВОЙ У КАЖДОЙ СТАДИИ и считается по журналу самого проекта
  // (`stageThresholds`), потому что 25 минут — норма для разработки и втрое выше нормы
  // для ревью. На `ok` список НЕ влияет — долгая стадия не поломка, а повод посмотреть.
  // Убивать её движок не может и не пытается: у agent() в Workflow нет ни таймаута, ни
  // отмены, а прерванная на середине стадия оставила бы недописанное рабочее дерево без
  // события финиша — хуже, чем дать ей доработать.
  const STALE_START_H = 6
  const thresholds = stageThresholds(events, readConfig(root) || {})
  const thresholdOf = (stage) => thresholds[stage] || thresholds._default
  const nowMs = Date.now()
  const ageH = (e) => (nowMs - Date.parse(e.ts || 0)) / 3600000
  const pendingFiles = pending.filter((e) => !(ageH(e) > STALE_START_H)).map((e) => e._file)
  const abandoned = pending
    .filter((e) => ageH(e) > STALE_START_H)
    .map((e) => `${e._file} (${Math.round(ageH(e))} ч назад — финиша не будет)`)
  const unknown = raw.filter((e) => !pending.includes(e)).map((e) => e._file)
  // Исправленные события в расчёт не идут, но показать их надо: иначе след ошибки есть,
  // а увидеть его нечем, и «в журнале 158 файлов, в тайминге 157» выглядит дырой.
  const corrected = listEvents(root, { change, includeCorrected: true })
    .filter((e) => e._corrected)
    .map((e) => e._file)
  const resolved = events.filter((e) => e._ticket_from === 'agent_id').length
  const resolvedLive = events.filter((e) => e._ticket_from === 'transcript').length
  const open = []
  const byTicket = new Map()
  for (const e of events) {
    if (!e.ticket || e._broken) continue
    if (!byTicket.has(e.ticket)) byTicket.set(e.ticket, [])
    byTicket.get(e.ticket).push(e)
  }
  byTicket.delete('unknown') // открытые стадии без привязки показываем отдельно, см. pending_binding
  for (const [ticket, evs] of byTicket) {
    let openStage = null
    let openAt = null
    for (const e of evs) {
      if (e.event === 'started') {
        openStage = e.stage
        openAt = e.ts
      } else if (openStage === e.stage) {
        openStage = null
        openAt = null
      }
    }
    if (openStage) open.push({ ticket, stage: openStage, ts: openAt })
  }
  // Брошенная ПРИВЯЗАННАЯ стадия. Поле `abandoned_starts` до 0.4.31 наполнялось только из
  // `pending` — то есть из стартов БЕЗ тикета. Привязанный старт туда не попадал никогда
  // и жил в `open_stages`, который на `ok` не влияет. Отсюда дефект обкатки на проект-В
  // 01.10.2026: четыре стадии висели сутками, `doctor` отвечал `ok: true`, доска держала
  // «слотов 3/3» при пустых ветках, а следующий прогон не находил ни одного слота.
  //
  // Критерий тот же, что для непривязанных, и других быть не может: «идёт» и
  // «оборвалось» в журнале выглядят одинаково, различает их только время. Старше шести
  // часов — финиша не будет.
  //
  // Движок закрывает это САМ только на словах: печатает готовую команду. Событие о
  // стадии, которой никто не наблюдал, он писать не вправе — это и есть граница
  // ADR-0002, и `abandon` стоит по ту её сторону, где решение принимает человек.
  const abandonedOpen = open
    .filter((o) => o.ts && ageH(o) > STALE_START_H)
    .map((o) => ({
      ticket: o.ticket,
      stage: o.stage,
      ts: o.ts,
      age_h: Math.round(ageH(o)),
      fix: `firm-event.mjs abandon --ticket ${o.ticket} --stage ${o.stage}`,
    }))
  // ЗАДАЧА, ВСТАВШАЯ НА ЗАКРЫТОЙ СТАДИИ. Открытых стадий у неё нет, и поэтому до 0.4.136
  // сказать о ней было нечему: `doctor` отвечал `ok: true`, `open_stages` и `long_running`
  // пусты, а задача стояла мёртвая. Так выглядела Д-72 у проект-В 10.11.2026: прогон падал
  // между Test и QA (запрещённое время в скрипте), три задачи прошли разработку и тесты,
  // `test/finished` записан штатно — и ничего не говорило, что продолжения не будет.
  //
  // Критерий тот же, что у брошенного старта, и порог тот же (шесть часов): «идёт» и
  // «оборвалось» в журнале различает только время. Разница в том, ЧТО названо: там —
  // стадия без финиша, здесь — финиш без следующей стадии.
  //
  // На `ok` не влияет: дыры в журнале нет, журнал как раз полон (ADR-0006), и лечится это
  // не исправляющим событием, а новым прогоном. Но назвать обязан — иначе мёртвая задача
  // неотличима от идущей, а это ровно И-12: «не знаю» не равно «соблюдено».
  // Что считается ТЕРМИНАЛЬНЫМ — берём у того же словаря статусов, что доска и
  // планировщик (`statusFromEvents`), а не вторым списком имён. Замер проект-В 10.11.2026
  // показал цену второго словаря ровно на этом месте: я написал в своём наборе `merged`,
  // которого в журнале нет (стадия `merge`, событие `finished`), и 28 ВЛИТЫХ задач уехали
  // в находки — «T-395 стоит 12 ч и ничем не занята» про влитую задачу верно буквально и
  // бессмысленно по делу.
  const TERMINAL_STATUS = new Set(['merged', 'released', 'superseded', 'cancelled'])
  // Терминальное СОБЫТИЕ сверх статуса: эскалация ждёт человека по замыслу (ADR-0009), а
  // `abandoned` возвращает задачу в «не начата» — стоять ей и положено.
  const TERMINAL_EV = new Set(['escalated', 'abandoned', 'cancelled', 'superseded'])
  // `guard` — НЕ СТАДИЯ, и это главное различение всей находки. Сторож срабатывает посреди
  // чужой стадии и её не закрывает: «стадия guard закрыта (long-wait), следующая не
  // начиналась» описывает не то, что произошло. 45 записей из 82 у проект-В были такими.
  // Два исключения, и оба по делу: `stage-call-failed` означает, что несущая стадия как раз
  // умерла (именно им опознались три настоящие жертвы Д-72), а `short-lane` — вердикт
  // правила движка, то есть настоящее слово о задаче.
  const GUARD_SAYS = new Set(['stage-call-failed', 'short-lane'])
  const stalled = []
  for (const [ticket, evs] of byTicket) {
    // `G-` — тема разведки, а не задача поставки (ADR-0012): у неё нет ни стадий цикла, ни
    // слияния, и «стоит 418 ч» про тему верно всегда.
    if (ticket === 'MR' || ticket === 'unknown' || /^G-/.test(ticket)) continue
    if (open.some((o) => o.ticket === ticket)) continue
    if (TERMINAL_STATUS.has(statusFromEvents(evs).status)) continue
    // Последнее СЛОВО о задаче, а не последняя запись. `retracted` — исправляющее событие
    // (ADR-0006): им гасят ошибочную запись, и последним словом оно не бывает никогда,
    // иначе исправление превращает влитую задачу в подвисшую.
    const said = evs.filter(
      (e) => e.event !== 'retracted' && !(e.stage === 'guard' && !GUARD_SAYS.has(e.event)),
    )
    const last = said[said.length - 1]
    if (!last || !last.ts) continue
    if (TERMINAL_EV.has(last.event)) continue
    if (!(ageH(last) > STALE_START_H)) continue
    stalled.push({
      ticket,
      last_stage: last.stage || '?',
      last_event: last.event || '?',
      ts: last.ts,
      age_h: Math.round(ageH(last)),
      why: `стадия ${last.stage || '?'} закрыта (${last.event || '?'}), следующая не начиналась — ` +
        `задача стоит ${Math.round(ageH(last))} ч и ничем не занята`,
      fix: 'продолжить задачу новым прогоном /firm-build либо закрыть решением человека ' +
        `(firm-event.mjs record --ticket ${ticket} --stage lifecycle --event blocked --notes "<причина>")`,
    })
  }
  // Долго идущие стадии считаем по ОБОИМ спискам: привязанные стадии в `open`,
  // непривязанные — в `pending`. С 0.4.12 старт заявляет тикет сам, и почти всё
  // попадает в первый; но если рантайм не дал идентификатор агента, стадия останется
  // во втором, а застревать она умеет одинаково.
  const openLive = open.filter((o) => !(o.ts && ageH(o) > STALE_START_H))
  const longRunning = [
    ...openLive.map((o) => ({ ticket: o.ticket, stage: o.stage, ts: o.ts })),
    ...pending.map((e) => ({ ticket: 'не привязана', stage: e.stage || '?', ts: e.ts })),
  ]
    .filter((o) => o.ts && ageH(o) * 60 > thresholdOf(o.stage).min && !(ageH(o) > STALE_START_H))
    // Подсказку про `abandon` даём уже здесь, на мягком пороге, а не только на шести
    // часах. Человек, снявший прогон, знает про свои стадии то, чего движок знать не
    // может, — и ему нужен рычаг сразу, а не через пять часов ожидания жёсткого порога.
    // Формулировка условная нарочно: «если прогон снят», а не «стадия брошена». Долгая
    // стадия сама по себе не поломка, и объявлять её брошенной движок права не имеет.
    .map((o) =>
      `${o.ticket} · ${o.stage} — ${Math.round(ageH(o) * 60)} мин ` +
      `(порог ${thresholdOf(o.stage).min}, ${thresholdOf(o.stage).source})` +
      (o.ticket === 'не привязана'
        ? ''
        : `; если прогон снят — firm-event.mjs abandon --ticket ${o.ticket} --stage ${o.stage}`),
    )
  // Отказавшее слияние. Событие merge/failed стадия пишет сама, но статус задачи от него
  // не меняется (принята, но не влита) — значит по доске этого не видно. Показываем те
  // задачи, у которых ПОСЛЕДНЕЕ событие слияния — отказ: повторная удачная попытка
  // снимает вопрос, а нерешённый отказ останавливает поставку, поэтому он влияет на ok.
  // Провалившееся слияние — находка, и она краснит `ok`: пока оно не разобрано, задача не
  // влита, а зависимые от неё стоят. Но у задачи, СНЯТОЙ решением человека после этого
  // отказа, разбирать уже нечего: слияния не было и не будет, потому что задачу заменили
  // или отменили. Это тот же довод, что у второй страховки Д-29 (сверка не дописывает
  // «влито» задаче с терминальным статусом), и без него `doctor` краснеет навсегда — на
  // проект-В 01.11.2026 ровно так висел `T-181`, снятый человеком через четыре часа после
  // отказа слияния. Решение человека — последнее слово (ADR-0001), и спорить с ним
  // сверке нечем.
  // ПОПРАВКА 05.11.2026 (отчёт проект-В, дефект 2). Терминальность выводится из СОБЫТИЙ, а
  // не из доски, и вот почему это не вкусовщина. Доска строится только по названной
  // поставке, поэтому `change ? … : []` означало: у безадресного `doctor` терминальных
  // задач НОЛЬ. Замер на журнале проект-В: `doctor` без ключа — `failed_merges: [T-171,
  // T-181]`, `ok: false`; `doctor --change 2026-10-23-game-redesign` — `failed_merges: []`
  // и обе задачи в `failed_merges_closed` со словами «решение человека». То есть ответ
  // сверки зависел от аргумента, которого человеку взять негде: поставка заархивирована,
  // `active_change` равен null и другим уже не станет, а имя мёртвой поставки надо знать
  // наизусть.
  //
  // И снять находку было нечем — та же форма, что у развилки расписок: исправляющее
  // событие здесь было бы ЛОЖЬЮ (слияние действительно падало, событие верное), а решение
  // человека о замене в журнале есть и спорить с ним сверке нечем (ADR-0001). Статус
  // считается тем же `statusFromEvents`, что и у доски, — значит безадресный ответ сходится
  // с адресным по построению, а не по совпадению.
  const terminalByHuman = new Set(
    [...byTicket.entries()]
      .filter(([, evs]) => ['superseded', 'cancelled'].includes(statusFromEvents(evs).status))
      .map(([ticket]) => ticket),
  )
  const failedMerge = []
  const failedMergeClosed = []
  // Отчёт о ПОПЫТКЕ, опоздавший за состоявшееся слияние, находкой не считается (Д-67,
  // отчёт проект-В 09.11.2026). Трижды за вечер шаг слияния дописывал своё «не влито» после
  // того, как Оркестратор довёл мерж руками, — и `doctor` краснел `failed_merges` при
  // влитой задаче, а `accepted_not_merged` одновременно спрашивал, не влили ли её мимо
  // правил. Оба события правдивы, спорить с ними нечем; неверным было ЧТЕНИЕ — «последнее
  // слово» вместо доказательства слияния (ADR-0005).
  for (const [ticket, evs] of byTicket) {
    const lastMerge = [...evs].reverse().find((e) => e.stage === 'merge')
    if (lastMerge && lastMerge.event === 'failed') {
      const row = { ticket, ts: lastMerge.ts, notes: lastMerge.notes || lastMerge.note || '' }
      const mergedEv = evs.find((e) => e.stage === 'merge' && e.event === 'finished' && !e._broken)
      if (mergedEv) {
        failedMergeClosed.push({
          ...row,
          closed_by: 'слияние состоялось',
          merged_ts: mergedEv.ts,
          why:
            'отчёт о неудачной ПОПЫТКЕ записан после состоявшегося слияния (гонка двух перьев: ' +
            'шаг слияния пишет свой итог, а мерж в это время доводит человек). Оба события ' +
            'правдивы, исправляющего не нужно: влито подтверждается вторым родителем мерж-коммита ' +
            '(ADR-0005), а не последним словом журнала.',
        })
      } else if (terminalByHuman.has(ticket)) failedMergeClosed.push({ ...row, closed_by: 'решение человека' })
      else failedMerge.push(row)
    }
  }
  const impossible = journalInvariants(root, change, listEvents(root, { change, includeCorrected: false }))
  const board = change ? computeBoard(root, change, { parallelism: parallelismOf(root) }) : { tasks: [] }
  // Принята, но не влита — ВОПРОС, а не находка, и потому на `ok` не влияет.
  //
  // Состояние законное: между вердиктом ревью и слиянием задача живёт в нём на каждом
  // прогоне, и красный `doctor` здесь означал бы красный `doctor` всегда — то есть
  // бесполезный. Но названным оно быть обязано, и вот почему: слияние, сделанное вручную
  // через `--ff` или rebase, движок не видит в принципе. В графе такая ветка неотличима
  // от только что созданной на вершине поставки — ни мерж-коммита, ни своих коммитов;
  // проверено, `git cherry` молчит в обоих случаях. Выдумать ответ движок не вправе
  // (ADR-0007), поэтому он показывает, что знает, и спрашивает человека.
  //
  // Поле `in_delivery` и есть то, что он знает: своих коммитов относительно поставки у
  // ветки нет. Для только что созданной ветки это тоже верно — отсюда и вопрос, а не
  // утверждение.
  const acceptedNotMerged = board.tasks
    .filter((t) => t.status === 'accepted')
    .map((t) => {
      const own = gitLines(root, ['rev-list', '--count', `feature/${change}..task/${t.id}`])[0]
      return {
        ticket: t.id,
        branch: gitLines(root, ['rev-parse', '--verify', `task/${t.id}`]).length ? `task/${t.id}` : null,
        in_delivery: own === '0',
        question:
          own === '0'
            ? 'содержимое ветки уже в поставке, а события слияния нет — её влили мимо правил ' +
              `движка (--no-ff)? если да: firm-event.mjs record --ticket ${t.id} --stage merge ` +
              '--event finished --actor human --notes "влито вручную"'
            : 'ждёт слияния',
      }
    })
  // Расхождение кэша называется ВМЕСТЕ С ПРИЧИНОЙ, иначе `doctor` и `sync` выглядят
  // спорящими: первый находит расхождение, второй отвечает `fixed: []` — и человек читает
  // это как «лечить отказался», хотя патч отложен и причина у него названа (Д-33, разбор
  // проект-В 31.10.2026: автор отчёта смотрел `fixed` и не видел `deferred`).
  const staleFlight = inFlightTickets(root)
  const stale = board.tasks.filter((t) => t.cache_stale).map((t) => {
    const head = `${t.id}: в файле «${t.cached_status}», в журнале «${t.status}»`
    if (t.path.includes(`${sep}archive${sep}`)) return `${head} — архивный снимок, не правится (иммутабелен)`
    if (!staleFlight) return `${head} — git не ответил про рабочие деревья, патч отложен целиком`
    if (staleFlight.has(t.id)) return `${head} — дерево задачи живо, патч отложен до слияния: sync`
    return `${head} — патчится следующим sync`
  })
  // События, у которых движок сам обрезал `notes` (Д-26). На `ok` НЕ влияет: это не дыра в
  // журнале — журнал честно говорит, что знает не всё, и говорит это полем. Но назвать
  // обязан: предел в 60 000 символов нормальный разбор не задевает, и если он сработал,
  // значит роль вывалила в журнал что-то ненормальное — лог прогона, дамп, дифф целиком.
  const truncated = listEvents(root, { change })
    .filter((e) => e.notes_truncated)
    .map((e) => `${e.ticket} ${e.stage}/${e.event}: оставлено ${String(e.notes || '').length} из ${e.notes_full_chars}`)
  // Один номер задачи в двух живых поставках. Журнал на проект один, тикет в нём —
  // ключ, так что такие задачи склеятся: доска покажет чужие стадии, а привязка при
  // этом формально исправна, и больше её поймать негде. Поэтому это влияет на ok.
  const dups = duplicateIds(root)
  // Баги, привязанные к задаче, которой больше нет в работе. Связь односторонняя: у бага
  // есть `fix_task` и `tickets`, у задачи ссылок на баги нет. Когда задачу заменяют,
  // обе ссылки указывают в никуда, а баг остаётся открытым — получается баг без
  // исполнителя при живых задачах-заменах (наблюдено 24.09.2026 на T-106f2 → T-112/T-113).
  // Перевесить автоматически нельзя: какая из замен чинит какой баг — решение Архитектора.
  // Движок находит и называет кандидатов, решает человек.
  const terminal = new Map(
    board.tasks.filter((t) => t.status === 'superseded' || t.status === 'cancelled').map((t) => [t.id, t]),
  )
  const bugsOnTerminal = []
  if (terminal.size) {
    for (const b of listBugs(root)) {
      if (!b.open) continue
      // Один и тот же id обычно стоит и в fix_task, и в tickets — считаем его один раз.
      const refs = [...new Set([b.fix_task, ...(b.tickets || [])].filter(Boolean))].filter((x) => terminal.has(x))
      if (!refs.length) continue
      const hint = [...new Set(refs.flatMap((id) => terminal.get(id).superseded_by || []))]
      bugsOnTerminal.push(
        `${b.id}: ссылается на ${refs.join(', ')}` + (hint.length ? ` — перевесить на ${hint.join(', ')}?` : ''),
      )
    }
  }
  // ── Приписка не туда: событие лежит в чужой поставке ───────────────────────
  // `doctor` фильтрует события по поставке — а дыра бывает ИМЕННО в поле поставки, и тогда
  // он слеп по построению: чего нет в выборке, того он не видит. Так и вышло на проект-В
  // 11.10.2026 (Д-2): три стадии шли, их события лежали в соседней поставке, а `doctor`
  // по «своей» отвечал `ok: true` со всеми списками пустыми. Это снимало последнюю защиту
  // от Д-1 — инструкция сборки учит доверять именно этому ответу и чинить привязку до
  // запуска.
  //
  // Поэтому проверка идёт по ВСЕМ событиям, без фильтра по поставке, и сравнивает поле
  // события с тем, какой поставке принадлежит его задача. Это не догадка: задачи лежат в
  // файлах поставок, связь однозначна. Архивных поставок проверка не касается — их имени
  // в `changes/` уже нет, и утверждать про такие события нечего.
  const pinFindings = activeChangeFindings(root)
  const changeOfTicket = new Map()
  for (const c of listChanges(root)) for (const task of listTasks(root, c)) changeOfTicket.set(task.id, c)
  const misfiled = listEvents(root)
    .filter(
      (e) =>
        !e._broken && e.change && isBoundTicket(e.ticket) &&
        changeOfTicket.has(e.ticket) && changeOfTicket.get(e.ticket) !== e.change,
    )
    .map((e) => `${e._file}: записано «${e.change}», а ${e.ticket} принадлежит «${changeOfTicket.get(e.ticket)}»`)

  // Расписка о ревью, разошедшаяся с влитым (И-13, ADR-0013). На `ok` влияет: это не
  // вопрос без ответа, а доказанное расхождение — содержимое в поставке, которого надзор
  // не видел. На старых событиях без поля `tree` список пуст по построению, поэтому
  // версия не красит `doctor` на живых проектах задним числом.
  const staleReceiptsFound = staleReceipts(root, change, events)
  // Разрыв цепочки расписок об отправке (И-14, ADR-0014). Считается по ВСЕМ событиям, без
  // фильтра по поставке: отправка уровня поставки (`ticket: MR`) идёт и между поставками,
  // и привязать её к одной из них не к чему.
  const { findings: egressFindings, forks: egressForks } = egressChain(root, change, listEvents(root))
  // ── MR-ревью, закрытое без вердикта ───────────────────────────────────────
  // Вердикт ревью движок берёт из structured output роли (см. verdictFrom выше) — а у
  // ревью ПОСТАВКИ его нет: задачное ревью зовёт сборщик со схемой, а ревью всего диффа
  // запускает текст команды (`/firm-build` §4), и схемы там не просили вовсе. Следствие
  // замерено по проект-В 23.10.2026: все семь событий MR-ревью с 03.10 легли как
  // `review/finished` с пустыми `notes` — то есть за шесть поставок вердикт по диффу
  // целиком не попал в журнал ни разу, и доказательства приёмки у поставки нет.
  //
  // С 0.4.99 вердикт пишет сам Оркестратор (`record --ticket MR --stage review --event
  // accepted|rejected`), а это — сеть под ним: закрытая стадия без вердикта называется
  // вслух. На `ok` НЕ влияет намеренно: журнал неизменяем (ADR-0006), и прошлые поставки
  // иначе краснили бы сверку навсегда, а починить их нечем — вердикт уже не вернуть.
  const mrReview = events.filter((e) => e.ticket === 'MR' && e.stage === 'review' && !e._broken)
  const mrClosed = mrReview.filter((e) => e.event === 'finished')
  const mrVerdict = mrReview.filter((e) => ['accepted', 'rejected', 'escalated'].includes(e.event))
  const mrWithoutVerdict = mrClosed.length && !mrVerdict.length
    ? mrClosed.map((e) => `${e._file}: стадия закрыта, вердикта нет — записать его событием: ` +
        'firm-event.mjs record --ticket MR --stage review --event accepted|rejected --notes "<вердикт>"')
    : []

  print(args, {
    ok:
      broken.length === 0 && unknown.length === 0 && failedMerge.length === 0 && dups.length === 0 &&
      bugsOnTerminal.length === 0 && abandonedOpen.length === 0 && impossible.length === 0 &&
      misfiled.length === 0 && pinFindings.length === 0 && staleReceiptsFound.length === 0 &&
      egressFindings.length === 0,
    change,
    stale_receipts: staleReceiptsFound,
    egress_chain: egressFindings,
    // Развилки цепочки расписок — НАБЛЮДЕНИЕ, не находка: на `ok` не влияют. За одной
    // распиской пишут несколько, потому что деревьев и живых линий несколько, и задача
    // `MR` принадлежит всей поставке сразу. Замер проект-В 05.11.2026: 4 развилки на 120
    // расписок `MR` и ни одной ссылки в пустоту — до этой правки все четыре числились
    // разрывом, снять который нечем (журнал неизменяем).
    egress_forks: egressForks,
    // Вопрос, а не находка: на `ok` не влияет (см. выше, про неизменяемый журнал).
    mr_review_without_verdict: mrWithoutVerdict,
    // Закреплённая поставка, которой нет. На `ok` влияет, и это не строгость: пока ключ
    // назвал несуществующее имя, активная поставка НЕ определена — а значит и этот ответ
    // `doctor` не про ту поставку, про которую думает человек.
    active_change_findings: pinFindings,
    // Событие в чужой поставке. Чинится как любая ошибка журнала — исправляющим событием
    // (`record --corrects <файл> --ts <исходное время> …`), а не правкой файла: ADR-0006.
    misfiled,
    impossible_events: impossible,
    broken,
    unknown,
    pending_binding: pendingFiles,
    abandoned_starts: abandoned,
    abandoned_stages: abandonedOpen,
    long_running: longRunning,
    // Задачи, вставшие на закрытой стадии: прогон их больше не ведёт, а терминального
    // события у них нет. См. довод выше — на `ok` не влияет, но молчать об этом нельзя.
    stalled_tickets: stalled,
    // Несоответствие секции `vcs` настоящему репозиторию. На `ok` НЕ влияет: это не дыра
    // в журнале (И-1…И-12 тут ни при чём), а обещание конфига, которое некому сдержать.
    // Останавливать из-за него сборку движок права не имеет — но назвать обязан заранее,
    // а не на шаге выдачи.
    vcs: vcsFindings(root, readConfig(root) || {}),
    // Расхождение записанной версии движка с фактической. На `ok` НЕ влияет по тому же
    // доводу, что и `vcs`: это не дыра в журнале. Но молчать о нём нельзя — `/firm-adopt`
    // обновляет ещё и копии git-хуков в `.git/hooks`, которых не доставляет
    // ни `/plugin update`, ни подъём версии. Разбор проект-В 11.10.2026 (Д-7): расхождение
    // в три версии висело всю сборку, и узнать о нём можно было только спросив `phase`.
    engine_version: engineVersionFindings(root, readConfig(root) || {}),
    corrected,
    // Двойной счёт токенов. ВОПРОС, а не находка: на `ok` не влияет. Лишний финиш — это
    // настоящее событие рантайма, а не поломка журнала, и чинится он чтением (`tokenUse`
    // берёт по заходу максимум, а не сумму). Поле здесь, чтобы расхождение числа на
    // дашборде с наивной суммой по файлам имело имя.
    //
    // Отдаётся СВОДКОЙ, а не массивом строк (отчёт проект-В 03.11.2026, находка 3): голый
    // массив с полем `inflated_by` прочитали как доказательство, что учёт раздут на 1,25
    // миллиарда, хотя дедупликация стоит в читателе с 25.10.2026. Ответ теперь лежит в
    // том же объекте, что и числа, — иначе его негде взять, кроме кода.
    duplicate_finishes: duplicateFinishSummary(listEvents(root, { change })),
    resolved_by_agent_id: resolved,
    resolved_by_transcript: resolvedLive,
    open_stages: openLive,
    failed_merges: failedMerge,
    // Отказы слияния, снятые решением человека: на `ok` не влияют, но показаны — иначе
    // след отказа исчезает, и история задачи читается как «слияние просто не случилось».
    failed_merges_closed: failedMergeClosed,
    accepted_not_merged: acceptedNotMerged,
    stale_cache: stale,
    // Несведённый индекс главного дерева. На `ok` НЕ влияет — это не дыра в журнале, —
    // но назван до запуска: при нём git не начнёт ни одного слияния, и упадёт оно с
    // именем ПЕРВОЙ задачи следующей волны, а не того кармана, который его оставил
    // (Д-34, проект-В 31.10.2026: дважды упало слияние T-211 из-за файла T-213).
    unmerged_index: unmergedPaths(root) || [],
    truncated_notes: truncated,
    duplicate_ids: dups,
    bugs_on_terminal_tasks: bugsOnTerminal,
  })
}

function print(args, obj) {
  if (args.json) {
    process.stdout.write(JSON.stringify(obj, null, 1) + '\n')
    return
  }
  process.stdout.write(summarize(obj) + '\n')
}

function summarize(o) {
  if (o.event) {
    const e = o.event
    return `[firm2] ${e.ticket} ${e.stage}/${e.event}${e.attempt > 1 ? ` (попытка ${e.attempt})` : ''} → ${o.path}`
  }
  return JSON.stringify(o, null, 1)
}

// ── Точка входа ───────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2))
// Неизвестный флаг — отказ, а не умолчание (Д-61): правило одно на все CLI движка.
requireKnownFlags(process.argv.slice(2), ['actor', 'agent_id', 'attempt', 'change', 'corrects', 'epic', 'event', 'event_name', 'git_sha', 'notes', 'run_id', 'stage', 'ticket', 'ts'], { cmd: 'firm-event.mjs' })
const cmd = args._[0] || 'help'
const root = args.root ? String(args.root) : repoRoot()

try {
  switch (cmd) {
    case 'record': cmdRecord(root, args); break
    case 'claim': cmdClaim(root, args); break
    case 'abandon': cmdAbandon(root, args); break
    case 'hook': cmdHook(root, args); break
    case 'release': cmdRelease(root, args); break
    case 'sync': cmdSync(root, args); break
    case 'dashboard': cmdDashboard(root, args); break
    case 'doctor': cmdDoctor(root, args); break
    default:
      process.stdout.write(
        [
          'firm-event — журнал переходов firm2',
          '',
          '  record --ticket T-003 --stage dev --event started [--change X] [--actor R] [--attempt N] [--run-id ID] [--notes "…"]',
          '  claim  --ticket T-003 --stage dev [--agent-id ID] [--attempt N]',
          '  abandon --ticket T-003 [--stage dev] [--notes "..."]',
          '                 закрыть стадию, брошенную снятым прогоном (финиша не будет)',
          '  record ... --corrects <файл[,файл…]> --notes "почему"',
          '                 исправить ошибочно записанные события новым (журнал не правится;',
          '                 счёт токенов и агент переносятся из исправляемого);',
          '                 чтобы просто аннулировать, не добавляя ничего взамен —',
          '                 --event retracted',
          '  hook   (payload хука на stdin; вызывается из hooks/stage-event.sh)',
          '  release --change X         событие выпуска всем задачам поставки',
        '  sync   [--change X]        пересчитать кэш статусов + дашборд',
          '  dashboard [--change X]     пересобрать дашборд',
          '  doctor [--change X]        найти дыры в журнале',
          '',
          'Флаг --json — машинный вывод.',
        ].join('\n') + '\n',
      )
  }
} catch (e) {
  process.stderr.write(`[firm-event] сбой: ${e.stack || e.message}\n`)
  process.exit(1)
}
