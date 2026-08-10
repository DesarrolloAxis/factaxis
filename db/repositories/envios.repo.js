'use strict';

const { pool } = require('../pool');

async function insert(
  { tenantId, dteDocumentoId, trackId = null, estadoSii = 'enviado', glosaRespuesta = null, xmlRespuesta = null },
  client = pool
) {
  const { rows } = await client.query(
    `INSERT INTO dte_envios (tenant_id, dte_documento_id, track_id, estado_sii, glosa_respuesta, xml_respuesta)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, dte_documento_id, track_id, estado_sii`,
    [tenantId, dteDocumentoId, trackId, estadoSii, glosaRespuesta, xmlRespuesta]
  );
  return rows[0];
}

async function updateEstado(
  id,
  tenantId,
  { estadoSii, glosaRespuesta = null, xmlRespuesta = null },
  client = pool
) {
  const { rows } = await client.query(
    `UPDATE dte_envios
     SET estado_sii = $3, glosa_respuesta = COALESCE($4, glosa_respuesta),
         xml_respuesta = COALESCE($5, xml_respuesta), updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING id, estado_sii`,
    [id, tenantId, estadoSii, glosaRespuesta, xmlRespuesta]
  );
  return rows[0] || null;
}

/** Envíos de UN tenant aún no resueltos (para el job de polling, invocado por tenant). */
async function listPendientesByTenant(tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, dte_documento_id, track_id, estado_sii
     FROM dte_envios
     WHERE tenant_id = $1
       AND estado_sii IN ('enviado', 'en_proceso')
       AND track_id IS NOT NULL
     ORDER BY id ASC`,
    [tenantId]
  );
  return rows;
}

module.exports = { insert, updateEstado, listPendientesByTenant };
