import { json, error, uid, now, today } from './api-utils.js';

// GET /api/patients?tag=&q=&page=&limit=
export async function listPatients(req, env) {
  const url    = new URL(req.url);
  const tag    = url.searchParams.get('tag') || '';
  const q      = url.searchParams.get('q') || '';
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit  = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));
  const offset = (page - 1) * limit;
  const clinicId = req.user.clinic_id;

  let where = 'WHERE p.clinic_id = ?';
  const binds = [clinicId];

  if (tag) { where += ' AND p.tag = ?'; binds.push(tag); }
  if (q) {
    where += ' AND (p.full_name LIKE ? OR p.phone LIKE ?)';
    binds.push(`%${q}%`, `%${q}%`);
  }

  const [rows, counts, total] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.full_name, p.phone, p.tag, p.balance, p.visits_count,
              p.last_visit, p.source, p.risk_score, p.medical_note,
              u.full_name AS doctor_name, u.color AS doctor_color, u.initials AS doctor_initials
       FROM patients p
       LEFT JOIN users u ON u.id = p.lead_doctor_id
       ${where}
       ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),

    env.DB.prepare(
      `SELECT tag, COUNT(*) AS cnt FROM patients WHERE clinic_id = ? GROUP BY tag`
    ).bind(clinicId).all(),

    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM patients p ${where}`
    ).bind(...binds).first(),
  ]);

  const tagCounts = {};
  for (const r of counts.results) tagCounts[r.tag] = r.cnt;

  return json({
    patients: rows.results.map(mapPatientRow),
    tagCounts,
    total: total?.cnt ?? 0,
    page,
    limit,
  });
}

// GET /api/patients/:id
export async function getPatient(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    `SELECT p.*, u.full_name AS doctor_name, u.color AS doctor_color, u.initials AS doctor_initials
     FROM patients p
     LEFT JOIN users u ON u.id = p.lead_doctor_id
     WHERE p.id = ? AND p.clinic_id = ?`
  ).bind(id, req.user.clinic_id).first();

  if (!p) return error('Patient not found', 404);

  const [loyalty, family, nextAppt] = await Promise.all([
    env.DB.prepare(
      `SELECT la.points, la.tier FROM loyalty_accounts la WHERE la.patient_id = ?`
    ).bind(id).first(),

    env.DB.prepare(
      `SELECT pf.relative_id, pf.relation, pt.full_name
       FROM patient_family pf
       JOIN patients pt ON pt.id = pf.relative_id
       WHERE pf.patient_id = ?`
    ).bind(id).all(),

    env.DB.prepare(
      `SELECT a.id, a.starts_at, a.duration_min, a.status, a.price,
              u.full_name AS doctor_name, pr.name AS procedure_name
       FROM appointments a
       LEFT JOIN users u ON u.id = a.doctor_id
       LEFT JOIN procedures pr ON pr.id = a.procedure_id
       WHERE a.patient_id = ? AND a.starts_at > ? AND a.status NOT IN ('cancelled','noshow')
       ORDER BY a.starts_at LIMIT 1`
    ).bind(id, Date.now()).first(),
  ]);

  return json({
    ...mapPatientFull(p),
    loyalty: loyalty ?? null,
    family: family.results,
    nextAppointment: nextAppt ? mapAppt(nextAppt) : null,
  });
}

// POST /api/patients
export async function createPatient(req, env) {
  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const { fullName, phone, birthDate, gender, source, leadDoctorId, medicalNote } = body;
  if (!fullName || !phone) return error('fullName and phone are required');

  const id = uid();
  const ts = now();

  await env.DB.prepare(
    `INSERT INTO patients (id, clinic_id, full_name, phone, birth_date, gender, source,
      lead_doctor_id, medical_note, tag, balance, visits_count, registered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, 0, ?, ?, ?)`
  ).bind(id, req.user.clinic_id, fullName.trim(), phone.trim(),
    birthDate || null, gender || null, source || null,
    leadDoctorId || null, medicalNote || null,
    today(), ts, ts
  ).run();

  return json({ id }, 201);
}

// DELETE /api/patients/:id
export async function deletePatient(req, env, _ctx, { id }) {
  const row = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!row) return error('Patient not found', 404);

  await env.DB.prepare(
    'DELETE FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).run();

  return json({ ok: true });
}

// PATCH /api/patients/:id
export async function updatePatient(req, env, _ctx, { id }) {
  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const allowed = ['full_name','phone','email','birth_date','gender','source',
    'lead_doctor_id','medical_note','marketing_opt_in','language','preferred_payment'];
  const sets = [];
  const binds = [];

  for (const [k, v] of Object.entries(body)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowed.includes(col)) { sets.push(`${col} = ?`); binds.push(v); }
  }
  if (!sets.length) return error('Nothing to update');

  sets.push('updated_at = ?');
  binds.push(now(), id, req.user.clinic_id);

  await env.DB.prepare(
    `UPDATE patients SET ${sets.join(', ')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds).run();

  return json({ ok: true });
}

// GET /api/patients/:id/timeline
export async function getTimeline(req, env, _ctx, { id }) {
  const url   = new URL(req.url);
  const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));

  const rows = await env.DB.prepare(
    `SELECT al.id, al.type, al.icon, al.title, al.description, al.meta, al.event_at,
            u.full_name AS actor_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.actor_id
     WHERE al.patient_id = ? AND al.clinic_id = ?
     ORDER BY al.event_at DESC
     LIMIT ?`
  ).bind(id, req.user.clinic_id, limit).all();

  return json({ events: rows.results.map(mapEvent) });
}

// GET /api/patients/:id/loyalty
export async function getLoyalty(req, env, _ctx, { id }) {
  const [account, txs, tiers] = await Promise.all([
    env.DB.prepare('SELECT points, tier, updated_at FROM loyalty_accounts WHERE patient_id = ?').bind(id).first(),
    env.DB.prepare('SELECT id, delta, reason, created_at FROM loyalty_transactions WHERE patient_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all(),
    env.DB.prepare('SELECT id, name, min_points, perks FROM loyalty_tiers WHERE clinic_id = ? ORDER BY min_points').bind(req.user.clinic_id).all(),
  ]);
  return json({ account: account ?? null, transactions: txs.results, tiers: tiers.results });
}

// GET /api/patients/:id/family
export async function getFamily(req, env, _ctx, { id }) {
  const rows = await env.DB.prepare(
    `SELECT pf.relative_id AS id, pf.relation, pt.full_name, pt.phone, pt.tag
     FROM patient_family pf
     JOIN patients pt ON pt.id = pf.relative_id
     WHERE pf.patient_id = ?`
  ).bind(id).all();
  return json({ family: rows.results });
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapPatientRow(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    tag: r.tag,
    balance: r.balance,
    visitsCount: r.visits_count,
    lastVisit: r.last_visit,
    source: r.source,
    riskScore: r.risk_score,
    medicalNote: r.medical_note,
    doctor: r.doctor_name ? { name: r.doctor_name, color: r.doctor_color, initials: r.doctor_initials } : null,
  };
}

function mapPatientFull(r) {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    birthDate: r.birth_date,
    gender: r.gender,
    tag: r.tag,
    balance: r.balance,
    visitsCount: r.visits_count,
    lastVisit: r.last_visit,
    source: r.source,
    riskScore: r.risk_score,
    medicalNote: r.medical_note,
    marketingOptIn: !!r.marketing_opt_in,
    language: r.language,
    preferredPayment: r.preferred_payment,
    registeredAt: r.registered_at,
    doctor: r.doctor_name ? { name: r.doctor_name, color: r.doctor_color, initials: r.doctor_initials } : null,
  };
}

function mapAppt(r) {
  return {
    id: r.id,
    startsAt: r.starts_at,
    durationMin: r.duration_min,
    status: r.status,
    price: r.price,
    doctorName: r.doctor_name,
    procedureName: r.procedure_name,
  };
}

function mapEvent(r) {
  return {
    id: r.id,
    type: r.type,
    icon: r.icon,
    title: r.title,
    description: r.description,
    meta: r.meta ? JSON.parse(r.meta) : null,
    eventAt: r.event_at,
    actorName: r.actor_name,
  };
}
