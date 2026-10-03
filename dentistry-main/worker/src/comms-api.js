import { json, error, uid, now } from './api-utils.js';

// GET /api/patients/:id/conversations  — метаданные: диалоги + каналы + шаблоны
export async function getConversations(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const [convRows, channelRows, templateRows] = await Promise.all([
    env.DB.prepare(
      'SELECT id, channel, last_message, last_at, unread FROM conversations WHERE patient_id = ? AND clinic_id = ?'
    ).bind(id, req.user.clinic_id).all(),

    env.DB.prepare(
      'SELECT id, channel, address, is_primary FROM patient_channels WHERE patient_id = ? ORDER BY channel'
    ).bind(id).all(),

    env.DB.prepare(
      'SELECT id, name, channel, body FROM message_templates WHERE clinic_id = ? AND is_active = 1 ORDER BY name'
    ).bind(req.user.clinic_id).all(),
  ]);

  // Свести в map channel → conversation
  const conversations = {};
  for (const r of convRows.results) {
    conversations[r.channel] = {
      id: r.id,
      lastMessage: r.last_message,
      lastAt: r.last_at,
      unread: r.unread,
    };
  }

  return json({
    conversations,
    channels: channelRows.results.map(r => ({
      id: r.id,
      channel: r.channel,
      address: r.address,
      isPrimary: !!r.is_primary,
    })),
    templates: templateRows.results.map(r => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      body: r.body,
    })),
  });
}

// GET /api/patients/:id/conversations/:channel/messages  — история сообщений
export async function getMessages(req, env, _ctx, { id, channel }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE patient_id = ? AND clinic_id = ? AND channel = ?'
  ).bind(id, req.user.clinic_id, channel).first();

  if (!conv) return json({ messages: [] });

  // Пометить все входящие как прочитанные
  await env.DB.prepare(
    "UPDATE conversations SET unread = 0 WHERE id = ?"
  ).bind(conv.id).run();

  const rows = await env.DB.prepare(
    `SELECT id, direction, body, status, is_automated, sent_at
     FROM messages
     WHERE conversation_id = ?
     ORDER BY sent_at ASC
     LIMIT 100`
  ).bind(conv.id).all();

  return json({
    messages: rows.results.map(r => ({
      id: r.id,
      direction: r.direction,
      body: r.body,
      status: r.status,
      isAutomated: !!r.is_automated,
      sentAt: r.sent_at,
    })),
  });
}

// POST /api/patients/:id/conversations/:channel/messages  — отправить сообщение
export async function sendMessage(req, env, _ctx, { id, channel }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const { body: text } = body;
  if (!text || !text.trim()) return error('body is required');

  const ts = now();

  // Найти или создать диалог
  let conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE patient_id = ? AND clinic_id = ? AND channel = ?'
  ).bind(id, req.user.clinic_id, channel).first();

  if (!conv) {
    const convId = uid();
    await env.DB.prepare(
      `INSERT INTO conversations (id, clinic_id, patient_id, channel, last_message, last_at, unread)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).bind(convId, req.user.clinic_id, id, channel, text.trim(), ts).run();
    conv = { id: convId };
  } else {
    await env.DB.prepare(
      'UPDATE conversations SET last_message = ?, last_at = ? WHERE id = ?'
    ).bind(text.trim(), ts, conv.id).run();
  }

  const msgId = uid();
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, direction, body, status, is_automated, sent_at, created_at)
     VALUES (?, ?, 'out', ?, 'sent', 0, ?, ?)`
  ).bind(msgId, conv.id, text.trim(), ts, ts).run();

  return json({ id: msgId }, 201);
}
