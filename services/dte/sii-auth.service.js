'use strict';

/**
 * services/dte/sii-auth.service.js
 *
 * Autenticación contra el SII: GetSeed -> firmar la semilla con el
 * certificado del tenant -> GetToken. El token se cachea en memoria por
 * tenant (con TTL) para no re-autenticar en cada documento — el SII limita
 * la frecuencia de este flujo.
 *
 * El cliente SOAP/mock concreto se resuelve vía services/dte/sii-client
 * (SII_CLIENT_MODE=mock|soap), así que este servicio no sabe si está
 * hablando con el ambiente real o el simulador.
 */

const tenantsRepo = require('../../db/repositories/tenants.repo');
const signatureService = require('./signature.service');
const { getClient } = require('./sii-client');

class SiiAuthError extends Error {}

const DEFAULT_TTL_MINUTES = Number(process.env.SII_TOKEN_TTL_MINUTES || 360);

/** tenantId -> { token, expiresAt } */
const tokenCache = new Map();

function buildSemillaXml(semilla) {
  return `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
}

/**
 * Devuelve un token vigente para el tenant, reutilizando el cacheado si
 * todavía no expira. `forceRefresh: true` ignora la caché (p.ej. tras un
 * rechazo del SII por token inválido/expirado).
 */
async function getToken(tenantId, { forceRefresh = false, clientMode } = {}) {
  if (!tenantId) throw new SiiAuthError('getToken requiere tenantId');

  const cached = tokenCache.get(tenantId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const tenant = await tenantsRepo.getById(tenantId);
  if (!tenant) throw new SiiAuthError(`Tenant ${tenantId} no existe`);

  const { privateKeyPem, certificatePem } = await signatureService.getCertificadoActivo(tenantId);

  const client = getClient(clientMode);
  const { semilla } = await client.getSeed(tenant.ambiente_sii);
  const semillaFirmada = signatureService.signWholeDocument(buildSemillaXml(semilla), {
    privateKeyPem,
    certificatePem,
  });
  const { token } = await client.getToken(tenant.ambiente_sii, semillaFirmada);

  if (!token) {
    throw new SiiAuthError('El SII no devolvió un token válido');
  }

  tokenCache.set(tenantId, {
    token,
    expiresAt: Date.now() + DEFAULT_TTL_MINUTES * 60 * 1000,
  });

  return token;
}

function clearCache(tenantId) {
  if (tenantId) tokenCache.delete(tenantId);
  else tokenCache.clear();
}

module.exports = { getToken, clearCache, SiiAuthError };
