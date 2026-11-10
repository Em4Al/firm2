// Браузерный критерий не закрывается пропуском. Разбор проект-В 11.10.2026, T-089: коммит
// стадии назывался «живой прогон не выполнен, браузер недоступен», и стадия закрылась
// ЗЕЛЁНОЙ — браузерная проверка делает `t.skip("окно не поднялось")`, набор выходит с
// кодом 0. Критерий, который по метке закрывается только живым прогоном, на стадии не
// проверил никто. (Гейт поставки в проект-В это ловит — `test_no_live_check_passed_without_running`
// требует «пропущено 0», — но после всех стадий; находка возвращает стадию в работу сразу.)
//
// Проверка про пропуски у движка была и раньше, но требовала лишь ОБЪЯСНЕНИЯ, а оно здесь
// было. Поэтому находка узкая: пересечение метки `требует-браузера` и пропуска именно по
// браузерной причине. Главное в этих тестах — не «находит», а «молчит на чужих пропусках»:
// на точке ветвления той же поставки их пять, и ни один не про браузер.
import test from 'node:test'
import assert from 'node:assert/strict'
import { browserSkipFinding, BROWSER_RECIPE } from '../scripts/lib/firm.mjs'

const browserTask = { id: 'T-089', labels: ['требует-браузера'] }
const plainTask = { id: 'T-088', labels: [] }
const skipped = (n, why) => ({ report: { total: 7, passed: 6, failed: 0, skipped: n }, skipped_why: why })

test('метка и браузерный пропуск — находка с рецептом', () => {
  const f = browserSkipFinding(browserTask, skipped(1, 'браузера на машине нет'))
  assert.ok(f, 'находка должна быть')
  assert.match(f, /требует-браузера/)
  assert.match(f, /chrome-headless-shell/, 'без рецепта запрет обходят, а не исполняют')
  assert.match(f, /single-process/)
})

test('тот же случай словами роли: окно не поднялось', () => {
  assert.ok(browserSkipFinding(browserTask, skipped(1, 'окно не поднялось: запустить браузер в этом окружении не удалось')))
})

test('молчит на чужом пропуске: причина не про браузер', () => {
  assert.equal(browserSkipFinding(browserTask, skipped(5, 'нет внешней службы оплаты, тест для другой платформы')), null)
})

test('молчит без метки: пропуск по браузеру законен, если прогон не про экран', () => {
  assert.equal(browserSkipFinding(plainTask, skipped(1, 'браузера на машине нет')), null)
})

test('молчит, когда пропусков нет', () => {
  assert.equal(browserSkipFinding(browserTask, skipped(0, '')), null)
  // Причина про браузер названа, а пропусков ноль — бывает, когда роль объясняет прошлый
  // прогон. Решает ЧИСЛО: ноль пропусков значит, что проверка прошла.
  assert.equal(browserSkipFinding(browserTask, skipped(0, 'браузера на машине нет')), null)
})

test('молчит без объяснения — это ловит прежняя проверка, и дважды держать не надо', () => {
  assert.equal(browserSkipFinding(browserTask, skipped(2, '')), null)
})

test('молчит без structured output: роль со старым промптом не должна ронять стадию', () => {
  assert.equal(browserSkipFinding(browserTask, null), null)
  assert.equal(browserSkipFinding(browserTask, { report: null }), null)
  assert.equal(browserSkipFinding(null, skipped(1, 'браузер')), null)
})

test('рецепт называет и то, что НЕ работает: иначе роль потратит вечер на системный Chrome', () => {
  assert.match(BROWSER_RECIPE, /Системный Chrome/)
  assert.match(BROWSER_RECIPE, /--no-sandbox не/)
  assert.match(BROWSER_RECIPE, /puppeteer\/browsers install/, 'без команды установки человека придётся спрашивать дважды')
})
