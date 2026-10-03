import { json, error, uid, now } from './api-utils.js';

// GET /api/inventory  — список позиций склада + KPI сводка
export async function listInventory(req, env) {
  const clinicId = req.user.clinic_id;

  // Asia/Almaty = UTC+5
  const ALM = 5 * 3600000;
  const nowAlm = new Date(Date.now() + ALM);
  const year  = nowAlm.getUTCFullYear();
  const month = nowAlm.getUTCMonth();
  const mStr  = String(month + 1).padStart(2, '0');
  const monthStart = new Date(`${year}-${mStr}-01T00:00:00+05:00`).getTime();
  const monthEnd   = new Date(`${year}-${mStr}-${new Date(year, month + 1, 0).getDate()}T23:59:59+05:00`).getTime();

  // Expiry threshold: today + 60 days → 'YYYY-MM'
  const exp60 = new Date(Date.now() + ALM + 60 * 86400000);
  const exp60Str = `${exp60.getUTCFullYear()}-${String(exp60.getUTCMonth() + 1).padStart(2, '0')}`;
  const todayStr  = nowAlm.toISOString().slice(0, 7); // 'YYYY-MM'

  const [itemRows, writeoffRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, category, stock, min_stock, unit, expiry, cost, supplier, is_active, updated_at
       FROM inventory_items
       WHERE clinic_id = ? AND is_active = 1
       ORDER BY category, name`
    ).bind(clinicId).all(),

    // Списано за текущий месяц (из движений)
    env.DB.prepare(
      `SELECT COALESCE(SUM(im.qty * ii.cost), 0) AS total
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       WHERE ii.clinic_id = ? AND im.kind = 'out'
         AND im.created_at >= ? AND im.created_at <= ?`
    ).bind(clinicId, monthStart, monthEnd).first(),
  ]);

  const items = (itemRows.results || []).map(r => ({
    id:       r.id,
    name:     r.name,
    category: r.category || 'Прочее',
    stock:    r.stock,
    minStock: r.min_stock,
    unit:     r.unit || 'шт',
    expiry:   r.expiry || null,
    cost:     r.cost,
    supplier: r.supplier || '',
    isLow:    r.stock < r.min_stock,
    isExpiringSoon: r.expiry && r.expiry >= todayStr && r.expiry <= exp60Str,
    isExpired:      r.expiry ? r.expiry < todayStr : false,
  }));

  const totalValue    = items.reduce((s, i) => s + i.stock * i.cost, 0);
  const lowCount      = items.filter(i => i.isLow).length;
  const expiringCount = items.filter(i => i.isExpiringSoon).length;
  const expiredCount  = items.filter(i => i.isExpired).length;
  const writeoffMonth = writeoffRow?.total || 0;

  return json({
    items,
    kpi: { totalValue, lowCount, expiringCount, expiredCount, writeoffMonth },
  });
}

// PATCH /api/inventory/:id  — обновить позицию склада
export async function updateInventoryItem(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const item = await env.DB.prepare(
    'SELECT id FROM inventory_items WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!item) return error('Item not found', 404);

  const body = await req.json().catch(() => ({}));
  const sets = []; const binds = [];

  if (body.name      !== undefined) { sets.push('name=?');      binds.push(body.name); }
  if (body.category  !== undefined) { sets.push('category=?');  binds.push(body.category); }
  if (body.minStock  !== undefined) { sets.push('min_stock=?'); binds.push(body.minStock); }
  if (body.unit      !== undefined) { sets.push('unit=?');      binds.push(body.unit); }
  if (body.cost      !== undefined) { sets.push('cost=?');      binds.push(body.cost); }
  if (body.expiry    !== undefined) { sets.push('expiry=?');    binds.push(body.expiry || null); }
  if (body.supplier  !== undefined) { sets.push('supplier=?');  binds.push(body.supplier || null); }
  if (body.isActive  !== undefined) { sets.push('is_active=?'); binds.push(body.isActive ? 1 : 0); }

  if (!sets.length) return error('Nothing to update', 400);
  sets.push('updated_at=?'); binds.push(now());

  await env.DB.prepare(
    `UPDATE inventory_items SET ${sets.join(',')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds, id, clinicId).run();

  return json({ ok: true });
}

// POST /api/inventory/movements  — записать движение (приход / списание)
export async function createMovement(req, env) {
  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const { itemId, kind, qty, reason, doctorId } = body;
  if (!itemId || !kind || !qty) return error('itemId, kind, qty required');
  if (!['in', 'out', 'adjust'].includes(kind)) return error('kind must be in|out|adjust');
  if (typeof qty !== 'number' || qty === 0) return error('qty must be non-zero number');

  // Проверяем что позиция принадлежит клинике
  const item = await env.DB.prepare(
    'SELECT id, stock FROM inventory_items WHERE id = ? AND clinic_id = ?'
  ).bind(itemId, req.user.clinic_id).first();
  if (!item) return error('Item not found', 404);

  // Врач, для которого списан расходник (может отличаться от автора). Опционально.
  let docId = null;
  if (doctorId) {
    const doc = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ? AND clinic_id = ?'
    ).bind(doctorId, req.user.clinic_id).first();
    if (!doc) return error('Doctor not found', 404);
    docId = doctorId;
  }

  // Вычисляем новый остаток
  const delta = kind === 'out' ? -Math.abs(qty) : Math.abs(qty);
  const newStock = item.stock + delta;
  if (newStock < 0) return error('Insufficient stock', 422);

  const ts = now();
  const movId = uid();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO inventory_movements (id, item_id, kind, qty, reason, doctor_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(movId, itemId, kind, Math.abs(qty), reason || null, docId, req.user.sub, ts),

    env.DB.prepare(
      'UPDATE inventory_items SET stock = ?, updated_at = ? WHERE id = ?'
    ).bind(newStock, ts, itemId),
  ]);

  return json({ id: movId, newStock }, 201);
}

// POST /api/inventory  — создать новую позицию склада
export async function createInventoryItem(req, env) {
  const clinicId = req.user.clinic_id;
  const body = await req.json().catch(() => ({}));
  const { name, category, stock = 0, minStock = 0, unit = 'шт', expiry, cost = 0, supplier } = body;
  if (!name) return error('name required', 400);

  const id  = uid();
  const ts  = now();

  await env.DB.prepare(
    `INSERT INTO inventory_items
       (id, clinic_id, name, category, stock, min_stock, unit, expiry, cost, supplier, is_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(id, clinicId, name, category || 'Прочее', stock, minStock, unit, expiry || null, cost, supplier || null, ts).run();

  return json({ ok: true, id }, 201);
}

// POST /api/inventory/:id/order  — зафиксировать заказ позиции
export async function orderInventoryItem(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const item = await env.DB.prepare(
    'SELECT id, name, min_stock, stock, unit FROM inventory_items WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!item) return error('Item not found', 404);

  const body = await req.json().catch(() => ({}));
  const qty = body.qty || Math.max(item.min_stock - item.stock, 1);
  const reason = `Заказ у поставщика: ${qty} ${item.unit}`;

  // Записываем движение типа 'in' со статусом "ожидается" через reason
  const movId = uid();
  const ts    = now();
  await env.DB.prepare(
    `INSERT INTO inventory_movements (id, item_id, kind, qty, reason, created_by, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?)`
  ).bind(movId, id, qty, reason, req.user.sub, ts).run();

  // Обновляем склад (поступление)
  await env.DB.prepare(
    'UPDATE inventory_items SET stock = stock + ?, updated_at = ? WHERE id = ?'
  ).bind(qty, ts, id).run();

  return json({ ok: true, movId, qty, newStock: item.stock + qty });
}

// GET /api/inventory/writeoffs  — последние списания (kind='out') по всей клинике.
// Доступно всем ролям: списывать материалы могут врачи, ассистенты и т.д.
export async function listWriteoffs(req, env) {
  const clinicId = req.user.clinic_id;
  const limit = Math.min(parseInt(new URL(req.url).searchParams.get('limit')) || 100, 200);

  // Границы текущего месяца по Asia/Almaty (UTC+5) — для суммы «списано за месяц»
  const ALM = 5 * 3600000;
  const nowAlm = new Date(Date.now() + ALM);
  const year  = nowAlm.getUTCFullYear();
  const month = nowAlm.getUTCMonth();
  const mStr  = String(month + 1).padStart(2, '0');
  const monthStart = new Date(`${year}-${mStr}-01T00:00:00+05:00`).getTime();
  const monthEnd   = new Date(`${year}-${mStr}-${new Date(year, month + 1, 0).getDate()}T23:59:59+05:00`).getTime();

  const [rows, monthRow] = await Promise.all([
    env.DB.prepare(
      `SELECT im.id, im.item_id, im.qty, im.reason, im.created_at, im.doctor_id,
              ii.name AS item_name, ii.unit, ii.cost,
              u.full_name AS created_by_name,
              du.full_name AS doctor_name
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       LEFT JOIN users u  ON u.id  = im.created_by
       LEFT JOIN users du ON du.id = im.doctor_id
       WHERE ii.clinic_id = ? AND im.kind = 'out'
       ORDER BY im.created_at DESC
       LIMIT ?`
    ).bind(clinicId, limit).all(),

    env.DB.prepare(
      `SELECT COALESCE(SUM(im.qty * ii.cost), 0) AS total, COUNT(*) AS cnt
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.item_id
       WHERE ii.clinic_id = ? AND im.kind = 'out'
         AND im.created_at >= ? AND im.created_at <= ?`
    ).bind(clinicId, monthStart, monthEnd).first(),
  ]);

  return json({
    writeoffs: (rows.results || []).map(r => ({
      id:        r.id,
      itemId:    r.item_id,
      material:  r.item_name,
      qty:       r.qty,
      unit:      r.unit || 'шт',
      cost:      r.cost,
      amount:    r.qty * r.cost,
      reason:    r.reason || '',
      createdAt: r.created_at,
      employee:  r.created_by_name || '',
      doctorId:  r.doctor_id || '',
      doctor:    r.doctor_name || '',
    })),
    kpi: {
      writeoffMonth: monthRow?.total || 0,
      countMonth:    monthRow?.cnt || 0,
    },
  });
}

// PATCH /api/inventory/movements/:id  — изменить списание (только owner/manager).
// Корректировка склада: возвращаем старое кол-во и снимаем новое атомарно.
export async function updateMovement(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const mov = await env.DB.prepare(
    `SELECT im.id, im.item_id, im.kind, im.qty
     FROM inventory_movements im
     JOIN inventory_items ii ON ii.id = im.item_id
     WHERE im.id = ? AND ii.clinic_id = ?`
  ).bind(id, clinicId).first();
  if (!mov) return error('Movement not found', 404);
  if (mov.kind !== 'out') return error('Only writeoffs are editable', 422);

  const body = await req.json().catch(() => ({}));
  const newItemId = body.itemId || mov.item_id;
  const newQty    = body.qty != null ? Math.abs(body.qty) : mov.qty;
  const newReason = body.reason !== undefined ? (body.reason || null) : undefined;
  let   newDoctor = undefined;
  if (body.doctorId !== undefined) {
    if (body.doctorId) {
      const doc = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ? AND clinic_id = ?'
      ).bind(body.doctorId, clinicId).first();
      if (!doc) return error('Doctor not found', 404);
      newDoctor = body.doctorId;
    } else {
      newDoctor = null;
    }
  }
  if (!newQty) return error('qty must be non-zero', 400);

  const oldItem = await env.DB.prepare(
    'SELECT id, stock FROM inventory_items WHERE id = ? AND clinic_id = ?'
  ).bind(mov.item_id, clinicId).first();
  if (!oldItem) return error('Item not found', 404);

  const ts = now();
  const stmts = [];

  if (newItemId === mov.item_id) {
    // та же позиция: вернуть старое списание и снять новое
    const newStock = oldItem.stock + mov.qty - newQty;
    if (newStock < 0) return error('Insufficient stock', 422);
    stmts.push(env.DB.prepare(
      'UPDATE inventory_items SET stock=?, updated_at=? WHERE id=?'
    ).bind(newStock, ts, mov.item_id));
  } else {
    // материал сменили: вернуть на старую позицию, снять с новой
    const newItem = await env.DB.prepare(
      'SELECT id, stock FROM inventory_items WHERE id = ? AND clinic_id = ?'
    ).bind(newItemId, clinicId).first();
    if (!newItem) return error('New item not found', 404);
    const newStock = newItem.stock - newQty;
    if (newStock < 0) return error('Insufficient stock', 422);
    stmts.push(env.DB.prepare(
      'UPDATE inventory_items SET stock=?, updated_at=? WHERE id=?'
    ).bind(oldItem.stock + mov.qty, ts, mov.item_id));
    stmts.push(env.DB.prepare(
      'UPDATE inventory_items SET stock=?, updated_at=? WHERE id=?'
    ).bind(newStock, ts, newItemId));
  }

  const sets = ['item_id=?', 'qty=?'];
  const binds = [newItemId, newQty];
  if (newReason !== undefined) { sets.push('reason=?');    binds.push(newReason); }
  if (newDoctor !== undefined) { sets.push('doctor_id=?'); binds.push(newDoctor); }
  stmts.push(env.DB.prepare(
    `UPDATE inventory_movements SET ${sets.join(', ')} WHERE id=?`
  ).bind(...binds, id));

  await env.DB.batch(stmts);
  return json({ ok: true });
}

// DELETE /api/inventory/movements/:id  — удалить движение и вернуть остаток (owner/manager)
export async function deleteMovement(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const mov = await env.DB.prepare(
    `SELECT im.id, im.item_id, im.kind, im.qty, ii.stock
     FROM inventory_movements im
     JOIN inventory_items ii ON ii.id = im.item_id
     WHERE im.id = ? AND ii.clinic_id = ?`
  ).bind(id, clinicId).first();
  if (!mov) return error('Movement not found', 404);

  // Реверс: списание (out) возвращаем на склад, приход (in) — снимаем
  const revert = mov.kind === 'out' ? Math.abs(mov.qty) : -Math.abs(mov.qty);
  const newStock = mov.stock + revert;
  if (newStock < 0) return error('Insufficient stock to revert', 422);

  const ts = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM inventory_movements WHERE id = ?').bind(id),
    env.DB.prepare('UPDATE inventory_items SET stock = ?, updated_at = ? WHERE id = ?')
      .bind(newStock, ts, mov.item_id),
  ]);
  return json({ ok: true, newStock });
}

// GET /api/inventory/:id/movements  — история движений позиции
export async function getItemMovements(req, env, _ctx, { id }) {
  const item = await env.DB.prepare(
    'SELECT id FROM inventory_items WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!item) return error('Item not found', 404);

  const rows = await env.DB.prepare(
    `SELECT im.id, im.kind, im.qty, im.reason, im.created_at,
            u.full_name AS created_by_name
     FROM inventory_movements im
     LEFT JOIN users u ON u.id = im.created_by
     WHERE im.item_id = ?
     ORDER BY im.created_at DESC
     LIMIT 50`
  ).bind(id).all();

  return json({
    movements: (rows.results || []).map(r => ({
      id:            r.id,
      kind:          r.kind,
      qty:           r.qty,
      reason:        r.reason || '',
      createdAt:     r.created_at,
      createdByName: r.created_by_name || '',
    })),
  });
}
