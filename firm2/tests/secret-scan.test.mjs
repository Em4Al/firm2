// Секрет не уезжает в коммит (пункт 5 разбора ECC, `docs/ecc-ingest.md`).
//
// Проверка стоит на PreToolUse(Bash), а не git-хуком: `pre-commit` снимается флагом
// `--no-verify`, и снимает его та же роль, которой он мешает.
//
// Тесты держат две стороны, и вторая важнее первой. Первая — что настоящий ключ не
// проходит. Вторая — что проверка НЕ срабатывает на штатной работе: образец, красящий
// коммиты на ровном месте, обходится не разбором, а привычкой, и защиты от него не
// остаётся вовсе. Поэтому ложных поводов здесь столько же, сколько настоящих.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { findSecretsInDiff, redact, targetDir } from '../scripts/lib/secrets.mjs'
import { listEvents } from '../scripts/lib/firm.mjs'
import { makeProject, ENGINE } from './helpers.mjs'

// Собранные здесь «ключи» — синтетические: форма настоящая, содержимое случайное.
const KEYS = {
  aws: `AKIA${'Q7ZT4NXB2VLMD9KE'}`,
  github: `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`,
  anthropic: `sk-ant-${'api03-7mKq2LpZ8vRt4Nw1Xy6Hb3Gd9Fs0Jc5'}`,
  stripe: `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`,
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
}

const diff = (file, ...added) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n` +
  `${added.map((l) => `+${l}`).join('\n')}\n`

// ── Образцы: что считается секретом ──────────────────────────────────────────

test('ключ, узнаваемый по форме, — находка (AWS, GitHub, Anthropic, Stripe, JWT)', () => {
  for (const [who, key] of Object.entries(KEYS)) {
    const f = findSecretsInDiff(diff('app/settings.py', `KEY = "${key}"`))
    assert.equal(f.length >= 1, true, `не узнан ключ ${who}`)
    assert.equal(f[0].file, 'app/settings.py')
  }
})

test('закрытый ключ и пароль в строке подключения', () => {
  assert.equal(findSecretsInDiff(diff('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----')).length, 1)
  const url = findSecretsInDiff(diff('app/db.py', 'DSN = "postgresql://app:hT7xQ2vw@db.example:5432/app"'))
  assert.equal(url.length >= 1, true)
})

test('присваивание ключу с говорящим именем — находка, если значение похоже на ключ', () => {
  assert.equal(findSecretsInDiff(diff('a.py', 'api_key = "9fK2mQ7xZ1tB4nV8"')).length, 1)
  assert.equal(findSecretsInDiff(diff('a.ts', 'const clientSecret: string = "s3cr3t-value-0192"')).length, 1)
})

test('только ДОБАВЛЕННЫЕ строки: тот же ключ в удаляемой строке находкой не является', () => {
  const removal =
    `diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1 @@\n-api_key = "${KEYS.github}"\n+api_key = os.environ["API_KEY"]\n`
  assert.deepEqual(findSecretsInDiff(removal), [])
})

// ── Границы: на чём проверка молчать ОБЯЗАНА ─────────────────────────────────

test('чтение из окружения — не находка (это и есть правильный код)', () => {
  const ok = [
    'api_key = os.environ["API_KEY"]',
    'password = os.getenv("DB_PASSWORD")',
    'const token = process.env.TOKEN',
    'secret = settings.SECRET_KEY',
  ]
  for (const line of ok) assert.deepEqual(findSecretsInDiff(diff('a.py', line)), [], line)
})

test('заглушки, подстановки и замазка — не находка', () => {
  const ok = [
    'password = "changeme"',
    'api_key = "your-api-key-here"',
    'token: "{{ vault_token }}"',
    'secret = "${SECRET}"',
    'password = "********"',
    'api_key = "<replace-me>"',
    'password = "example-password"',
  ]
  for (const line of ok) assert.deepEqual(findSecretsInDiff(diff('a.yml', line)), [], line)
})

test('слово «пароль» в прозе и в комментарии — не находка', () => {
  const ok = [
    '# пароль читается из окружения, в репозиторий не попадает',
    'if not password:',
    'raise ValueError("нужен token")',
    '- [ ] форма логина принимает пароль и показывает ошибку',
  ]
  for (const line of ok) assert.deepEqual(findSecretsInDiff(diff('docs/a.md', line)), [], line)
})

test('находка срезается при печати: сам ключ в stderr целиком не уезжает', () => {
  const f = findSecretsInDiff(diff('a.py', `token = "${KEYS.github}"`))
  assert.equal(f[0].excerpt.includes(KEYS.github), false)
  assert.match(f[0].excerpt, /\[срезано\]/)
  assert.equal(redact(`x = ${KEYS.aws}`).includes(KEYS.aws), false)
})

// ── Хук целиком: отказ, оговорка, режим warn ─────────────────────────────────

function stage(p, file, text) {
  mkdirSync(dirname(join(p.root, file)), { recursive: true })
  writeFileSync(join(p.root, file), text)
  p.git('add', '--', file)
}

const scan = (p, command) => p.cli('secret-scan.mjs', [], { input: JSON.stringify({ cwd: p.root, tool_input: { command } }) })

test('секрет в staged-диффе — exit 2, коммита не будет, событие guard/secret записано', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  const r = scan(p, 'git commit -m "настройки"')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /похоже на СЕКРЕТ/)
  assert.equal(r.stderr.includes(KEYS.anthropic), false)
  const ev = listEvents(p.root).filter((e) => e.stage === 'guard' && e.event === 'secret')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].actor, 'secret-scan')
  assert.match(ev[0].notes, /ОТМЕНЁН/)
})

test('чистый дифф — exit 0 и молча', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', 'API_KEY = os.environ["API_KEY"]\n')
  const r = scan(p, 'git commit -m "настройки"')
  assert.equal(r.status, 0)
  assert.equal(r.stderr.trim(), '')
  assert.equal(listEvents(p.root).filter((e) => e.event === 'secret').length, 0)
})

test('команда — не коммит: хук не смотрит ни на что вовсе', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  for (const cmd of ['git status', 'npm test', 'git log --oneline']) {
    assert.equal(scan(p, cmd).status, 0, cmd)
  }
})

test('оговорка с причиной пропускает коммит, но пишется событием', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'tests/vectors.py', `TOKEN = "${KEYS.jwt}"  # firm2: не секрет — вектор из RFC 7515\n`)
  const r = scan(p, 'git commit -m "вектор"')
  assert.equal(r.status, 0)
  assert.match(r.stderr, /оговорк/)
  const ev = listEvents(p.root).filter((e) => e.event === 'secret')
  assert.equal(ev.length, 1)
  assert.match(ev[0].notes, /оговоркой/)
})

test('оговорка БЕЗ причины не считается — отказ остаётся', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'tests/vectors.py', `TOKEN = "${KEYS.jwt}"  # firm2: не секрет\n`)
  assert.equal(scan(p, 'git commit -m "вектор"').status, 2)
})

test('guard.secret_scan: warn — коммит проходит, но событие есть', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'guard:\n  secret_scan: warn\n' })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.aws}"\n`)
  const r = scan(p, 'git commit -m "настройки"')
  assert.equal(r.status, 0)
  assert.match(r.stderr, /warn/)
  assert.match(listEvents(p.root).filter((e) => e.event === 'secret')[0].notes, /warn/)
})

test('мусор в ключе читается как block: опечатка не снимает защиту (И-12)', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'guard:\n  secret_scan: ДА\n' })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.aws}"\n`)
  assert.equal(scan(p, 'git commit -m "настройки"').status, 2)
})

test('`git commit -am` смотрит и на незастейдженное: иначе проверка обходится одним флагом', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', 'API_KEY = os.environ["API_KEY"]\n')
  p.git('commit', '-qm', 'база настроек')
  // Правка есть в рабочем дереве, но НЕ в индексе — `--cached` её не видит.
  writeFileSync(join(p.root, 'app/settings.py'), `API_KEY = "${KEYS.stripe}"\n`)
  assert.equal(scan(p, 'git commit -am "правка"').status, 2)
  assert.equal(scan(p, 'git commit -m "правка"').status, 0)
})

test('чужой проект (нет engine: firm2) — хук молчит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  writeFileSync(join(p.root, '.firm', 'config'), 'engine: другой\n')
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  assert.equal(scan(p, 'git commit -m "x"').status, 0)
})

// ── Дерево, в которое коммитят, а не то, откуда позвали (дефект O, 23.10.2026) ─
//
// Стадия обычно остаётся в каталоге сессии и коммитит через `git -C <дерево задачи>`.
// Хук, спрашивающий индекс у `h.cwd`, смотрел в ГЛАВНОЕ дерево — и на проект-В трижды
// отменил коммит T-118 на находке из файлов T-130, лежавших в индексе главного дерева от
// незакрытого мержа. Эти тесты держат обе стороны: чужой индекс коммит не отменяет, а
// защита через `-C` не ослабевает.

test('targetDir: каталог берётся из команды — -C, cd, кавычки, накопление', () => {
  assert.equal(targetDir('git commit -m x', '/repo'), '/repo')
  assert.equal(targetDir('git -C /wt/T-118 commit -m x', '/repo'), '/wt/T-118')
  assert.equal(targetDir('git -C ../wt/T-118 commit -m x', '/repo/app'), '/repo/wt/T-118')
  assert.equal(targetDir('git -C "/wt/T 118" commit -m x', '/repo'), '/wt/T 118')
  assert.equal(targetDir('cd /wt/T-118 && git commit -m x', '/repo'), '/wt/T-118')
  assert.equal(targetDir('cd wt/T-118 && git add -A && git commit -m x', '/repo'), '/repo/wt/T-118')
  // Несколько флагов внутри ОДНОГО вызова — поведение самого git: по порядку.
  assert.equal(targetDir('git -C /a -C b commit -m x', '/repo'), '/a/b')
  // А два вызова с одним и тем же -C не складываются: иначе каталог получился бы /wt/wt,
  // то есть несуществующий, и проверка ушла бы смотреть пустой дифф.
  assert.equal(targetDir('git -C /wt add -A && git -C /wt commit -m x', '/repo'), '/wt')
  // Берётся вызов, который КОММИТИТ, а не последний вызов git в строке: стадии пишут
  // `… commit … && git -C <главное дерево> log`, и каталог лога тут ни при чём.
  assert.equal(targetDir('git -C /wt commit -m x && git -C /repo log --oneline -1', '/repo'), '/wt')
  // Конфигурационные флаги между `git` и `-C` не сбивают разбор.
  assert.equal(targetDir('git -c core.hooksPath=/dev/null -C /wt/T-118 commit -m x', '/repo'), '/wt/T-118')
})

function worktree(p, ticket) {
  const wt = p.sibling(ticket)
  p.git('worktree', 'add', '-q', '-b', `task/${ticket}`, wt, 'HEAD')
  return wt
}

const scanFrom = (p, command) =>
  p.cli('secret-scan.mjs', [], { input: JSON.stringify({ cwd: p.root, tool_input: { command } }) })

test('секрет в индексе ГЛАВНОГО дерева не отменяет коммит в дереве задачи', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = worktree(p, 'T-001')
  // Чужая работа ждёт в индексе главного дерева — ровно случай незакрытого мержа.
  stage(p, 'tests/test_other.py', `ADMIN_SECRET = "${KEYS.stripe}"\n`)
  // А стадия коммитит своё, чистое, в своём дереве.
  mkdirSync(join(wt, 'app'), { recursive: true })
  writeFileSync(join(wt, 'app', 'mine.py'), 'KEY = os.environ["KEY"]\n')
  execFileSync('git', ['-C', wt, 'add', '-A'], { encoding: 'utf8' })
  const r = scanFrom(p, `git -C ${wt} commit -m "своя работа"`)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(listEvents(p.root).filter((e) => e.event === 'secret').length, 0)
})

test('секрет в дереве задачи отменяет коммит и через -C: защита не ослабла', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = worktree(p, 'T-001')
  mkdirSync(join(wt, 'app'), { recursive: true })
  writeFileSync(join(wt, 'app', 'settings.py'), `API_KEY = "${KEYS.anthropic}"\n`)
  execFileSync('git', ['-C', wt, 'add', '-A'], { encoding: 'utf8' })
  const r = scanFrom(p, `git -C ${wt} commit -m "настройки"`)
  assert.equal(r.status, 2, r.stdout + r.stderr)
  const ev = listEvents(p.root).filter((e) => e.event === 'secret')
  assert.equal(ev.length, 1)
  // И привязка теперь правильная: ветку хук читает в том же дереве, что и дифф.
  assert.equal(ev[0].ticket, 'T-001')
})

test('секрет в дереве задачи отменяет коммит и через cd … &&', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const wt = worktree(p, 'T-001')
  writeFileSync(join(wt, 'db.py'), 'DSN = "postgresql://app:hT7xQ2vw@db.example:5432/app"\n')
  execFileSync('git', ['-C', wt, 'add', '-A'], { encoding: 'utf8' })
  const r = scanFrom(p, `cd ${wt} && git commit -m "подключение"`)
  assert.equal(r.status, 2, r.stdout + r.stderr)
})

// ── Д-48 (проект-В, 04.11.2026): три дефекта одного замера ─────────────────────
//
// Коммит `1e0285c9` увёз три находки, имея ДВА события «коммит ОТМЕНЁН». Разбор дал три
// независимых дефекта, и каждый закреплён отдельно: форма команды, предмет сверки и
// самораскрутка журнала.

test('`merge --continue` создаёт коммит — и признак это знает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  // Ровно форма, которой коммит ушёл на проект-В: конфликт слияния закрывается не словом
  // `commit`. До 0.4.126 признак искал подстроку «commit» и на этих формах молчал.
  for (const cmd of [
    'git merge --continue',
    'git rebase --continue',
    'git cherry-pick --continue',
    'git -C . revert --continue',
    'git am --continue',
  ]) {
    assert.equal(scan(p, cmd).status, 2, cmd)
  }
})

test('`--continue` без продолжаемой команды коммита не создаёт — и сверки не вызывает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  // Иначе признак красил бы любую строку со словом `--continue` и обходился привычкой.
  for (const cmd of ['git merge --abort', 'git status --porcelain', 'npm test -- --continue']) {
    assert.equal(scan(p, cmd).status, 0, cmd)
  }
})

test('журнал движка под сверку не попадает: иначе задача про секреты блокирует себя', (t) => {
  // Замер: все три находки коммита лежали в `.firm/events/`, причём две — внутри событий
  // ОТМЕНЫ, цитировавших первую находку. Сверка кормила себя своим протоколом, и
  // поверхность росла на файл за попытку.
  const ev = diff('.firm/events/2026-11-04T10-00-00-000Z-guard-secret.json',
    `  "notes": "app/x.py: ключ ${KEYS.github} похож на СЕКРЕТ"`)
  assert.deepEqual(findSecretsInDiff(ev), [])
  // И это исключение только для журнала, а не для всего, что начинается на `.firm`.
  assert.equal(findSecretsInDiff(diff('.firm/config', `token = "${KEYS.github}"`)).length >= 1, true)
})

test('событие называет файл и СТРОКУ, а не цитирует находку', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `# первая строка\nAPI_KEY = "${KEYS.anthropic}"\n`)
  assert.equal(scan(p, 'git commit -m "настройки"').status, 2)
  const e = listEvents(p.root).filter((x) => x.event === 'secret')[0]
  assert.match(e.notes, /app\/settings\.py:2 /)
  // Цитата в журнале размножает ключ по файлам, которые потом сами идут в коммит.
  assert.equal(/\[срезано\]/.test(e.notes), false, 'в событии не должно быть и срезанного фрагмента')
})

test('фраза с пробелом ключом не считается: ложная отмена проект-В', () => {
  // Заметка Ревьюера: «`?token=` в WebSocket-пути `...`». Markdown-кавычки прочлись как
  // границы литерала, и «секретом» объявилась русская фраза. Присваивания там не было
  // вовсе — `?token=` это имя параметра без значения.
  const note = '- остаточное: `?token=` в WebSocket-пути `wss://host/ws` не удостоверяется'
  assert.deepEqual(findSecretsInDiff(diff('.firm/review/T-1.md', note)), [])
  // Настоящий литерал в обратных кавычках защиты не теряет.
  assert.equal(findSecretsInDiff(diff('a.ts', `const token = \`${KEYS.github}\``)).length >= 1, true)
})

// ── Второй слой: git-хук pre-commit ──────────────────────────────────────────

function installHooks(p) {
  const r = p.cli('firm-state.mjs', ['adopt', '--json', '--root', p.root])
  const j = JSON.parse(r.stdout || '{}')
  return j.git_hook || {}
}

test('/firm-adopt ставит ВСЕ хуки из шаблонов, а не только post-merge', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  const h = installHooks(p)
  const names = (h.hooks || []).map((x) => x.name).sort()
  assert.deepEqual(names, ['post-merge', 'pre-commit'],
    'список хуков не перечисляется поимённо намеренно: второй отстал бы так же, как отставала копия первого')
  for (const name of names) {
    const f = join(p.root, '.git', 'hooks', name)
    assert.equal(readFileSync(f, 'utf8'), readFileSync(join(ENGINE, 'templates', 'git-hooks', name), 'utf8'))
  }
})

test('git-хук отменяет коммит любой формы — даже той, которой первый слой не знает', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  installHooks(p)
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  const r = spawnSync('git', ['commit', '-m', 'настройки'], {
    cwd: p.root, encoding: 'utf8', timeout: 30000, env: p.env,
  })
  assert.notEqual(r.status, 0, 'коммит должен быть остановлен хуком')
  assert.match(r.stdout + r.stderr, /похоже на СЕКРЕТ/)
  assert.equal(listEvents(p.root).filter((e) => e.event === 'secret').length, 1)
  // И коммита действительно нет: это главное, чего не умеет первый слой.
  const log = execFileSync('git', ['-C', p.root, 'log', '--oneline'], { encoding: 'utf8' })
  assert.equal(/настройки/.test(log), false)
})

test('git-хук пропускает чистый коммит молча', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  installHooks(p)
  stage(p, 'app/settings.py', 'API_KEY = os.environ["API_KEY"]\n')
  const r = spawnSync('git', ['commit', '-m', 'настройки'], {
    cwd: p.root, encoding: 'utf8', timeout: 30000, env: p.env,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(listEvents(p.root).filter((e) => e.event === 'secret').length, 0)
})

// ── Д-49 (проект-В, 04.11.2026): у мержа родителей два ─────────────────────────
//
// Замер на живом мерже `main` → `3d`: 21 блокирующая находка, и ни одной строки мерж не
// писал — все годами лежали в сливаемой ветке. Правок разрешения, узнаваемых как секрет,
// ноль при 89 конфликтных файлах. Проект заплатил 21 оговоркой в 19 файлах, причём на
// КАЖДУЮ линию: в сливаемой ветке те же строки придут добавленными и в следующий мерж.
//
// Это третий случай одного рода («предмет сверки взят не тот»): не то дерево (0.4.98),
// не тот коммит (0.4.126, `merge --continue`), не тот родитель (здесь).

function mergeInProgress(p, { fromSecond = null, resolved = null } = {}) {
  // Вторая линия живёт своей жизнью: строка-заглушка написана ЕЙ, своим коммитом.
  p.git('checkout', '-q', '-b', 'other', 'main')
  if (fromSecond) {
    stage(p, 'tests/stub.py', fromSecond)
    p.git('commit', '-qm', 'заглушка второй линии')
  }
  p.git('checkout', '-q', `feature/${p.change}`)
  spawnSync('git', ['merge', '--no-ff', '--no-commit', 'other'], {
    cwd: p.root, encoding: 'utf8', timeout: 30000, env: p.env,
  })
  if (resolved) stage(p, 'app/resolved.py', resolved)
  return readFileSync(join(p.root, '.git', 'MERGE_HEAD'), 'utf8').trim()
}

test('Д-49: секрет, пришедший СО ВТОРОЙ ветки, мерж не отменяет', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeInProgress(p, { fromSecond: `ADMIN_SECRET = "${KEYS.stripe}"\n` })
  const r = scan(p, 'git commit -m "merge: other → feature"')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /пришли СО ВТОРОЙ/, 'и молчать тут нельзя: «сторож промолчал» читается как «сторож не сработал»')
  // Событие не пишется: чистый мерж — не находка, а событие на каждый мерж это шум.
  assert.equal(listEvents(p.root).filter((e) => e.event === 'secret').length, 0)
})

test('Д-49: секрет, написанный РАЗРЕШЕНИЕМ конфликта, мерж отменяет — защита не ослабла', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeInProgress(p, {
    fromSecond: 'TOKEN = os.environ["TOKEN"]\n',
    resolved: `API_KEY = "${KEYS.anthropic}"\n`,
  })
  const r = scan(p, 'git commit -m "merge: other → feature"')
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /app\/resolved\.py/)
  // Единственное, что в мерже пишется руками, — за это он и отвечает.
  assert.equal(/tests\/stub\.py/.test(r.stderr), false)
})

test('Д-49: обе стороны сразу — чужое отброшено, своё названо', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  mergeInProgress(p, {
    fromSecond: `ADMIN_SECRET = "${KEYS.stripe}"\n`,
    resolved: `API_KEY = "${KEYS.anthropic}"\n`,
  })
  const r = scan(p, 'git commit -m "merge: other → feature"')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Это мерж, и находок со второй ветки отброшено [1-9]/)
  const ev = listEvents(p.root).filter((e) => e.event === 'secret')
  assert.equal(ev.length, 1)
  assert.match(ev[0].notes, /app\/resolved\.py/)
  assert.equal(/stub\.py/.test(ev[0].notes), false, 'в журнал чужая строка не уезжает и именем')
})

test('Д-49: вне мержа отбора по второму родителю нет — обычный коммит судится как прежде', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  const r = scan(p, 'git commit -m "настройки"')
  assert.equal(r.status, 2)
  assert.equal(/мерж/.test(r.stderr), false)
})

test('Д-49: отказ рантайма предупреждает, что отмена уносит компаунд целиком', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  stage(p, 'app/settings.py', `API_KEY = "${KEYS.anthropic}"\n`)
  // Стадия проект-В потеряла ход дважды: `git add -A && git commit` отменён целиком, значит
  // `git add` не выполнился, подготовленные оговорки остались вне индекса, и второй отказ
  // прочитался как «оговорки не помогли».
  assert.match(scan(p, 'git add -A && git commit -m "x"').stderr, /Индексируй ОТДЕЛЬНЫМ вызовом/)
  // Git-хуку эта оговорка не нужна: он работает с уже собранным индексом.
  const r = p.cli('secret-scan.mjs', ['--staged'], { env: { CLAUDE_PROJECT_DIR: p.root } })
  assert.equal(r.status, 1)
  assert.equal(/ОТДЕЛЬНЫМ вызовом/.test(r.stderr), false)
})
