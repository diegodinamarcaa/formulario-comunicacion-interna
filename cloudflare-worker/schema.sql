CREATE TABLE IF NOT EXISTS solicitudes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  solicitante TEXT NOT NULL,
  area TEXT NOT NULL,
  correo TEXT NOT NULL,
  contacto_adicional TEXT,
  tipo TEXT NOT NULL,
  tema TEXT NOT NULL,
  antecedentes TEXT NOT NULL,
  publico TEXT NOT NULL,
  accion TEXT NOT NULL,
  fecha_actividad TEXT,
  fecha_limite TEXT,
  canal_consultas TEXT,
  prioridad_sugerida TEXT NOT NULL,
  justificacion_urgencia TEXT,
  enlace TEXT,
  estado TEXT NOT NULL DEFAULT 'Nueva',
  prioridad_editorial TEXT,
  fecha_programada TEXT,
  canal_editorial TEXT,
  notas_editoriales TEXT
);

CREATE TABLE IF NOT EXISTS archivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id TEXT NOT NULL,
  nombre_original TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (solicitud_id) REFERENCES solicitudes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes(estado);
CREATE INDEX IF NOT EXISTS idx_solicitudes_prioridad ON solicitudes(prioridad_sugerida);
CREATE INDEX IF NOT EXISTS idx_solicitudes_created_at ON solicitudes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archivos_solicitud ON archivos(solicitud_id);
