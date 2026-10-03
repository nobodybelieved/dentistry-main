import { json } from './api-utils.js';

// GET /api/analytics  — бизнес-аналитика клиники
export async function getAnalytics(req, env) {
  const clinicId = req.user.clinic_id;

  // Asia/Almaty = UTC+5
  const ALM = 5 * 3600000;
  const nowAlm  = new Date(Date.now() + ALM);
  const year    = nowAlm.getUTCFullYear();
  const month   = nowAlm.getUTCMonth(); // 0-indexed
  const mStr    = String(month + 1).padStart(2, '0');
  const monthStart = new Date(`${year}-${mStr}-01T00:00:00+05:00`).getTime();
  const monthEnd   = new Date(`${year}-${mStr}-${new Date(year, month + 1, 0).getDate()}T23:59:59+05:00`).getTime();

  // 6 месяцев назад для трендов
  const sixMonthsAgo = new Date(year, month - 5, 1);
  const sixMStr = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;

  // 12 месяцев назад для retention
  const twelveMonthsAgo = new Date(Date.now() + ALM - 365 * 86400000);
  const twelveAgoTs = twelveMonthsAgo.getTime() - ALM;

  const [
    ltvRow,
    npsRow, npsRecentRows,
    retentionRow,
    sourceRows,
    doctorRows,
    revenueMonthRows,
    newPatientMonthRows,
  ] = await Promise.all([

    // LTV = суммарные платежи / кол-во уникальных пациентов с платежами
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COUNT(DISTINCT patient_id) AS pat_count
       FROM transactions
       WHERE clinic_id = ? AND kind = 'payment' AND status = 'paid'`
    ).bind(clinicId).first(),

    // NPS — средний балл и количество ответов
    env.DB.prepare(
      `SELECT COALESCE(AVG(score), 0) AS avg_score,
              COUNT(*) AS cnt
       FROM nps_responses WHERE clinic_id = ?`
    ).bind(clinicId).first(),

    // Последние NPS с именем пациента
    env.DB.prepare(
      `SELECT n.score, n.comment, n.created_at,
              p.full_name AS patient_name
       FROM nps_responses n
       LEFT JOIN patients p ON p.id = n.patient_id
       WHERE n.clinic_id = ?
       ORDER BY n.created_at DESC
       LIMIT 5`
    ).bind(clinicId).all(),

    // Retention = пациенты с 2+ завершёнными визитами / все пациенты
    env.DB.prepare(
      `SELECT COUNT(DISTINCT patient_id) AS returning_patients,
              (SELECT COUNT(*) FROM patients WHERE clinic_id = ? AND tag != 'inactive') AS total_patients
       FROM (
         SELECT patient_id, COUNT(*) AS visit_count
         FROM appointments
         WHERE clinic_id = ? AND status = 'done'
         GROUP BY patient_id
         HAVING visit_count >= 2
       )`
    ).bind(clinicId, clinicId).first(),

    // Источники пациентов
    env.DB.prepare(
      `SELECT COALESCE(source, 'Не указан') AS source,
              COUNT(*) AS cnt
       FROM patients
       WHERE clinic_id = ?
       GROUP BY source
       ORDER BY cnt DESC`
    ).bind(clinicId).all(),

    // Производительность врачей в текущем месяце (завершённые приёмы)
    env.DB.prepare(
      `SELECT u.id, u.full_name AS name, u.initials, u.color, u.specialty,
              COUNT(a.id) AS appts_month,
              COALESCE(SUM(a.price), 0) AS rev_month,
              COALESCE(AVG(a.price), 0) AS avg_check
       FROM appointments a
       JOIN users u ON u.id = a.doctor_id
       WHERE a.clinic_id = ? AND a.status = 'done'
         AND a.starts_at >= ? AND a.starts_at <= ?
       GROUP BY u.id
       ORDER BY rev_month DESC`
    ).bind(clinicId, monthStart, monthEnd).all(),

    // Выручка по месяцам (последние 6)
    env.DB.prepare(
      `SELECT substr(tx_date, 1, 7) AS month,
              SUM(amount) AS revenue
       FROM transactions
       WHERE clinic_id = ? AND kind = 'payment' AND status = 'paid'
         AND tx_date >= ?
       GROUP BY month
       ORDER BY month`
    ).bind(clinicId, sixMStr).all(),

    // Новые пациенты по месяцам (последние 6)
    env.DB.prepare(
      `SELECT substr(datetime(created_at/1000, 'unixepoch'), 1, 7) AS month,
              COUNT(*) AS cnt
       FROM patients
       WHERE clinic_id = ?
         AND created_at >= ?
       GROUP BY month
       ORDER BY month`
    ).bind(clinicId, new Date(sixMonthsAgo).getTime()).all(),
  ]);

  // LTV
  const totalRevenue = ltvRow?.total || 0;
  const patWithPayments = ltvRow?.pat_count || 1;
  const ltv = Math.round(totalRevenue / patWithPayments);

  // NPS
  const avgNps = Math.round((npsRow?.avg_score || 0) * 10) / 10;
  const npsCount = npsRow?.cnt || 0;
  const npsRecent = (npsRecentRows.results || []).map(r => ({
    score:       r.score,
    comment:     r.comment || '',
    patientName: r.patient_name || 'Аноним',
    createdAt:   r.created_at,
  }));

  // Retention
  const returningPat = retentionRow?.returning_patients || 0;
  const totalPat     = retentionRow?.total_patients || 1;
  const retentionPct = Math.round((returningPat / totalPat) * 100);

  // Источники — добавляем % и красивый label
  const SOURCE_LABEL = {
    Instagram:'Instagram', Рекомендация:'Рекомендации', Сайт:'Сайт', Реклама:'Реклама',
    '2GIS':'2GIS', Семья:'Семья/Знакомые', Google:'Google', TikTok:'TikTok',
    widget:'Виджет', phone:'Телефон', reception:'Рецепция',
  };
  const SOURCE_COLOR = {
    Instagram:'#E1306C', Рекомендация:'#0F766E', Сайт:'#7C3AED', Реклама:'#0891B2',
    '2GIS':'#0084FF', Семья:'#059669', Google:'#4285F4', TikTok:'#000000',
    widget:'#D97706', phone:'#64748B', reception:'#94A3B8',
  };
  const sourceAll = sourceRows.results || [];
  const sourceTotal = sourceAll.reduce((s, r) => s + r.cnt, 0) || 1;
  const sources = sourceAll.map(r => ({
    source: r.source,
    label:  SOURCE_LABEL[r.source] || r.source,
    color:  SOURCE_COLOR[r.source] || '#64748B',
    count:  r.cnt,
    pct:    Math.round((r.cnt / sourceTotal) * 100),
  }));

  // Врачи
  const doctors = (doctorRows.results || []).map(r => ({
    id:         r.id,
    name:       r.name,
    initials:   r.initials || '??',
    color:      r.color || '#0F766E',
    specialty:  r.specialty || '',
    apptsMonth: r.appts_month,
    revMonth:   r.rev_month,
    avgCheck:   Math.round(r.avg_check),
  }));

  // Выручка по месяцам — заполняем пустые месяцы нулями
  const revMap = {};
  for (const r of (revenueMonthRows.results || [])) revMap[r.month] = r.revenue;
  const newPatMap = {};
  for (const r of (newPatientMonthRows.results || [])) newPatMap[r.month] = r.cnt;

  const revenueByMonth = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(year, month - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    revenueByMonth.push({
      month:      key,
      revenue:    revMap[key] || 0,
      newPatients: newPatMap[key] || 0,
    });
  }

  return json({
    kpi: { ltv, avgNps, npsCount, retentionPct, totalPatients: totalPat },
    sources,
    doctors,
    revenueByMonth,
    npsRecent,
  });
}
