import { json, error, uid, now } from './api-utils.js';

// GET /api/schedule?date=2026-06-17&doctor_id=
export async function getSchedule(req, env) {
  const url      = new URL(req.url);
  const date     = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const doctorId = url.searchParams.get('doctor_id') || '';
  const clinicId = req.user.clinic_id;

  // Дата-диапазон: весь день по Asia/Almaty (UTC+5)
  const dayStart = new Date(`${date}T00:00:00+05:00`).getTime();
  const dayEnd   = new Date(`${date}T23:59:59+05:00`).getTime();

  let where = 'WHERE a.clinic_id = ? AND a.starts_at BETWEEN ? AND ?';
  const binds = [clinicId, dayStart, dayEnd];
  if (doctorId) { where += ' AND a.doctor_id = ?'; binds.push(doctorId); }

  const [appointments, doctors] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.patient_id, a.doctor_id, a.chair_id, a.procedure_id,
              a.starts_at, a.duration_min, a.status, a.price, a.risk_score,
              a.source, a.note,
              p.full_name AS patient_name, p.phone AS patient_phone, p.medical_note,
              u.full_name AS doctor_name, u.color AS doctor_color, u.initials AS doctor_initials,
              pr.name AS procedure_name, pr.category_id
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.doctor_id
       LEFT JOIN procedures pr ON pr.id = a.procedure_id
       ${where}
       ORDER BY a.starts_at`
    ).bind(...binds).all(),

    env.DB.prepare(
      `SELECT id, full_name, initials, color, specialty
       FROM users
       WHERE clinic_id = ? AND role IN ('doctor','hygienist') AND is_active = 1
       ORDER BY full_name`
    ).bind(clinicId).all(),
  ]);

  return json({
    date,
    doctors: doctors.results.map(d => ({
      id: d.id, fullName: d.full_name, initials: d.initials,
      color: d.color, specialty: d.specialty,
    })),
    appointments: appointments.results.map(mapAppt),
  });
}

// GET /api/appointments/:id
export async function getAppointment(req, env, _ctx, { id }) {
  const a = await env.DB.prepare(
    `SELECT a.*, p.full_name AS patient_name, p.phone AS patient_phone, p.medical_note,
            u.full_name AS doctor_name, u.color AS doctor_color, u.initials AS doctor_initials,
            pr.name AS procedure_name, pr.category_id,
            c.name AS chair_name
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN users u ON u.id = a.doctor_id
     LEFT JOIN procedures pr ON pr.id = a.procedure_id
     LEFT JOIN chairs c ON c.id = a.chair_id
     WHERE a.id = ? AND a.clinic_id = ?`
  ).bind(id, req.user.clinic_id).first();

  if (!a) return error('Appointment not found', 404);
  return json(mapApptFull(a));
}

// POST /api/appointments
export async function createAppointment(req, env) {
  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const { patientId, doctorId, procedureId, chairId, startsAt, durationMin, note, source } = body;
  if (!patientId || !doctorId || !startsAt) return error('patientId, doctorId, startsAt are required');

  // Проверить что пациент и врач в этой клинике
  const [patient, doctor, procedure] = await Promise.all([
    env.DB.prepare('SELECT id FROM patients WHERE id = ? AND clinic_id = ?').bind(patientId, req.user.clinic_id).first(),
    env.DB.prepare('SELECT id FROM users WHERE id = ? AND clinic_id = ?').bind(doctorId, req.user.clinic_id).first(),
    procedureId ? env.DB.prepare('SELECT id, price FROM procedures WHERE id = ?').bind(procedureId).first() : Promise.resolve(null),
  ]);

  if (!patient) return error('Patient not found', 404);
  if (!doctor) return error('Doctor not found', 404);

  const id = uid();
  const ts = now();

  await env.DB.prepare(
    `INSERT INTO appointments (id, clinic_id, patient_id, doctor_id, chair_id, procedure_id,
      starts_at, duration_min, status, price, source, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, req.user.clinic_id, patientId, doctorId,
    chairId || null, procedureId || null,
    startsAt, durationMin || 30,
    procedure?.price ?? null,
    source || 'reception',
    note || null,
    req.user.sub, ts, ts
  ).run();

  // Пушнуть real-time
  await broadcastClinic(env, req.user.clinic_id, { type: 'appointment_created', id });

  return json({ id }, 201);
}

// PATCH /api/appointments/:id
export async function updateAppointment(req, env, _ctx, { id }) {
  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const VALID_STATUSES = ['pending','confirmed','inchair','done','noshow','cancelled'];
  const allowed = ['status','chair_id','note','starts_at','duration_min','doctor_id','procedure_id','price'];
  const sets = [];
  const binds = [];

  for (const [k, v] of Object.entries(body)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (!allowed.includes(col)) continue;
    if (col === 'status' && !VALID_STATUSES.includes(v)) return error('Invalid status');
    sets.push(`${col} = ?`);
    binds.push(v);
  }
  if (!sets.length) return error('Nothing to update');

  sets.push('updated_at = ?');
  binds.push(now(), id, req.user.clinic_id);

  const result = await env.DB.prepare(
    `UPDATE appointments SET ${sets.join(', ')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds).run();

  if (result.meta.changes === 0) return error('Appointment not found', 404);

  await broadcastClinic(env, req.user.clinic_id, { type: 'appointment_updated', id, ...body });

  return json({ ok: true });
}

// DELETE /api/appointments/:id
export async function deleteAppointment(req, env, _ctx, { id }) {
  const result = await env.DB.prepare(
    'DELETE FROM appointments WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).run();

  if (result.meta.changes === 0) return error('Appointment not found', 404);

  await broadcastClinic(env, req.user.clinic_id, { type: 'appointment_deleted', id });
  return json({ ok: true });
}

// GET /api/slots?doctor_id=&date=   (свободные слоты, для виджета и новой записи)
export async function getSlots(req, env) {
  const url      = new URL(req.url);
  const doctorId = url.searchParams.get('doctor_id');
  const date     = url.searchParams.get('date');
  if (!doctorId || !date) return error('doctor_id and date are required');

  const dayStart = new Date(`${date}T09:00:00+05:00`).getTime();
  const dayEnd   = new Date(`${date}T20:00:00+05:00`).getTime();

  const booked = await env.DB.prepare(
    `SELECT starts_at, duration_min FROM appointments
     WHERE doctor_id = ? AND starts_at BETWEEN ? AND ?
     AND status NOT IN ('cancelled','noshow')
     ORDER BY starts_at`
  ).bind(doctorId, dayStart, dayEnd).all();

  const slots = [];
  const slotMin = 30;
  let cursor = dayStart;

  while (cursor + slotMin * 60_000 <= dayEnd) {
    const end = cursor + slotMin * 60_000;
    const busy = booked.results.some(b =>
      cursor < b.starts_at + b.duration_min * 60_000 && end > b.starts_at
    );
    if (!busy) slots.push(cursor);
    cursor += slotMin * 60_000;
  }

  return json({ date, doctorId, slots });
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

async function broadcastClinic(env, clinicId, msg) {
  try {
    const doId = env.CLINIC_ROOM.idFromName(clinicId);
    const stub = env.CLINIC_ROOM.get(doId);
    await stub.fetch('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(msg),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch { /* DO может не быть активен — не критично */ }
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapAppt(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    doctorId: r.doctor_id,
    startsAt: r.starts_at,
    durationMin: r.duration_min,
    status: r.status,
    price: r.price,
    riskScore: r.risk_score,
    note: r.note,
    patientName: r.patient_name,
    patientPhone: r.patient_phone,
    medicalNote: r.medical_note,
    doctorName: r.doctor_name,
    doctorColor: r.doctor_color,
    doctorInitials: r.doctor_initials,
    procedureName: r.procedure_name,
    categoryId: r.category_id,
  };
}

function mapApptFull(r) {
  return {
    ...mapAppt(r),
    chairId: r.chair_id,
    chairName: r.chair_name,
    source: r.source,
    procedureId: r.procedure_id,
  };
}
