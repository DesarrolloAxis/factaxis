'use strict';

const { pool } = require('../pool');

async function insert(
  {
    tenantId,
    tipoDte,
    folio,
    fechaEmision,
    rutReceptor,
    razonSocialReceptor,
    montoNeto,
    montoIva,
    montoTotal,
    estadoInterno = 'borrador',
    referenciaDocumentoId = null,
  },
  client = pool
) {
  const { rows } = await client.query(
    `INSERT INTO dte_documentos
       (tenant_id, tipo_dte, folio, fecha_emision, rut_receptor, razon_social_receptor,
        monto_neto, monto_iva, monto_total, estado_interno, referencia_documento_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, tenant_id, tipo_dte, folio, estado_interno`,
    [
      tenantId,
      tipoDte,
      folio,
      fechaEmision,
      rutReceptor,
      razonSocialReceptor,
      montoNeto,
      montoIva,
      montoTotal,
      estadoInterno,
      referenciaDocumentoId,
    ]
  );
  return rows[0];
}

async function getById(id, tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, tipo_dte, folio, fecha_emision, rut_receptor, razon_social_receptor,
            monto_neto, monto_iva, monto_total, xml_dte, estado_interno, referencia_documento_id
     FROM dte_documentos
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] || null;
}

async function updateEstado(id, tenantId, estadoInterno, client = pool) {
  const { rows } = await client.query(
    `UPDATE dte_documentos
     SET estado_interno = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING id, estado_interno`,
    [id, tenantId, estadoInterno]
  );
  return rows[0] || null;
}

async function setXmlYEstado(id, tenantId, xmlDte, estadoInterno, client = pool) {
  const { rows } = await client.query(
    `UPDATE dte_documentos
     SET xml_dte = $3, estado_interno = $4, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING id, estado_interno`,
    [id, tenantId, xmlDte, estadoInterno]
  );
  return rows[0] || null;
}

async function listByTenant(tenantId, { estadoInterno } = {}, client = pool) {
  if (estadoInterno) {
    const { rows } = await client.query(
      `SELECT id, tipo_dte, folio, fecha_emision, rut_receptor, monto_total, estado_interno
       FROM dte_documentos
       WHERE tenant_id = $1 AND estado_interno = $2
       ORDER BY id DESC`,
      [tenantId, estadoInterno]
    );
    return rows;
  }
  const { rows } = await client.query(
    `SELECT id, tipo_dte, folio, fecha_emision, rut_receptor, monto_total, estado_interno
     FROM dte_documentos
     WHERE tenant_id = $1
     ORDER BY id DESC`,
    [tenantId]
  );
  return rows;
}

module.exports = { insert, getById, updateEstado, setXmlYEstado, listByTenant };
