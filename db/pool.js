'use strict';

/**
 * Pool de conexión PostgreSQL compartido por todo el ERP.
 *
 * IMPORTANTE (aislamiento multi-tenant):
 * Este pool es intencionalmente "tonto" — no sabe nada de tenants. La regla
 * de negocio de que TODO acceso a tablas `tenant_*` / `dte_*` debe filtrar
 * por `tenant_id` vive en la capa de repositorios (`db/repositories/*.js`),
 * nunca aquí. Ver db/repositories/tenantScopedQuery.js y
 * services/dte/__tests__/tenant-isolation.test.js.
 */

require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Nunca loguear datos de conexión ni parámetros de queries aquí.
  // eslint-disable-next-line no-console
  console.error('[db] error inesperado en cliente idle del pool', err.message);
});

/**
 * Ejecuta `fn(client)` dentro de una transacción. Hace COMMIT si `fn`
 * resuelve, ROLLBACK si lanza. Uso obligatorio para asignación de folios
 * (SELECT ... FOR UPDATE) y para cualquier escritura multi-tabla del
 * módulo DTE.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // eslint-disable-next-line no-console
      console.error('[db] error durante ROLLBACK', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
