// Макет поставки: показан ли человеку экран, который он утверждает.
//
// Разбор стадии Дизайнера 22.10.2026. «Прототип нужен человеку НА ВОРОТАХ» стояло в трёх
// текстах и не проверялось ни одним механизмом. Здесь — машинная половина починки, и
// главная её граница та же, что у всех замеров движка: **молчать, когда надо**. Поставка
// без экранов, поставка с нарисованным макетом и локальная картинка внутри файла не имеют
// права давать находку — иначе шаг станет шумом, а шум убивает сигнал надёжнее молчания.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { designFindings, designFile } from '../scripts/lib/firm.mjs'
import { makeProject } from './helpers.mjs'

function task(p, id, { ui = false } = {}) {
  writeFileSync(
    join(p.tasksPath, `${id}.md`),
    `---\nid: ${id}\ntitle: ${id}\nstatus: todo\nparallel_safe: true\nui: ${ui}\nlabels: []\n---\n\n## Что сделать\n\nэкран\n`,
  )
}

function mock(p, html) {
  const abs = join(p.root, designFile(p.change))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, html)
  return abs
}

const find = (p) => designFindings(p.root, p.change)

test('есть задачи с экраном, а макета нет — находка, и она называет путь', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { ui: true })
  task(p, 'T-002', { ui: true })
  task(p, 'T-003')
  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /T-001, T-002/, 'находка обязана перечислить именно экранные задачи')
  assert.doesNotMatch(f[0], /T-003/)
  assert.match(f[0], new RegExp(designFile(p.change).replace(/\//g, '\\/')))
  // Цена молчания названа в самой находке: без макета отменяется ещё и ось стиля.
  assert.match(f[0], /ui\.md/)
})

test('поставка без экранов находки не даёт: макет ей не нужен', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001')
  assert.deepEqual(find(p), [])
})

test('макет на месте и все секции в нём — молчание', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { ui: true })
  task(p, 'T-002', { ui: true })
  mock(p, '<h2>T-001 · список</h2><h2>T-002 · карточка</h2>')
  assert.deepEqual(find(p), [])
})

test('макет есть, а секции задачи в нём нет — находка на этой задаче', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { ui: true })
  task(p, 'T-007', { ui: true })
  mock(p, '<h2>T-001 · список</h2>')
  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /T-007/)
  assert.doesNotMatch(f[0], /T-001/, 'нарисованная задача в находке не участвует')
})

test('ресурс из сети — находка: без интернета ворота покажут не то, что утверждают', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { ui: true })
  mock(p, '<h2>T-001</h2><script src="https://cdn.example.com/x.js"></script>')
  const f = find(p)
  assert.equal(f.length, 1, JSON.stringify(f))
  assert.match(f[0], /cdn\.example\.com/, 'находка предъявляет саму ссылку, а не факт')
})

test('шрифт из сети в CSS ловится тоже — @import мимо src и href', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { ui: true })
  mock(p, "<h2>T-001</h2><style>@import url('https://fonts.example.com/i.css');</style>")
  assert.match(find(p)[0], /fonts\.example\.com/)
})

test('локальная картинка и якорь внутри файла находкой НЕ являются', (t) => {
  const p = makeProject(t, { tasks: [] })
  task(p, 'T-001', { ui: true })
  // Самодостаточный файл — это запрет на СЕТЬ, а не на разметку. Проверка, срабатывающая
  // на `href="#T-001"`, сделала бы находкой каждый макет с навигацией, то есть все.
  mock(p, '<a href="#T-001">T-001</a><img src="data:image/png;base64,AAA"><img src="./local.png">')
  assert.deepEqual(find(p), [])
})
