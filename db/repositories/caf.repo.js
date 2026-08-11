'use strict';

const { pool } = require('../pool');

/**
 * Bloquea (FOR UPDATE) el CAF vigente más antiguo con folios disponibles
 * para tenant_id/tipo_dte. DEBE llamarse dentro de una transacción
 * (pasar el `client` de esa transacción, nunca el pool directo) — el lock
 * se libera recién al COMMIT/ROLLBACK, y es lo que evita folios duplicados
 * bajo ventas concurrentes.
 */
async function lockCafConFolioDisponible(client, tenantId, tipoDte) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, tipo_dte, folio_desde, folio_hasta, folio_actual,
            caf_key_ref, fecha_vencimiento, estado
     FROM tenant_caf
     WHERE tenant_id = $1
       AND tipo_dte = $2
       AND estado = 'vigente'
       AND folio_actual <= folio_hasta
     ORDER BY folio_desde ASC
     LIMIT 1
     FOR UPDATE`,
    [tenantId, tipoDte]
  );
  return rows[0] || null;
}

/**
 * Avanza folio_actual en 1 tras asignar `folioAsignado`. Si el rango queda
 * agotado (folio_actual > folio_hasta), marca estado = 'agotado'. Debe
 * ejecutarse con el mismo `client`/transacción que hizo el lock.
 */
async function consumirFolio(client, tenantId, cafId, folioAsignado) {
  const { rows } = await client.query(
    `UPDATE tenant_caf
     SET folio_actual = $1 + 1,
         estado = CASE WHEN $1 + 1 > folio_hasta THEN 'agotado' ELSE estado END
     WHERE id = $2 AND tenant_id = $3
     RETURNING id, folio_actual, estado`,
    [folioAsignado, cafId, tenantId]
  );
  return rows[0];
}

async function insert(
  {
    tenantId,
    tipoDte,
    folioDesde,
    folioHasta,
    folioActual,
    archivoCaf,
    cafKeyRef,
    fechaSolicitud,
    fechaVencimiento,
    estado = 'vigente',
  },
  client = pool
) {
  const { rows } = await client.query(
    `INSERT INTO tenant_caf
       (tenant_id, tipo_dte, folio_desde, folio_hasta, folio_actual, archivo_caf,
        caf_key_ref, fecha_solicitud, fecha_vencimiento, estado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, tenant_id, tipo_dte, folio_desde, folio_hasta, folio_actual, estado`,
    [
      tenantId,
      tipoDte,
      folioDesde,
      folioHasta,
      folioActual,
      archivoCaf,
      cafKeyRef,
      fechaSolicitud,
      fechaVencimiento,
      estado,
    ]
  );
  return rows[0];
}

async function listByTenant(tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, tipo_dte, folio_desde, folio_hasta, folio_actual, fecha_vencimiento, estado
     FROM tenant_caf
     WHERE tenant_id = $1
     ORDER BY tipo_dte, folio_desde`,
    [tenantId]
  );
  return rows;
}

module.exports = { lockCafConFolioDisponible, consumirFolio, insert, listByTenant };
