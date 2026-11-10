// Обещания конфига про систему контроля версий (lib/firm.mjs, vcsFindings). Конфиг мог
// обещать `vcs.host: github` и `vcs.remote: origin`, а `git remote` — быть пустым, и
// узнавал об этом DevOps на шаге выдачи, когда вся поставка уже сделана (проект-В 05.10.2026).
// Проверка только локальная — сети не нужно, `git remote add` никуда не ходит.
import test from 'node:test'
import assert from 'node:assert/strict'
import { vcsFindings, readConfig } from '../scripts/lib/firm.mjs'
import { makeProject, plainDir } from './helpers.mjs'

// ── vcsFindings — секции нет или она неполная ─────────────────────────────────

test('vcsFindings: секции vcs нет вовсе — пустой массив (выдача руками законна)', (t) => {
  const p = makeProject(t, { tasks: [] })
  assert.deepEqual(vcsFindings(p.root, readConfig(p.root)), [])
})

test('vcsFindings: секция vcs есть, но без host — пустой массив', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  remote: origin\n' })
  assert.deepEqual(vcsFindings(p.root, readConfig(p.root)), [])
})

// ── vcs.host задан, remote отсутствует ────────────────────────────────────────

test('vcsFindings: host задан, git remote пуст — замечание с готовой командой на умолчании origin', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n' })
  const f = vcsFindings(p.root, readConfig(p.root))
  assert.equal(f.length, 1)
  assert.match(f[0], /удалённого репозитория нет вовсе/)
  assert.match(f[0], /git remote add origin <url>/, 'подсказка обязана назвать имя умолчания — origin')
})

test('vcsFindings: host задан, remote пуст, vcs.remote свой — подсказка называет ИМЕННО его, а не origin', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n  remote: upstream\n' })
  const f = vcsFindings(p.root, readConfig(p.root))
  assert.equal(f.length, 1)
  assert.match(f[0], /git remote add upstream <url>/)
  assert.doesNotMatch(f[0], /git remote add origin/)
})

// ── remote есть, но не тот, что назван в конфиге ──────────────────────────────

test('vcsFindings: remote есть, но не тот, что в vcs.remote — замечание перечисляет настоящие', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n  remote: upstream\n' })
  p.git('remote', 'add', 'origin', '/tmp/does-not-matter.git')
  const f = vcsFindings(p.root, readConfig(p.root))
  assert.equal(f.length, 1)
  assert.match(f[0], /vcs\.remote: upstream — такого удалённого нет/)
  assert.match(f[0], /Есть: origin/)
})

test('vcsFindings: remote совпадает с vcs.remote умолчанием (origin) — про remote замечаний нет', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n' })
  p.git('remote', 'add', 'origin', '/tmp/does-not-matter.git')
  assert.deepEqual(vcsFindings(p.root, readConfig(p.root)), [])
})

// ── vcs.target_branch ──────────────────────────────────────────────────────────

test('vcsFindings: target_branch не существует НИ локально, НИ на удалённом — «некуда вливаться»', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n  target_branch: release\n' })
  p.git('remote', 'add', 'origin', '/tmp/does-not-matter.git')
  const f = vcsFindings(p.root, readConfig(p.root))
  assert.equal(f.length, 1)
  assert.match(f[0], /vcs\.target_branch: release — такой ветки нет ни локально, ни на origin/)
  assert.match(f[0], /Поставке некуда вливаться/)
})

test('vcsFindings: ветка есть ЛОКАЛЬНО, на удалённом её нет — замечания про ветку быть не должно', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n  target_branch: release\n' })
  p.git('remote', 'add', 'origin', '/tmp/does-not-matter.git') // remote настоящий и совпадает — шума про него нет
  p.git('branch', 'release') // локальная ветка есть, на remote её не заводили
  assert.deepEqual(vcsFindings(p.root, readConfig(p.root)), [],
    'ветка годится локальная ИЛИ удалённая — наличия одной из двух достаточно')
})

test('vcsFindings: ветка есть ТОЛЬКО на удалённом (refs/remotes/<remote>/<ветка>) — замечания нет', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n  target_branch: release\n' })
  p.git('remote', 'add', 'origin', '/tmp/does-not-matter.git')
  const head = p.git('rev-parse', 'HEAD').trim()
  // Имитация отслеживаемой удалённой ветки без сети: сам git remote add никуда не ходит,
  // а remote-tracking ref можно завести вручную — это и есть то, что видит `rev-parse`.
  p.git('update-ref', `refs/remotes/origin/release`, head)
  assert.deepEqual(vcsFindings(p.root, readConfig(p.root)), [],
    'проверка обязана смотреть И refs/remotes/<remote>/<ветка>, а не только refs/heads')
})

test('vcsFindings: всё сходится (remote тот, ветка локальная) — пустой массив', (t) => {
  const p = makeProject(t, { tasks: [], extraConfig: 'vcs:\n  host: github\n  target_branch: main\n' })
  p.git('remote', 'add', 'origin', '/tmp/does-not-matter.git')
  assert.deepEqual(vcsFindings(p.root, readConfig(p.root)), [])
})

// ── Не git-репозиторий — функция не падает ────────────────────────────────────

test('vcsFindings: каталог не git-репозиторий — не падает, вызовы git обёрнуты', (t) => {
  const d = plainDir(t)
  assert.doesNotThrow(() => vcsFindings(d, { vcs: { host: 'github' } }))
  const f = vcsFindings(d, { vcs: { host: 'github' } })
  assert.equal(f.length, 1, 'git remote тоже вернёт null → пусто → то же замечание, что и у пустого remote')
})

// ── Где используется: doctor и phase ──────────────────────────────────────────

test('doctor: несоответствие vcs отдаётся полем vcs и НЕ валит ok', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'vcs:\n  host: github\n' })
  const d = p.evJson('doctor')
  assert.equal(d.status, 0, d.stderr)
  assert.equal(d.json.ok, true, 'обещание конфига — не дыра в журнале, движок не вправе валить сборку из-за него')
  assert.equal(d.json.vcs.length, 1)
  assert.match(d.json.vcs[0], /удалённого репозитория нет вовсе/)
})

test('doctor: секции vcs нет — поле vcs присутствует и пусто, ok не задет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const d = p.evJson('doctor')
  assert.equal(d.status, 0, d.stderr)
  assert.deepEqual(d.json.vcs, [])
  assert.equal(d.json.ok, true)
})

test('phase: то же поле vcs, той же формы, что у doctor', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'vcs:\n  host: github\n  remote: upstream\n' })
  const r = p.cli('firm-state.mjs', ['phase', '--root', p.root, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.vcs.length, 1)
  assert.match(j.vcs[0], /git remote add upstream <url>/)
})
