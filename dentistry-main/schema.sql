-- ============================================================================
--  Dentaly CRM — D1 (SQLite) schema
--  Стоматологическая CRM. Multi-clinic, Cloudflare Workers + D1 + R2.
--
--  Конвенции (как в Pllato Suite):
--    • id            TEXT  — crypto.randomUUID()
--    • деньги        INTEGER — тенге, без копеек
--    • бизнес-даты   TEXT  — 'YYYY-MM-DD'
--    • created_at    INTEGER — Date.now() (мс от эпохи)
--    • boolean       INTEGER — 0 / 1
--    • snake_case в БД, camelCase в JS-маппинге
--
--  Применение:
--    wrangler d1 execute dentaly-db --remote --file=schema.sql
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────────────
--  КЛИНИКИ (multi-clinic — переключатель «Smile Studio ›» в сайдбаре)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                 -- «Smile Studio»
  legal_name    TEXT,                          -- ТОО / ИП реквизиты
  bin           TEXT,                          -- БИН/ИИН
  address       TEXT,
  phone         TEXT,
  email         TEXT,
  website       TEXT,                          -- smile-studio.kz
  timezone      TEXT DEFAULT 'Asia/Almaty',
  work_schedule TEXT,                          -- JSON: часы работы по дням
  settings      TEXT,                          -- JSON: прочие настройки клиники
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────
--  КАБИНЕТЫ / КРЕСЛА (Settings: «6 рабочих мест, 2 кабинета»)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chairs (
  id          TEXT PRIMARY KEY,
  clinic_id   TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                   -- «Кресло 3»
  room        TEXT,                            -- «Кабинет 1»
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- ─────────────────────────────────────────────────────────────────────────
--  ПОЛЬЗОВАТЕЛИ / СОТРУДНИКИ
--  role: owner|manager|admin|doctor|assistant|hygienist
--  Управляющий = manager/owner. Врачи = DOCTORS из мокапа.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  clinic_id      TEXT REFERENCES clinics(id) ON DELETE SET NULL,
  full_name      TEXT NOT NULL,                -- «Айгерим Сатпаева»
  initials       TEXT,                         -- «АС» (для аватара)
  color          TEXT,                         -- HEX-цвет аватара/расписания
  role           TEXT NOT NULL DEFAULT 'doctor',
  specialty      TEXT,                         -- Терапевт / Хирург-имплантолог / Ортодонт ...
  phone          TEXT,
  email          TEXT UNIQUE,
  password_hash  TEXT,                         -- bcrypt
  signature_key  TEXT,                         -- R2-ключ PNG-подписи врача
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_clinic ON users(clinic_id);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);

-- ─────────────────────────────────────────────────────────────────────────
--  ПАЦИЕНТЫ
--  tag: new|active|sleeping|debtor|vip   (вычисляемый сегмент)
--  source: Instagram|Рекомендация|2GIS|Google|Сайт|TikTok|Реклама|Семья
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
  id              TEXT PRIMARY KEY,
  clinic_id       TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  birth_date      TEXT,                         -- 'YYYY-MM-DD' (age в мокапе → birth_date)
  gender          TEXT,                         -- m|f
  phone           TEXT,
  email           TEXT,
  source          TEXT,                         -- канал привлечения
  lead_doctor_id  TEXT REFERENCES users(id) ON DELETE SET NULL,  -- лечащий врач
  tag             TEXT DEFAULT 'new',
  balance         INTEGER NOT NULL DEFAULT 0,   -- <0 = долг
  visits_count    INTEGER NOT NULL DEFAULT 0,
  last_visit      TEXT,                         -- 'YYYY-MM-DD'
  registered_at   TEXT,                         -- «Клиент с …» (since)
  risk_score      REAL DEFAULT 0,               -- 0..1 риск отмены/ухода
  marketing_opt_in INTEGER NOT NULL DEFAULT 1,
  language        TEXT DEFAULT 'ru',
  preferred_payment TEXT,                       -- «Kaspi · Карта VISA»
  medical_note    TEXT,                         -- аллергии/анамнез («Аллергия на лидокаин…»)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_tag    ON patients(tag);
CREATE INDEX IF NOT EXISTS idx_patients_doctor ON patients(lead_doctor_id);
CREATE INDEX IF NOT EXISTS idx_patients_phone  ON patients(phone);

-- Семейные связи (мокап: family:['p2']). Двусторонние пары.
CREATE TABLE IF NOT EXISTS patient_family (
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relative_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relation    TEXT,                             -- супруг|ребёнок|родитель ...
  PRIMARY KEY (patient_id, relative_id)
);

-- ─────────────────────────────────────────────────────────────────────────
--  ПРОГРАММА ЛОЯЛЬНОСТИ (3 уровня · 1 балл = 10 ₸)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- Silver|Gold|Platinum
  min_points    INTEGER NOT NULL DEFAULT 0,
  rate_tenge    INTEGER NOT NULL DEFAULT 10,    -- 1 балл = N ₸
  perks         TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  patient_id    TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  points        INTEGER NOT NULL DEFAULT 0,
  tier          TEXT,                           -- денормализованный текущий уровень
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,               -- + начисление / − списание
  reason        TEXT,                           -- «День рождения», «Оплата визита» …
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_patient ON loyalty_transactions(patient_id);

-- ─────────────────────────────────────────────────────────────────────────
--  ПРАЙС-ЛИСТ
--  category: ther|surg|orto|hyg|cons|prost|endo|ped
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS procedure_categories (
  id          TEXT PRIMARY KEY,                 -- 'ther', 'surg', …
  name        TEXT NOT NULL,                    -- Терапия, Хирургия …
  color       TEXT
);

CREATE TABLE IF NOT EXISTS procedures (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  category_id   TEXT REFERENCES procedure_categories(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,                  -- «Имплантация Straumann SLActive»
  price         INTEGER NOT NULL,               -- ₸
  duration_min  INTEGER DEFAULT 30,
  cost          INTEGER DEFAULT 0,              -- себестоимость (для маржи)
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_procedures_clinic ON procedures(clinic_id);
CREATE INDEX IF NOT EXISTS idx_procedures_cat    ON procedures(category_id);

-- ─────────────────────────────────────────────────────────────────────────
--  РАСПИСАНИЕ / ЗАПИСИ
--  status: pending|confirmed|inchair|done|noshow|cancelled
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chair_id      TEXT REFERENCES chairs(id) ON DELETE SET NULL,
  procedure_id  TEXT REFERENCES procedures(id) ON DELETE SET NULL,
  plan_visit_id TEXT,                           -- связь с визитом плана (если из плана)
  starts_at     INTEGER NOT NULL,               -- эпоха-мс начала
  duration_min  INTEGER NOT NULL DEFAULT 30,
  status        TEXT NOT NULL DEFAULT 'pending',
  price         INTEGER,                        -- снимок цены на момент записи
  risk_score    REAL DEFAULT 0,                 -- риск отмены (AI)
  source        TEXT,                           -- widget|reception|phone|...
  note          TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_appt_clinic_time ON appointments(clinic_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_doctor_time ON appointments(doctor_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_patient     ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_status      ON appointments(status);

-- ─────────────────────────────────────────────────────────────────────────
--  ЗУБНАЯ ФОРМУЛА (FDI 11–48)
--  state:    healthy|caries|filling|crown|implant|extracted|endo
--  surfaces: JSON {m,d,o,v,l: caries|filling|healthy}  (мезиал/дистал/окклюз/вестиб/лингв)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teeth (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth_num   INTEGER NOT NULL,                 -- FDI: 11..48
  state       TEXT DEFAULT 'healthy',
  surfaces    TEXT,                             -- JSON по поверхностям
  updated_at  INTEGER,
  UNIQUE (patient_id, tooth_num)
);
CREATE INDEX IF NOT EXISTS idx_teeth_patient ON teeth(patient_id);

-- История по конкретному зубу (TOOTH_HISTORY)
CREATE TABLE IF NOT EXISTS tooth_history (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth_num   INTEGER NOT NULL,
  event_date  TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  text        TEXT NOT NULL,                    -- «Установка импланта Straumann …»
  doctor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tooth_hist ON tooth_history(patient_id, tooth_num);

-- ─────────────────────────────────────────────────────────────────────────
--  ПЛАНЫ ЛЕЧЕНИЯ
--  status: draft|agreed|in_progress|completed|cancelled
--  active_variant: economy|standard|premium
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS treatment_plans (
  id              TEXT PRIMARY KEY,
  clinic_id       TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id      TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,                -- «Комплексное лечение и протезирование»
  status          TEXT NOT NULL DEFAULT 'draft',
  active_variant  TEXT DEFAULT 'standard',
  discount_pct    REAL DEFAULT 0,
  discount_reason TEXT,                         -- «Постоянный клиент»
  agreed_at       TEXT,                         -- 'YYYY-MM-DD'
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plans_patient ON treatment_plans(patient_id);
CREATE INDEX IF NOT EXISTS idx_plans_status  ON treatment_plans(status);

-- Варианты (Эконом / Стандарт / Премиум)
CREATE TABLE IF NOT EXISTS plan_variants (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,                    -- economy|standard|premium
  name        TEXT NOT NULL,
  subtitle    TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  duration    TEXT,                             -- «5–6 мес»
  UNIQUE (plan_id, variant_key)
);

-- Визиты внутри плана
CREATE TABLE IF NOT EXISTS plan_visits (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  doctor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,                  -- «Имплантация 46»
  visit_date    TEXT,                           -- план/факт дата
  duration_min  INTEGER DEFAULT 60,
  status        TEXT NOT NULL DEFAULT 'planned',-- planned|in_progress|done
  sort_order    INTEGER DEFAULT 0,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_visits_plan ON plan_visits(plan_id);

-- Этапы (процедуры) внутри визита
CREATE TABLE IF NOT EXISTS plan_stages (
  id            TEXT PRIMARY KEY,
  visit_id      TEXT NOT NULL REFERENCES plan_visits(id) ON DELETE CASCADE,
  procedure_id  TEXT REFERENCES procedures(id) ON DELETE SET NULL,
  tooth_num     INTEGER,                        -- FDI
  proc_name     TEXT NOT NULL,                  -- снимок названия
  price         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'planned',-- planned|done
  sort_order    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plan_stages_visit ON plan_stages(visit_id);

-- ─────────────────────────────────────────────────────────────────────────
--  ФИНАНСЫ
--  payments — фактические поступления; transactions — общий журнал операций
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  plan_id       TEXT REFERENCES treatment_plans(id) ON DELETE SET NULL,
  visit_id      TEXT REFERENCES plan_visits(id) ON DELETE SET NULL,
  amount        INTEGER NOT NULL,               -- ₸
  method        TEXT,                           -- Kaspi QR|Kaspi Red рассрочка|Карта VISA|Наличные
  installment   TEXT,                           -- «0/0/12» если рассрочка
  paid_at       TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  receipt_key   TEXT,                           -- R2-ключ чека (отправляется в WhatsApp)
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_clinic  ON payments(clinic_id);
CREATE INDEX IF NOT EXISTS idx_payments_date    ON payments(paid_at);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT REFERENCES patients(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                  -- payment|charge|refund|plan|writeoff
  title         TEXT,                           -- «Имплантация 46»
  amount        INTEGER NOT NULL,               -- + приход / − начисление
  method        TEXT,
  status        TEXT DEFAULT 'paid',            -- paid|plan|pending
  tx_date       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_patient ON transactions(patient_id);
CREATE INDEX IF NOT EXISTS idx_tx_clinic  ON transactions(clinic_id);

-- ─────────────────────────────────────────────────────────────────────────
--  СКЛАД
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- «Артикаин Septanest 4% 1:200000»
  category      TEXT,                           -- Анестезия|Расходники|Имплантация|…
  stock         INTEGER NOT NULL DEFAULT 0,
  min_stock     INTEGER NOT NULL DEFAULT 0,
  unit          TEXT,                           -- карпул|шт|шприц|компл|л|упак
  expiry        TEXT,                           -- 'YYYY-MM' или NULL
  cost          INTEGER NOT NULL DEFAULT 0,     -- ₸ за единицу
  supplier      TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inv_clinic ON inventory_items(clinic_id);

-- Движения склада: приход (поступление), расход (списание), инвентаризация
CREATE TABLE IF NOT EXISTS inventory_movements (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                  -- in|out|adjust
  qty           INTEGER NOT NULL,
  reason        TEXT,                           -- «Списано на визит», «Поступление от поставщика»
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  doctor_id     TEXT REFERENCES users(id) ON DELETE SET NULL, -- для какого врача списан расходник (может ≠ created_by)
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL, -- кто выполнил операцию (автор)
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(item_id);

-- ─────────────────────────────────────────────────────────────────────────
--  ФАЙЛЫ И СНИМКИ (R2)  — КТ(dicom), снимки(jpg), слепки(stl), pdf(ИДС/договоры)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT REFERENCES patients(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- «КТ-снимок челюстей»
  kind          TEXT,                           -- ct|xray|scan|photo|document|contract|consent|warranty
  ext           TEXT,                           -- dicom|jpg|stl|pdf
  r2_key        TEXT NOT NULL,                  -- ключ в R2
  size_bytes    INTEGER,
  tooth_num     INTEGER,                        -- если снимок привязан к зубу
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_patient ON files(patient_id);

-- Шаблоны документов (ИДС, договоры) + сгенерированные документы
CREATE TABLE IF NOT EXISTS document_templates (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- «ИДС на имплантацию», «Договор»
  kind          TEXT,                           -- consent|contract|warranty
  r2_key        TEXT,                           -- .docx шаблон
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generated_documents (
  id            TEXT PRIMARY KEY,
  template_id   TEXT REFERENCES document_templates(id) ON DELETE SET NULL,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  plan_id       TEXT REFERENCES treatment_plans(id) ON DELETE SET NULL,
  number        TEXT,                           -- «К-2026-184»
  r2_key        TEXT NOT NULL,                  -- готовый PDF
  signed_at     TEXT,                           -- дата подписи (электронно)
  status        TEXT DEFAULT 'ready',           -- ready|signed
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gendoc_patient ON generated_documents(patient_id);

-- ─────────────────────────────────────────────────────────────────────────
--  КОММУНИКАЦИИ  (каналы: wa|tg|sms|email)
-- ─────────────────────────────────────────────────────────────────────────
-- Контакты пациента по каналам
CREATE TABLE IF NOT EXISTS patient_channels (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,                    -- wa|tg|sms|email
  address     TEXT NOT NULL,                    -- номер / @username / email
  is_primary  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (patient_id, channel, address)
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,                  -- wa|tg|sms
  last_message  TEXT,
  last_at       INTEGER,
  unread        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (patient_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_conv_clinic ON conversations(clinic_id, last_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,                -- in|out
  body            TEXT,
  attachment_key  TEXT,                         -- R2
  status          TEXT,                         -- sent|delivered|read|failed
  is_automated    INTEGER NOT NULL DEFAULT 0,   -- отправлено автоматизацией/ботом
  sent_at         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, sent_at);

-- Шаблоны сообщений (24 шаблона в мокапе)
CREATE TABLE IF NOT EXISTS message_templates (
  id          TEXT PRIMARY KEY,
  clinic_id   TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                    -- «Подтверждение записи»
  channel     TEXT,                             -- wa|tg|sms|any
  body        TEXT NOT NULL,                    -- с плейсхолдерами {{name}}, {{date}} …
  is_active   INTEGER NOT NULL DEFAULT 1
);

-- Автоматизации (8 сценариев)
CREATE TABLE IF NOT EXISTS automations (
  id          TEXT PRIMARY KEY,
  clinic_id   TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                    -- «Подтверждение записи»
  description TEXT,                             -- «WhatsApp + Telegram за 24 ч до визита»
  channels    TEXT,                             -- JSON ['wa','tg']
  trigger     TEXT,                             -- before_visit_24h|after_visit_2h|birthday|...
  template_id TEXT REFERENCES message_templates(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active|paused
  created_at  INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────
--  NPS / ОТЗЫВЫ
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nps_responses (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  score         INTEGER,                         -- 0..10
  comment       TEXT,
  created_at    INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────
--  ЛЕНТА СОБЫТИЙ / ХРОНОЛОГИЯ ПАЦИЕНТА (TIMELINE) + общий журнал действий
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT REFERENCES patients(id) ON DELETE CASCADE,
  actor_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,                  -- call_in|call_out|visit|payment|plan_agreed|message|nps|...
  icon          TEXT,                           -- подсказка иконки для UI
  title         TEXT,
  meta          TEXT,
  description   TEXT,
  event_at      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_patient ON activity_log(patient_id, event_at);
CREATE INDEX IF NOT EXISTS idx_activity_clinic  ON activity_log(clinic_id, event_at);

-- ─────────────────────────────────────────────────────────────────────────
--  УВЕДОМЛЕНИЯ (колокольчик)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,  -- адресат (NULL = всем)
  icon          TEXT,                           -- bell|box|alert|star|cash|cal
  title         TEXT NOT NULL,
  meta          TEXT,
  link          TEXT,                           -- куда вести по клику
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- ─────────────────────────────────────────────────────────────────────────
--  ЛИДЫ / ВОРОНКА / ИСТОЧНИКИ (Аналитика)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    TEXT REFERENCES patients(id) ON DELETE SET NULL,
  name          TEXT,
  phone         TEXT,
  source        TEXT,                           -- Instagram|2GIS|Google|Сайт|TikTok|Рекомендация
  stage         TEXT NOT NULL DEFAULT 'lead',   -- lead|booked|visited|plan|paid|repeat
  utm           TEXT,                           -- JSON utm-меток
  cost          INTEGER DEFAULT 0,              -- стоимость привлечения (CAC)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leads_clinic ON leads(clinic_id, stage);

-- ─────────────────────────────────────────────────────────────────────────
--  АУТЕНТИФИКАЦИЯ (rate-limit/cache живут в KV; здесь — refresh-сессии)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ─────────────────────────────────────────────────────────────────────────
--  НАСТРОЙКИ (key-value на клинику) + интеграции
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  clinic_id   TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  PRIMARY KEY (clinic_id, key)
);

-- Интеграции: Kaspi, WhatsApp Cloud API, Telegram Bot, SMS Mobizon, 1С, Bitrix24
CREATE TABLE IF NOT EXISTS integrations (
  id           TEXT PRIMARY KEY,
  clinic_id    TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,                   -- kaspi|whatsapp|telegram|sms_mobizon|1c|bitrix24
  status       TEXT NOT NULL DEFAULT 'disabled',-- enabled|disabled
  config       TEXT,                            -- JSON (нечувствительная часть; секреты — в Worker secrets)
  updated_at   INTEGER,
  UNIQUE (clinic_id, provider)
);

-- ─────────────────────────────────────────────────────────────────────────
--  КОМАНДА И РОЛИ
-- ─────────────────────────────────────────────────────────────────────────

-- Переопределения разделов по роли (встроенные роли живут в хардкоде ROLES)
CREATE TABLE IF NOT EXISTS roles (
  id       TEXT PRIMARY KEY,   -- owner|manager|admin|doctor|... | role_xxxxxxxx (кастомные)
  name     TEXT NOT NULL,
  sections TEXT                -- JSON-массив id разделов; NULL = использовать хардкод-дефолт
);

-- Приглашения новых сотрудников
CREATE TABLE IF NOT EXISTS invites (
  token         TEXT PRIMARY KEY,
  clinic_id     TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  name          TEXT,
  email         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  used_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_clinic ON invites(clinic_id, created_at);
