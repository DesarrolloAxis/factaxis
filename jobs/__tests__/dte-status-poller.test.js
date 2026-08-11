'use strict';

process.env.SII_CLIENT_MODE = 'mock';

const poller = require('../dte-status-poller');
const orchestrator = require('../../services/dte/dte.orchestrator');
const documentosRepo = require('../../db/repositories/documentos.repo');
const {
  resetDteTables,
  getAlmasendTenant,
  getAlmasendProductos,
  setupCertificadoYCaf,
  closePool,
} = require('../../services/dte/test-support/testHelpers');
const mockClient = require('../../services/dte/sii-client/mock.client');

describe('jobs/dte-status-poller (mock)', () => {
  let tenant;
  let productos;

  beforeEach(async () => {
    mockClient.__mock__.reset();
    mockClient.__mock__.setConsultasParaResolver(1);
    await resetDteTables();
    tenant = await getAlmasendTenant();
    productos = await getAlmasendProductos();
    await setupCertificadoYCaf(tenant.id, { tiposDte: [33], folioHasta: 10 });
  });

  afterAll(async () => {
    await closePool();
  });

  test('runOnce consulta los envios pendientes de todos los tenants activos y los resuelve', async () => {
    const r1 = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });
    const r2 = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });

    const resumen = await poller.runOnce();
    expect(resumen.consultados).toBe(2);
    expect(resumen.errores).toHaveLength(0);

    const doc1 = await documentosRepo.getById(r1.documentoId, tenant.id);
    const doc2 = await documentosRepo.getById(r2.documentoId, tenant.id);
    expect(doc1.estado_interno).toBe('aceptado');
    expect(doc2.estado_interno).toBe('aceptado');

    // segundo ciclo: nada pendiente
    const resumen2 = await poller.runOnce();
    expect(resumen2.consultados).toBe(0);
  });

  test('un error consultando un envio no detiene el polling de los demas', async () => {
    const r1 = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });
    const r2 = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });

    const original = mockClient.queryEstUp;
    let calls = 0;
    mockClient.queryEstUp = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('timeout simulado');
      return original(...args);
    };

    let resumen;
    try {
      resumen = await poller.runOnce();
    } finally {
      mockClient.queryEstUp = original;
    }

    expect(resumen.errores).toHaveLength(1);
    expect(resumen.consultados).toBe(2);

    const doc1 = await documentosRepo.getById(r1.documentoId, tenant.id);
    const doc2 = await documentosRepo.getById(r2.documentoId, tenant.id);
    // uno de los dos SI se resolvio pese al error en el otro
    const estados = [doc1.estado_interno, doc2.estado_interno];
    expect(estados).toContain('aceptado');
  });
});
