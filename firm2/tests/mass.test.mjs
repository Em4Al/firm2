// Масса репозитория: во что он превратился за все поставки.
//
// Маршрут движка целиком про новое поведение и назад не смотрит: до 13.10.2026 ни одна
// команда не отвечала на вопрос «сколько проверок накопилось и сколько из них копии».
// Поэтому решение об уборке было спором о впечатлениях. Замер даёт четыре числа.
//
// Тесты держат ровно два его свойства, и оба — про доверие:
//   • замер НЕ кричит на здоровом проекте (иначе его перестанут читать);
//   • находка опирается на число, которое можно предъявить, а не на ощущение.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { massState, isTestPath, MASS_RATIO_LOUD, MASS_COPIED_LOUD } from '../scripts/lib/firm.mjs'

function proj(files, cfg = 'engine: firm2\n') {
  const root = mkdtempSync(join(tmpdir(), 'mass-'))
  mkdirSync(join(root, '.firm'), { recursive: true })
  writeFileSync(join(root, '.firm', 'config'), cfg)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const lines = (n, text) => Array.from({ length: n }, (_, i) => `${text} // ${i}`).join('\n')

test('признак файла проверок: путь, а не содержимое', () => {
  assert.equal(isTestPath('tests/test_a.py'), true)
  assert.equal(isTestPath('web/src/a.test.ts'), true)
  assert.equal(isTestPath('internal/a_test.go'), true)
  assert.equal(isTestPath('web/__tests__/a.ts'), true)
  assert.equal(isTestPath('e2e/flow.spec.ts'), true)
  assert.equal(isTestPath('web/src/core/engine.ts'), false)
  // Слово «latest» внутри имени — не признак проверки: признак отделён границей.
  assert.equal(isTestPath('web/src/latest.ts'), false)
})

test('проект может назвать свои пути проверок сам, и это сильнее признака', () => {
  const cfg = 'engine: firm2\nmass:\n  test_paths:\n    - "checks/**"\n'
  assert.equal(isTestPath('checks/a.ts', { mass: { test_paths: ['checks/**'] } }), true)
  // Названы свои пути — догадка по имени больше не действует: иначе проект не может
  // переопределить признак, а только добавить к нему.
  assert.equal(isTestPath('tests/a.py', { mass: { test_paths: ['checks/**'] } }), false)
  const root = proj({ 'checks/a.ts': lines(10, 'const a = 1'), 'src/b.ts': lines(10, 'const b = 2') }, cfg)
  const m = massState(root)
  assert.equal(m.tests.files, 1)
  assert.equal(m.product.files, 1)
})

test('здоровый проект находок не даёт', () => {
  const root = proj({
    'src/a.ts': lines(200, 'export const a = 1'),
    'tests/a.test.ts': lines(100, 'assert.equal(uniqueCheckNumber1, 1)'),
  })
  const m = massState(root, null, [])
  assert.equal(m.ratio < MASS_RATIO_LOUD, true)
  assert.deepEqual(m.findings, [])
})

test('проверок вдвое больше продукта — находка с числами', () => {
  const root = proj({
    'src/a.ts': lines(50, 'export const a = 1'),
    'tests/a.test.ts': lines(300, 'assert.equal(somethingVeryUnique, 1)'),
  })
  const m = massState(root, null, [])
  assert.equal(m.ratio >= MASS_RATIO_LOUD, true)
  assert.equal(m.findings.length, 1)
  assert.match(m.findings[0], /300 строк против 50/)
})

test('одна и та же обвязка в трёх файлах читается как копия, в одном — нет', () => {
  const boiler = [
    'const here = dirname(fileURLToPath(import.meta.url))',
    'const store = makeStore({ root: here, mode: "memory" })',
    'await store.seed({ users: ["anya", "boris"], areas: 12 })',
  ].join('\n')
  const three = proj({
    'src/a.ts': lines(20, 'export const a = 1'),
    'tests/a.test.ts': `${boiler}\n${lines(3, 'assert.equal(a1, 1)')}`,
    'tests/b.test.ts': `${boiler}\n${lines(3, 'assert.equal(b1, 2)')}`,
    'tests/c.test.ts': `${boiler}\n${lines(3, 'assert.equal(c1, 3)')}`,
  })
  const m = massState(three, null, [])
  assert.equal(m.copied.lines, 9) // три строки обвязки в каждом из трёх файлов
  assert.equal(m.copied.share_pct >= MASS_COPIED_LOUD, true)
  assert.match(m.findings.join(' '), /трёх и более файлах/)
  assert.equal(m.repeated[0].files, 3)

  const one = proj({
    'src/a.ts': lines(20, 'export const a = 1'),
    // Та же строка тридцать раз в ОДНОМ файле — таблица случаев, а не копия.
    'tests/a.test.ts': Array.from({ length: 30 }, () => boiler.split('\n')[0]).join('\n'),
  })
  const m1 = massState(one, null, [])
  assert.equal(m1.copied.lines, 0)
  assert.deepEqual(m1.repeated, [])
})

test('импорты и скобки копиями не считаются', () => {
  const noise = 'import { readFileSync, writeFileSync } from "node:fs"\n// общий комментарий во всех файлах\n}'
  const root = proj({
    'src/a.ts': lines(20, 'export const a = 1'),
    'tests/a.test.ts': `${noise}\nassert.equal(firstUniqueThing, 1)`,
    'tests/b.test.ts': `${noise}\nassert.equal(secondUniqueThing, 2)`,
    'tests/c.test.ts': `${noise}\nassert.equal(thirdUniqueThing, 3)`,
  })
  const m = massState(root, null, [])
  assert.equal(m.copied.lines, 0)
  assert.deepEqual(m.findings, [])
})

test('медианы стадий берутся из журнала, а пустой журнал даёт null, не ноль (И-12)', () => {
  const root = proj({ 'src/a.ts': lines(10, 'export const a = 1') })
  const ev = (agent, stage, event, ts) => ({ agent_id: agent, stage, event, ts })
  const m = massState(root, null, [
    ev('a1', 'dev', 'started', '2026-10-01T10:00:00Z'), ev('a1', 'dev', 'finished', '2026-10-01T10:02:00Z'),
    ev('a2', 'dev', 'started', '2026-10-01T11:00:00Z'), ev('a2', 'dev', 'finished', '2026-10-01T11:04:00Z'),
    ev('b1', 'test', 'started', '2026-10-01T12:00:00Z'), ev('b1', 'test', 'finished', '2026-10-01T12:30:00Z'),
  ])
  assert.equal(m.stages.dev.median_min, 3)
  assert.equal(m.stages.test.median_min, 30)
  assert.equal(m.stages.review.median_min, null)
  assert.match(m.findings.join(' '), /30 мин против 3 мин/)

  const empty = massState(root, null, [])
  assert.equal(empty.stages.dev.median_min, null)
  assert.equal(empty.findings.length, 0)
})
