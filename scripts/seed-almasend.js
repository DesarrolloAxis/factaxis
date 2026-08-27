#!/usr/bin/env node
'use strict';

/**
 * scripts/seed-almasend.js
 *
 * Deja el tenant piloto ALMASEND SpA listo para emitir DTEs contra el
 * simulador del SII (SII_CLIENT_MODE=mock): ingesta un certificado
 * digital autofirmado y CAFs de prueba (tipos 33 y 61), reutilizando los
 * mismos fixtures que usa la suite de Jest
 * (services/dte/test-support/testHelpers.js#setupCertificadoYCaf).
 *
 * Sin esto, el tenant queda creado (migración 009_seed_tenant_almasend)
 * pero sin certificado ni folios, y el endpoint de ejemplo del README
 * (POST /api/dte/test/emitir) falla con "No hay folios disponibles".
 *
 * Idempotente: si el tenant ya tiene un certificado vigente y folios
 * disponibles para ambos tipos de documento, no hace nada. Usa --force
 * para re-ingestar de todas formas (por ejemplo, tras vaciar tenant_caf).
 *
 * Uso:
 *   npm run seed:almasend
 *   node scripts/seed-almasend.js --force
 */

require('dotenv').config();
const { pool } = require('../db/pool');
const tenantsRepo = require('../db/repositories/tenants.repo');
const certificadosRepo = require('../db/repositories/certificados.repo');
const cafRepo = require('../db/repositories/caf.repo');
const { ALMASEND_RUT, setupCertificadoYCaf } = require('../services/dte/test-support/testHelpers');

const TIPOS_DTE = [33, 61];

async function yaListo(tenantId) {
  const cert = await certificadosRepo.getActivoVigente(tenantId);
  if (!cert) return false;

  const cafs = await cafRepo.listByTenant(tenantId);
  return TIPOS_DTE.every((tipoDte) =>
    cafs.some((c) => c.tipo_dte === tipoDte && c.estado === 'vigente' && c.folio_actual <= c.folio_hasta)
  );
}

async function main() {
  const force = process.argv.includes('--force');

  const tenant = await tenantsRepo.getByRut(ALMASEND_RUT);
  if (!tenant) {
    throw new Error(
      `Tenant ALMASEND (RUT ${ALMASEND_RUT}) no existe. Corre "npm run migrate:up" primero ` +
        '(la migración 009_seed_tenant_almasend lo crea).'
    );
  }

  if (!force && (await yaListo(tenant.id))) {
    console.log(
      `[seed:almasend] tenant ${tenant.id} (${tenant.razon_social}) ya tiene certificado vigente y ` +
        `folios disponibles para tipos ${TIPOS_DTE.join(', ')} — nada que hacer (usa --force para re-ingestar).`
    );
    return;
  }

  if (force) {
    // setupCertificadoYCaf siempre ingesta el mismo rango de folios (1-folioHasta);
    // sin limpiar antes, un CAF previo con el mismo rango choca con el índice único
    // uq_tenant_caf_rango (tenant_id, tipo_dte, folio_desde, folio_hasta).
    await pool.query('DELETE FROM tenant_caf WHERE tenant_id = $1 AND tipo_dte = ANY($2)', [
      tenant.id,
      TIPOS_DTE,
    ]);
  }

  console.log(
    `[seed:almasend] ingestando certificado autofirmado + CAF (tipos ${TIPOS_DTE.join(', ')}) ` +
      `para tenant ${tenant.id} (${tenant.razon_social})...`
  );
  await setupCertificadoYCaf(tenant.id, { tiposDte: TIPOS_DTE, folioHasta: 50 });
  console.log('[seed:almasend] listo. El tenant ya puede emitir DTEs contra el simulador (SII_CLIENT_MODE=mock).');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[seed:almasend] FAILED:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { main };
