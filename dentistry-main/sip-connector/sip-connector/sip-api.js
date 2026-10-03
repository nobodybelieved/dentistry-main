// Pllato CRM — SIP/WebRTC API
//
// Отдаёт менеджеру SIP-credentials для подключения к Asterisk через WSS.
// Только аутентифицированный юзер может получить креды (auth-gated).
//
// Endpoints:
//   GET    /api/crm/sip/token   — credentials для WebRTC клиента
//   POST   /api/crm/sip/log     — лог звонка (опционально, для записи в БД)
//
// Secrets (wrangler secret put):
//   SIP_DOMAIN              — например '34-23-1-1.nip.io'
//   SIP_ENDPOINT_PASSWORD   — pjsip endpoint 100 password из setup-asterisk.sh
//   SIP_TURN_URL            — (опц) внешний TURN если оператор за NAT
//   SIP_TURN_USERNAME       — (опц)
//   SIP_TURN_PASSWORD       — (опц)

import { jsonResponse } from './api-utils.js';
import { addCallActivityLog } from './binotel-api.js';
import { broadcastToUser } from './user-notify-room.js';

/**
 * Главный роутер для /api/crm/sip/*
 */
export async function handleSipRequest(path, method, request, env, user, ctx) {
  if (!path.startsWith('/api/crm/sip/')) return null;

  // Все endpoint'ы требуют auth — она уже сделана в основном api.js
  if (!env.SIP_DOMAIN || !env.SIP_ENDPOINT_PASSWORD) {
    return jsonResponse({ error: 'sip_not_configured' }, 503);
  }

  if (path === '/api/crm/sip/token' && method === 'GET') {
    return await getSipToken(env, user);
  }
  if (path === '/api/crm/sip/log' && method === 'POST') {
    return await logSipCall(env, user, await request.json().catch(() => ({})));
  }

  return null;
}

/**
 * POST /api/crm/sip/log
 * Body: {
 *   phone:        '77011234567',
 *   customerId:   uuid | null,
 *   dealId:       uuid | null,
 *   contactName:  'Иван Иванов',
 *   direction:    'out' | 'in' (default 'out'),
 *   startedAt:    timestamp ms (когда был установлен звонок),
 *   endedAt:      timestamp ms (когда положили трубку),
 *   durationSec:  number (опц., посчитаем сами если есть startedAt+endedAt),
 *   status:       'completed' | 'no_answer' | 'cancelled' (default 'completed')
 * }
 *
 * Что делает:
 *   1. INSERT в phone_calls — для журнала звонков в карточке клиента
 *   2. Если есть customerId — addCallActivityLog для активных сделок
 *      → в истории сделки появится строка о звонке с длительностью
 *   3. Не блокирует Binotel webhook — если он тоже прилетит, мы апдейтим
 *      ту же запись по binotel_call_id (null здесь — будет создан другой
 *      рекорд от webhook; для исходящих через SIP-trunk Binotel обычно
 *      webhook НЕ шлёт, так что дублирования нет).
 *
 * Запись разговора (record_url) сейчас НЕ заполняется — она появится
 * когда настроим MixMonitor на Asterisk + загрузку в R2 (TODO).
 */
async function logSipCall(env, user, body) {
  const phone = String(body?.phone || '').replace(/[^\d]/g, '');
  if (!phone || phone.length < 7) return jsonResponse({ error: 'invalid_phone' }, 400);

  // Поддерживаем оба формата (snake_case от sip-client.js и camelCase
  // — для совместимости с возможными другими клиентами и для нас же
  // при ручном тесте через curl).
  const direction = (body?.incoming || body?.direction === 'in') ? 'in' : 'out';
  const customerId = body?.customerId || body?.customer_id || null;
  const dealId = body?.dealId || body?.deal_id || null;
  const startedAt = Number(body?.startedAt || body?.started_at) || Date.now();
  const endedAt = Number(body?.endedAt || body?.ended_at) || Date.now();
  let durationSec = Number(body?.durationSec ?? body?.duration_sec);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    durationSec = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  }
  const status = body?.status || (durationSec > 0 ? 'completed' : 'no_answer');
  // callId — общий ключ с SIP-заголовком X-Pllato-Call-Id (под этим именем
  // Asterisk сохранит .wav). phone_calls.id = callId → запись потом привяжется.
  const providedCallId = String(body?.callId || body?.call_id || '').trim();
  const validCallId = /^[A-Za-z0-9_\-]{8,64}$/.test(providedCallId) ? providedCallId : null;

  // Если customerId не передан — попробуем найти по номеру.
  // Это покрывает кейс когда юзер позвонил из UI набора, без привязки.
  let resolvedCustomerId = customerId;
  if (!resolvedCustomerId) {
    const found = await env.DB.prepare(
      'SELECT id FROM customers WHERE phone = ? OR phone_secondary = ? LIMIT 1'
    ).bind(phone, phone).first();
    if (found) resolvedCustomerId = found.id;
  }

  const callId = validCallId || crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO phone_calls
      (id, customer_id, binotel_call_id, direction, internal_number, external_number,
       started_at, answered_at, ended_at, duration_sec, status, record_url,
       assigned_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    callId,
    resolvedCustomerId,
    null,                    // binotel_call_id — нет, мы инициировали через SIP-trunk
    direction,
    String(user.id || ''),   // internal — у нас один endpoint 100, но логически это юзер
    phone,
    startedAt,
    durationSec > 0 ? startedAt : null,  // answered_at = startedAt если был ответ
    endedAt,
    durationSec,
    status,
    null,                    // record_url — пока null (MixMonitor TODO)
    user.id,
    now
  ).run();

  // Активность в истории сделки — переиспользуем готовый helper из binotel-api
  // (он знает правильную схему deal_activity_log с acted_by/acted_at + рендерит
  // нормальный текст «📞 Исходящий · 0:08 · +77...»).
  if (resolvedCustomerId) {
    const action = direction === 'in'
      ? (durationSec > 0 ? 'call_in_completed' : 'call_in_missed')
      : 'call_out_completed';
    await addCallActivityLog(env, resolvedCustomerId, {
      action,
      externalNumber: phone,
      durationSec,
      recordUrl: null,        // запись прилетит позже с Asterisk → привяжем по callId
      callId,                 // храним в old_value для последующей привязки записи
    }).catch(e => console.error('[sip-log] activity_log failed:', e?.message || e));

    // Обновляем last_contact_at у клиента
    await env.DB.prepare(
      'UPDATE customers SET last_contact_at = ? WHERE id = ?'
    ).bind(now, resolvedCustomerId).run().catch(() => {});

    // Auto-Ping — после ИСХОДЯЩЕГО ответившего звонка сразу шлём в браузер
    // менеджера event 'auto_ping', который открывает модал Пинга с
    // предзаполненным результатом разговора. Юзер быстро отмечает что
    // обсудили и переходит к следующему лиду.
    //
    // Не шлём для:
    // - входящих (там у клиента уже есть карточка, менеджер сам открывает Пинг)
    // - неотвеченных (durationSec == 0)
    // - звонков без клиента в БД (некуда крепить Пинг)
    if (direction === 'out' && durationSec > 0) {
      // Получаем имя/телефон клиента для предзаполнения модала
      const cust = await env.DB.prepare(
        'SELECT name, phone FROM customers WHERE id = ? LIMIT 1'
      ).bind(resolvedCustomerId).first().catch(() => null);

      try {
        await broadcastToUser(env, user.id, {
          type: 'auto_ping',
          customer_id: resolvedCustomerId,
          customer_name: cust?.name || '',
          customer_phone: cust?.phone || phone,
          duration_sec: durationSec,
          call_id: callId,
          record_url: null,  // TODO #176 — MixMonitor + R2
        });
      } catch (e) {
        console.error('[sip-log] auto_ping broadcast failed:', e?.message);
      }
    }
  }

  return jsonResponse({ ok: true, call_id: callId });
}

/**
 * GET /api/crm/sip/token
 * Возвращает credentials для SIP.js / JsSIP клиента в браузере.
 *
 * Ответ:
 * {
 *   user: '100',              ← SIP username (общий endpoint на N операторов)
 *   password: '...',          ← endpoint password (берётся из Worker secret)
 *   domain: '34-23-1-1.nip.io',
 *   wss: 'wss://34-23-1-1.nip.io:8089/ws',
 *   iceServers: [{ urls: 'stun:...' }, { urls: 'turn:...', username, credential }],
 *   display_name: 'Имя менеджера'   ← для From в SIP сигнализации
 * }
 */
async function getSipToken(env, user) {
  const domain = env.SIP_DOMAIN;
  const sipUser = env.SIP_USER || '100';
  const password = env.SIP_ENDPOINT_PASSWORD;

  // ICE-серверы для NAT-traversal
  const iceServers = [
    { urls: `stun:${domain}:3478` },
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  // External TURN — если оператор за корпоративным NAT'ом
  if (env.SIP_TURN_URL && env.SIP_TURN_USERNAME && env.SIP_TURN_PASSWORD) {
    iceServers.push({
      urls: [
        env.SIP_TURN_URL,
        env.SIP_TURN_URL.replace('turn:', 'turn:') + '?transport=tcp',
      ],
      username: env.SIP_TURN_USERNAME,
      credential: env.SIP_TURN_PASSWORD,
    });
  }

  return jsonResponse({
    user: sipUser,
    password,
    domain,
    wss: `wss://${domain}:8089/ws`,
    iceServers,
    display_name: user.name || user.username || '',
    // Метаданные для frontend (необязательны, но полезны)
    user_id: user.id,
    role: user.role,
  });
}
