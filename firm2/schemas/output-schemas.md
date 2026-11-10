# Схемы structured output ролей (канон)

Единый контракт хендоффа. Роли возвращают ровно эти структуры; Workflow/`/firm-run` используют их как `schema`.

> ⚠️ **Ключи свойств — только ASCII** (`^[a-zA-Z0-9_.-]{1,64}$`), иначе Anthropic API 400.
> Значения enum можно кириллицей (напр. verdict: "принято"/"отклонено").

## PM (два режима — опрос через ретрансляцию)
```json
{ "mode": "questions", "change": "<name>",
  "questions": [{ "id": "q1", "text": "…", "recommendation": "…" }] }

{ "mode": "done", "status": "ok", "change": "<name>",
  "artifact_path": "openspec/changes/<name>/proposal.md", "criteria": ["…"] }
```

## Архитектор (два режима + адъюдикация dissent)
```json
{ "mode": "questions", "change": "<name>",
  "questions": [{ "id": "q1", "text": "…", "recommendation": "…" }] }

{ "mode": "done", "status": "ok", "change": "<name>",
  "artifacts": ["design.md", "tasks.md", "specs/…"],
  "tasks": [{ "id": "T1", "labels": ["high-complexity"] }] }
```
Адъюдикация dissent (Архитектор заводит баг + вердикт):
```json
{ "verdict": "blocker" | "not_blocker", "bug_path": "docs/bugs/BUG-001.md", "notes": "…" }
```

## Разработчик
```json
{ "status": "ok" | "fail" | "blocked", "task": "T1",
  "files_changed": ["…"], "escalate": false, "notes": "" }
```

## Тестировщик
```json
{ "status": "ok" | "fail", "tests": ["…"],
  "report": { "total": 0, "passed": 0, "failed": 0 } }
```

## Ревьюер-QA (вердикт)
```json
{ "verdict": "принято" | "отклонено", "escalate": false,
  "criteria_results": [{}], "notes": "" }
```

## Технический писатель (OpenSpec archive)
```json
{ "status": "ok" | "fail", "archive": "openspec/changes/archive/YYYY-MM-DD-<name>",
  "live_specs_updated": true, "validate_specs_ok": true }
```

## DevOps (PR/MR)
```json
{ "status": "ok" | "fail", "mr_url": "…", "build_report": {} }
```
