import { json, error } from './api-utils.js';

const EXT_COLOR = {
  dicom: '#7C3AED', jpg: '#0891B2', jpeg: '#0891B2', png: '#0891B2',
  stl: '#059669', pdf: '#DC2626', mp4: '#D97706', heic: '#0891B2',
};

// GET /api/patients/:id/files  — список файлов + документов
export async function listPatientFiles(req, env, _ctx, { id }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();
  if (!p) return error('Patient not found', 404);

  const [filesRows, docsRows] = await Promise.all([
    env.DB.prepare(
      `SELECT f.id, f.name, f.kind, f.ext, f.size_bytes, f.tooth_num, f.r2_key, f.created_at,
              u.full_name AS uploaded_by
       FROM files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.patient_id = ? AND f.clinic_id = ?
       ORDER BY f.created_at DESC`
    ).bind(id, req.user.clinic_id).all(),

    env.DB.prepare(
      `SELECT gd.id, gd.number AS name, 'pdf' AS ext, 'document' AS kind,
              gd.r2_key, gd.signed_at, gd.status, gd.created_at
       FROM generated_documents gd
       WHERE gd.patient_id = ?
       ORDER BY gd.created_at DESC`
    ).bind(id).all(),
  ]);

  const files = filesRows.results.map(r => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    ext: r.ext || 'bin',
    sizeBytes: r.size_bytes,
    toothNum: r.tooth_num,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    color: EXT_COLOR[r.ext] || '#64748B',
    isDocument: false,
  }));

  const docs = docsRows.results.map(r => ({
    id: r.id,
    name: r.name,
    kind: 'document',
    ext: 'pdf',
    sizeBytes: null,
    signedAt: r.signed_at,
    status: r.status,
    createdAt: r.created_at,
    color: '#DC2626',
    isDocument: true,
  }));

  return json({ items: [...files, ...docs].sort((a, b) => b.createdAt - a.createdAt) });
}

// GET /api/patients/:id/files/:fileId/download  — прокси R2 (с auth)
export async function downloadPatientFile(req, env, _ctx, { id, fileId }) {
  const p = await env.DB.prepare(
    'SELECT id FROM patients WHERE id = ? AND clinic_id = ?'
  ).bind(id, req.user.clinic_id).first();

  if (!p) return error('Patient not found', 404);

  const meta = await env.DB.prepare(
    'SELECT r2_key, name, ext FROM files WHERE id = ? AND patient_id = ?'
  ).bind(fileId, id).first();

  if (!meta) return error('File not found', 404);

  return error('File storage is temporarily unavailable', 503);
}
