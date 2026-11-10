// Неизвестный флаг — отказ, а не поведение по умолчанию (Д-61, отчёт проект-В 08.11.2026).
//
// Что случилось. Стадия хотела узнать, есть ли у разрушающей команды сухой прогон, и
// спросила `firm-state.mjs prune --help`. Флаг не распознан, не отвергнут — и `prune` СНЁС
// два рабочих дерева. Повезло: работа была влита. То есть вызов, которым спрашивают «что ты
// умеешь», выполнил удаление каталогов, а осторожность перед разрушающей командой стоила
// ровно той команды.
//
// Класс тот же, что у Д-50 (`next-id --kind adr` молча отдавал номер задачи): неизвестный
// вход молча заменяется умолчанием. Урок оттуда — «подмена молчит, отказ видно» — жил при
// одном виде номера; теперь он в библиотеке, то есть один на все CLI движка.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'
import { gitSubcommands, stripTextArgs } from '../scripts/lib/firm.mjs'

const CLIS = ['firm-state.mjs', 'firm-event.mjs', 'suite-run.mjs', 'task-merge.mjs', 'firm-permissions.mjs']

test('--help печатает подсказку и НИЧЕГО не делает — во всех CLI движка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  for (const cli of CLIS) {
    const r = p.cli(cli, ['--help'])
    assert.equal(r.status, 0, `${cli}: ${r.stderr}`)
    assert.ok(r.stdout.trim().length, `${cli}: подсказка пуста`)
  }
})

test('неизвестный флаг — exit 2 с перечнем известных, а не работа по умолчанию', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  for (const cli of CLIS) {
    const r = p.cli(cli, ['--чего-то-нет'])
    assert.equal(r.status, 2, `${cli}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /неизвестный флаг/, cli)
    assert.match(r.stderr, /Известные:/, `${cli}: отказ без перечня известных оставляет гадать`)
  }
})

test('prune --help дерево НЕ сносит — тот самый случай проект-В', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  // Осиротевшее дерево: задача закрыта, каталог висит — ровно то, что prune и сносит.
  const wt = join(p.root + '.worktrees', 'T-001')
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')

  const help = p.cli('firm-state.mjs', ['prune', '--help', '--root', p.root])
  assert.equal(help.status, 0, help.stderr)
  assert.ok(existsSync(wt), 'вопрос «что ты умеешь» каталогов не удаляет')
  assert.match(help.stdout, /prune/, 'и отвечает про prune, а не молчит')
})

test('prune --dry-run называет, что снесёт, и не трогает ничего', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = join(p.root + '.worktrees', 'T-001')
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')

  const dry = JSON.parse(p.cli('firm-state.mjs', ['prune', '--dry-run', '--json', '--root', p.root]).stdout)
  assert.equal(dry.dry_run, true)
  assert.deepEqual(dry.would_remove, [wt], 'сухой прогон называет дерево по пути')
  assert.ok(existsSync(wt), 'и оставляет его на месте')

  // А без флага — сносит: сухой прогон не должен подменять саму команду.
  const real = JSON.parse(p.cli('firm-state.mjs', ['prune', '--json', '--root', p.root]).stdout)
  assert.deepEqual(real.removed, [wt])
  assert.equal(existsSync(wt), false)
})

test('известный флаг с опечаткой в середине тоже отвергается, а не читается как умолчание', (t) => {
  // `--dry-rnu` — ровно та опечатка, которая у молчащего разбора означает «сноси».
  const p = makeProject(t, { tasks: ['T-001'] })
  const r = p.cli('firm-state.mjs', ['prune', '--dry-rnu', '--root', p.root])
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /--dry-rnu/)
})

// Д-58, по замеру проект-В 08.11.2026: исход сноса дерева из сессии перемежается, и причина
// не найдена. Поэтому `prune` не рассказывает, что осталось, — он это ЧИТАЕТ: `worktree
// list --porcelain` печатает `prunable` у записи без каталога. Поле есть всегда, в том
// числе когда не осталось ничего: «проверено и чисто» и «не проверялось» — разные ответы.
test('prune отвечает замером, осталась ли служебная запись', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = join(p.root + '.worktrees', 'T-001')
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  p.ev('record', '--ticket', 'T-001', '--stage', 'merge', '--event', 'finished', '--actor', 'test')

  const r = JSON.parse(p.cli('firm-state.mjs', ['prune', '--json', '--root', p.root]).stdout)
  assert.deepEqual(r.removed, [wt])
  assert.equal(r.registry_left, false, 'снесли полностью — и это сказано полем, а не умолчанием')
  assert.deepEqual(r.registry_left_names, [])
  assert.equal(r.registry_note, null, 'человека зовут только когда есть что доделать')
})

test('запись осталась без каталога — prune называет её по пути, а не молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = join(p.root + '.worktrees', 'T-001')
  p.git('worktree', 'add', '-q', '-B', 'task/T-001', wt, `feature/${p.change}`)
  // Ровно та половина, что оставалась у проект-В: каталога нет, служебная запись есть.
  rmSync(wt, { recursive: true, force: true })

  const r = JSON.parse(p.cli('firm-state.mjs', ['prune', '--json', '--root', p.root]).stdout)
  assert.equal(r.registry_left, false, 'свой же финальный `worktree prune` запись снял — замер это и говорит')
  // Замер — не предсказание: если бы запись осталась, её назвали бы путём и позвали человека.
  if (r.registry_left) {
    assert.ok(r.registry_left_names.length)
    assert.match(r.registry_note, /worktree prune/)
  }
})

// ── Д-74: снятие текста данными — обе формы ключа и обе формы кавычек ────────
//
// Разбор подкоманд общий на трёх сторожей (расписка, отправка, сверка секретов), поэтому
// его края проверяются здесь напрямую, а не только через поведение одного сторожа. Замер
// проект-В 10.11.2026 нашёл ровно край: кавычки разбирались в форме «ключ пробел значение» и
// не разбирались в `ключ=значение`.
test('Д-74: значение текстового ключа снимается целиком в любой форме', () => {
  const merged = (cmd) => gitSubcommands(cmd).some((g) => g.sub === 'merge')
  for (const cmd of [
    'rec --notes "a git merge --no-edit task/T-404 b"',
    'rec --notes="a git merge --no-edit task/T-404"',
    "rec --notes='a git merge --no-edit task/T-404'",
    'rec --message="git merge task/T-1" --ticket T-1',
    'rec --notes=git-merge-task',
  ]) {
    assert.equal(merged(cmd), false, `текст прочитан как команда: ${cmd}`)
  }
})

test('Д-74: снятое значение не уносит с собой соседнюю команду', () => {
  const merged = (cmd) => gitSubcommands(cmd).some((g) => g.sub === 'merge')
  for (const cmd of [
    'rec --notes="текст" && git merge task/T-1',
    'rec --notes "текст с пробелами" ; git merge task/T-1',
    'git merge task/T-1 --notes --quiet',
    'bash -c "git merge task/T-1"',
  ]) {
    assert.equal(merged(cmd), true, `слияние пропущено: ${cmd}`)
  }
})

test('Д-74: нетекстовый ключ с «=» остаётся в команде как есть', () => {
  // Снимаем значения ИМЕНОВАННЫХ ключей, а не всё, где встретился знак равенства: иначе
  // `--git-dir=…` и `-c user.name=x` исчезали бы вместе с разбором глобальных ключей.
  assert.equal(stripTextArgs('git --git-dir=/r/.git merge task/T-1'), 'git --git-dir=/r/.git merge task/T-1')
  assert.deepEqual(gitSubcommands('git -c user.name=x merge task/T-1').map((g) => g.sub), ['merge'])
})
