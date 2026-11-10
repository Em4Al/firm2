#!/usr/bin/env node
// Поднять версию плагина. Во время обкатки это не бухгалтерия, а доставка:
// `/plugin marketplace update` и `/plugin update` сверяют версию в манифесте и,
// увидев прежнюю, решают, что обновлять нечего — даже если содержимое источника
// изменилось. Проверено на пилоте: подхватило только uninstall + install.
//
// Касается это того, что копируется в кэш: commands/, agents/, hooks.json и workflows/.
// Сам читается из исходника по engine_root только scripts/ — он обновления не ждёт.
// workflows/ попал в этот список 01.10.2026: workflow плагина зовётся ПО ИМЕНИ
// (firm2:firm2-build), рантайм регистрирует его сам и берёт из кэша, а путь в
// Workflow({scriptPath}) инструмент отклоняет — обойти кэш нечем.
//
//   node scripts/bump-version.mjs            # patch: 0.2.0 → 0.2.1
//   node scripts/bump-version.mjs minor      # 0.2.0 → 0.3.0
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const kind = (process.argv.find((a) => !a.startsWith('--') && /^(patch|minor|major)$/i.test(a)) || 'patch').toLowerCase()
const manifest = join(here, '..', '.claude-plugin', 'plugin.json')
const example = join(here, '..', 'templates', 'firm-config.example')

// Рубеж перед подъёмом версии, а не после. Версия — это механизм доставки: подняли —
// правка уехала в проекты следующим `/plugin update`, и уехала целиком, вместе с
// недоделанным. Поэтому проверка стоит ЗДЕСЬ, в единственном месте, через которое доставка
// обязана пройти: не прошло — версия не меняется, и уехать физически нечему.
//
// Обойти можно (`--no-preflight`), и это не лазейка, а честный выход для случая «правка
// только в тексте команды»: запрет, который нельзя обойти, обходят копированием файла
// руками, и тогда не работает уже ничего.
if (!process.argv.includes('--no-preflight')) {
  const r = spawnSync('node', [join(here, 'preflight.mjs')], { encoding: 'utf8', stdio: 'inherit' })
  if (r.status !== 0) {
    process.stderr.write(
      '\n[firm2] версия НЕ поднята: рубеж не пройден. Либо исправить, либо, если правка\n' +
        '        заведомо безопасна, — node scripts/bump-version.mjs --no-preflight\n',
    )
    process.exit(1)
  }
}

const raw = readFileSync(manifest, 'utf8')
const was = JSON.parse(raw).version || '0.0.0'
const [maj, min, pat] = String(was).split('.').map((n) => parseInt(n, 10) || 0)
const next =
  kind === 'major' ? `${maj + 1}.0.0` : kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`

// Правим строку, а не гоняем JSON через разбор и сборку: round-trip переформатировал бы
// весь манифест и утопил бы единственное содержательное изменение в шуме диффа.
writeFileSync(manifest, raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${next}"`))

// Пин в шаблоне конфига держим тем же числом: по нему новые проекты записывают
// engine_version, и расхождение с фактической версией сразу увидит firm-state phase.
try {
  const s = readFileSync(example, 'utf8')
  writeFileSync(example, s.replace(/engine_version:\s*"[^"]*"/, `engine_version: "${next}"`))
} catch {}

process.stdout.write(
  `[firm2] версия ${was} → ${next}\n` +
    `        Правки в commands/ agents/ hooks.json workflows/ доедут до проектов только после\n` +
    `        /plugin marketplace update firm2 — и только если версия изменилась.\n`,
)
