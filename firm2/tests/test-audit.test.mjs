// Разбор окупаемости тестов — машинная его часть.
//
// Граница, которую держат эти тесты, одна и она важнее каталога: находка обязана быть
// ПРЕДЪЯВИМА СТРОКОЙ. Разбор, который срабатывает по догадке, обесценивает и настоящие
// свои находки — и обесценивает мгновенно: первый же прогон по собственному набору движка
// дал ложную находку (`}` внутри строкового литерала обрывал тело теста), и доверие к
// остальным сорока восьми строчкам вывода пропало вместе с ней.
//
// Поэтому половина файла ниже — не про то, что разбор находит, а про то, чего он НЕ
// находит: тест с утверждением за строковым литералом, за комментарием, на незнакомом
// языке. Вторая половина — что каждый из трёх классов действительно предъявлен.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { testsOf, auditTests } from '../scripts/lib/tests.mjs'
import { makeProject } from './helpers.mjs'

function lay(root, rel, text) {
  mkdirSync(join(root, dirname(rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function rules(res, rule) {
  return res.findings.filter((f) => f.rule === rule)
}

test('тест без единого утверждения — находка, с файлом и строкой', (t) => {
  const p = makeProject(t)
  lay(p.root, 'tests/a.test.mjs', [
    "import test from 'node:test'",
    '',
    "test('зовёт и ничего не проверяет', () => {",
    '  doThing(1, 2)',
    '})',
  ].join('\n'))
  const res = auditTests(p.root, null)
  const f = rules(res, 'без утверждений')
  assert.equal(f.length, 1)
  assert.equal(f[0].file, 'tests/a.test.mjs')
  assert.equal(f[0].line, 3)
  assert.equal(f[0].test, 'зовёт и ничего не проверяет')
})

test('закрывающая скобка внутри строки не обрывает тело: утверждение после неё видно', (t) => {
  const p = makeProject(t)
  // Ровно та ложная находка, на которой разбор споткнулся о собственный набор
  // (`tests/mass.test.mjs:101`, 21.10.2026).
  lay(p.root, 'tests/b.test.mjs', [
    "test('скобка в литерале', () => {",
    "  const s = 'хвост }'",
    '  assert.equal(s.length, 8)',
    '})',
  ].join('\n'))
  assert.deepEqual(rules(auditTests(p.root, null), 'без утверждений'), [])
})

test('утверждение, закомментированное целиком, за утверждение не считается', (t) => {
  const p = makeProject(t)
  lay(p.root, 'tests/c.test.mjs', [
    "test('проверка выключена и об этом никто не знает', () => {",
    '  const v = run()',
    '  // assert.equal(v, 42)',
    '})',
  ].join('\n'))
  const f = rules(auditTests(p.root, null), 'без утверждений')
  assert.equal(f.length, 1)
  assert.equal(f[0].line, 1)
})

test('самосравнение предъявлено текстом самого утверждения', (t) => {
  const p = makeProject(t)
  // Вторая сторона образца подставляется заменой намеренно: написанная литералом, она
  // сделала бы находкой сам этот файл — разбор смотрит на текст и не знает, что текст
  // лежит в фикстуре. Так выглядит честная граница «предъявимо строкой»: она режет и
  // своих.
  lay(p.root, 'tests/d.test.mjs', [
    "test('проходит по построению', () => {",
    '  const got = norm(input)',
    '  assert.equal(got, ВТОРАЯ)',
    '})',
  ].join('\n').replace('ВТОРАЯ', 'got'))
  const f = rules(auditTests(p.root, null), 'самосравнение')
  assert.equal(f.length, 1)
  assert.match(f[0].why, /got/)
  assert.match(f[0].why, /по построению/)
})

test('два теста с одним именем в файле — находка на втором, и она называет первый', (t) => {
  const p = makeProject(t)
  lay(p.root, 'tests/e.test.mjs', [
    "test('одно имя', () => {",
    '  assert.ok(a)',
    '})',
    '',
    "test('одно имя', () => {",
    '  assert.ok(b)',
    '})',
  ].join('\n'))
  const f = rules(auditTests(p.root, null), 'имя-дубль')
  assert.equal(f.length, 1)
  assert.equal(f[0].line, 5)
  assert.match(f[0].why, /строки 1\b/)
})

test('одно имя в РАЗНЫХ файлах находкой не является: вердикт их различает путём', (t) => {
  const p = makeProject(t)
  lay(p.root, 'tests/f1.test.mjs', "test('одно имя', () => { assert.ok(a) })")
  lay(p.root, 'tests/f2.test.mjs', "test('одно имя', () => { assert.ok(b) })")
  assert.deepEqual(rules(auditTests(p.root, null), 'имя-дубль'), [])
})

test('python: тело берётся по отступу, пустая строка его не кончает', () => {
  const list = testsOf('tests/t_x.py', [
    'def test_one():',
    '    v = run()',
    '',
    '    assert v == 1',
    '',
    'def test_two():',
    '    run()',
  ].join('\n'))
  assert.equal(list.length, 2)
  assert.match(list[0].body, /assert v == 1/)
  assert.equal(list[1].line, 6)
})

test('незнакомый язык разбору не подлежит, и это сказано вслух, а не угадано', (t) => {
  const p = makeProject(t)
  lay(p.root, 'tests/g_test.go', 'func TestThing(t *testing.T) {\n  do()\n}\n')
  assert.equal(testsOf('tests/g_test.go', 'func TestThing(t *testing.T) {}'), null)
  const res = auditTests(p.root, null)
  assert.deepEqual(res.findings, [])
  assert.deepEqual(res.unparsed_ext, ['go'])
  assert.equal(res.files, 1)
  assert.equal(res.parsed_files, 0)
})

test('рабочий код в разбор не попадает — считаются только тестовые пути', (t) => {
  const p = makeProject(t)
  lay(p.root, 'src/thing.mjs', 'export function thing() { return 1 }\n')
  lay(p.root, 'tests/h.test.mjs', "test('ок', () => { assert.ok(1) })")
  const res = auditTests(p.root, null)
  assert.equal(res.files, 1)
  assert.equal(res.tests, 1)
})

test('тестовые пути берутся из конфига, когда проект их объявил', (t) => {
  const p = makeProject(t)
  // Путь нарочно не похож на тестовый: по умолчанию разбор его не видит вовсе.
  lay(p.root, 'qa/i.mjs', "test('без проверок', () => { run() })")
  assert.deepEqual(auditTests(p.root, null).findings, [])
  const res = auditTests(p.root, { mass: { test_paths: ['qa/**'] } })
  assert.equal(res.files, 1)
  assert.equal(rules(res, 'без утверждений').length, 1)
})

test('собственный набор движка разбирается целиком и машинных находок не даёт', () => {
  // Разбор, который врёт на своём же репозитории, не стоит ничего. Этот тест и есть
  // причина, по которой `bodyFromBraces` пропускает строки и комментарии.
  const res = auditTests(join(import.meta.dirname, '..', '..'), null)
  assert.ok(res.tests > 400, `тестов найдено ${res.tests}`)
  assert.equal(res.files, res.parsed_files)
  assert.deepEqual(
    res.findings.map((f) => `${f.file}:${f.line} [${f.rule}]`),
    [],
  )
})

test('пометка человека снимает тест с разбора — но только с причиной', (t) => {
  // Приём обещал эту пометку с 0.4.86, а машинная половина её не читала: человек
  // помечал, находка всё равно печаталась. Та же асимметрия «обещано текстом, не
  // исполняется механизмом», что между двумя гвардами (разбор 21.10.2026).
  const p = makeProject(t)
  lay(p.root, 'tests/keep.test.mjs', [
    '// firm2: тест оставить — держит контракт шаблона, утверждать тут нечего',
    "test('без проверок, и это осознанно', () => {",
    '  render()',
    '})',
    '',
    '// firm2: тест оставить',
    "test('пометка без причины не считается', () => {",
    '  render()',
    '})',
  ].join('\n'))
  const res = auditTests(p.root, null)
  assert.equal(res.kept, 1)
  assert.equal(res.findings.length, 1)
  assert.equal(res.findings[0].test, 'пометка без причины не считается')
  assert.equal(res.tests, 2, 'снятый с разбора всё равно считается тестом')
})

test('снятый с разбора тест не прячет дубль имени: вердикт читают по имени', (t) => {
  const p = makeProject(t)
  lay(p.root, 'tests/dup.test.mjs', [
    "test('одно имя', () => { assert.ok(a) })",
    '// firm2: тест оставить — заглушка под внешнюю службу',
    "test('одно имя', () => { run() })",
  ].join('\n'))
  const res = auditTests(p.root, null)
  assert.deepEqual(res.findings.map((f) => f.rule), [])
  assert.equal(res.kept, 1)
})
