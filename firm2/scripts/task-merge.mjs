#!/usr/bin/env node
// Конфликт файла задачи — класс, который движок создаёт сам, и разрешать его должен он же.
//
// Отчёт проект-В 08.11.2026 (Д-56). За одну поставку слияние встало СЕМЬ раз (T-341, T-346,
// T-347, T-353, T-363, T-344, T-364), и все семь — один и тот же класс: конфликтующий файл
// один, `openspec/changes/<поставка>/tasks/T-XXX.md`. Роль в дереве задачи дописывает в
// конец файла свой раздел (протокол живой проверки, протокол тестировщика), роль в главном
// дереве — свой (раздел доработки по записи о дефекте, переписанные критерии после
// арбитража). Оба добавления идут в конец, после одного и того же абзаца, и git их не
// сводит в принципе: для него это две конкурирующие вставки в одну точку.
//
// Ни одна сторона при этом не ошиблась. Файл задачи append-only по замыслу (ADR-0006), а
// разделение труда «стадия пишет протокол, Архитектор пишет доработку» предписано
// маршрутом. То есть конфликт встроен в устройство, и «быть внимательнее» его не лечит.
// Шаг слияния честно останавливался (решение по содержимому не его, ADR-0009) — но каждая
// остановка останавливала ВОЛНУ и требовала Оркестратора. Семь остановок за поставку.
//
// Что делает этот скрипт. Разрешает ровно тот класс, в котором решения по содержимому НЕТ:
// обе стороны только ДОПИСАЛИ, ничего не тронув выше. Тогда ответ — не выбор, а правило:
// общее начало плюс оба дописанных куска в хронологическом порядке (что написано раньше,
// то выше; порядок берётся у времени коммитов, а не у ощущения). Ни одна строка не
// теряется, и судить тут нечего.
//
// Чего он НЕ делает, и это важнее того, что делает:
//   • не трогает ничего за пределами каталога задач поставки;
//   • отказывается, если хоть одна сторона ПРАВИЛА написанное выше (общее начало перестало
//     быть началом): там уже есть выбор, а выбор — человеку (ADR-0009);
//   • не коммитит и не продолжает слияние: он готовит файл и ставит его в индекс, а
//     решение «слияние состоялось» остаётся за шагом слияния и его доказательством
//     (второй родитель мерж-коммита, ADR-0005).
//
// Пустая сторона — не ошибка, но и не молчание: у T-363 сторона поставки была пуста, и это
// надо было УВИДЕТЬ, а не взять слепо. Такой файл разрешается (терять нечего), но скрипт
// говорит об этом полем, а не прозой.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot, unmergedPaths, requireKnownFlags} from './lib/firm.mjs'

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
const root = args.root ? String(args.root) : repoRoot()

// Каждый вызов git адресует дерево явным `-C`: унаследованное окружение git врёт про чужое
// дерево, и снято оно в `lib/firm.mjs` на весь процесс (отчёт проект-В 03.11.2026).
function git(...a) {
  return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function gitOrNull(...a) {
  try {
    return git(...a)
  } catch {
    return null
  }
}

// Содержимое стороны из индекса конфликта: 1 — общее начало (база), 2 — наше (ветка
// поставки), 3 — пришедшее (ветка задачи). Ступени нет — значит сторона файла не имела.
function stage(n, path) {
  return gitOrNull('show', `:${n}:${path}`)
}

// Хронология сторон — по времени последнего коммита, тронувшего этот файл на каждой стороне.
// Спрашиваем git, а не считаем по порядку разделов: «что написано раньше» — факт истории.
function sideTime(ref, path) {
  const out = gitOrNull('log', '-1', '--format=%cI', ref, '--', path)
  const t = out && Date.parse(out.trim())
  return t || null
}

function isTaskFile(path, change) {
  const re = change
    ? new RegExp(`^openspec/changes/${change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/tasks/[^/]+\\.md$`)
    : /^openspec\/changes\/[^/]+\/tasks\/[^/]+\.md$/
  return re.test(path)
}

function resolveOne(path) {
  const base = stage(1, path)
  const ours = stage(2, path)
  const theirs = stage(3, path)
  if (ours === null || theirs === null) {
    return {
      path,
      resolved: false,
      why:
        'одна из сторон файла не имеет вовсе (добавлен против удалённого или наоборот). ' +
        'Это не дописывание, а решение о судьбе файла — оно человеку.',
    }
  }
  // База может отсутствовать: обе стороны завели файл независимо. Дописыванием это остаётся
  // (общее начало просто пусто), и терять по-прежнему нечего.
  const common = base === null ? '' : base
  if (!ours.startsWith(common) || !theirs.startsWith(common)) {
    // Прежде здесь был отказ, и для второго класса конфликта он оказался преждевременным
    // (Д-68, отчёт проект-В 09.11.2026): три задачи подряд дали один и тот же случай — в ветке
    // поставки раздел «Замечания» (дописал Архитектор, разбирая эскалацию), в ветке задачи
    // «Протокол проверки» (дописал исполнитель). Заголовки РАЗНЫЕ, общих строк не тронул
    // никто — а строчный признак видел замену, потому что дерево задачи стояло на коммите ДО
    // правки Архитектора, и его сторона «переписала» то, чего у неё не было.
    //
    // Поэтому вторая попытка, уровнем выше строк: разделами.
    const bySection = resolveBySections(path, common, ours, theirs)
    if (bySection) return bySection
    return {
      path,
      resolved: false,
      why:
        'сторона ПРАВИЛА написанное выше — общее начало перестало быть началом, и разделами ' +
        'это тоже не сводится (общий раздел изменён, или один заголовок дописан с двух ' +
        'сторон). Здесь есть выбор между версиями, а выбор по содержимому движок не делает ' +
        '(ADR-0009).',
    }
  }
  const addOurs = ours.slice(common.length)
  const addTheirs = theirs.slice(common.length)
  // Один и тот же заголовок, дописанный С ДВУХ сторон, строчным правилом сводить нельзя:
  // получится файл, где один раздел сказан дважды и с разным содержимым — то самое двойное
  // объявление, которое сверка границ считает находкой (F-048). Это выбор, и он человеку.
  const headsOf = (text) => (String(text).match(/^##\s+\S.*$/gm) || []).map((x) => x.trim())
  const clashHeads = headsOf(addOurs).filter((h) => headsOf(addTheirs).includes(h))
  if (clashHeads.length) {
    return {
      path,
      resolved: false,
      why:
        `один и тот же раздел дописан с двух сторон (${clashHeads.join(', ')}) — свести значит ` +
        'либо выбрать версию, либо сказать одно дважды. Выбор по содержимому движок не делает ' +
        '(ADR-0009), а двойное объявление само по себе находка (F-048).',
    }
  }
  const tOurs = sideTime('HEAD', path)
  const tTheirs = sideTime('MERGE_HEAD', path)
  // Хронология неизвестна (нет MERGE_HEAD, файл не тронут коммитом) — кладём сторону
  // поставки первой и говорим об этом: порядок назван, а не угадан молча.
  const oursFirst = tOurs !== null && tTheirs !== null ? tOurs <= tTheirs : true
  const first = oursFirst ? addOurs : addTheirs
  const second = oursFirst ? addTheirs : addOurs
  const text = common + first + second
  writeFileSync(join(root, path), text, 'utf8')
  git('add', '--', path)
  return {
    path,
    resolved: true,
    order: oursFirst ? 'поставка → задача' : 'задача → поставка',
    order_known: tOurs !== null && tTheirs !== null,
    added_chars: { delivery: addOurs.length, task: addTheirs.length },
    one_side_empty: addOurs.length === 0 || addTheirs.length === 0,
    why:
      'обе стороны только дописали; собрано общее начало плюс оба куска в хронологическом ' +
      'порядке — ни одна строка не потеряна' +
      (addOurs.length === 0 ? '. СТОРОНА ПОСТАВКИ ПУСТА — посмотри, так ли это задумано (у T-363 так и было)' : '') +
      (addTheirs.length === 0 ? '. СТОРОНА ЗАДАЧИ ПУСТА — посмотри, так ли это задумано' : ''),
  }
}

// Разбор файла на преамбулу и разделы второго уровня. Заголовок — строка, начинающаяся с
// «## »: ровно та форма, которой пишут протоколы и замечания в файле задачи. Третий уровень
// и глубже остаётся ВНУТРИ своего раздела и отдельной единицей не считается — иначе
// объединение начало бы перекладывать подпункты между разделами.
function splitSections(text) {
  const lines = String(text).split('\n')
  const pre = []
  const out = []
  let cur = null
  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      if (cur) out.push(cur)
      cur = { head: line.trim(), lines: [line] }
      continue
    }
    if (cur) cur.lines.push(line)
    else pre.push(line)
  }
  if (cur) out.push(cur)
  return { pre: pre.join('\n'), sections: out.map((x) => ({ head: x.head, text: x.lines.join('\n') })) }
}

// Сведение разделами. Разрешается РОВНО тот случай, в котором выбора по содержимому нет:
// преамбула у сторон одна и та же, все общие с базой разделы не тронуты ни одной стороной, а
// новое у каждой — свои заголовки, которых у другой нет. Тогда ответ — объединение: база
// плюс добавленное поставкой плюс добавленное задачей, в порядке появления.
//
// Отказ (возврат null, а решение зовущему) в трёх случаях, и каждый — настоящий выбор:
//   • преамбула разошлась: кто-то правил написанное выше разделов;
//   • общий раздел изменён одной из сторон: это правка чужого текста, а не дописывание;
//   • один и тот же заголовок дописан С ДВУХ сторон: содержимое надо выбирать или сливать.
function resolveBySections(path, common, ours, theirs) {
  const b = splitSections(common)
  const o = splitSections(ours)
  const t = splitSections(theirs)
  if (o.pre !== b.pre || t.pre !== b.pre) return null
  const byHead = (list) => new Map(list.map((x) => [x.head, x.text]))
  const bm = byHead(b.sections)
  const om = byHead(o.sections)
  const tm = byHead(t.sections)
  // Общий раздел, ИЗМЕНЁННЫЙ стороной, — выбор между версиями, и он человеку.
  //
  // А вот раздел, которого у стороны НЕТ ВОВСЕ, удалением не считается, и это не поблажка:
  // файл задачи append-only по замыслу (ADR-0006), то есть разделы в нём не снимают. Так
  // выглядит сторона, закоммиченная из дерева, которое стояло на коммите ДО правки соседа —
  // ровно случай проект-В (Д-68). Берём базовую версию: ни одна строка не теряется.
  for (const [head, text] of bm) {
    if (om.has(head) && om.get(head) !== text) return null
    if (tm.has(head) && tm.get(head) !== text) return null
  }
  const addedOurs = o.sections.filter((x) => !bm.has(x.head))
  const addedTheirs = t.sections.filter((x) => !bm.has(x.head))
  if (!addedOurs.length && !addedTheirs.length) return null
  // Один заголовок с двух сторон — выбор, и он человеку.
  const clash = addedOurs.filter((x) => tm.has(x.head)).map((x) => x.head)
  if (clash.length) return null
  const tOurs = sideTime('HEAD', path)
  const tTheirs = sideTime('MERGE_HEAD', path)
  const oursFirst = tOurs !== null && tTheirs !== null ? tOurs <= tTheirs : true
  const first = oursFirst ? addedOurs : addedTheirs
  const second = oursFirst ? addedTheirs : addedOurs
  const parts = [b.pre, ...b.sections.map((x) => x.text), ...first.map((x) => x.text), ...second.map((x) => x.text)]
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n')
  writeFileSync(join(root, path), text.endsWith('\n') ? text : text + '\n', 'utf8')
  git('add', '--', path)
  return {
    path,
    resolved: true,
    by: 'разделы',
    order: oursFirst ? 'поставка → задача' : 'задача → поставка',
    order_known: tOurs !== null && tTheirs !== null,
    added_sections: {
      delivery: addedOurs.map((x) => x.head),
      task: addedTheirs.map((x) => x.head),
    },
    why:
      'стороны дописали РАЗНЫЕ разделы, а общие и преамбулу не тронул никто — собрано ' +
      'объединение по заголовкам в хронологическом порядке коммитов. Строчный признак здесь ' +
      'видел замену только потому, что дерево задачи стояло на коммите до правки соседа (Д-68).',
  }
}

function main() {
  const change = args.change ? String(args.change) : null
  const paths = unmergedPaths(root)
  if (!paths.length) {
    process.stdout.write(
      JSON.stringify({ ok: true, resolved: [], refused: [], note: 'несведённых путей нет — разрешать нечего' }, null, 1) + '\n',
    )
    return
  }
  const mine = paths.filter((p) => isTaskFile(p, change))
  const foreign = paths.filter((p) => !isTaskFile(p, change))
  const results = args.dry_run
    ? mine.map((p) => ({ path: p, resolved: false, why: 'сухой прогон: файл подходит по классу, но не тронут' }))
    : mine.map(resolveOne)
  const resolved = results.filter((r) => r.resolved)
  const refused = results.filter((r) => !r.resolved)
  const out = {
    // `ok` — про то, что в индексе не осталось НИЧЕГО неразобранного. Разрешённый свой
    // класс при оставшемся чужом файле — это не «готово»: мерж по-прежнему держит человек.
    ok: !foreign.length && !refused.length,
    change,
    resolved,
    refused,
    foreign,
    note:
      (resolved.length
        ? `разрешено механически: ${resolved.length}. Класс — дописывание с двух сторон в ` +
          'append-only файл задачи (Д-56): решения по содержимому в нём нет, есть правило.\n'
        : '') +
      (refused.length
        ? `НЕ разрешено (${refused.length}) — смотри why у каждого: это уже выбор, и он человеку.\n`
        : '') +
      (foreign.length
        ? `ВНЕ КЛАССА (${foreign.length}): ${foreign.join(', ')} — эти файлы скрипт не трогал ` +
          'вовсе. Пока они не сведены, слияние не кончено.\n'
        : '') +
      'Коммита скрипт не делает: файлы поставлены в индекс, мерж завершает шаг слияния, и ' +
      'доказательством остаётся второй родитель мерж-коммита (ADR-0005).',
  }
  process.stdout.write(JSON.stringify(out, null, 1) + '\n')
}

function usage() {
  return [
    'firm2 task-merge — разрешить конфликт файла задачи, в котором обе стороны только дописали.',
    '',
    '  node task-merge.mjs --change <поставка> [--dry-run] [--root <корень>]',
    '  node task-merge.mjs --all                 # любой файл задачи любой поставки',
    '',
    'Без --change (или --all) скрипт ничего не правит и печатает эту справку.',
    '',
    'Зачем: за поставку проект-В 08.11.2026 слияние встало семь раз, и все семь — один класс:',
    'роль в дереве задачи дописывает протокол в конец openspec/changes/<поставка>/tasks/T-XXX.md,',
    'роль в главном дереве — раздел доработки туда же. Обе правы (append-only, ADR-0006),',
    'git не сводит это в принципе, а каждая остановка останавливала волну.',
    '',
    'Разрешается ТОЛЬКО дописывание с двух сторон: общее начало плюс оба куска по хронологии',
    'коммитов. Правила выше — отказ: там есть выбор, и выбор человеку (ADR-0009). Файлы вне',
    'каталога задач поставки не трогаются вовсе; коммит и завершение мержа — не его дело.',
    '',
  ].join('\n')
}

// Без аргументов скрипт НИЧЕГО не правит, а печатает, зачем он. Он пишет в файлы рабочего
// дерева, и «запустил посмотреть» не должно означать «правка случилась»: ту же осторожность
// движок держит у прочих пишущих команд.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Неизвестный флаг — отказ, а не умолчание (Д-61); `--help` печатает подсказку. Внутри
  // проверки на прямой вызов: сторож на уровне модуля судил бы argv того, кто импортировал.
  requireKnownFlags(process.argv.slice(2), ['all', 'change', 'dry_run'], { cmd: 'task-merge.mjs', usage: usage() })
  if (!args.change && !args.all && !args.dry_run) process.stdout.write(usage())
  else main()
}
