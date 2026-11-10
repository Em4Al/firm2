#!/usr/bin/env node
// Расписка об отправке наружу (ADR-0014).
//
// Отвечает на вопрос, на который движок не мог ответить ничем: что из проекта уехало
// наружу и когда. `secret-scan` закрывает соседний и более узкий — ключ не попадает в
// коммит; код уезжает не только ключами и не только коммитами.
//
// ЭТО УЧЁТ, А НЕ КОНТРОЛЬ, и граница тут проведена сознательно (формулировка перенята у
// gstack дословно: ledger записывает ПОПЫТКУ отправки, чтобы случайность была разбираема, и
// средством контроля утечки не является). Контроль у нас уже есть — песочница пускает сеть
// через фильтрующий прокси, и хост не из белого списка не отвечает вовсе. Расписка отвечает
// на другой вопрос: что прошло через разрешённое.
//
// Отсюда ДВА следствия, и оба обязаны быть видны в коде, а не только в ADR:
//   1. Гвард ничего не останавливает — всегда exit 0. Гвард, держащий `git push`, снимут в
//      первый же день, и снимут правильно: пуш — штатная работа.
//   2. Fail-open на любой своей ошибке. Отправка, сломанная из-за того, что её не смогли
//      записать, вреднее незаписанной. Значит и опереться на «расписки нет — не отправляли»
//      нельзя: отправить мимо неё можно, например командой неизвестной формы.
//
// Полезной нагрузки в расписке нет — только хост, ссылка и отпечаток. Команда проходит через
// `redact` из secrets.mjs: иначе `curl` с токеном в URL положил бы этот токен в журнал, то
// есть расписка стала бы вторым местом, где лежит секрет.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { relative, isAbsolute, resolve } from 'node:path'
import {
  repoRoot, readConfig, writeEvent, listEvents, taskTree, worktreesDir, listWorktrees,
  ticketFromBranch, activeChange, receiptDigest,
  gitSubcommands,
} from './lib/firm.mjs'
import { redact } from './lib/secrets.mjs'

// Уровень поставки. Не `unknown`: событие с `unknown` — дыра по И-7, и человек, пушнувший
// из главного дерева, красил бы `doctor` каждым своим пушем.
const DELIVERY_TICKET = 'MR'

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

// Что считается отправкой наружу. Образцы узкие намеренно: расписка на каждый `git status`
// превратила бы журнал в лог и обесценила бы настоящие (тот же довод, что у образцов
// secret-scan).
const SINKS = [
  { sink: 'pr', re: /\b(?:gh\s+(?:pr|release)\s+create|glab\s+mr\s+create)\b/ },
  { sink: 'publish', re: /\b(?:npm\s+publish|docker\s+push|twine\s+upload|gh\s+release\s+upload)\b/ },
  { sink: 'copy', re: /\b(?:scp|rsync|sftp)\b[\s\S]{0,200}?[\w.-]+@[\w.-]+:/ },
  { sink: 'http', re: /\b(?:curl|wget|http|https)\b[\s\S]{0,200}?https?:\/\// },
]

// Пуш опознаётся РАЗБОРОМ ПОДКОМАНДЫ, а не подстрокой «push» в тексте (Д-20 проект-В
// 28.10.2026). Образец `\bgit\b…\bpush\b` ловил `git stash push` — укладку в локальный
// карман перед слиянием, — а заодно слово `push` внутри `echo` в читающей команде
// (`git branch -r && echo "--- рефлог push? ---"`). Цена не в лишней строке: расписка об
// отправке — удостоверение (ADR-0014), и поток из ложных расписок делает настоящую
// неотличимой. На поставке со множеством слияний ложные и составляли весь `guard/egress`.
//
// Сам разбор живёт в lib: тот же дефект случился во ВТОРОМ стороже (Д-22, сторож расписки
// о ревью отклонял `git merge-base`), и две копии правила означали бы две разные починки.
function sinkOf(cmd) {
  // Пуш — первым: он точнее остальных образцов и не должен проигрывать им по порядку.
  if (gitSubcommands(cmd).some((g) => g.sub === 'push')) return 'push'
  for (const s of SINKS) if (s.re.test(cmd)) return s.sink
  return null
}

// Хост получателя. Для пуша спрашиваем git — имя remote в команде не адрес, а псевдоним, и
// отвечать «origin» на вопрос «куда уехало» значит не отвечать вовсе.
function hostOf(root, sink, cmd) {
  // Адрес, названный в самой команде, сильнее псевдонима remote — и спрашивать его надо
  // ПЕРВЫМ, включая пуш. `git push https://user:pass@host/repo.git main` псевдонима не
  // содержит вовсе, и разбор «первое слово после push» давал там `https`, то есть хост
  // терялся ровно в том случае, где он важнее всего: пуш в чужой репозиторий мимо origin
  // (поймано тестом 21.10.2026).
  const url = cmd.match(/https?:\/\/([^/\s'"]+)/)
  if (url) return url[1].replace(/^[^@]*@/, '') // из `user:token@host` оставляем host
  if (sink === 'copy') {
    const m = cmd.match(/[\w.-]+@([\w.-]+):/)
    if (m) return m[1]
  }
  if (sink === 'push' || sink === 'pr' || sink === 'publish') {
    // Имя remote берём из РАЗОБРАННОЙ подкоманды, а не из текста: `git stash push -- path`
    // отдавал здесь `--`, и адрес подставлялся к команде, которая никуда не отправляла.
    const parsed = gitSubcommands(cmd).find((g) => g.sub === 'push')
    const named = parsed ? parsed.rest.find((t) => !t.startsWith('-')) : null
    const remote = named || 'origin'
    try {
      const url = execFileSync('git', ['-C', root, 'remote', 'get-url', remote], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const h = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]*@)?([^/:]+)/i)
      return h ? h[1] : url.slice(0, 60)
    } catch {
      return null
    }
  }
  return null
}

// Что именно отправляют: ветка для пуша, URL для сети. Длинного содержимого здесь быть не
// должно — это ссылка, а не нагрузка.
function refOf(sink, cmd) {
  if (sink === 'push') {
    const m = cmd.match(/\bpush\b[\s\S]{0,120}?\b((?:task|feature)\/[\w.-]+|HEAD|main|master)\b/)
    return m ? m[1] : null
  }
  const u = cmd.match(/https?:\/\/[^\s'"]+/)
  if (u) return redact(u[0].replace(/\/\/[^@/]*@/, '//'))
  return null
}

// Задача, от чьего имени идёт отправка. Три источника по убыванию надёжности: ветка в самой
// команде, рабочее дерево вызова, и уровень поставки — тот же порядок, что у привязки
// события (ADR-0004).
function ticketOf(root, cfg, cmd, cwd) {
  const inRef = cmd.match(/\btask\/(T-[\w.]+)/)
  if (inRef) return inRef[1]
  const abs = cwd ? (isAbsolute(cwd) ? cwd : resolve(root, cwd)) : null
  if (abs) {
    const dir = worktreesDir(root, cfg || {})
    for (const w of listWorktrees(root)) {
      const t = ticketFromBranch(w.branch)
      if (!t) continue
      const rel = relative(w.path, abs)
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return t
    }
    if (dir) {
      const rel = relative(dir, abs)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        const first = rel.split(/[\\/]/)[0]
        if (/^T-[\w.]+$/.test(first)) return first
      }
    }
  }
  return DELIVERY_TICKET
}

// Предыдущая расписка ТОЙ ЖЕ задачи. Цепочка по задаче, а не по проекту: стадии идут
// параллельно, и общая цепочка дала бы вилку на двух одновременных отправках (ADR-0014).
function prevOf(root, ticket) {
  const mine = listEvents(root)
    .filter((e) => !e._broken && e.stage === 'guard' && e.event === 'egress' && e.ticket === ticket && e.digest)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
  return mine.length ? mine[mine.length - 1].digest : null
}

function main() {
  const h = readStdin()
  if (!h) process.exit(0)

  const ti = h.tool_input || {}
  const tool = String(h.tool_name || '')
  let sink = null
  let cmd = ''

  // WebFetch и WebSearch — отдельный путь отправки: запрос уходит наружу мимо и песочницы,
  // и git, и никакой команды, которую можно было бы узнать образцом, тут нет.
  if (/^WebFetch$/i.test(tool)) {
    sink = 'http'
    cmd = String(ti.url || '')
  } else if (/^WebSearch$/i.test(tool)) {
    sink = 'search'
    cmd = String(ti.query || '')
  } else {
    cmd = String(ti.command || '')
    sink = sinkOf(cmd)
  }
  if (!sink || !cmd) process.exit(0)

  const root = process.env.CLAUDE_PROJECT_DIR || repoRoot()
  if (!root) process.exit(0)
  const cfg = readConfig(root)
  if (!cfg || cfg.engine !== 'firm2') process.exit(0)

  const ticket = ticketOf(root, cfg, cmd, h.cwd || process.cwd())
  const host = sink === 'search' ? null : hostOf(root, sink, cmd)
  const ref = sink === 'search' ? null : refOf(sink, cmd)
  // Отпечаток содержимого есть только там, где отправляют ветку задачи. Для сети его нет и
  // выдумывать нечего (И-12): хеш запроса ответил бы на другой вопрос.
  const tree = sink === 'push' && ticket !== DELIVERY_TICKET ? taskTree(root, ticket) : null

  const ts = new Date().toISOString()
  const prev = prevOf(root, ticket)
  const digest = receiptDigest({ prev, ts, ticket, sink, host, ref, tree })

  writeEvent(root, {
    ts,
    change: activeChange(root),
    ticket,
    stage: 'guard',
    event: 'egress',
    actor: 'egress',
    prev,
    digest,
    egress: { sink, host, ref, tool: tool || 'Bash' },
    ...(tree ? { tree } : {}),
    notes: `${sink}${host ? ` → ${host}` : ''}${ref ? ` (${ref})` : ''}: ${redact(cmd)}`,
  })
  process.exit(0)
}

// Fail-open целиком, а не только по веткам: расписка не вправе ломать отправку (ADR-0014).
// Молчать при этом нельзя — строка в stderr стоит ничего, а «учёт тихо не ведётся» — это
// ровно та дыра, ради закрытия которой он заводился.
try {
  main()
} catch (e) {
  process.stderr.write(`[firm2] расписка об отправке не записана: ${e.message}\n`)
  process.exit(0)
}
