import { json, error } from './api-utils.js';

// GET /api/procedures — прайс-лист клиники
export async function listProcedures(req, env) {
  const clinicId = req.user.clinic_id;
  const url = new URL(req.url);
  const categoryId = url.searchParams.get('category');

  let q = `SELECT pr.id, pr.name, pr.price, pr.duration_min, pr.cost, pr.is_active,
                   pr.category_id, pc.name AS cat_name, pc.color AS cat_color
            FROM procedures pr
            LEFT JOIN procedure_categories pc ON pc.id = pr.category_id
            WHERE pr.clinic_id = ? AND pr.is_active = 1`;
  const binds = [clinicId];
  if (categoryId) { q += ' AND pr.category_id = ?'; binds.push(categoryId); }
  q += ' ORDER BY pc.name, pr.name';

  const [rows, cats] = await Promise.all([
    env.DB.prepare(q).bind(...binds).all(),
    env.DB.prepare(
      'SELECT id, name, color FROM procedure_categories ORDER BY name'
    ).all(),
  ]);

  const procedures = (rows.results || []).map(r => ({
    id:          r.id,
    name:        r.name,
    price:       r.price,
    durationMin: r.duration_min,
    cost:        r.cost || 0,
    categoryId:  r.category_id,
    catName:     r.cat_name || '',
    catColor:    r.cat_color || '#0F766E',
    marginPct:   r.price > 0 ? Math.round(((r.price - (r.cost || 0)) / r.price) * 100) : 0,
  }));

  return json({
    procedures,
    categories: cats.results || [],
  });
}

// POST /api/procedures — создать процедуру
export async function createProcedure(req, env) {
  const clinicId = req.user.clinic_id;
  const body = await req.json().catch(() => ({}));
  const { name, price, categoryId, durationMin = 30, cost = 0 } = body;

  if (!name) return error('name required', 400);
  if (!price || price <= 0) return error('price must be positive', 400);

  const id  = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO procedures (id,clinic_id,category_id,name,price,duration_min,cost,is_active,created_at)
     VALUES (?,?,?,?,?,?,?,1,?)`
  ).bind(id, clinicId, categoryId || null, name, price, durationMin, cost, now).run();

  return json({ ok: true, id });
}

// PATCH /api/procedures/:id — обновить цену / название / длительность
export async function patchProcedure(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const proc = await env.DB.prepare(
    'SELECT id FROM procedures WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!proc) return error('Procedure not found', 404);

  const body = await req.json().catch(() => ({}));
  const sets = []; const binds = [];

  if (body.name !== undefined)        { sets.push('name=?');         binds.push(body.name); }
  if (body.price !== undefined)       { sets.push('price=?');        binds.push(body.price); }
  if (body.durationMin !== undefined) { sets.push('duration_min=?'); binds.push(body.durationMin); }
  if (body.cost !== undefined)        { sets.push('cost=?');         binds.push(body.cost); }
  if (body.categoryId !== undefined)  { sets.push('category_id=?');  binds.push(body.categoryId); }
  if (body.isActive !== undefined)    { sets.push('is_active=?');    binds.push(body.isActive ? 1 : 0); }

  if (!sets.length) return error('Nothing to update', 400);

  await env.DB.prepare(
    `UPDATE procedures SET ${sets.join(',')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds, id, clinicId).run();

  return json({ ok: true });
}
