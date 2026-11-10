#!/usr/bin/env node
// Счёт СТАДИИ: сколько она шла и куда делось её время.
//
// Пятый замер движка, и заведён он по разбору 30.10.2026. Вопрос «почему стадия теста шла
// два с половиной часа» машинного ответа не имел вовсе: журнал знает, когда стадия
// началась и кончилась, и не знает ничего о том, что внутри. Ответ пришлось собирать
// руками, читая транскрипт субагента, — и он оказался не про нарезку задач и не про
// лишние тесты: 7.3 часа из 15.1 часа стадий волны ушли в циклы ожидания собственных
// прогонов, запущенных фоном, потому что вызов команды обрывается примерно на десяти
// минутах.
//
// Порог выражается в замеренном (ADR-0010), а замеренного здесь не было. Теперь есть:
//
//   node scripts/stage-bill.mjs                 # человеку, по активной поставке
//   node scripts/stage-bill.mjs --json          # машине
//   node scripts/stage-bill.mjs --ticket T-199  # одна задача
//   node scripts/stage-bill.mjs --top 30        # сколько строк показать
//
// Что считается. Для каждой законченной стадии берётся её транскрипт (по `agent_id` и
// `session_id` события) и разбираются вызовы команд:
//   • шла     — от первого вызова до последнего (календарь стадии по её же следам);
//   • ждала   — сумма промежутков после вызовов, которые ничего не делали, кроме `sleep`;
//   • прогонов набора — вызовов проектной команды тестов целиком (`stack.test_cmd` и
//     `task_test_cmd`), без адресных, с фильтром по пути или имени теста;
//   • вызовов — сколько раз стадия вообще звала командную строку.
//
// Чего он НЕ делает: не судит и не запрещает. Код возврата всегда 0 (ADR-0009) — находка
// замера это кандидат, а решение за человеком.
import { readFileSync, existsSync } from 'node:fs'
import {
  repoRoot, readConfig, listEvents, activeChange, agentTranscriptPath, humanDuration, stageBudget,
} from './lib/firm.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}
const onlyTicket = valueOf('--ticket')
const top = Number(valueOf('--top')) > 0 ? Number(valueOf('--top')) : 20

const root = repoRoot()
if (!root) {
  process.stdout.write('[firm2] не репозиторий — считать нечего\n')
  process.exit(0)
}
const cfg = readConfig(root) || {}
const change = valueOf('--change') || activeChange(root)

// Команды прогона проекта. Адресный вызов отличается от полного ТЕМ ЖЕ признаком, который
// назван ролям: есть ли в команде указание на конкретный тест или файл. Строгого разбора
// командной строки здесь нет и быть не может — командная строка это чужой язык; признак
// грубый и назван грубым.
const TEST_CMDS = [
  (cfg.stack && cfg.stack.test_cmd) || '',
  (cfg.stack && cfg.stack.task_test_cmd) || '',
].filter(Boolean)
const ADDRESSED = /::|--test\s+\S+\.(mjs|js|ts)|-k\s|--last-failed|\.py\b|\.test\./
// Исключающие флаги путь НАЗЫВАЮТ, но прогон от этого адресным не становится: `pytest
// --ignore=tests/test_t036...py` — это полный набор минус один файл. Проверено на живом
// замере: без этой строки стадия T-199 с тремя полными прогонами показывала ноль.
const EXCLUDING = /(--ignore|--deselect|--ignore-glob)(=|\s+)\S+/g

function bashCalls(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r = null
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const content = r && r.message && Array.isArray(r.message.content) ? r.message.content : []
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.name === 'Bash' && c.input && c.input.command) {
        out.push({ ts: r.timestamp || null, cmd: String(c.input.command) })
      }
    }
  }
  return out
}

// Ожидание: вызов, который только спит. Считается не намерением команды, а ФАКТОМ — от
// её запуска до следующего вызова: столько стадия и простояла. Последний вызов стадии
// промежутка не имеет, и ожидание в нём не считается вовсе.
const SLEEP_ONLY = /^[^\n]*\bsleep\s+\d/
function billOf(calls) {
  const stamped = calls.filter((c) => c.ts)
  if (!stamped.length) return null
  const t = (c) => Date.parse(c.ts)
  let waited = 0
  let polls = 0
  let full = 0
  for (let i = 0; i < stamped.length; i += 1) {
    const c = stamped[i]
    const sleeps = SLEEP_ONLY.test(c.cmd) || /\bsleep\s+\d/.test(c.cmd)
    if (sleeps) {
      polls += 1
      if (i + 1 < stamped.length) waited += Math.max(0, t(stamped[i + 1]) - t(c))
    }
    const bare = c.cmd.replace(EXCLUDING, '')
    if (TEST_CMDS.some((x) => bare.includes(x)) && !ADDRESSED.test(bare)) full += 1
  }
  return {
    calls: stamped.length,
    span_ms: Math.max(0, t(stamped[stamped.length - 1]) - t(stamped[0])),
    waited_ms: waited,
    polls,
    full_runs: full,
  }
}

// Считаем по АГЕНТАМ, а не по событиям: одна стадия пишет не одно событие (панель ревью —
// три голоса, финиш и вердикт — два события одного агента), и счёт по событиям показал бы
// одну стадию восемь раз, умножив её время на восемь. Агент — это и есть стадия.
const events = listEvents(root, { change }).filter((e) => !e._broken)
const byAgent = new Map()
for (const e of events) {
  if (e.event === 'started' || !e.agent_id) continue
  const prev = byAgent.get(e.agent_id)
  if (!prev || Date.parse(e.ts) > Date.parse(prev.ts)) byAgent.set(e.agent_id, e)
}
const rows = []
for (const e of byAgent.values()) {
  if (onlyTicket && e.ticket !== onlyTicket) continue
  const path = agentTranscriptPath(root, e.session_id, e.agent_id)
  if (!path || !existsSync(path)) continue
  const bill = billOf(bashCalls(path))
  if (!bill) continue
  rows.push({
    ticket: e.ticket, stage: e.stage, event: e.event, attempt: e.attempt || 1, ts: e.ts,
    over_budget: e.over_budget || null, ...bill,
  })
}
rows.sort((a, b) => b.span_ms - a.span_ms)

const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0)
const budgets = stageBudget(cfg)
const total = {
  change,
  stages: rows.length,
  span_ms: sum('span_ms'),
  waited_ms: sum('waited_ms'),
  full_runs: sum('full_runs'),
  // Доля ожидания — то самое число, ради которого замер заведён: оно отвечает на вопрос
  // «стадия работала или ждала», а он не выводится ни из календаря, ни из токенов.
  waited_share: sum('span_ms') ? Math.round((sum('waited_ms') / sum('span_ms')) * 100) : 0,
  over_budget: rows.filter((r) => r.over_budget).length,
  budgets,
}

if (json) {
  process.stdout.write(JSON.stringify({ ...total, stages_detail: rows }, null, 1) + '\n')
  process.exit(0)
}

process.stdout.write(`[firm2] счёт стадий — поставка ${change || 'не выбрана'}\n\n`)
if (!rows.length) {
  process.stdout.write(
    'Считать нечего: ни у одной законченной стадии не нашлось транскрипта.\n' +
    'Это нормально для старых поставок — транскрипты живут в каталоге сессии и стираются\n' +
    'вместе с ней. Замер отвечает про ЖИВУЮ работу, и молчание здесь значит «не записано»,\n' +
    'а не «стадии были мгновенными».\n',
  )
  process.exit(0)
}
process.stdout.write(
  `Стадий с записями: ${total.stages}. Суммарно шли ${humanDuration(total.span_ms)}, ` +
  `из них ЖДАЛИ ${humanDuration(total.waited_ms)} (${total.waited_share}%).\n` +
  `Прогонов набора целиком: ${total.full_runs}` +
  (Object.keys(budgets).length
    ? `. Бюджет: ${Object.entries(budgets).map(([s, m]) => `${s} ${m}м`).join(', ')}, ` +
      `за бюджет вышли ${total.over_budget}.\n`
    : '. Бюджет стадии проектом снят.\n'),
)
process.stdout.write('\n')
const pad = (s, n) => String(s).padEnd(n)
process.stdout.write(`${pad('задача', 9)}${pad('стадия', 14)}${pad('шла', 10)}${pad('ждала', 10)}${pad('опросов', 9)}${pad('наборов', 9)}вызовов\n`)
for (const r of rows.slice(0, top)) {
  process.stdout.write(
    pad(r.ticket, 9) + pad(`${r.stage}#${r.attempt}`, 14) +
    pad(humanDuration(r.span_ms), 10) + pad(r.waited_ms ? humanDuration(r.waited_ms) : '—', 10) +
    pad(r.polls || '—', 9) + pad(r.full_runs || '—', 9) + r.calls +
    (r.over_budget ? `  ← за бюджет (${r.over_budget.minutes} мин при ${r.over_budget.budget})` : '') + '\n',
  )
}
if (rows.length > top) process.stdout.write(`… и ещё ${rows.length - top} стадий (--top N)\n`)
process.stdout.write(
  '\nКак читать. «Ждала» — время после вызовов, которые только спали: стадия запустила\n' +
  'прогон фоном и опрашивала его, потому что вызов обрывается примерно на десяти минутах.\n' +
  'Это не работа и не чужое время — это цена прогона, который стадии не по размеру.\n' +
  'Лечится не терпением: сужением задачного набора (stack.task_test_cmd), адресными\n' +
  'прогонами на мутациях и основанием, которое движок снимает один раз на волну.\n',
)
