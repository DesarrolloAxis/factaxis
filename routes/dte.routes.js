'use strict';

/**
 * Endpoints de prueba del módulo DTE. Todos cuelgan de /api/dte y pasan
 * primero por resolveTenant (ver middleware/tenant.middleware.js): cada
 * request opera sobre UN tenant (req.tenant), nunca sobre "todos" salvo
 * el poller manual, que expone explícitamente que corre multi-tenant.
 *
 * IMPORTANTE: estos endpoints existen para poder ejercitar el pipeline
 * end-to-end (incluyendo la ingesta de certificado/CAF) mientras se
 * resuelven los trámites externos con el SII. No están pensados como la
 * superficie de API definitiva del ERP (eso incluiría auth de verdad,
 * validación de input más estricta, etc.).
 */

const express = require('express');
const { resolveTenant } = require('../middleware/tenant.middleware');
const documentosRepo = require('../db/repositories/documentos.repo');
const detalleRepo = require('../db/repositories/detalle.repo');
const cafRepo = require('../db/repositories/caf.repo');
const signatureService = require('../services/dte/signature.service');
const cafService = require('../services/dte/caf.service');
const orchestrator = require('../services/dte/dte.orchestrator');
const poller = require('../jobs/dte-status-poller');

const router = express.Router();
router.use(resolveTenant);

/** Serializa el tenant sin ningún dato sensible (nunca certificado_ref, nunca claves). */
function serializeTenant(tenant) {
  return {
    id: tenant.id,
    rut: tenant.rut,
    razonSocial: tenant.razon_social,
    ambienteSii: tenant.ambiente_sii,
  };
}

// --- Setup (bootstrap del pipeline mientras no hay cert/CAF reales) ---

/** Ingesta un certificado digital .pfx (enviado como base64) para el tenant. */
router.post('/setup/certificado', async (req, res, next) => {
  try {
    const { pfxBase64, password, rutCertificado, vigenciaDesde, vigenciaHasta } = req.body;
    if (!pfxBase64 || !password || !rutCertificado || !vigenciaDesde || !vigenciaHasta) {
      return res.status(400).json({
        error: 'Se requiere pfxBase64, password, rutCertificado, vigenciaDesde, vigenciaHasta',
      });
    }
    const result = await signatureService.ingestarCertificado({
      tenantId: req.tenant.id,
      pfxBuffer: Buffer.from(pfxBase64, 'base64'),
      password,
      rutCertificado,
      vigenciaDesde,
      vigenciaHasta,
    });
    // Nunca devolver certificado_ref ni ninguna clave — result ya viene sin eso.
    return res.status(201).json({ tenant: serializeTenant(req.tenant), certificado: result });
  } catch (err) {
    return next(err);
  }
});

/** Ingesta un CAF (XML del SII, como texto plano) para el tenant. */
router.post('/setup/caf', async (req, res, next) => {
  try {
    const { cafXml } = req.body;
    if (!cafXml) return res.status(400).json({ error: 'Se requiere cafXml' });
    const result = await cafService.ingestarCaf({ tenantId: req.tenant.id, xmlString: cafXml });
    return res.status(201).json({ tenant: serializeTenant(req.tenant), caf: result });
  } catch (err) {
    return next(err);
  }
});

/** Lista los rangos de folios del tenant, SIN exponer archivo_caf ni caf_key_ref. */
router.get('/setup/caf', async (req, res, next) => {
  try {
    const cafs = await cafRepo.listByTenant(req.tenant.id);
    return res.json({ tenant: serializeTenant(req.tenant), cafs });
  } catch (err) {
    return next(err);
  }
});

// --- Emisión ---

/**
 * Genera un DTE de prueba end-to-end a partir de una "venta simulada":
 * body: { tipoDte (33|56|61, default 33), receptor: {rut, razonSocial},
 *         items: [{productoId, cantidad, precioUnitario?, descuento?}],
 *         fechaEmision?, referenciaDocumentoId? (obligatorio si tipoDte=56/61),
 *         razonReferencia?, codRefReferencia? (1|2|3),
 *         soloReferencia? (true = NC/ND de texto, sin items),
 *         resolucion?: {nroResolucion, fechaResolucion} }
 */
router.post('/test/emitir', async (req, res, next) => {
  try {
    const {
      tipoDte = 33,
      receptor,
      items,
      fechaEmision,
      referenciaDocumentoId,
      razonReferencia,
      codRefReferencia,
      soloReferencia,
      resolucion,
    } = req.body;

    if (!receptor?.rut || !receptor?.razonSocial) {
      return res.status(400).json({ error: 'Se requiere receptor: { rut, razonSocial }' });
    }
    if (!soloReferencia && (!Array.isArray(items) || items.length === 0)) {
      return res.status(400).json({ error: 'Se requiere items: [{ productoId, cantidad }] (o soloReferencia: true)' });
    }

    const result = await orchestrator.emitir({
      tenantId: req.tenant.id,
      tipoDte,
      receptor,
      items,
      fechaEmision,
      referenciaDocumentoId,
      razonReferencia,
      codRefReferencia,
      soloReferencia,
      resolucion,
    });

    return res.status(201).json({ tenant: serializeTenant(req.tenant), ...result });
  } catch (err) {
    return next(err);
  }
});

// --- Consulta ---

router.get('/documentos', async (req, res, next) => {
  try {
    const { estado } = req.query;
    const docs = await documentosRepo.listByTenant(req.tenant.id, { estadoInterno: estado });
    return res.json({ tenant: serializeTenant(req.tenant), documentos: docs });
  } catch (err) {
    return next(err);
  }
});

router.get('/documentos/:id', async (req, res, next) => {
  try {
    const doc = await documentosRepo.getById(req.params.id, req.tenant.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado para este tenant' });
    const detalle = await detalleRepo.listByDocumento(doc.id, req.tenant.id);
    return res.json({ tenant: serializeTenant(req.tenant), documento: doc, detalle });
  } catch (err) {
    return next(err);
  }
});

/** Dispara manualmente un ciclo del poller (todos los tenants activos, no solo req.tenant). */
router.post('/poller/run', async (_req, res, next) => {
  try {
    const resumen = await poller.runOnce();
    return res.json(resumen);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
