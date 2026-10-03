-- Атрибуция списания «для какого врача» (отдельно от автора created_by).
-- Применять однократно к уже развёрнутой БД:
--   cd worker && npx wrangler d1 execute dentaly-db --remote \
--     --file=migrations/0001_inventory_movement_doctor.sql
-- (SQLite не поддерживает ADD COLUMN IF NOT EXISTS — при повторном запуске
--  выдаст «duplicate column name», это ожидаемо и безопасно.)
ALTER TABLE inventory_movements ADD COLUMN doctor_id TEXT REFERENCES users(id) ON DELETE SET NULL;
