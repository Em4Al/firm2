// Д-7, разбор проект-В 11.10.2026. Расхождение записанной версии движка с фактической
// (0.4.70 против 0.4.73) висело всю сборку, и узнать о нём можно было только спросив
// `phase` отдельной командой: ни `doctor`, ни `board`, ни `build-args` о нём не говорили.
//
// Почему это не украшение. Между теми версиями лежали исправления привязки событий, то
// есть расходилось ПОВЕДЕНИЕ. И главное: `/firm-adopt` ставит ещё и git-хуки движка в
// `.git/hooks`, которых не доставляет ни `/plugin update`, ни подъём версии, — значит при
// расхождении прогон может идти на новом движке со старыми хуками. С 0.4.126 хуков два, и
// второй (`pre-commit`) в проектах не лежит вовсе, пока adopt не позван: в проект-В он так и
// приехал 05.11.2026, а до того коммит из обычного терминала шёл без сверки секретов
// совсем. Поэтому находка обязана называть ОБА — назвав один, она молчит о том, которого
// в проекте нет.
//
// Отсюда две проверки: находка видна там, где её прочтут ДО прогона (`build-args`) и при
// разборе журнала (`doctor`), и она НЕ красит `ok` — расхождение само по себе не ошибка.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { engineVersionFindings, engineVersionState } from '../scripts/lib/firm.mjs'
import { ENGINE, makeProject } from './helpers.mjs'

const ACTUAL = JSON.parse(readFileSync(join(ENGINE, '.claude-plugin', 'plugin.json'), 'utf8')).version

test('расхождение названо и в doctor, и в build-args — но ok не красит', (t) => {
  const p = makeProject(t, { tasks: ['T-001'], extraConfig: 'engine_version: 0.0.1\n' })

  const v = engineVersionState(p.root)
  assert.equal(v.recorded, '0.0.1')
  assert.equal(v.actual, ACTUAL, 'фактическая версия берётся из манифеста плагина')
  assert.equal(v.drift, true)

  const f = engineVersionFindings(p.root)
  assert.equal(f.length, 1)
  assert.match(f[0], /0\.0\.1/)
  assert.match(f[0], /firm-adopt/, 'находка обязана говорить, чем снимается')
  assert.match(f[0], /post-merge/, 'и чем расхождение опасно — хуком, который больше ничем не доезжает')
  assert.match(f[0], /pre-commit/, 'хуков с 0.4.126 два, и второго в проекте до первого adopt нет вовсе')

  const d = p.evJson('doctor')
  assert.equal(d.json.engine_version.length, 1, `doctor молчит о расхождении: ${JSON.stringify(d.json.engine_version)}`)
  assert.equal(d.json.ok, true, 'расхождение версии — не дыра в журнале, останавливать им разбор нельзя')

  const b = JSON.parse(p.cli('firm-state.mjs', ['build-args', '--json', '--root', p.root]).stdout)
  assert.ok(
    b.warnings.some((w) => /0\.0\.1/.test(w)),
    `build-args читают ПЕРЕД прогоном — это единственный момент, когда расхождение ещё можно снять: ${JSON.stringify(b.warnings)}`,
  )
})

test('версии совпали или не записаны — находки нет', (t) => {
  const same = makeProject(t, { tasks: ['T-001'], extraConfig: `engine_version: ${ACTUAL}\n` })
  assert.deepEqual(engineVersionFindings(same.root), [])
  assert.equal(engineVersionState(same.root).drift, false)

  // Версия не записана вовсе — это не расхождение, а проект, заведённый до того, как
  // движок стал её писать. Жаловаться тут значило бы жаловаться на пустое место.
  const none = makeProject(t, { tasks: ['T-001'] })
  assert.deepEqual(engineVersionFindings(none.root), [])
  assert.equal(engineVersionState(none.root).recorded, null)
})
