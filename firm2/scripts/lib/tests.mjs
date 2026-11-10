// Разбор набора тестов: что в нём не окупается.
//
// Вопрос, на который движок не мог ответить. Критериальное покрытие у нас закрыто железно
// (каждый критерий закрыт тестом, Ревьюер судит по именам), мутационная проверка требует
// от Тестировщика доказать, что тест умеет падать. А обратного вопроса — «этот тест
// вообще за что-то платит» — не задавал никто, и набор только рос: 464 теста на движок,
// и ни одной причины что-либо из них снять.
//
// Приём взят из `test-audit` плагина gstack (`github.com/garrytan/gstack`, MIT): каталог
// малоценных образцов плюс — что важнее каталога — список того, что кандидатом НЕ
// становится никогда. Каталог суждения живёт в `skills/firm-test-audit/SKILL.md`; здесь
// только то, что доказывается чтением файла.
//
// ГРАНИЦА ЭТОГО ФАЙЛА. Машинная находка обязана быть предъявима строкой. Всё, где нужен
// вкус («тест дублирует соседний», «контракт это или не контракт»), сюда не попадает
// вовсе: образец, срабатывающий по догадке, обесценит и настоящие находки (тот же довод,
// что у образцов `secret-scan`). И ни одна находка не является приговором — движок
// предлагает кандидата, а снимает тест роль по карточке приёма — и снятое сверяется
// отдельно (`reviewRemovals` ниже, решение человека 10.11.2026).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTestPath, listCodeFiles } from './firm.mjs'

// Чем тест объявляется. Разбираем два семейства — их держат все проекты движка; на
// незнакомом языке честно отвечаем «не разбираю», а не гадаем (И-12).
const JS_TEST = /(?:^|[\s;{(])(?:it|test)\s*(?:\.\w+)?\s*\(\s*(['"`])([^'"`]{1,200})\1/
const PY_TEST = /^(\s*)(?:async\s+)?def\s+(test_\w+)\s*\(/

// Чем проверяется утверждение. Список длинный намеренно: тест без утверждения — самая
// дорогая находка каталога, и ложное срабатывание на незнакомой форме утверждения
// обесценит её первым же разбором.
const ASSERT = /\b(?:assert\w*|expect|should|chai|verify|toBe|toEqual|toMatch|toThrow|toHaveBeenCalled|pytest\.raises|assertRaises|require\.(?:Equal|NoError))\b/
// Строки, которые сами по себе проверкой не являются, но выглядят ею в грубом поиске.
const ASSERT_NOISE = /^\s*(?:\/\/|#|\*)/

// Пометка человека: тест снят с разбора. Причина ОБЯЗАТЕЛЬНА — тот же вид регулярки, что
// у оговорки `firm2: не секрет` (`lib/secrets.mjs`) и у стадийной проверки
// (`test-criteria-guard.mjs`): защита, снятая без записанной причины, хуже отсутствующей.
//
// Приём `firm-test-audit` обещал эту пометку с 0.4.86, а машинная половина разбора её не
// читала — то есть человек пометил, а находка всё равно печаталась. Найдено разбором
// стадии Тестировщика 21.10.2026: ровно та же асимметрия, что между двумя гвардами.
const KEEP = /firm2:\s*тест оставить\s*[—-]\s*\S/i

const JS_EXT = /\.(?:m|c)?[jt]sx?$/
const PY_EXT = /\.pyi?$/

// Тело теста по скобкам. Строки и комментарии пропускаются, и это не придирка: первый же
// прогон по собственному набору движка дал ЛОЖНУЮ находку — `}` внутри строкового литерала
// обрывал тело теста на середине, и тест с тремя утверждениями читался как «без
// утверждений» (`tests/mass.test.mjs:101`, 21.10.2026). Разбор, который врёт на своём же
// репозитории, обесценивает каждую свою находку.
function bodyFromBraces(text, from) {
  let depth = 0
  let started = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    // Строка любого из трёх видов: проматываем до её конца, считая экранирование.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === quote) break
        // В шаблонной строке `${...}` снова начинается код — но скобки внутри него
        // парные, поэтому для подсчёта глубины всю вставку можно пройти как текст.
        i++
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (ch === '{') {
      depth++
      started = true
    } else if (ch === '}') {
      depth--
      if (started && depth === 0) return text.slice(from, i + 1)
    }
  }
  return text.slice(from)
}

// Пометка считается на строке объявления и на строке ВЫШЕ: комментарий естественно ставят
// над тестом. Та же граница, что у `test-criteria-guard`.
function keptAt(text, index) {
  const before = text.slice(0, index)
  const lines = before.split('\n')
  const own = text.slice(index).split('\n')[0]
  const prev = lines.length > 1 ? lines[lines.length - 2] : ''
  return KEEP.test(own) || KEEP.test(prev)
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

// Тесты одного файла. Возвращает имя, строку и тело — дальше судит только вызывающий.
export function testsOf(rel, text) {
  const out = []
  if (JS_EXT.test(rel)) {
    const re = new RegExp(JS_TEST.source, 'g')
    let m
    while ((m = re.exec(text))) {
      const open = text.indexOf('{', m.index + m[0].length)
      if (open < 0) continue
      // Объявление теста узнаётся по символу ПЕРЕД `it`/`test` — и этот символ часто
      // перевод строки, то есть принадлежит предыдущей строке. Без сдвига каждая находка
      // указывала бы на строку выше нужной, а разбор, который врёт номером, бесполезен:
      // по нему нельзя открыть файл и увидеть то, о чём речь.
      const at = m.index + (/^[\s;{(]/.test(m[0]) ? 1 : 0)
      out.push({
        name: m[2],
        line: lineOf(text, at),
        body: bodyFromBraces(text, open),
        kept: keptAt(text, at),
      })
    }
    return out
  }
  if (PY_EXT.test(rel)) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(PY_TEST)
      if (!m) continue
      const indent = m[1].length
      const body = []
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        // Пустая строка тело не кончает: между блоками теста они обычны.
        if (l.trim() && (l.length - l.trimStart().length) <= indent) break
        body.push(l)
      }
      out.push({ name: m[2], line: i + 1, body: body.join('\n'), kept: KEEP.test(lines[i]) || (i > 0 && KEEP.test(lines[i - 1])) })
    }
    return out
  }
  return null // язык не разбираем — так и скажем, гадать не будем
}

function hasAssert(body) {
  return body
    .split('\n')
    .filter((l) => !ASSERT_NOISE.test(l))
    .some((l) => ASSERT.test(l))
}

// Самосравнение: обе стороны утверждения — одно и то же выражение. Такой тест проходит по
// построению и не может разойтись с кодом никогда (анти-образец «tautological» из скила
// `tdd`, который движок уже выдаёт Разработчику и Тестировщику).
const SELF_CMP = [
  /\bassert(?:\.\w+)?\s*\(\s*([^,()]{2,80}?)\s*,\s*\1\s*[,)]/,
  /\bexpect\s*\(\s*([^()]{2,80}?)\s*\)\s*\.\s*to(?:Be|Equal|StrictEqual)\s*\(\s*\1\s*\)/,
  /\bassert\s+([^\n=<>!]{2,80}?)\s*==\s*\1\s*$/m,
]

function selfCompare(body) {
  for (const re of SELF_CMP) {
    const m = body.match(re)
    if (m) return m[0].trim().slice(0, 120)
  }
  return null
}

/**
 * Разбор набора тестов проекта. Только доказуемое чтением файла:
 *   - тест без единого утверждения — он не может упасть, то есть не проверяет ничего;
 *   - самосравнение — проходит по построению;
 *   - два теста с одним именем в одном файле — по вердикту не отличить, который упал.
 * Всё остальное (дубли контрактов, грепы исходника, тест ради теста) — суждение, и оно в
 * приёме `firm-test-audit`, а не здесь.
 */
export function auditTests(root, config = null) {
  const files = listCodeFiles(root).filter((rel) => isTestPath(rel, config))
  const findings = []
  let tests = 0
  let parsed = 0
  let kept = 0
  const unparsed = new Set()

  for (const rel of files) {
    let text
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const list = testsOf(rel, text)
    if (list === null) {
      unparsed.add(rel.split('.').pop())
      continue
    }
    parsed++
    tests += list.length
    const names = new Map()
    for (const t of list) {
      // Снятый человеком с разбора — считаем и молчим. Имя всё равно запоминаем: дубль
      // имени мешает читать вердикт независимо от того, снят тест с разбора или нет.
      if (t.kept) {
        kept++
        if (!names.has(t.name)) names.set(t.name, t.line)
        continue
      }
      if (!hasAssert(t.body)) {
        findings.push({
          file: rel,
          line: t.line,
          test: t.name,
          rule: 'без утверждений',
          why: 'в теле нет ни одной проверки: тест не может упасть, то есть не проверяет ничего',
        })
      }
      const self = selfCompare(t.body)
      if (self) {
        findings.push({
          file: rel,
          line: t.line,
          test: t.name,
          rule: 'самосравнение',
          why: `обе стороны утверждения — одно выражение (${self}): проходит по построению и с кодом разойтись не может`,
        })
      }
      if (names.has(t.name)) {
        findings.push({
          file: rel,
          line: t.line,
          test: t.name,
          rule: 'имя-дубль',
          why: `имя уже занято тестом со строки ${names.get(t.name)}: по вердикту не отличить, который из двух упал`,
        })
      } else {
        names.set(t.name, t.line)
      }
    }
  }

  return {
    files: files.length,
    parsed_files: parsed,
    tests,
    kept,
    unparsed_ext: [...unparsed].sort(),
    findings,
  }
}

// ── Снятие теста: что из этого проверяемо машиной ───────────────────────────────────────
//
// Решение человека 10.11.2026: право снимать тесты у Тестировщика и Ревьюера есть. До него
// права не имела ни одна роль, и это стоило второго шага уборки: дифф, снимающий тест,
// Ревьюер почти наверняка отклонял, потому что никакого правила про законное снятие у него
// не было — был только запрет.
//
// Право не бывает голым, иначе оно отменяет тот довод, которым защищён каждый тест: тест —
// это чьё-то решение о том, что важно. Поэтому движок здесь делает ровно то, что умеет
// (CLAUDE.md, критерий машинных мест): **СВЕРЯЕТ и называет**, а судит роль, и её суждение
// записано карточкой приёма `firm-test-audit`.
//
// Что проверяемо чтением файлов — и больше здесь ничего нет:
//   • тест действительно снят (имя было в основании и его нет сейчас) — разница снимков;
//   • был ли он кандидатом МАШИННОГО разбора (три класса) — считается по телу из основания;
//   • помечен ли человеком «тест оставить» — читается тем же `KEEP`, что в разборе;
//   • назван ли инвариантом — снятие такого есть правка доменной модели, а не уборка.
//
// Чего здесь нет намеренно: «ловится ли это чем-то ещё». Это суждение (шаг 3 приёма), и
// машинного ответа у него нет — а значит нет и права молчать о нём: снятие без карточки
// возвращается как `требует карточки`, то есть «не знаю» с названной причиной (И-12), а не
// как разрешение.
// Граница слова здесь НЕ через `\b`: в JS `\b` считает словом только латиницу с цифрами,
// поэтому `\bИ-7` не совпадает никогда — ни в начале строки, ни после пробела. Проверено
// тестом, а не рассуждением: первая редакция пропускала `И-7` молча.
const INVARIANT_NAMED = /(?:^|[^A-Za-zА-Яа-яЁё0-9])И-\d+[а-я]?(?![0-9])/

function machineRule(t) {
  if (!hasAssert(t.body)) return 'без утверждений'
  if (selfCompare(t.body)) return 'самосравнение'
  return null
}

function gitAt(root, argv) {
  try {
    return execFileSync('git', ['-C', root, ...argv], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * Что снято относительно основания. `base` — ref основания (точка ветвления задачи или
 * ветка-цель). Сравнение идёт с РАБОЧИМ деревом, а не с HEAD: снятие, ещё не
 * закоммиченное, — это то же снятие, и спрашивают о нём до коммита.
 *
 * Возвращает `{ checked: false, why }`, если спросить не удалось. Пустой список при
 * `checked: false` не значит «ничего не снято» — это ровно та разница, которой стоит
 * `LEFTOVERS_SCHEMA` и которой не было у восьми имён отнесения (Д-65).
 */
export function reviewRemovals(root, { base, config = null } = {}) {
  if (!base) return { checked: false, why: 'не названо основание сравнения (--base <ref>)', removed: [], added: 0 }
  const status = gitAt(root, ['diff', '--name-status', '-M', base, '--'])
  if (status === null) {
    return {
      checked: false,
      why: `git не ответил на сравнение с «${base}» — ref не существует или это не репозиторий`,
      removed: [], added: 0,
    }
  }
  const removed = []
  let added = 0
  const files = []
  for (const line of status.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    const code = parts[0][0]
    // При переименовании (`R`) интересует путь-источник: тесты из него могли и не уехать.
    const rel = parts[1]
    if (!rel || !isTestPath(rel, config)) continue
    if (code !== 'D' && code !== 'M' && code !== 'R') continue
    const baseText = gitAt(root, ['show', `${base}:${rel}`])
    if (baseText === null) continue
    const was = testsOf(rel, baseText)
    if (was === null) {
      files.push({ file: rel, parsed: false, why: `язык файла разбору не поддаётся — что снято, движок не знает` })
      continue
    }
    const nowRel = code === 'R' ? parts[2] || rel : rel
    let nowText = null
    if (code !== 'D') {
      try {
        nowText = readFileSync(join(root, nowRel), 'utf8')
      } catch {
        nowText = null
      }
    }
    const now = nowText === null ? [] : (testsOf(nowRel, nowText) || [])
    const liveNames = new Set(now.map((t) => t.name))
    const wasNames = new Set(was.map((t) => t.name))
    added += now.filter((t) => !wasNames.has(t.name)).length
    files.push({ file: rel, parsed: true, was: was.length, now: now.length })
    for (const t of was) {
      if (liveNames.has(t.name)) continue
      const rule = machineRule(t)
      const verdict = t.kept || INVARIANT_NAMED.test(t.name)
        ? 'запрещено'
        : rule
          ? 'обосновано замером'
          : 'требует карточки'
      removed.push({
        file: rel,
        line: t.line,
        test: t.name,
        machine_candidate: rule,
        kept_by_human: !!t.kept,
        invariant_named: INVARIANT_NAMED.test(t.name),
        verdict,
        why: t.kept
          ? 'человек пометил «тест оставить — <причина>»: снятие отменяет записанное решение человека, и роль этого права не получала'
          : INVARIANT_NAMED.test(t.name)
            ? 'тест назван инвариантом: его снятие — правка доменной модели, а не уборка (CLAUDE.md)'
            : rule
              ? `машинный разбор называл его кандидатом (${rule}) — снятие обосновано замером, карточка нужна только на «чем ловится ещё»`
              : 'машинного довода за снятие нет: кандидатом разбор его не называл. Это не запрет — это требование карточки приёма firm-test-audit (что ловил, чем ловится ещё, чем доказано)',
      })
    }
  }
  return { checked: true, base, files, removed, added }
}
