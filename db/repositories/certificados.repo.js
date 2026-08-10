'use strict';

const { pool } = require('../pool');

/** Certificado activo y vigente (por fecha) de un tenant, o null. */
async function getActivoVigente(tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, certificado_ref, rut_certificado, vigencia_desde, vigencia_hasta, activo
     FROM tenant_certificados
     WHERE tenant_id = $1
       AND activo = true
       AND vigencia_desde <= CURRENT_DATE
       AND vigencia_hasta >= CURRENT_DATE
     LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

async function desactivarTodos(tenantId, client = pool) {
  await client.query(
    `UPDATE tenant_certificados SET activo = false WHERE tenant_id = $1 AND activo = true`,
    [tenantId]
  );
}

async function insert(
  { tenantId, certificadoRef, rutCertificado, vigenciaDesde, vigenciaHasta, activo = true },
  client = pool
) {
  const { rows } = await client.query(
    `INSERT INTO tenant_certificados
       (tenant_id, certificado_ref, rut_certificado, vigencia_desde, vigencia_hasta, activo)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, rut_certificado, vigencia_desde, vigencia_hasta, activo`,
    [tenantId, certificadoRef, rutCertificado, vigenciaDesde, vigenciaHasta, activo]
  );
  return rows[0];
}

module.exports = { getActivoVigente, desactivarTodos, insert };
