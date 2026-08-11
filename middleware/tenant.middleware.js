'use strict';

/**
 * Resuelve el tenant de la request y lo deja en `req.tenant`.
 *
 * En este sprint el ERP todavía no tiene autenticación/sesión real, así
 * que el tenant se resuelve por el header `X-Tenant-Rut` (o el RUT de
 * ALMASEND por defecto, el único tenant cargado). El punto de este
 * middleware es forzar que TODA ruta bajo /api/dte pase por acá — nunca
 * se debe leer `req.query.tenantId` ni nada equivalente directamente en
 * un handler, precisamente para no abrir una vía de cruce de tenants.
 */

const tenantsRepo = require('../db/repositories/tenants.repo');

const DEFAULT_TENANT_RUT = process.env.DEFAULT_TENANT_RUT || '78138404-6';

async function resolveTenant(req, res, next) {
  try {
    const rut = req.header('X-Tenant-Rut') || DEFAULT_TENANT_RUT;
    const tenant = await tenantsRepo.getByRut(rut);
    if (!tenant || !tenant.activo) {
      return res.status(404).json({ error: `Tenant con RUT ${rut} no existe o está inactivo` });
    }
    req.tenant = tenant;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { resolveTenant };
