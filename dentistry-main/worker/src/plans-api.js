import { json, error } from './api-utils.js';

// POST /api/patients/:id/plan  — создать план лечения
export async function createPatientPlan(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!p) return error('Patient not found', 404);

  const body = await req.json().catch(() => ({}));
  const { title, status = 'draft', variant = 'standard', discount = 0, stages = [] } = body;
  if (!title) return error('title required', 400);

  const now     = Date.now();
  const planId  = crypto.randomUUID();
  const visitId = crypto.randomUUID();
  const today   = new Date(now + 5 * 3600000).toISOString().slice(0, 10);
  const agreedAt = status === 'agreed' ? today : null;

  const stageTotal = stages.reduce((s, x) => s + (x.price || 0), 0);
  const discountedTotal = Math.round(stageTotal * (1 - discount / 100));

  const stmts = [
    env.DB.prepare(
      `INSERT INTO treatment_plans
         (id,clinic_id,patient_id,doctor_id,title,status,active_variant,discount_pct,agreed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(planId, clinicId, id, req.user.sub, title, status, variant, discount, agreedAt, now, now),

    // 3 варианта: economy=70%, standard=100%, premium=140%
    env.DB.prepare(
      `INSERT INTO plan_variants (id,plan_id,variant_key,name,subtitle,total,duration) VALUES
       (?,?,'economy','Эконом','Базовые материалы',?,?),
       (?,?,'standard','Стандарт','Оптимально',?,?),
       (?,?,'premium','Премиум','Топ материалы',?,?)`
    ).bind(
      crypto.randomUUID(), planId, Math.round(discountedTotal * 0.7), '4–5 мес',
      crypto.randomUUID(), planId, discountedTotal, '5–6 мес',
      crypto.randomUUID(), planId, Math.round(discountedTotal * 1.4), '6–7 мес',
    ),

    env.DB.prepare(
      `INSERT INTO plan_visits (id,plan_id,doctor_id,title,visit_date,duration_min,status,sort_order,created_at)
       VALUES (?,?,?,?,?,60,'planned',0,?)`
    ).bind(visitId, planId, req.user.sub,
      'Первый визит' + (stages[0] ? ' — ' + stages[0].proc : ''),
      today, now),

    ...stages.map((s, i) =>
      env.DB.prepare(
        `INSERT INTO plan_stages (id,visit_id,tooth_num,proc_name,price,status,sort_order)
         VALUES (?,?,?,?,?,'planned',?)`
      ).bind(crypto.randomUUID(), visitId, s.tooth || null, s.proc, s.price || 0, i)
    ),
  ];

  await env.DB.batch(stmts);
  return json({ ok: true, planId, visitId });
}

// PATCH /api/plans/:id  — изменить статус / вариант / скидку
export async function patchPlan(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const plan = await env.DB.prepare(
    'SELECT id FROM treatment_plans WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!plan) return error('Plan not found', 404);

  const body = await req.json().catch(() => ({}));
  const sets = []; const binds = [];
  const now = Date.now();

  if (body.status !== undefined)        { sets.push('status=?');         binds.push(body.status); }
  if (body.activeVariant !== undefined) { sets.push('active_variant=?'); binds.push(body.activeVariant); }
  if (body.discountPct !== undefined)   { sets.push('discount_pct=?');   binds.push(body.discountPct); }
  if (body.status === 'agreed')         { sets.push('agreed_at=?');      binds.push(new Date(now + 5*3600000).toISOString().slice(0,10)); }

  if (!sets.length) return error('Nothing to update', 400);
  sets.push('updated_at=?'); binds.push(now);

  await env.DB.prepare(
    `UPDATE treatment_plans SET ${sets.join(',')} WHERE id = ? AND clinic_id = ?`
  ).bind(...binds, id, clinicId).run();

  return json({ ok: true });
}

// POST /api/plans/:id/visits  — добавить визит в план
export async function addPlanVisit(req, env, _ctx, { id }) {
  const clinicId = req.user.clinic_id;
  const plan = await env.DB.prepare(
    'SELECT id FROM treatment_plans WHERE id = ? AND clinic_id = ?'
  ).bind(id, clinicId).first();
  if (!plan) return error('Plan not found', 404);

  const body = await req.json().catch(() => ({}));
  const { title, date, doctorId, durationMin = 60, stages = [] } = body;
  if (!title) return error('title required', 400);

  const now     = Date.now();
  const visitId = crypto.randomUUID();

  const maxSort = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order),0) AS m FROM plan_visits WHERE plan_id = ?'
  ).bind(id).first();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO plan_visits (id,plan_id,doctor_id,title,visit_date,duration_min,status,sort_order,created_at)
       VALUES (?,?,?,?,?,?,'planned',?,?)`
    ).bind(visitId, id, doctorId || req.user.sub, title, date || null, durationMin,
           (maxSort?.m ?? 0) + 1, now),

    ...stages.map((s, i) =>
      env.DB.prepare(
        `INSERT INTO plan_stages (id,visit_id,tooth_num,proc_name,price,status,sort_order)
         VALUES (?,?,?,?,?,'planned',?)`
      ).bind(crypto.randomUUID(), visitId, s.tooth || null, s.proc, s.price || 0, i)
    ),
  ];

  await env.DB.batch(stmts);
  return json({ ok: true, visitId });
}

// PATCH /api/plans/:planId/visits/:visitId  — редактировать визит
export async function patchPlanVisit(req, env, _ctx, { planId, visitId }) {
  const clinicId = req.user.clinic_id;
  const visit = await env.DB.prepare(
    `SELECT pv.id FROM plan_visits pv
     JOIN treatment_plans tp ON tp.id = pv.plan_id
     WHERE pv.id = ? AND tp.id = ? AND tp.clinic_id = ?`
  ).bind(visitId, planId, clinicId).first();
  if (!visit) return error('Visit not found', 404);

  const body = await req.json().catch(() => ({}));
  const sets = []; const binds = [];
  if (body.title       !== undefined) { sets.push('title=?');       binds.push(body.title); }
  if (body.visitDate   !== undefined) { sets.push('visit_date=?');  binds.push(body.visitDate || null); }
  if (body.doctorId    !== undefined) { sets.push('doctor_id=?');   binds.push(body.doctorId || null); }
  if (body.durationMin !== undefined) { sets.push('duration_min=?');binds.push(body.durationMin); }

  if (!sets.length) return error('Nothing to update', 400);
  await env.DB.prepare(
    `UPDATE plan_visits SET ${sets.join(',')} WHERE id = ?`
  ).bind(...binds, visitId).run();
  return json({ ok: true });
}

// DELETE /api/plans/:planId/stages/:sid  — удалить этап
export async function deletePlanStage(req, env, _ctx, { planId, sid }) {
  const clinicId = req.user.clinic_id;

  // проверяем что этап принадлежит плану клиники
  const stage = await env.DB.prepare(
    `SELECT ps.id, ps.visit_id FROM plan_stages ps
     JOIN plan_visits pv ON pv.id = ps.visit_id
     JOIN treatment_plans tp ON tp.id = pv.plan_id
     WHERE ps.id = ? AND tp.id = ? AND tp.clinic_id = ?`
  ).bind(sid, planId, clinicId).first();
  if (!stage) return error('Stage not found', 404);

  await env.DB.prepare('DELETE FROM plan_stages WHERE id = ?').bind(sid).run();

  // если в визите больше нет этапов — удаляем визит
  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM plan_stages WHERE visit_id = ?'
  ).bind(stage.visit_id).first();
  if ((remaining?.cnt ?? 0) === 0) {
    await env.DB.prepare('DELETE FROM plan_visits WHERE id = ?').bind(stage.visit_id).run();
  }

  return json({ ok: true });
}

// GET /api/patients/:id/plan  — активный план лечения с вариантами, визитами, этапами, платежами
export async function getPatientPlan(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const plan = await env.DB.prepare(
    `SELECT id, active_variant, discount_pct, agreed_at
     FROM treatment_plans
     WHERE patient_id = ? AND clinic_id = ? AND status != 'cancelled'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(id, req.user.clinic_id).first();

  if (!plan) return json({ plan: null });

  const [variantsRows, visitsRows, stagesRows, paymentsRows] = await Promise.all([
    env.DB.prepare(
      'SELECT variant_key, name, subtitle, total, duration FROM plan_variants WHERE plan_id = ?'
    ).bind(plan.id).all(),

    env.DB.prepare(
      `SELECT id, doctor_id, title, visit_date, duration_min, status, sort_order
       FROM plan_visits WHERE plan_id = ? ORDER BY sort_order, created_at`
    ).bind(plan.id).all(),

    env.DB.prepare(
      `SELECT ps.id, ps.visit_id, ps.tooth_num, ps.proc_name, ps.price, ps.status
       FROM plan_stages ps
       JOIN plan_visits pv ON pv.id = ps.visit_id
       WHERE pv.plan_id = ?
       ORDER BY pv.sort_order, ps.sort_order`
    ).bind(plan.id).all(),

    env.DB.prepare(
      'SELECT amount, method, paid_at FROM payments WHERE patient_id = ? AND plan_id = ? ORDER BY paid_at'
    ).bind(id, plan.id).all(),
  ]);

  const variants = {};
  for (const v of variantsRows.results) {
    variants[v.variant_key] = {
      name: v.name,
      sub: v.subtitle || '',
      total: v.total,
      duration: v.duration || '',
    };
  }

  const stagesByVisit = {};
  for (const s of stagesRows.results) {
    if (!stagesByVisit[s.visit_id]) stagesByVisit[s.visit_id] = [];
    stagesByVisit[s.visit_id].push({
      id: s.id,
      tooth: s.tooth_num,
      proc: s.proc_name,
      price: s.price,
      status: s.status,
    });
  }

  const visits = visitsRows.results.map(v => ({
    id: v.id,
    date: v.visit_date || '',
    title: v.title,
    docId: v.doctor_id,
    duration: v.duration_min,
    status: v.status,
    stages: stagesByVisit[v.id] || [],
  }));

  const payments = paymentsRows.results.map(pm => ({
    d: pm.paid_at,
    amt: pm.amount,
    m: pm.method || '',
  }));

  return json({
    plan: {
      id: plan.id,
      agreedAt: plan.agreed_at || '',
      discount: plan.discount_pct || 0,
      activeVariant: plan.active_variant || 'standard',
      variants,
      visits,
      payments,
    },
  });
}

// GET /api/treatment-plans  — все планы клиники
export async function listTreatmentPlans(req, env) {
  const clinicId = req.user.clinic_id;
  const url = new URL(req.url);
  const status = url.searchParams.get('status') || 'all';

  let where = `WHERE tp.clinic_id = ? AND tp.status != 'cancelled'`;
  const binds = [clinicId];
  if (status !== 'all') { where += ' AND tp.status = ?'; binds.push(status); }

  const rows = await env.DB.prepare(
    `SELECT
       tp.id, tp.title, tp.status, tp.active_variant,
       tp.discount_pct, tp.agreed_at, tp.created_at,
       p.id AS patient_id, p.full_name AS patient_name, p.phone, p.tag,
       u.full_name AS doctor_name, u.initials AS doctor_initials, u.color AS doctor_color,
       pv.total AS variant_total,
       (SELECT COUNT(*) FROM plan_stages ps
        JOIN plan_visits v2 ON v2.id = ps.visit_id WHERE v2.plan_id = tp.id) AS stages_total,
       (SELECT COUNT(*) FROM plan_stages ps
        JOIN plan_visits v2 ON v2.id = ps.visit_id
        WHERE v2.plan_id = tp.id AND ps.status = 'done') AS stages_done,
       (SELECT ps2.proc_name FROM plan_stages ps2
        JOIN plan_visits v3 ON v3.id = ps2.visit_id
        WHERE v3.plan_id = tp.id AND ps2.status = 'planned'
        ORDER BY v3.sort_order, ps2.sort_order LIMIT 1) AS next_step
     FROM treatment_plans tp
     JOIN patients p ON p.id = tp.patient_id
     LEFT JOIN users u ON u.id = tp.doctor_id
     LEFT JOIN plan_variants pv
       ON pv.plan_id = tp.id AND pv.variant_key = tp.active_variant
     ${where}
     ORDER BY tp.created_at DESC LIMIT 100`
  ).bind(...binds).all();

  const plans = (rows.results || []).map(r => ({
    id: r.id,
    title: r.title,
    status: r.status,
    agreedAt: r.agreed_at || '',
    createdAt: r.created_at,
    variantTotal: r.variant_total || 0,
    discountPct: r.discount_pct || 0,
    stagesTotal: r.stages_total || 0,
    stagesDone: r.stages_done || 0,
    nextStep: r.next_step || '',
    patient: { id: r.patient_id, name: r.patient_name, phone: r.phone || '', tag: r.tag || 'active' },
    doctor: { name: r.doctor_name || '', initials: r.doctor_initials || '?', color: r.doctor_color || '#0F766E' },
  }));

  const totalAmount = plans.reduce((s, p) => s + p.variantTotal, 0);
  return json({
    plans,
    summary: {
      total: plans.length,
      active: plans.filter(p => p.status === 'active').length,
      draft: plans.filter(p => p.status === 'draft').length,
      totalAmount,
      avgAmount: plans.length ? Math.round(totalAmount / plans.length) : 0,
    },
  });
}

// GET /api/patients/:id/visits  — история записей пациента (приёмы)
export async function getPatientVisits(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const rows = await env.DB.prepare(
    `SELECT a.starts_at, a.duration_min, a.price, a.status,
            u.full_name AS doctor_name, u.initials AS doctor_initials, u.color AS doctor_color,
            pr.name AS procedure_name
     FROM appointments a
     LEFT JOIN users u ON u.id = a.doctor_id
     LEFT JOIN procedures pr ON pr.id = a.procedure_id
     WHERE a.patient_id = ? AND a.clinic_id = ? AND a.status NOT IN ('cancelled','noshow')
     ORDER BY a.starts_at DESC
     LIMIT 50`
  ).bind(id, req.user.clinic_id).all();

  return json({
    visits: rows.results.map(r => ({
      startsAt: r.starts_at,
      durationMin: r.duration_min,
      price: r.price,
      status: r.status,
      doctorName: r.doctor_name,
      doctorInitials: r.doctor_initials,
      doctorColor: r.doctor_color,
      procedureName: r.procedure_name,
    })),
  });
}

// GET /api/patients/:id/finance  — финансовые транзакции и статистика
export async function getPatientFinance(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const [txRows, totalPaid, avgCheck] = await Promise.all([
    env.DB.prepare(
      `SELECT kind, title, amount, method, status, tx_date
       FROM transactions
       WHERE patient_id = ? AND clinic_id = ?
       ORDER BY tx_date DESC LIMIT 50`
    ).bind(id, req.user.clinic_id).all(),

    env.DB.prepare(
      'SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE patient_id = ? AND clinic_id = ?'
    ).bind(id, req.user.clinic_id).first(),

    env.DB.prepare(
      `SELECT COALESCE(AVG(price),0) AS avg
       FROM appointments
       WHERE patient_id = ? AND clinic_id = ? AND status = 'done' AND price IS NOT NULL`
    ).bind(id, req.user.clinic_id).first(),
  ]);

  return json({
    totalPaid: totalPaid?.total ?? 0,
    avgCheck: Math.round(avgCheck?.avg ?? 0),
    transactions: txRows.results.map(r => ({
      d: r.tx_date,
      t: r.title || '',
      amt: r.amount,
      m: r.method || '',
      s: r.status || 'paid',
    })),
  });
}
