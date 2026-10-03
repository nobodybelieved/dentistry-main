# Развёртывание — Dentaly CRM

Два этапа: **(A)** опубликовать кликабельное демо на Cloudflare Pages прямо
сейчас, **(B)** поднять бэкенд позже по `BACKEND_PLAN.md`.

---

## A. Демо на Cloudflare Pages (статика)

Демо — это один `index.html` (без сборки). Корень проекта = корень публикации.

### Вариант 1 — через Dashboard (GitHub-интеграция)
1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → репозиторий `pllato-kz/dentaly`.
2. Настройки сборки:
   - **Framework preset:** `None`
   - **Build command:** *(пусто)*
   - **Build output directory:** `/` (корень)
3. Deploy → проект получит адрес `https://dentaly.pages.dev`.
4. Каждый push в `main` → авто-деплой (как у других проектов Pllato).

### Вариант 2 — через Wrangler (вручную)
```bash
npx wrangler pages deploy . --project-name=dentaly
```

### Проверка
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://dentaly.pages.dev/index.html
```

`_headers` уже добавляет базовые заголовки безопасности (X-Frame-Options,
X-Content-Type-Options, Referrer-Policy, Permissions-Policy).

---

## B. Бэкенд (когда дойдём до реализации)

Резюме `BACKEND_PLAN.md`. Все ресурсы по конвенции `dentaly-*`.

### 1. Создать ресурсы
```bash
# D1
npx wrangler d1 create dentaly-db
# R2
npx wrangler r2 bucket create dentaly-files
# KV
npx wrangler kv namespace create AUTH_CACHE
```
Полученные id вписать в `worker/wrangler.toml` (bindings: `DB`, `FILES`,
`AUTH_CACHE`, DO `ClinicRoom`/`UserNotifyRoom`).

### 2. Применить схему и демо-данные
```bash
cd worker
npx wrangler d1 execute dentaly-db --remote --file=../schema.sql
npx wrangler d1 execute dentaly-db --remote --file=../seed.sql
# локально для разработки:
npx wrangler d1 execute dentaly-db --local --file=../schema.sql
```

### 3. Секреты Worker
```bash
printf '%s' "$JWT"        | npx wrangler secret put JWT_SECRET     # hex 64, без \n!
printf '%s' "$WA_TOKEN"   | npx wrangler secret put WHATSAPP_TOKEN
printf '%s' "$TG_TOKEN"   | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$SMS_KEY"    | npx wrangler secret put MOBIZON_KEY
printf '%s' "$KASPI"      | npx wrangler secret put KASPI_SECRET
printf '%s' "$WH_SECRET"  | npx wrangler secret put WEBHOOK_SECRET
printf '%s' "$OPENAI"     | npx wrangler secret put OPENAI_API_KEY
# JSON-файлы — через stdin redirect, НЕ pipe:
npx wrangler secret put DOCXTOPDF_SECRET < secret.txt
```
> ⚠️ `echo | wrangler secret put` добавляет trailing `\n` и ломает подпись JWT.
> Используйте `printf '%s'` или `wrangler secret bulk`.

### 4. Деплой Worker
```bash
cd worker && npx wrangler deploy
curl https://dentaly-worker.<account>.workers.dev/api/health
```
DO-классы (`ClinicRoom`, `UserNotifyRoom`) применяются автоматически при первом
деплое с новым классом (нужен **Workers Paid**, $5/мес — из-за SQLite DO).

### 5. Связать фронт с API
В `config.js` фронта указать `API_URL` своего Worker. Добавить домен Pages и
домен виджета клиента в CORS allowlist Worker (`index.js`).

### 6. Cloud Run (docx→PDF), опционально
Отдельный сервис `dentaly-docxtopdf` (Python + LibreOffice) — для ИДС/договоров.
См. паттерн `pllato-docxtopdf` из Pllato Suite.

---

## Мониторинг (рекомендация)
- UptimeRobot: `dentaly.pages.dev`, `/api/health`, docxtopdf — «Alert After 2
  Failed Checks» (CF Bot Fight Mode может дать ложный 401 на первой проверке).

---

*Архитектура и эндпоинты: `BACKEND_PLAN.md`. Функционал: `TZ.md`.*
