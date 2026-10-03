import { json, error, hashPassword, uid, now } from './api-utils.js';

// ─── Разделы и роли ───────────────────────────────────────────────────────────

export const ALL_SECTIONS = [
  'dashboard', 'schedule', 'patients', 'treatment',
  'finance', 'inventory', 'writeoff', 'comms', 'analytics', 'team', 'settings',
];

// «Склад» (inventory) виден только управляющему; «Списание» (writeoff) — всем,
// т.к. списывать материалы могут врачи, ассистенты, гигиенисты.
const ROLES = {
  owner:     { name: 'Владелец',      sections: ALL_SECTIONS },
  manager:   { name: 'Управляющий',   sections: ['dashboard','schedule','patients','treatment','finance','inventory','writeoff','comms','analytics','team'] },
  admin:     { name: 'Администратор', sections: ['dashboard','schedule','patients','writeoff','comms'] },
  doctor:    { name: 'Врач',          sections: ['dashboard','schedule','patients','treatment','writeoff'] },
  hygienist: { name: 'Гигиенист',     sections: ['dashboard','schedule','patients','writeoff'] },
  assistant: { name: 'Ассистент',     sections: ['dashboard','schedule','patients','writeoff'] },
};

let ROLES_EFFECTIVE = { ...ROLES };
let _rolesLoadedAt = 0;

export async function refreshRoles(env) {
  if (Date.now() - _rolesLoadedAt < 30000) return;
  try {
    const rows = await env.DB.prepare('SELECT id, name, sections FROM roles').all();
    const eff = {};
    for (const k of Object.keys(ROLES)) eff[k] = { ...ROLES[k] };
    for (const r of (rows.results || [])) {
      if (!eff[r.id]) eff[r.id] = { name: r.name || r.id, sections: [] };
      else if (r.name) eff[r.id].name = r.name;
      if (r.id === 'owner') continue;
      if (r.sections) {
        try {
          const s = JSON.parse(r.sections);
          if (Array.isArray(s)) eff[r.id].sections = s.filter(x => ALL_SECTIONS.includes(x));
        } catch {}
      }
    }
    ROLES_EFFECTIVE = eff;
    _rolesLoadedAt = Date.now();
  } catch {}
}

function isAdmin(role) {
  return role === 'owner' || role === 'manager';
}

function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Сотрудники (admin) ───────────────────────────────────────────────────────

export async function listTeamUsers(req, env) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  await refreshRoles(env);
  const rows = await env.DB.prepare(
    `SELECT id, full_name, initials, color, role, specialty, email, phone, is_active, created_at
     FROM users WHERE clinic_id = ? ORDER BY is_active DESC, created_at ASC LIMIT 500`
  ).bind(req.user.clinic_id).all();
  const items = (rows.results || []).map(u => ({
    id: u.id,
    fullName: u.full_name,
    initials: u.initials,
    color: u.color,
    role: u.role,
    roleName: (ROLES_EFFECTIVE[u.role] || { name: u.role }).name,
    specialty: u.specialty,
    email: u.email,
    phone: u.phone,
    isActive: !!u.is_active,
    createdAt: u.created_at,
    isMe: u.id === req.user.sub,
  }));
  return json({ ok: true, items });
}

// GET /api/staff — активные сотрудники клиники для атрибуции (списание и т.п.).
// Доступно всем ролям: списать может любой сотрудник (врач, гигиенист,
// управляющий, админ, ассистент). Лёгкая выборка без email/телефонов.
export async function listStaff(req, env) {
  await refreshRoles(env);
  const rows = await env.DB.prepare(
    `SELECT id, full_name, initials, color, role, specialty
     FROM users
     WHERE clinic_id = ? AND is_active = 1 AND role != 'superadmin'
     ORDER BY full_name`
  ).bind(req.user.clinic_id).all();
  return json({
    staff: (rows.results || []).map(u => ({
      id: u.id,
      name: u.full_name,
      initials: u.initials || '',
      color: u.color || '#0F766E',
      role: u.role,
      roleName: (ROLES_EFFECTIVE[u.role] || { name: u.role }).name,
      spec: u.specialty || '',
    })),
  });
}

export async function updateTeamUser(req, env, params) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  await refreshRoles(env);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND clinic_id = ?')
    .bind(params.id, req.user.clinic_id).first();
  if (!target) return error('Сотрудник не найден', 404);
  if (target.role === 'owner' && req.user.role !== 'owner') return error('Недостаточно прав', 403);
  const sets = [], binds = [];
  if (body.fullName != null) {
    const nm = String(body.fullName).trim();
    if (!nm) return error('Имя не может быть пустым');
    sets.push('full_name=?'); binds.push(nm);
    sets.push('initials=?');
    binds.push(nm.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase());
  }
  if (body.email != null) {
    sets.push('email=?');
    binds.push(body.email.trim().toLowerCase() || null);
  }
  if (body.role != null) {
    const role = String(body.role);
    if (!ROLES_EFFECTIVE[role]) return error('Неизвестная роль');
    if (target.role === 'owner' && role !== 'owner') return error('Роль владельца менять нельзя');
    if (target.id === req.user.sub && role !== req.user.role) return error('Свою роль менять нельзя');
    sets.push('role=?'); binds.push(role);
  }
  if (!sets.length) return error('Нет полей для обновления');
  binds.push(params.id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...binds).run();
  return json({ ok: true });
}

export async function toggleTeamUserActive(req, env, params) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  if (req.user.sub === params.id) return error('Нельзя отключить самого себя');
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND clinic_id = ?')
    .bind(params.id, req.user.clinic_id).first();
  if (!target) return error('Сотрудник не найден', 404);
  if (target.role === 'owner') return error('Владельца отключить нельзя');
  const active = body.active ? 1 : 0;
  await env.DB.prepare('UPDATE users SET is_active=? WHERE id=?').bind(active, params.id).run();
  return json({ ok: true, active: !!active });
}

// ─── Роли ─────────────────────────────────────────────────────────────────────

export async function getRoles(req, env) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  _rolesLoadedAt = 0;
  await refreshRoles(env);
  const roles = Object.keys(ROLES_EFFECTIVE).map(k => {
    const r = ROLES_EFFECTIVE[k];
    return {
      id: k,
      name: r.name,
      locked: k === 'owner',
      builtin: !!ROLES[k],
      sections: r.sections || [],
    };
  });
  return json({ ok: true, roles, allSections: ALL_SECTIONS });
}

export async function saveRoleSections(req, env) {
  if (req.user.role !== 'owner') return error('Доступно только владельцу', 403);
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  await refreshRoles(env);
  const role = (body.role || '').toString();
  if (!ROLES_EFFECTIVE[role]) return error('Неизвестная роль');
  if (role === 'owner') return error('Эту роль изменять нельзя');
  const secs = (Array.isArray(body.sections) ? body.sections : []).filter(s => ALL_SECTIONS.includes(s));
  const r = await env.DB.prepare('UPDATE roles SET sections=? WHERE id=?')
    .bind(JSON.stringify(secs), role).run();
  if (!r.meta?.changes) {
    await env.DB.prepare('INSERT OR IGNORE INTO roles (id,name,sections) VALUES (?,?,?)')
      .bind(role, (ROLES_EFFECTIVE[role] || {}).name || role, JSON.stringify(secs)).run();
  }
  _rolesLoadedAt = 0;
  await refreshRoles(env);
  return json({ ok: true, role, sections: secs });
}

export async function createRole(req, env) {
  if (req.user.role !== 'owner') return error('Доступно только владельцу', 403);
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const name = (body.name || '').trim();
  if (!name) return error('Укажите название роли');
  const secs = (Array.isArray(body.sections) ? body.sections : []).filter(s => ALL_SECTIONS.includes(s));
  const id = 'role_' + randHex(4);
  await env.DB.prepare('INSERT INTO roles (id,name,sections) VALUES (?,?,?)')
    .bind(id, name, JSON.stringify(secs)).run();
  _rolesLoadedAt = 0;
  await refreshRoles(env);
  return json({ ok: true, id, name, sections: secs }, 201);
}

export async function renameRole(req, env) {
  if (req.user.role !== 'owner') return error('Доступно только владельцу', 403);
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const role = (body.role || '').toString(), name = (body.name || '').trim();
  if (!name) return error('Укажите название');
  if (role === 'owner') return error('Эту роль переименовывать нельзя');
  const r = await env.DB.prepare('UPDATE roles SET name=? WHERE id=?').bind(name, role).run();
  if (!r.meta?.changes) {
    const base = ROLES[role];
    await env.DB.prepare('INSERT OR IGNORE INTO roles (id,name,sections) VALUES (?,?,?)')
      .bind(role, name, JSON.stringify(base ? base.sections : [])).run();
    await env.DB.prepare('UPDATE roles SET name=? WHERE id=?').bind(name, role).run();
  }
  _rolesLoadedAt = 0;
  await refreshRoles(env);
  return json({ ok: true });
}

export async function deleteRole(req, env) {
  if (req.user.role !== 'owner') return error('Доступно только владельцу', 403);
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const role = (body.role || '').toString();
  if (ROLES[role]) return error('Встроенную роль удалить нельзя');
  await env.DB.prepare('DELETE FROM roles WHERE id=?').bind(role).run();
  _rolesLoadedAt = 0;
  await refreshRoles(env);
  return json({ ok: true });
}

// ─── Приглашения ──────────────────────────────────────────────────────────────

export async function createInvite(req, env) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const role = (body.role || '').trim();
  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  await refreshRoles(env);
  if (!ROLES_EFFECTIVE[role]) return error('Неизвестная роль');
  if (!email) return error('Нужен email сотрудника');
  const token = randHex(24);
  const ts = now();
  const expires = ts + INVITE_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO invites (token,clinic_id,role,name,email,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(token, req.user.clinic_id, role, name || null, email, req.user.sub, ts, expires).run();
  const base = (env.INVITE_URL_BASE || 'https://dentaly.pages.dev').replace(/\/+$/, '');
  const link = `${base}/#/invite/${token}`;
  const roleName = (ROLES_EFFECTIVE[role] || {}).name || role;
  return json({
    ok: true,
    invite: { token, role, roleName, name: name || null, email, link, expiresAt: expires },
  }, 201);
}

export async function listInvites(req, env) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  await refreshRoles(env);
  const rows = await env.DB.prepare(
    'SELECT token,role,name,email,created_at,expires_at,used_at FROM invites WHERE clinic_id=? ORDER BY created_at DESC LIMIT 100'
  ).bind(req.user.clinic_id).all();
  const ts = now();
  const items = (rows.results || []).map(r => ({
    ...r,
    roleName: (ROLES_EFFECTIVE[r.role] || { name: r.role }).name,
    status: r.used_at ? 'used' : (r.expires_at < ts ? 'expired' : 'pending'),
  }));
  return json({ ok: true, items });
}

export async function getInvite(req, env, params) {
  const inv = await env.DB.prepare(
    'SELECT token,role,name,email,expires_at,used_at FROM invites WHERE token=?'
  ).bind(params.token).first();
  if (!inv) return error('Приглашение не найдено', 404);
  if (inv.used_at) return error('Приглашение уже использовано', 410);
  if (inv.expires_at < now()) return error('Срок действия приглашения истёк', 410);
  await refreshRoles(env);
  return json({
    ok: true,
    invite: {
      role: inv.role,
      roleName: (ROLES_EFFECTIVE[inv.role] || { name: inv.role }).name,
      name: inv.name || null,
      email: inv.email || null,
    },
  });
}

export async function acceptInvite(req, env, params) {
  const inv = await env.DB.prepare(
    'SELECT token,clinic_id,role,name,email,expires_at,used_at FROM invites WHERE token=?'
  ).bind(params.token).first();
  if (!inv) return error('Приглашение не найдено', 404);
  if (inv.used_at) return error('Приглашение уже использовано', 410);
  if (inv.expires_at < now()) return error('Срок действия приглашения истёк', 410);
  await refreshRoles(env);
  if (!ROLES_EFFECTIVE[inv.role]) return error('Роль приглашения недействительна');
  let body; try { body = await req.json(); } catch { return error('Invalid JSON'); }
  const fullName = (body.name || inv.name || '').trim();
  if (!fullName) return error('Укажите имя');
  const email = (body.email || inv.email || '').trim().toLowerCase();
  if (!email) return error('Нужен email');
  const password = body.password || '';
  if (!password || password.length < 6) return error('Пароль слишком короткий (мин. 6 символов)');
  if (await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first()) {
    return error('Этот email уже используется', 409);
  }
  const passHash = await hashPassword(password);
  const initials = fullName.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  const id = uid(), ts = now();
  await env.DB.prepare(
    'INSERT INTO users (id,clinic_id,full_name,initials,role,email,password_hash,is_active,created_at) VALUES (?,?,?,?,?,?,?,1,?)'
  ).bind(id, inv.clinic_id, fullName, initials, inv.role, email, passHash, ts).run();
  await env.DB.prepare('UPDATE invites SET used_at=?, used_user_id=? WHERE token=?')
    .bind(ts, id, params.token).run();
  return json({ ok: true, user: { id, fullName, email, role: inv.role } }, 201);
}

export async function revokeInvite(req, env, params) {
  if (!isAdmin(req.user.role)) return error('Недостаточно прав', 403);
  const inv = await env.DB.prepare('SELECT token, used_at, clinic_id FROM invites WHERE token=?')
    .bind(params.token).first();
  if (!inv) return error('Приглашение не найдено', 404);
  if (inv.clinic_id !== req.user.clinic_id) return error('Недостаточно прав', 403);
  if (inv.used_at) return error('Приглашение уже использовано, отозвать нельзя', 409);
  await env.DB.prepare('DELETE FROM invites WHERE token=?').bind(params.token).run();
  return json({ ok: true });
}
