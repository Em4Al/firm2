// И-9 со стороны движка: пока над задачей работает стадия в своём рабочем дереве, файл
// задачи в ГЛАВНОМ дереве не правится. Прежде «в полёте» выводилось через
// `merge-base --is-ancestor` — смысловой двойник запрещённого ADR-0005 `branch --merged`, —
// и защита отключалась ровно до первого коммита стадии, то есть когда нужна больше всего.
//
// Здесь же И-12: отказ git означает «не знаю» (откладываем всё), а не «в полёте никого».
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inFlightTickets, writeEvent } from '../scripts/lib/firm.mjs'
import { makeProject, plainDir, brokenGitDir } from './helpers.mjs'

function accepted(p, ticket) {
  writeEvent(p.root, {
    ts: new Date(Date.now() - 600000).toISOString(),
    change: p.change, ticket, stage: 'review', event: 'accepted', actor: 'test',
  })
}

test('И-9: есть рабочее дерево задачи — sync НЕ правит status в файле задачи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = p.sibling('T-001')
  // Ровно как стадия Prepare: ветка задачи заводится на вершине поставки, своих
  // коммитов у неё ещё нет — прежний признак считал её влитой и снимал защиту.
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  assert.deepEqual([...inFlightTickets(p.root)], ['T-001'])

  const file = join(p.tasksPath, 'T-001.md')
  const before = readFileSync(file, 'utf8')
  accepted(p, 'T-001')

  const r = p.evJson('sync')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(file, 'utf8'), before,
    'правка под работающей стадией стоит отказа слияния «your local changes would be overwritten»')
  assert.deepEqual(r.json.fixed, [])
  // Формулировка «после слияния» читалась как «уже применено» и сбивала с толку
  // (разбор 05.10.2026) — теперь сказано прямо, что в файле СЕЙЧАС старое значение.
  assert.ok(
    (r.json.deferred || []).some((s) => s.startsWith('T-001:') && s.includes('ОТЛОЖЕН до слияния')),
    `отложенное обязано быть названо: ${JSON.stringify(r.json.deferred)}`,
  )
})

test('И-9: рабочее дерево убрано — sync кэш догоняет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = p.sibling('T-001')
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  accepted(p, 'T-001')
  p.evJson('sync')

  p.git('worktree', 'remove', '--force', wt)
  assert.deepEqual([...inFlightTickets(p.root)], [], 'дерева нет — стадии нет')

  const r = p.evJson('sync')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.json.fixed, ['T-001: todo → accepted'])
  assert.match(readFileSync(join(p.tasksPath, 'T-001.md'), 'utf8'), /^status: accepted$/m)
})

test('И-9: дерево чужой задачи не защищает нашу', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  const wt = p.sibling('T-002')
  p.git('worktree', 'add', '-q', '-B', 'task/T-002', wt, `feature/${p.change}`)
  accepted(p, 'T-001')

  const r = p.evJson('sync')
  assert.deepEqual([...inFlightTickets(p.root)], ['T-002'])
  assert.deepEqual(r.json.fixed, ['T-001: todo → accepted'])
})

test('И-12: git не ответил — inFlightTickets даёт null («не знаю»), а не пустое множество', (t) => {
  const notARepo = plainDir(t)
  const res = inFlightTickets(notARepo)
  assert.equal(res, null,
    'пустое множество читалось бы как «в полёте никого» — и движок пошёл бы править файлы всех задач')
})

test('И-12: на «не знаю» sync откладывает ВСЁ и называет причину', (t) => {
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  accepted(p, 'T-001')
  accepted(p, 'T-002')
  const before = readFileSync(join(p.tasksPath, 'T-001.md'), 'utf8')

  // Отказ git воспроизводим ПОДСТАВНЫМ `git`, который всегда отвечает 128. Прежде здесь
  // стоял `GIT_DIR` в несуществующий каталог, но движок эту переменную теперь снимает на
  // входе (отчёт проект-В 03.11.2026, находка 1: окружение git-хука сильнее `-C` и уводило
  // индекс события в чужое дерево). Тест, опирающийся на снятую переменную, проверял бы
  // не инвариант, а способ его подделки.
  p.git('rev-parse', '--git-dir') // убедимся, что до правки репозиторий жив
  const r = p.cli('firm-event.mjs', ['sync', '--root', p.root, '--change', p.change, '--json'], {
    env: { PATH: `${brokenGitDir(t)}:${process.env.PATH}` },
  })
  const json = JSON.parse(r.stdout || '{}')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(json.fixed, [], 'не зная, кто в полёте, править нельзя ничего')
  assert.equal(json.deferred.length, 2)
  for (const d of json.deferred) assert.match(d, /git не ответил про рабочие деревья/)
  assert.equal(readFileSync(join(p.tasksPath, 'T-001.md'), 'utf8'), before)
})
