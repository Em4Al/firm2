// Секция `models:` в .firm/config принимает алиас (opus|sonnet|haiku) ИЛИ полное имя модели
// `claude-…` (в том числе с суффиксом `[1m]`). Граница проверяется там же, где в
// board.test.mjs: `firm-state.mjs models` и `build-args` — единственная дорога значения
// в workflow, где оно становится opts.model. Существование модели движок не проверяет
// (это знает только API), поэтому тесты закрепляют ФОРМУ: что пропускается и что режется.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeProject } from './helpers.mjs'

const modelsOf = (p) => {
  const r = p.cli('firm-state.mjs', ['models', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const buildArgsOf = (p) => {
  const r = p.cli('firm-state.mjs', ['build-args', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const projectWith = (t, body) =>
  makeProject(t, { tasks: ['T-001'], extraConfig: `models:\n${body}` })

// ── (1) полное имя принимается и доезжает дословно ───────────────────────────

test('полное имя модели: доезжает до models и build-args дословно, без предупреждений', (t) => {
  const p = projectWith(t,
    '  developer: claude-sonnet-5-5\n' +
    '  tester: claude-sonnet-5-5[1m]\n' +
    '  reviewer_qa: claude-opus-5\n')
  const m = modelsOf(p)
  assert.equal(m.models.developer, 'claude-sonnet-5-5')
  assert.equal(m.models.tester, 'claude-sonnet-5-5[1m]', 'суффикс [1m] — часть значения, обрезать нельзя')
  assert.equal(m.models.reviewer_qa, 'claude-opus-5')
  assert.deepEqual(m.warnings, [], m.warnings.join('; '))

  const b = buildArgsOf(p)
  assert.equal(b.models.developer, 'claude-sonnet-5-5')
  assert.equal(b.models.tester, 'claude-sonnet-5-5[1m]')
  assert.equal(b.models.reviewer_qa, 'claude-opus-5')
})

test('полное имя модели: допустимые формы (цифры, точки, дефисы, кавычки вокруг значения)', (t) => {
  const good = [
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
    ['claude-3.5-sonnet', 'claude-3.5-sonnet'],
    ['claude-0', 'claude-0'],
    ['claude-opus-5[1m]', 'claude-opus-5[1m]'],
    ['"claude-sonnet-5-5"', 'claude-sonnet-5-5'],
    ["'claude-sonnet-5-5[1m]'", 'claude-sonnet-5-5[1m]'],
  ]
  for (const [lit, want] of good) {
    const m = modelsOf(projectWith(t, `  pm: ${lit}\n`))
    assert.equal(m.models.pm, want, `значение ${lit} должно пройти`)
    assert.deepEqual(m.warnings, [], `${lit}: ${m.warnings.join('; ')}`)
  }
})

// ── (2) алиасы по-прежнему работают ──────────────────────────────────────────

test('алиасы opus/sonnet/haiku по-прежнему принимаются; inherit и пусто пропускаются', (t) => {
  const p = projectWith(t,
    '  pm: opus\n  architect: sonnet\n  designer: haiku\n  developer: inherit\n  docwriter:\n')
  const m = modelsOf(p)
  assert.equal(m.models.pm, 'opus')
  assert.equal(m.models.architect, 'sonnet')
  assert.equal(m.models.designer, 'haiku')
  assert.equal('developer' in m.models, false, 'inherit — не значение')
  assert.equal('docwriter' in m.models, false, 'пустое — не значение')
  assert.deepEqual(m.warnings, [])
  const b = buildArgsOf(p)
  assert.equal(b.models.pm, 'opus')
  assert.equal(b.models.architect, 'sonnet')
  assert.equal(b.models.designer, 'haiku')
})

// ── (3) мусор отбрасывается с предупреждением ────────────────────────────────

// [как записано в конфиге, что получит движок после разбора]
const BAD = [
  ['Claude-Sonnet', 'Claude-Sonnet'],                   // регистр: без флага i
  ['claude-', 'claude-'],                               // после префикса пусто
  ['claude--opus', 'claude--opus'],                     // первый символ после префикса — не [a-z0-9]
  ['claude-.x', 'claude-.x'],
  ['claude-sonnet 5', 'claude-sonnet 5'],               // пробел внутри
  ['"claude-sonnet 5"', 'claude-sonnet 5'],
  ['"claude-sonnet-5-5 "', 'claude-sonnet-5-5 '],       // хвостовой пробел внутри кавычек ($ обязателен)
  ['claude-sonnet\t5', 'claude-sonnet\t5'],             // настоящая табуляция
  ['"claude-sonnet\\n"', 'claude-sonnet\\n'],           // литерал \n: перевод строки в строку конфига не пронести
  ['claude-sonnet\'5', 'claude-sonnet\'5'],             // апостроф
  ['claude-sonnet"5', 'claude-sonnet"5'],               // кавычка
  ['gpt-4', 'gpt-4'],
  ['sonnet-5-5', 'sonnet-5-5'],                         // нет префикса claude-
  ['gpt-claude-opus-5', 'gpt-claude-opus-5'],           // префикс не в начале (якорь ^)
  ['claude-sonnet-5-5[2m]', 'claude-sonnet-5-5[2m]'],   // чужой суффикс
  ['claude-opus-5[1M]', 'claude-opus-5[1M]'],
  ['claude-opus-5[1m][1m]', 'claude-opus-5[1m][1m]'],   // суффикс не более одного раза
  ['claude-[1m]', 'claude-[1m]'],
  ['claude-opus-5(1m)', 'claude-opus-5(1m)'],          // скобки не те: суффикс именно [1m]
  ['claude-opus-5[1m', 'claude-opus-5[1m'],
  ['claude-opus-51m]', 'claude-opus-51m]'],
  ['claude-opus_5', 'claude-opus_5'],
  ['claude-opus-5/x', 'claude-opus-5/x'],
  ['claude-опус', 'claude-опус'],
  ['42', '42'],                                         // число
  ['4.5', '4.5'],
  ['true', 'true'],                                     // булево
]

test('мусорное значение отбрасывается с одним предупреждением, а не уходит в сборщик', (t) => {
  for (const [lit, parsed] of BAD) {
    const p = projectWith(t, `  developer: ${lit}\n`)
    const m = modelsOf(p)
    assert.equal('developer' in m.models, false, `${JSON.stringify(lit)} не должно пройти`)
    assert.equal(m.warnings.length, 1, `${JSON.stringify(lit)}: ${JSON.stringify(m.warnings)}`)
    assert.match(m.warnings[0], /models\.developer/, 'предупреждение обязано назвать ключ')
    assert.ok(m.warnings[0].includes(`"${parsed}"`), `и значение: ${m.warnings[0]}`)
    assert.match(m.warnings[0], /не opus\/sonnet\/haiku и не полное имя claude-/)
    assert.match(m.warnings[0], /оверрайд отброшен/)
    assert.equal('developer' in buildArgsOf(p).models, false, 'и до workflow оно не доезжает')
  }
})

// ── (4) смесь: валидное проходит, невалидное режется, предупреждение одно ────

test('смесь валидной и невалидной ролей: проходит валидная, предупреждение ровно одно', (t) => {
  const p = projectWith(t, '  developer: claude-sonnet-5-5\n  tester: sonnet-5-5\n')
  const m = modelsOf(p)
  assert.equal(m.models.developer, 'claude-sonnet-5-5')
  assert.equal('tester' in m.models, false)
  assert.equal(m.warnings.length, 1, JSON.stringify(m.warnings))
  assert.match(m.warnings[0], /models\.tester/)
  const b = buildArgsOf(p)
  assert.equal(b.models.developer, 'claude-sonnet-5-5')
  assert.equal('tester' in b.models, false)

  // Неизвестная роль с полным именем — по-прежнему «нет такой роли», а не молчаливый приём.
  const q = projectWith(t, '  developr: claude-sonnet-5-5\n')
  const mq = modelsOf(q)
  assert.equal('developr' in mq.models, false)
  assert.equal(mq.warnings.length, 1)
  assert.match(mq.warnings[0], /нет такой роли/)
})

// ── (5) умолчание developer_high_complexity ──────────────────────────────────

test('developer_high_complexity: умолчание opus сохраняется и перекрывается полным именем', (t) => {
  const none = modelsOf(makeProject(t, { tasks: ['T-001'] }))
  assert.equal(none.models.developer_high_complexity, 'opus')

  const full = projectWith(t, '  developer_high_complexity: claude-opus-5\n')
  assert.equal(modelsOf(full).models.developer_high_complexity, 'claude-opus-5')
  assert.equal(buildArgsOf(full).models.developer_high_complexity, 'claude-opus-5')

  const one = projectWith(t, '  developer_high_complexity: claude-opus-5[1m]\n')
  assert.equal(modelsOf(one).models.developer_high_complexity, 'claude-opus-5[1m]')

  // Негодное значение не должно оставить роль без умолчания: после отброса возвращается opus.
  const bad = modelsOf(projectWith(t, '  developer_high_complexity: opus-5\n'))
  assert.equal(bad.models.developer_high_complexity, 'opus')
  assert.equal(bad.warnings.length, 1)

  // Остальные роли умолчания по-прежнему не получают.
  const other = modelsOf(projectWith(t, '  developer: claude-sonnet-5-5\n'))
  assert.equal(other.models.developer_high_complexity, 'opus')
  assert.equal('tester_high_complexity' in other.models, false)
})
