# Dentaly CRM — Claude Code Context

> Читается при старте сессии Claude Code. Контекст проекта Dentaly.

## TL;DR
**Dentaly** — CRM для стоматологии (бренд Pllato). Витрина — сеть клиник
«Smile Studio», Алматы. Сейчас в репо: **кликабельный мокап + полный пакет ТЗ
для реализации** (спецификация, модель данных, архитектура, демо-данные).

**Репо:** `github.com/pllato-kz/dentaly` (PRIVATE), ветка `main`.
**Демо (план):** `dentaly.pages.dev` (Cloudflare Pages, авто-деплой из `main`).

## Структура
```
dentaly/
├── index.html        ← мокап = эталон UI + деплой-демо (vanilla JS, без сборки)
├── TZ.md             ← техзадание: модули/экраны/роли/бизнес-правила
├── BACKEND_PLAN.md   ← архитектура CF (Workers/D1/R2/DO), API, cron
├── schema.sql        ← модель данных D1 (SQLite), ~33 таблицы
├── seed.sql          ← демо-данные (Smile Studio, врачи, p4 — витрина плана)
├── DEPLOY.md         ← Pages сейчас, бэкенд позже
├── README.md
├── _headers          ← заголовки безопасности Pages
└── .gitignore
```

## Что это за продукт
Стоматологическая CRM: Дашборд · Расписание (сетка время×врачи) · Пациенты
(список + карточка с 7 вкладками) · Лечение (планы) · Финансы · Склад ·
Коммуникации (WhatsApp/Telegram/SMS) · Аналитика · Настройки · AI-ассистент.

**Сигнатурные фичи:** интерактивная зубная формула (FDI 11–48, состояние по
поверхностям M/D/O/V/L + история зуба) и планы лечения (план → визиты → этапы,
3 варианта Эконом/Стандарт/Премиум, график платежей, AI-рекомендация рассрочки).

## Конвенции (как во всех проектах Pllato)
- Vanilla JS без билдера. Snake_case в БД → camelCase в JS.
- id: `crypto.randomUUID()` (TEXT). Деньги: INTEGER (тенге). Даты бизнес-: TEXT
  'YYYY-MM-DD'. Timestamps: INTEGER (`Date.now()` мс). Boolean: 0/1.
- Язык UI: ru. Валюта ₸, locale ru-RU. TZ Asia/Almaty (UTC+5).
- Цвета — CSS-переменные (`--primary:#0F766E`). Сайдбар `#0E1F1E`.
- Коммиты: `type: краткое описание` (feat/fix/docs/security/refactor).

## Бэкенд (когда дойдём)
Повторяет стек **Pllato Suite** (`~/pllato-chat-v1.5/pllato-chat`): Worker + D1 +
R2 + KV + DO + Pages + Cloud Run (docx→pdf). Многое переиспользуется 1:1
(auth.js, files.js, user-notify-room.js, CORS-обёртка с WS-исключением,
documents-api.js). Детали и список эндпоинтов — `BACKEND_PLAN.md`.

## Gotchas
- Pages раздаёт `index.html` как есть — никакого npm install / сборки.
- При реализации бэкенда: `/api/ws/*` обрабатывать **до** CORS-обёртки (иначе
  теряется WebSocket → close 1006). SQLite DO требует Workers Paid ($5/мес).
- Файлы пациентов (КТ/снимки/ИДС) — медданные: только auth + подписанные
  R2-ссылки, без публичного download.
- Секреты: `printf '%s'` (не `echo`, добавляет `\n` и ломает JWT).
- `seed.sql` идемпотентен (INSERT OR REPLACE, фикс. id). created_at =
  1779408000000 (~2026-05-22, «сегодня» мокапа).

## Что обычно просят
1. Доработать мокап (новый экран/фича в `index.html`).
2. Уточнить/расширить ТЗ или схему.
3. Начать реализацию бэкенда по `BACKEND_PLAN.md`.
4. Развернуть демо на Pages.

---
*Эталон UI: `index.html`. Спека: `TZ.md`. Данные: `schema.sql`/`seed.sql`.*
