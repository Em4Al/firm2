// «Тест зелёный, но ничего не доказывает» — вторая по частоте причина отклонений ревью
// после настоящих дефектов (разбор 04.10.2026: ~6 заходов из 30 на четырёх пилотах).
// Два её вида движок теперь видит сам, потому что число называет сама роль:
//
//   пропущенные тесты — проект-В T-036: браузерный гейт вернул ноль, пропустив все проверки
//     экрана через `pytest.skip`. «2 passed, 1 skipped», код 0, все прочли как «зелено»;
//   отсутствие мутационной проверки — доказательства, что тест вообще способен упасть.
//
// Первый случай держит стадию (exit 2), второй только предупреждает: мутировать бывает
// нечего, и это суждение, а не факт. Здесь же — защита от петли (`stop_hook_active`):
// код 2 возвращает роль в работу, и если она не чинит, цикл бесконечен.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { worktreesDir } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

// Structured output роли: рантайм кладёт его блоком `tool_use`, а не текстом.
const outLine = (input) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Все тесты зелёные' },
        { type: 'tool_use', name: 'StructuredOutput', input },
      ],
    },
  })

// Привязка тикета — маркером в нагрузке: дерева задачи в этих сценах нет намеренно,
// иначе первой сработала бы вчерашняя проверка незакоммиченного.
function finishTest(p, so, extra = {}) {
  const payload = {
    agent_type: 'firm2:firm-tester',
    hook_event_name: 'SubagentStop',
    cwd: p.root,
    agent_id: 'test-1',
    prompt: 'FIRM2-TICKET: T-001\nFIRM2-CHANGE: ch',
    last_assistant_message: 'Все тесты зелёные',
    ...extra,
  }
  if (so !== null) {
    const path = join(p.root, 'tester.jsonl')
    writeFileSync(path, outLine(so) + '\n')
    payload.agent_transcript_path = path
  }
  return p.cli('firm-event.mjs', ['hook', '--root', p.root], { input: JSON.stringify(payload) })
}

function events(p) {
  return p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
}

const MUTATED = { done: true, evidence: 'сломал знак сравнения — упало 3 теста' }

// ── Пропущенные тесты ────────────────────────────────────────────────────────

test('пропуски без объяснения держат стадию, и число названо', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = finishTest(p, { status: 'ok', report: { passed: 2, failed: 0, skipped: 3 }, mutation_check: MUTATED })

  assert.equal(r.status, 2, `зелёный прогон с пропусками ничего не доказывает: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /пропустил 3 тест/, 'роль обязана увидеть СВОЁ число, а не общий упрёк')
  assert.match(r.stderr, /skipped_why/, 'и узнать, чем закрыть претензию')

  const [e] = events(p)
  assert.equal(e.stage, 'test')
  assert.equal(e.event, 'finished', 'событие пишется до проверки: журнал не молчит о состоявшейся стадии')
})

test('пропуски с объяснением проходят молча и остаются в журнале', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = finishTest(p, {
    status: 'ok',
    report: { passed: 2, failed: 0, skipped: 3 },
    skipped_why: 'нет браузера в песочнице, экранные проверки гоняет человек',
    mutation_check: MUTATED,
  })

  assert.equal(r.status, 0, `законный пропуск — не нарушение: ${r.stderr}`)
  assert.equal(r.stderr.trim(), '', 'требуем объяснения, а не нуля пропусков')
  assert.match(events(p)[0].notes, /пропущено 3: нет браузера в песочнице/,
    'внутри прогона это живёт до конца стадии, а вопрос «адекватны ли тесты» — дольше')
})

test('ноль пропусков и отсутствие поля report стадию не держат', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const zero = finishTest(p, { status: 'ok', report: { passed: 7, failed: 0, skipped: 0 }, mutation_check: MUTATED })
  assert.equal(zero.status, 0, zero.stderr)
  assert.equal(zero.stderr.trim(), '')

  // Роль со СТАРЫМ промптом: `scripts/` доезжают в проекты сразу, а промпты только после
  // обновления плагина. Встать колом на рассинхроне версий движок не вправе.
  const p2 = makeProject(t, { tasks: ['T-001'] })
  const old = finishTest(p2, { status: 'ok' })
  assert.equal(old.status, 0, `старый промпт обязан доработать: ${old.stderr}`)
  assert.doesNotMatch(old.stderr, /пропустил/, 'о числе, которого роль не называла, говорить нечего')
  assert.ok(events(p2)[0].notes == null, 'заметке взяться неоткуда')
})

test('structured output нет вовсе — ни претензий, ни предупреждений', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = finishTest(p, null)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr.trim(), '', 'молчащая роль — не повод выдумывать за неё ответ (ADR-0007)')
  assert.equal(events(p)[0].event, 'finished')
})

// ── Защита от петли ──────────────────────────────────────────────────────────

test('stop_hook_active: то же сообщение, но стадию больше не держим', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = finishTest(
    p,
    { status: 'ok', report: { passed: 2, failed: 0, skipped: 3 }, mutation_check: MUTATED },
    { stop_hook_active: true },
  )

  assert.equal(r.status, 0,
    'код 2 возвращает роль в работу; если она не чинит, тот же код вернёт её снова — и так без конца')
  assert.match(r.stderr, /пропустил 3 тест/, 'сказанное остаётся сказанным')
  assert.match(r.stderr, /дальше не держу/)
})

test('stop_hook_active: проверка незакоммиченного тоже отпускает стадию', (t) => {
  // Та же защита на вчерашней проверке — она переведена на общий `stageStop`.
  const p = makeProject(t, { tasks: ['T-001'] })
  // Дерево задачи по пути движка: проверка незакоммиченного смотрит именно туда.
  const dir = worktreesDir(p.root, null)
  const tree = join(dir, 'T-001')
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', tree, `feature/${p.change}`)
  t.after(() => {
    try {
      p.git('worktree', 'remove', '--force', tree)
    } catch { /* мог быть снесён */ }
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(tree, 'test_t001.py'), 'def test_x():\n    assert True\n')

  const held = finishTest(p, { status: 'ok', mutation_check: MUTATED }, { cwd: tree })
  assert.equal(held.status, 2, 'первый раз — держим')

  const released = finishTest(p, { status: 'ok', mutation_check: MUTATED }, { cwd: tree, stop_hook_active: true })
  assert.equal(released.status, 0, 'второй — отпускаем')
  assert.match(released.stderr, /НЕ закоммичена/)
  assert.match(released.stderr, /дальше не держу/)
})

// ── Мутационная проверка ─────────────────────────────────────────────────────

test('нет mutation_check — предупреждение, но не остановка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = finishTest(p, { status: 'ok', report: { passed: 5, failed: 0, skipped: 0 } })

  assert.equal(r.status, 0,
    '«докажи, что тест может упасть» — суждение, а не факт, и движку его не выносить')
  assert.match(r.stderr, /mutation_check не возвращён/)
})

test('notes события склеивает доказательство во всех видах', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  finishTest(p, { status: 'ok', report: { skipped: 0 }, mutation_check: MUTATED })
  assert.equal(events(p)[0].notes, 'мутация: сломал знак сравнения — упало 3 теста')

  const p2 = makeProject(t, { tasks: ['T-001'] })
  finishTest(p2, {
    status: 'ok',
    report: { skipped: 1 },
    skipped_why: 'нет внешней службы',
    mutation_check: { done: false, why_not: 'тикет документный, мутировать нечего' },
  })
  assert.equal(events(p2)[0].notes,
    'пропущено 1: нет внешней службы | без мутации: тикет документный, мутировать нечего')

  const p3 = makeProject(t, { tasks: ['T-001'] })
  finishTest(p3, { status: 'ok', mutation_check: { done: true } }) // evidence не назван
  assert.ok(events(p3)[0].notes == null, 'пустых заметок в журнале быть не должно')
})
