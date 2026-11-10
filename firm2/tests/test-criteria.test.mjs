// Защита от теста, проверяющего МОМЕНТ, а не поведение (ретро 09.10.2026).
//
// Семейство из пяти дефектов: BUG-043, 045, 046, 047 (проект-В), BUG-018 (проект-Б,
// независимо) и BUG-049 (T-064). Чинили четырьмя правками промптов и пятой —
// переформулировкой. Хук `test-criteria-guard.mjs` заменяет шестую формулировку запретом.
//
// Проверяется и то, что запрещает, и то, что ПРОПУСКАЕТ: защита, которая ловит законный
// случай, будет снята целиком, и тогда не останется никакой. Два пропуска здесь не
// формальность, а условия, на которых правило вообще может жить: `merge-base` законен для
// проверки СТАДИИ (0.4.60), и проверка состояния дерева законна всегда.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('../scripts/test-criteria-guard.mjs', import.meta.url))

// Репозиторий нужен настоящий: хук ищет корень через git и читает `.firm/config`.
function project(config = 'engine: firm2\n') {
  const root = mkdtempSync(join(tmpdir(), 'firm2-tcg-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  mkdirSync(join(root, '.firm'), { recursive: true })
  writeFileSync(join(root, '.firm', 'config'), config)
  return root
}

// Исход читаем кодом возврата: 0 — пропустил, 2 — отменил вызов Write/Edit.
// `execFileSync` бросает на ненулевом коде, поэтому ловим и берём `status`.
function exitCode(root, toolInput) {
  try {
    execFileSync('node', [GUARD], {
      cwd: root,
      input: JSON.stringify({ tool_input: toolInput }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return 0
  } catch (e) {
    return e.status
  }
}

test('жёсткий перечень файлов в тесте отклоняется', () => {
  const root = project()
  assert.equal(
    exitCode(root, { file_path: 'tests/test_boundary.py', content: 'ALLOWED_FILES = {"a.py"}\n' }),
    2,
  )
})

test('сравнение с точкой ветвления отклоняется', () => {
  const root = project()
  assert.equal(
    exitCode(root, { file_path: 'tests/test_diff.py', content: 'sh("git merge-base feature HEAD")\n' }),
    2,
  )
})

test('трёхточечный диф отклоняется и в Edit (new_string)', () => {
  const root = project()
  assert.equal(
    exitCode(root, { file_path: 'tests/test_e.py', new_string: 'sh("git diff feature...HEAD")\n' }),
    2,
  )
})

test('проверка состояния дерева проходит', () => {
  const root = project()
  assert.equal(
    exitCode(root, { file_path: 'tests/test_schema.py', content: 'assert Path("openspec").is_dir()\n' }),
    0,
  )
})

test('стадийная проверка проходит, если помечена — строкой выше или в хвосте', () => {
  const root = project()
  const above = '# firm2: стадийная проверка — живёт один прогон\nsh("git merge-base f HEAD")\n'
  const inline = 'sh("git merge-base f HEAD")  # firm2: стадийная проверка — один прогон\n'
  assert.equal(exitCode(root, { file_path: 'tests/test_a.py', content: above }), 0)
  assert.equal(exitCode(root, { file_path: 'tests/test_i.py', content: inline }), 0)
})

test('файл, не похожий на тест, под правило не подпадает', () => {
  const root = project()
  assert.equal(
    exitCode(root, { file_path: 'src/merge.py', content: 'sh("git merge-base f HEAD")\n' }),
    0,
  )
})

test('рубильник в конфиге снимает защиту', () => {
  const root = project('engine: firm2\nguard:\n  test_criteria: off\n')
  assert.equal(
    exitCode(root, { file_path: 'tests/test_b.py', content: 'ALLOWED_FILES = {}\n' }),
    0,
  )
})

test('в проекте не под firm2 хук молчит', () => {
  const root = project('engine: something-else\n')
  assert.equal(
    exitCode(root, { file_path: 'tests/test_b.py', content: 'ALLOWED_FILES = {}\n' }),
    0,
  )
})

// ── Пометка без причины и след в журнале (разбор стадии Тестировщика, 21.10.2026) ──
//
// Две асимметрии с `secret-scan`, обе против собственного правила движка «молча снятая
// защита хуже отсутствующей». Заголовок этого хука, его подсказка роли и промпт
// Тестировщика все три требовали называть причину — а регулярка пропускала голую пометку.
// И сработавшая пометка не попадала в журнал: семейство из пяти кругов могло вернуться
// через пометку, не оставив следа ни в сверке, ни у человека.

test('пометка БЕЗ причины не считается, и отказ говорит именно про причину', () => {
  const root = project()
  const bare = '# firm2: стадийная проверка\nsh("git merge-base f HEAD")\n'
  let err = ''
  try {
    execFileSync('node', [GUARD], {
      cwd: root,
      input: JSON.stringify({ tool_input: { file_path: 'tests/test_b.py', content: bare } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    assert.fail('голая пометка не должна проходить')
  } catch (e) {
    assert.equal(e.status, 2)
    err = String(e.stderr || '')
  }
  assert.match(err, /без причины/)
  assert.doesNotMatch(err, /проверяет МОМЕНТ/, 'роль решит, что пометка не сработала вовсе')
})

test('сработавшая пометка пишется событием guard/test_criteria', () => {
  const root = project()
  mkdirSync(join(root, '.firm', 'events'), { recursive: true })
  const ok = '# firm2: стадийная проверка — живёт один прогон, после слияния снимается\nsh("git merge-base f HEAD")\n'
  assert.equal(exitCode(root, { file_path: join(root, 'tests', 'test_ok.py'), content: ok }), 0)
  const files = readdirSync(join(root, '.firm', 'events'))
  assert.equal(files.length, 1, 'пометка, о которой никто не узнал, — снятая молча защита')
  const ev = JSON.parse(readFileSync(join(root, '.firm', 'events', files[0]), 'utf8'))
  assert.equal(ev.stage, 'guard')
  assert.equal(ev.event, 'test_criteria')
  assert.match(ev.notes, /tests\/test_ok\.py|test_ok\.py/)
  // `unknown` краснит doctor навсегда, а журнал иммутабелен — вне ветки задачи пишем MR.
  assert.equal(ev.ticket, 'MR')
})

test('тест без признаков семейства событий не плодит', () => {
  const root = project()
  mkdirSync(join(root, '.firm', 'events'), { recursive: true })
  assert.equal(exitCode(root, { file_path: 'tests/test_plain.py', content: 'assert thing() == 1\n' }), 0)
  assert.deepEqual(readdirSync(join(root, '.firm', 'events')), [])
})
