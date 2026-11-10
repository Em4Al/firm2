// Общая оснастка тестов движка. Только стандартная библиотека Node (ADR-0010).
//
// Главное правило этого файла: НИ ОДИН тест не смотрит на настоящий проект. Каждый
// строит свой одноразовый git-репозиторий в os.tmpdir() и сносит его в конце. Приём взят
// из `scripts/preflight.mjs`, раздел 4, — там он уже обкатан на синтетической поставке с
// конфликтным слиянием.
//
// Две страховки от «теста, который испортил рабочий каталог»:
//   1. команды движка зовутся с явным `--root` И с `CLAUDE_PROJECT_DIR=<tmp>`;
//      `repoRoot()` читает именно эту переменную, и без подмены скрипт, запущенный из
//      marketplace, писал бы события в marketplace;
//   2. `CLAUDE_CONFIG_DIR` указывается в пустой временный каталог: привязка события по
//      транскрипту субагента (`markerFromAgent`) иначе читает настоящий ~/.claude.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SCRIPTS = join(ENGINE, 'scripts')

// Пустой каталог вместо настоящего ~/.claude — на весь процесс тестов.
const FAKE_CLAUDE = realpathSync(mkdtempSync(join(tmpdir(), 'firm2-test-claude-')))
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE
process.on('exit', () => rmSync(FAKE_CLAUDE, { recursive: true, force: true }))

// Фиксированное время коммитов: тесты И-5/И-6 проверяют, что движок берёт время
// мерж-коммита, а не текущее, и смещение `+03:00` здесь существенно — именно на нём
// жил дефект с `ts`, не кончающимся на `Z`.
export const COMMIT_DATE = '2026-09-30T15:04:05+03:00'

const gitEnv = {
  GIT_AUTHOR_NAME: 'firm2-test',
  GIT_AUTHOR_EMAIL: 'test@firm2',
  GIT_COMMITTER_NAME: 'firm2-test',
  GIT_COMMITTER_EMAIL: 'test@firm2',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/**
 * Одноразовый проект под firm2: git-репозиторий, `.firm/config`, поставка и задачи.
 * Возвращает объект с путями и готовыми вызовами движка.
 */
export function makeProject(t, {
  change = 'ch',
  tasks = ['T-001'],
  status = 'todo',
  parallelism = 3,
  parallelSafe = false,
  archived = false,
  extraConfig = '',
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'firm2-test-')))
  const extraDirs = []
  if (t && typeof t.after === 'function') {
    t.after(() => {
      rmSync(root, { recursive: true, force: true })
      for (const d of extraDirs) rmSync(d, { recursive: true, force: true })
    })
  }

  mkdirSync(join(root, '.firm', 'events'), { recursive: true })
  const tasksRel = archived
    ? join('openspec', 'changes', 'archive', `2026-09-30-${change}`, 'tasks')
    : join('openspec', 'changes', change, 'tasks')
  mkdirSync(join(root, tasksRel), { recursive: true })
  writeFileSync(
    join(root, '.firm', 'config'),
    // `active_change` здесь НЕ пишется намеренно, и это не экономия строки. Настоящие
    // конфиги его не имеют (проверено по четырём живым проектам), а с 0.4.72 ключ
    // читается и перекрывает расчёт — то есть, стоя в оснастке, он молча отключал бы
    // проверки того самого расчёта. Кому нужен закреплённый — пишет его через
    // `extraConfig`.
    `engine: firm2\nengine_root: "${ENGINE}"\nparallelism: ${parallelism}\n${extraConfig}`,
  )
  for (const id of tasks) {
    writeFileSync(
      join(root, tasksRel, `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\n` +
        `${parallelSafe ? 'parallel_safe: true\n' : ''}---\n\nПроверочная задача.\n\n- [ ] критерий один\n`,
    )
  }

  // Окружение одно на все вызовы, включая git: git-хук проекта зовёт `firm-event.mjs`,
  // а тот читает `CLAUDE_PROJECT_DIR`. Не подменив её, хук в тесте работал бы по тому
  // проекту, который назвал рантайм снаружи.
  const env = { ...process.env, ...gitEnv, CLAUDE_PROJECT_DIR: root, CLAUDE_CONFIG_DIR: FAKE_CLAUDE }

  // Как в настоящем проекте под firm2: дашборд перегенерируется на каждом событии и
  // потому не коммитится (ADR-0003), граф кода — тоже артефакт сборки. Без этого они
  // попадают в коммиты сцены и в диффы слияний, и тесты начинают зависеть от того, стоит
  // ли на машине `codegraph`.
  writeFileSync(join(root, '.gitignore'), '.codegraph/\n.firm/dashboard.html\n')

  const git = (...a) =>
    execFileSync('git', ['-C', root, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE },
    })

  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 'test@firm2')
  git('config', 'user.name', 'firm2-test')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-q', '-b', `feature/${change}`)

  const cli = (script, argv, opts = {}) =>
    spawnSync('node', [join(SCRIPTS, script), ...argv], {
      encoding: 'utf8', cwd: root, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input ?? '', env: { ...env, ...(opts.env || {}) },
    })

  const ev = (...argv) => cli('firm-event.mjs', [...argv, '--root', root])
  const evJson = (...argv) => {
    const r = ev(...argv, '--json')
    let out = null
    try {
      out = JSON.parse(r.stdout || '{}')
    } catch {
      out = null
    }
    return { ...r, json: out }
  }

  return {
    root,
    change,
    tasksDirRel: tasksRel,
    tasksPath: join(root, tasksRel),
    eventsPath: join(root, '.firm', 'events'),
    git,
    env,
    cli,
    ev,
    evJson,
    // Каталог-сосед (рабочее дерево задачи лежит ВНЕ репозитория, §9).
    sibling(name) {
      const d = realpathSync(mkdtempSync(join(tmpdir(), `firm2-test-wt-${name}-`)))
      extraDirs.push(d)
      return join(d, name)
    },
    eventFiles() {
      return readdirSync(join(root, '.firm', 'events')).filter((f) => f.endsWith('.json')).sort()
    },
    // Git-хук ставится так же, как у человека: копией в .git/hooks + chmod +x.
    installPostMerge() {
      const dst = join(root, '.git', 'hooks', 'post-merge')
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
      copyFileSync(join(ENGINE, 'templates', 'git-hooks', 'post-merge'), dst)
      chmodSync(dst, 0o755)
      return dst
    },
  }
}

// Коммит в текущей ветке с заданным содержимым файла.
export function commitFile(p, file, text, message, date = COMMIT_DATE) {
  writeFileSync(join(p.root, file), text)
  p.git('add', '-A')
  execFileSync('git', ['-C', p.root, 'commit', '-qm', message], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...p.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
}

// Каталог, который НЕ является git-репозиторием: нужен, чтобы проверить ответ движка
// на отказ git («не знаю», а не «никого нет»).
export function plainDir(t) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'firm2-test-plain-')))
  if (t && typeof t.after === 'function') t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}

// Каталог с подставным `git`, который всегда отказывает. Нужен тестам инварианта И-12:
// «git не ответил» — это состояние, которое надо воспроизводить, а не описывать.
//
// Прежде отказ имитировали переменной `GIT_DIR`, указанной в несуществующий каталог. С
// 03.11.2026 так нельзя: движок снимает `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` на входе
// (отчёт проект-В, находка 1 — унаследованное от git-хука окружение сильнее ключа `-C` и
// уводило запись события в индекс чужого дерева). То есть тест опирался ровно на то, что
// теперь чинится, и падал бы на верной правке. Подставной `git` от окружения не зависит.
export function brokenGitDir(t) {
  const d = plainDir(t)
  const bin = join(d, 'git')
  writeFileSync(bin, '#!/bin/sh\necho "fatal: git недоступен (подстава теста)" >&2\nexit 128\n')
  chmodSync(bin, 0o755)
  return d
}

export function isoAgo(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString()
}

// Тело workflow-сборщика как исполнимая функция. Приём: `export const meta = {...}` в теле
// функции недопустим, поэтому блок вырезается. Живёт в оснастке, а не в одном тесте:
// планировщик проверяют два файла — панель QA (panelloss) и сам планировщик (scheduler).
export function loadBuildBody() {
  const script = process.env.FIRM2_BUILD_SCRIPT || join(ENGINE, 'workflows', 'firm2-build.js')
  const src = readFileSync(script, 'utf8')
  const start = src.indexOf('export const meta')
  if (start < 0) throw new Error('в скрипте нет export const meta')
  const end = src.indexOf('\n}\n', start)
  if (end <= start) throw new Error('не нашёл конец meta')
  const body = src.slice(0, start) + src.slice(end + 3)
  if (/^export\s/m.test(body)) throw new Error('в теле остался export')
  return body
}
