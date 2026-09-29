const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx','jpg','jpeg','png','webp','mp4','mov','m4v'
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(null, 204, env);

    try {
      if (request.method === 'POST' && url.pathname === '/api/solicitudes') {
        return await createSolicitud(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/solicitudes') {
        requireAdmin(request, env);
        return await listSolicitudes(url, env);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/solicitudes/')) {
        requireAdmin(request, env);
        const id = decodeURIComponent(url.pathname.split('/').pop());
        return await getSolicitud(id, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/archivo') {
        requireAdmin(request, env);
        const key = url.searchParams.get('key');
        return await getArchivo(key, env);
      }

      return corsResponse({ ok:false, error:'Ruta no encontrada' }, 404, env);
    } catch (err) {
      const status = err?.status || 500;
      return corsResponse({ ok:false, error: err?.message || 'Error interno' }, status, env);
    }
  }
};

async function createSolicitud(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (env.ALLOWED_ORIGIN && origin && !origin.startsWith(env.ALLOWED_ORIGIN)) {
    throw httpError(403, 'Origen no autorizado');
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    throw httpError(415, 'El formulario debe enviarse como multipart/form-data');
  }

  const form = await request.formData();
  const files = form.getAll('Adjuntos[]').filter(v => v instanceof File && v.size > 0);
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.size;
    const ext = extensionOf(file.name);
    if (!ALLOWED_EXTENSIONS.has(ext)) throw httpError(400, `Tipo de archivo no permitido: ${file.name}`);
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw httpError(413, 'Los adjuntos superan el límite total de 10 MB');

  const publicos = [
    ['Público - Dirección del SSM','Dirección del SSM'],
    ['Público - Jefaturas','Jefaturas'],
    ['Público - Toda la red','Toda la red']
  ].filter(([k]) => form.get(k) === 'Sí').map(([,v]) => v);

  const data = {
    solicitante: text(form, 'Solicitante', true),
    area: text(form, 'Área', true),
    correo: text(form, 'Correo institucional', true),
    contacto_adicional: text(form, 'Contacto técnico adicional'),
    tipo: text(form, 'Tipo de información', true),
    tema: text(form, 'Tema', true),
    antecedentes: text(form, 'Antecedentes', true),
    publico: publicos.join(', '),
    accion: text(form, 'Acción esperada', true),
    fecha_actividad: text(form, 'Fecha de actividad'),
    fecha_limite: text(form, 'Fecha límite de acción'),
    canal_consultas: text(form, 'Canal de consultas'),
    prioridad_sugerida: text(form, 'Prioridad sugerida', true),
    justificacion_urgencia: text(form, 'Justificación de urgencia'),
    enlace: text(form, 'Enlace')
  };

  if (!data.publico) throw httpError(400, 'Debes seleccionar al menos un público objetivo');
  if (!isInstitutionalEmail(data.correo)) throw httpError(400, 'Ingresa un correo institucional válido');
  if (data.prioridad_sugerida === 'Urgente' && !data.justificacion_urgencia) {
    throw httpError(400, 'Debes justificar por qué la solicitud es urgente');
  }

  const now = new Date();
  const id = buildId(now);
  const createdAt = now.toISOString();

  await env.DB.prepare(`
    INSERT INTO solicitudes (
      id, created_at, solicitante, area, correo, contacto_adicional, tipo, tema,
      antecedentes, publico, accion, fecha_actividad, fecha_limite, canal_consultas,
      prioridad_sugerida, justificacion_urgencia, enlace, estado
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Nueva')
  `).bind(
    id, createdAt, data.solicitante, data.area, data.correo, data.contacto_adicional,
    data.tipo, data.tema, data.antecedentes, data.publico, data.accion,
    data.fecha_actividad, data.fecha_limite, data.canal_consultas,
    data.prioridad_sugerida, data.justificacion_urgencia, data.enlace
  ).run();

  const savedFiles = [];
  try {
    for (const file of files) {
      const safe = safeFilename(file.name);
      const key = `${id}/${crypto.randomUUID()}-${safe}`;
      await env.FILES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { solicitudId: id, originalName: file.name }
      });
      await env.DB.prepare(`
        INSERT INTO archivos (solicitud_id, nombre_original, r2_key, content_type, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, file.name, key, file.type || '', file.size, createdAt).run();
      savedFiles.push({ name:file.name, size:file.size, key });
    }
  } catch (e) {
    for (const f of savedFiles) await env.FILES.delete(f.key).catch(() => {});
    await env.DB.prepare('DELETE FROM archivos WHERE solicitud_id = ?').bind(id).run().catch(() => {});
    await env.DB.prepare('DELETE FROM solicitudes WHERE id = ?').bind(id).run().catch(() => {});
    throw httpError(500, 'No fue posible guardar los archivos. La solicitud no fue registrada; inténtalo nuevamente.');
  }

  const emailResult = await maybeSendNotification(env, { id, createdAt, ...data, files:savedFiles });

  return corsResponse({
    ok:true,
    id,
    message:'Solicitud registrada correctamente',
    notification: emailResult
  }, 201, env);
}

async function listSolicitudes(url, env) {
  const estado = url.searchParams.get('estado');
  const prioridad = url.searchParams.get('prioridad');
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 250);
  const where = [];
  const binds = [];
  if (estado) { where.push('estado = ?'); binds.push(estado); }
  if (prioridad) { where.push('prioridad_sugerida = ?'); binds.push(prioridad); }
  const sql = `SELECT * FROM solicitudes ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);
  const result = await env.DB.prepare(sql).bind(...binds).all();
  return corsResponse({ ok:true, solicitudes:result.results }, 200, env);
}

async function getSolicitud(id, env) {
  const solicitud = await env.DB.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(id).first();
  if (!solicitud) throw httpError(404, 'Solicitud no encontrada');
  const archivos = await env.DB.prepare('SELECT id, nombre_original, r2_key, content_type, size_bytes, created_at FROM archivos WHERE solicitud_id = ? ORDER BY id').bind(id).all();
  return corsResponse({ ok:true, solicitud, archivos:archivos.results }, 200, env);
}

async function getArchivo(key, env) {
  if (!key) throw httpError(400, 'Falta key');
  const object = await env.FILES.get(key);
  if (!object) throw httpError(404, 'Archivo no encontrado');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${safeFilename(object.customMetadata?.originalName || 'archivo')}"`);
  headers.set('Cache-Control','private, no-store');
  return new Response(object.body, { headers });
}

async function maybeSendNotification(env, data) {
  if (env.MAIL_PROVIDER !== 'brevo' || !env.BREVO_API_KEY || !env.NOTIFY_EMAIL || !env.SENDER_EMAIL) {
    return { sent:false, reason:'not-configured' };
  }

  const html = buildEmailHtml(data);
  const subject = `[${data.prioridad_sugerida}] ${data.id} · ${data.tema}`;
  const payload = {
    sender: { name: 'Comunicación Interna SSM', email: env.SENDER_EMAIL },
    to: [{ email: env.NOTIFY_EMAIL }],
    replyTo: { email: data.correo, name: data.solicitante },
    subject,
    htmlContent: html
  };

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'api-key':env.BREVO_API_KEY },
    body:JSON.stringify(payload)
  });
  if (!r.ok) return { sent:false, reason:`provider-${r.status}` };
  return { sent:true };
}

function buildEmailHtml(d) {
  const priorityColor = {
    'Urgente':'#d93644','Importante':'#ed8b00','Programable':'#2f75b5','Complementaria':'#6b7785'
  }[d.prioridad_sugerida] || '#2f75b5';
  const files = d.files.length
    ? d.files.map(f => `<tr><td style="padding:7px 0;border-bottom:1px solid #edf0f3">📎 ${esc(f.name)}</td><td style="text-align:right;color:#6b7785">${formatBytes(f.size)}</td></tr>`).join('')
    : '<tr><td style="padding:7px 0;color:#6b7785">Sin archivos adjuntos</td></tr>';

  return `<!doctype html><html><body style="margin:0;background:#f3f6f9;font-family:Arial,Helvetica,sans-serif;color:#263238">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6f9;padding:24px 8px"><tr><td align="center">
  <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #d9e2ea">
    <tr><td style="background:#17365d;padding:26px 30px;color:#fff"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.8">Servicio de Salud Maule · Comunicación Interna</div><div style="font-size:25px;font-weight:700;margin-top:8px">Nueva solicitud recibida</div><div style="font-size:14px;margin-top:6px;opacity:.9">${esc(d.id)} · ${formatDateTime(d.createdAt)}</div></td></tr>
    <tr><td style="padding:28px 30px">
      <div style="display:inline-block;background:${priorityColor};color:#fff;font-weight:700;padding:7px 11px;border-radius:20px;font-size:12px">${esc(d.prioridad_sugerida.toUpperCase())}</div>
      <h1 style="font-size:23px;color:#17365d;margin:14px 0 22px;line-height:1.25">${esc(d.tema)}</h1>
      ${emailRow('Solicita', d.solicitante)}
      ${emailRow('Área / Unidad', d.area)}
      ${emailRow('Tipo', d.tipo)}
      ${emailRow('Público', d.publico)}
      ${emailRow('Acción esperada', d.accion)}
      ${d.fecha_actividad ? emailRow('Fecha actividad', formatDate(d.fecha_actividad)) : ''}
      ${d.fecha_limite ? emailRow('Fecha límite', formatDate(d.fecha_limite)) : ''}
      <div style="margin:25px 0 8px;font-weight:700;color:#17365d">Antecedentes</div>
      <div style="background:#f7f9fb;border:1px solid #e0e6eb;border-radius:12px;padding:16px;line-height:1.55;white-space:pre-wrap">${esc(d.antecedentes)}</div>
      ${d.justificacion_urgencia ? `<div style="margin:18px 0 8px;font-weight:700;color:#d93644">Justificación de urgencia</div><div style="background:#fff2f3;border:1px solid #f3c7cc;border-radius:12px;padding:14px;line-height:1.5">${esc(d.justificacion_urgencia)}</div>` : ''}
      <div style="margin:25px 0 8px;font-weight:700;color:#17365d">Material recibido</div>
      <table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">${files}</table>
      ${d.enlace ? `<div style="margin-top:14px"><b>Enlace de apoyo:</b> <a href="${escAttr(d.enlace)}" style="color:#2f75b5">Abrir enlace</a></div>` : ''}
      <div style="margin-top:24px;background:#fff8ec;border:1px solid #f0d9ac;border-radius:12px;padding:14px;font-size:13px;line-height:1.5"><b>Prioridad pendiente de revisión editorial.</b><br>La clasificación informada por el área solicitante es referencial. Comunicación Interna determinará la prioridad, canal y programación definitiva.</div>
      <div style="margin-top:22px;font-size:13px;color:#6b7785">Responder a este correo dirigirá la respuesta a <b>${esc(d.correo)}</b>.</div>
    </td></tr>
  </table></td></tr></table></body></html>`;
}

function emailRow(label, value) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-bottom:1px solid #edf0f3"><tr><td style="padding:9px 0;width:165px;color:#6b7785;font-size:13px">${esc(label)}</td><td style="padding:9px 0;font-size:14px;font-weight:600">${esc(value || '—')}</td></tr></table>`;
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) throw httpError(503, 'Acceso administrativo no configurado');
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) throw httpError(401, 'No autorizado');
}

function text(form, key, required=false) {
  const value = String(form.get(key) || '').trim();
  if (required && !value) throw httpError(400, `Falta: ${key}`);
  return value.slice(0, 5000);
}

function isInstitutionalEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function buildId(d) {
  const p = n => String(n).padStart(2,'0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `CI-${stamp}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
}

function extensionOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
function safeFilename(name) { return String(name).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120) || 'archivo'; }
function formatBytes(n) { return n < 1024*1024 ? `${Math.round(n/1024)} KB` : `${(n/1024/1024).toFixed(1)} MB`; }
function formatDate(s) { if (!s) return ''; const [y,m,d] = s.split('-'); return `${d}-${m}-${y}`; }
function formatDateTime(s) { return new Intl.DateTimeFormat('es-CL',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Santiago'}).format(new Date(s)); }
function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function escAttr(s='') { return esc(s); }
function httpError(status, message) { const e = new Error(message); e.status=status; return e; }

function corsResponse(data, status, env) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary':'Origin'
  });
  if (status === 204) return new Response(null,{status,headers});
  headers.set('Content-Type','application/json; charset=utf-8');
  return new Response(JSON.stringify(data),{status,headers});
}
