import { json, error } from './api-utils.js';

// GET /api/comms  — все диалоги клиники + статистика
export async function listComms(req, env) {
  const clinicId = req.user.clinic_id;

  // Asia/Almaty = UTC+5
  const ALM = 5 * 3600000;
  const nowAlm = new Date(Date.now() + ALM);
  const year  = nowAlm.getUTCFullYear();
  const month = nowAlm.getUTCMonth();
  const mStr  = String(month + 1).padStart(2, '0');
  const monthStart = new Date(`${year}-${mStr}-01T00:00:00+05:00`).getTime();
  const monthEnd   = new Date(`${year}-${mStr}-${new Date(year, month + 1, 0).getDate()}T23:59:59+05:00`).getTime();

  const [convRows, sentRow, deliveredRow, templateRow] = await Promise.all([
    // Все диалоги с именем и телефоном пациента, сортировка по last_at
    env.DB.prepare(
      `SELECT c.id, c.patient_id, c.channel, c.last_message, c.last_at, c.unread,
              p.full_name AS patient_name, p.phone AS patient_phone
       FROM conversations c
       JOIN patients p ON p.id = c.patient_id
       WHERE c.clinic_id = ?
       ORDER BY c.last_at DESC
       LIMIT 100`
    ).bind(clinicId).all(),

    // Отправлено за текущий месяц
    env.DB.prepare(
      `SELECT COUNT(*) AS cnt
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.clinic_id = ? AND m.direction = 'out'
         AND m.created_at >= ? AND m.created_at <= ?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    // Доставлено (статус delivered или read) за текущий месяц
    env.DB.prepare(
      `SELECT COUNT(*) AS cnt
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.clinic_id = ? AND m.direction = 'out'
         AND m.status IN ('delivered','read')
         AND m.created_at >= ? AND m.created_at <= ?`
    ).bind(clinicId, monthStart, monthEnd).first(),

    // Количество активных шаблонов
    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM message_templates
       WHERE clinic_id = ? AND is_active = 1`
    ).bind(clinicId).first(),
  ]);

  const convs = convRows.results || [];
  const sentCount      = sentRow?.cnt || 0;
  const deliveredCount = deliveredRow?.cnt || 0;
  const deliveryRate   = sentCount > 0
    ? Math.round((deliveredCount / sentCount) * 100)
    : 0;

  // Агрегация по каналам
  const byChannel = { wa: { convs: 0, unread: 0 }, tg: { convs: 0, unread: 0 }, sms: { convs: 0, unread: 0 } };
  let totalUnread = 0;
  for (const c of convs) {
    const ch = c.channel;
    if (!byChannel[ch]) byChannel[ch] = { convs: 0, unread: 0 };
    byChannel[ch].convs++;
    byChannel[ch].unread += c.unread || 0;
    totalUnread += c.unread || 0;
  }

  // Автоматизации — добавляем в ответ сразу
  const autoRows = await env.DB.prepare(
    `SELECT id, name, description, channels, trigger, status
     FROM automations WHERE clinic_id = ? ORDER BY created_at`
  ).bind(clinicId).all();

  const automations = (autoRows.results || []).map(a => ({
    id:          a.id,
    name:        a.name,
    description: a.description || '',
    channels:    JSON.parse(a.channels || '[]'),
    trigger:     a.trigger,
    status:      a.status,
  }));

  return json({
    conversations: convs.map(c => ({
      id:          c.id,
      patientId:   c.patient_id,
      patientName: c.patient_name,
      patientPhone:c.patient_phone || '',
      channel:     c.channel,
      lastMessage: c.last_message || '',
      lastAt:      c.last_at,
      unread:      c.unread || 0,
    })),
    stats: {
      totalConvs:   convs.length,
      totalUnread,
      sentMonth:    sentCount,
      deliveryRate,
      templateCount: templateRow?.cnt || 0,
      byChannel,
    },
    automations,
  });
}

// PATCH /api/automations/:id  — обновить поля (статус, название, описание, каналы, триггер)
export async function patchAutomation(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const auto = await env.DB.prepare(
    'SELECT id, status FROM automations WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!auto) return error('Automation not found', 404);

  const body = await req.json().catch(() => ({}));
  const sets = []; const binds = [];

  if (body.name        !== undefined) { sets.push('name=?');        binds.push(body.name.trim()); }
  if (body.description !== undefined) { sets.push('description=?'); binds.push(body.description.trim()); }
  if (body.channels    !== undefined) { sets.push('channels=?');    binds.push(JSON.stringify(body.channels)); }
  if (body.trigger     !== undefined) { sets.push('trigger=?');     binds.push(body.trigger); }
  if (body.status      !== undefined) {
    sets.push('status=?');
    binds.push(body.status);
  } else if (!sets.length) {
    // Toggle без явного status
    const toggled = auto.status === 'active' ? 'paused' : 'active';
    sets.push('status=?'); binds.push(toggled);
  }

  await env.DB.prepare(
    `UPDATE automations SET ${sets.join(',')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds, id, clinicId).run();

  const updated = await env.DB.prepare(
    'SELECT id, name, description, channels, trigger, status FROM automations WHERE id = ?'
  ).bind(id).first();

  return json({ ok: true, status: updated.status });
}

// PATCH /api/templates/:id  — редактировать шаблон
export async function patchTemplate(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const tmpl = await env.DB.prepare(
    'SELECT id FROM message_templates WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!tmpl) return error('Template not found', 404);

  const body = await req.json().catch(() => ({}));
  const sets = []; const binds = [];
  if (body.name    !== undefined) { sets.push('name=?');    binds.push(body.name); }
  if (body.body    !== undefined) { sets.push('body=?');    binds.push(body.body); }
  if (body.channel !== undefined) { sets.push('channel=?'); binds.push(body.channel); }

  if (!sets.length) return error('Nothing to update', 400);
  await env.DB.prepare(
    `UPDATE message_templates SET ${sets.join(',')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds, id, clinicId).run();
  return json({ ok: true });
}

// GET /api/templates  — шаблоны сообщений
export async function listTemplates(req, env) {
  const clinicId = req.user.clinic_id;
  const url = new URL(req.url);
  const channel = url.searchParams.get('channel');

  let q = 'SELECT id, name, channel, body FROM message_templates WHERE clinic_id = ? AND is_active = 1';
  const binds = [clinicId];
  if (channel) { q += ' AND (channel = ? OR channel = \'any\')'; binds.push(channel); }
  q += ' ORDER BY name';

  const rows = await env.DB.prepare(q).bind(...binds).all();
  return json({
    templates: (rows.results || []).map(t => ({
      id:      t.id,
      name:    t.name,
      channel: t.channel,
      body:    t.body,
    })),
  });
}

// POST /api/templates  — создать шаблон
export async function createTemplate(req, env) {
  const clinicId = req.user.clinic_id;
  const body = await req.json().catch(() => ({}));
  const { name, body: text, channel = 'any' } = body;
  if (!name || !text) return error('name and body are required', 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO message_templates (id, clinic_id, name, channel, body, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`
  ).bind(id, clinicId, name.trim(), channel, text.trim()).run();

  return json({ id, name: name.trim(), channel, body: text.trim() }, 201);
}

// DELETE /api/templates/:id  — удалить шаблон
export async function deleteTemplate(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const tmpl = await env.DB.prepare(
    'SELECT id FROM message_templates WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!tmpl) return error('Template not found', 404);

  await env.DB.prepare('DELETE FROM message_templates WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// POST /api/automations  — создать автоматизацию
export async function createAutomation(req, env) {
  const clinicId = req.user.clinic_id;
  const body = await req.json().catch(() => ({}));
  const { name, description = '', channels = [], trigger = '', status = 'active' } = body;
  if (!name) return error('name is required', 400);

  const id = crypto.randomUUID();
  const ts = Date.now();
  await env.DB.prepare(
    `INSERT INTO automations (id, clinic_id, name, description, channels, trigger, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, clinicId, name.trim(), description.trim(), JSON.stringify(channels), trigger, status, ts).run();

  return json({ id, name: name.trim(), description, channels, trigger, status }, 201);
}

// DELETE /api/automations/:id  — удалить автоматизацию
export async function deleteAutomation(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const auto = await env.DB.prepare(
    'SELECT id FROM automations WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!auto) return error('Automation not found', 404);

  await env.DB.prepare('DELETE FROM automations WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
