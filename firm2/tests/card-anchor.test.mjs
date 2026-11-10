// КАРТОЧКА ЗАДАЧИ — ДОКУМЕНТ ПЛАНИРОВАНИЯ, И В ЕЁ КОНЕЦ НЕ ПИШУТ ДВЕ РУКИ.
//
// Второй отчёт проект-В 10.11.2026, п.2. Разобраны ВСЕ 90 событий merge-failed проекта:
// 23 (26%) упираются в файл `openspec/changes/<поставка>/tasks/T-NNN.md` — 14 прямых
// конфликтов своей карточки и 9 случаев, где несведённая карточка блокировала слияние
// следующей задачи. Четыре поставки подряд, две из них на существенно более старых
// версиях движка: фигура не менялась, менялись номера задач.
//
// Фигура всегда одна: общее начало карточки кончается планом, и дальше в одну точку
// дописывают ДВЕ РАЗНЫЕ РУКИ — стадия с ветки задачи («## Протокол проверки») и арбитраж
// с ветки поставки («## Доработка по BUG-NNN»). `task-merge.mjs` отказывает верно: общее
// начало, изменённое с двух сторон, это не дописывание, а выбор, и выбор принадлежит
// человеку (ADR-0009). Умнее сводить нельзя — сводить пришлось бы по смыслу.
//
// Причина была В САМОМ ДВИЖКЕ: он обеими инструкциями и посылал двух писателей в один
// якорь, хотя машинное место есть у обоих — у протокола закрывающее событие стадии, у
// текста решения арбитража `lifecycle/arbitrated`. Правка 0.4.140 убирает дублирование:
// протокол приезжает полем ответа, предписание — событием, а карточка остаётся планом.
//
// Тест держит обе половины: что инструкций дублирования больше НЕТ, и что протокол при
// этом не потерялся — он доходит и до события, и до промпта надзора.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBuildBody, makeProject } from './helpers.mjs'

const BODY = loadBuildBody()

test('ни один промпт движка больше не велит дописывать в файл задачи', () => {
  assert.ok(!/впиши в файл задачи/.test(BODY), 'протокол стадии: инструкция убрана')
  assert.ok(!/допиши в \$\{task\.path\}/.test(BODY), 'предписание арбитража: инструкция убрана')
  // И сказано, куда вместо этого, иначе запрет оставил бы протокол без места. Имя поля
  // здесь НЕ литерал: оно берётся по стадии (`PROTO_FIELD`), потому что у разработки и у
  // теста схемы разные — см. ниже тест про провод поля.
  assert.match(BODY, /верни ПОЛЕМ \\?`\$\{field\}/)
  assert.match(BODY, /const PROTO_FIELD = \{ dev: 'notes', test: 'protocol' \}/)
  assert.match(BODY, /ФАЙЛ ЗАДАЧИ НЕ ПРАВЬ/)
})

test('протокол стадии доходит до промпта Ревьюера', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const calls = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'm1', head: 'm1', cmd: 's', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: ['T-101'], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return {
        status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 },
        mutation_check: { done: true, evidence: 'м' },
        protocol: 'открыл экран, переключил рисунок, перезагрузил — выбор держится',
      }
    }
    if (label.startsWith('qa')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label.startsWith('merge-failed:') || label.startsWith('journal:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(label)
  }
  const parallel = async (ths) => Promise.all(ths.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, () => {}, () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '',
    tasks: [{ id: 'T-101', path: 'T-101.md', labels: ['требует-браузера'], parallel_safe: true }],
  }))
  const qa = calls.find((c) => c.label.startsWith('qa'))
  assert.ok(qa, 'ревью состоялось')
  assert.match(qa.prompt, /Протокол стадии, как она его предъявила/)
  assert.match(qa.prompt, /выбор держится/)
  assert.match(qa.prompt, /В ФАЙЛЕ ЗАДАЧИ протокола с 0\.4\.140 нет/)
})

test('протокол стадии попадает в закрывающее событие — через настоящий хук', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const path = join(p.root, 'agent.jsonl')
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input: {
      status: 'ok', report: { passed: 2, failed: 0, skipped: 0 },
      mutation_check: { done: true, evidence: 'сломал знак — упало 2' },
      protocol: 'поднял headless-shell, прошёл три состояния, снял скриншоты',
    } }] },
  }) + '\n')
  const r = p.cli('firm-event.mjs', ['hook', '--root', p.root], {
    input: JSON.stringify({
      agent_type: 'firm2:firm-tester', hook_event_name: 'SubagentStop', cwd: p.root, agent_id: 'pr-1',
      prompt: `FIRM2-TICKET: T-001\nFIRM2-CHANGE: ${p.change}`, agent_transcript_path: path,
    }),
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const evs = p.eventFiles().map((f) => JSON.parse(readFileSync(join(p.eventsPath, f), 'utf8')))
  const fin = evs.find((e) => e.event === 'finished' && e.stage === 'test')
  assert.ok(fin, 'финиш записан')
  assert.match(fin.notes, /протокол: поднял headless-shell/)
  // И числа прогона стоят ПЕРЕД протоколом: обрезка по общему пределу съест хвост
  // протокола, а не мутационную проверку.
  assert.ok(fin.notes.indexOf('мутация') < fin.notes.indexOf('протокол'), fin.notes)
})

// ПРОВОД ПОЛЯ: промпт не вправе называть поле, которого нет в схеме ЭТОЙ стадии.
//
// Седьмой прогон проект-В (10.11.2026) предъявил правку 0.4.140 неработающей: поля `protocol`
// не оказалось ни в одном из 16 событий прогона, а карточка T-416 получила раздел
// «## Протокол живой проверки» коммитом стадии РАЗРАБОТКИ. Причина — не в роли: один и тот
// же текст правила про браузер уходил в два промпта с РАЗНЫМИ схемами и обеим называл
// `protocol`, которого в `DEV_SCHEMA` нет. Вернуть протокол стадии разработки было некуда.
//
// Тест держит не литерал, а само правило — и потому ловит следующий такой провод, а не
// только этот: он снимает со КАЖДОГО промпта все имена полей, которые тот велит вернуть,
// и сверяет их со схемой, переданной ТЕМ ЖЕ вызовом.
async function runWave(t, { browser = true, tested = null } = {}) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const calls = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt, schema: opts.schema || null })
    if (label === 'пауза?') return { state: 'running' }
    if (label.startsWith('основание:')) return { state: 'ok', sha: 'm1', head: 'm1', cmd: 's', red: [], failed: 0, total: 10 }
    if (label === 'состояние поставки') return { state: 'ok', exists: ['T-101'], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      return tested || { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 }, mutation_check: { done: true, evidence: 'м' } }
    }
    if (label.startsWith('qa')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label.startsWith('merge-failed:') || label.startsWith('journal:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(label)
  }
  const parallel = async (ths) => Promise.all(ths.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, () => {}, () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo', worktrees_dir: '',
    tasks: [{ id: 'T-101', path: 'T-101.md', labels: browser ? ['требует-браузера'] : [], parallel_safe: true }],
  }))
  return calls
}

test('ни один промпт не велит вернуть поле, которого нет в его схеме', async (t) => {
  const calls = await runWave(t)
  let checked = 0
  for (const c of calls) {
    const props = c.schema && c.schema.properties ? c.schema.properties : null
    if (!props) continue
    for (const m of c.prompt.matchAll(/ПОЛЕМ `([a-z_]+)`/g)) {
      checked++
      assert.ok(
        Object.prototype.hasOwnProperty.call(props, m[1]),
        `${c.label}: промпт велит вернуть поле \`${m[1]}\`, а в схеме стадии его нет`,
      )
    }
  }
  assert.ok(checked >= 2, `проверено имён полей: ${checked} — провода на месте, иначе тест ничего не меряет`)
})

test('место протокола называется по стадии: у разработки notes, у теста protocol', async (t) => {
  const calls = await runWave(t)
  const dev = calls.find((c) => c.label.startsWith('dev:'))
  const tst = calls.find((c) => c.label.startsWith('test:'))
  assert.match(dev.prompt, /верни ПОЛЕМ `notes`/)
  assert.ok(!/верни ПОЛЕМ `protocol`/.test(dev.prompt), 'стадии разработки чужое поле больше не называется')
  assert.match(tst.prompt, /верни ПОЛЕМ `protocol`/)
})

test('пустой протокол на браузерной задаче назван, а не опущен', async (t) => {
  const quiet = { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 }, mutation_check: { done: true, evidence: 'м' } }
  const withBrowser = await runWave(t, { browser: true, tested: quiet })
  const qa = withBrowser.find((c) => c.label.startsWith('qa'))
  assert.match(qa.prompt, /ПРОТОКОЛ СТАДИИ НЕ ПРЕДЪЯВЛЕН/)
  // Вторая сторона замера: без метки браузера молчание законно — иначе лекарство стало бы
  // шумом на каждой задаче, а шум убивает сигнал надёжнее молчания.
  const noBrowser = await runWave(t, { browser: false, tested: quiet })
  const qa2 = noBrowser.find((c) => c.label.startsWith('qa'))
  assert.ok(!/ПРОТОКОЛ СТАДИИ НЕ ПРЕДЪЯВЛЕН/.test(qa2.prompt), 'на небраузерной задаче пустой протокол не обсуждается')
})
