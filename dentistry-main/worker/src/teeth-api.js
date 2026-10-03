import { json, error } from './api-utils.js';

// GET /api/patients/:id/teeth  — формула + история по всем зубам одним запросом
export async function getTeeth(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const [teethRows, histRows] = await Promise.all([
    env.DB.prepare(
      'SELECT tooth_num, state, surfaces FROM teeth WHERE patient_id = ? ORDER BY tooth_num'
    ).bind(id).all(),

    env.DB.prepare(
      'SELECT tooth_num, event_date, text FROM tooth_history WHERE patient_id = ? ORDER BY tooth_num, event_date DESC'
    ).bind(id).all(),
  ]);

  const teeth = {};
  for (const r of teethRows.results) {
    teeth[r.tooth_num] = {
      state: r.state || 'healthy',
      seg: r.surfaces ? JSON.parse(r.surfaces) : null,
    };
  }

  const history = {};
  for (const r of histRows.results) {
    const key = r.tooth_num;
    if (!history[key]) history[key] = [];
    history[key].push({ d: r.event_date, t: r.text });
  }

  return json({ teeth, history });
}

// PUT /api/patients/:id/teeth/:num  — сохранить состояние зуба
export async function updateTooth(req, env, _ctx, { id, num }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const { state, surfaces } = body;

  await env.DB.prepare(
    `INSERT INTO teeth (id, patient_id, tooth_num, state, surfaces, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(patient_id, tooth_num) DO UPDATE SET
       state      = excluded.state,
       surfaces   = excluded.surfaces,
       updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), id, parseInt(num),
    state || 'healthy',
    surfaces ? JSON.stringify(surfaces) : null,
    Date.now()
  ).run();

  return json({ ok: true });
}
