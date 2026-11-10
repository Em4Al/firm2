// И-13: вердикт удостоверяет содержимое, а не тикет (ADR-0013).
//
// Тесты держат три стороны, и каждая без двух других бессмысленна:
//   1. отпечаток считается от ДЕРЕВА — переписанная история с тем же содержимым расписку
//      не протухает, одна изменённая строка протухает её всегда;
//   2. гвард отказывает ровно там, где расхождение доказано, и НЕ мешает штатной работе
//      (отказ на ровном месте обходят, а не исполняют — довод `bash-guard.mjs`);
//   3. `doctor` видит то же расхождение задним числом, по истории, и молчит на событиях
//      без отпечатка — иначе подъём версии покрасил бы четыре живых проекта.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeEvent, listEvents, taskTree, treeOfCommit, acceptedReceipt } from '../scripts/lib/firm.mjs'
import { makeProject, commitFile, plainDir, COMMIT_DATE } from './helpers.mjs'

const DEV_TS = '2026-09-30T11:00:00.000Z'

// Вызов гварда так, как его зовёт рантайм: нагрузка PreToolUse на stdin.
function guard(p, command, env = {}) {
  return p.cli('review-receipt.mjs', [], { input: JSON.stringify({ tool_input: { command }, cwd: p.root }), env })
}

// Ветка задачи с одним своим коммитом. Возвращает отпечаток её вершины.
function branchWith(p, ticket, text) {
  p.git('checkout', '-q', '-b', `task/${ticket}`)
  commitFile(p, `${ticket}.txt`, text, `${ticket}: работа`)
  p.git('checkout', '-q', `feature/${p.change}`)
  return taskTree(p.root, ticket)
}

// Доработка после вердикта: ещё один коммит в ветке задачи.
function amend(p, ticket, text) {
  p.git('checkout', '-q', `task/${ticket}`)
  commitFile(p, `${ticket}.txt`, text, 'доработка после вердикта')
  p.git('checkout', '-q', `feature/${p.change}`)
  return taskTree(p.root, ticket)
}

// Сцена «расписка протухла»: ветка судилась одним содержимым, а несёт другое.
// Событие пишется ПОСЛЕ всей работы с ветками — иначе коммит на ветке задачи унесёт файл
// журнала с собой, и возврат на ветку поставки сотрёт его из рабочего дерева
// (те же грабли, что разобраны в merge.test.mjs).
function staleScene(p, ticket = 'T-001') {
  const judged = branchWith(p, ticket, 'один\n')
  const now = amend(p, ticket, 'правка после вердикта\n')
  accepted(p, ticket, judged)
  return { judged, now }
}

function accepted(p, ticket, tree, ts = '2026-09-30T12:00:00.000Z') {
  writeEvent(p.root, {
    ts, change: p.change, ticket, stage: 'review', event: 'accepted', actor: 'test',
    ...(tree ? { tree } : {}),
  })
}

// ── Отпечаток: содержимое, а не история ──────────────────────────────────────

test('И-13: отпечаток берётся у дерева — amend без правок содержимого его не меняет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const before = branchWith(p, 'T-001', 'один\n')
  assert.match(String(before), /^[0-9a-f]{12}$/, 'отпечаток — короткий хеш дерева')

  p.git('checkout', '-q', 'task/T-001')
  p.git('commit', '-q', '--amend', '-m', 'другое сообщение, то же содержимое')
  p.git('checkout', '-q', `feature/${p.change}`)

  assert.equal(taskTree(p.root, 'T-001'), before, 'rebase и amend судимое содержимое не меняют')
})

test('И-13: одна изменённая строка меняет отпечаток', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const before = branchWith(p, 'T-001', 'один\n')
  p.git('checkout', '-q', 'task/T-001')
  commitFile(p, 'T-001.txt', 'один и ещё полстроки\n', 'доработка после вердикта')
  p.git('checkout', '-q', `feature/${p.change}`)
  assert.notEqual(taskTree(p.root, 'T-001'), before)
})

test('И-12: нет ветки, нет репозитория — отпечаток null, а не выдумка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  assert.equal(taskTree(p.root, 'T-001'), null, 'ветки ещё нет — сказать нечего')
  assert.equal(taskTree(p.root, 'unknown'), null)
  assert.equal(taskTree(plainDir(t), 'T-001'), null, 'не репозиторий — тоже «не знаю»')
  assert.equal(treeOfCommit(p.root, 'нет-такого-коммита'), null)
})

// ── Расписка: чем задача принята ─────────────────────────────────────────────

test('И-13: расписка — последнее принятие; короткая полоса считается наравне с ревью', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, { ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-001', stage: 'review', event: 'accepted', actor: 'test', tree: 'aaaaaaaaaaaa' })
  writeEvent(p.root, { ts: '2026-09-30T13:00:00.000Z', change: p.change, ticket: 'T-001', stage: 'review', event: 'accepted', actor: 'test', tree: 'bbbbbbbbbbbb' })
  const r = acceptedReceipt(listEvents(p.root), 'T-001')
  assert.equal(r.tree, 'bbbbbbbbbbbb', 'вторая попытка судит содержимое заново')

  writeEvent(p.root, { ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-002', stage: 'guard', event: 'short-lane', actor: 'test', tree: 'cccccccccccc' })
  assert.equal(acceptedReceipt(listEvents(p.root), 'T-002').tree, 'cccccccccccc')

  writeEvent(p.root, { ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-003', stage: 'review', event: 'rejected', actor: 'test', tree: 'dddddddddddd' })
  assert.equal(acceptedReceipt(listEvents(p.root), 'T-003'), null, 'отклонение — не принятие')
})

test('И-13: record стемпливает отпечаток в событие', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const tree = branchWith(p, 'T-001', 'один\n')
  const r = p.evJson('record', '--ticket', 'T-001', '--stage', 'guard', '--event', 'short-lane', '--actor', 'test')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.json.event.tree, tree, 'короткая полоса принимает без ревью — отпечаток обязан быть и здесь')
})

// ── Гвард: отказывает по доказанному расхождению ─────────────────────────────

test('И-13: слияние с протухшей распиской отменяется (exit 2) и называет оба отпечатка', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const { judged, now } = staleScene(p)

  const r = guard(p, `git -C ${p.root} merge --no-ff --no-edit task/T-001`)
  assert.equal(r.status, 2, `гвард обязан отменить вызов: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, new RegExp(judged), 'в отказе названо принятое дерево')
  assert.match(r.stderr, new RegExp(now), 'и нынешнее')
  assert.match(r.stderr, /FIRM2_STALE_REVIEW=i-know/, 'отказ без выхода обходят, а не исполняют')
  assert.equal(p.eventFiles().some((f) => /review-stale/.test(f)), false, 'отменённый вызов события не пишет')
})

test('И-13: свежая расписка — гвард молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  accepted(p, 'T-001', branchWith(p, 'T-001', 'один\n'))
  const r = guard(p, `git -C ${p.root} merge --no-ff --no-edit task/T-001`)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stderr.trim(), '', 'норма не комментируется')
})

test('И-12: расписка без отпечатка (движок старше) — названо, но не держит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  branchWith(p, 'T-001', 'один\n')
  accepted(p, 'T-001', null)
  const r = guard(p, `git -C ${p.root} merge --no-ff task/T-001`)
  assert.equal(r.status, 0, 'иначе подъём версии сделал бы незаливаемой каждую задачу в работе')
  assert.match(r.stderr, /без отпечатка/)
})

test('И-13: принятия нет вовсе — это другой дефект: названо, не держит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  branchWith(p, 'T-001', 'один\n')
  const r = guard(p, `git -C ${p.root} merge --no-ff task/T-001`)
  assert.equal(r.status, 0)
  assert.match(r.stderr, /события принятия в журнале нет/)
})

test('И-13: выход и ключ проекта пропускают слияние, но пишут событие — и НЕ подписью человека', (t) => {
  for (const mode of ['waiver', 'config']) {
    const p = makeProject(t, {
      tasks: ['T-001'],
      extraConfig: mode === 'config' ? 'guard:\n  stale_review: allow\n' : '',
    })
    staleScene(p)

    const cmd = mode === 'waiver'
      ? `FIRM2_STALE_REVIEW=i-know git -C ${p.root} merge --no-ff task/T-001`
      : `git -C ${p.root} merge --no-ff task/T-001`
    const r = guard(p, cmd)
    assert.equal(r.status, 0, `${mode}: ${r.stderr}`)
    const files = p.eventFiles().filter((f) => /guard-review-stale/.test(f))
    assert.equal(files.length, 1, `${mode}: пропуск обязан остаться в журнале`)
    const ev = listEvents(p.root).find((e) => e.event === 'review-stale')
    // Запись выхода НЕ называет человека, и это правка 04.11.2026 по случаю проект-В:
    // переменную берёт кто угодно, а чаще всего — стадия, которой отказ мешает. Дважды за
    // одну поставку журнал получил запись о согласии, которого человек не давал; отличить
    // настоящее согласие от самоназначенного по журналу было нельзя. Подделанная подпись в
    // источнике истины дороже пропущенного слияния: она отменяет доверие ко всем записям
    // того же вида.
    if (mode === 'waiver') {
      assert.match(ev.notes, /вызывающей стороной/i)
      assert.match(ev.notes, /подпись человека.*НЕ подтверждается/i)
      assert.equal(/пропущено человеком/.test(ev.notes), false,
        'движок не отличает человека от стадии по устройству — значит и называть его не вправе')
      assert.match(ev.notes, /record --actor human/, 'рядом с выходом назван путь, который подпись НЕСЁТ')
    } else {
      assert.match(ev.notes, /stale_review: allow/)
    }
  }
})

test('отказ ставит путь с подписью человека ПЕРВЫМ, а выход — последним и с оговоркой', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)
  const r = guard(p, `git -C ${p.root} merge --no-ff task/T-001`)
  assert.equal(r.status, 2)
  const human = r.stderr.indexOf('--actor human')
  const waiver = r.stderr.indexOf('FIRM2_STALE_REVIEW=i-know')
  assert.ok(human > 0 && waiver > 0, r.stderr)
  assert.ok(human < waiver,
    'роль берёт то, что названо первым и короче: рецепт — такой же механизм, как признак')
  assert.match(r.stderr, /согласием человека это НЕ является/)
})

test('гвард не трогает чужие команды и чужие проекты', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)

  for (const cmd of [
    `git -C ${p.root} commit -m "обычный коммит"`,
    `git -C ${p.root} merge --no-ff feature/other`,
    `git -C ${p.root} log --merges task/T-001`,
    'ls -la',
  ]) {
    assert.equal(guard(p, cmd).status, 0, `не слияние задачи, а гвард вмешался: ${cmd}`)
  }

  // Чужой проект: нагрузка та же, но `.firm/config` движка нет.
  const foreign = plainDir(t)
  const r = p.cli('review-receipt.mjs', [], {
    input: JSON.stringify({ tool_input: { command: 'git merge --no-ff task/T-001' }, cwd: foreign }),
    env: { CLAUDE_PROJECT_DIR: foreign },
  })
  assert.equal(r.status, 0, 'чужие проекты нас не касаются')
})

// ── doctor: то же расхождение задним числом ──────────────────────────────────

test('И-13: doctor видит влитое дерево, которого не принимали, и это влияет на ok', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const judged = branchWith(p, 'T-001', 'один\n')
  // Стадию разработки закрываем: тест обязан красить `doctor` ИМЕННО находкой И-13, а не
  // попутно открытым интервалом. С открытым `dev/started` ответ был бы `ok: false` и без
  // расхождения расписок — то есть тест прошёл бы, даже если находку убрать из расчёта
  // `ok` (поймано проверкой мутацией 21.10.2026).
  writeEvent(p.root, { ts: DEV_TS, change: p.change, ticket: 'T-001', stage: 'dev', event: 'started', actor: 'test' })
  writeEvent(p.root, { ts: '2026-09-30T11:30:00.000Z', change: p.change, ticket: 'T-001', stage: 'dev', event: 'finished', actor: 'test' })
  accepted(p, 'T-001', judged)

  // После вердикта в ветку доложили — и влили уже это.
  p.git('checkout', '-q', 'task/T-001')
  commitFile(p, 'T-001.txt', 'правка после вердикта\n', 'ещё коммит')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')
  writeEvent(p.root, {
    ts: new Date(COMMIT_DATE).toISOString(), change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'finished', actor: 'test',
  })

  const r = p.evJson('doctor', '--change', p.change)
  assert.equal(r.json.ok, false, 'непросмотренное содержимое в поставке — находка, а не вопрос')
  assert.equal(r.json.stale_receipts.length, 1)
  assert.equal(r.json.stale_receipts[0].accepted_tree, judged)
  assert.equal(r.json.stale_receipts[0].merged_tree, taskTree(p.root, 'T-001'))
})

test('И-13: расписка без отпечатка не красит doctor задним числом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeEvent(p.root, { ts: DEV_TS, change: p.change, ticket: 'T-001', stage: 'dev', event: 'started', actor: 'test' })
  branchWith(p, 'T-001', 'один\n')
  accepted(p, 'T-001', null) // событие записано движком до 0.4.83
  p.git('checkout', '-q', 'task/T-001')
  commitFile(p, 'T-001.txt', 'правка\n', 'ещё коммит')
  p.git('checkout', '-q', `feature/${p.change}`)
  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')
  writeEvent(p.root, {
    ts: new Date(COMMIT_DATE).toISOString(), change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'finished', actor: 'test',
  })

  const r = p.evJson('doctor', '--change', p.change)
  assert.deepEqual(r.json.stale_receipts, [], 'сверять не с чем — молчим')
})

test('И-13: тот же сценарий со свежей распиской оставляет doctor зелёным', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const judged = branchWith(p, 'T-001', 'один\n')
  // Сначала слияние, потом журнал: `writeEvent` кладёт файл события в индекс, и мерж
  // отказался бы «Your local changes would be overwritten» (И-12 — те же грабли, что в
  // merge.test.mjs). Отпечаток от этого не меняется: он снят до слияния и влито именно он.
  p.git('merge', '--no-ff', '--no-edit', 'task/T-001')
  writeEvent(p.root, { ts: DEV_TS, change: p.change, ticket: 'T-001', stage: 'dev', event: 'started', actor: 'test' })
  writeEvent(p.root, { ts: '2026-09-30T11:30:00.000Z', change: p.change, ticket: 'T-001', stage: 'dev', event: 'finished', actor: 'test' })
  accepted(p, 'T-001', judged) // влито ровно то, что принято
  writeEvent(p.root, {
    ts: new Date(COMMIT_DATE).toISOString(), change: p.change, ticket: 'T-001',
    stage: 'merge', event: 'finished', actor: 'test',
  })

  const r = p.evJson('doctor', '--change', p.change)
  assert.deepEqual(r.json.stale_receipts, [])
  assert.equal(r.json.ok, true, 'штатный путь обязан быть зелёным, иначе находке не поверят')
})

// ── Сквозной путь: штемпель ставит сам хук ───────────────────────────────────
// Без этого теста половина механизма держалась бы на текстовом правиле рубежа: события
// писались бы по-прежнему, гвард молчал бы всегда (сверять не с чем), и `doctor` отвечал
// бы `ok`. То есть поломка была бы НЕВИДИМОЙ — ровно тот класс, ради которого И-13 и
// вводился.
const outLine = (input) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input }] },
  })
const markerLine = (ticket) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `FIRM2-TICKET: ${ticket}\nFIRM2-CHANGE: ch\nFIRM2-ATTEMPT: 1` }] },
  })

test('И-13: финиш ревью стемпливает отпечаток дерева задачи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const tree = branchWith(p, 'T-001', 'один\n')
  const path = join(p.root, 'review.jsonl')
  writeFileSync(path, [markerLine('T-001'), outLine({ verdict: 'принято', notes: 'замечаний нет' })].join('\n') + '\n')

  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-reviewer-qa',
      hook_event_name: 'SubagentStop',
      cwd: p.root,
      agent_id: 'qa-1',
      agent_transcript_path: path,
      last_assistant_message: 'done',
    }),
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)

  const ev = listEvents(p.root).find((e) => e.stage === 'review')
  assert.equal(ev.event, 'accepted')
  assert.equal(ev.tree, tree, 'вердикт обязан нести содержимое, которое судил')
})

// ── Д-22: слияние опознаётся подкомандой, а не словом «merge» в тексте ───────
//
// Отчёт проект-В 29.10.2026, движок 0.4.112. Образец `\bgit\b…\bmerge\b…task/(T-…)` ловил
// `merge-base`: слово `merge` кончается на границе (дальше дефис). Отклонялась ЧИТАЮЩАЯ
// команда — та самая, которой смотрят, что изменилось после вердикта, то есть отказ
// запрещал диагностику, к которой сам же подталкивал. Поведение вдобавок было
// непредсказуемым: `--merged` проходил, `merge-base` нет. А на heredoc отказ начинал
// мешать записи файла, в ТЕКСТЕ которого встретились нужные слова — на этом самом отчёте.
test('Д-22: читающие команды с «merge» в имени подкоманды не держатся', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p) // расписка протухла — значит гвард сработал бы, будь это слияние
  for (const cmd of [
    `git -C ${p.root} merge-base feature/ch task/T-001`,
    `git -C ${p.root} diff --merge-base task/T-001`,
    `git -C ${p.root} merge-tree feature/ch task/T-001`,
    `git -C ${p.root} log --merges --oneline task/T-001`,
    `git -C ${p.root} branch --merged task/T-001`,
  ]) {
    const r = guard(p, cmd)
    assert.equal(r.status, 0, `читающая команда отклонена: ${cmd}\n${r.stderr}`)
    assert.equal(r.stderr.trim(), '', `и прокомментирована: ${cmd}`)
  }
})

test('Д-22: текст heredoc командой не является', (t) => {
  // Второй случай из отчёта, и он дороже первого: сторож мешал работе, не имеющей к git
  // отношения вовсе — записи файла, в котором ОПИСАН этот сторож.
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)
  const r = guard(p, `cat > docs/report.md <<'EOF'\nгвард ловит git merge --no-ff task/T-001\nEOF`)
  assert.equal(r.status, 0, `запись файла отклонена: ${r.stderr}`)
  assert.equal(r.stderr.trim(), '')
})

test('Д-22: настоящее слияние по-прежнему отменяется, в том числе с глобальными ключами', (t) => {
  // Направление ошибки несимметрично: пропустить слияние хуже, чем задержать читающую
  // команду. Поэтому формы разбираются, а не угадываются.
  for (const cmd of [
    'git merge --no-ff task/T-001',
    'git -C /repo merge task/T-001',
    'git --git-dir=/repo/.git --work-tree=/repo merge --no-edit task/T-001',
    'git -c user.name=x merge task/T-001',
    'cd /repo && git merge --no-ff task/T-001',
  ]) {
    const p = makeProject(t, { tasks: ['T-001'] })
    staleScene(p)
    const r = guard(p, cmd)
    assert.equal(r.status, 2, `слияние пропущено: ${cmd}\n${r.stdout}${r.stderr}`)
  }
})

test('Д-22: отказ говорит про ЭТУ команду и не выдаёт запрета диагностики', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)
  const r = guard(p, `git -C ${p.root} merge --no-ff task/T-001`)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /ЭТА КОМАНДА СЛИЯНИЯ/, 'заголовок утверждает ровно то, что произошло')
  assert.match(r.stderr, /ни одна читающая команда этим сторожем не держится/)
  assert.match(r.stderr, /merge-base/, 'названо поимённо, чем можно смотреть расхождение')
})

test('Д-22: тикет берётся из слияния, а не из текста heredoc перед ним', (t) => {
  // Вырезается РОВНО тело heredoc'а: после него может идти настоящая команда. Сторож,
  // обрезавший весь хвост, слияния не увидел бы вовсе — а это худшее направление ошибки,
  // чем задержанное чтение. И тикет при этом должен быть тот, который вливают: упоминание
  // другой задачи в тексте файла не делает её участником слияния.
  const p = makeProject(t, { tasks: ['T-001', 'T-002'] })
  staleScene(p) // протухла расписка T-001
  const cmd = `cat > docs/note.md <<'EOF'\nсмотри task/T-002\nEOF\ngit -C ${p.root} merge --no-ff task/T-001`
  const r = guard(p, cmd)
  assert.equal(r.status, 2, `слияние за телом heredoc пропущено: ${r.stdout}${r.stderr}`)
  // Тикет назван в заголовке отказа: задача из текста файла к слиянию отношения не имеет
  // (сама команда в отказе эхом, и упоминание T-002 в ней — её текст, а не вердикт).
  assert.match(r.stderr, /ЭТА КОМАНДА СЛИЯНИЯ T-001 отменена/)
})

// ── Д-64: отказ прав, но его диагноз был шире правды ─────────────────────────
//
// Отчёт проект-В 09.11.2026. После вердикта по `T-373` слияние упало содержательным
// конфликтом, и человек развёл его в дереве задачи, подтянув туда вершину поставки (в
// главном дереве слияние не идёт — его ломают файлы журнала идущих стадий). Расписка от
// этого протухла — и правильно: содержимое ветки изменилось. Но отпечаток берётся у дерева
// целиком, поэтому отказ назвал 249 файлов и +10 839 строк, из которых почти всё — восемь
// уже отсуженных и влитых задач плюс журнал, а своей рукой написано двадцать строк в одном
// файле. Первое движение читателя при виде 249 неверное.
//
// Разделение берёт тот же вопрос, что `taskDiff`: файла нет в диффе ветки против точки
// ветвления — значит он в ветку ПРИШЁЛ, а не написан в ней.
test('Д-64: отказ разделяет своё и подтянутое двумя числами, и своё называет поимённо', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const judged = branchWith(p, 'T-001', 'один\n')
  // Чужая работа на ветке поставки — та, что потом окажется «подтянутой».
  commitFile(p, 'chuzhoe-1.txt', 'отсуженная задача\n', 'T-370: влито')
  commitFile(p, 'chuzhoe-2.txt', 'ещё одна\n', 'T-371: влито')
  // Своя правка после вердикта — ровно одна, как у проект-В.
  p.git('checkout', '-q', 'task/T-001')
  commitFile(p, 'T-001.txt', 'правка после вердикта\n', 'своя правка')
  // И подтянутая вершина поставки: это и раздувает расхождение.
  p.git('merge', '-q', '--no-ff', '-m', 'подтянул поставку', `feature/${p.change}`)
  p.git('checkout', '-q', `feature/${p.change}`)
  accepted(p, 'T-001', judged)

  const r = guard(p, 'git -C . merge --no-ff task/T-001')
  assert.equal(r.status, 2, 'сторож по-прежнему отказывает: содержимое после вердикта изменилось')
  assert.match(r.stderr, /Своих правок: 1 файл\(ов\) — T-001\.txt/, 'своё названо числом и поимённо')
  assert.match(r.stderr, /Подтянуто с ветки поставки feature\/.*: 2 файл\(ов\)/, 'чужое отделено и посчитано')
  assert.match(r.stderr, /СУДИТЬ НАДО ПЕРВЫЙ СПИСОК/)
  assert.match(r.stderr, /249 файлов/, 'назван замер, из которого правило выросло')
})

test('Д-64: путь, который роль исполнить не может, помечен как только человеческий', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p, 'T-001')
  const r = guard(p, 'git -C . merge --no-ff task/T-001')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /ТОЛЬКО ЧЕЛОВЕК, РОЛИ ЭТОТ ХОД НЕДОСТУПЕН/)
  // Агент читает все четыре выхода и примеряет к себе; у последнего пометка была, у
  // первого — нет, хотя он несёт подпись человека по определению.
  assert.ok(
    r.stderr.indexOf('ТОЛЬКО ЧЕЛОВЕК') < r.stderr.indexOf('FIRM2_STALE_REVIEW=i-know'),
    'пометка стоит у первого выхода, а не только у последнего',
  )
})

test('разделить не удалось — сказано прямо, а общий список за своё не выдаётся (И-12)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p, 'T-001')
  // Ветки поставки под тем именем, которое знает расписка, больше нет: дифф «своё против
  // основания» не прочитать. Это известное состояние, а не повод назвать всё своим.
  p.git('checkout', '-q', '-b', 'tmp-head')
  p.git('branch', '-D', `feature/${p.change}`)
  const r = guard(p, 'git -C . merge --no-ff task/T-001')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /РАЗДЕЛИТЬ НЕ УДАЛОСЬ/)
  assert.doesNotMatch(r.stderr, /Своих правок/, 'число, которого не знаем, не печатается')
})

// ── Д-74: текст, пришедший значением ключа, командой не является ─────────────
//
// Отчёт проект-В 10.11.2026, движок 0.4.136. Лекарство от Д-22 накрывало ОДИН способ передать
// текст данными: тело heredoc снималось перед разбором, а значение кавычечного аргумента —
// нет. Их замер: одна и та же строка «git merge --no-edit task/T-404» в `--notes "…"` давала
// ОТКАЗ, а телом heredoc проходила. Одно правило, два ответа, и разница только в способе
// передачи.
//
// Платила за это запись РЕШЕНИЙ: `record --stage lifecycle --event superseded --notes
// "<разбор на 4 КБ>"` дважды отменён как «команда слияния», хотя ни строки по git в нём нет.
// Чем точнее разбор называл исполнителю шаг — а называть точный шаг требуют наши же правила
// нарезки, — тем вероятнее был отказ: разбор начинал писаться с оглядкой на сторожа.
test('Д-74: слова слияния в значении --notes не делают запись события слиянием', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p) // расписка протухла: будь это слиянием, сторож бы сработал
  const cmd =
    `node firm-event.mjs record --ticket T-001 --stage lifecycle --event superseded ` +
    `--actor human --notes "исполнителю заменяющей задачи: git merge --no-edit task/T-001, ` +
    `затем git push. Помеха: сторож расписки читал эту строку как команду"`
  const r = guard(p, cmd)
  assert.equal(r.status, 0, `запись решения отклонена как слияние: ${r.stderr}`)
  assert.equal(r.stderr.trim(), '', 'и даже не прокомментирована')
})

test('Д-74: та же строка телом heredoc тоже проходит — ответ один на два способа', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)
  const r = guard(p, `cat > n.md <<'EOF'\nисполнителю: git merge --no-edit task/T-001\nEOF`)
  assert.equal(r.status, 0)
  assert.equal(r.stderr.trim(), '', 'прежнее поведение heredoc не тронуто')
})

test('Д-74: снимаются и другие текстовые ключи, включая форму --key=значение', (t) => {
  for (const cmd of [
    'firm-event.mjs record --ticket T-001 --notes="git merge --no-ff task/T-001"',
    "firm-event.mjs record --ticket T-001 --message 'git merge task/T-001'",
    'gh pr comment --body "слить вручную: git merge --no-ff task/T-001"',
    'firm-state.mjs note --why "git merge task/T-001 падал на конфликте"',
  ]) {
    const p = makeProject(t, { tasks: ['T-001'] })
    staleScene(p)
    const r = guard(p, cmd)
    assert.equal(r.status, 0, `текст принят за команду: ${cmd}\n${r.stderr}`)
  }
})

// Оставшаяся половина Д-74 (замер проект-В 10.11.2026, независимая проверка краёв: 8 из 10).
// Форм передачи две — «ключ пробел значение» и `ключ=значение`, — а кавычки первая редакция
// разбирала только в первой: `--notes="a git merge …"` снималось до первого пробела, и хвост
// значения снова читался как команда. Та же фигура, которой описан весь дефект: одно правило
// с двумя ответами, только теперь не heredoc против кавычек, а две формы одного ключа.
test('Д-74: в форме --ключ="значение с пробелами" значение снимается ЦЕЛИКОМ', (t) => {
  for (const cmd of [
    'firm-event.mjs record --ticket T-001 --notes="исполнителю: git merge --no-edit task/T-001, затем push"',
    "firm-event.mjs record --ticket T-001 --notes='исполнителю: git merge --no-edit task/T-001'",
    'gh pr comment --body="слить вручную: git merge --no-ff task/T-001 и проверить"',
  ]) {
    const p = makeProject(t, { tasks: ['T-001'] })
    staleScene(p)
    const r = guard(p, cmd)
    assert.equal(r.status, 0, `значение снято наполовину, хвост прочитан как команда: ${cmd}\n${r.stderr}`)
  }
})

test('Д-74: снятие значения не съедает соседнюю команду ни в одной из двух форм', (t) => {
  // Признак, отличающий лекарство от обхода: четыре строки ОТКАЗ обязаны остаться ОТКАЗ.
  for (const cmd of [
    'firm-event.mjs record --notes="git merge task/T-001" && git -C /repo merge --no-ff task/T-001',
    "firm-event.mjs record --notes='текст' ; git -C /repo merge --no-ff task/T-001",
  ]) {
    const p = makeProject(t, { tasks: ['T-001'] })
    staleScene(p)
    const r = guard(p, cmd)
    assert.equal(r.status, 2, `настоящее слияние за снятым значением пропущено: ${cmd}`)
  }
})

test('Д-74: НАСТОЯЩЕЕ слияние ловится по-прежнему — лекарство не ослабило сторож', (t) => {
  // Признак, отличающий лекарство от обхода (их формулировка, и она верная): первая строка
  // замера обязана стать «проходит», третья — остаться «ОТКАЗ».
  for (const cmd of [
    'git -C /repo merge --no-edit task/T-001',
    // Сообщение коммита снято, но слияние рядом — настоящее, и оно ловится.
    'git -C /repo merge --no-ff task/T-001 -m "git merge вручную"',
    // Текстовый ключ без значения (следом другой ключ) не съедает соседнюю команду.
    'git -C /repo merge --no-edit task/T-001 --notes --quiet',
    // Слияние ПОСЛЕ записи решения: хвост сохраняется, как и за телом heredoc.
    'firm-event.mjs record --notes "git merge task/T-001" && git -C /repo merge --no-ff task/T-001',
  ]) {
    const p = makeProject(t, { tasks: ['T-001'] })
    staleScene(p)
    const r = guard(p, cmd)
    assert.equal(r.status, 2, `слияние пропущено: ${cmd}\n${r.stdout}${r.stderr}`)
  }
})

test('Д-74: `bash -c "git push"` остаётся отправкой — снимаем ключи, а не кавычки', (t) => {
  // Почему не «снимать всё кавычечное»: команда, переданная оболочке строкой, — настоящая,
  // и пропустить её хуже, чем задержать чтение. Поэтому список текстовых ключей именованный.
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)
  const r = guard(p, `bash -c "git -C /repo merge --no-ff task/T-001"`)
  assert.equal(r.status, 2, 'слияние внутри bash -c обязано ловиться')
})

test('Д-74: отказ называет третий путь — «слияния в команде нет, слова пришли текстом»', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  staleScene(p)
  const r = guard(p, 'git -C /repo merge --no-ff task/T-001')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /СЛИЯНИЯ В НЕЙ НЕТ/, 'первый вопрос рецепта — тот ли это случай вообще')
  assert.match(r.stderr, /ЛОЖНОЕ guard\/review-stale/, 'сказано, чем плох обход через FIRM2_STALE_REVIEW здесь')
})
