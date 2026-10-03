import { json } from './api-utils.js';

// GET /api/dashboard
export async function getDashboard(req, env) {
  const clinicId = req.user.clinic_id;

  // Asia/Almaty = UTC+5
  const ALM = 5 * 3600000;
  const nowAlm = new Date(Date.now() + ALM);
  const year  = nowAlm.getUTCFullYear();
  const month = nowAlm.getUTCMonth(); // 0-indexed
  const todayStr = nowAlm.toISOString().slice(0, 10);

  // Month start/end in ms (Almaty midnight)
  const mStr  = String(month + 1).padStart(2, '0');
  const monthStart = new Date(`${year}-${mStr}-01T00:00:00+05:00`).getTime();
  const lastDay    = new Date(year, month + 1, 0).getDate();
  const monthEnd   = new Date(`${year}-${mStr}-${lastDay}T23:59:59+05:00`).getTime();

  // Previous month
  const prevM   = month === 0 ? 12 : month;
  const prevY   = month === 0 ? year - 1 : year;
  const prevMStr = String(prevM).padStart(2, '0');
  const prevLastDay = new Date(prevY, prevM, 0).getDate();
  const prevMonthStart = new Date(`${prevY}-${prevMStr}-01T00:00:00+05:00`).getTime();
  const prevMonthEnd   = new Date(`${prevY}-${prevMStr}-${prevLastDay}T23:59:59+05:00`).getTime();

  // Today start/end in ms
  const todayStart = new Date(`${todayStr}T00:00:00+05:00`).getTime();
  const todayEnd   = new Date(`${todayStr}T23:59:59+05:00`).getTime();

  // 14 days ago date string (Almaty)
  const day14AgoStr = new Date(todayStart - 13 * 86400000 + ALM).toISOString().slice(0, 10);

  const [
    revRow, revPrevRow,
    avgCheckRow,
    newPatientsRow, newPatientsPrevRow,
    chairsRow, todayApptRow,
    inClinicRows,
    topDocRows,
    revDayRows,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
       WHERE clinic_id=? AND kind='payment' AND status='paid'
         AND created_at>=? AND created_at<=?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    env.DB.prepare(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
       WHERE clinic_id=? AND kind='payment' AND status='paid'
         AND created_at>=? AND created_at<=?`
    ).bind(clinicId, prevMonthStart, prevMonthEnd).first(),

    env.DB.prepare(
      `SELECT COALESCE(AVG(price),0) AS avg FROM appointments
       WHERE clinic_id=? AND status='done' AND starts_at>=? AND starts_at<=?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM patients
       WHERE clinic_id=? AND created_at>=? AND created_at<=?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM patients
       WHERE clinic_id=? AND created_at>=? AND created_at<=?`
    ).bind(clinicId, prevMonthStart, prevMonthEnd).first(),

    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM chairs WHERE clinic_id=? AND is_active=1`
    ).bind(clinicId).first(),

    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM appointments
       WHERE clinic_id=? AND starts_at BETWEEN ? AND ?
         AND status NOT IN ('cancelled','noshow')`
    ).bind(clinicId, todayStart, todayEnd).first(),

    env.DB.prepare(
      `SELECT a.id, p.full_name AS patient_name,
              u.full_name AS doctor_name, u.color, u.initials,
              pr.name AS proc_name, a.starts_at,
              c.name AS chair_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.doctor_id
       LEFT JOIN procedures pr ON pr.id = a.procedure_id
       LEFT JOIN chairs c ON c.id = a.chair_id
       WHERE a.clinic_id=? AND a.status='inchair'
         AND a.starts_at BETWEEN ? AND ?
       ORDER BY a.starts_at`
    ).bind(clinicId, todayStart, todayEnd).all(),

    env.DB.prepare(
      `SELECT u.id, u.full_name AS name, u.specialty, u.color, u.initials,
              COALESCE(SUM(a.price),0) AS rev, COUNT(a.id) AS appts
       FROM appointments a
       JOIN users u ON u.id = a.doctor_id
       WHERE a.clinic_id=? AND a.status='done'
         AND a.starts_at>=? AND a.starts_at<=?
       GROUP BY u.id ORDER BY rev DESC LIMIT 5`
    ).bind(clinicId, monthStart, monthEnd).all(),

    env.DB.prepare(
      `SELECT tx_date AS date, SUM(amount) AS amount
       FROM transactions
       WHERE clinic_id=? AND kind='payment' AND status='paid' AND tx_date>=?
       GROUP BY tx_date ORDER BY tx_date`
    ).bind(clinicId, day14AgoStr).all(),
  ]);

  const revenueMonth = revRow?.total || 0;
  const revenuePrev  = revPrevRow?.total || 0;
  const revDelta = revenuePrev > 0
    ? Math.round(((revenueMonth - revenuePrev) / revenuePrev) * 1000) / 10
    : null;

  const chairCount   = chairsRow?.cnt || 6;
  const todayCount   = todayApptRow?.cnt || 0;
  const chairLoadPct = Math.min(Math.round((todayCount / (chairCount * 10)) * 100), 99);

  const newPatientsMonth = newPatientsRow?.cnt || 0;
  const newPatientsPrev  = newPatientsPrevRow?.cnt || 0;
  const newPatientsDelta = newPatientsMonth - newPatientsPrev;

  // Build 14-day revenue series
  const revMap = {};
  for (const r of (revDayRows.results || [])) revMap[r.date] = r.amount;
  const revenueByDay = [];
  for (let i = 13; i >= 0; i--) {
    const ts = todayStart - i * 86400000;
    const ds = new Date(ts + ALM).toISOString().slice(0, 10);
    revenueByDay.push({ date: ds, amount: revMap[ds] || 0 });
  }

  return json({
    kpi: {
      revenueMonth,
      revDelta,
      avgCheck: Math.round(avgCheckRow?.avg || 0),
      chairLoadPct,
      todayCount,
      newPatientsMonth,
      newPatientsDelta,
    },
    inClinic: (inClinicRows.results || []).map(r => ({
      patientName: r.patient_name,
      doctorName:  r.doctor_name,
      procName:    r.proc_name || 'Процедура',
      color:       r.color || '#0F766E',
      initials:    r.initials || '??',
      startsAt:    r.starts_at,
      chairName:   r.chair_name || '',
    })),
    topDoctors: (topDocRows.results || []).map(r => ({
      id:        r.id,
      name:      r.name,
      specialty: r.specialty || '',
      color:     r.color || '#0F766E',
      initials:  r.initials || '',
      revMonth:  r.rev,
      appts:     r.appts,
    })),
    revenueByDay,
  });
}
