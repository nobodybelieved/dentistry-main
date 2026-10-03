import { json, error, signJWT, verifyPassword, hashPassword, uid, now } from './api-utils.js';

const RATE_LIMIT_MAX = 5;    // попыток
const RATE_LIMIT_WIN = 900;  // секунд (15 мин)

export async function handleLogin(req, env) {
  let body;
  try { body = await req.json(); } catch { return error('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return error('email and password required');

  // Rate-limit по IP
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:login:${ip}`;
  const rlRaw = await env.AUTH_CACHE.get(rlKey);
  const attempts = rlRaw ? parseInt(rlRaw) : 0;
  if (attempts >= RATE_LIMIT_MAX) {
    return error('Too many login attempts. Try again in 15 minutes.', 429);
  }

  const user = await env.DB.prepare(
    'SELECT id, clinic_id, full_name, role, email, password_hash, is_active FROM users WHERE email = ?'
  ).bind(email.toLowerCase().trim()).first();

  if (!user || !user.is_active) {
    await incrementRateLimit(env.AUTH_CACHE, rlKey, RATE_LIMIT_WIN);
    return error('Invalid credentials', 401);
  }

  if (!user.password_hash) {
    await incrementRateLimit(env.AUTH_CACHE, rlKey, RATE_LIMIT_WIN);
    return error('Invalid credentials', 401);
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await incrementRateLimit(env.AUTH_CACHE, rlKey, RATE_LIMIT_WIN);
    return error('Invalid credentials', 401);
  }

  // Сброс rate-limit после успешного входа
  await env.AUTH_CACHE.delete(rlKey);

  // Обновить last_login_at
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now(), user.id).run();

  const payload = {
    sub: user.id,
    clinic_id: user.clinic_id,
    role: user.role,
    name: user.full_name,
  };

  const token = await signJWT(payload, env.JWT_SECRET);

  return json({
    token,
    user: {
      id: user.id,
      clinicId: user.clinic_id,
      fullName: user.full_name,
      role: user.role,
      email: user.email,
    },
  });
}

export async function handleLogout(req, env) {
  // JWT stateless — клиент просто дропает токен.
  // Если нужно инвалидировать конкретный токен — добавить blocklist в KV.
  return json({ ok: true });
}

export async function handleMe(req, env) {
  const user = await env.DB.prepare(
    `SELECT u.id, u.clinic_id, u.full_name, u.initials, u.color, u.role,
            u.specialty, u.phone, u.email, u.is_active,
            c.name AS clinic_name
     FROM users u
     LEFT JOIN clinics c ON c.id = u.clinic_id
     WHERE u.id = ?`
  ).bind(req.user.sub).first();

  if (!user) return error('User not found', 404);

  return json({
    id: user.id,
    clinicId: user.clinic_id,
    clinicName: user.clinic_name,
    fullName: user.full_name,
    initials: user.initials,
    color: user.color,
    role: user.role,
    specialty: user.specialty,
    phone: user.phone,
    email: user.email,
  });
}

// Утилита: исправить имена пациентов (восстановить UTF-8 из seed)
export async function handleFixNames(req, env) {
  if (env.ENVIRONMENT !== 'development') return error('Forbidden', 403);

  const patients = [
    ['p1',  'Айгерим Касенова',  'Аллергия на лидокаин. Только артикаин.'],
    ['p2',  'Данияр Касенов',    null],
    ['p4',  'Анастасия Иванова', 'План лечения 8 этапов. Имплантация в работе.'],
    ['p5',  'Бауржан Нурланов',  null],
    ['p9',  'Алия Турсынова',    null],
    ['p10', 'Максим Соколов',    null],
    ['p21', 'Кирилл Зайцев',     'Ребёнок Зайцевых. Боится бормашины, седация.'],
    ['p22', 'Ольга Зайцева',     null],
  ];

  for (const [id, name, note] of patients) {
    await env.DB.prepare(
      'UPDATE patients SET full_name=?, medical_note=? WHERE id=?'
    ).bind(name, note, id).run();
  }

  // Восстановить процедуры (на случай если name/price были испорчены)
  const procedures = [
    ['pr1',  'Первичная консультация',            5000,   30, 1500],
    ['pr2',  'Профгигиена Air Flow',               18000,  45, 6000],
    ['pr3',  'Лечение кариеса (1 поверхность)',    25000,  45, 9000],
    ['pr4',  'Лечение кариеса (2 поверхности)',    38000,  60, 14000],
    ['pr5',  'Лечение пульпита (1 канал)',          42000,  60, 16000],
    ['pr6',  'Лечение пульпита (3 канала)',         78000,  90, 30000],
    ['pr7',  'Удаление зуба простое',              15000,  30, 5000],
    ['pr8',  'Удаление зуба сложное',              35000,  60, 13000],
    ['pr9',  'Имплантация Straumann SLActive',     350000, 90, 185000],
    ['pr10', 'Коронка металлокерамика',            95000,  60, 38000],
    ['pr11', 'Коронка цирконий E-max',             180000, 60, 72000],
    ['pr12', 'Винир керамический',                 180000, 60, 72000],
    ['pr13', 'Брекеты Damon Q (1 челюсть)',        380000, 60, 150000],
    ['pr14', 'Элайнеры Invisalign',                1450000,60, 600000],
    ['pr15', 'Отбеливание Zoom 4',                 85000,  90, 30000],
    ['pr16', 'Лечение зуба у ребёнка',             18000,  45, 6000],
  ];
  for (const [id, name, price, dur, cost] of procedures) {
    await env.DB.prepare(
      'UPDATE procedures SET name=?, price=?, duration_min=?, cost=? WHERE id=?'
    ).bind(name, price, dur, cost, id).run();
  }

  // Врачи и пользователи
  const users = [
    ['u1', 'Платон Антонов',      'Управляющий'],
    ['d1', 'Айгерим Сатпаева',    'Терапевт'],
    ['d2', 'Тимур Жумабеков',     'Хирург-имплантолог'],
    ['d3', 'Анастасия Иванова',   'Ортодонт'],
    ['d4', 'Даурен Алимов',       'Терапевт'],
    ['d5', 'Светлана Ким',        'Гигиенист'],
    ['d6', 'Бауржан Нурланов',    'Ортопед'],
    ['d7', 'Елена Петренко',      'Детский врач'],
    ['d8', 'Рустам Карим',        'Эндодонт'],
  ];
  for (const [id, full_name, specialty] of users) {
    await env.DB.prepare(
      'UPDATE users SET full_name=?, specialty=? WHERE id=?'
    ).bind(full_name, specialty, id).run();
  }

  // Клиника
  await env.DB.prepare(
    `UPDATE clinics SET name=?, legal_name=?, address=? WHERE id=?`
  ).bind('Smile Studio', 'ТОО «Смайл Студио»', 'Алматы, пр. Достык 132', 'c1').run();

  // Кресла
  const chairs = [
    ['ch1','Кресло 1','Кабинет 1'],['ch2','Кресло 2','Кабинет 1'],['ch3','Кресло 3','Кабинет 1'],
    ['ch4','Кресло 4','Кабинет 2'],['ch5','Кресло 5','Кабинет 2'],['ch6','Кресло 6','Кабинет 2'],
  ];
  for (const [id, name, room] of chairs) {
    await env.DB.prepare('UPDATE chairs SET name=?, room=? WHERE id=?').bind(name, room, id).run();
  }

  // Категории процедур
  const procCats = [
    ['ther','Терапия'],['surg','Хирургия'],['orto','Ортодонтия'],['hyg','Гигиена'],
    ['cons','Консультация'],['prost','Ортопедия'],['endo','Эндодонтия'],['ped','Детская'],
  ];
  for (const [id, name] of procCats) {
    await env.DB.prepare('UPDATE procedure_categories SET name=? WHERE id=?').bind(name, id).run();
  }

  // Склад — позиции
  const inventory = [
    ['inv1',  'Артикаин Septanest 4% 1:200000',    'Анестезия'],
    ['inv2',  'Перчатки нитриловые M (Mercator)',   'Расходники'],
    ['inv3',  'Композит Filtek Ultimate A3',         'Пломбировочные'],
    ['inv4',  'Имплантат Straumann SLActive 4.1×10','Имплантация'],
    ['inv5',  'Боры алмазные FG (комплект)',         'Инструменты'],
    ['inv6',  'Слюноотсосы одноразовые',             'Расходники'],
    ['inv7',  'Маски трёхслойные',                   'СИЗ'],
    ['inv8',  'Цемент GC Fuji Plus',                 'Цементы'],
    ['inv9',  'Никель-титан Reciproc Blue R25',      'Эндодонтия'],
    ['inv10', 'Гипохлорит натрия 3%',               'Дезинфекция'],
    ['inv11', 'Брекет Damon Q (паз 0.022)',          'Ортодонтия'],
    ['inv12', 'Винт абатмента Straumann',            'Имплантация'],
  ];
  for (const [id, name, category] of inventory) {
    await env.DB.prepare(
      'UPDATE inventory_items SET name=?, category=? WHERE id=?'
    ).bind(name, category, id).run();
  }

  // Автоматизации
  const automations = [
    ['au1','Подтверждение записи',    'WhatsApp + Telegram за 24 ч до визита'],
    ['au2','Напоминание за 2 часа',   'WhatsApp с инструкцией как добраться'],
    ['au3','Запрос NPS',              'Telegram-опрос через 2 часа после визита'],
    ['au4','Реактивация спящих',      'Каждый понедельник пациентам без визита 6+ мес'],
    ['au5','День рождения',           'Поздравление + бонус 1000 баллов'],
    ['au6','Профосмотр через 6 мес',  'Напоминание о плановой гигиене'],
    ['au7','Должникам',               'Деликатное напоминание раз в 2 недели'],
    ['au8','Реферальная программа',   'Запрос рекомендации после 3-го визита'],
  ];
  for (const [id, name, description] of automations) {
    await env.DB.prepare(
      'UPDATE automations SET name=?, description=? WHERE id=?'
    ).bind(name, description, id).run();
  }

  // Шаблоны сообщений
  const templates = [
    ['mt1','Подтверждение записи',    'Напоминаем: {{date}} в {{time}} у Вас приём у {{doctor}}. Подтвердите, пожалуйста.'],
    ['mt2','Напоминание за 1 день',   'Завтра в {{time}} ждём Вас в Smile Studio. Доктор: {{doctor}}.'],
    ['mt3','Напоминание за 2 часа',   'Через 2 часа Ваш приём. Адрес: пр. Достык 132. До встречи!'],
    ['mt4','Запрос отзыва',           'Оцените визит от 0 до 10 — нам важно Ваше мнение'],
    ['mt5','Профосмотр через 6 мес',  '{{name}}, прошло полгода — пора на плановую гигиену. Записать Вас?'],
    ['mt6','Поздравление с днём рождения','{{name}}, поздравляем с днём рождения! Дарим 1000 бонусных баллов'],
  ];
  for (const [id, name, body] of templates) {
    await env.DB.prepare(
      'UPDATE message_templates SET name=?, body=? WHERE id=?'
    ).bind(name, body, id).run();
  }

  const total = patients.length + procedures.length + users.length + chairs.length
              + procCats.length + inventory.length + automations.length + templates.length + 1;
  return json({ ok: true, fixed: total });
}

// Утилита: сеть seed-пользователей с паролем (для dev/демо)
export async function handleSeedPasswords(req, env) {
  if (env.ENVIRONMENT !== 'development') return error('Forbidden', 403);

  const password = 'Dentaly2026!';
  const hash = await hashPassword(password);

  await env.DB.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?')
    .bind('admin@smile-studio.kz', hash, 'u1').run();

  const doctors = [
    ['d1', 'satkpaeva@smile-studio.kz'],
    ['d2', 'zhumabekov@smile-studio.kz'],
    ['d3', 'ivanova@smile-studio.kz'],
    ['d4', 'alimov@smile-studio.kz'],
    ['d5', 'kim@smile-studio.kz'],
    ['d6', 'nurlanov@smile-studio.kz'],
    ['d7', 'petrenko@smile-studio.kz'],
    ['d8', 'karim@smile-studio.kz'],
  ];

  for (const [id, email] of doctors) {
    await env.DB.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?')
      .bind(email, hash, id).run();
  }

  return json({ ok: true, password, users: doctors.length + 1 });
}

async function incrementRateLimit(kv, key, ttl) {
  const cur = await kv.get(key);
  await kv.put(key, String((cur ? parseInt(cur) : 0) + 1), { expirationTtl: ttl });
}
