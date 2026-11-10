// Счёт контекста движка.
//
// Главное, что держат эти тесты, — не арифметика, а то, чем счёт НЕ является. Три
// границы, каждую легко потерять при следующей правке, и каждая потеря делает число
// убедительным и неверным одновременно:
//
//   1. окна не складываются — у подагента своё, и общий итог «движок стоит N» был бы
//      ложью;
//   2. счёт стадии — верхняя граница: всегда читается только тело роли;
//   3. в символах замер, в токенах пересчёт по видимому коэффициенту, и ни одна находка
//      на токенах не стоит — иначе бюджет держался бы на невымеренном числе
//      («правило без замера — вкус»).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { contextBill, contextBillLines, estimateTokens, CTX_BUDGET } from '../scripts/lib/context.mjs'
import { ENGINE } from './helpers.mjs'

function lay(root, rel, text) {
  mkdirSync(join(root, dirname(rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

// Оснастка — игрушечный «движок»: одна команда, одна роль, один приём.
function fakeEngine(t, { roleBody = 'Зови приём `firm-toy`.', skillChars = 100, cmdChars = 100 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'firm2-ctx-'))
  if (t && typeof t.after === 'function') t.after(() => rmSync(root, { recursive: true, force: true }))
  lay(root, 'commands/firm-toy.md', `---\ndescription: Команда-игрушка.\n---\n\n${'я'.repeat(cmdChars)}\n`)
  lay(root, 'agents/toy.md', `---\nname: firm-toy-role\ndescription: Роль-игрушка.\n---\n\n${roleBody}\n`)
  lay(root, 'skills/firm-toy/SKILL.md', `---\nname: firm-toy\ndescription: Приём-игрушка.\n---\n\n${'я'.repeat(skillChars)}\n`)
  return root
}

test('счёт разложен по окнам, и общего итога «движок стоит N» в нём нет', (t) => {
  const b = contextBill(fakeEngine(t), null)
  assert.equal(b.commands.length, 1)
  assert.equal(b.roles.length, 1)
  assert.ok(b.always.chars > 0)
  // Ни одно поле не называет сумму окон: складывать окно сессии с окном подагента нельзя.
  assert.equal(Object.hasOwn(b, 'total_tokens'), false)
  assert.match(contextBillLines(b).join('\n'), /НЕ складываются/)
})

test('стадия названа верхней границей: тело роли отделено от дочитываемого', (t) => {
  const b = contextBill(fakeEngine(t, { skillChars: 5000 }), null)
  const r = b.roles[0]
  assert.equal(r.parts[0].kind, 'роль')
  assert.equal(r.parts[1].name, 'firm-toy')
  assert.ok(r.chars > r.own_chars, 'верхняя граница обязана быть больше «всегда»')
  assert.equal(r.own_chars, r.parts[0].chars)
  assert.match(contextBillLines(b).join('\n'), /верхняя граница/)
})

test('приёмы роли берутся из её текста, а не из таблицы', (t) => {
  const b = contextBill(fakeEngine(t, { roleBody: 'Приёмов не зову.' }), null)
  assert.equal(b.roles[0].parts.length, 1)
  assert.equal(b.roles[0].chars, b.roles[0].own_chars)
  assert.deepEqual(b.skills[0].used_by, [])
  assert.match(contextBillLines(b).join('\n'), /не называет ни одна роль/)
})

test('стандарты попадают в стадию только той роли, которая назвала их каталог', (t) => {
  const root = fakeEngine(t, { roleBody: 'Читай docs/standards/common.md.' })
  lay(root, 'templates/standards/common.md', 'я'.repeat(3000))
  // Вторая роль стандартов не читает, и девять тысяч символов ей вешать не за что:
  // стадия, которой приписали чужое чтение, — это завышенный счёт, то есть такая же
  // ложь, как заниженный.
  lay(root, 'agents/mute.md', '---\nname: firm-mute\ndescription: Роль без стандартов.\n---\n\nНичего не читаю.\n')
  const b = contextBill(root, null)
  const reads = b.roles.find((r) => r.name === 'firm-toy-role')
  const mute = b.roles.find((r) => r.name === 'firm-mute')
  assert.deepEqual(reads.parts.map((p) => p.kind), ['роль', 'стандарт'])
  assert.deepEqual(mute.parts.map((p) => p.kind), ['роль'])
  assert.equal(mute.chars, mute.own_chars)
  assert.equal(b.standards.length, 1)
})

test('шаблон, названный ролью по пути, попадает в счёт стадии', (t) => {
  // Разбор стадии Ревьюера 21.10.2026: роль читает `templates/lint-policy.md` на каждом
  // красном линте, а счёт считал только `templates/standards/*` — то есть занижал молча.
  // Замер, не видящий того, что названо в тексте прямым путём, хуже отсутствующего: он
  // убеждает, что посчитано всё.
  const root = fakeEngine(t, { roleBody: 'Разбирай по `$ENGINE/templates/lint-policy.md`.' })
  lay(root, 'templates/lint-policy.md', 'я'.repeat(3000))
  lay(root, 'templates/task.example.md', 'я'.repeat(2000))
  const r = contextBill(root, null).roles[0]
  const tpl = r.parts.filter((x) => x.kind === 'шаблон')
  assert.deepEqual(tpl.map((x) => x.name), ['lint-policy.md'], 'неназванный шаблон вешать нельзя')
  assert.equal(r.chars, r.own_chars + tpl[0].chars)
})

test('находки выражены в символах: пересчёт в токены на них не влияет', (t) => {
  const root = fakeEngine(t, { skillChars: CTX_BUDGET.skill + 500 })
  const a = contextBill(root, null)
  // Коэффициент меняем втрое — находка та же, потому что порог замеренный.
  const b = contextBill(root, { context: { chars_per_token_cyr: 6, chars_per_token_other: 12 } })
  assert.deepEqual(a.findings, b.findings)
  assert.equal(a.findings.length, 1)
  assert.match(a.findings[0], /приём firm-toy — \d+ символов/)
  assert.ok(b.always.tokens < a.always.tokens, 'пересчёт обязан зависеть от коэффициента')
  assert.equal(b.ratio.measured, true)
  assert.match(contextBillLines(b).join('\n'), /замер проекта/)
  assert.match(contextBillLines(a).join('\n'), /не замер/)
})

test('бюджеты перекрываются проектом, иначе порог движка был бы законом для чужого репозитория', (t) => {
  const root = fakeEngine(t, { skillChars: CTX_BUDGET.skill + 500 })
  const b = contextBill(root, { context: { budget_skill: CTX_BUDGET.skill + 2000 } })
  assert.deepEqual(b.findings, [])
  assert.equal(b.budget.skill, CTX_BUDGET.skill + 2000)
})

test('кириллица пересчитывается дороже латиницы — иначе счёт врал бы вдвое', () => {
  const cyr = estimateTokens('я'.repeat(100))
  const lat = estimateTokens('a'.repeat(100))
  assert.equal(cyr, 50)
  assert.equal(lat, 25)
})

test('движок считается целиком, и его собственный счёт предъявим', () => {
  const b = contextBill(ENGINE, null)
  assert.ok(b.commands.length >= 9, `команд ${b.commands.length}`)
  assert.ok(b.roles.length >= 8, `ролей ${b.roles.length}`)
  assert.ok(b.skills.length >= 10, `приёмов ${b.skills.length}`)
  // Описания — то, что лежит в окне всегда. Их рост заметен только так.
  assert.ok(b.always.chars > 3000 && b.always.chars < 12000, `описания ${b.always.chars}`)
  // Самый тяжёлый текст движка — тело команды, и это не случайность: команда и есть
  // сценарий сессии. Если первым окажется роль или приём, счёт стоит перечитать.
  assert.equal(b.heaviest[0].kind, 'команда')
})

test('итог назван полом, а не потолком: разговор и дифф движок не считает', () => {
  const lines = contextBillLines(contextBill(ENGINE, null)).join('\n')
  assert.match(lines, /ПОЛ счёта/)
  assert.match(lines, /CLAUDE\.md/)
})

test('шаблон, названный внутри шаблона, счёт видит — но только на один уровень', (t) => {
  // Разбор стадии DevOps 22.10.2026: инструкции режимов уехали из тела роли в
  // `templates/devops-modes.md`, DoD стал называть уже он — и счёт потерял 2 157 символов
  // молча. Замер, у которого «похудевшая» роль выглядит дешевле, чем есть, хуже
  // отсутствующего: он убеждает, что вынос текста в шаблон был экономией.
  const root = fakeEngine(t, { roleBody: 'Режим назван — читай `$ENGINE/templates/modes.md`.' })
  lay(root, 'templates/modes.md', `${'я'.repeat(1000)}\nСверь по templates/dod.md.\n`)
  lay(root, 'templates/dod.md', `${'я'.repeat(700)}\nА ещё есть templates/deep.md.\n`)
  lay(root, 'templates/deep.md', 'я'.repeat(500))
  const r = contextBill(root, null).roles[0]
  const names = r.parts.filter((x) => x.kind === 'шаблон').map((x) => x.name)
  assert.deepEqual(names, ['modes.md', 'dod.md'], 'второй уровень считается, третий — уже чтение документации, а не стадия')
  assert.equal(r.chars, r.own_chars + r.parts.filter((x) => x.kind === 'шаблон').reduce((a, x) => a + x.chars, 0))
})

test('один и тот же шаблон не считается дважды, как бы его ни называли', (t) => {
  const root = fakeEngine(t, { roleBody: 'Читай `$ENGINE/templates/modes.md` и templates/modes.md.' })
  lay(root, 'templates/modes.md', `${'я'.repeat(800)}\nсм. templates/modes.md\n`)
  const r = contextBill(root, null).roles[0]
  assert.equal(r.parts.filter((x) => x.kind === 'шаблон').length, 1, 'двойной счёт завышает стадию — такая же ложь, как недосчёт')
})
