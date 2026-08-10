'use strict';

require('dotenv').config();
const { pool } = require('../../../db/pool');
const tenantsRepo = require('../../../db/repositories/tenants.repo');

const ALMASEND_RUT = '78138404-6';

/** Limpia todas las tablas transaccionales del módulo DTE (deja tenants/productos intactos). */
async function resetDteTables() {
  await pool.query(`
    TRUNCATE TABLE dte_eventos_receptor, dte_envios, dte_detalle, dte_documentos,
      tenant_caf, tenant_certificados, vault_secrets
    RESTART IDENTITY CASCADE
  `);
}

async function getAlmasendTenant() {
  return tenantsRepo.getByRut(ALMASEND_RUT);
}

async function getAlmasendProductos() {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.precio_unitario FROM productos p
     JOIN tenants t ON t.id = p.tenant_id
     WHERE t.rut = $1 ORDER BY p.id`,
    [ALMASEND_RUT]
  );
  return rows;
}

async function closePool() {
  await pool.end();
}

/** Ingesta certificado autofirmado + CAF(s) de prueba para un tenant, listo para emitir. */
async function setupCertificadoYCaf(tenantId, { tiposDte = [33, 61], folioHasta = 50 } = {}) {
  const { buildSelfSignedCertFixture } = require('../__fixtures__/generate-cert-fixture');
  const { buildCafXml } = require('../__fixtures__/generate-caf-fixture');
  const signatureService = require('../signature.service');
  const cafService = require('../caf.service');

  const tenant = await tenantsRepo.getById(tenantId);
  const cert = buildSelfSignedCertFixture({ rut: tenant.rut, commonName: tenant.razon_social });
  await signatureService.ingestarCertificado({
    tenantId,
    pfxBuffer: cert.pfxBuffer,
    password: cert.password,
    rutCertificado: tenant.rut,
    vigenciaDesde: '2026-01-01',
    vigenciaHasta: '2027-01-01',
  });

  for (const tipoDte of tiposDte) {
    const caf = buildCafXml({
      rutEmisor: tenant.rut,
      razonSocial: tenant.razon_social,
      tipoDte,
      folioDesde: 1,
      folioHasta,
      fechaAutorizacion: '2026-01-01',
    });
    await cafService.ingestarCaf({ tenantId, xmlString: caf.xml });
  }

  return { certificatePem: cert.certificatePem };
}

module.exports = {
  ALMASEND_RUT,
  resetDteTables,
  getAlmasendTenant,
  getAlmasendProductos,
  setupCertificadoYCaf,
  closePool,
};
