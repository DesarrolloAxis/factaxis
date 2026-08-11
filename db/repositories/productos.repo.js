'use strict';

const { pool } = require('../pool');

async function getById(id, tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, sku, nombre, precio_unitario, activo
     FROM productos
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] || null;
}

module.exports = { getById };
