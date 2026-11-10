---
name: firm-docs
description: Приём движка «SDD-документация: архив спеки фичи + живая дока». Адаптер поверх OpenSpec (@fission-ai/openspec). Использует Технический писатель на закрытии поставки.
---

# firm-docs (адаптер поверх OpenSpec)

Приём движка для **жизненного цикла документации** по модели SDD. Делегирует в **OpenSpec**.

## Зависимость (политика «пин + адаптер»)

- Пакет: **`@fission-ai/openspec`**, bin `openspec`, Node 20.19+.
- **Пин версии** — из `.firm/config` (`dependencies.openspec`). НЕ используй `@latest`.
- Инструмент молодой: **не хардкодь пути** — бери их из `--json`-вывода CLI.

## Модель OpenSpec

- `openspec/specs/` — **живая дока** (текущее состояние, source of truth).
- `openspec/changes/<name>/` — активное изменение: `proposal.md`, `specs/`-**дельты**, `design.md`, `tasks.md`.
- `openspec/changes/archive/YYYY-MM-DD-<name>/` — **иммутабельный снимок** после закрытия.

Маппинг на нашу поставку: `requirements.md`→`proposal.md`, `spec.md`→`design.md`, `tickets/`→`tasks.md`,
изменения контракта → `specs/`-дельты.

## Последовательность на закрытии поставки

```bash
# 1. Найти активное изменение (не хардкодить путь)
openspec list --changes --json

# 2. Проверить валидность. Невалидно → вернуть тикет разработчику, НЕ архивировать.
openspec validate <change-name> --strict --json

# 3. Заархивировать: снимок в changes/archive/YYYY-MM-DD-<name>/ + вливание дельт в живые specs/
openspec archive <change-name> --yes --json
#   вариант «только снимок, без мутации живой доки»: --skip-specs

# 4. Верификация
openspec list --changes --json          # изменение ушло из активных
openspec validate --specs                # живые спеки валидны (без --all: он добавляет к
                                         # проверке активные поставки, и чужая краснота
                                         # выглядит как своя — прогнано на 1.11.0)

# 5. Commit в VCS: openspec/specs/** + openspec/changes/archive/** (git — вторая линия иммутабельности)
```

## Предусловие (интеграция)

`openspec archive` требует, чтобы изменение `<name>` уже существовало в `openspec/changes/`.
Кто его авторит — см. решение о глубине интеграции (тикет 10 / открытый вопрос):
- **глубоко:** Архитектор пишет изменение сразу в формате OpenSpec;
- **легко:** Технический писатель создаёт изменение из наших `requirements/spec/tickets` (`openspec new change`), затем архивирует.

> Точка изоляции зависимости (ADR-0011): смена версии OpenSpec / форк / vendoring — правится
> только этот адаптер.
