'use strict';

/**
 * Corre una vez antes de toda la suite de Jest: aplica migraciones
 * pendientes contra DATABASE_URL (debe apuntar a una base de datos de
 * pruebas — NUNCA producción). No hace seed adicional: la migración
 * 009_seed_tenant_almasend ya deja el tenant piloto + productos demo.
 */

require('dotenv').config();

module.exports = async function globalSetup() {
  const { up } = require('./migrate');
  const { pool } = require('../db/pool');
  await up();
  await pool.end();
};
