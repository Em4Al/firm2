// Счёт контекста движка: сколько своих текстов firm2 кладёт в окно до того, как начнётся
// работа.
//
// Вопрос возник из сравнения с gstack (`context-bill`): движок меряет массу продукта и
// массу тестов проекта (`firm-state mass`), окупаемость набора тестов (`test-audit`) — а
// собственную массу не мерял ничем. При этом она тратится первой и каждый раз: описания
// команд и ролей лежат в окне с начала сессии, тело команды дочитывается целиком при
// вызове, тело роли — при запуске стадии.
//
// ГРАНИЦА ПЕРВАЯ, и она важнее числа: **контексты не складываются**. Подагент получает
// своё окно, поэтому тело Тестировщика не прибавляется к окну оркестратора. Один общий
// итог «движок стоит N» был бы неправдой — счёт разложен по окнам, в которых он реально
// возникает.
//
// ГРАНИЦА ВТОРАЯ: в символах здесь ЗАМЕР, в токенах — ПЕРЕСЧЁТ по видимому коэффициенту.
// Точного токенизатора у движка нет и не будет (ADR-0010: без внешних зависимостей), а
// домашнее правило «правило без замера — вкус» распространяется и на этот файл. Поэтому
// все пороги находок выражены в СИМВОЛАХ, то есть в замеренном, а токены стоят рядом
// справочно и подписаны как оценка. Проект, у которого есть собственный замер (например
// из `/context`), пишет его в `.firm/config`:
//
//   context:
//     chars_per_token_cyr: 2.1
//     chars_per_token_other: 3.8
//
// ГРАНИЦА ТРЕТЬЯ: счёт — это пол, а не потолок. В окне оркестратора лежат ещё CLAUDE.md
// проекта, выводы скриптов, диффы и сам разговор; движок не знает их размера и не делает
// вид, что знает (И-12).
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter, STANDARDS_DIR } from './firm.mjs'

// Пересчёт символов в токены. Кириллица тратится дороже латиницы — это свойство
// токенизатора, не выбор движка. Числа по умолчанию взяты как порядок величины и
// перекрываются замером проекта; именно поэтому ни одна находка на них не опирается.
export const CTX_RATIO = { cyr: 2, other: 4 }

// Бюджеты находок — в символах. Это ВЫБОР, а не замер, и он назван выбором: каждый порог
// поставлен чуть выше нынешнего самого тяжёлого текста движка, то есть ловит рост, а не
// текущее состояние. Проект вправе их сдвинуть (`context.budget_*` в `.firm/config`).
export const CTX_BUDGET = {
  // Описание лежит в окне ВСЕГДА и у каждой сессии; самое длинное сейчас — 285 символов.
  description: 400,
  // Тело команды дочитывается целиком при вызове; самое тяжёлое сейчас — /firm-build.
  command: 26000,
  // Тело приёма дочитывается целиком при вызове роли.
  skill: 8000,
  // Стадия: роль плюс приёмы, которые она зовёт, плюс стандарты, если она их читает.
  stage: 26000,
}

function countChars(text) {
  const s = String(text)
  let cyr = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c >= 0x0400 && c <= 0x04ff) || c === 0x0451 || c === 0x0401) cyr++
  }
  return { chars: s.length, cyr, other: s.length - cyr }
}

export function estimateTokens(text, ratio = CTX_RATIO) {
  const { cyr, other } = countChars(text)
  const rc = Number(ratio.cyr) > 0 ? Number(ratio.cyr) : CTX_RATIO.cyr
  const ro = Number(ratio.other) > 0 ? Number(ratio.other) : CTX_RATIO.other
  return Math.round(cyr / rc + other / ro)
}

function readMd(path) {
  if (!existsSync(path)) return null
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const { data, body } = parseFrontmatter(text)
  return { text, data: data || {}, body }
}

function ratioOf(config) {
  const c = (config && config.context) || {}
  const cyr = Number(c.chars_per_token_cyr)
  const other = Number(c.chars_per_token_other)
  const measured = cyr > 0 || other > 0
  return {
    cyr: cyr > 0 ? cyr : CTX_RATIO.cyr,
    other: other > 0 ? other : CTX_RATIO.other,
    measured,
  }
}

function budgetOf(config) {
  const c = (config && config.context) || {}
  const pick = (key, dflt) => (Number(c[`budget_${key}`]) > 0 ? Number(c[`budget_${key}`]) : dflt)
  return {
    description: pick('description', CTX_BUDGET.description),
    command: pick('command', CTX_BUDGET.command),
    skill: pick('skill', CTX_BUDGET.skill),
    stage: pick('stage', CTX_BUDGET.stage),
  }
}

/**
 * Счёт контекста движка по его собственным файлам.
 *
 * Возвращает не один итог, а три окна: что лежит в сессии всегда (описания), во что
 * обходится вызов команды и во что — запуск стадии. Складывать их между собой нельзя, и
 * в выводе это сказано словами.
 */
export function contextBill(engine, config = null) {
  const ratio = ratioOf(config)
  const budget = budgetOf(config)
  const tok = (t) => estimateTokens(t, ratio)
  const findings = []
  const all = []

  const read = (dir, file) => readMd(join(engine, dir, file))
  const list = (dir, suffix) =>
    existsSync(join(engine, dir))
      ? readdirSync(join(engine, dir)).filter((f) => f.endsWith(suffix)).sort()
      : []

  // ── Приёмы ───────────────────────────────────────────────────────────────
  const skills = []
  const skillDirs = existsSync(join(engine, 'skills'))
    ? readdirSync(join(engine, 'skills'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : []
  for (const name of skillDirs) {
    const md = readMd(join(engine, 'skills', name, 'SKILL.md'))
    if (!md) continue
    const desc = String(md.data.description || '')
    const item = {
      name,
      path: `skills/${name}/SKILL.md`,
      chars: md.text.length,
      tokens: tok(md.text),
      desc,
      desc_chars: desc.length,
      used_by: [],
    }
    skills.push(item)
    all.push({ kind: 'приём', name, path: item.path, chars: item.chars, tokens: item.tokens })
    if (desc.length > budget.description) {
      findings.push(
        `описание приёма ${name} — ${desc.length} символов (бюджет ${budget.description}): описание лежит в окне каждой сессии, независимо от того, зовут приём или нет`,
      )
    }
    if (item.chars > budget.skill) {
      findings.push(
        `приём ${name} — ${item.chars} символов (бюджет ${budget.skill}): тело дочитывается целиком при вызове`,
      )
    }
  }

  // ── Команды ──────────────────────────────────────────────────────────────
  const commands = []
  for (const file of list('commands', '.md')) {
    const md = read('commands', file)
    if (!md) continue
    const name = `/${file.replace(/\.md$/, '')}`
    const desc = String(md.data.description || '')
    const item = {
      name,
      path: `commands/${file}`,
      chars: md.text.length,
      tokens: tok(md.text),
      desc,
      desc_chars: desc.length,
    }
    commands.push(item)
    all.push({ kind: 'команда', name, path: item.path, chars: item.chars, tokens: item.tokens })
    if (desc.length > budget.description) {
      findings.push(
        `описание команды ${name} — ${desc.length} символов (бюджет ${budget.description}): описание лежит в окне каждой сессии`,
      )
    }
    if (item.chars > budget.command) {
      findings.push(
        `команда ${name} — ${item.chars} символов (бюджет ${budget.command}): тело дочитывается целиком при вызове`,
      )
    }
  }

  // ── Стандарты кода: их дочитывает стадия, которая судит по осям ──────────
  const standards = []
  const stdDir = join(engine, 'templates', 'standards')
  for (const file of existsSync(stdDir) ? readdirSync(stdDir).filter((f) => f.endsWith('.md')).sort() : []) {
    const text = readFileSync(join(stdDir, file), 'utf8')
    standards.push({ name: file, path: `templates/standards/${file}`, chars: text.length, tokens: tok(text) })
  }

  // ── Роли и стадии ────────────────────────────────────────────────────────
  // Какие приёмы зовёт роль, спрашивается у её текста, а не у таблицы: таблица разойдётся
  // с промптом на первой же правке промпта, и счёт станет врать молча.
  //
  // Счёт стадии — ВЕРХНЯЯ ГРАНИЦА, и называть его иначе было бы неправдой в обе стороны.
  // Всегда читается только тело роли; приём попадает в окно, когда роль его позвала, а
  // стандарты — те, что разложены в конкретном проекте (`python.md` в JS-проекте не
  // лежит). Поэтому у роли два числа: `own_chars` — что тратится наверняка, `chars` — до
  // чего может дойти.
  const roles = []
  for (const file of list('agents', '.md')) {
    const md = read('agents', file)
    if (!md) continue
    const name = String(md.data.name || file.replace(/\.md$/, ''))
    const desc = String(md.data.description || '')
    const parts = [{ kind: 'роль', name, path: `agents/${file}`, chars: md.text.length, tokens: tok(md.text) }]
    for (const s of skills) {
      if (new RegExp(`\\b${s.name}\\b`).test(md.body)) {
        s.used_by.push(name)
        parts.push({ kind: 'приём', name: s.name, path: s.path, chars: s.chars, tokens: s.tokens })
      }
    }
    // Стандарты читает та роль, которая сама назвала их каталог.
    if (md.body.includes(STANDARDS_DIR)) {
      for (const st of standards) parts.push({ kind: 'стандарт', ...st })
    }
    // Любой ДРУГОЙ шаблон движка, названный в теле роли, тоже попадает в окно — и до
    // 0.4.88 счёт его не видел. Разбор стадии Ревьюера 21.10.2026: роль читает
    // `templates/lint-policy.md` (3242 символа) на каждом красном линте, а счёт считал
    // только `templates/standards/*`. Недосчёт был не у одной роли: Архитектор и PM читают
    // `groom-dossier.md` и `openspec-conventions.md`, DevOps — `definition-of-done.md`.
    // Замер, который не видит того, что названо в тексте прямым путём, занижает молча.
    //
    // Шаблон, названный ВНУТРИ шаблона, считается тоже — на один уровень. Разбор стадии
    // DevOps 22.10.2026: инструкции его режимов уехали из тела роли в
    // `templates/devops-modes.md`, а DoD называет уже он, — и счёт потерял 2 157 символов
    // молча, то есть «похудевшая» роль выглядела дешевле, чем есть. Глубже одного уровня
    // не идём намеренно: шаблон, называющий шаблон, который называет шаблон, — это уже
    // не дочитывание стадии, а чтение документации, и счёт стал бы гадать.
    const seen = new Set()
    const refsOf = (text) => new Set(text.match(/templates\/[\w./-]+\.md/g) || [])
    const addTemplate = (ref, depth) => {
      const rel = ref.replace(/^.*templates\//, 'templates/')
      if (rel.startsWith('templates/standards/')) return // учтены выше, целым каталогом
      if (seen.has(rel)) return
      const path = join(engine, rel)
      if (!existsSync(path)) return
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return
      }
      seen.add(rel)
      parts.push({ kind: 'шаблон', name: rel.replace('templates/', ''), path: rel, chars: text.length, tokens: tok(text) })
      if (depth > 0) for (const inner of refsOf(text)) addTemplate(inner, depth - 1)
    }
    for (const ref of refsOf(md.body)) addTemplate(ref, 1)
    const chars = parts.reduce((a, p) => a + p.chars, 0)
    const item = {
      name,
      path: `agents/${file}`,
      own_chars: md.text.length,
      desc,
      desc_chars: desc.length,
      chars,
      tokens: parts.reduce((a, p) => a + p.tokens, 0),
      parts,
    }
    roles.push(item)
    all.push({ kind: 'роль', name, path: item.path, chars: md.text.length, tokens: parts[0].tokens })
    if (desc.length > budget.description) {
      findings.push(
        `описание роли ${name} — ${desc.length} символов (бюджет ${budget.description}): описание лежит в окне каждой сессии`,
      )
    }
    if (chars > budget.stage) {
      findings.push(
        `стадия ${name} — до ${chars} символов движка (бюджет ${budget.stage}): роль ${md.text.length} читается всегда, ` +
          `${parts.length - 1} текста (${parts.slice(1).map((x) => x.name).join(', ')}) дочитываются, когда их позовут — и это ДО тикета`,
      )
    }
  }

  // ── Окно, которое есть всегда: описания ──────────────────────────────────
  // Описания считаются по своему тексту, а не по сумме длин: пересчёт у кириллицы и
  // латиницы разный, и складывать символы, чтобы потом поделить на один коэффициент,
  // значит придумать себе число.
  const descTexts = [
    ...commands.map((c) => c.desc),
    ...roles.map((r) => r.desc),
    ...skills.map((s) => s.desc),
  ].join('\n')
  const always = {
    chars:
      commands.reduce((a, c) => a + c.desc_chars, 0) +
      roles.reduce((a, r) => a + r.desc_chars, 0) +
      skills.reduce((a, s) => a + s.desc_chars, 0),
    tokens: tok(descTexts),
    counts: { commands: commands.length, roles: roles.length, skills: skills.length },
  }

  all.sort((a, b) => b.chars - a.chars)
  const sessions = commands.slice().sort((a, b) => b.chars - a.chars)
  const stages = roles.slice().sort((a, b) => b.chars - a.chars)

  return {
    ratio,
    budget,
    always,
    commands: sessions,
    roles: stages,
    skills,
    standards,
    heaviest: all.slice(0, 8),
    totals: {
      files: all.length + standards.length,
      chars: all.reduce((a, x) => a + x.chars, 0) + standards.reduce((a, x) => a + x.chars, 0),
    },
    findings,
  }
}

function t(n) {
  return `~${n} ток.`
}

export function contextBillLines(b) {
  const out = []
  out.push(
    `пересчёт: 1 токен ≈ ${b.ratio.cyr} симв. кириллицы / ${b.ratio.other} прочих` +
      (b.ratio.measured ? ' (замер проекта)' : ' (оценка по умолчанию, не замер)'),
  )
  out.push('')
  out.push(
    `в окне ВСЕГДА: ${b.always.chars} символов, ${t(b.always.tokens)} — описания ` +
      `${b.always.counts.commands} команд, ${b.always.counts.roles} ролей, ${b.always.counts.skills} приёмов`,
  )
  if (b.commands.length) {
    const c = b.commands[0]
    out.push(`самая тяжёлая команда: ${c.name} — ${c.chars} символов, ${t(c.tokens)}`)
  }
  if (b.roles.length) {
    const r = b.roles[0]
    const extra = r.parts.length - 1
    out.push(
      `самая тяжёлая стадия: ${r.name} — роль ${r.own_chars} символов всегда` +
        (extra ? `, до ${r.chars} символов (${t(r.tokens)}) с ${extra} дочитываемыми текстами` : ''),
    )
    out.push('  (верхняя граница: приём попадает в окно, когда роль его позвала, а стандарты — те, что разложены в проекте)')
  }
  out.push('')
  out.push('эти три числа НЕ складываются: у подагента своё окно, а не продолжение окна сессии.')
  out.push('')
  out.push('тяжелейшие тексты движка:')
  for (const h of b.heaviest) out.push(`  ${String(h.chars).padStart(6)} симв.  ${h.path}`)
  const unused = b.skills.filter((s) => s.used_by.length === 0).map((s) => s.name)
  if (unused.length) {
    out.push('')
    out.push(
      `приёмы, которых не называет ни одна роль: ${unused.join(', ')} — их описания в окне ` +
        'всё равно лежат, а зовёт их человек или команда (это не находка, а факт для сверки)',
    )
  }
  out.push('')
  if (b.findings.length) {
    out.push('находки:')
    for (const f of b.findings) out.push(`  • ${f}`)
  } else {
    out.push('находок нет: все тексты движка в пределах объявленных бюджетов')
  }
  out.push('')
  out.push(
    `итого текстов движка: ${b.totals.chars} символов в ${b.totals.files} файлах. Это ПОЛ счёта, ` +
      'а не весь: CLAUDE.md проекта, выводы скриптов, диффы и сам разговор движок не знает и не считает.',
  )
  return out
}
