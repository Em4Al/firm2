// Таблица ролей движка и её находки.
//
// Тесты держат не формат вывода, а четыре утверждения, каждое из которых уже один раз
// оказывалось неправдой (22.10.2026, при постановке проверки):
//
//   1. ключи выхода считаются ВЕРХНЕГО уровня: у Тестировщика выход вложенный, и
//      ленивая регулярка выдавала `done`/`evidence`/`why_not` за ключи стадии, теряя
//      `ports` и `skipped_why` — то есть проверка молчала о реальном расхождении и
//      ругалась на выдуманное;
//   2. комментарий между полями схемы не съедает следующее поле (`ports` в DEV_SCHEMA
//      стоит сразу после абзаца объяснения — и терялся);
//   3. маркер — это строка со ЗНАЧЕНИЕМ, а не слово `FIRM2-TICKET`: иначе абзац
//      «маркера здесь нет намеренно» читается как маркер, и проверка ловится на
//      собственной оговорке;
//   4. причина «события стадии нет» — законный путь, но названный словами у самой точки
//      вызова: роль имеет ровно одну стадию, а работ у неё бывает больше.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rolesTable } from '../scripts/lib/roles.mjs'
import { ENGINE } from './helpers.mjs'

function lay(root, rel, text) {
  mkdirSync(join(root, dirname(rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

// Игрушечный «движок»: одна роль, один вызов в сборщике, одна команда. Стадия взята из
// настоящего словаря (`dev`) — словарь импортируется из `lib/firm.mjs`, и подменять его
// тут значило бы проверять подмену.
function fakeEngine(t, {
  roleOut = '`{ status: "ok", task, notes }`',
  roleBody = '',
  schema = "status: { enum: ['ok'] }, task: { type: 'string' }, notes: { type: 'string' }",
  prompt = '`${marks(task)} сделай`',
  command = 'Запусти `firm2:firm-toy` **с маркером `FIRM2-TICKET: MR`**.',
  stage = 'dev',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'firm2-roles-'))
  if (t && typeof t.after === 'function') t.after(() => rmSync(root, { recursive: true, force: true }))
  lay(root, 'agents/toy.md', `---\nname: firm-toy\ndescription: игрушка\ntools: Read, Bash\nmodel: haiku\n---\n\nТело роли. ${roleBody}\n\n## Выход (structured output)\n${roleOut}\n\n## Дальше\nничего\n`)
  lay(root, 'scripts/firm-event.mjs', `const STAGE_BY_AGENT = {\n  'firm2:firm-toy': '${stage}',\n}\n`)
  lay(root, 'workflows/firm2-build.js',
    `const A = {\n  toy: 'firm2:firm-toy',\n}\nconst TOY_SCHEMA = {\n  type: 'object',\n  properties: { ${schema} },\n}\n` +
    `function marks(task) {\n  return \`FIRM2-TICKET: \${task.id}\\n\`\n}\n` +
    `await agent(${prompt}, { agentType: A.toy, schema: TOY_SCHEMA, label: 'toy' })\n`)
  lay(root, 'commands/firm-toy.md', `# toy\n\n${command}\n`)
  mkdirSync(join(root, 'skills'), { recursive: true })
  mkdirSync(join(root, 'templates'), { recursive: true })
  return root
}

const finds = (table, re) => table.findings.filter((f) => re.test(f))

test('снимок роли выводится из исходника: модель, инструменты, стадия, схема вызова', (t) => {
  const table = rolesTable(fakeEngine(t))
  assert.equal(table.roles.length, 1)
  const r = table.roles[0]
  assert.equal(r.model, 'haiku')
  assert.deepEqual(r.tools, ['Read', 'Bash'])
  assert.equal(r.stage, 'dev')
  assert.deepEqual(r.schemas, ['TOY_SCHEMA'])
  assert.deepEqual(r.schema_keys, ['status', 'task', 'notes'])
  assert.deepEqual(r.declared_output, ['status', 'task', 'notes'])
  assert.equal(table.findings.length, 0, table.findings.join('\n'))
})

test('ключ схемы, не названный в разделе «Выход», — находка', (t) => {
  const table = rolesTable(fakeEngine(t, { roleOut: '`{ status: "ok", task }`' }))
  assert.equal(finds(table, /ключ notes/).length, 1, table.findings.join('\n'))
})

test('роль, которой схему даёт промпт стадии, от сверки ключей освобождена', (t) => {
  const table = rolesTable(fakeEngine(t, {
    roleOut: 'Схему даёт промпт стадии; ключи не придумывай.\n\n`{ status: "ok" }`',
  }))
  assert.equal(finds(table, /ключ /).length, 0, table.findings.join('\n'))
})

test('ключи вложенного объекта не считаются ключами выхода', (t) => {
  const table = rolesTable(fakeEngine(t, {
    roleOut: '`{ status: "ok", task, report: { total, passed }, notes }`',
  }))
  // `total` и `passed` лежат внутри `report` — выходом роли они не являются, и находки
  // «ключ total не передаётся» быть не должно, как и потери `notes` за вложенным блоком.
  assert.deepEqual(table.roles[0].declared_output, ['status', 'task', 'report', 'notes'])
  assert.equal(table.findings.length, 0, table.findings.join('\n'))
})

test('комментарий между полями схемы не съедает следующее поле', (t) => {
  const table = rolesTable(fakeEngine(t, {
    schema: "status: { enum: ['ok'] },\n    // Порты, которые заняла стадия (см. place()).\n    task: { type: 'string' }, notes: { type: 'string' }",
  }))
  assert.deepEqual(table.roles[0].schema_keys, ['status', 'task', 'notes'])
})

test('промпт, собранный переменной, виден: маркер ищется и через имена', (t) => {
  const root = fakeEngine(t)
  // Как панель Ревьюера: вызов получает готовую строку, а маркер кладёт функция.
  writeFileSync(join(root, 'workflows', 'firm2-build.js'),
    `const A = {\n  toy: 'firm2:firm-toy',\n}\nconst TOY_SCHEMA = { type: 'object', properties: { status: { enum: ['ok'] }, task: {}, notes: {} } }\n` +
    `function toyPrompt(task) {\n  return \`FIRM2-TICKET: \${task.id}\\n сделай\`\n}\n` +
    `const prompt = toyPrompt(task) + hint\nawait agent(prompt, { agentType: A.toy, schema: TOY_SCHEMA, label: 'toy' })\n`)
  const table = rolesTable(root)
  assert.equal(table.roles[0].calls.find((c) => c.kind === 'сборщик').marker, true, table.findings.join('\n'))
})

test('маркер — это значение, а не слово: упоминание без T-XXX/MR за привязку не идёт', (t) => {
  const table = rolesTable(fakeEngine(t, {
    command: 'Запусти `firm2:firm-toy`. Про маркер `FIRM2-TICKET` тут только сказано.',
  }))
  assert.equal(finds(table, /не несёт ни маркер/).length, 1, table.findings.join('\n'))
})

test('причина «события стадии нет» снимает находку, и перенос строки ей не мешает', (t) => {
  const table = rolesTable(fakeEngine(t, {
    command: 'Запусти `firm2:firm-toy`: маркера нет, потому что **события\nстадии нет** — привязывать не к чему.',
  }))
  assert.equal(finds(table, /не несёт ни маркер/).length, 0, table.findings.join('\n'))
})

test('стадия роли вне словаря STAGES — находка', (t) => {
  const table = rolesTable(fakeEngine(t, { stage: 'testing' }))
  assert.equal(finds(table, /словаре STAGES/).length, 1, table.findings.join('\n'))
})

test('приём и шаблон, которых нет, — находки; существующие молчат', (t) => {
  const root = fakeEngine(t, { roleBody: 'Зови приём `firm-toykit`, читай `templates/toy.md`.' })
  let table = rolesTable(root)
  assert.equal(finds(table, /приём firm-toykit/).length, 1)
  assert.equal(finds(table, /шаблон templates\/toy\.md/).length, 1)
  mkdirSync(join(root, 'skills', 'firm-toykit'), { recursive: true })
  writeFileSync(join(root, 'templates', 'toy.md'), 'шаблон')
  table = rolesTable(root)
  assert.equal(table.findings.length, 0, table.findings.join('\n'))
  assert.deepEqual(table.roles[0].skills, ['firm-toykit'])
})

test('роль в карте A, которую не берёт ни один вызов, — находка', (t) => {
  const root = fakeEngine(t)
  const p = join(root, 'workflows', 'firm2-build.js')
  writeFileSync(p, readFileSync(p, 'utf8').replace("  toy: 'firm2:firm-toy',", "  toy: 'firm2:firm-toy',\n  ghost: 'firm2:firm-ghost',"))
  const table = rolesTable(root)
  assert.equal(finds(table, /карте A сборщика объявлена роль ghost/).length, 1, table.findings.join('\n'))
})

test('роль, которую не зовут нигде, — находка', (t) => {
  const root = fakeEngine(t, { command: 'Ничего не запускаем.' })
  const p = join(root, 'workflows', 'firm2-build.js')
  // Вызов из сборщика убран целиком: промпт тут ни при чём — роль не зовут вовсе.
  writeFileSync(p, readFileSync(p, 'utf8').replace(/await agent[\s\S]*$/, ''))
  const table = rolesTable(root)
  assert.equal(finds(table, /не зовётся нигде/).length, 1, table.findings.join('\n'))
})

// Живой движок. Это и есть то, зачем проверка нужна: расхождение между схемой сборщика и
// промптом роли находилось глазами восемь разборов подряд.
test('на живом движке расхождений нет', () => {
  const table = rolesTable(ENGINE)
  assert.equal(table.roles.length, 8)
  assert.equal(table.findings.length, 0, table.findings.join('\n'))
})
