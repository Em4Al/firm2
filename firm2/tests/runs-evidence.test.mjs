// Предъявимый прогон: Тестировщик отдаёт обе стороны дифференциальной проверки с `sha`,
// и они доезжают до промпта Ревьюера.
//
// Повод — замер первой волны проект-В 25.10.2026: 8,17 ч из 11,09 ч работы инструментов ушло
// в полный серверный набор, 79 полных прогонов за волну. Умножало их правило, стоявшее и у
// Тестировщика, и у КАЖДОГО из трёх Ревьюеров: «прогони обе стороны сам» — восемь полных
// прогонов на попытку при одной детерминированной команде и одном коммите.
//
// Решение: прогон — это факт о коммите, и удостоверяется он отпечатком, а не повтором
// (ADR-0013, И-13). Тесты держат ровно это и ничего больше:
//   1. предъявленные стороны доезжают до Ревьюера вместе с sha и командой;
//   2. сторона без sha предъявленной не считается — иначе «прогон был» без «на чём»
//      читалось бы как доказательство;
//   3. `runs` нет вовсе — Ревьюеру прямо сказано гнать обе стороны самому, как раньше.
//
// Прод-код исполняется настоящий: подменяется только то, что за agent() (см. panelloss).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBuildBody } from './helpers.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const BODY = loadBuildBody()
const TASK = { id: 'T-001', path: 't.md', labels: [], parallel_safe: true }

// `trunk` — что ответит зонд основания сверки: объект → снято, null → снять не удалось.
async function promptsWith(runs, { trunk = { state: 'ok', sha: 'ma1nsha00000', head: 'ma1nsha00000', cmd: 'suite -q', red: ['tests/test_old.py::t9'], failed: 1, total: 100 }, deliveryRed = null } = {}) {
  const calls = []
  const logs = []
  const stub = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label.startsWith('основание:')) return trunk || { state: 'unknown', output: 'дерево не завелось' }
    if (label === 'пауза?') return { state: 'running' }
    if (label === 'состояние поставки') return { state: 'ok', exists: [TASK.id], merged: [] }
    if (label.startsWith('worktree:')) return { status: 'ok', worktree: '', branch: '' }
    if (label.startsWith('dev:')) return { status: 'ok', escalate: false }
    if (label.startsWith('test:')) {
      const out = { status: 'ok', tests: ['t'], report: { total: 1, passed: 1, failed: 0 } }
      if (runs) out.runs = runs
      if (deliveryRed) out.delivery_red = deliveryRed
      return out
    }
    if (label.startsWith('qa-panel:') || label.startsWith('qa:')) return { verdict: 'принято', notes: 'ок' }
    if (label.startsWith('adjudicate:')) return { verdict: 'not_blocker' }
    if (label.startsWith('journal:')) return { status: 'ok' }
    if (label.startsWith('merge:')) return { status: 'ok' }
    if (label === 'leftovers') return { found: [] }
    throw new Error(`заглушка не знает вызова с label «${label}»`)
  }
  const parallel = async (thunks) =>
    Promise.all(thunks.map(async (f) => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'phase', 'args', BODY)
  await fn(stub, parallel, (m) => logs.push(String(m)), () => {}, JSON.stringify({
    change: 'demo', plugin_root: '/engine', feature_branch: 'feature/demo',
    worktrees_dir: '', tasks: [TASK],
  }))
  const qa = calls.find((c) => c.label.startsWith('qa-panel:') || c.label.startsWith('qa:'))
  const tst = calls.find((c) => c.label.startsWith('test:'))
  assert.ok(qa, 'ревьюера не позвали — проверять нечего')
  assert.ok(tst, 'тестировщика не позвали — проверять нечего')
  return { qa: qa.prompt, test: tst.prompt, log: logs.join('\n') }
}

const qaPromptWith = async (runs) => (await promptsWith(runs)).qa

const FULL = {
  base: { sha: 'abc1234567890def', cmd: 'uv run pytest -q', red: ['tests/test_a.py::t1'], failed: 1, total: 100 },
  head: { sha: 'fed0987654321cba', cmd: 'uv run pytest -q', red: ['tests/test_a.py::t1'], failed: 1, total: 103 },
}

test('предъявленный прогон доезжает до Ревьюера: оба sha, команда и красные', async () => {
  const p = await qaPromptWith(FULL)
  assert.match(p, /abc123456789/, 'sha точки ветвления')
  assert.match(p, /fed098765432/, 'sha HEAD')
  assert.match(p, /uv run pytest -q/, 'команда дословно — иначе сверять нечего')
  assert.match(p, /tests\/test_a\.py::t1/, 'красный на точке ветвления назван поимённо')
  assert.match(p, /merge-base/, 'сказано, с чем сверять sha')
  assert.match(p, /АДРЕСНО/, 'перепрогон адресный, а не всего набора')
})

test('сторона без sha предъявленной не считается', async () => {
  // «Прогон был» без «на чём» — это снова слова. Худший исход здесь не лишний прогон, а
  // принятый на веру список красных с неизвестного коммита.
  const p = await qaPromptWith({ base: { cmd: 'uv run pytest -q', red: [], failed: 0 }, head: FULL.head })
  assert.match(p, /точка ветвления: не предъявлен/)
  assert.match(p, /fed098765432/, 'вторая сторона при этом предъявлена и видна')
})

test('прогона нет вовсе — Ревьюер проверяет адресно, а холодную базу всё равно не гонит', async () => {
  // Запасной путь до 30.10.2026 звучал «гони обе стороны сам», и это была та же дыра, что
  // у Тестировщика: сторону точки ветвления движок снимает один раз на волну, а роль
  // заводила под неё холодное дерево и теряла в нём часы.
  const p = await qaPromptWith(null)
  assert.match(p, /Прогон Тестировщик НЕ предъявил/)
  assert.match(p, /само по себе замечание/, 'молчание Тестировщика не бесплатно')
  assert.match(p, /ТОЧКИ ВЕТВЛЕНИЯ движок снял сам/, 'вторая половина — работа движка, а не Ревьюера')
  assert.match(p, /АДРЕСНО/, 'сказано, чем проверять вместо полного прогона')
  assert.doesNotMatch(p, /прогон на merge-base дерева задачи и на HEAD/,
    'старое «гони обе стороны сам» — источник двухчасовых стадий, его в промпте быть не должно')
  assert.doesNotMatch(p, /Предъявленный прогон/, 'пустой блок не выдаётся за предъявленный')
})

// ── Основание сверки: БАЗА утверждения «новых красных нет» ───────────────────────────
//
// Дифференциальная проверка от точки ветвления отвечает на вопрос «моё ли это красное» и
// отвечает верно. На вопрос «надо ли его чинить» она не отвечает никак: красное,
// внесённое поставкой РАНЬШЕ точки ветвления, стоит в обеих половинах сравнения и
// читается предсуществующим. Замер — MR-ревью поставки «сменные скины» проект-В 13.10.2026:
// 21 красный = 12 предсуществующих + 9 своих, и ТРИ независимые сверки (merge-base внутри
// ветки, точка ветвления задачи, вершина ветки поставки) все три сказали «новых нет».
// Все три были верны по букве: их базы лежали внутри поставки. Правило проекта — BR-165.

test('основание снимает движок, один раз на прогон, и выдаёт его стадии как данность', async () => {
  const r = await promptsWith(FULL)
  assert.match(r.test, /ОСНОВАНИЕ СВЕРКИ выдано движком/)
  assert.match(r.test, /перегонять его НЕ НАДО/i, 'сторона снята кодом — повторять её значит снова платить за эхо')
  assert.match(r.test, /ma1nsha00000/, 'sha ветки-цели предъявлен стадии')
  assert.match(r.test, /tests\/test_old\.py::t9/, 'красные ветки-цели названы поимённо')
  assert.match(r.test, /ТРИ, а не на две группы/, 'три группы: предсуществующие, поставки, свои')
  assert.match(r.log, /Основание сверки: «main» на sha ma1nsha00000/, 'прогон назвал основание в логе')
})

test('Ревьюер знает, что сторону основания снял движок, а не Тестировщик', async () => {
  const r = await promptsWith(FULL)
  assert.match(r.qa, /Основание сверки снял ДВИЖОК \(не Тестировщик\)/)
  assert.match(r.qa, /ma1nsha00000/)
})

test('основание не снято — остаётся дешёвая половина правила, и об этом сказано обоим', async () => {
  // Направление отказа открытое: прогон не блокируется (красное чужое, ADR-0009), но и
  // молчать нельзя — иначе слепота возвращается незаметно под верной по букве фразой.
  const r = await promptsWith(FULL, { trunk: null })
  assert.match(r.test, /ОСНОВАНИЕ СВЕРКИ по ветке-цели движку снять не удалось/)
  assert.match(r.test, /git cat-file -e main:/, 'машинный якорь назван командой, а не намёком')
  assert.match(r.qa, /не удалось/)
  assert.match(r.qa, /НЕ доказывает/, 'Ревьюеру сказано, чего в этом случае не доказывает сверка с точкой ветвления')
  assert.match(r.log, /Основание сверки снять НЕ удалось/)
})

test('красные поставки названы поимённо, но задачу не отклоняют', async () => {
  const own = ['tests/test_t093_qa_snapshot_skin_texts.py::test_a', 'tests/test_t093_qa_snapshot_skin_texts.py::test_b']
  const r = await promptsWith(FULL, { deliveryRed: own })
  assert.match(r.log, /названы внесёнными САМОЙ ПОСТАВКОЙ/)
  assert.match(r.log, /test_t093_qa_snapshot_skin_texts/, 'в логе прогона они поимённо')
  assert.match(r.log, /КРАСНЫЕ ПОСТАВКИ \(2\)/, 'и отдельной строкой в итоге прогона — один раз на поставку')
  // С 0.4.126 имя не остаётся словом: движок сверяет его с теми же двумя снимками сам.
  // Здесь снимка нет, и это сказано словами «проверить нечем», а не выдано за хозяина
  // (Д-43: на проект-В 04.11.2026 такое «красное» оказалось измерением, и четыре адресных
  // прогона дали зелёный — то есть поимённое называние без доказательства заводит работу
  // по несуществующему дефекту).
  assert.match(r.log, /ни одно из них не остаётся словом/)
  assert.match(r.log, /проверить нечем/)
  // ПОПРАВКА 09.11.2026 (Д-65). Прежде здесь ожидалось «НЕ ПОДТВЕРЖДЕНО» — и это была та же
  // ошибка, что `found: []` в уборке: несделанная проверка пересказывалась как сделанная.
  // «Не подтверждено» означает «смотрели на двух снимках и не нашли»; здесь снимка нет
  // вовсе. У проект-В так пришли восемь записей `unknown` подряд, и список читался
  // проверенным. Теперь это свой ответ, со своей причиной и рецептом.
  assert.match(r.log, /ОТНЕСЕНИЕ НЕ СНЯТО по 2 из 2/, 'итог делит «не проверено» и «не подтверждено»')
  assert.match(r.log, /НЕ «не подтверждено»/)
  assert.match(r.log, /merge-base/, 'рядом рецепт, которым это снимается руками')
  assert.match(r.qa, /внесла САМА ПОСТАВКА/)
  assert.match(r.qa, /не основание её отклонить/, 'чужая работа задачу не отклоняет')
})

test('своих красных поставки не названо — Ревьюеру дана дешёвая команда проверить это сам', async () => {
  const r = await promptsWith(FULL)
  assert.match(r.qa, /Своих красных поставки Тестировщик не назвал/)
  assert.match(r.qa, /git cat-file -e main:/)
})

// ── Ревизия основания ДОКАЗЫВАЕТСЯ, а не называется (разбор проект-В 02.11.2026) ─
//
// Стадиям выдавалось «точка ветвления ddc5fce5, красных 0», а три независимые стадии
// называли на ней пять красных поимённо. Сверка файлов по ревизиям объяснила расхождение без
// всякой нестабильности набора: одного из тех пяти файлов (`test_t187_tile_guard.py`) на
// ветке-цели НЕ СУЩЕСТВУЕТ, а на точке ветвления он есть — значит «0» снят с ветки-цели.
//
// Разрыв был внутри зонда: `sha` он берёт из `git merge-base`, а набор гонит в ТЁПЛОМ дереве
// `_base`, которое переиспользуется между волнами намеренно. Не прошёл `checkout --detach` —
// дерево осталось на прежней ревизии, и ответ сходится по форме: ревизия названа верно,
// числа чужие. Движок печатал это стадиям словами «снято движком, перегонять не надо».
test('зонд назвал одну ревизию, а гнал на другой — измерение не принимается', async () => {
  const r = await promptsWith(null, {
    trunk: { state: 'ok', sha: 'ddc5fce5aaaa', head: '3d00000bbbb', cmd: 'suite -q', red: [], failed: 0, total: 100 },
  })
  assert.match(r.log, /назвал ревизию ddc5fce5aaaa/, 'в логе названы ОБЕ ревизии — иначе разбор снова пойдёт в сторону привязки')
  assert.match(r.log, /гнал на 3d00000bbbb/)
  assert.match(r.log, /измерение не принято/)
  assert.doesNotMatch(r.test, /красных 0/,
    'число, за ревизию которого нельзя поручиться, стадии не выдаётся: его читают как факт')
  assert.match(r.test, /снять НЕ удалось|снять не удалось/,
    'направление отказа закрытое: стадии честно сказано, что основания нет (И-12)')
})

test('ревизия не доказана вовсе (head не пришёл) — тоже не принимается', async () => {
  const r = await promptsWith(null, {
    trunk: { state: 'ok', sha: 'ma1nsha00000', cmd: 'suite -q', red: ['tests/test_old.py::t9'], failed: 1, total: 100 },
  })
  assert.match(r.log, /не доказал ревизию/)
  assert.doesNotMatch(r.test, /tests\/test_old\.py::t9/, 'список красных без доказанной ревизии — не основание')
})

test('ревизия доказана короткой формой — измерение принимается', async () => {
  const r = await promptsWith(null, {
    trunk: { state: 'ok', sha: 'ma1nsha000001234', head: 'ma1nsha00000', cmd: 'suite -q', red: ['tests/test_old.py::t9'], failed: 1, total: 100 },
  })
  assert.doesNotMatch(r.log, /не принято/, 'сокращённый sha — та же ревизия, а не расхождение')
  assert.match(r.test, /tests\/test_old\.py::t9/)
})
