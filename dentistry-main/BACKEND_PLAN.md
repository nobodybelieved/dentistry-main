# Backend Plan — Dentaly CRM

Архитектура повторяет проверенный стек **Pllato Suite** (Cloudflare-native,
self-hosted на аккаунте клиента). Один клиент = один аккаунт CF = один Worker +
D1 + R2. Не multi-tenant на уровне инфраструктуры; мультиклиника — на уровне
данных (`clinic_id`).

---

## 1. Топология

```
  pllato-suite-style:

  [ dentaly (Pages) ]  ── статичный SPA: index.html + app.js + ui-*.js + style.css
        │  HTTPS + JWT (localStorage) / WS (?token=)
        ▼
  [ dentaly-worker (Cloudflare Worker) ]  ── API + бизнес-логика
        ├── D1   dentaly-db        — основная БД (schema.sql)
        ├── R2   dentaly-files     — КТ/снимки/слепки/документы/чеки/подписи
        ├── KV   AUTH_CACHE        — rate-limit логина, кэш сессий
        ├── DO   ClinicRoom        — real-time расписания/«в кресле» (WebSocket)
        ├── DO   UserNotifyRoom    — персональные уведомления (WebSocket)
        ├── cron — напоминания, реактивация, NPS, пересчёт рисков/сегментов
        └── fetch → Cloud Run docxtopdf  — генерация ИДС/договоров (.docx → PDF)
                  → WhatsApp Cloud API / Telegram Bot API / Mobizon (SMS)
                  → Kaspi (оплаты/рассрочка)
                  → OpenAI/Whisper (AI-ассистент, надиктовка протокола)
```

### Ресурсы (имена по конвенции `<slug>-*`, slug=`dentaly`)
| Ресурс | Имя | Назначение |
|--------|-----|-----------|
| Worker | `dentaly-worker` | API |
| D1 | `dentaly-db` | БД (33+ таблицы, `schema.sql`) |
| R2 | `dentaly-files` | бинарные файлы |
| KV | `AUTH_CACHE` | rate-limit / cache |
| DO | `ClinicRoom`, `UserNotifyRoom` | real-time (Hibernation API) |
| Pages | `dentaly` | фронт SPA → `dentaly.pages.dev` |
| Cloud Run | `dentaly-docxtopdf` | конвертер .docx→PDF (Python + LibreOffice) |

Plan: **Workers Paid** ($5/мес) — обязателен из-за SQLite Durable Objects.

---

## 2. Структура кода Worker (предлагаемая)

```
worker/
├── wrangler.toml
├── src/
│   ├── index.js            — routing, CORS allowlist, WS upgrade (до CORS-обёртки!)
│   ├── auth.js             — JWT, bcrypt, login rate-limit, роли/гард
│   ├── api-utils.js        — json(), error(), withAuth(), withRole()
│   ├── patients-api.js     — пациенты, сегменты, семья, лояльность
│   ├── schedule-api.js     — расписание, записи, статусы, слоты
│   ├── teeth-api.js        — зубная формула, история зуба
│   ├── plans-api.js        — планы лечения, визиты, этапы, варианты
│   ├── finance-api.js      — оплаты, транзакции, дебиторка, прайс
│   ├── inventory-api.js    — склад, движения, автосписание
│   ├── comms-api.js        — диалоги, сообщения, шаблоны, автоматизации
│   ├── analytics-api.js    — KPI, воронка, когорты, источники, врачи
│   ├── files.js            — R2 upload/download (auth + подписанные ссылки)
│   ├── documents-api.js    — .docx-шаблоны → PDF (Cloud Run)
│   ├── ai-api.js           — ассистент, скоринг рисков, Whisper-протокол
│   ├── integrations/
│   │   ├── whatsapp.js      — Cloud API webhook + отправка
│   │   ├── telegram.js      — Bot webhook + отправка
│   │   ├── sms.js           — Mobizon
│   │   └── kaspi.js         — оплаты/рассрочка
│   ├── clinic-room.js      — DO: real-time расписания/«в кресле»
│   ├── user-notify-room.js — DO: персональные уведомления + broadcastToUser()
│   └── cron.js             — scheduled handlers
└── schema.sql, seed.sql    — (копии из корня)
```

**Конвенции** (как в Pllato Suite): vanilla JS без TS; snake_case в БД →
camelCase в JS; `crypto.randomUUID()` для id; `Date.now()` (INTEGER мс) для
timestamps; всё async/await; JWT в `Authorization: Bearer`, для WS — в query.
⚠️ `/api/ws/*` обрабатывать **до** общей CORS-обёртки (иначе теряется
`webSocket` property → close 1006).

---

## 3. API (черновик эндпоинтов)

> Все под `/api`, требуют JWT (кроме `auth/login`, webhooks, публичного виджета).
> Ответы JSON, ошибки `{error, code}`. Гард по ролям где указано `[role]`.

### Auth
```
POST   /api/auth/login            {email,password} → {token,user}
POST   /api/auth/logout
GET    /api/me                    → текущий пользователь + клиника
POST   /api/auth/2fa/verify       [owner]
```

### Пациенты
```
GET    /api/patients              ?tag=&q=&page=         список + счётчики сегментов
POST   /api/patients              создать
GET    /api/patients/:id          карточка (шапка + быстрые факты)
PATCH  /api/patients/:id
GET    /api/patients/:id/timeline лента взаимодействий (обзор)
GET    /api/patients/:id/family
GET    /api/patients/:id/loyalty
```

### Зубная формула
```
GET    /api/patients/:id/teeth                карта зубов
PUT    /api/patients/:id/teeth/:num           состояние/поверхности зуба
GET    /api/patients/:id/teeth/:num/history   история зуба
POST   /api/patients/:id/teeth/:num/history   добавить запись
```

### Расписание
```
GET    /api/schedule              ?date=&doctor_id=      сетка дня
POST   /api/appointments          создать запись
GET    /api/appointments/:id
PATCH  /api/appointments/:id      смена статуса/переноса (broadcast в ClinicRoom)
GET    /api/slots                 ?doctor_id=&date=      свободные слоты (для виджета)
```

### Планы лечения
```
GET    /api/treatment-plans                 ?status= список (модуль «Лечение»)
GET    /api/patients/:id/plan               план пациента (hero+варианты+визиты)
POST   /api/patients/:id/plan               создать (draft/agreed)
PATCH  /api/plans/:id                       статус/активный вариант/скидка
POST   /api/plans/:id/visits                добавить визит
DELETE /api/plans/:id/stages/:sid           удалить этап
POST   /api/plans/:id/offer                 «отправить пациенту» (WhatsApp/TG)
GET    /api/plans/:id/pdf                    PDF плана клиенту
```

### Финансы
```
GET    /api/finance/summary       [manager]  KPI + структура выручки
GET    /api/finance/debtors       [manager]  должники
POST   /api/payments              принять оплату (обновляет баланс/лояльность)
GET    /api/patients/:id/finance  операции пациента
GET    /api/procedures            прайс-лист
POST   /api/procedures            [manager]  CRUD прайса
PATCH  /api/procedures/:id        [manager]
```

### Склад
```
GET    /api/inventory             позиции + KPI
POST   /api/inventory             [admin] добавить позицию
POST   /api/inventory/:id/move    приход/расход/инвентаризация
POST   /api/inventory/:id/order   заказать (для позиций < min)
```

### Коммуникации
```
GET    /api/conversations         активные диалоги (фильтр по каналу)
GET    /api/patients/:id/messages ?channel=  переписка
POST   /api/patients/:id/messages отправить (wa|tg|sms)
GET    /api/templates             шаблоны сообщений
GET    /api/automations           список (8 сценариев)
PATCH  /api/automations/:id       вкл/выкл
POST   /api/webhooks/whatsapp     входящие (secret в URL + HMAC)
POST   /api/webhooks/telegram
POST   /api/webhooks/kaspi        статус оплаты
```

### Аналитика
```
GET    /api/analytics/kpi         [manager] LTV/CAC/retention
GET    /api/analytics/sources     [manager] источники + ROI
GET    /api/analytics/cohorts     [manager] когорты удержания
GET    /api/analytics/doctors     [manager] производительность врачей
```

### Файлы / документы / AI / уведомления
```
POST   /api/files                 upload в R2 (multipart)
GET    /api/files/:id             download (auth + подписанная ссылка)
POST   /api/documents/generate    .docx-шаблон + данные → PDF (Cloud Run)
POST   /api/ai/chat               ассистент
POST   /api/ai/transcribe         надиктовка протокола (Whisper)
GET    /api/ai/risk/:patientId    скоринг риска
GET    /api/notifications         колокольчик
GET    /api/ws/user?token=        WebSocket: уведомления (UserNotifyRoom)
GET    /api/ws/clinic?token=      WebSocket: расписание/«в кресле» (ClinicRoom)
```

### Публичное (виджет онлайн-записи)
```
GET    /api/public/slots          свободные слоты (CORS: домен клиники)
POST   /api/public/book           заявка с виджета → lead + appointment(pending)
```

---

## 4. Cron-задачи (UTC; Алматы = UTC+5)

| Расписание | Задача |
|-----------|--------|
| каждые 15 мин | подтверждения за 24 ч / напоминания за 2 ч (автоматизации) |
| ежедневно 04:00 UTC (09:00 Алматы) | пересчёт сегментов (sleeping/debtor/vip), риск-скоринг |
| Пн 04:00 UTC | реактивация спящих 6+ мес |
| после визита (+2 ч, через очередь) | NPS-опрос |
| ежедневно | проверка склада < min → уведомление; сроки годности < 60 дн |

---

## 5. Real-time (Durable Objects, Hibernation API)

- **ClinicRoom** (по `clinic_id`): пуш изменений расписания, статус «в кресле»,
  новые записи с виджета. Подписка ресепшна/дашборда.
- **UserNotifyRoom** (по `user_id`): персональные уведомления (не подтверждена
  запись, низкий склад, NPS, согласование плана) + auto-actions.
- Бесплатно когда idle (Hibernation). Требует Workers Paid.

---

## 6. Безопасность

- JWT TTL 48 ч, bcrypt, ролевой гард (`withRole('manager')`).
- Login rate-limit 5/15 мин через KV.
- CORS allowlist (домены Pages + localhost + домен виджета клиента).
- Файлы пациентов (КТ/снимки/ИДС) — **только через auth**, подписанные R2-ссылки
  с TTL. ⚠️ Не делать публичный download (медданные!).
- Webhook'и: secret в URL **+** HMAC-проверка подписи.
- Audit-журнал действий (таблица `activity_log` + отдельный security-лог).
- 2FA для роли `owner`/`manager`.

---

## 7. Что переиспользуется из Pllato Suite

Готовые паттерны можно перенести почти 1:1: `auth.js` (JWT/bcrypt/rate-limit),
`files.js` (R2 + auth), `user-notify-room.js` (DO + broadcastToUser), CORS-обёртка
с WS-исключением, `documents-api.js` (docx→pdf через Cloud Run), интеграционные
webhook-хендлеры (WhatsApp/Telegram по аналогии с Wazzup/Binotel), `fcm.js` (push).

---

*Модель данных: `schema.sql`. Демо-данные: `seed.sql`. Функционал: `TZ.md`.
Развёртывание: `DEPLOY.md`.*
