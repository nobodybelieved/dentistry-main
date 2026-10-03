// Cron-задачи Dentaly CRM
// Расписание (UTC; Алматы = UTC+5):
//   */15 * * * *  — напоминания о записях (за 24ч и за 2ч)
//   0 4 * * *     — ежедневно 09:00 Алматы: сегменты + склад
//   0 4 * * 1     — понедельник 09:00: реактивация спящих

const ALM = 5 * 3600000; // UTC+5 в мс

function uid() { return crypto.randomUUID(); }
function nowMs() { return Date.now(); }

// ─── Создать уведомление ──────────────────────────────────────────────────────
async function notify(db, clinicId, userId, { icon, title, meta, link }) {
  await db.prepare(
    `INSERT INTO notifications (id,clinic_id,user_id,icon,title,meta,link,is_read,created_at)
     VALUES (?,?,?,?,?,?,?,0,?)`
  ).bind(uid(), clinicId, userId || null, icon, title, meta || null, link || null, nowMs()).run();
}

// ─── Получить всех manager/admin клиники ─────────────────────────────────────
async function getManagers(db, clinicId) {
  const rows = await db.prepare(
    `SELECT id FROM users WHERE clinic_id = ? AND role IN ('manager','admin','owner') AND is_active = 1`
  ).bind(clinicId).all();
  return (rows.results || []).map(r => r.id);
}

// ─── Получить все активные клиники ───────────────────────────────────────────
async function getClinics(db) {
  const rows = await db.prepare('SELECT id FROM clinics WHERE is_active = 1').all();
  return (rows.results || []).map(r => r.id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ЗАДАЧА 1: Напоминания о записях (каждые 15 мин)
// ═══════════════════════════════════════════════════════════════════════════════
export async function runReminders(db) {
  const now = nowMs();
  const window15 = 15 * 60 * 1000; // 15 минут — окно проверки

  // Записи через ~24ч (23:45 – 24:15 от сейчас)
  const h24start = now + 23 * 3600000 + 45 * 60000;
  const h24end   = now + 24 * 3600000 + 15 * 60000;

  // Записи через ~2ч (1:45 – 2:15 от сейчас)
  const h2start = now + 105 * 60000;
  const h2end   = now + 135 * 60000;

  const clinics = await getClinics(db);

  for (const clinicId of clinics) {
    const managers = await getManagers(db, clinicId);

    // 24-часовые напоминания
    const appts24 = await db.prepare(
      `SELECT a.id, a.starts_at, p.full_name, u.full_name AS doc_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users u ON u.id = a.doctor_id
       WHERE a.clinic_id = ? AND a.status IN ('pending','confirmed')
         AND a.starts_at >= ? AND a.starts_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.clinic_id = ? AND n.link = 'appt:'||a.id AND n.meta = 'reminder24'
         )`
    ).bind(clinicId, h24start, h24end, clinicId).all();

    for (const a of (appts24.results || [])) {
      const dt = new Date(a.starts_at + ALM);
      const time = `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
      for (const uid2 of managers) {
        await notify(db, clinicId, uid2, {
          icon: 'cal',
          title: `Завтра в ${time} — ${a.full_name}`,
          meta: 'reminder24',
          link: `appt:${a.id}`,
        });
      }
    }

    // 2-часовые напоминания
    const appts2 = await db.prepare(
      `SELECT a.id, a.starts_at, p.full_name, u.full_name AS doc_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users u ON u.id = a.doctor_id
       WHERE a.clinic_id = ? AND a.status IN ('pending','confirmed')
         AND a.starts_at >= ? AND a.starts_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.clinic_id = ? AND n.link = 'appt:'||a.id AND n.meta = 'reminder2h'
         )`
    ).bind(clinicId, h2start, h2end, clinicId).all();

    for (const a of (appts2.results || [])) {
      const dt = new Date(a.starts_at + ALM);
      const time = `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
      for (const uid2 of managers) {
        await notify(db, clinicId, uid2, {
          icon: 'bell',
          title: `Через 2 часа: ${a.full_name} в ${time}`,
          meta: 'reminder2h',
          link: `appt:${a.id}`,
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ЗАДАЧА 2: Пересчёт сегментов пациентов (ежедневно)
// ═══════════════════════════════════════════════════════════════════════════════
export async function runSegments(db) {
  const now = nowMs();
  const almToday = new Date(now + ALM).toISOString().slice(0, 10);
  const sixMonthsAgo = new Date(now + ALM - 183 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now + ALM - 30 * 86400000).toISOString().slice(0, 10);

  const clinics = await getClinics(db);

  for (const clinicId of clinics) {
    // debtor: balance < 0
    await db.prepare(
      `UPDATE patients SET tag='debtor', updated_at=? WHERE clinic_id=? AND balance<0`
    ).bind(now, clinicId).run();

    // sleeping: нет визита 6+ мес, не должник, есть хоть 1 визит
    await db.prepare(
      `UPDATE patients SET tag='sleeping', updated_at=?
       WHERE clinic_id=? AND balance>=0 AND visits_count>0
         AND (last_visit IS NULL OR last_visit < ?)`
    ).bind(now, clinicId, sixMonthsAgo).run();

    // vip: много визитов и не должник
    await db.prepare(
      `UPDATE patients SET tag='vip', updated_at=?
       WHERE clinic_id=? AND balance>=0 AND visits_count>=15
         AND (last_visit IS NULL OR last_visit >= ?)`
    ).bind(now, clinicId, sixMonthsAgo).run();

    // new: 1 визит или зарегистрирован < 30 дней, не должник
    await db.prepare(
      `UPDATE patients SET tag='new', updated_at=?
       WHERE clinic_id=? AND balance>=0 AND visits_count<=1
         AND (registered_at IS NULL OR registered_at >= ?)`
    ).bind(now, clinicId, thirtyDaysAgo).run();

    // active: всё остальное — не sleeping, не debtor, не vip, не new
    await db.prepare(
      `UPDATE patients SET tag='active', updated_at=?
       WHERE clinic_id=? AND balance>=0 AND visits_count>1
         AND last_visit >= ?
         AND tag NOT IN ('vip','debtor')`
    ).bind(now, clinicId, sixMonthsAgo).run();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ЗАДАЧА 3: Проверка склада (ежедневно)
// ═══════════════════════════════════════════════════════════════════════════════
export async function runInventoryCheck(db) {
  const now = nowMs();
  const almNow = new Date(now + ALM);
  const todayStr = almNow.toISOString().slice(0, 7); // YYYY-MM
  const exp60 = new Date(now + ALM + 60 * 86400000);
  const exp60Str = `${exp60.getUTCFullYear()}-${String(exp60.getUTCMonth()+1).padStart(2,'0')}`;

  const clinics = await getClinics(db);

  for (const clinicId of clinics) {
    const managers = await getManagers(db, clinicId);

    // Позиции ниже минимума (без уже существующего уведомления сегодня)
    const lowItems = await db.prepare(
      `SELECT id, name, stock, min_stock, unit FROM inventory_items
       WHERE clinic_id = ? AND is_active = 1 AND stock < min_stock
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.clinic_id = ? AND n.link = 'inv:'||inventory_items.id
             AND n.created_at > ?
         )`
    ).bind(clinicId, clinicId, now - 86400000).all();

    for (const item of (lowItems.results || [])) {
      for (const uid2 of managers) {
        await notify(db, clinicId, uid2, {
          icon: 'box',
          title: `Заканчивается: ${item.name}`,
          meta: `Остаток ${item.stock} ${item.unit} (минимум ${item.min_stock})`,
          link: `inv:${item.id}`,
        });
      }
    }

    // Истекают в 60 дней
    const expItems = await db.prepare(
      `SELECT id, name, expiry FROM inventory_items
       WHERE clinic_id = ? AND is_active = 1
         AND expiry IS NOT NULL AND expiry >= ? AND expiry <= ?
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.clinic_id = ? AND n.link = 'inv-exp:'||inventory_items.id
             AND n.created_at > ?
         )`
    ).bind(clinicId, todayStr, exp60Str, clinicId, now - 86400000).all();

    for (const item of (expItems.results || [])) {
      for (const uid2 of managers) {
        await notify(db, clinicId, uid2, {
          icon: 'alert',
          title: `Срок годности истекает: ${item.name}`,
          meta: `${item.expiry} — до 60 дней`,
          link: `inv:${item.id}`,
        });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ЗАДАЧА 4: Реактивация спящих (каждый понедельник)
// ═══════════════════════════════════════════════════════════════════════════════
export async function runReactivation(db) {
  const now = nowMs();
  const clinics = await getClinics(db);

  for (const clinicId of clinics) {
    const managers = await getManagers(db, clinicId);

    const sleeping = await db.prepare(
      `SELECT id, full_name, phone, last_visit FROM patients
       WHERE clinic_id = ? AND tag = 'sleeping'
       ORDER BY last_visit ASC LIMIT 20`
    ).bind(clinicId).all();

    const count = (sleeping.results || []).length;
    if (!count) continue;

    for (const uid2 of managers) {
      await notify(db, clinicId, uid2, {
        icon: 'bell',
        title: `Реактивация: ${count} спящих пациентов`,
        meta: `Не приходили 6+ месяцев. Рекомендуем позвонить.`,
        link: `patients:sleeping`,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ГЛАВНЫЙ ОБРАБОТЧИК scheduled()
// ═══════════════════════════════════════════════════════════════════════════════
export async function handleScheduled(event, env) {
  const cron = event.cron;
  const db   = env.DB;

  try {
    if (cron === '*/15 * * * *') {
      await runReminders(db);
    } else if (cron === '0 4 * * *') {
      await runSegments(db);
      await runInventoryCheck(db);
    } else if (cron === '0 4 * * 1') {
      await runReactivation(db);
    }
  } catch (e) {
    console.error(`[cron ${cron}] error:`, e);
  }
}
