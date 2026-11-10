#!/usr/bin/env node
// Печатает путь к КОДУ движка, который надо гонять. Одна строка на stdout.
//
// Зачем отдельный скрипт: плагин при установке копируется в ~/.claude/plugins/cache,
// и `${CLAUDE_PLUGIN_ROOT}` указывает именно туда. Кэш отстаёт от исходника — пока
// firm2 обкатывается, это означает отладку уже исправленных дефектов. Поэтому и хуки,
// и команды маршрута спрашивают путь здесь, а не берут переменную рантайма напрямую.
//
// Порядок поиска:
//   1. engine_root из .firm/config проекта — явная воля проекта, главнее всего;
//   2. каталог firm2 внутри маркетплейса firm2 (для directory-маркетплейса
//      installLocation и есть исходник);
//   3. CLAUDE_PLUGIN_ROOT — то, что дал рантайм;
//   4. каталог этого скрипта.
//
// Сам скрипт намеренно тривиален: даже устаревшая копия из кэша отработает верно.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const selfDir = dirname(fileURLToPath(import.meta.url))

function fromConfig() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const cfg = join(root, '.firm', 'config')
  if (!existsSync(cfg)) return null
  const m = readFileSync(cfg, 'utf8').match(/^engine_root:\s*"?([^"#\n]+?)"?\s*$/m)
  return m ? resolve(root, m[1]) : null
}

function fromMarketplace() {
  const p = join(homedir(), '.claude', 'plugins', 'known_marketplaces.json')
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    for (const entry of Object.values(data)) {
      const loc = entry && entry.installLocation
      if (loc && existsSync(join(loc, 'firm2', 'scripts', 'firm-event.mjs'))) {
        return join(loc, 'firm2')
      }
    }
  } catch {
    return null
  }
  return null
}

const candidates = [
  fromConfig(),
  fromMarketplace(),
  process.env.CLAUDE_PLUGIN_ROOT || null,
  resolve(selfDir, '..'),
]

const found = candidates.find((c) => c && existsSync(join(c, 'scripts', 'firm-event.mjs')))
process.stdout.write((found || resolve(selfDir, '..')) + '\n')
