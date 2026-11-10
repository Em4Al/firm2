// И-2 со стороны переименования каталога: журнал только дописывается, значит
// `firm-rename-dir.mjs` не вправе править текст уже записанных событий. Пути файлов в
// `notes` и `criteria` кладёт хук из structured output роли, поэтому совпадение с именем
// каталога — норма, а не редкость.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject } from './helpers.mjs'

// Каталог, который переименовываем, с двумя членами: из них скрипт выводит формы замены.
function withPackage(p) {
  mkdirSync(join(p.root, 'config'), { recursive: true })
  writeFileSync(join(p.root, 'config', 'settings.py'), 'ROOT_URLCONF = "config.urls"\n')
  writeFileSync(join(p.root, 'config', 'urls.py'), 'urlpatterns = []\n')
}

const NOTES = 'флаг cookie выставлен в config/settings.py, модуль config.urls не тронут'

function withEvent(p) {
  const file = join(p.eventsPath, '2026-09-30T12-00-00-000Z-T-001-review-accepted.json')
  writeFileSync(file, JSON.stringify({
    ts: '2026-09-30T12:00:00.000Z', change: p.change, ticket: 'T-001',
    stage: 'review', event: 'accepted', actor: 'test', notes: NOTES,
    criteria: [{ c: 'cookie-флаги выставлены в config/settings.py', s: 'выполнено' }],
  }, null, 1) + '\n')
  return file
}

const rename = (p, ...argv) =>
  p.cli('firm-rename-dir.mjs', ['--from', 'config', '--to', 'conf', ...argv])

test('И-2: переименование каталога не правит текст записанных событий', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withPackage(p)
  const eventFile = withEvent(p)
  const before = readFileSync(eventFile, 'utf8')
  // Дерево должно быть чистым: скрипт откатывается через reset --hard и на грязном
  // дереве снёс бы чужую работу.
  p.git('add', '-A')
  p.git('commit', '-qm', 'пакет и событие')

  const r = rename(p)
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.ok(existsSync(join(p.root, 'conf', 'settings.py')), 'каталог обязан переехать')
  assert.equal(readFileSync(eventFile, 'utf8'), before,
    'событие — запись о прошлом; переписать его значило бы переписать историю (ADR-0006)')
  assert.match(readFileSync(eventFile, 'utf8'), /config\/settings\.py/, 'цитата осталась цитатой')

  // Журнал не должен и МЕШАТЬ переименованию. Проверка остатка идёт по тем же исключениям,
  // что и замена; иначе упоминание каталога в `notes` читалось бы как недоделанная замена,
  // и переименование откатывалось бы целиком — проект с таким журналом стало бы невозможно
  // переименовать вовсе.
  assert.doesNotMatch(r.stdout, /ОСТАЛИСЬ ССЫЛКИ/, 'ложной тревоги из-за цитаты в журнале быть не должно')
  assert.doesNotMatch(r.stdout, /откатываю/, 'откат при чистой замене — ошибка')
  assert.match(r.stdout, /проверки зелёные/)
})

test('И-2: код при этом правится — иначе проверка ничего не значит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withPackage(p)
  withEvent(p)
  p.git('add', '-A')
  p.git('commit', '-qm', 'пакет и событие')

  const r = rename(p)
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(readFileSync(join(p.root, 'conf', 'settings.py'), 'utf8'), /"conf\.urls"/,
    'ссылка в коде обязана переехать вместе с каталогом')
})

test('И-2: --dry-run ничего не меняет и не числит журнал в плане замен', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withPackage(p)
  const eventFile = withEvent(p)
  const before = readFileSync(eventFile, 'utf8')
  p.git('add', '-A')
  p.git('commit', '-qm', 'пакет и событие')

  const r = rename(p, '--dry-run')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(p.root, 'config')), '--dry-run не двигает каталог')
  assert.equal(readFileSync(eventFile, 'utf8'), before)
  // План замен перечисляется файлами; журнала в нём быть не должно.
  const plan = r.stdout.slice(0, r.stdout.indexOf('ОСТАЁТСЯ ЧЕЛОВЕКУ') + 1 || undefined)
  assert.equal(/\.firm\/events/.test(plan), false, `журнал попал в план замен:\n${plan}`)
  assert.match(plan, /config\/settings\.py/, 'а код в плане быть обязан')
})

test('И-2: остаток ссылки доказуемой формы откатывает переименование и выходит не нулём', (t) => {
  const p = makeProject(t, { tasks: ['T-001'] })
  withPackage(p)
  withEvent(p)
  // Настоящий остаток: отслеживаемый файл, который скрипт поправить НЕ может и потому не
  // берёт в план, — двоичный (`isText` отсекает его по нулевому байту). Так выглядит
  // скомпилированный фикстур, каталог переводов или заготовка базы, в которой лежит путь
  // `config/urls.py`. Замена его не покрывает, а ссылка после переименования становится
  // битой — ровно случай, ради которого ниже стоит `reset --hard`.
  writeFileSync(join(p.root, 'fixture.bin'), Buffer.from('seed\u0000 путь config/urls.py далее\n', 'utf8'))
  p.git('add', '-A')
  p.git('commit', '-qm', 'пакет, событие и двоичный фикстур')
  const settingsBefore = readFileSync(join(p.root, 'config', 'settings.py'), 'utf8')
  const head = p.git('rev-parse', 'HEAD').trim()

  const r = rename(p)

  assert.match(r.stdout, /ОСТАЛИСЬ ССЫЛКИ ДОКАЗУЕМОЙ ФОРМЫ/,
    `до правки эта ветка не срабатывала никогда (\\b не работает в POSIX ERE):\n${r.stdout}`)
  assert.match(r.stdout, /fixture\.bin/, 'остаток обязан быть назван по файлу')
  assert.match(r.stdout, /ПРОВЕРКА КРАСНАЯ \(остаток ссылок\)/)
  assert.equal(r.status, 1, 'красная проверка — не нулевой код возврата')

  // Откат настоящий: каталог на месте, правки в коде сняты, HEAD тот же.
  assert.ok(existsSync(join(p.root, 'config', 'settings.py')), 'reset --hard вернул каталог')
  assert.equal(existsSync(join(p.root, 'conf')), false, 'нового каталога остаться не должно')
  assert.equal(readFileSync(join(p.root, 'config', 'settings.py'), 'utf8'), settingsBefore)
  assert.equal(p.git('rev-parse', 'HEAD').trim(), head)
  assert.equal(p.git('status', '--porcelain').trim(), '', 'дерево вернулось в исходное состояние')

  // И то, чего человек в плане не видел: файл, который скрипт не правит, в план не попадает.
  const plan = r.stdout.slice(0, r.stdout.indexOf('Перенесено'))
  assert.equal(/fixture\.bin/.test(plan), false, 'двоичный файл в план замен не идёт — отсюда и нужда в проверке')
})
