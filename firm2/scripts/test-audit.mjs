#!/usr/bin/env node
// Разбор набора тестов: что в нём не окупается.
//
// Движок умел спрашивать «закрыт ли каждый критерий тестом» (Ревьюер по именам) и «умеет
// ли тест падать» (мутационная проверка Тестировщика). Обратного вопроса — «этот тест
// вообще за что-то платит» — не задавал никто, и набор только рос.
//
// Печатает ТОЛЬКО доказуемое чтением файла. Суждение — дублирует ли тест соседний,
// контракт это или привычка — живёт в приёме `firm-test-audit`, который этот разбор
// запускает первым шагом и дальше судит сам, называя файл и строку.
//
//   node scripts/test-audit.mjs                       # человеку
//   node scripts/test-audit.mjs --json                # приёму и машине
//   node scripts/test-audit.mjs --removed --base <ref>  # что СНЯТО относительно основания
//
// Код возврата всегда 0: это разбор, а не рубеж. Снимать тесты движок не умеет и не будет
// сам — он предлагает кандидата и сверяет снятое (ADR-0009).
//
// Второй режим заведён 10.11.2026 вместе с правом ролей снимать тесты: до него права не
// имела ни одна роль, и Ревьюеру нечем было отличить законное снятие от молчаливой потери
// чьего-то решения о том, что важно. Теперь отличает: `--removed` называет каждый снятый
// тест и чем снятие обосновано.
import { repoRoot, readConfig, requireKnownFlags } from './lib/firm.mjs'
import { auditTests, reviewRemovals } from './lib/tests.mjs'

const argv = process.argv.slice(2)
// Сторож флагов и у замера: цена опечатки здесь не удаление, а НЕВЕРНЫЙ ОТВЕТ — `--remove`
// вместо `--removed` молча напечатал бы разбор набора, и роль прочла бы его как «снятого
// нет» (Д-61, тот же довод).
requireKnownFlags(argv, ['removed', 'base'], {
  cmd: 'test-audit.mjs',
  usage:
    'test-audit.mjs — разбор окупаемости тестов (замер, код возврата всегда 0)\n' +
    '  --json                    машинный вид\n' +
    '  --removed --base <ref>    что снято относительно основания и чем это обосновано\n' +
    '  --root <путь>             корень репозитория\n',
})
const json = argv.includes('--json')
const rootArg = argv.indexOf('--root')
const root = rootArg >= 0 ? argv[rootArg + 1] : repoRoot()

if (!root) {
  process.stderr.write('[test-audit] не найден корень репозитория (--root <путь>)\n')
  process.exit(0)
}

if (argv.includes('--removed')) {
  const bi = argv.indexOf('--base')
  const r = reviewRemovals(root, { base: bi >= 0 ? argv[bi + 1] : null, config: readConfig(root) })
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 1) + '\n')
    process.exit(0)
  }
  if (!r.checked) {
    // «Не проверено» — отдельный ответ от «ничего не снято». Пустой список при сорванной
    // сверке читается как порядок, и это ровно тот дефект, от которого стоит `checked` в
    // уборке (Д-57).
    process.stdout.write(`[firm2] СНЯТОЕ НЕ ПРОВЕРЕНО: ${r.why}\nПустой список здесь не значит «ничего не снято».\n`)
    process.exit(0)
  }
  if (!r.removed.length) {
    process.stdout.write(
      `[firm2] относительно ${r.base} не снято ни одного теста` +
        (r.added ? `, добавлено ${r.added}` : '') + '\n',
    )
    process.exit(0)
  }
  process.stdout.write(`[firm2] снято тестов: ${r.removed.length}, добавлено: ${r.added} (основание ${r.base})\n`)
  for (const x of r.removed) {
    process.stdout.write(`  [${x.verdict}] ${x.file}:${x.line} — ${x.test}\n      ${x.why}\n`)
  }
  const bad = r.removed.filter((x) => x.verdict === 'запрещено')
  const need = r.removed.filter((x) => x.verdict === 'требует карточки')
  process.stdout.write(
    '\nСудит роль, а не этот разбор: он сверяет и называет. ' +
      (bad.length ? `ЗАПРЕЩЕНО снято: ${bad.length} — это отклонение вердикта. ` : '') +
      (need.length ? `Карточка приёма firm-test-audit нужна на ${need.length}. ` : '') +
      'Одобрить снятие без карточки — значит отменить чужое решение молча.\n',
  )
  process.exit(0)
}

const res = auditTests(root, readConfig(root))

if (json) {
  process.stdout.write(JSON.stringify(res, null, 1) + '\n')
  process.exit(0)
}

process.stdout.write(
  `[firm2] тестов: ${res.tests} в ${res.parsed_files} файлах из ${res.files}` +
    (res.kept ? `, снято с разбора человеком: ${res.kept}` : '') +
    (res.unparsed_ext.length ? ` (не разбираю: ${res.unparsed_ext.join(', ')})` : '') + '\n',
)
if (!res.findings.length) {
  process.stdout.write('машинных находок нет. Остальное — суждение: приём firm-test-audit.\n')
  process.exit(0)
}
for (const f of res.findings) {
  process.stdout.write(`  ${f.file}:${f.line} [${f.rule}] ${f.test}\n      ${f.why}\n`)
}
process.stdout.write(
  `\nнаходок: ${res.findings.length}. Это КАНДИДАТЫ, а не приговор: каждый разбирается ` +
    'по приёму firm-test-audit. Снять его вправе Тестировщик по карточке шага 3, и снятое \n' +
    'сверяется отдельно: test-audit.mjs --removed --base <ref>.\n',
)
