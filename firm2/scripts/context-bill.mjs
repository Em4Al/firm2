#!/usr/bin/env node
// Счёт контекста движка: сколько своих текстов firm2 кладёт в окно до начала работы.
//
// Движок умел мерить массу продукта и проверок проекта (`firm-state mass`) и окупаемость
// набора тестов (`test-audit`), а собственную массу — нет. При этом она тратится первой и
// каждый раз: описания команд, ролей и приёмов лежат в окне с начала сессии, тело команды
// дочитывается при вызове, тело роли — при запуске стадии.
//
//   node scripts/context-bill.mjs                 # человеку
//   node scripts/context-bill.mjs --json          # машине
//   node scripts/context-bill.mjs --engine <путь> # посчитать другую копию движка
//
// Считается КОД ДВИЖКА, а не проект: по умолчанию берётся каталог, в котором лежит сам
// скрипт, и это намеренно — счёт не должен зависеть от того, из какого проекта его
// позвали. Коэффициент пересчёта в токены и бюджеты находок проект может перекрыть через
// `context:` в `.firm/config` — тогда счёт идёт по ЕГО замеру.
//
// Код возврата всегда 0: это замер, а не рубеж. Бюджет здесь — выбор, названный выбором,
// и запрещать по нему доставку движок не будет (ADR-0009).
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoRoot, readConfig } from './lib/firm.mjs'
import { contextBill, contextBillLines } from './lib/context.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const engArg = argv.indexOf('--engine')
const engine = engArg >= 0 ? resolve(argv[engArg + 1]) : join(dirname(fileURLToPath(import.meta.url)), '..')

// Конфиг читается у проекта, из которого позвали: замер токенов и бюджеты — его решение,
// а тексты всё равно считаются по движку. Нет проекта — идут значения по умолчанию.
const root = repoRoot()
const bill = contextBill(engine, root ? readConfig(root) : null)

if (json) {
  process.stdout.write(JSON.stringify(bill, null, 1) + '\n')
  process.exit(0)
}

process.stdout.write('[firm2] счёт контекста движка\n\n')
process.stdout.write(contextBillLines(bill).join('\n') + '\n')
