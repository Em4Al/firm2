// Таблица ролей движка, снятая с исходника: что роль такое, кто её зовёт, какую схему ей
// при этом передают и что она сама объявила своим выходом.
//
// Зачем это отдельным модулем. Восемь разборов стадий (14–22.10.2026) дали один и тот же
// класс дефекта — **обе стороны провода написаны, а провода нет**, — и каждый раз его
// находили глазами, перечитывая исходник:
//
//   · ключ есть в схеме сборщика, а в промпте роли о нём не сказано (`ports`
//     у Разработчика, 0.4.91 — стадия не могла назвать порт, который у неё просили);
//   · в промпте объявлен выход, которого не передаёт ни один вызов (DevOps, 0.4.95);
//   · роль пишет стадию, а команда, которая её запускает, не несёт маркер
//     (`docs` и `design`, 0.4.94: 0 событий на 2 511 при 213 закрытых поставках);
//   · роль называет приём, которого нет (`mattpocock-skills:verify`, не существовал
//     никогда) или шаблон по пути, которого нет (пять путей, 0.4.88).
//
// Все четыре находки — машинные: они выводятся из исходника без суждения. Поэтому они
// переезжают сюда, а рубеж перестаёт держать их поимённым списком регулярок на каждую
// роль (шаг 3с), который отставал от жизни после каждого разбора: добавил роль или поле —
// проверяется само.
//
// ГРАНИЦА, и она важнее любой находки: модуль выводит ТОЛЬКО то, что записано формально.
// Что считать входом роли, зачем она нужна и как читать её выход — суждение, и его здесь
// нет и не будет. Схема «вход-выход восьми ролей» (`docs/how-it-works.md`) собирается из
// этого вывода примерно наполовину, вторая половина пишется человеком.
//
// Таблицы читаются ТЕКСТОМ, а не импортом, и это не лень: `firm-event.mjs` и
// `firm2-build.js` — не чистые модули. Первый при импорте исполняет свой CLI (печатает
// подсказку), второй вообще не модуль (рантайм оборачивает его тело в функцию, на верхнем
// уровне законен `return`). Проверять на расхождение надо там, где данные ЛЕЖАТ, —
// иначе появится третья копия таблицы, и расходиться станет уже ей.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter, STAGES } from './firm.mjs'

// Фраза-освобождение в разделе «Выход». DevOps получает схему от сборщика на каждой из
// пяти механических стадий и своих ключей там не придумывает — для него расхождение
// «ключ схемы не назван в промпте» законно и СКАЗАНО ВСЛУХ. Освобождение держится на
// тексте роли, а не на списке имён в этом файле: список имён — вторая копия решения.
const SCHEMA_FROM_PROMPT = /Схему даёт промпт стадии/

// Фраза-освобождение у точки вызова: «события стадии нет» и почему. Нужна потому, что
// роль в таблице `STAGE_BY_AGENT` имеет РОВНО ОДНУ стадию, а работ у неё бывает больше:
// Архитектор в сборке арбитрирует (`adjudicate`), а на планировании пишет спеку, и
// событие со стадией `adjudicate` на планировании было бы не дырой, а неправдой — а по
// доктрине движка (firm-event.mjs, fallbackTicket) ложь хуже дыры: дыру `doctor` показывает,
// ложь не ловит никто. Поэтому вызов без маркера законен, но причина пишется словами РЯДОМ
// С ВЫЗОВОМ: молчаливое исключение — это ровно тот дефект, который ищет этот модуль.
// Пробел здесь любой: фраза живёт в тексте команды, а текст переносится по строкам —
// `/события стадии нет/` не нашлась ровно там, где была написана, и проверка объявила
// дефектом свою же оговорку.
const NO_EVENT = /события\s+стадии\s+нет/

// Маркер — это не упоминание слова `FIRM2-TICKET`, а строка с ЗНАЧЕНИЕМ: `T-XXX`, `MR`
// или подстановка сборщика. Проверка на одно слово ловилась на собственном объяснении:
// абзац «маркера здесь нет намеренно, потому что…» читался ею как маркер, то есть текст,
// говорящий о ОТСУТСТВИИ привязки, выдавался за привязку. Форма взята та же, что у
// `TICKET_RE` в `firm-event.mjs`: расходиться двум формам одного маркера нельзя.
// `FIRM2-GROOM: G-XXX` — третья форма привязки, заведённая 25.10.2026: стадии разведки
// принадлежат ТЕМЕ, у которой ни тикета, ни поставки нет по устройству (ADR-0012). Для
// этой проверки она равноправна: вопрос здесь один — несёт ли вызов привязку вообще.
const MARKER = /FIRM2-(?:TICKET:\s*(?:T-[\w.]+|MR\b|\$\{|<)|GROOM:\s*(?:G-[\w.X]+|\$\{|<))/

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function list(dir, suffix) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).sort() : []
}

/** Таблица «роль → стадия журнала» из `firm-event.mjs`, включая legacy-псевдонимы. */
export function stageByAgent(engine) {
  const src = read(join(engine, 'scripts', 'firm-event.mjs'))
  const block = src.match(/const STAGE_BY_AGENT = \{([\s\S]*?)\n\}/)
  const out = {}
  if (!block) return out
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*'([^']+)':\s*'([^']+)'/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Карта `A` сборщика: ключ вызова → полное имя роли с префиксом плагина. */
export function workflowAgents(engine) {
  const src = read(join(engine, 'workflows', 'firm2-build.js'))
  const block = src.match(/const A = \{([\s\S]*?)\n\}/)
  const out = {}
  if (!block) return out
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(\w+):\s*'([^']+)'/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Схемы сборщика: имя константы → её ключи верхнего уровня. */
export function workflowSchemas(engine) {
  const src = read(join(engine, 'workflows', 'firm2-build.js'))
  const out = {}
  const re = /const (\w+_SCHEMA) = \{([\s\S]*?)\n\}/g
  let m
  while ((m = re.exec(src))) {
    // Построчные комментарии снимаются ДО разбора: половина схем сборщика объяснена
    // комментарием между полями (`ports`, `report`, `mutation_check` — у каждого свой
    // абзац), а комментарий — это текст со скобками и запятыми, то есть ровно то, что
    // сбивает разбор ключей. До 22.10.2026 из-за этого терялось поле, стоявшее СРАЗУ
    // после абзаца, — то есть проверка молчала именно там, где поле объяснено.
    const props = m[2].replace(/^\s*\/\/.*$/gm, '').match(/properties:\s*\{([\s\S]*)/)
    out[m[1]] = props ? keysAtTop(props[1]) : []
  }
  return out
}

// Ключи верхнего уровня внутри фигурных скобок. Читается посимвольно, потому что
// вложенные объекты (`report: { total, passed }`) и массивы здесь обычны, а регулярка на
// `(\w+):` собрала бы и их поля — то есть нашла бы «ключ, которого роль не назвала» там,
// где роль назвала всё.
function keysAtTop(text) {
  const keys = []
  let depth = 0
  let head = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth < 0) break // вышли из блока: дальше чужой текст
    } else if (ch === ',' && depth === 0) head = true
    else if (head && /[A-Za-z_]/.test(ch)) {
      const name = text.slice(i).match(/^[A-Za-z_]\w*/)[0]
      keys.push(name)
      i += name.length - 1
      head = false
    } else if (!/\s/.test(ch)) head = false
  }
  return [...new Set(keys)]
}

// Ключи, которые роль объявила своим выходом. Раздел у всех восьми ролей называется
// одинаково («## Выход (structured output)»), а внутри лежат блоки в обратных кавычках —
// по одному на режим (у PM их три: вопросы, готово на груминге, готово на планировании).
function declaredOutput(body) {
  const sec = body.match(/\n##+ Выход[^\n]*\n([\s\S]*?)(?=\n##+ |$)/)
  if (!sec) return null
  const keys = []
  for (const block of braceBlocks(sec[1])) keys.push(...keysAtTop(block))
  return { keys: [...new Set(keys)], text: sec[1] }
}

// Блоки в фигурных скобках ВЕРХНЕГО уровня. Ленивая регулярка `\{.*?\}` обрывалась на
// первой закрывающей скобке, а у половины ролей выход вложенный (`report: { total, … }`),
// и дальше разбор считал ключи вложенного объекта ключами выхода: у Тестировщика вместо
// `skipped_why`, `mutation_check` и `ports` выходили `done`, `evidence`, `why_not`.
function braceBlocks(text) {
  const out = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i + 1
      depth++
    } else if (text[i] === '}') {
      depth--
      if (depth === 0 && start >= 0) out.push(text.slice(start, i))
      if (depth < 0) depth = 0
    }
  }
  return out
}

// Есть ли в промпте маркер задачи. Промпт у половины вызовов собран НЕ на месте: панель
// Ревьюера получает готовую строку переменной, а строит её `qaPrompt()`. Проверка «ищем
// `marks(` в тексте вызова» объявила бы такой вызов беззмаркерным — то есть нашла бы
// дефект там, где всё на месте, а это хуже, чем не найти: красноту, которую нечем
// погасить, начинают обходить. Поэтому имена из выражения промпта разворачиваются на два
// уровня: `prompt` → `const prompt = qaPrompt(...)` → `function qaPrompt()`. Глубже не
// идём: третий уровень — это уже не сборка промпта, а чтение программы целиком.
function hasMarker(src, expr, depth) {
  if (MARKER.test(expr)) return true
  if (depth <= 0) return false
  for (const id of new Set(expr.match(/[A-Za-z_]\w*/g) || [])) {
    const def = src.match(new RegExp(`(?:const|let|function)\\s+${id}\\b([\\s\\S]{0,1200})`))
    if (def && hasMarker(src, def[1], depth - 1)) return true
  }
  return false
}

// Точки вызова в сборщике. Маркер ищется не в опциях, а в ПРОМПТЕ: его кладёт `marks()`,
// и роль без него напишет событие с `ticket: unknown` — вечную красноту `doctor` на
// неизменяемом журнале (ADR-0006).
function workflowCalls(engine, agents) {
  const src = read(join(engine, 'workflows', 'firm2-build.js'))
  const calls = []
  const re = /agentType:\s*A\.(\w+)/g
  let m
  while ((m = re.exec(src))) {
    const opts = src.slice(m.index, m.index + 400)
    const schema = (opts.match(/schema:\s*(\w+)/) || [])[1] || null
    const label = (opts.match(/label:\s*[`'"]([^`'"]+)/) || [])[1] || ''
    const start = src.lastIndexOf('agent(', m.index)
    const prompt = start >= 0 ? src.slice(start, m.index) : ''
    calls.push({
      kind: 'сборщик',
      key: m[1],
      agent: agents[m[1]] || null,
      where: `workflows/firm2-build.js:${src.slice(0, m.index).split('\n').length}`,
      label,
      schema,
      marker: hasMarker(src, prompt, 2),
      no_event: NO_EVENT.test(src.slice(Math.max(0, m.index - 600), m.index + 200)),
    })
  }
  return calls
}

// Точки вызова в текстах команд. Схемы здесь нет по устройству: команду исполняет
// оркестратор в сессии человека, и структуру выхода он просит словами.
function commandCalls(engine) {
  const calls = []
  for (const file of list(join(engine, 'commands'), '.md')) {
    const src = read(join(engine, 'commands', file))
    const re = /Запусти\s+`?(firm2:firm-[\w-]+)`?/g
    let m
    while ((m = re.exec(src))) {
      calls.push({
        kind: 'команда',
        agent: m[1],
        where: `commands/${file}:${src.slice(0, m.index).split('\n').length}`,
        label: `/${file.replace(/\.md$/, '')}`,
        schema: null,
        // Маркер в тексте команды стоит рядом с запуском — окно намеренно короткое:
        // проверка, видящая чужой абзац, не проверяет ничего (разбор PM, 0.4.93).
        marker: MARKER.test(src.slice(m.index, m.index + 300)),
        no_event: NO_EVENT.test(src.slice(Math.max(0, m.index - 300), m.index + 300)),
      })
    }
  }
  return calls
}

/**
 * Таблица ролей движка и находки по ней.
 *
 * Находки — расхождения между формальными сторонами одного провода, а не суждения о
 * тексте. Код возврата по ним не выносится: судит рубеж (шаг 3у), печатает — CLI.
 */
export function rolesTable(engine) {
  const stages = stageByAgent(engine)
  const agents = workflowAgents(engine)
  const schemas = workflowSchemas(engine)
  const calls = [...workflowCalls(engine, agents), ...commandCalls(engine)]
  const skills = existsSync(join(engine, 'skills'))
    ? readdirSync(join(engine, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : []
  const commands = list(join(engine, 'commands'), '.md').map((f) => f.replace(/\.md$/, ''))
  const findings = []
  const roles = []

  const files = list(join(engine, 'agents'), '.md')
  const names = files.map((f) => String(parseFrontmatter(read(join(engine, 'agents', f))).data.name || f.replace(/\.md$/, '')))

  for (const file of files) {
    const text = read(join(engine, 'agents', file))
    const { data, body } = parseFrontmatter(text)
    const name = String(data.name || file.replace(/\.md$/, ''))
    const full = `firm2:${name}`
    const mine = calls.filter((c) => c.agent === full)
    const stage = stages[full] || null

    // Приёмы: роль называет их обратными кавычками. Имя роли и имя команды из набора
    // исключаются — иначе `firm-build` в тексте сойдёт за ненайденный приём.
    const named = [...new Set((body.match(/`firm-[a-z-]+`/g) || []).map((s) => s.slice(1, -1)))]
      .filter((n) => !names.includes(n) && !commands.includes(n))
    const used = named.filter((n) => skills.includes(n))
    const missingSkills = named.filter((n) => !skills.includes(n))

    // Шаблоны: путь, названный в теле прямым текстом. Пять таких путей не разрешались
    // (0.4.88) — ссылка в промпте, по которой роль не может ничего прочитать.
    const refs = [...new Set((body.match(/templates\/[\w./-]+\.md/g) || []))]
    const missingTemplates = refs.filter((r) => !existsSync(join(engine, r)))

    const out = declaredOutput(body)
    const exempt = Boolean(out && SCHEMA_FROM_PROMPT.test(out.text))
    const schemaKeys = [...new Set(mine.flatMap((c) => (c.schema && schemas[c.schema]) || []))]

    roles.push({
      name,
      path: `agents/${file}`,
      model: String(data.model || ''),
      tools: String(data.tools || '').split(',').map((s) => s.trim()).filter(Boolean),
      own_chars: text.length,
      stage,
      stage_aliases: Object.keys(stages).filter((k) => stages[k] === stage && k !== full),
      calls: mine.map((c) => ({
        kind: c.kind, where: c.where, label: c.label, schema: c.schema, marker: c.marker, no_event: c.no_event,
      })),
      schemas: [...new Set(mine.map((c) => c.schema).filter(Boolean))],
      schema_keys: schemaKeys,
      declared_output: out ? out.keys : null,
      schema_from_prompt: exempt,
      skills: used,
      templates: refs,
    })

    // ── Находки ──────────────────────────────────────────────────────────────
    if (!mine.length) {
      findings.push(`роль ${name} не зовётся нигде: ни в сборщике, ни в тексте команды — стадии нет, хотя промпт написан`)
    }
    if (stage && !STAGES.includes(stage)) {
      findings.push(`роль ${name} пишет стадию «${stage}», которой нет в словаре STAGES (lib/firm.mjs)`)
    }
    for (const c of mine) {
      if (stage && !c.marker && !c.no_event) {
        findings.push(
          `роль ${name} пишет стадию «${stage}», а вызов ${c.where} не несёт ни маркер FIRM2-TICKET, ни причину, ` +
            `почему события стадии нет: тикет на финише хук берёт из промпта (fromTranscript), и без маркера ` +
            `событие уйдёт с ticket: unknown`,
        )
      }
    }
    if (!out) {
      findings.push(`у роли ${name} нет раздела «Выход»: чем стадия отвечает — не сказано`)
    } else if (!exempt) {
      for (const key of schemaKeys) {
        if (!out.keys.includes(key)) {
          findings.push(
            `ключ ${key} схемы ${mine.map((c) => c.schema).filter(Boolean).join('/')} передаётся роли ${name}, ` +
              `а в её разделе «Выход» не назван: стадия не знает, что у неё это просят`,
          )
        }
      }
    }
    for (const n of missingSkills) findings.push(`роль ${name} называет приём ${n}, которого нет в skills/`)
    for (const r of missingTemplates) findings.push(`роль ${name} называет шаблон ${r}, которого нет в движке`)
  }

  // Роль, объявленная в карте `A` сборщика и не использованная ни одним вызовом. Это не
  // придирка: `docwriter` простоял в карте неиспользованным (его зовёт команда, а не
  // сборщик), и объявление читалось как «сборщик умеет эту стадию».
  const usedKeys = new Set(calls.filter((c) => c.kind === 'сборщик').map((c) => c.key))
  for (const [key, full] of Object.entries(agents)) {
    if (!usedKeys.has(key)) findings.push(`в карте A сборщика объявлена роль ${key} (${full}), а ни один вызов её не берёт`)
  }

  return { roles, calls, schemas, stages, findings }
}

/** Человеческий вывод: одна карточка на роль плюс находки. */
export function rolesLines(table) {
  const out = []
  for (const r of table.roles) {
    out.push(
      `${r.name}  модель ${r.model || '—'}  стадия ${r.stage || '— (события не пишет)'}  ${r.own_chars} символов`,
    )
    out.push(`  инструменты: ${r.tools.join(' ') || '—'}`)
    out.push(`  приёмы: ${r.skills.join(', ') || '—'}`)
    out.push(`  шаблоны: ${r.templates.join(', ') || '—'}`)
    out.push(`  выход: ${r.declared_output ? r.declared_output.join(' ') : '— раздела нет'}${r.schema_from_prompt ? ' (схему даёт промпт стадии)' : ''}`)
    if (r.schema_keys.length) out.push(`  схемы вызовов: ${r.schemas.join(', ')} → ${r.schema_keys.join(' ')}`)
    for (const c of r.calls) {
      const mark = c.marker ? 'маркер есть' : c.no_event ? 'события стадии нет (сказано)' : 'маркера нет'
      out.push(`  зовёт ${c.kind} ${c.where} ${c.label ? `«${c.label}» ` : ''}${c.schema ? `${c.schema} ` : ''}${mark}`)
    }
    out.push('')
  }
  out.push(
    table.findings.length
      ? `находки (${table.findings.length}):\n${table.findings.map((f) => `  · ${f}`).join('\n')}`
      : 'расхождений нет: каждый ключ схемы назван в промпте, каждая стадия зовётся с маркером',
  )
  return out
}
