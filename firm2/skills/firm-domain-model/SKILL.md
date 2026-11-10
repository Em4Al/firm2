---
name: firm-domain-model
description: Приём движка «доменное моделирование / глоссарий». Адаптер поверх mattpocock-skills:domain-modeling. Использует PM и Архитектор.
---

# firm-domain-model (адаптер)

Приём движка для **уточнения доменных терминов и глоссария**.

**Реализация:** делегирует в `mattpocock-skills:domain-modeling` (пин версии — см. `.firm/config`).
Вызови Skill tool со скиллом `mattpocock-skills:domain-modeling`.

> Точка изоляции зависимости — см. ADR-0011 (`docs/adr/0011-приём-изолирует-внешний-скил.md`).
