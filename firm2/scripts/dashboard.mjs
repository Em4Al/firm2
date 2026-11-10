#!/usr/bin/env node
// Генератор дашборда (§7). Один самодостаточный HTML, две вкладки:
// «Статусы» с графом зависимостей и «Тайминг». Внешних зависимостей нет —
// Node гарантирован (его требует OpenSpec), а тянуть в плагин Python или
// npm-пакеты на целевой проект нельзя.
//
// Дашборд НЕ коммитится (ADR-0003): он перегенерируемый, и в параллельных
// ветках давал бы неразрешимый конфликт на каждом слиянии.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  repoRoot, readConfig, computeBoard, listBugs, listEvents,
  humanDuration, humanTokens, gates, tokenUse, shortModel, STAGES, activeChange, inFlightTickets,
  areaRules, filesByTask, areaFindings, groomView, groomFindings, parseFrontmatter,
  deliveryTiming, pauseSpans, waves, duplicateFinishSummary,
} from './lib/firm.mjs'

const STATUS_META = {
  todo: { label: 'ждёт зависимости', color: '#8a8f98' },
  ready: { label: 'ждёт слот', color: '#0b3d91' },
  in_progress: { label: 'в разработке', color: '#2f6feb' },
  in_test: { label: 'в тестах', color: '#8957e5' },
  in_review: { label: 'на ревью', color: '#bf8700' },
  rework: { label: 'на доработке', color: '#d1242f' },
  accepted: { label: 'принята', color: '#1a7f37' },
  merged: { label: 'влита', color: '#116329' },
  released: { label: 'выпущена', color: '#0b5020' },
  blocked: { label: 'заблокирована', color: '#cf222e' },
  cancelled: { label: 'снята', color: '#6e7781' },
  // `superseded` — задача, которую человек ЗАМЕНИЛ другой (`lifecycle/superseded`, и
  // `sync` ставит этот статус в файл). В словаре доски его не было с самого начала, хотя
  // пишет движок именно его: замер проект-В 02.11.2026 — 12 снятых человеком задач висели
  // карточкой «прочее — статус вне словаря доски». Остаточное ведро отработало как
  // задумано (молча ничего не потерялось), но ответ на вопрос «что это за 12» давала
  // только она сама.
  superseded: { label: 'заменена', color: '#6e7781' },
}

const ORDER = [
  'blocked', 'rework', 'in_review', 'in_test', 'in_progress',
  'ready', 'todo', 'accepted', 'merged', 'released', 'superseded', 'cancelled',
]

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Строки графа — ВОЛНЫ ПЛАНИРОВЩИКА, а не глубина зависимостей.
//
// До 30.10.2026 строка значила «длина самой длинной цепочки зависимостей», и легенда
// отдельной строкой предупреждала: «строка графа — глубина зависимостей, а не пойдут
// вместе». То есть доска показывала величину, которую сама же просила не читать как план,
// и на вопрос «почему в работу взяты именно эти три задачи» ответа на ней не было вовсе
// (просьба 30.10.2026: «логика планировщика никак не отражена на дереве задач»).
//
// Теперь строка — то, чем она выглядит: задачи одной строки пойдут ВМЕСТЕ. Правило берётся
// не отсюда: прокрутку вперёд считает `waves()` из `lib/firm.mjs` — та же функция, которой
// меряет план гейт планирования и `firm-state phase`. Своего правила у доски нет и быть не
// должно: доска, считающая план по-своему, однажды покажет не тот план, по которому пойдёт
// прогон (ADR-0001 — истина не на доске).
//
// Чего прокрутка НЕ обещает: что волна начнётся, только когда кончится предыдущая. Слот
// освобождается по одному, и задача из следующей волны стартует, не дожидаясь остальных.
// Волна отвечает на «что с чем пойдёт и в каком порядке», а не на «когда».
const DONE_STATUS = ['merged', 'released']
// Снятое решением человека: зависимость на такую задачу прогон считает закрытой (основание
// неполное, и он говорит об этом вслух), а сама задача в план не вернётся.
const OUT_STATUS = ['cancelled', 'superseded']
const WORK_STATUS = ['in_progress', 'in_test', 'in_review', 'rework']
const PER_ROW = 4

function chunk(list, n) {
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

// Что держит задачу: имена зависимостей, которые ещё не закрыты, со статусами.
function holders(t, byId) {
  return (t.depends_on || [])
    .map((d) => byId.get(d))
    .filter((d) => d && !DONE_STATUS.includes(d.status) && !OUT_STATUS.includes(d.status))
}

function planRows(tasks, parallelism) {
  const cap = Math.max(1, Number(parallelism) || 1)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const pick = (ss) => tasks.filter((t) => ss.includes(t.status))
  const done = pick(DONE_STATUS)
  const work = pick(WORK_STATUS)
  const accepted = pick(['accepted'])
  const dropped = pick(OUT_STATUS)
  const blocked = pick(['blocked'])
  // Закрытым для прокрутки считается всё, чего ждать не нужно: влитое, снятое человеком,
  // идущее сейчас и принятое. Прокрутка отвечает на «что будет ДАЛЬШЕ», и повторять в ней
  // то, что уже идёт, значит показать задачу дважды.
  const closed = [...done, ...dropped, ...work, ...accepted].map((t) => t.id)
  const sim = waves(tasks, { parallelism: cap, done: closed, held: blocked.map((t) => t.id) })
  const stuck = new Set(sim.stuck || [])

  const rows = []
  const push = (cap_, list, extra = {}) => {
    chunk(list, Math.max(PER_ROW, cap)).forEach((part, i) => {
      rows.push({ cap: i ? '' : cap_, tasks: part, ...extra })
    })
  }
  if (done.length) push(`сделано · ${done.length} ${plural(done.length, 'задача', 'задачи', 'задач')} влито`, done)
  if (accepted.length) {
    push(`принято, ждёт слияния · ${accepted.length} ${plural(accepted.length, 'задача', 'задачи', 'задач')}`, accepted)
  }
  if (work.length) {
    const solo = work.find((t) => !t.parallel_safe)
    const free = Math.max(0, cap - work.length)
    const why = solo
      ? ` · ${solo.id} идёт одна, ${cap - 1} ${plural(cap - 1, 'слот', 'слота', 'слотов')} ждут: ${
        solo.exclusive_why || 'причина не указана'}`
      : ''
    rows.push({
      cap: `идёт сейчас · занято ${work.length} из ${cap} ${plural(cap, 'слота', 'слотов', 'слотов')}${why}`,
      tasks: work,
      // Свободный слот рисуется пустой рамкой: это не украшение, а ответ на «почему не
      // взяли ещё одну». Пустой слот при готовых задачах — простой, и его видно.
      free: solo ? 0 : free,
      now: true,
    })
  }
  sim.waves.forEach((ids, i) => {
    const w = ids.map((id) => byId.get(id)).filter(Boolean)
    const solo = w.length === 1 && !w[0].parallel_safe
    const n = (work.length ? 1 : 0) + i + 1
    const parts = [`волна ${n}`]
    if (!work.length && i === 0) parts.push('пойдёт первой: зависимости закрыты')
    if (solo) parts.push(`${w[0].id} идёт одна: ${w[0].exclusive_why || 'причина не указана'}`)
    else if (w.length < cap && i < sim.waves.length - 1) {
      parts.push(`готово ${w.length} из ${cap} — остальных держат зависимости`)
    }
    rows.push({ cap: parts.join(' · '), tasks: w, wave: n })
  })
  const aside = [...blocked, ...dropped, ...tasks.filter((t) => stuck.has(t.id))]
  if (aside.length) {
    const why = [
      blocked.length ? `${blocked.length} заблокировано` : '',
      dropped.length ? `${dropped.length} снято человеком` : '',
      stuck.size ? `${stuck.size} ждут снятого или заблокированного` : '',
    ].filter(Boolean).join(', ')
    push(`вне плана прогона · ${why}`, aside)
  }
  return { rows, cap, sim, blocked, dropped, stuck, work, done, accepted }
}

// Почему в работе именно эти задачи. Тот же вопрос, что у строк графа, но ответ на него
// нужен словами: правило планировщика состоит из трёх условий, и в картинке видно только
// результат. Условия называются по ФАКТАМ задачи (чем закрыто основание, стоит ли ∥,
// был ли свободен слот), а не пересказом кода.
function whyBlock(tasks, parallelism) {
  const { cap, work, rows } = planRows(tasks, parallelism)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const ready = tasks.filter((t) => ['ready', 'todo'].includes(t.status) && !holders(t, byId).length)
  if (!work.length && !ready.length) return ''
  const basis = (t) => {
    const deps = (t.depends_on || []).map((d) => byId.get(d)).filter(Boolean)
    if (!deps.length) return 'зависимостей нет'
    const out = deps.filter((d) => OUT_STATUS.includes(d.status))
    const ok = deps.filter((d) => DONE_STATUS.includes(d.status))
    const parts = []
    if (ok.length) parts.push(`${ok.map((d) => d.id).join(', ')} ${plural(ok.length, 'влита', 'влиты', 'влиты')}`)
    if (out.length) {
      parts.push(`${out.map((d) => d.id).join(', ')} снято человеком — основание неполное`)
    }
    return parts.join('; ') || 'основание не закрыто'
  }
  const li = work.map((t) => (
    `<li><b>${esc(t.id)}</b> — ${esc(basis(t))}; ${
      t.parallel_safe ? '∥ можно вести вместе с другими' : `идёт одна: ${esc(t.exclusive_why || 'причина не указана')}`
    }; слот был свободен</li>`
  ))
  const waiting = ready.filter((t) => !WORK_STATUS.includes(t.status))
  const free = Math.max(0, cap - work.length)
  const tail = waiting.length
    ? `<p class="muted">Готовы и ждут: <b>${waiting.map((t) => esc(t.id)).join(', ')}</b> — зависимости ` +
      `закрыты. ${free
        ? `Свободных слотов ${free}: доска читает файлы задач и журнал, а не идущий прогон, — ` +
          'свободный слот при готовой задаче значит либо что прогон её вот-вот возьмёт, либо что прогона сейчас нет.'
        : 'Слотов нет — пойдут по мере освобождения.'}</p>`
    : ''
  return (
    '<div class="why"><b>Почему в работе именно эти</b>' +
    (li.length ? `<ul>${li.join('')}</ul>` : '<p class="muted">Сейчас в работе нет ни одной задачи.</p>') +
    tail +
    `<p class="muted">Правило одно на прогон и на доску: берётся задача, у которой все зависимости ` +
    `влиты; помеченная «одна» (без ∥) занимает прогон целиком; одновременно не больше потолка ` +
    `parallelism — ${cap}. Порядок среди готовых — порядок плана Архитектора, и вперёд равных ` +
    `пускается задача с браузерной проверкой: она дольше всех и чаще уходит на вторую попытку. ` +
    `Строки графа ниже — это те же волны.</p>` +
    `<p class="muted">Волна отвечает на «что с чем пойдёт», а не на «когда»: слот освобождается ` +
    `по одному, и задача следующей волны стартует, не дожидаясь, пока кончится вся предыдущая. ` +
    `Прокрутку считает та же функция, что меряет план на гейте планирования (${
      rows.length} ${plural(rows.length, 'строка', 'строки', 'строк')} графа).</p>` +
    '</div>'
  )
}

// Задача, заведённая ради бага, ничем не отличается от обычной ни статусом, ни меткой —
// а на доске это разные вещи: одна двигает поставку вперёд, другая чинит уже найденное.
// Связь хранится в самом баге (fix_task), так что строим обратный указатель.
function fixMap(bugs, change) {
  const map = new Map()
  for (const b of bugs) {
    if (change && b.change && b.change !== change) continue
    if (!b.fix_task) continue
    if (!map.has(b.fix_task)) map.set(b.fix_task, [])
    map.get(b.fix_task).push(b)
  }
  return map
}

function graphSvg(tasks, fixes = new Map(), gate = null, parallelism = 3) {
  if (!tasks.length) return '<p class="muted">Задач пока нет.</p>'
  // Граф растёт ВНИЗ, а не вправо: ось Y — порядок прогона, задачи одной волны стоят в
  // ряд. Так его читают сверху вниз, как список, и он влезает в ширину экрана при любом
  // числе волн; вправо же он уезжал за край на третьем-четвёртом слое, и человек листал
  // горизонтально, теряя из вида начало цепочки. Просьба 02.10.2026.
  //
  // Строка — волна планировщика (см. `planRows`), а не глубина зависимостей: три задачи в
  // работе стоят на одной горизонтали, потому что они и идут вместе. Волна не бывает шире
  // потолка parallelism, так что переносить её не нужно; переносятся только группы
  // «сделано» и «вне плана» — там счёт идёт десятками, и девять карточек в ряд уехали бы в
  // ширину на две тысячи пикселей. Четыре по 190 с зазорами — 838, влезает в колонку
  // страницы (1200 минус отступы) на любом экране.
  const plan = planRows(tasks, parallelism)
  const rowsOf = plan.rows
  const anyFix = tasks.some((t) => fixes.has(t.id))
  const W = 190, H = anyFix ? 68 : 54, GX = 26, GY = 62, PAD = 16, CAPH = 20
  const pos = new Map()
  const rowY = (ri) => PAD + CAPH + ri * (H + GY)
  rowsOf.forEach((row, ri) => {
    row.tasks.forEach((t, ci) => {
      pos.set(t.id, { x: PAD + ci * (W + GX), y: rowY(ri) })
    })
  })
  const widest = Math.max(1, ...rowsOf.map((r) => r.tasks.length + (r.free || 0)))
  // Ворота — два ряда ПОД графом, по той же причине, по которой граф пошёл вниз: поставка
  // не заканчивается влитой последней задачей, и оставшиеся два шага должны читаться там
  // же, куда ведёт взгляд.
  const GATES = gate ? [['MR-ревью', gate.review], ['Демо', gate.demo]] : []
  const gy = (i) => rowY(rowsOf.length + i)
  const gx = PAD + Math.max(0, (widest - 1) / 2) * (W + GX)
  const width = PAD * 2 + widest * W + (widest - 1) * GX
  const height = PAD * 2 + CAPH + (rowsOf.length + GATES.length) * (H + GY)

  // Подпись строки — слева над ней. Она и есть ответ на «почему эти задачи вместе»:
  // карточки без подписи читались как глубина зависимости, чем они и были до 30.10.2026.
  // Полоса под текущей волной. Группа «сделано» стоит выше (история течёт вниз, и рёбра
  // тогда смотрят в одну сторону), а на большой поставке это шесть строк влитого перед
  // живой работой — текущую строку надо находить глазом сразу.
  const bands = rowsOf.map((row, ri) => (
    row.now
      ? `<rect x="${PAD - 8}" y="${rowY(ri) - CAPH + 2}" width="${width - PAD * 2 + 16}" ` +
        `height="${H + CAPH + 4}" rx="10" fill="var(--accent)" fill-opacity="0.07"/>`
      : ''
  ))
  const caps = rowsOf.map((row, ri) => (
    row.cap
      ? `<text x="${PAD}" y="${rowY(ri) - 7}" class="rowcap${row.now ? ' now' : ''}">${esc(row.cap)}</text>`
      : ''
  ))
  // Свободный слот. Пустая рамка пунктиром ровно там, где стояла бы задача: простой слота
  // при готовой задаче — главная статья календарного расхода прогона (замер проект-В
  // 05.10.2026: 5,5 слото-часов простоя при готовой задаче в поставке), и увидеть его на
  // доске было нельзя.
  const slots = []
  rowsOf.forEach((row, ri) => {
    for (let i = 0; i < (row.free || 0); i += 1) {
      const x = PAD + (row.tasks.length + i) * (W + GX)
      slots.push(
        `<g transform="translate(${x},${rowY(ri)})">` +
        `<rect width="${W}" height="${H}" rx="8" fill="none" stroke="var(--edge)" ` +
        'stroke-width="2" stroke-dasharray="5 4"/>' +
        `<text x="14" y="${Math.round(H / 2) + 4}" class="f">слот свободен</text>` +
        '</g>',
      )
    }
  })

  // Рёбра вертикальные: от низа задачи-зависимости к верху зависимой.
  const edges = []
  const edge = (x1, y1, x2, y2, attrs) => {
    const my = (y1 + y2) / 2
    const d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
    // Под каждым ребром — невидимая толстая копия: щёлкнуть по линии толщиной 1.5 пикселя
    // мышью нельзя, а именно щелчок по стрелке и просили.
    return (
      `<path class="hit" d="${d}" ${attrs}/>` +
      `<path class="edge" d="${d}" fill="none" stroke="var(--edge)" stroke-width="1.5" ` +
      `marker-end="url(#arrow)" ${attrs}/>`
    )
  }
  for (const t of tasks) {
    for (const d of t.depends_on) {
      const a = pos.get(d), b = pos.get(t.id)
      if (!a || !b) continue
      edges.push(edge(a.x + W / 2, a.y + H, b.x + W / 2, b.y, `data-from="${esc(d)}" data-to="${esc(t.id)}"`))
    }
  }

  const boxes = tasks.map((t) => {
    const p = pos.get(t.id)
    const c = (STATUS_META[t.status] || {}).color || '#888'
    const label = (STATUS_META[t.status] || {}).label || t.status
    const title = t.title.length > 26 ? t.title.slice(0, 25) + '…' : t.title
    // Флаги карточки разведены по двум углам нарочно. Справа — ЧТО это за задача (`UI`,
    // `⚙` high-complexity): свойства её содержимого. Слева, вплотную к номеру, — `∥`:
    // это свойство не задачи, а прогона, ответ на «можно ли вести её вместе с другими»,
    // и в одном ряду с UI он читался как ещё одна метка содержимого. Просьба 05.10.2026:
    // признак в журнале есть с самого начала, но увидеть его на дашборде не получалось.
    const flags = [
      t.ui ? 'UI' : '',
      t.labels.includes('high-complexity') ? '⚙' : '',
      // Замок — метка безопасности. В том же правом углу, что UI и ⚙: это тоже
      // свойство содержимого задачи, а не прогона.
      t.labels.includes('чувствительный-к-безопасности') ? '🔒' : '',
    ].filter(Boolean).join(' ')
    // Заливка цветом статуса, а не только контур. Контура не хватало: при двух десятках
    // карточек синий «в разработке» и зелёный «влита» на глаз не различались — просьба
    // 02.10.2026. Влитые и выпущенные залиты заметнее остальных: именно их человек
    // пересчитывает взглядом, прикидывая, сколько поставки уже готово.
    //
    // Делаем вторым прямоугольником с `fill-opacity`, а не `color-mix`: цвет темы приходит
    // переменной CSS, и смешивать её в SVG пришлось бы функцией, которой в старых webkit
    // нет, — а молча потерянная заливка хуже отсутствующей.
    const wash = ['merged', 'released'].includes(t.status) ? 0.18 : 0.1
    return (
      `<g id="box-${esc(t.id)}" class="box" data-id="${esc(t.id)}" transform="translate(${p.x},${p.y})">` +
      `<rect width="${W}" height="${H}" rx="8" fill="var(--card)"/>` +
      `<rect width="${W}" height="${H}" rx="8" fill="${c}" fill-opacity="${wash}"/>` +
      `<rect class="frame" width="${W}" height="${H}" rx="8" fill="none" stroke="${c}" stroke-width="2"/>` +
      `<rect width="5" height="${H}" rx="2" fill="${c}"/>` +
      `<text x="14" y="21" class="n">${esc(t.id)}${
        t.parallel_safe ? ' <tspan class="par">∥</tspan>' : ''
      }</text>` +
      `<text x="${W - 10}" y="21" class="f" text-anchor="end">${esc(flags)}</text>` +
      `<text x="14" y="38" class="t">${esc(title)}</text>` +
      `<text x="14" y="50" class="s" fill="${c}">${esc(label)}${
        t.working_by_worktree ? ' · идёт работа' : ''
      }${t.attempt > 1 ? ` · попытка ${t.attempt}` : ''}</text>` +
      (fixes.has(t.id)
        ? `<text x="14" y="63" class="fx">исправление ${esc(fixes.get(t.id).map((b) => b.id).join(', '))}</text>`
        : '') +
      '</g>'
    )
  })

  // В ворота упираются ВСЕ задачи, от которых ничего не зависит: рисовать ребро от
  // каждой — получить решётку, в которой не виден граф зависимостей. Промежуточные
  // задачи доходят до ворот через своих потомков, это и есть смысл зависимости.
  const depended = new Set(tasks.flatMap((t) => t.depends_on))
  const terminal = tasks.filter((t) => !depended.has(t.id))
  const gateBoxes = []
  if (GATES.length) {
    GATES.forEach(([name, g], i) => {
      const y = gy(i)
      const done = g && ['accepted', 'finished', 'ok'].includes(g.state)
      const c = done ? STATUS_META.merged.color : g && g.state === 'идут' ? STATUS_META.in_review.color : '#8a8f98'
      const meta = !g || g.state === 'не начаты'
        ? 'не начаты'
        : `${g.state}${g.ms ? ` · ${humanDuration(g.ms)}` : ''}${g.tokens ? ` · ${humanTokens(g.tokens)}` : ''}`
      gateBoxes.push(
        `<g transform="translate(${gx},${y})">` +
        `<rect width="${W}" height="${H}" rx="8" fill="var(--card)"/>` +
        `<rect width="${W}" height="${H}" rx="8" fill="${c}" fill-opacity="${done ? 0.18 : 0.08}"/>` +
        `<rect width="${W}" height="${H}" rx="8" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="${done ? '0' : '5 3'}"/>` +
        `<rect width="5" height="${H}" rx="2" fill="${c}"/>` +
        `<text x="14" y="21" class="n">${esc(name)}</text>` +
        `<text x="${W - 10}" y="21" class="f" text-anchor="end">${i === 1 ? 'человек' : 'QA'}</text>` +
        `<text x="14" y="38" class="t">${i === 1 ? 'ворота поставки' : 'дифф целиком'}</text>` +
        `<text x="14" y="50" class="s" fill="${c}">${esc(meta)}</text>` +
        '</g>',
      )
    })
    const dash = (x1, y1, x2, y2, attrs) => {
      const my = (y1 + y2) / 2
      const d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
      edges.push(
        `<path class="hit" d="${d}" ${attrs}/>` +
        `<path class="edge" d="${d}" fill="none" stroke="var(--edge)" stroke-width="1.5" ` +
        `stroke-dasharray="4 3" marker-end="url(#arrow)" ${attrs}/>`,
      )
    }
    for (const t of terminal) {
      const p = pos.get(t.id)
      if (p) dash(p.x + W / 2, p.y + H, gx + W / 2, gy(0), `data-from="${esc(t.id)}" data-to="gate-review"`)
    }
    dash(gx + W / 2, gy(0) + H, gx + W / 2, gy(1), 'data-from="gate-review" data-to="gate-demo"')
  }

  return (
    `<div class="scroll"><svg class="graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" fill="var(--edge)"/></marker></defs>' +
    bands.join('') + edges.join('') + caps.join('') + slots.join('') + boxes.join('') + gateBoxes.join('') +
    '</svg></div>' +
    legend(tasks) +
    '<p class="muted hint">Щёлкни по стрелке — связь выделится; по карточке — все её связи. ' +
    'Щелчок по пустому месту снимает выделение.</p>'
  )
}

// Легенда. Её не было вовсе, и это стоило ровно того, чего стоит неподписанный значок:
// `∥` стоял в карточках с самого начала, а прочитать его как «можно вместе» было нельзя —
// он выглядел типографским мусором рядом с `UI`. Отсюда вопрос 05.10.2026 «почему дашборд
// не отмечает параллельные задачи» при 65 значках `∥` на той же странице.
//
// Показываются ТОЛЬКО те обозначения, которые на этой странице действительно есть:
// легенда, перечисляющая отсутствующее, учит читать то, чего человек не видит, и сама
// становится шумом. Статусы — в порядке ORDER, то есть от тревожных к закрытым.
function legend(tasks) {
  const items = []
  if (tasks.some((t) => t.parallel_safe)) {
    items.push('<span class="lg"><b class="par">∥</b> можно вести одновременно с другими</span>')
  }
  if (tasks.some((t) => !t.parallel_safe)) {
    items.push('<span class="lg"><b>одна</b> идёт в одиночку, остальные слоты ждут</span>')
  }
  if (tasks.some((t) => t.ui)) items.push('<span class="lg"><b>UI</b> правит экран</span>')
  if (tasks.some((t) => t.labels.includes('high-complexity'))) {
    items.push('<span class="lg"><b>⚙</b> high-complexity: Разработчик на opus, ревью панелью</span>')
  }
  if (tasks.some((t) => t.labels.includes('чувствительный-к-безопасности'))) {
    items.push('<span class="lg"><b>🔒</b> чувствительный-к-безопасности: ревью панелью, ось безопасности в вердикте</span>')
  }
  const seen = ORDER.filter((k) => tasks.some((t) => t.status === k))
  const dots = seen
    .map((k) => `<span class="lg"><i class="dot" style="background:${STATUS_META[k].color}"></i>` +
      `${esc(STATUS_META[k].label)}</span>`)
    .join('')
  if (!items.length && !dots) return ''
  return (
    '<div class="legend">' +
    (items.length ? `<div class="lgrow">${items.join('')}</div>` : '') +
    (dots ? `<div class="lgrow">${dots}</div>` : '') +
    '<div class="lgrow"><span class="lg">строка графа — ВОЛНА прогона: эти задачи пойдут ' +
    'вместе. Пунктирная рамка — свободный слот</span></div>' +
    '</div>'
  )
}

function statusTable(tasks, fixes = new Map(), folded = new Set(), out = new Set()) {
  const rows = [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id.localeCompare(b.id))
  const tr = rows.map((t) => {
    const meta = STATUS_META[t.status] || { label: t.status, color: '#888' }
    // Причину ждать показываем полем, а не статусом (§4): todo — каких задач ждёт,
    // ready — кто занял слоты.
    const why = t.waiting_for.length
      ? esc(t.status === 'todo' ? `ждёт ${t.waiting_for.join(', ')}` : t.waiting_for.join(', '))
      : '<span class="muted">—</span>'
    return (
      (folded.has(t.id) ? '<tr class="folded">' : out.has(t.id) ? '<tr class="out">' : '<tr>') +
      `<td class="mono">${esc(t.id)}</td>` +
      `<td>${esc(t.title)}${t.epic ? ` <span class="chip">${esc(t.epic)}</span>` : ''}` +
      (fixes.has(t.id)
        ? ` <span class="chip fx">исправление ${esc(fixes.get(t.id).map((b) => b.id).join(', '))}</span>`
        : '') +
      '</td>' +
      // «Идёт работа» — не статус, а отдельный факт: рабочее дерево задачи живо. Статус
      // при этом остаётся тем, что в журнале (ADR-0001), поэтому это приписка, а не
      // подмена: иначе таблица обещала бы знание, которого у журнала нет.
      `<td><span class="dot" style="background:${meta.color}"></span>${esc(meta.label)}${
        t.working_by_worktree ? ' <span class="chip">идёт работа</span>' : ''
      }</td>` +
      `<td>${why}</td>` +
      `<td class="mono">${t.attempt}</td>` +
      `<td>${t.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ')}` +
      `${t.parallel_safe ? '<span class="chip par" title="можно вести одновременно с другими задачами">∥</span>' : ''}` +
      // Исключительность — не метка задачи, а её цена для всего прогона, поэтому видна
      // в таблице наравне с метками. Причина уходит в подсказку, чтобы не раздувать строку.
      `${!t.parallel_safe ? `<span class="chip one" title="${esc(t.exclusive_why || 'причина не указана')}">одна</span>` : ''}` +
      `${t.ui ? '<span class="chip">UI</span>' : ''}</td>` +
      '</tr>'
    )
  })
  return (
    '<div class="scroll"><table><thead><tr><th>Задача</th><th>Название</th><th>Статус</th>' +
    '<th>Почему ждёт</th><th>Поп.</th><th>Метки</th></tr></thead><tbody>' +
    (tr.join('') || '<tr><td colspan="6" class="muted">Задач нет</td></tr>') +
    '</tbody></table></div>'
  )
}

function timingTable(tasks) {
  const rows = tasks
    // Задача без движения в таблицу входит тоже: её календарь кончился последним
    // событием, и `calendar_ms` у одиночного старта равен нулю — а сказать про неё надо.
    .filter((t) => t.timing.calendar_ms > 0 || t.timing.idle_ms > 0)
    // Сортировка по ЧИСТОМУ времени: наверху самые дорогие задачи. По общему ожиданию
    // наверх всплывали те, в которых движок просто ждал человека, а по ожиданию движка —
    // те, что стояли в очереди за слотом: и то и другое отвечает на вопрос «что чинить»,
    // а таблицу открывают с вопросом «сколько это заняло». Накладные при этом не
    // спрятаны — они рядом, своей колонкой.
    .sort((a, b) => (b.timing.clean_ms || 0) - (a.timing.clean_ms || 0))
  const tr = rows.map((t) => {
    const { calendar_ms, active_ms, waiting_ms, idle_ms } = t.timing
    const clean = t.timing.clean_ms || 0
    const human = t.timing.waiting_human_ms || 0
    const paused = t.timing.waiting_pause_ms || 0
    const engineWait = t.timing.waiting_engine_ms || 0
    const pct = calendar_ms ? Math.round((active_ms / calendar_ms) * 100) : 0
    const tk = t.tokens || { total: 0, fresh: 0, out: 0, ctx_peak: 0, wait_ms: 0, tool_ms: 0, wait_max_ms: 0, by_stage: {} }
    // Разбивка по стадиям — рядом с общим числом, а не на отдельной вкладке: вопрос
    // «почему задача дорогая» задают ровно в тот момент, когда видят «дорого».
    // По стадиям показываем СВЕЖЕЕ: вопрос «какая стадия дорогая» по сумме с кэшем
    // отвечается неверно — дорогой выглядит самая длинная, а не самая работающая.
    const stages = STAGE_ORDER.filter((k) => tk.by_stage[k])
      .map((k) => `<span title="с кэшем ${esc(humanTokens(tk.by_stage[k].total))}">${k} ${humanTokens(tk.by_stage[k].fresh)}</span>`)
      .join(' · ')
    // Модели — рядом со стадиями, потому что это один и тот же вопрос с двух сторон:
    // «где задача потратила» и «чем именно тратила». Порядок — по убыванию расхода:
    // первой стоит та модель, которая и определила цену задачи.
    const models = Object.entries(tk.by_model || {})
      .sort((a, b) => b[1].total - a[1].total)
      .map(([m, v]) => `<span title="${esc(m)}">${esc(shortModel(m))} ${humanTokens(v.total)}</span>`)
      .join(' · ')
    return (
      '<tr>' +
      `<td class="mono">${esc(t.id)}</td>` +
      `<td>${esc(t.title)}</td>` +
      // Чистое время стоит ПЕРЕД календарным: на вопрос «сколько заняла задача» отвечает
      // оно, а календарное — справочное, в нём чужое время.
      `<td class="mono"${
        clean < calendar_ms ? ` title="календарное ${esc(humanDuration(calendar_ms))} минус чужое: ${esc(humanDuration(calendar_ms - clean))}"` : ''
      }>${humanDuration(clean)}</td>` +
      `<td class="mono">${humanDuration(calendar_ms)}</td>` +
      `<td class="mono">${humanDuration(active_ms)}</td>` +
      // В клетке стоит ожидание ДВИЖКА, а чужие части — подписью под ним. Общее ожидание
      // уходит в подсказку: оно верно, но отвечает на другой вопрос, чем «что чинить».
      `<td class="mono" title="всего ожидания ${esc(humanDuration(waiting_ms))}">${humanDuration(engineWait)}${
        human ? `<small> +${humanDuration(human)} ждут человека</small>` : ''
      }${paused ? `<small> +${humanDuration(paused)} на паузе</small>` : ''}${
        idle_ms ? `<small> +${humanDuration(idle_ms)} без движения</small>` : ''
      }</td>` +
      `<td><div class="bar"><span style="width:${pct}%"></span></div><small>${pct}% активного</small></td>` +
      `<td class="mono">${humanTokens(tk.fresh)}</td>` +
      `<td class="mono">${humanTokens(tk.total)}</td>` +
      `<td class="mono">${humanTokens(tk.out)}</td>` +
      // Пиковый контекст отвечает не на «сколько потрачено», а на «почему долго»: пауза
      // на ход растёт вместе с контекстом, который каждый ход перечитывается заново.
      // На T-058 (проект-В, 05.10.2026) контекст дошёл до 341k, и медиана паузы выросла
      // вдвое — стадия шла 141 минуту при 8 минутах внутри инструментов.
      `<td class="mono"${tk.ctx_peak > 200000 ? ' title="больше 200k — стадия платит за перечитывание контекста"' : ''}>` +
      `${tk.ctx_peak ? humanTokens(tk.ctx_peak) : '—'}</td>` +
      // «Модель ждали / инструменты» отвечает на вопрос «агент работал или ждал»: у T-053
      // (проект-В) из 80 минут стадии 75 ушли на ответы модели и 5 на инструменты, и это не
      // видно ни по токенам, ни по пику контекста. Подсказка называет самую долгую паузу.
      `<td class="mono"${tk.wait_max_ms >= 600000 ? ` title="самая долгая пауза перед ответом модели — ${humanDuration(tk.wait_max_ms)}"` : ''}>` +
      `${tk.wait_ms || tk.tool_ms ? `${humanDuration(tk.wait_ms)} / ${humanDuration(tk.tool_ms)}` : '—'}</td>` +
      `<td><small class="muted">${esc(stages || '—')}</small></td>` +
      `<td><small class="muted">${models || '—'}</small></td>` +
      '</tr>'
    )
  })
  return (
    '<div class="scroll"><table><thead><tr><th>Задача</th><th>Название</th>' +
    '<th title="календарное без ожидания человека и без паузы — время, за которое отвечает прогон">Чистое</th>' +
    '<th title="от первого входа в работу до слияния, чужое время включено">Календарное</th>' +
    '<th>Активное</th><th title="ожидание движка; чужие части — человек, пауза, без движения — подписаны отдельно">Ожидание движка</th><th>Доля</th>' +
    '<th title="вход + выход: то, что модель прочитала впервые и написала">Свежих</th>' +
    '<th title="сумма usage, включая чтение и запись кэша — величина про перечитывание контекста, а не про работу">С кэшем</th><th>Вывод</th>' +
    '<th title="наибольший контекст одного хода">Пик&nbsp;ctx</th>' +
    '<th title="время ответов модели (очередь, мышление, генерация) / время работы инструментов">Модель / инстр.</th>' +
    '<th>По стадиям</th><th>По моделям</th></tr></thead><tbody>' +
    (tr.join('') || '<tr><td colspan="12" class="muted">Ещё ни одна задача не начиналась</td></tr>') +
    '</tbody></table></div>'
  )
}

// Порядок стадий в разбивке — по ходу цикла, а не по алфавиту и не по величине:
// так видно, на каком шаге расход вырос, а перестановка колонок между задачами
// мешала бы их сравнивать.
//
// Это именно ПОРЯДОК, а не словарь: словарь один и живёт в lib/firm.mjs (STAGES). Стадии,
// которых здесь нет, дописываются в конец — иначе новая стадия исчезала бы из разбивки
// молча, а ровно так и пропали 34 минуты арбитража на прогоне 24.09.2026.
const STAGE_CYCLE = ['dev', 'test', 'review', 'adjudicate', 'design', 'gate', 'docs', 'merge']
const STAGE_ORDER = [...STAGE_CYCLE, ...STAGES.filter((s) => !STAGE_CYCLE.includes(s))]

function gatesTable(gate) {
  const row = (name, who, g) => {
    const state = g.state === 'не начаты' ? '<span class="muted">не начаты</span>' : esc(g.state)
    return (
      '<tr>' +
      `<td class="mono">${esc(name)}</td>` +
      `<td>${esc(who)}</td>` +
      `<td>${state}</td>` +
      `<td class="mono">${g.ms ? humanDuration(g.ms) : '—'}</td>` +
      `<td class="mono">${g.tokens ? humanTokens(g.tokens) : '—'}</td>` +
      `<td class="mono">${g.attempts > 1 ? `${g.attempts} захода` : '—'}</td>` +
      '</tr>'
    )
  }
  return (
    '<div class="scroll"><table><thead><tr><th>Ворота</th><th>Кто ведёт</th><th>Состояние</th>' +
    '<th>Время</th><th>Токены</th><th>Заходов</th></tr></thead><tbody>' +
    row('MR-ревью', 'Ревьюер-QA, дифф целиком', gate.review) +
    row('Демо', 'человек', gate.demo) +
    '</tbody></table></div>'
  )
}

// Расход по моделям — по всей поставке разом: задачи и ворота вместе.
//
// Метрика отвечает на вопрос, на который суммарное число не отвечает: роли фирмы
// работают на разных моделях нарочно (Разработчик — Sonnet, надзорный слой и
// high-complexity — Opus), а цена токена различается в разы. Поэтому «миллион токенов»
// без разбивки — это «много», но не «дорого».
//
// Цен здесь нет намеренно: они меняются помимо движка, и вшитый прайс устарел бы молча,
// выдавая неверные деньги с той же уверенностью, что и верные. Разбивка даёт то, из чего
// стоимость считается умножением на актуальный прайс — и остаётся честной год спустя.
function modelsTable(byModel, total) {
  const rows = Object.entries(byModel || {}).sort((a, b) => b[1].total - a[1].total)
  const tr = rows.map(([m, v]) => {
    const pct = total ? Math.round((v.total / total) * 100) : 0
    return (
      '<tr>' +
      `<td class="mono" title="${esc(m)}">${esc(shortModel(m))}</td>` +
      `<td class="mono">${humanTokens(v.total)}</td>` +
      `<td><div class="bar"><span style="width:${pct}%"></span></div><small>${pct}%</small></td>` +
      `<td class="mono">${humanTokens(v.in)}</td>` +
      `<td class="mono">${humanTokens(v.cache_read)}</td>` +
      `<td class="mono">${humanTokens(v.cache_write)}</td>` +
      `<td class="mono">${humanTokens(v.out)}</td>` +
      `<td class="mono">${v.thinking ? humanTokens(v.thinking) : '—'}</td>` +
      `<td class="mono">${v.calls}</td>` +
      '</tr>'
    )
  })
  return (
    '<div class="scroll"><table><thead><tr><th>Модель</th><th>Всего</th><th>Доля</th>' +
    '<th>Ввод</th><th>Чтение кэша</th><th>Запись кэша</th><th>Вывод</th><th>Мышление</th>' +
    '<th>Вызовов</th></tr></thead><tbody>' +
    (tr.join('') || '<tr><td colspan="9" class="muted">Расход ещё не записан</td></tr>') +
    '</tbody></table></div>'
  )
}

// Распределение ошибок по источнику — вторая метрика рядом с таймингом (§5).
// Открытый блокирующий баг — это вопрос «можно ли отдавать поставку», а не статистика.
// Он должен попадаться на глаза на той же вкладке, где смотрят доску, а не ждать, пока
// кто-то уйдёт на вторую. Поэтому счётчик в карточках и полоса над доской.
// Склонение по числу: «1 блокирующий», «2 блокирующих». Мелочь, но дашборд читают
// каждый день, и кривая согласованность в глаза бросается сильнее, чем кажется.
function plural(n, one, few, many) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function blockerBanner(blockers) {
  if (!blockers.length) return ''
  const items = blockers
    .map((b) => {
      const who = b.tickets && b.tickets.length ? ` · ${esc(b.tickets.join(', '))}` : ''
      const fix = b.fix_task ? ` · исправление ${esc(b.fix_task)}` : ' · задача-исправление не заведена'
      const what = b.title ? ` — ${esc(b.title)}` : ''
      return `<li><b>${esc(b.id)}</b>${what}${who}${fix}</li>`
    })
    .join('')
  return (
    `<div class="alarm-box"><b>Открыт${blockers.length > 1 ? 'ы' : ''} блокирующ${
      blockers.length > 1 ? 'ие баги' : 'ий баг'
    }: поставку отдавать нельзя</b><ul>${items}</ul>` +
    `<span class="muted">Состояние снимется само, когда задача-исправление будет влита (firm-event.mjs sync). Подробности — вкладка «Тайминг».</span></div>`
  )
}

// Стадии, которые идут, но чей тикет в журнале ещё не привязан. Снимок, сделанный в этот
// миг, раньше просто показывал «никого» — молча. Молчать здесь нельзя: человек видит
// пустую доску и решает, что прогон встал (ADR-0007, неопределённость требует сказать).
function unboundBanner(unbound, working) {
  if (!unbound.length && !working.size) return ''
  const parts = []
  if (working.size) {
    parts.push(
      `<li>Прямо сейчас есть рабочие деревья задач: <b>${esc([...working].join(', '))}</b>. ` +
        'На доске они отмечены как «в работе» по дереву, а не по журналу.</li>',
    )
  }
  if (unbound.length) {
    const stages = [...new Set(unbound.map((e) => e.stage))].join(', ')
    parts.push(
      `<li>Непривязанных стартов в журнале: <b>${unbound.length}</b> (${esc(stages)}). ` +
        'Это нормальное свойство момента: тикет стадии читается из транскрипта субагента, ' +
        'а он появляется мгновением позже события старта. Привязка достроится сама на финише.</li>',
    )
  }
  return (
    '<div class="alarm-box note"><b>Снимок сделан во время идущей стадии</b>' +
    `<ul>${parts.join('')}</ul>` +
    '<span class="muted">Пересобрать прямо сейчас: <span class="mono">node $ENGINE/scripts/dashboard.mjs</span> ' +
    '— или просто позвать <span class="mono">/firm2:firm-dashboard</span>.</span></div>'
  )
}

// Однополосный прогон виден только счётом. Отдельная задача с `parallel_safe: false`
// выглядит невинно, а полсотни таких — это поставка, которая идёт в один поток при трёх
// настроенных слотах (замер проект-В 05.10.2026: 82% рабочего времени одна стадия).
// Говорим числом и долей, но не решаем за человека: исключительность бывает законной.
function exclusivityBanner(tasks) {
  const live = tasks.filter((t) => !['merged', 'released', 'superseded', 'cancelled'].includes(t.status))
  if (live.length < 2) return ''
  const ex = live.filter((t) => !t.parallel_safe)
  const share = Math.round((100 * ex.length) / live.length)
  if (share <= 50) return ''
  const silent = ex.filter((t) => !t.exclusive_why)
  return (
    '<div class="alarm-box note"><b>Прогон будет почти однополосным</b>' +
    `<p>Из ${live.length} незавершённых задач ${ex.length} (${share}%) помечены идти ОДНИ: ` +
    'пока такая задача работает, остальные слоты стоят. Число слотов тут ни при чём — ' +
    'параллельность определяет не <code>parallelism</code>, а эта пометка.</p>' +
    (silent.length
      ? `<p>Причина не названа у ${silent.length}: ${silent.map((t) => esc(t.id)).join(', ')}. ` +
        'Исключительность бывает законной (общий файл, миграция, общая настройка) — ' +
        'но тогда это решение, а не умолчание: напиши причину полем <code>exclusive_why</code>.</p>'
      : '') +
    '<span>Замер обкатки: при такой доле 82% рабочего времени идёт одна стадия из трёх возможных.</span></div>'
  )
}

// Пометки задач против их фактического диффа. Полный список — здесь, а не в stderr
// каждого слияния: на поставке в шестьдесят задач это десятки строк, которые в потоке
// событий перестают читать, а на доске их смотрят ровно тогда, когда они нужны — на
// воротах поставки. Молчим, когда в конфиге не объявлены области (ADR-0007).
function areasNote(root, change, tasks, cfg) {
  const rules = areaRules(cfg)
  if (!rules.length) return ''
  let files
  try {
    files = filesByTask(root, change)
  } catch {
    return ''
  }
  if (!files.size) return ''
  const lines = []
  const mixed = []
  for (const t of tasks) {
    const got = areaFindings(t, files.get(t.id), rules)
    for (const g of got) (g.includes('смешанная') ? mixed : lines).push(g)
  }
  if (!lines.length && !mixed.length) return ''
  const head = lines.slice(0, 8)
  return (
    '<div class="alarm-box note"><b>Пометки задач расходятся с тем, что они правили</b>' +
    (lines.length
      ? '<ul>' + head.map((l) => `<li>${esc(l)}</li>`).join('') +
        (lines.length > head.length ? `<li class="muted">…и ещё ${lines.length - head.length}</li>` : '') +
        '</ul>'
      : '') +
    (mixed.length
      ? `<p>Смешанных задач (правят и экран, и сервер): <b>${mixed.length}</b>. ` +
        'На обкатке у этого класса вдвое больше дефектов, чем у чисто серверных, и 77% из ' +
        'них находит человек на демо, а не автоматический контур.</p>'
      : '') +
    '<span>Сверка идёт по диффу ветки задачи против областей из <code>areas</code> в .firm/config. ' +
    'Движок ничего не меняет — он только называет расхождение.</span></div>'
  )
}

function bugsBlock(bugs, change, { stats = true } = {}) {
  const mine = bugs.filter((b) => !change || !b.change || b.change === change)
  if (!mine.length) return '<p class="muted">Ошибок не заведено.</p>'
  const bySource = {}
  for (const b of mine) bySource[b.source] = (bySource[b.source] || 0) + 1
  const total = mine.length
  const bars = Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => (
      `<div class="srcrow"><span class="srclabel">${esc(src)}</span>` +
      `<div class="bar"><span style="width:${Math.round((n / total) * 100)}%"></span></div>` +
      `<span class="mono">${n}</span></div>`
    ))
    .join('')
  const rows = mine.map((b) => (
    '<tr>' +
    `<td class="mono">${esc(b.id)}</td><td>${esc(b.title || '—')}</td>` +
    `<td>${esc(b.source)}</td><td>${esc(b.verdict)}</td>` +
    `<td>${esc(b.status)}</td><td class="mono">${esc(b.tickets.join(', ') || '—')}</td>` +
    `<td class="mono">${esc(b.fix_task || '—')}</td></tr>`
  )).join('')
  return (
    (stats ? bars : '') +
    '<div class="scroll"><table><thead><tr><th>Баг</th><th>Что наблюдалось</th><th>Источник</th><th>Вердикт</th>' +
    `<th>Состояние</th><th>Задачи</th><th>Исправление</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    (stats
      ? '<p class="muted">Если большинство приходит с демо, а не из QA — ревью пропускает; если из dissent — задачи нарезаны слишком крупно.</p>'
      : '')
  )
}

// ── Груминг (ADR-0012) ────────────────────────────────────────────────────────
//
// Отдельной вкладкой, а не строкой в доске поставки, и это требование, а не вкус: доска
// отвечает на «что с поставкой», и темы, по которым поставки ещё нет, сделали бы её ответ
// неправдой. Вкладка появляется только когда груминг есть — поставка без него видит ровно
// тот дашборд, что и раньше.
//
// Группировка по выпуску: человек грумит темы россыпью, а собирает выпусками, и вопрос у
// него «что уже готово к 3.2», а не «что я грумил».
function groomRelease(root, g) {
  if (g.release) return String(g.release)
  // Выпуск мог быть назван в самом досье — там он ближе к требованиям, из которых следует.
  if (!g.dossier) return null
  const base = g.dossier_in === 'дерево груминга' && g.worktree ? g.worktree : root
  for (const name of ['requirements.md', 'README.md']) {
    try {
      const fm = parseFrontmatter(readFileSync(join(base, g.dossier, name), 'utf8')).data
      if (fm && fm.release) return String(fm.release)
    } catch { /* нет файла — смотрим следующий */ }
  }
  return null
}

const GROOM_META = {
  grooming: { label: 'в разборе', color: '#0b3d91' },
  groomed: { label: 'прогрумлено', color: '#1a7f37' },
  planned: { label: 'ушло в планирование', color: '#8a8f98' },
}

function groomBlock(root, view, findings) {
  const byRelease = new Map()
  for (const g of view) {
    const rel = g._broken ? null : groomRelease(root, g)
    const key = rel || 'выпуск не назначен'
    if (!byRelease.has(key)) byRelease.set(key, [])
    byRelease.get(key).push({ ...g, _release: rel })
  }
  const groups = [...byRelease.entries()].sort((a, b) => {
    if (a[0] === 'выпуск не назначен') return 1
    if (b[0] === 'выпуск не назначен') return -1
    return String(a[0]).localeCompare(String(b[0]))
  })
  const blocks = groups.map(([rel, items]) => {
    const rows = items.map((g) => {
      const meta = GROOM_META[g.status] || { label: g.status || '—', color: '#8a8f98' }
      const where = g._broken
        ? `<span class="warn">${esc(g._broken)}</span>`
        : `${g.dossier ? `<code>${esc(g.dossier)}</code> <span class="muted">(${esc(g.dossier_in)})</span>` : '<span class="muted">досье нет</span>'}`
      const tree = g._broken
        ? '—'
        : g.worktree_alive === null
          ? '<span class="muted">git молчит</span>'
          : g.worktree_alive
            ? `<code>${esc(String(g.worktree || '').split('/').pop())}</code>`
            : '<span class="muted">отдано</span>'
      return (
        '<tr>' +
        `<td class="mono">${esc(g.id)}</td><td>${esc(g.title || '—')}</td>` +
        `<td><span class="pill" style="background:${meta.color}">${esc(meta.label)}</span></td>` +
        `<td>${where}</td><td>${tree}</td>` +
        `<td class="mono">${g._broken || g.commits_ahead === null ? '—' : g.commits_ahead}</td></tr>`
      )
    }).join('')
    return (
      `<h3>${esc(rel)} <span class="muted">· ${items.length} ${plural(items.length, 'тема', 'темы', 'тем')}</span></h3>` +
      '<div class="scroll"><table><thead><tr><th>Тема</th><th>О чём</th><th>Состояние</th>' +
      `<th>Досье</th><th>Дерево</th><th>Коммитов</th></tr></thead><tbody>${rows}</tbody></table></div>`
    )
  }).join('')
  const warn = findings.length
    ? `<div class="banner alarm"><b>Объявленное расходится с фактическим:</b><ul>${
      findings.map((f) => `<li>${esc(f)}</li>`).join('')
    }</ul></div>`
    : ''
  return warn + blocks
}

function eventsBlock(events) {
  const last = events.slice(-40).reverse()
  const rows = last.map((e) => (
    '<tr>' +
    `<td class="mono">${esc(String(e.ts || '').replace('T', ' ').replace(/\..*$/, ''))}</td>` +
    `<td class="mono">${esc(e.ticket || '—')}</td>` +
    `<td>${esc(e.stage)}/${esc(e.event)}</td>` +
    `<td class="mono">${esc(e.actor || '—')}</td>` +
    `<td class="mono">${esc(e.attempt || 1)}</td></tr>`
  )).join('')
  return (
    '<div class="scroll"><table><thead><tr><th>Время</th><th>Задача</th><th>Событие</th>' +
    `<th>Кто</th><th>Поп.</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Событий нет</td></tr>'}</tbody></table></div>`
  )
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1c1c1a;--muted:#6e7781;--card:#fff;--line:#e3e3e0;--edge:#b9b9b4;--accent:#2f6feb;--bad:#d1242f}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e8e6;--muted:#9aa0a6;--card:#1f1f24;--line:#2e2e35;--edge:#4a4a55;--bad:#f2606b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 20px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px;flex-wrap:wrap}
.tabs button{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);
 padding:8px 14px;font:inherit;cursor:pointer;border-radius:6px 6px 0 0}
.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:120px;flex:1 1 120px}
.card b{display:block;font-size:22px;line-height:1.2}
.card span{color:var(--muted);font-size:12px}
.card.alarm{border-color:var(--bad);background:color-mix(in srgb, var(--bad) 8%, var(--card))}
.alarm-box{border:1px solid var(--bad);border-radius:10px;padding:12px 16px;margin-bottom:16px;
  background:color-mix(in srgb, var(--bad) 8%, var(--card))}
.alarm-box ul{margin:8px 0;padding-left:20px}
.alarm-box.note{border-color:var(--accent);background:color-mix(in srgb, var(--accent) 7%, var(--card))}
.alarm-box span{font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.muted{color:var(--muted)}
.chip{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:1px 8px;font-size:11px;margin-right:2px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.bar{background:var(--line);border-radius:6px;height:8px;overflow:hidden;min-width:80px}
.bar span{display:block;height:100%;background:var(--accent)}
.srcrow{display:flex;align-items:center;gap:10px;margin:6px 0}
.srclabel{min-width:90px;color:var(--muted);font-size:12px}
.scroll{overflow-x:auto;margin-bottom:16px}
svg text.n{font:600 13px ui-monospace,Menlo,monospace;fill:var(--fg)}
svg text.t{font:12px -apple-system,sans-serif;fill:var(--fg)}
svg text.s{font:11px -apple-system,sans-serif}
svg text.fx{font:10px ui-monospace,Menlo,monospace;fill:var(--bad)}
.chip.fx{border-color:var(--bad);color:var(--bad)}
.chip.one{border-style:dashed;cursor:help}
svg text.f{font:11px -apple-system,sans-serif;fill:var(--muted)}
svg text.rowcap{font:600 11px -apple-system,sans-serif;fill:var(--muted);text-transform:uppercase;letter-spacing:.04em}
svg text.rowcap.now{fill:var(--accent)}
.why{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;
  padding:10px 14px;margin:0 0 14px;background:var(--card);font-size:13px}
.why ul{margin:6px 0 8px;padding-left:20px}
.why li{margin:2px 0}
.why p{margin:4px 0;font-size:12px}
svg.graph path.hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}
svg.graph path.edge{pointer-events:none;transition:stroke .1s,stroke-width .1s}
svg.graph path.edge.hl{stroke:var(--accent);stroke-width:3.5}
svg.graph g.box{cursor:pointer}
svg.graph g.box.hl rect.frame{stroke-width:3.5}
svg.graph.picked g.box:not(.hl){opacity:.45}
.hint{font-size:12px;margin:-8px 0 18px}
.legend{display:flex;flex-direction:column;gap:4px;margin:10px 0 14px;font-size:12px;color:var(--muted)}
.lgrow{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
.lg{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.lg b{font-weight:600;color:var(--fg)}
.par{color:var(--accent);font-weight:700}
.chip.par{cursor:help}
svg text .par,svg tspan.par{fill:var(--accent)}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 18px;font-size:12px;color:var(--muted)}
.fold{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;margin:0 0 12px;cursor:pointer}
tr.folded,tr.out{display:none}
body.show-all tr.folded{display:table-row}
body.show-out tr.out{display:table-row}
[hidden]{display:none!important}
small{color:var(--muted)}
`

const JS = `
// Подсветка связи. Выделяем не только стрелку, но и карточки на её концах: вопрос, который
// задают щелчком, — «что от чего зависит», а на него отвечает именно пара, а не линия.
// Щелчок по карточке выделяет все её связи сразу — так видно место задачи в цепочке.
// Графов на странице может быть до ЧЕТЫРЁХ — по одному на сочетание двух свёрток
// (влитое без ссылок, снятое человеком), — и виден всегда один. Вешаем обработчик на
// каждый: раньше здесь стоял querySelector, и подсветка связей работала бы только в
// первом.
document.querySelectorAll('svg.graph').forEach(function(svg){
(function(){
  function clear(){
    svg.querySelectorAll('.hl').forEach(function(x){x.classList.remove('hl')});
    svg.classList.remove('picked');
  }
  function mark(ids, paths){
    svg.classList.add('picked');
    paths.forEach(function(p){p.classList.add('hl')});
    ids.forEach(function(id){
      var b = svg.querySelector('[data-id="' + id + '"]');
      if (b) b.classList.add('hl');
    });
  }
  svg.addEventListener('click', function(ev){
    var hit = ev.target.closest('path.hit');
    var box = ev.target.closest('g.box');
    clear();
    if (hit){
      var from = hit.getAttribute('data-from'), to = hit.getAttribute('data-to');
      mark([from, to], Array.prototype.slice.call(
        svg.querySelectorAll('path.edge[data-from="' + from + '"][data-to="' + to + '"]')));
      return;
    }
    if (box){
      var id = box.getAttribute('data-id');
      var paths = Array.prototype.slice.call(
        svg.querySelectorAll('path.edge[data-from="' + id + '"], path.edge[data-to="' + id + '"]'));
      var ids = [id];
      paths.forEach(function(p){
        ids.push(p.getAttribute('data-from'));
        ids.push(p.getAttribute('data-to'));
      });
      mark(ids, paths);
    }
  });
})();
});
// Галочек две, и прячут они РАЗНОЕ: влитое без ссылок и снятое человеком (замена,
// отмена). Копий графа поэтому до четырёх — по одной на сочетание, — и видна ровно та,
// что отвечает текущим галочкам. Ключ вида собирается из тех же букв, что и при сборке:
// «m» — спрятано влитое, «o» — спрятано снятое, «-» — не спрятано ничего.
var fold = document.getElementById('fold');
var foldOut = document.getElementById('fold-out');
function applyFold(){
  document.body.classList.toggle('show-all', !!(fold && !fold.checked));
  document.body.classList.toggle('show-out', !!(foldOut && !foldOut.checked));
  var views = document.querySelectorAll('.gview');
  if (!views.length) return;
  var key = ((fold && fold.checked) ? 'm' : '') + ((foldOut && foldOut.checked) ? 'o' : '');
  views.forEach(function(v){ v.hidden = v.getAttribute('data-view') !== (key || '-'); });
}
[fold, foldOut].forEach(function(c){ if (c) c.addEventListener('change', applyFold); });
document.querySelectorAll('.tabs button').forEach(function(b){
  b.addEventListener('click', function(){
    document.querySelectorAll('.tabs button').forEach(function(x){x.setAttribute('aria-selected', String(x===b))});
    document.querySelectorAll('section[data-tab]').forEach(function(s){s.hidden = s.dataset.tab !== b.dataset.tab});
  });
});
`

export function buildDashboard(root = repoRoot(), change = null) {
  // Поставку не передали — вычисляем, а не собираем пустую доску: см. activeChange в
  // lib/firm.mjs. Фолбэк стоит здесь, а не только в разборе аргументов, потому что
  // buildDashboard зовут и из команд.
  change = change || activeChange(root)
  const cfg = readConfig(root) || {}
  // Сужение задачного прогона — свойство ПОСТАВКИ, а не задачи, и видно оно должно быть
  // там же, где её читают. Иначе оно живёт только в конфиге, а на доске узкий зелёный
  // выглядит как полный — то есть как то, чем не является.
  const st = (cfg && cfg.stack) || {}
  const narrowTests =
    st.task_test_cmd && st.test_cmd && st.task_test_cmd !== st.test_cmd
      ? { task: String(st.task_test_cmd), full: String(st.test_cmd) }
      : null
  // Груминг читается всегда, но вкладка появляется только когда он есть: поставка без
  // груминга обязана видеть ровно прежний дашборд.
  const groom = groomView(root, cfg)
  const groomNotes = groom.length ? groomFindings(root, cfg) : []
  const parallelism = Number(cfg.parallelism) > 0 ? Number(cfg.parallelism) : 3
  const board = computeBoard(root, change, { parallelism })
  const tasks = board.tasks
  const events = listEvents(root, { change })
  const bugs = listBugs(root)
  const gate = gates(events)
  const openBugs = bugs.filter((b) => (!change || !b.change || b.change === change) && b.open)
  const openBlockers = openBugs.filter((b) => b.verdict === 'blocker')
  const fixes = fixMap(bugs, change)
  const now = new Date().toISOString().replace('T', ' ').replace(/\..*$/, '')

  // Снимок делается НА СОБЫТИИ, и последнее событие после смены стадии — всегда
  // `dev/started`, у которого тикета в тот момент ещё нет: маркер читается из транскрипта
  // субагента, а файл транскрипта рантайм создаёт мгновением позже. Привязка достраивается
  // (resolveTickets, resolveFromTranscripts), но ИМЕННО в этот миг достраивать не из чего, —
  // и снимок, сделанный тогда, показывал «в работе никого». Таким он и оставался до
  // следующего привязанного события, то есть до конца стадии: десятки минут.
  //
  // Поэтому дашборд спрашивает ещё и рабочие деревья. Живое дерево `task/T-XXX` — признак
  // того же свойства, что мерж-коммит для «влито»: он не выводится из журнала, он есть в
  // репозитории, и к моменту старта стадии дерево УЖЕ создано. Это не второй судья над
  // статусом (статус по-прежнему из журнала, ADR-0001), а второй источник ответа на
  // отдельный вопрос — «идёт ли работа прямо сейчас». Нашла сессия проекта 02.10.2026.
  //
  // `null` означает «git не ответил» (inFlightTickets отвечает так намеренно) — тогда не
  // выдумываем ничего.
  const inFlight = inFlightTickets(root)
  const working = new Set()
  if (inFlight) {
    for (const t of tasks) {
      if (!inFlight.has(t.id)) continue
      // Дерево живо и у влитой задачи — его просто не убрали. Про такую задачу журнал
      // знает точнее, и перебивать его нечем.
      if (['merged', 'released', 'superseded', 'cancelled'].includes(t.status)) continue
      if (['todo', 'ready'].includes(t.status) || !t.status) working.add(t.id)
    }
  }
  for (const t of tasks) if (working.has(t.id)) t.working_by_worktree = true

  // Непривязанные стадии: говорим о них вслух, а не считаем, что их нет (ADR-0007).
  const unbound = events.filter((e) => !e._broken && e.event === 'started' && e.agent_id && !/^(T-[\w.]+|MR)$/.test(String(e.ticket || '')))

  // Стадии, вышедшие за бюджет. Отметку ставит хук на событии в момент финиша
  // (`over_budget`), здесь она только показывается: доска считает заново всё, кроме того,
  // что уже является фактом о событии. Карточка появляется, лишь когда перерасход есть —
  // пустая строка на доске это шум.
  const overBudget = events.filter((e) => !e._broken && e.over_budget && e.over_budget.minutes)
  const overWorst = overBudget.reduce((a, e) => Math.max(a, Number(e.over_budget.minutes) || 0), 0)
  const overStages = [...new Set(overBudget.map((e) => e.stage))].join(', ')

  const counts = {}
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1
  const done = (counts.merged || 0) + (counts.released || 0)

  // Карточки сводки обязаны СКЛАДЫВАТЬСЯ в итог, и это не косметика.
  //
  // До 0.4.110 их было пять — задач, влито, ждут слот, ждут зависимости, блок/доработка, —
  // и ни одна не считала задачи В РАБОТЕ. На проект-В 28.10.2026 это читалось так: «63 задач»,
  // а дальше 12 + 11 + 37 + 0 = 60. Три задачи, которые ведутся ПРЯМО СЕЙЧАС (T-141 в
  // разработке, T-153 и T-155 в тестах), в сводке не были видны нигде — то есть доска
  // молчала ровно про ту работу, ради которой на неё смотрят. Хуже: против T-153 открыты
  // два блокирующих бага, и задача, которую они держат, в сводке отсутствовала.
  //
  // Поэтому буфер считается не перечнем статусов, а ОСТАТКОМ: что не попало ни в одну
  // названную группу, попадает в «прочее» и остаётся видимым. Новый статус в словаре
  // доски больше не может исчезнуть из сводки молча — он может только оказаться в
  // «прочем» и потребовать себе карточку.
  const IN_FLIGHT = ['in_progress', 'in_test', 'in_review']
  // Имя `inFlight` выше занято множеством тикетов из git — здесь СЧЁТ задач по статусу.
  const inFlightCount = IN_FLIGHT.reduce((a, s) => a + (counts[s] || 0), 0)
  const namedCounts = {
    merged: done,
    in_flight: inFlightCount,
    // `accepted` — принята, но не влита: ни работа, ни результат. Своя карточка у неё
    // появляется только когда такие задачи есть: пустая строка на доске — это шум.
    accepted: counts.accepted || 0,
    ready: counts.ready || 0,
    todo: counts.todo || 0,
    stuck: (counts.blocked || 0) + (counts.rework || 0),
  }
  const named = Object.values(namedCounts).reduce((a, n) => a + n, 0)
  const other = tasks.length - named

  // Свёртка влитых задач. На большой поставке (проект-В — полсотни задач) граф и таблица
  // целиком состоят из законченного, и найти в них живую работу трудно. Прячем влитое,
  // но НЕ всё: задача, на которую ссылается ещё не влитая, остаётся видимой — иначе у
  // живой задачи обрывается стрелка и «ждёт T-040» указывает в пустоту.
  //
  // Это именно вид, а не отбор данных: вторая копия графа и строки таблицы остаются в
  // файле, их возвращает галочка. Доска только на чтение (ADR-0001), и прятать так,
  // чтобы спрятанное нельзя было достать, она права не имеет.
  const MERGED_STATUS = ['merged', 'released']
  const liveDeps = new Set()
  for (const t of tasks) {
    if (MERGED_STATUS.includes(t.status)) continue
    for (const d of t.depends_on || []) liveDeps.add(d)
  }
  const folded = new Set(
    tasks.filter((t) => MERGED_STATUS.includes(t.status) && !liveDeps.has(t.id)).map((t) => t.id),
  )
  // Вторая свёртка — снятое решением человека (`superseded`, `cancelled`). Довод тот же,
  // что у первой, но причина другая: такая задача не «сделана», а ВЫБРОШЕНА, и вместо неё
  // взята другая. В плане её нет и не будет, а в графе она занимала последнюю строку и
  // мешала читать живые (просьба человека 30.10.2026). Прячется по умолчанию — как и
  // влитое, — и так же возвращается галочкой: доска только на чтение, спрятанное обязано
  // доставаться (ADR-0001).
  const outIds = new Set(tasks.filter((t) => OUT_STATUS.includes(t.status)).map((t) => t.id))
  // Копий графа до четырёх: прокрутку волн считает `waves()` по тому составу задач,
  // который видно, и подпись строки («вне плана прогона · 3 снято человеком») обязана
  // сойтись с тем, что в ней нарисовано. Пересчитать состав в браузере нечем — планировщик
  // живёт в движке, и второй его копии на доске быть не должно. Цена названа: вид весит
  // как граф, и на поставке в 67 задач четыре вида это около полумегабайта файла.
  const groups = []
  if (folded.size) groups.push({ key: 'm', ids: folded })
  if (outIds.size) groups.push({ key: 'o', ids: outIds })
  const defaultView = groups.map((g) => g.key).join('') || '-'
  const views = []
  for (let mask = 0; mask < 1 << groups.length; mask++) {
    const hide = new Set()
    const keys = []
    groups.forEach((g, i) => {
      if (!(mask & (1 << i))) return
      keys.push(g.key)
      for (const id of g.ids) hide.add(id)
    })
    views.push({ view: keys.join('') || '-', hide })
  }
  const foldControl = [
    folded.size
      ? `<label class="fold"><input type="checkbox" id="fold" checked> ` +
        `скрыть влитое, на которое никто не ссылается — ${folded.size} ` +
        `${plural(folded.size, 'задача', 'задачи', 'задач')}</label>`
      : '',
    outIds.size
      ? `<label class="fold"><input type="checkbox" id="fold-out" checked> ` +
        `скрыть снятое человеком (замена, отмена) — ${outIds.size} ` +
        `${plural(outIds.size, 'задача', 'задачи', 'задач')}</label>`
      : '',
  ].filter(Boolean).join('\n  ')
  const graphBlock = views.length > 1
    ? views.map((v) => `<div class="gview" data-view="${v.view}"${
        v.view === defaultView ? '' : ' hidden'
      }>${graphSvg(tasks.filter((t) => !v.hide.has(t.id)), fixes, gate, parallelism)}</div>`).join('')
    : graphSvg(tasks, fixes, gate, parallelism)

  const legend = ORDER.filter((s) => counts[s])
    .map((s) => `<span><span class="dot" style="background:${STATUS_META[s].color}"></span>${STATUS_META[s].label} · ${counts[s]}</span>`)
    .join('')

  const totalWait = tasks.reduce((a, t) => a + t.timing.waiting_ms, 0)
  const totalActive = tasks.reduce((a, t) => a + t.timing.active_ms, 0)
  // Ожидание складывается ПО ЗАДАЧАМ, и это не календарь поставки: задачи идут
  // параллельно, их интервалы накладываются, и сумма законно больше календаря. Отдельно
  // считается ожидание на НЕЗАКРЫТЫХ задачах: у них конец интервала — «сейчас», то есть
  // число растёт само, пока смотришь. Это не ошибка счёта, но читать его как «столько
  // прождали» нельзя, поэтому обе части названы врозь (то же решение, что `open_runs`
  // в замере груминга: открытый интервал — не ноль и не факт).
  const totalIdle = tasks.reduce((a, t) => a + (t.timing.idle_ms || 0), 0)
  // Ожидание раскладывается на три части, и это не косметика: ДВИЖОК отвечает только за
  // одну из них. Время, когда задача ждала человека (эскалация до следующего события) и
  // время, когда прогон стоял на паузе, — чужое, и прогон им не распоряжается (ADR-0009).
  // Складывать его с накладными между стадиями значит предъявлять движку чужой счёт:
  // замер проект-В 28.10.2026 показывал «168 ч 26 м ожидания», в которых работы движка было
  // меньше половины. Поэтому в карточке стоит ожидание ДВИЖКА, а чужие части названы
  // отдельно и своими именами.
  const totalHuman = tasks.reduce((a, t) => a + (t.timing.waiting_human_ms || 0), 0)
  const totalPause = tasks.reduce((a, t) => a + (t.timing.waiting_pause_ms || 0), 0)
  const totalEngineWait = tasks.reduce((a, t) => a + (t.timing.waiting_engine_ms || 0), 0)
  // ЧИСТОЕ время — то, что стоит в шапке. Разбивка ожидания отвечает на вопрос «что
  // чинить», и в шапке она стояла тремя карточками: человек читал её как счёт поставке,
  // хотя две части из трёх к прогону не относятся вовсе. Вопрос шапки другой — «сколько
  // это заняло», — и ответ на него один: календарь минус чужое. Вычтенное не спрятано:
  // оно названо в подсказке карточки и разложено на вкладке «Тайминг».
  const totalClean = tasks.reduce((a, t) => a + (t.timing.clean_ms || 0), 0)
  // И отдельно — время САМОЙ ПОСТАВКИ, не сумма по задачам. Это два разных вопроса, и
  // сумма на второй не отвечает: задачи идут параллельно, их интервалы накладываются, и
  // сумма законно больше календаря (здесь 226 ч 46 м по задачам при 170 ч календаря —
  // замер проект-В 29.10.2026). «Сколько поставка шла» — объединение интервалов, когда шла
  // хоть одна стадия; остальное в её календаре простой: ждут человека, пауза, промежутки
  // между волнами. В шапке стоят оба числа рядом, подписанные разными словами.
  const dl = deliveryTiming(events, pauseSpans(events))
  // Вычтенное считается как РАЗНИЦА календаря и чистого, а не сложением частей человека
  // и паузы: части накладываются (пауза обычно стоит внутри ожидания человека), и их
  // сумма назвала бы вычтенным больше, чем вычли. Поэтому в карточке — ровно разница, а
  // части названы в подсказке с оговоркой про перекрытие.
  const totalForeign = tasks.reduce((a, t) => a + Math.max(0, t.timing.calendar_ms - (t.timing.clean_ms || 0)), 0)
  // Ворота идут В сумму: они часть стоимости поставки, и MR-ревью диффа целиком —
  // не самая дешёвая её часть. Показываем и отдельной строкой, чтобы было видно, сколько
  // стоит проверка поставки против суммы всех задач.
  const gateTokens = gate.review.tokens + gate.demo.tokens
  const gateMs = gate.review.ms + gate.demo.ms
  const totalTokens = gateTokens + tasks.reduce((a, t) => a + ((t.tokens && t.tokens.total) || 0), 0)
  const totalOut = tasks.reduce((a, t) => a + ((t.tokens && t.tokens.out) || 0), 0)
  const countedTasks = tasks.filter((t) => t.tokens && t.tokens.total > 0).length
  // По моделям считаем из ЖУРНАЛА целиком, а не складывая задачи: так в сумму попадают
  // и ворота, и стадии, которые ни к одной задаче не привязаны. Общее число здесь и в
  // карточке поэтому сходится по построению.
  const allTokens = tokenUse(events)
  // Двойные финиши — не для красоты строкой ниже. Отчёт проект-В 03.11.2026 (находка 3)
  // прочитал `duplicate_finishes` из `doctor` как «учёт раздут на 1,25 млрд» и сделал
  // вывод «цена поставки — шум», при том что дедупликация стоит здесь же, в `tokenUse`.
  // Если дашборд сам не говорит, что двойной счёт снят, это делает соседний инструмент —
  // и говорит обратное. Про занижение (механические вызовы) он уже говорит; теперь
  // названы оба искажения, и оба с числами.
  const dupe = duplicateFinishSummary(events)
  const modelNames = Object.keys(allTokens.by_model)
  // СВЕЖИЕ токены — вход и выход, то есть то, что модель прочитала впервые и написала.
  // Чтение кэша — это ПЕРЕЧИТЫВАНИЕ уже посланного контекста, и смешивать его с работой
  // в одном числе значит прятать работу: замер проект-В 28.10.2026 по поставке
  // 2026-10-23-game-redesign — 510,5M «всего», из них 480,5M чтение кэша (94,1%),
  // 26,1M запись кэша (5,1%) и лишь 3,9M вывода (0,76%). Карточка «токенов всего»
  // показывала, сколько раз перечитан контекст, а человек читал её как «сколько сделано».
  //
  // Переводить кэш в «эквивалент» движок не станет: коэффициент — это ЦЕНА, она разная у
  // моделей и планов и меняется без нас, а порог выражается в замеренном (ADR-0010).
  // Поэтому обе величины показываются как есть, рядом, с долей кэша.
  const freshTokens = (allTokens.in || 0) + (allTokens.out || 0)
  const cacheRead = allTokens.cache_read || 0
  const cacheShare = allTokens.total ? Math.round((cacheRead / allTokens.total) * 100) : 0

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>firm2 · ${esc(change || 'поставка')}</title>
<style>${CSS}</style></head><body><div class="wrap">
<h1>firm2 — ${esc(change || 'поставка не выбрана')}</h1>
<p class="sub">Собрано ${esc(now)} · слотов ${board.slots_used}/${parallelism} · событий ${events.length}.
Источник истины — файлы задач и журнал событий; доска только на чтение (ADR-0001).</p>${
  narrowTests
    ? `\n<p class="sub"><b>Задачный прогон сужен проектом:</b> задачи — <code>${esc(narrowTests.task)}</code>,
ворота — <code>${esc(narrowTests.full)}</code>. Зелёный на задаче не означает зелёный на воротах, и
полный набор обязан пройти на закрытии поставки: цена сужения переехала туда, а не исчезла.</p>`
    : ''
}

<div class="cards">
  <div class="card"><b>${tasks.length}</b><span>задач</span></div>
  <div class="card"><b>${done}</b><span>влито</span></div>
  <div class="card${inFlightCount ? ' live' : ''}"><b>${inFlightCount}</b><span>в работе${
    inFlightCount ? ` · ${esc(IN_FLIGHT.filter((s) => counts[s]).map((s) => `${STATUS_META[s].label} ${counts[s]}`).join(', '))}` : ''
  }</span></div>${
    namedCounts.accepted
      ? `\n  <div class="card"><b>${namedCounts.accepted}</b><span>принята, не влита</span></div>`
      : ''
  }
  <div class="card"><b>${(counts.ready || 0)}</b><span>ждут слот</span></div>
  <div class="card"><b>${(counts.todo || 0)}</b><span>ждут зависимости</span></div>
  <div class="card"><b>${namedCounts.stuck}</b><span>блок / доработка</span></div>${
    other
      ? `\n  <div class="card"><b>${other}</b><span>прочее — ${esc(
          ORDER.filter((s) => counts[s] && !['merged', 'released', 'accepted', 'ready', 'todo', 'blocked', 'rework', ...IN_FLIGHT].includes(s))
            .map((s) => STATUS_META[s] ? STATUS_META[s].label : s).join(', ') || 'статус вне словаря доски',
        )}</span></div>`
      : ''
  }
  <div class="card" title="${
    esc(`поставка идёт с ${String(dl.started || '').slice(0, 16).replace('T', ' ')}; календарных ${humanDuration(dl.calendar_ms)}, из них ${humanDuration(dl.idle_ms)} простоя — ждут человека, пауза (${humanDuration(dl.pause_ms)}), промежутки между волнами. Открытую стадию пауза не прерывает, поэтому из работы она не вычитается.`)
  }"><b>${humanDuration(dl.clean_ms)}</b><span>шла поставка · когда работала хоть одна стадия</span></div>
  <div class="card"${
    totalForeign
      ? ` title="сумма по задачам, а не календарь поставки: задачи идут параллельно. Вычтено ${esc(humanDuration(totalForeign))} чужого: ${esc(humanDuration(totalHuman))} ждут человека, ${esc(humanDuration(totalPause))} на паузе (части накладываются, вычтено объединение); накладные движка — ${esc(humanDuration(totalEngineWait))}, разбивка на вкладке «Тайминг»"`
      : ` title="сумма по задачам, а не календарь поставки: задачи идут параллельно. Ожидания человека и паузы в этой поставке не было; накладные движка — ${esc(humanDuration(totalEngineWait))}"`
  }><b>${humanDuration(totalClean)}</b><span>чистое по задачам · без ожидания человека и паузы${
    totalForeign ? ` (вычтено ${humanDuration(totalForeign)})` : ''
  }</span></div>${
    totalIdle ? `\n  <div class="card"><b>${humanDuration(totalIdle)}</b><span>без движения · задачи не влиты, стадий не идёт</span></div>` : ''
  }${
    overBudget.length
      ? `\n  <div class="card alarm" title="${esc(
          `бюджет стадии — решение проекта (stage_budget в .firm/config), по умолчанию 30 минут на разработку и на тест. ` +
          `Движок стадию не прерывает: он называет бюджет в промпте и помечает перерасход на событии. ` +
          `Худшая стадия: ${overWorst} мин. Куда делось время — node scripts/stage-bill.mjs`,
        )}"><b>${overBudget.length}</b><span>стадий за бюджетом · ${esc(overStages)} · худшая ${overWorst} мин</span></div>`
      : ''
  }
  <div class="card"><b>${humanTokens(freshTokens)}</b><span>свежих токенов · вход+выход${
    allTokens.calls ? `; ${allTokens.calls} ${plural(allTokens.calls, 'вызов', 'вызова', 'вызовов')}` : ''
  }${cacheRead ? `; кэш ${humanTokens(cacheRead)} (${cacheShare}%)` : ''
  }${modelNames.length ? ` · ${modelNames.length} ${plural(modelNames.length, 'модель', 'модели', 'моделей')}` : ''}</span></div>
  <div class="card"><b>${gateMs ? humanDuration(gateMs) : '—'}</b><span>на воротах${
    gateTokens ? ` · ${humanTokens(gateTokens)}` : ''
  }</span></div>
  <div class="card${openBlockers.length ? ' alarm' : ''}"><b>${openBugs.length}</b><span>багов открыто${
    openBlockers.length ? ` · ${openBlockers.length} ${plural(openBlockers.length, 'блокирующий', 'блокирующих', 'блокирующих')}` : ''
  }</span></div>
</div>

<nav class="tabs" role="tablist">
  <button data-tab="status" aria-selected="true">Статусы</button>
  <button data-tab="timing" aria-selected="false">Тайминг</button>
  ${groom.length ? '<button data-tab="groom" aria-selected="false">Груминг</button>' : ''}
</nav>

<section data-tab="status">
  ${blockerBanner(openBlockers)}
  ${unboundBanner(unbound, working)}
  ${exclusivityBanner(tasks)}
  ${areasNote(root, change, tasks, cfg)}
  <div class="legend">${legend || '<span>Задач нет</span>'}</div>
  ${whyBlock(tasks, parallelism)}
  ${foldControl}
  ${graphBlock}
  ${statusTable(tasks, fixes, folded, outIds)}
  <h2>Баги поставки</h2>
  <p class="sub">Здесь — что нашли и к каким задачам это привязано. Разбор по источникам
  (какой контур ловит дефекты, а какой пропускает) — на вкладке «Тайминг».</p>
  ${bugsBlock(bugs, change, { stats: false })}
</section>

<section data-tab="timing" hidden>
  <p class="sub"><b>Два числа, и они отвечают на разные вопросы.</b> «Сколько поставка
  ШЛА» — ${humanDuration(dl.clean_ms)}: объединение интервалов, когда работала хоть одна
  стадия, из ${humanDuration(dl.calendar_ms)} календарных с ${esc(String(dl.started || '').slice(0, 10))}.
  Остальные ${humanDuration(dl.idle_ms)} — простой: ждут человека, пауза
  (${humanDuration(dl.pause_ms)}), промежутки между волнами. Открытую стадию пауза не
  прерывает — она доигрывает, и это время было работой, поэтому из работы пауза не
  вычитается. «Сколько поставка СТОИЛА» — ${humanDuration(totalClean)} чистого по задачам:
  календарное каждой задачи без ожидания человека и без паузы, сложенное. Второе число
  законно больше первого: задачи идут параллельно, и их интервалы накладываются.</p>
  <p class="sub">Календарное — от первого входа в работу до слияния. Активное — сумма стадий:
  ${humanDuration(totalActive)}. Разница есть ожидание, и она раскладывается на части:
  <b>${humanDuration(totalEngineWait)} ожидания движка</b> (слоты заняты, зависимости не влиты,
  накладные между стадиями) — это то, за что прогон отвечает и что имеет смысл уменьшать;${
    totalHuman ? ` ${humanDuration(totalHuman)} задачи ждали человека (от эскалации до следующего события);` : ''
  }${totalPause ? ` ${humanDuration(totalPause)} прогон стоял на паузе;` : ''} всего ожидания
  ${humanDuration(totalWait)}. Чужое время движку не предъявляется (ADR-0009), поэтому в карточке
  стоит его часть, а не сумма. Части человека и паузы часто накладываются, и вычитаются они
  ОБЪЕДИНЕНИЕМ: иначе одно и то же время вычлось бы дважды. <b>Это сумма по задачам, а не
  календарь поставки:</b> задачи идут параллельно, и их интервалы накладываются.</p>
  <p class="sub">Календарь задачи кончается там, где кончаются факты: у влитой — слиянием,
  у идущей — «сейчас» (работа происходит, и показывать её нулём нельзя, И-11), а у задачи,
  которую не влили и по которой стадий не идёт, — ПОСЛЕДНИМ СОБЫТИЕМ. Иначе остановленная
  задача добавляла бы в ожидание время, в котором с ней ничего не происходило, и сумма
  росла бы сама, пока на неё смотрят.${
    totalIdle
      ? ` Такой хвост не выброшен, он назван своим именем: без движения ${humanDuration(totalIdle)} по ${
          tasks.filter((t) => t.timing.idle_ms > 0).length
        } ${plural(tasks.filter((t) => t.timing.idle_ms > 0).length, 'задаче', 'задачам', 'задачам')}.`
      : ''
  }</p>
  <p class="sub">Токены — расход субагентов на стадиях задачи: сумма <code>usage</code> из их
  транскриптов, с кэшем. Работа оркестратора и команд сюда не входит — это не задача.
  <b>Число занижено</b>, и это известно: механические вызовы DevOps (зонд паузы,
  подготовка дерева, проверка полосы, запись события, слияние) событий не пишут, значит их
  расход — около пяти промптов на задачу — здесь не учтён вовсе.
  Всего ${humanTokens(totalTokens)} по ${countedTasks} ${plural(countedTasks, 'задаче', 'задачам', 'задачам')},
  из них ${humanTokens(totalOut)} вывода.
  ${dupe.agents
    ? `<b>Двойной счёт снят:</b> у ${dupe.agents} ${plural(dupe.agents, 'захода', 'заходов', 'заходов')}
  финишей больше одного (${dupe.extra_events} ${plural(dupe.extra_events, 'лишнее событие', 'лишних события', 'лишних событий')}),
  и каждый лишний несёт полный счёт заново. По заходу берётся максимум, а не сумма, — иначе
  показанное было бы больше на ${humanTokens(dupe.would_inflate_by)}. Сами события остаются в
  журнале: он только дописывается (ADR-0006), чинится чтение.`
    : 'Двойных финишей в журнале нет.'}</p>
  <p class="sub"><b>Числа «всего» включают кэш, и это не работа.</b> По журналу поставки:
  свежих (вход + выход) ${humanTokens(freshTokens)}, чтение кэша ${humanTokens(cacheRead)}
  (${cacheShare}% от ${humanTokens(allTokens.total)}), запись кэша
  ${humanTokens(allTokens.cache_write || 0)}. Чтение кэша — это перечитывание уже
  посланного контекста: величина настоящая и важная (она объясняет, почему длинные стадии
  дорожают), но она отвечает на вопрос «сколько раз перечитан контекст», а не «сколько
  сделано». Поэтому в сводке стоит свежее, а кэш назван рядом. Переводить одно в другое
  движок не станет: коэффициент — это цена, она разная у моделей и планов, а порог
  выражается в замеренном (ADR-0010).</p>
  ${timingTable(tasks)}
  <h2>Ворота поставки</h2>
  <p class="sub">В них упираются все задачи. MR-ревью ведёт QA по диффу целиком, демо
  показывают человеку — поэтому у ревью есть токены, а у демо их нет и быть не может:
  там идёт только время, и обычно это самый долгий интервал маршрута.</p>
  ${gatesTable(gate)}
  <h2>Расход по моделям</h2>
  <p class="sub">Задачи и ворота вместе. Роли идут на разных моделях нарочно, а цена
  токена различается в разы — поэтому суммарное число говорит «много», а «дорого»
  говорит только эта таблица. Цен движок не хранит: они меняются без него, и вшитый
  прайс устарел бы молча. Стоимость считается отсюда умножением.</p>
  ${modelsTable(allTokens.by_model, allTokens.total)}
  <h2>Ошибки по источнику</h2>
  ${bugsBlock(bugs, change)}
  <h2>Последние события</h2>
  ${eventsBlock(events)}
</section>

${groom.length ? `<section data-tab="groom" hidden>
  <p class="sub">Темы в разборе. Поставки по ним ещё нет — папку в <code>openspec/changes/</code>
  заводит планирование (ADR-0012), а до него тема живёт досье в бэклоге и своим рабочим
  деревом от <code>main</code>. Поэтому груминг не мешает идущей сборке и может идти в
  нескольких сессиях разом.</p>
  ${groomBlock(root, groom, groomNotes)}
</section>` : ''}

</div><script>${JS}</script></body></html>
`
  const dir = join(root, '.firm')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'dashboard.html')
  writeFileSync(out, html)
  return out
}

// Прямой запуск: node dashboard.mjs [change]
//
// Флаги отбрасываются, и это не придирка: `dashboard.mjs --json` принимал `--json` за имя
// поставки и честно собирал дашборд поставки «--json» — то есть пустой, поверх настоящего.
// Поймано 01.10.2026 на живом проекте. Имя поставки не может начинаться с дефиса, значит
// такой аргумент — заведомо флаг, и молча считать его именем нельзя.
if (import.meta.url === `file://${process.argv[1]}`) {
  const change = process.argv.slice(2).find((a) => !a.startsWith('-')) || null
  const p = buildDashboard(repoRoot(), change)
  process.stdout.write(p + '\n')
}
