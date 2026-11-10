// Чистка кэша не трогает версию, на которой кто-то работает. Разбор 11.10.2026: пятая за
// день доставка оставила три последних версии и снесла 0.4.73 — ту, на которой в этот
// момент шла сборка в проект-В. Рантайм берёт workflow плагина из кэша, значит это было
// удаление сборщика на ходу; каталог пришлось восстанавливать из git.
//
// Признак — ВОЗРАСТ, а не запись в конфиге проекта: в конфиге проект-В стояла 0.4.75 (её
// поставил последний /firm-adopt), а прогон шёл на 0.4.73. На какой версии стартовала
// чужая сессия, движок знать не может; что версия поставлена недавно — может.
import test from 'node:test'
import assert from 'node:assert/strict'
import { heldCacheVersions, CACHE_HOLD_HOURS } from '../scripts/lib/firm.mjs'

const now = Date.UTC(2026, 9, 11, 22, 0, 0)
const hoursAgo = (h) => now - h * 3600000

test('версия, поставленная три часа назад, не удаляется — это случай 0.4.73', () => {
  const held = heldCacheVersions([
    { version: '0.4.76', installed: hoursAgo(0.1) },
    { version: '0.4.75', installed: hoursAgo(2) },
    { version: '0.4.74', installed: hoursAgo(2.5) },
    { version: '0.4.73', installed: hoursAgo(3) },
  ], now)
  assert.deepEqual(held.sort(), ['0.4.73', '0.4.74', '0.4.75', '0.4.76'])
})

test('остывшие версии чистке не мешают: иначе кэш копился бы вечно', () => {
  const held = heldCacheVersions([
    { version: '0.4.76', installed: hoursAgo(1) },
    { version: '0.4.70', installed: hoursAgo(26) },
    { version: '0.4.60', installed: hoursAgo(24 * 9) },
  ], now)
  assert.deepEqual(held, ['0.4.76'])
})

test('окно трёхкратно от самого долгого замеренного прогона (6 ч 33 м)', () => {
  assert.equal(CACHE_HOLD_HOURS, 24)
  assert.deepEqual(heldCacheVersions([{ version: '0.4.70', installed: hoursAgo(23.9) }], now), ['0.4.70'])
  assert.deepEqual(heldCacheVersions([{ version: '0.4.70', installed: hoursAgo(24.1) }], now), [])
})

test('возраст не прочитан — держим: «не знаю» это не «можно удалять» (И-12)', () => {
  assert.deepEqual(heldCacheVersions([{ version: '0.4.70', installed: null }], now), ['0.4.70'])
  assert.deepEqual(heldCacheVersions([{ version: '0.4.70', installed: NaN }], now), ['0.4.70'])
  assert.deepEqual(heldCacheVersions([{ version: '0.4.70' }], now), ['0.4.70'])
})

test('мусор в списке не ломает чистку и не превращается в задержку', () => {
  assert.deepEqual(heldCacheVersions([null, {}, { installed: hoursAgo(1) }], now), [])
  assert.deepEqual(heldCacheVersions(null, now), [])
})
