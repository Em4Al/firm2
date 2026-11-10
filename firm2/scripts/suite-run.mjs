#!/usr/bin/env node
// Долгий прогон набора — МЕХАНИКА движка, а не поведение, которое просят соблюдать словами.
//
// Отчёт проект-В 03.11.2026, находка 5. Роль упаковки два захода из двух увела полный прогон
// (`uv run pytest`, 43 минуты) в фон и закончила ход. Первый раз прогон потерялся целиком и
// его гоняли заново; второй раз промпт запрещал это ДОСЛОВНО, называл цену первого случая и
// предписывал дробить набор — роль всё равно ушла в фон. Два из двух при явном запрете.
//
// Корень не в послушании. Потолок одного вызова инструмента — 10 минут, набор идёт 43:
// синхронно его не прогнать вовсе, а у роли из средств остаётся только фон. Запрет без
// исполнимого пути — это запрет, который обходят, и обошли его оба раза (тот же довод, что
// у `guard.full_suite` в `bash-guard.mjs`). Значит путь обязан нести движок.
//
// Устройство. Прогон запускается ОТДЕЛЬНЫМ процессом, переживающим вызов инструмента и ход
// роли, а роль ждёт его короткими ожиданиями, каждое внутри своего вызова:
//
//   start  — запустить и вернуть `id`. Вывод идёт в файл, процесс отвязан (`detached`).
//   wait   — ждать до `--timeout` секунд (по умолчанию 540, то есть внутри потолка 10 минут)
//            и вернуть либо `state: "running"` с прогрессом, либо итог прогона.
//   status — снимок без ожидания.
//   list   — какие прогоны есть и какие ещё идут.
//
// Вторая половина находки 5 — в том же механизме. В итоговом отчёте роль назвала причину
// единственного красного НЕВЕРНО: «11 снятых файлов проверок из T-140…T-214», тогда как в
// логе это `PASSED`-строки другого файла, параметризованного именами снятых проверок.
// Настоящий ответ (`pass 1103 / fail 2`) лежал в сводке раннера, до которой роль не дошла.
// Поэтому сводку снимает скрипт: `summary` — это разобранные числа раннера, а не строки,
// выбранные глазами из середины вывода. Не разобрали — говорим «не разобрано» и даём хвост
// файла (ADR-0007: неопределённость не выдаётся за ответ).
//
// Чего скрипт НЕ делает. Он не решает, что гнать: команду даёт зовущий (`--cmd`), и потолок
// на полный набор в стадии задачи остаётся за `bash-guard.mjs` — вызов с полной командой
// проекта он видит и здесь, потому что команда стоит в той же строке. Он не судит красноту:
// «упало 2» — это число, а не вердикт, и что с ним делать, решает роль и человек (ADR-0009).

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot, readConfig, writeEvent, isBoundTicket, requireKnownFlags} from './lib/firm.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_')
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const root = args.root ? String(args.root) : repoRoot()

function runsDir() {
  return join(root, '.firm', 'runs')
}

// Пауза без таймеров — тот же приём, что в привязке события (`lib/firm.mjs`): ожидание идёт
// в короткоживущем процессе, и делать всю цепочку асинхронной ради `setTimeout` незачем.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function metaPath(id) {
  return join(runsDir(), `${id}.json`)
}
function logPath(id) {
  return join(runsDir(), `${id}.log`)
}
function codePath(id) {
  return join(runsDir(), `${id}.code`)
}

function readMeta(id) {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf8'))
  } catch {
    return null
  }
}

// ── Сводка раннера ────────────────────────────────────────────────────────────
//
// Разбираем ТОЛЬКО то, что раннер сам объявил итогом, и только с конца файла: середина
// вывода полна строк, похожих на ответ (`PASSED`, `ok`, имена параметров), и ровно на такой
// строке роль проект-В и назвала причину красного неверно.
//
// Образцы заведены под то, что в проектах движка встречается: pytest, node:test, vitest и
// собственный раннер живых браузерных проверок проект-В (`ℹ pass 1103` / `ℹ fail 2`). Чужой
// раннер — это `summary: null` и `summary_why`, а не выдуманные числа.
function summarize(text) {
  const tail = text.length > 200000 ? text.slice(-200000) : text
  const num = (s) => (s === undefined ? null : Number(s))

  // pytest: «=== 2 failed, 1103 passed, 5 skipped in 2543.11s ===»
  const py = [...tail.matchAll(/^=+\s(.*?(?:passed|failed|error).*?)\s=+$/gm)].pop()
  if (py) {
    const line = py[1]
    const get = (word) => {
      const m = line.match(new RegExp(`(\\d+)\\s${word}`))
      return m ? Number(m[1]) : 0
    }
    return {
      runner: 'pytest',
      passed: get('passed'),
      failed: get('failed') + get('error') + get('errors'),
      skipped: get('skipped'),
      line,
    }
  }

  // node:test и vitest: «# pass 120» / «# fail 0», «Tests  3 failed | 120 passed»
  const nodePass = tail.match(/^#\spass\s(\d+)$/m)
  const nodeFail = tail.match(/^#\sfail\s(\d+)$/m)
  if (nodePass && nodeFail) {
    return {
      runner: 'node:test',
      passed: num(nodePass[1]),
      failed: num(nodeFail[1]),
      skipped: null,
      line: `pass ${nodePass[1]}, fail ${nodeFail[1]}`,
    }
  }
  const vit = tail.match(/^\s*Tests\s+(?:(\d+)\sfailed\s*\|\s*)?(\d+)\spassed/m)
  if (vit) {
    return { runner: 'vitest', passed: num(vit[2]), failed: num(vit[1]) || 0, skipped: null, line: vit[0].trim() }
  }

  // Свой раннер проекта: строки итога «pass N» и «fail M» (у проект-В с префиксом «ℹ»).
  const ownPass = [...tail.matchAll(/^\D{0,4}pass\s(\d+)\s*$/gm)].pop()
  const ownFail = [...tail.matchAll(/^\D{0,4}fail\s(\d+)\s*$/gm)].pop()
  if (ownPass && ownFail) {
    return {
      runner: 'свой раннер проекта',
      passed: num(ownPass[1]),
      failed: num(ownFail[1]),
      skipped: null,
      line: `pass ${ownPass[1]}, fail ${ownFail[1]}`,
    }
  }
  return null
}

function tailOf(text, lines = 40) {
  const all = text.split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

function snapshot(id) {
  const meta = readMeta(id)
  if (!meta) return { id, state: 'unknown', error: `прогон ${id} не найден в ${runsDir()}` }
  let text = ''
  try {
    text = readFileSync(logPath(id), 'utf8')
  } catch {
    text = ''
  }
  let code = null
  if (existsSync(codePath(id))) {
    const raw = readFileSync(codePath(id), 'utf8').trim()
    code = raw === '' ? null : Number(raw)
  }
  const finished = code !== null
  // Процесс, убитый сигналом, строки с кодом не оставит вообще (`kill -9`, перезагрузка,
  // снятый прогон). Тогда признак конца — отсутствие процесса: `kill(pid, 0)` не шлёт
  // сигнала, а только спрашивает, есть ли такой. Отвечаем `lost`, а не `finished`: итога
  // у этого прогона нет и выдумывать его нельзя (ADR-0007).
  let alive = true
  if (!finished && meta.pid) {
    try {
      process.kill(meta.pid, 0)
    } catch (e) {
      alive = e.code === 'EPERM' // чужой процесс под тем же pid — считаем живым, не врём
    }
  }
  const started = Date.parse(meta.started) || null
  // Длительность идущего прогона — от старта до СЕЙЧАС, законченного — до времени файла с
  // кодом возврата: иначе числа у одного и того же прогона будут расти после его конца.
  const endedAt = finished ? (statSync(codePath(id)).mtimeMs) : Date.now()
  const out = {
    id,
    state: finished ? 'finished' : (alive ? 'running' : 'lost'),
    cmd: meta.cmd,
    cwd: meta.cwd,
    ticket: meta.ticket || null,
    label: meta.label || null,
    pid: meta.pid || null,
    started: meta.started,
    duration_s: started ? Math.round((endedAt - started) / 1000) : null,
    log: logPath(id),
    log_bytes: text.length,
  }
  if (!finished && !alive) {
    out.exit_code = null
    out.summary = summarize(text)
    out.lost_why =
      'процесса нет, а строки с кодом возврата он не оставил: прогон убит сигналом или ' +
      'машина перезагружена. Итога у него НЕТ — гони заново, а не считай хвост лога итогом.'
  }
  if (finished) {
    out.exit_code = code
    const sum = summarize(text)
    out.summary = sum
    if (!sum) {
      out.summary_why =
        'сводка раннера не разобрана — числа НЕ выдуманы. Смотри хвост ниже и сам файл лога; ' +
        'код возврата при этом факт: 0 — раннер доволен, иное — нет.'
    }
  }
  out.tail = tailOf(text)
  return out
}

// Какие прогоны идут прямо сейчас. Смотрим реестр, а не процессы: `snapshot` уже умеет
// отличать идущий от брошенного сигналом, и под песочницей это единственный надёжный
// способ — `ps`/`pgrep` там не запускаются вовсе (отчёт проект-В 08.11.2026, Д-57).
function runningRuns() {
  if (!existsSync(runsDir())) return []
  return readdirSync(runsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => snapshot(f.slice(0, -5)))
    .filter((s) => s.state === 'running')
}

const sameCmd = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim()

function cmdStart() {
  const cmd = typeof args.cmd === 'string' ? args.cmd.trim() : ''
  if (!cmd) {
    process.stderr.write('[firm2] suite-run start: нужен --cmd "<команда прогона>"\n')
    process.exit(2)
  }
  const cwd = args.cwd ? String(args.cwd) : process.cwd()
  // ── Два одинаковых прогона из одного дерева ────────────────────────────────
  //
  // Отчёт проект-В 08.11.2026, Д-59 (случай 2). Роль упаковки запустила свой полный прогон
  // ОДНОВРЕМЕННО с прогоном Оркестратора из того же дерева: два `npm run test:browser`
  // состязались за браузеры, гейт упёрся в потолок 3600 с — и роль объявила этот таймаут
  // КРАСНЫМ ПОСТАВКИ. В одиночку тот же гейт уложился в 2370 с. Цена ложного красного —
  // час разбора.
  //
  // Это не вопрос аккуратности: ни роль, ни Оркестратор не видят чужой прогон, пока не
  // спросят реестр, а спрашивать его никто не велел. Значит держит механизм: пересечение
  // видно по `.firm/runs/`, и второй такой же прогон отменяется до старта. Отменяется
  // только ОДИНАКОВАЯ команда в ОДНОМ дереве: два разных набора рядом (линт и тесты) —
  // законное состояние, и запрещать его не за что; про них просто говорим вслух.
  const running = runningRuns()
  const clash = running.filter((r) => r.cwd === cwd && sameCmd(r.cmd, cmd))
  if (clash.length && !args.allow_parallel) {
    const r = clash[0]
    process.stderr.write(
      `[firm2] suite-run start: ОТКАЗ — этот прогон уже идёт в этом дереве.\n` +
        `  id ${r.id}, идёт ${r.duration_s} с, команда «${r.cmd}»\n` +
        `  дерево ${cwd}\n` +
        `Второй такой же прогон не ускоряет, а портит оба: на проект-В 08.11.2026 два\n` +
        `«npm run test:browser» из одного дерева состязались за браузеры, гейт упёрся в\n` +
        `потолок 3600 с, и таймаут был объявлен красным ПОСТАВКИ (в одиночку тот же гейт\n` +
        `уложился в 2370 с).\n` +
        `Что делать вместо запуска: дождаться идущего — он твой ответ.\n` +
        `  node "$ENGINE/scripts/suite-run.mjs" wait --id ${r.id}\n` +
        `Прогон точно нужен второй (другое дерево, другая ревизия) — скажи это явно:\n` +
        `  --allow-parallel, и назови в отчёте, ЗАЧЕМ их два.\n`,
    )
    process.exit(2)
  }
  const nearby = running.filter((r) => r.cwd === cwd && !sameCmd(r.cmd, cmd))
  mkdirSync(runsDir(), { recursive: true })
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`
  const fd = openSync(logPath(id), 'a')
  // `sh -c '( <команда> ); echo $? > <файл>'` — код возврата пишет сама оболочка. Живость
  // процесса по pid тут не годится: pid переиспользуются, а отвязанный процесс мы не
  // дожидаемся — признаком конца должен быть ФАКТ на диске, а не догадка о процессе.
  //
  // Скобки обязательны, и это не стиль: команда, кончающаяся на `exit`, без них выходит из
  // ТОЙ ЖЕ оболочки, и строка с кодом не пишется никогда — прогон кончился, а ожидание
  // ждёт его до таймаута. Поймано первым же зондом этого скрипта на `… ; exit 1`.
  const child = spawn('sh', ['-c', `( ${cmd} ); echo $? > ${JSON.stringify(codePath(id))}`], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  closeSync(fd)
  const meta = {
    id,
    cmd,
    cwd,
    pid: child.pid,
    started: new Date().toISOString(),
    label: args.label ? String(args.label) : null,
    ticket: args.ticket ? String(args.ticket) : null,
    // Кто запустил. Нужно не для отчётности: по этому полю хук стадии видит, что роль
    // кончила ход, а запущенный ею прогон ещё идёт (`guard/suite-abandoned`).
    agent_id: process.env.CLAUDE_AGENT_ID || null,
    session_id: process.env.CLAUDE_SESSION_ID || null,
  }
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 1) + '\n')
  return {
    ...meta,
    log: logPath(id),
    // Рядом идущие прогоны — не отказ, но и не молчание: соседний набор из того же дерева
    // делит с тобой браузеры, порты и диск, и если твой прогон упрётся в потолок, причина
    // может быть в нём, а не в поставке.
    ...(nearby.length
      ? {
        running_nearby: nearby.map((r) => ({ id: r.id, cmd: r.cmd, duration_s: r.duration_s })),
        nearby_why:
            'в этом же дереве уже идёт другой прогон. Это законно, но твои числа времени ' +
            'принадлежат обоим: таймаут при соседе — не красное поставки, а состязание за ' +
            'машину (проект-В, Д-59). Назови соседа, если будешь судить по времени.',
      }
      : {}),
    note:
      'Прогон идёт отдельным процессом и переживёт твой ход. Ждать его: ' +
      `suite-run.mjs wait --id ${id} — один вызов ждёт до 540 с (внутри потолка в 10 минут), ` +
      'и так, вызов за вызовом, до state: "finished". НЕ заканчивай ход, пока прогон идёт: ' +
      'незаконченный прогон на конце стадии движок запишет событием guard/suite-abandoned.',
  }
}

function cmdWait() {
  const id = args.id ? String(args.id) : null
  if (!id) {
    process.stderr.write('[firm2] suite-run wait: нужен --id (его вернул start)\n')
    process.exit(2)
  }
  // 540 с по умолчанию — потолок вызова инструмента 10 минут минус запас на ответ. Больше
  // ставить нельзя: вызов оборвут, и ожидание пропадёт вместе с ним.
  const timeout = Number(args.timeout) > 0 ? Math.min(Number(args.timeout), 900) : 540
  const until = Date.now() + timeout * 1000
  for (;;) {
    const snap = snapshot(id)
    if (snap.state !== 'running') return snap
    if (Date.now() >= until) {
      return {
        ...snap,
        waited_s: timeout,
        note:
          `прогон идёт ${snap.duration_s} с. Это НЕ сбой и не повод кончать ход: зови ` +
          `wait --id ${id} снова. Хвост лога выше показывает, что он жив.`,
      }
    }
    sleepMs(2000)
  }
}

function cmdList() {
  if (!existsSync(runsDir())) return { runs: [], note: 'прогонов не было' }
  const ids = readdirSync(runsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort()
  const runs = ids.map((id) => {
    const s = snapshot(id)
    return {
      id: s.id,
      state: s.state,
      ticket: s.ticket,
      label: s.label,
      cmd: s.cmd,
      duration_s: s.duration_s,
      exit_code: s.exit_code === undefined ? null : s.exit_code,
      summary: s.summary || null,
    }
  })
  return { runs, running: runs.filter((r) => r.state === 'running').map((r) => r.id) }
}

// ── Предъявление прогона ──────────────────────────────────────────────────────
//
// Отчёт проект-В 08.11.2026, Д-59 (случай 1). Роль упаковки объявила шаг ворот завершённым —
// «поставка готова к слиянию», — не дождавшись полного набора: два из четырёх ключевых
// файлов стояли в состоянии «завершаются», `dod.checked: false`. Прозой это читается как
// отчёт о прогоне; машинно прогона не было.
//
// Поэтому у ворот теперь есть машинный вопрос: ПРЕДЪЯВЛЕН ли долгий прогон. Ответ
// собирается из реестра `.firm/runs/` и состоит из того, что роль не может сказать словами:
// идентификатор прогона, код возврата, сводка раннера. Нет такого прогона — `ok: false`, и
// это ответ, а не ошибка: шаг просто не предъявлен (ADR-0007).
function cmdProof() {
  const ticket = args.ticket ? String(args.ticket) : null
  const cmd = typeof args.cmd === 'string' ? args.cmd.trim() : null
  if (!existsSync(runsDir())) {
    return {
      ok: false,
      ticket,
      cmd,
      runs: [],
      why:
        'прогонов не было вовсе (каталога .firm/runs нет): шаг, обязанный предъявить долгий ' +
        'прогон, не предъявил его. Отчёт прозой доказательством не является (проект-В, Д-59).',
    }
  }
  const all = readdirSync(runsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => snapshot(f.slice(0, -5)))
    .filter((s) => (!ticket || s.ticket === ticket) && (!cmd || sameCmd(s.cmd, cmd)))
    .sort((a, b) => String(a.started).localeCompare(String(b.started)))
  const brief = (s) => ({
    id: s.id,
    state: s.state,
    cmd: s.cmd,
    cwd: s.cwd,
    ticket: s.ticket,
    exit_code: s.exit_code === undefined ? null : s.exit_code,
    duration_s: s.duration_s,
    summary: s.summary || null,
    log: s.log,
  })
  const finished = all.filter((s) => s.state === 'finished')
  const running = all.filter((s) => s.state === 'running')
  const lost = all.filter((s) => s.state === 'lost')
  const out = { ok: false, ticket, cmd, runs: all.map(brief) }
  if (!all.length) {
    out.why =
      'ни одного прогона под эту привязку в реестре нет. Шаг, обязанный предъявить долгий ' +
      'прогон, не предъявил его: отчёт прозой доказательством не является (проект-В, Д-59).'
    return out
  }
  if (running.length) {
    out.why =
      `прогон ещё идёт (${running.map((r) => `${r.id}: ${r.duration_s} с`).join('; ')}) — ` +
      'шаг не кончен. Ждать: suite-run.mjs wait --id <id>.'
    return out
  }
  if (!finished.length) {
    out.why =
      'прогоны есть, но итога нет ни у одного: убиты сигналом или машина перезагружена ' +
      '(state: lost). Итога у таких прогонов НЕТ — гони заново.'
    return out
  }
  out.ok = true
  const last = finished[finished.length - 1]
  out.proof = brief(last)
  out.why =
    `предъявлен прогон ${last.id}: код возврата ${last.exit_code}, ` +
    (last.summary ? `сводка раннера ${JSON.stringify(last.summary)}` : 'сводка раннера НЕ разобрана — смотри лог') +
    (lost.length ? `. Рядом ${lost.length} прогон(ов) без итога — их числа не считать.` : '')
  return out
}

// Прогоны, брошенные стадией: роль их запустила и кончила ход, а они идут. Зовёт хук
// `SubagentStop` — там это единственный момент, когда факт ещё можно записать.
export function abandonedRuns(rootDir, agentId) {
  const dir = join(rootDir, '.firm', 'runs')
  if (!existsSync(dir) || !agentId) return []
  const out = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      let meta = null
      try {
        meta = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        continue
      }
      if (!meta || meta.agent_id !== agentId) continue
      if (existsSync(join(dir, `${meta.id}.code`))) continue // кончился — не брошен
      out.push(meta)
    }
  } catch {
    return out
  }
  return out
}

function usage() {
  return [
    'firm2 suite-run — долгий прогон набора, переживающий вызов инструмента и ход роли.',
    '',
    '  start  --cmd "<команда>" [--cwd <каталог>] [--ticket T-XXX] [--label "..."]',
    '                         запустить и вернуть id; вывод идёт в .firm/runs/<id>.log',
    '  wait   --id <id> [--timeout 540]',
    '                         ждать до timeout секунд: либо итог, либо state: "running"',
    '  status --id <id>       снимок без ожидания',
    '  list                   какие прогоны есть и какие ещё идут',
    '  proof  [--ticket T-XXX] [--cmd "<команда>"]',
    '                         предъявлен ли долгий прогон: id, код возврата, сводка раннера',
    '',
    'Зачем: потолок одного вызова — 10 минут, набор проекта идёт десятками минут, и роль,',
    'оставленная с этим наедине, уводит прогон в фон и теряет его (замер проект-В 03.11.2026:',
    'два захода из двух, 43 минуты каждый). Сводку снимает скрипт, а не глаз роли по логу.',
    '',
    'Два одинаковых прогона из одного дерева `start` отклоняет (--allow-parallel снимает):',
    'они состязаются за машину, и таймаут такого прогона однажды уехал как красное поставки',
    '(проект-В 08.11.2026). `proof` отвечает воротам, предъявлен ли прогон вообще.',
    '',
  ].join('\n')
}

function main() {
  // Неизвестный флаг — отказ, а не умолчание (Д-61): правило одно на все CLI движка
  // (`requireKnownFlags` в lib/firm.mjs). Стоит ВНУТРИ main, а не на уровне модуля: этот
  // файл импортирует хук стадии ради `abandonedRuns`, и сторож на уровне модуля судил бы
  // чужой argv — ровно та же ловушка, от которой здесь стоит проверка `import.meta.url`.
  requireKnownFlags(process.argv.slice(2), ['allow_parallel', 'cmd', 'cwd', 'id', 'label', 'ticket', 'timeout'], { cmd: 'suite-run.mjs', usage: usage() })
  const sub = args._[0]
  const cfg = readConfig(root)
  if (!sub) {
    process.stdout.write(usage())
    return
  }
  let res = null
  switch (sub) {
    case 'start': res = cmdStart(); break
    case 'wait': res = cmdWait(); break
    case 'status': res = snapshot(String(args.id || '')); break
    case 'list': res = cmdList(); break
    case 'proof': res = cmdProof(); break
    default:
      process.stderr.write(`[firm2] suite-run: неизвестная подкоманда «${sub}»\n\n${usage()}`)
      process.exit(2)
  }
  // Событие о запуске долгого прогона пишется только в проекте под firm2 и только когда
  // привязка известна: журнал чужого проекта — не наше дело, а событие без тикета — дыра.
  if (sub === 'start' && cfg && cfg.engine === 'firm2' && isBoundTicket(res.ticket)) {
    writeEvent(root, {
      ticket: res.ticket,
      stage: 'guard',
      event: 'suite-started',
      actor: 'suite-run',
      notes: `долгий прогон ${res.id}: ${res.cmd}`,
    })
  }
  process.stdout.write(JSON.stringify(res, null, 1) + '\n')
}

// Запускаемся только когда скрипт позвали НАПРЯМУЮ. Без этой проверки `import` из
// `firm-event.mjs` (там нужна `abandonedRuns`) исполнял бы CLI с чужим `argv` — то есть
// хук стадии падал бы на «неизвестной подкоманде hook». Поймано сразу после правки,
// тем же приёмом, что стоит в `dashboard.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
