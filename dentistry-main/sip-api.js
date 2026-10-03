// Dentaly CRM — SIP/WebRTC API
//
// Два эндпоинта для IP-телефонии из браузера.
// Подключается к sip-client.js (фронт) и Asterisk (инфра).
//
// Endpoints:
//   GET    /api/crm/sip/token   — SIP-credentials для WebRTC клиента
//   POST   /api/crm/sip/log     — лог завершённого звонка → activity_log
//
// Secrets (wrangler secret put):
//   SIP_DOMAIN              — например '34-23-1-1.nip.io'
//   SIP_ENDPOINT_PASSWORD   — pjsip endpoint 100 password из setup-asterisk.sh
//   SIP_USER                — (опц) SIP username, default '100'
//   SIP_TURN_URL            — (опц) TURN если оператор за NAT
//   SIP_TURN_USERNAME       — (опц)
//   SIP_TURN_PASSWORD       — (опц)

import { jsonResponse } from './api-utils.js';
import { broadcastToUser } from './user-notify-room.js';

/**
 * Главный роутер для /api/crm/sip/*
 * Подключается в основной api.js после авторизации:
 *   const sipResult = await handleSipRequest(path, method, request, env, user, ctx);
 *   if (sipResult) return sipResult;
 */
export async function handleSipRequest(path, method, request, env, user, ctx) {
  if (!path.startsWith('/api/crm/sip/')) return null;

  if (!env.SIP_DOMAIN || !env.SIP_ENDPOINT_PASSWORD) {
    return jsonResponse({ error: 'sip_not_configured' }, 503);
  }

  if (path === '/api/crm/sip/token' && method === 'GET') {
    return getSipToken(env, user);
  }
  if (path === '/api/crm/sip/log' && method === 'POST') {
    return await logSipCall(env, user, await request.json().catch(() => ({})), ctx);
  }

  return null;
}

/**
 * GET /api/crm/sip/token
 * Возвращает SIP-credentials для SIP.js в браузере.
 */
function getSipToken(env, user) {
  const domain = env.SIP_DOMAIN;
  const iceServers = [
    { urls: `stun:${domain}:3478` },
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  if (env.SIP_TURN_URL && env.SIP_TURN_USERNAME && env.SIP_TURN_PASSWORD) {
    iceServers.push({
      urls: [env.SIP_TURN_URL, env.SIP_TURN_URL + '?transport=tcp'],
      username: env.SIP_TURN_USERNAME,
      credential: env.SIP_TURN_PASSWORD,
    });
  }
  return jsonResponse({
    user: env.SIP_USER || '100',
    password: env.SIP_ENDPOINT_PASSWORD,
    domain,
    wss: `wss://${domain}:8089/ws`,
    iceServers,
    display_name: user.fullName || user.name || '',
    user_id: user.id,
  });
}

/**
 * POST /api/crm/sip/log
 * Body: { phone, customerId (=patientId), contactName, direction, startedAt, endedAt, durationSec, status }
 * Пишет событие в activity_log пациента + опциональный auto-ping менеджеру через DO.
 */
async function logSipCall(env, user, body, ctx) {
  const phone = String(body?.phone || '').replace(/[^\d+]/g, '');
  if (!phone || phone.length < 7) return jsonResponse({ error: 'invalid_phone' }, 400);

  const direction = (body?.direction === 'in' || body?.incoming) ? 'in' : 'out';
  const patientId = body?.customerId || body?.customer_id || body?.patientId || null;
  const startedAt = Number(body?.startedAt || body?.started_at) || Date.now();
  const endedAt   = Number(body?.endedAt   || body?.ended_at)   || Date.now();
  let durationSec = Number(body?.durationSec ?? body?.duration_sec);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    durationSec = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  }
  const status = body?.status || (durationSec > 0 ? 'completed' : 'no_answer');

  // Если patientId не передан — пробуем найти пациента по номеру телефона
  let resolvedPatientId = patientId;
  if (!resolvedPatientId) {
    const found = await env.DB.prepare(
      'SELECT id FROM patients WHERE phone = ? LIMIT 1'
    ).bind(phone).first().catch(() => null);
    if (found) resolvedPatientId = found.id;
  }

  const now = Date.now();
  const mins = Math.floor(durationSec / 60);
  const secs = String(durationSec % 60).padStart(2, '0');
  const durationFmt = `${mins}:${secs}`;
  const dirLabel = direction === 'in' ? 'Входящий' : 'Исходящий';
  const statusLabel = status === 'completed' ? '' : ' · Не отвечен';

  // Пишем в activity_log пациента (тип call_in / call_out)
  if (resolvedPatientId) {
    const actType = direction === 'in' ? 'call_in' : 'call_out';
    await env.DB.prepare(`
      INSERT INTO activity_log (id, clinic_id, patient_id, actor_id, type, icon, title, meta, event_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      user.clinicId,
      resolvedPatientId,
      user.id,
      actType,
      'phone',
      `${dirLabel} звонок · ${phone}`,
      JSON.stringify({ durationSec, durationFmt, status, phone }),
      startedAt,
      now
    ).run().catch(e => console.error('[sip-log] activity_log insert failed:', e?.message));

    // Auto-Ping: после исходящего отвеченного звонка — уведомляем менеджера через DO
    if (direction === 'out' && durationSec > 0) {
      const patient = await env.DB.prepare(
        'SELECT full_name, phone FROM patients WHERE id = ? LIMIT 1'
      ).bind(resolvedPatientId).first().catch(() => null);

      ctx.waitUntil(
        broadcastToUser(env, user.id, {
          type: 'auto_ping',
          patient_id: resolvedPatientId,
          patient_name: patient?.full_name || body?.contactName || '',
          patient_phone: patient?.phone || phone,
          duration_sec: durationSec,
        }).catch(e => console.error('[sip-log] auto_ping failed:', e?.message))
      );
    }
  }

  return jsonResponse({ ok: true });
}
