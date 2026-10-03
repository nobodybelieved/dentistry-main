import { handleLogin, handleLogout, handleMe, handleSeedPasswords, handleFixNames } from './auth.js';
import { withAuth, withRole, error, json } from './api-utils.js';
import {
  listPatients, getPatient, createPatient, updatePatient,
  getTimeline, getLoyalty, getFamily,
  deletePatient,
} from './patients-api.js';
import {
  getSchedule, getAppointment, createAppointment, updateAppointment, getSlots, deleteAppointment,
} from './schedule-api.js';
import { getTeeth, updateTooth } from './teeth-api.js';
import { listTreatmentPlans, getPatientPlan, getPatientVisits, getPatientFinance,
         createPatientPlan, patchPlan, addPlanVisit, deletePlanStage, patchPlanVisit } from './plans-api.js';
import { listPatientFiles, downloadPatientFile } from './files-api.js';
import { getConversations, getMessages, sendMessage } from './comms-api.js';
import { getDashboard } from './dashboard-api.js';
import { getClinicFinance, acceptPayment } from './finance-api.js';
import { listInventory, createMovement, getItemMovements,
         createInventoryItem, orderInventoryItem, updateInventoryItem,
         listWriteoffs, updateMovement, deleteMovement } from './inventory-api.js';
import {
  listComms, patchAutomation, createAutomation, deleteAutomation,
  listTemplates, createTemplate, patchTemplate, deleteTemplate,
} from './comms-clinic-api.js';
import { getAnalytics } from './analytics-api.js';
import { listProcedures, createProcedure, patchProcedure } from './procedures-api.js';
import { handleScheduled } from './cron.js';
import {
  refreshRoles, listStaff,
  listTeamUsers, updateTeamUser, toggleTeamUserActive,
  getRoles, saveRoleSections, createRole, renameRole, deleteRole,
  createInvite, listInvites, getInvite, acceptInvite, revokeInvite,
} from './team-api.js';

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://dentistry-main.rahymstar13.workers.dev',
  'http://localhost:3000',
  'http://localhost:8787',
  'http://127.0.0.1:5500',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern: new URLPattern({ pathname: pattern }), handler });
}

// Auth
route('POST', '/api/auth/login',    (req, env, ctx) => handleLogin(req, env));
route('POST', '/api/auth/logout',   withAuth((req, env) => handleLogout(req, env)));
route('GET',  '/api/me',            withAuth((req, env) => handleMe(req, env)));

// Dev-only: seed demo passwords + fix names
route('POST', '/api/dev/seed-passwords', (req, env) => handleSeedPasswords(req, env));
route('POST', '/api/dev/fix-names',      (req, env) => handleFixNames(req, env));

// Patients
route('GET',  '/api/patients',          withAuth(listPatients));
route('POST', '/api/patients',          withAuth(createPatient));
route('GET',  '/api/patients/:id',      withAuth(getPatient));
route('PATCH', '/api/patients/:id',      withAuth(updatePatient));
route('DELETE','/api/patients/:id',      withAuth(deletePatient));
route('GET',  '/api/patients/:id/timeline', withAuth(getTimeline));
route('GET',  '/api/patients/:id/loyalty',  withAuth(getLoyalty));
route('GET',  '/api/patients/:id/family',   withAuth(getFamily));
route('GET',  '/api/patients/:id/teeth',    withAuth(getTeeth));
route('PUT',  '/api/patients/:id/teeth/:num', withAuth(updateTooth));
route('GET',  '/api/patients/:id/plan',     withAuth(getPatientPlan));
route('POST', '/api/patients/:id/plan',     withAuth(createPatientPlan));
route('GET',  '/api/patients/:id/visits',   withAuth(getPatientVisits));
route('GET',  '/api/patients/:id/finance',  withAuth(getPatientFinance));
route('GET',  '/api/patients/:id/files',    withAuth(listPatientFiles));
route('GET',  '/api/patients/:id/files/:fileId/download', withAuth(downloadPatientFile));
route('GET',  '/api/patients/:id/conversations',          withAuth(getConversations));
route('GET',  '/api/patients/:id/conversations/:channel/messages', withAuth(getMessages));
route('POST', '/api/patients/:id/conversations/:channel/messages', withAuth(sendMessage));

// Notifications
route('GET',  '/api/notifications', withAuth(async (req, env) => {
  const { json } = await import('./api-utils.js');
  const rows = await env.DB.prepare(
    `SELECT id, icon, title, meta, link, is_read, created_at
     FROM notifications
     WHERE clinic_id = ? AND (user_id = ? OR user_id IS NULL)
     ORDER BY created_at DESC LIMIT 30`
  ).bind(req.user.clinic_id, req.user.sub).all();
  return json({ notifications: rows.results || [] });
}));
route('PATCH', '/api/notifications/read-all', withAuth(async (req, env) => {
  const { json } = await import('./api-utils.js');
  await env.DB.prepare(
    `UPDATE notifications SET is_read=1 WHERE clinic_id=? AND (user_id=? OR user_id IS NULL)`
  ).bind(req.user.clinic_id, req.user.sub).run();
  return json({ ok: true });
}));

// Dashboard
route('GET',  '/api/dashboard',          withAuth(getDashboard));

// Finance (clinic-wide)
route('GET',  '/api/finance',            withAuth(getClinicFinance));
route('POST', '/api/payments',           withAuth(acceptPayment));

// Прайс-лист
route('GET',   '/api/procedures',        withAuth(listProcedures));
route('POST',  '/api/procedures',        withAuth(createProcedure));
route('PATCH', '/api/procedures/:id',    withAuth(patchProcedure));

// Analytics
route('GET',  '/api/analytics',                        withAuth(getAnalytics));

// Comms (clinic-wide)
route('GET',   '/api/comms',                           withAuth(listComms));
route('POST',  '/api/automations',        withAuth(createAutomation));
route('PATCH', '/api/automations/:id',    withAuth(patchAutomation));
route('DELETE','/api/automations/:id',    withAuth(deleteAutomation));
route('GET',   '/api/templates',                       withAuth(listTemplates));
route('POST',  '/api/templates',                       withAuth(createTemplate));
route('PATCH', '/api/templates/:id',                   withAuth(patchTemplate));
route('DELETE','/api/templates/:id',                   withAuth(deleteTemplate));

// Inventory
route('GET',   '/api/inventory',                        withAuth(listInventory));
route('GET',   '/api/inventory/writeoffs',              withAuth(listWriteoffs));        // все роли: журнал списаний
route('POST',  '/api/inventory',                        withAuth(createInventoryItem));
route('POST',  '/api/inventory/movements',              withAuth(createMovement));       // все роли: списать/принять
route('PATCH', '/api/inventory/movements/:id',          withRole('manager')(updateMovement)); // правка списания — управляющий
route('DELETE','/api/inventory/movements/:id',          withRole('manager')(deleteMovement)); // удаление списания — управляющий
route('GET',   '/api/inventory/:id/movements',          withAuth(getItemMovements));
route('POST',  '/api/inventory/:id/order',              withAuth(orderInventoryItem));
route('PATCH', '/api/inventory/:id',                    withAuth(updateInventoryItem));

// Treatment plans (clinic-wide)
route('GET',   '/api/treatment-plans',              withAuth(listTreatmentPlans));
route('PATCH', '/api/plans/:id',                         withAuth(patchPlan));
route('POST',  '/api/plans/:id/visits',                  withAuth(addPlanVisit));
route('PATCH', '/api/plans/:planId/visits/:visitId',     withAuth(patchPlanVisit));
route('DELETE','/api/plans/:planId/stages/:sid',         withAuth(deletePlanStage));

// Сотрудники клиники (для атрибуции; доступно всем ролям)
route('GET',    '/api/staff',                     withAuth(listStaff));

// Team & Roles
route('GET',    '/api/admin/users',               withAuth(listTeamUsers));
route('POST',   '/api/admin/users/:id/active',    withAuth((req, env, ctx, params) => toggleTeamUserActive(req, env, params)));
route('POST',   '/api/admin/users/:id',           withAuth((req, env, ctx, params) => updateTeamUser(req, env, params)));
route('GET',    '/api/admin/roles',               withAuth(getRoles));
route('POST',   '/api/admin/roles/create',        withAuth(createRole));
route('POST',   '/api/admin/roles/rename',        withAuth(renameRole));
route('POST',   '/api/admin/roles/delete',        withAuth(deleteRole));
route('POST',   '/api/admin/roles',               withAuth(saveRoleSections));
route('POST',   '/api/invites',                   withAuth(createInvite));
route('GET',    '/api/invites',                   withAuth(listInvites));
route('POST',   '/api/invites/:token/accept',     (req, env, ctx, params) => acceptInvite(req, env, params));
route('GET',    '/api/invites/:token',            (req, env, ctx, params) => getInvite(req, env, params));
route('DELETE', '/api/invites/:token',            withAuth((req, env, ctx, params) => revokeInvite(req, env, params)));

// Schedule
route('GET',  '/api/schedule',           withAuth(getSchedule));
route('GET',  '/api/slots',              withAuth(getSlots));
route('POST',  '/api/appointments',       withAuth(createAppointment));
route('GET',   '/api/appointments/:id',  withAuth(getAppointment));
route('PATCH', '/api/appointments/:id',  withAuth(updateAppointment));
route('DELETE','/api/appointments/:id',  withAuth(deleteAppointment));

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },

  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // Обновить кэш ролей (30 сек TTL)
    refreshRoles(env).catch(() => {});

    // ⚠️ WebSocket ДО CORS-обёртки
    if (url.pathname.startsWith('/api/ws/')) {
      return handleWebSocket(request, env, ctx);
    }

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Route matching
    for (const { method, pattern, handler } of routes) {
      if (request.method !== method) continue;
      const match = pattern.exec(url);
      if (!match) continue;

      try {
        const params = match.pathname.groups;
        const resp   = await handler(request, env, ctx, params);
        return withCors(resp, origin);
      } catch (e) {
        console.error(e);
        return withCors(
          new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          }),
          origin
        );
      }
    }

    return withCors(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
      origin
    );
  },
};

// ─── WebSocket ────────────────────────────────────────────────────────────────

async function handleWebSocket(request, env, ctx) {
  const url  = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/ws/clinic') {
    const clinicId = request.headers.get('X-Clinic-Id') || url.searchParams.get('clinic_id');
    if (!clinicId) return new Response('clinic_id required', { status: 400 });
    const doId = env.CLINIC_ROOM.idFromName(clinicId);
    const stub = env.CLINIC_ROOM.get(doId);
    return stub.fetch(request);
  }

  if (path === '/api/ws/user') {
    const userId = url.searchParams.get('user_id');
    if (!userId) return new Response('user_id required', { status: 400 });
    const doId = env.USER_NOTIFY_ROOM.idFromName(userId);
    const stub = env.USER_NOTIFY_ROOM.get(doId);
    return stub.fetch(request);
  }

  return new Response('Unknown WS path', { status: 404 });
}

// ─── Durable Objects ──────────────────────────────────────────────────────────

export class ClinicRoom {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const msg = await request.text();
      for (const ws of this.sessions) {
        try { ws.send(msg); } catch {}
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    this.sessions.add(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(ws) { this.sessions.delete(ws); }
  webSocketError(ws) { this.sessions.delete(ws); }
  webSocketMessage(ws, msg) { /* клиент → сервер не нужен */ }
}

export class UserNotifyRoom {
  constructor(state, env) {
    this.state    = state;
    this.env      = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const msg = await request.text();
      for (const ws of this.sessions) {
        try { ws.send(msg); } catch {}
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    this.sessions.add(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(ws) { this.sessions.delete(ws); }
  webSocketError(ws) { this.sessions.delete(ws); }
  webSocketMessage(ws, msg) {}
}
