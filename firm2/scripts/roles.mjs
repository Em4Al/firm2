#!/usr/bin/env node
// Таблица ролей движка, снятая с исходника: кто зовёт роль, какую схему ей передают, что
// она объявила выходом, какие приёмы и шаблоны называет, какую стадию пишет в журнал.
//
//   node scripts/roles.mjs                  # человеку
//   node scripts/roles.mjs --json           # машине (рубеж, шаг 3у; пересборка схемы)
//   node scripts/roles.mjs --engine <путь>  # посмотреть другую копию движка
//
// Читается КОД ДВИЖКА, а не проект: по умолчанию берётся каталог самого скрипта. Проект
// тут ни при чём — таблица ролей одинакова во всех проектах, которые держат эту версию.
//
// Код возврата всегда 0. Это снимок структуры, и судит по нему рубеж (шаг 3у): скрипт,
// который падает, перестают звать руками, а звать его руками — ровно то, зачем он есть
// (из него собирается схема «вход-выход восьми ролей», `docs/how-it-works.md`).
//
// Зачем вообще — в заголовке `lib/roles.mjs`: восемь разборов стадий нашли один класс
// дефекта, «обе стороны провода написаны, а провода нет», и четыре его случая выводятся
// из исходника без суждения. Чего скрипт не выводит — там же, абзацем ниже.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolesTable, rolesLines } from './lib/roles.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const engArg = argv.indexOf('--engine')
const engine = engArg >= 0 ? resolve(argv[engArg + 1]) : join(dirname(fileURLToPath(import.meta.url)), '..')

const table = rolesTable(engine)

if (json) {
  process.stdout.write(JSON.stringify(table, null, 1) + '\n')
  process.exit(0)
}

process.stdout.write(`[firm2] роли движка: ${table.roles.length}\n\n`)
process.stdout.write(rolesLines(table).join('\n') + '\n')
