'use strict';

/**
 * `tenants` es la única tabla del dominio DTE que NO lleva columna
 * `tenant_id` — la fila completa ES el tenant, y su `id` cumple ese rol.
 * Por eso getById(tenantId) filtra por `id`, no por `tenant_id`; sigue
 * siendo una consulta acotada a un solo tenant.
 */

const { pool } = require('../pool');

async function getById(tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT id, rut, razon_social, giro, direccion, comuna, ambiente_sii,
            nro_resolucion_sii, fecha_resolucion_sii, activo
     FROM tenants
     WHERE id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

async function getByRut(rut, client = pool) {
  const { rows } = await client.query(
    `SELECT id, rut, razon_social, giro, direccion, comuna, ambiente_sii,
            nro_resolucion_sii, fecha_resolucion_sii, activo
     FROM tenants
     WHERE rut = $1`,
    [rut]
  );
  return rows[0] || null;
}

/**
 * Lista todos los tenants activos. Es la única consulta legítima "sin
 * filtro de tenant" del módulo: es un listado a nivel de sistema (usado
 * p.ej. por el poller para iterar tenant por tenant), no una lectura de
 * datos de negocio de un tenant específico.
 */
async function listActivos(client = pool) {
  const { rows } = await client.query(
    `SELECT id, rut, razon_social, ambiente_sii FROM tenants WHERE activo = true ORDER BY id`
  );
  return rows;
}

module.exports = { getById, getByRut, listActivos };
