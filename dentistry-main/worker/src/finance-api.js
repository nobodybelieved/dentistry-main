import { json, error } from './api-utils.js';

// GET /api/finance  — клиническая финансовая сводка
export async function getClinicFinance(req, env) {
  const clinicId = req.user.clinic_id;

  // Asia/Almaty = UTC+5
  const ALM = 5 * 3600000;
  const nowAlm = new Date(Date.now() + ALM);
  const year  = nowAlm.getUTCFullYear();
  const month = nowAlm.getUTCMonth(); // 0-indexed

  const mStr   = String(month + 1).padStart(2, '0');
  const lastDay = new Date(year, month + 1, 0).getDate();
  const monthStart = new Date(`${year}-${mStr}-01T00:00:00+05:00`).getTime();
  const monthEnd   = new Date(`${year}-${mStr}-${lastDay}T23:59:59+05:00`).getTime();

  const prevM    = month === 0 ? 12 : month;
  const prevY    = month === 0 ? year - 1 : year;
  const prevMStr = String(prevM).padStart(2, '0');
  const prevLastDay = new Date(prevY, prevM, 0).getDate();
  const prevMonthStart = new Date(`${prevY}-${prevMStr}-01T00:00:00+05:00`).getTime();
  const prevMonthEnd   = new Date(`${prevY}-${prevMStr}-${prevLastDay}T23:59:59+05:00`).getTime();

  // Рабочие дни месяца (пн–пт, упрощённо)
  const totalDays = lastDay;
  let workDaysTotal = 0;
  for (let d = 1; d <= totalDays; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow !== 0 && dow !== 6) workDaysTotal++;
  }
  const todayDay = nowAlm.getUTCDate();
  let workDaysDone = 0;
  for (let d = 1; d <= todayDay; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow !== 0 && dow !== 6) workDaysDone++;
  }

  const [
    revRow, revPrevRow,
    marginRow,
    debtRow, debtorRows,
    byCatRows,
    journalRows,
  ] = await Promise.all([

    // Выручка текущего месяца
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
       WHERE clinic_id=? AND kind='payment' AND status='paid'
         AND created_at>=? AND created_at<=?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    // Выручка прошлого месяца
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
       WHERE clinic_id=? AND kind='payment' AND status='paid'
         AND created_at>=? AND created_at<=?`
    ).bind(clinicId, prevMonthStart, prevMonthEnd).first(),

    // Маржинальность: (SUM price - SUM cost) / SUM price за текущий месяц
    env.DB.prepare(
      `SELECT COALESCE(SUM(a.price),0) AS revenue,
              COALESCE(SUM(pr.cost),0) AS cost
       FROM appointments a
       LEFT JOIN procedures pr ON pr.id = a.procedure_id
       WHERE a.clinic_id=? AND a.status='done'
         AND a.starts_at>=? AND a.starts_at<=?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    // Дебиторка: суммарный долг
    env.DB.prepare(
      `SELECT COALESCE(SUM(ABS(balance)),0) AS total, COUNT(*) AS cnt
       FROM patients WHERE clinic_id=? AND balance<0`
    ).bind(clinicId).first(),

    // Должники (список)
    env.DB.prepare(
      `SELECT p.id, p.full_name, p.phone, p.balance,
              MAX(a.starts_at) AS last_appt_ts
       FROM patients p
       LEFT JOIN appointments a ON a.patient_id=p.id AND a.status='done'
       WHERE p.clinic_id=? AND p.balance<0
       GROUP BY p.id
       ORDER BY p.balance ASC
       LIMIT 20`
    ).bind(clinicId).all(),

    // Структура выручки по категориям (из приёмов текущего месяца)
    env.DB.prepare(
      `SELECT pc.id, pc.name, pc.color,
              COALESCE(SUM(a.price),0) AS amount
       FROM appointments a
       JOIN procedures pr ON pr.id=a.procedure_id
       JOIN procedure_categories pc ON pc.id=pr.category_id
       WHERE a.clinic_id=? AND a.status='done'
         AND a.starts_at>=? AND a.starts_at<=?
       GROUP BY pc.id
       ORDER BY amount DESC`
    ).bind(clinicId, monthStart, monthEnd).all(),

    // Журнал транзакций (последние 40)
    env.DB.prepare(
      `SELECT t.id, t.kind, t.title, t.amount, t.method, t.status,
              t.tx_date, t.patient_id,
              p.full_name AS patient_name
       FROM transactions t
       LEFT JOIN patients p ON p.id=t.patient_id
       WHERE t.clinic_id=? AND t.status IN ('paid','pending','plan')
       ORDER BY t.tx_date DESC, t.created_at DESC
       LIMIT 40`
    ).bind(clinicId).all(),
  ]);

  const revenue  = revRow?.total  || 0;
  const revPrev  = revPrevRow?.total || 0;
  const revDelta = revPrev > 0
    ? Math.round(((revenue - revPrev) / revPrev) * 1000) / 10
    : null;

  const marginRevenue = marginRow?.revenue || 0;
  const marginCost    = marginRow?.cost    || 0;
  const marginPct = marginRevenue > 0
    ? Math.round(((marginRevenue - marginCost) / marginRevenue) * 100)
    : 0;

  const totalDebt   = debtRow?.total || 0;
  const debtorCount = debtRow?.cnt   || 0;

  const debtors = (debtorRows.results || []).map(r => ({
    id:        r.id,
    name:      r.full_name,
    phone:     r.phone || '',
    balance:   r.balance,
    lastVisit: r.last_appt_ts
      ? new Date(r.last_appt_ts + ALM).toISOString().slice(0, 10)
      : null,
  }));

  const catResults = byCatRows.results || [];
  const catTotal   = catResults.reduce((s, r) => s + r.amount, 0) || 1;
  const byCategory = catResults.map(r => ({
    id:     r.id,
    name:   r.name,
    color:  r.color || '#0F766E',
    amount: r.amount,
    pct:    Math.round((r.amount / catTotal) * 100),
  }));

  const journal = (journalRows.results || []).map(r => ({
    id:          r.id,
    date:        r.tx_date,
    title:       r.title || '',
    patientId:   r.patient_id || '',
    patientName: r.patient_name || '',
    kind:        r.kind,
    amount:      r.amount,
    method:      r.method || '',
    status:      r.status,
  }));

  return json({
    month:     `${year}-${mStr}`,
    workDays:  { done: workDaysDone, total: workDaysTotal },
    kpi: {
      revenue,
      revDelta,
      totalDebt,
      debtorCount,
      marginPct,
    },
    debtors,
    byCategory,
    journal,
  });
}

// POST /api/payments — принять оплату
export async function acceptPayment(req, env) {
  const body = await req.json().catch(() => ({}));
  const { patientId, amount, method, planId, visitId, title } = body;

  if (!patientId) return error('patientId required', 400);
  if (!amount || amount <= 0) return error('amount must be positive', 400);

  const clinicId = req.user.clinic_id;
  const ALM = 5 * 3600000;
  const now = Date.now();
  const today = new Date(now + ALM).toISOString().slice(0, 10);

  // Проверяем что пациент принадлежит клинике
  const patient = await env.DB.prepare(
    'SELECT id FROM patients WHERE id=? AND clinic_id=?'
  ).bind(patientId, clinicId).first();
  if (!patient) return error('Patient not found', 404);

  const paymentId = crypto.randomUUID();
  const txId      = crypto.randomUUID();
  const loyId     = crypto.randomUUID();
  const points    = Math.floor(amount / 10);
  const desc      = title || 'Оплата';

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payments
         (id,clinic_id,patient_id,plan_id,visit_id,amount,method,paid_at,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(paymentId, clinicId, patientId, planId||null, visitId||null,
           amount, method||null, today, req.user.sub, now),

    env.DB.prepare(
      `INSERT INTO transactions
         (id,clinic_id,patient_id,kind,title,amount,method,status,tx_date,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(txId, clinicId, patientId, 'payment', desc,
           amount, method||null, 'paid', today, now),

    env.DB.prepare(
      `UPDATE patients SET balance = balance + ? WHERE id = ? AND clinic_id = ?`
    ).bind(amount, patientId, clinicId),

    ...(points > 0 ? [
      env.DB.prepare(
        `INSERT INTO loyalty_transactions (id,patient_id,delta,reason,created_at)
         VALUES (?,?,?,?,?)`
      ).bind(loyId, patientId, points, desc, now),
    ] : []),
  ]);

  return json({ ok: true, paymentId, pointsEarned: points });
}
