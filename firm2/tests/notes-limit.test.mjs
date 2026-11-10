// Причина остановки стадии доезжает до журнала целиком (Д-26 проект-В 29.10.2026).
//
// Было: `notes` стадии разработки обрезались на 500 символах. За одну волну так пропали
// причины трёх эскалаций из трёх — у T-156 от 3158 символов доехало 523, у T-149 от 3750 —
// 522 (83% и 86% текста). Обрыв приходился на середину предложения и ничем не помечался:
// отличить обрезку от роли, бросившей фразу на полуслове, было нельзя. Журнал при этом —
// истина о задачах (ADR-0001) и только дописывается (ADR-0006), то есть портился именно
// объявленный авторитетным источник, и дополнить событие задним числом невозможно.
//
// Предел остался, но стал общим на все стадии и выражен в замеренном (ADR-0010): 60 000
// символов — шестнадцать самых длинных наблюдавшихся разборов. Сработал — помечается.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'

// Разборы той самой волны: длины взяты из отчёта, чтобы тест падал ровно на том, на чём
// падала живая сборка.
const T156 = 'замер: порядок значков один у себя. '.repeat(90) // ~3200
const T149 = 'имя из кода GRID_CELL_CEILING (gridModel.ts); добавлено. '.repeat(66) // ~3700

// Прогоняет хук SubagentStop со structured output роли и возвращает событие стадии.
function hookEvent(t, { agentType, so, stage, event }) {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = join(p.root, 'agent.jsonl')
  const records = [
    { type: 'assistant', uuid: 'u1', timestamp: '2026-10-29T10:00:00.000Z',
      message: { role: 'assistant', model: 'claude-sonnet-x', content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 10, output_tokens: 20 } } },
    { type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input: so }] } },
  ]
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: agentType, hook_event_name: 'SubagentStop', cwd: p.root, agent_id: 'n-1',
      prompt: 'FIRM2-TICKET: T-001\nFIRM2-CHANGE: ch', last_assistant_message: 'ok',
      agent_transcript_path: path,
    }),
  })
  const evs = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
  const ev = evs.find((e) => e.stage === stage && e.event === event)
  assert.ok(ev, `событие ${stage}/${event} записано: ${evs.map((e) => `${e.stage}/${e.event}`).join(', ')}`)
  return { ev, p }
}

test('Д-26: причина эскалации Разработчика доезжает целиком, а не первыми 500 символами', (t) => {
  const { ev } = hookEvent(t, {
    agentType: 'firm2:firm-developer', stage: 'dev', event: 'escalated',
    so: { status: 'blocked', escalate: true, notes: T149 },
  })
  assert.ok(ev.notes.includes(T149.trim()), 'текст роли лежит в событии дословно')
  assert.ok(ev.notes.length > 3000, `доехало ${ev.notes.length} символов, а не полпредложения`)
  assert.equal(ev.notes_truncated, undefined, 'обрезки не было — и пометки быть не должно')
})

test('Д-26: 3158 символов разбора — тот самый случай T-156 — доезжают без потерь', (t) => {
  const { ev } = hookEvent(t, {
    agentType: 'firm2:firm-developer', stage: 'dev', event: 'escalated',
    so: { status: 'blocked', escalate: true, notes: T156 },
  })
  assert.ok(ev.notes.endsWith(T156.trim()), 'конец текста на месте: обрыв был ровно здесь')
})

test('Д-26: вердикт ревью и критерии под тот же нож не попадают', (t) => {
  // Отчёт просил это проверить: у них вердикты приходили целыми, но «это могло быть
  // везением объёма». Не везение — в журнал они и раньше шли без обрезки.
  const { ev } = hookEvent(t, {
    agentType: 'firm2:firm-reviewer-qa', stage: 'review', event: 'rejected',
    so: {
      verdict: 'отклонено', notes: T149,
      criteria_results: [{ criterion: 'к'.repeat(900), status: 'не выполнено' }],
    },
  })
  assert.ok(ev.notes.includes(T149.trim()))
  assert.equal(ev.criteria[0].c.length, 900, 'формулировка критерия тоже не режется')
})

test('Д-26: текст маршрута (record --notes) не режется — им пишут разбор эскалации', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  p.cli('firm-event.mjs', [
    'record', '--root', p.root, '--ticket', 'T-001', '--stage', 'lifecycle',
    '--event', 'arbitrated', '--actor', 'human', '--notes', T149,
  ])
  const ev = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
    .find((e) => e.event === 'arbitrated')
  assert.equal(ev.notes, T149, 'решение разбора — это разбор, а не телеграмма')
})

test('Д-26: патология упирается в предел, и обрезка ПОМЕЧАЕТСЯ', (t) => {
  // 60 000 нормальный разбор не задевает; задело — значит в журнал льют лог или дифф.
  const huge = 'x'.repeat(70000)
  const { ev } = hookEvent(t, {
    agentType: 'firm2:firm-developer', stage: 'dev', event: 'escalated',
    so: { status: 'blocked', escalate: true, notes: huge },
  })
  assert.equal(ev.notes_truncated, true, 'молчащая обрезка была половиной дефекта')
  // Длина считается по СОБРАННОМУ тексту события (к выводу роли движок приписывает статус
  // и объём правки), поэтому сверяем не с 70000, а с тем, что движок сам же и назвал.
  assert.ok(ev.notes_full_chars >= 70000, `полная длина записана: ${ev.notes_full_chars}`)
  const said = ev.notes.match(/\[обрезано движком: было (\d+) символов\]$/)
  assert.ok(said, 'и сказано это в самом тексте — он уходит в промпт')
  assert.equal(Number(said[1]), ev.notes_full_chars, 'в тексте и в поле — одно число')
  assert.ok(ev.notes.length < 70000)
})

test('Д-26: doctor называет обрезанные события, но ok на них не ломает', (t) => {
  const { p } = hookEvent(t, {
    agentType: 'firm2:firm-developer', stage: 'dev', event: 'escalated',
    so: { status: 'blocked', escalate: true, notes: 'y'.repeat(61000) },
  })
  const d = JSON.parse(p.cli('firm-event.mjs', ['doctor', '--root', p.root, '--json']).stdout)
  assert.equal(d.truncated_notes.length, 1, 'журнал, сказавший «знаю не всё», честен — но сказать должен')
  assert.match(d.truncated_notes[0], /T-001 dev\/escalated: оставлено \d+ из \d{5}/)
  assert.equal(d.ok, true, 'это вопрос к роли, а не дыра в журнале: чинить задним числом нечего (ADR-0006)')
})
