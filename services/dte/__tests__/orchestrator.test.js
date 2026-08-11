'use strict';

process.env.SII_CLIENT_MODE = 'mock';

const orchestrator = require('../dte.orchestrator');
const documentosRepo = require('../../../db/repositories/documentos.repo');
const detalleRepo = require('../../../db/repositories/detalle.repo');
const signatureService = require('../signature.service');
const {
  resetDteTables,
  getAlmasendTenant,
  getAlmasendProductos,
  setupCertificadoYCaf,
  closePool,
} = require('../test-support/testHelpers');
const mockClient = require('../sii-client/mock.client');

describe('dte.orchestrator (end-to-end contra el mock del SII)', () => {
  let tenant;
  let productos;

  beforeEach(async () => {
    mockClient.__mock__.reset();
    await resetDteTables();
    tenant = await getAlmasendTenant();
    productos = await getAlmasendProductos();
    await setupCertificadoYCaf(tenant.id, { tiposDte: [33, 61], folioHasta: 20 });
  });

  afterAll(async () => {
    await closePool();
  });

  test('emite una Factura (33) end-to-end: folio, TED, firma, envio y persistencia', async () => {
    const result = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente Ejemplo' },
      items: [
        { productoId: productos[0].id, cantidad: 2 },
        { productoId: productos[1].id, cantidad: 1, descuento: 1000 },
      ],
      fechaEmision: '2026-08-10',
      resolucion: { nroResolucion: '80', fechaResolucion: '2024-01-01' },
    });

    expect(result.folio).toBe(1);
    expect(result.estadoInterno).toBe('enviado');
    expect(result.trackId).toMatch(/^MOCK-/);

    const doc = await documentosRepo.getById(result.documentoId, tenant.id);
    expect(doc.estado_interno).toBe('enviado');
    expect(doc.xml_dte).toContain('<Signature');
    expect(Number(doc.monto_neto)).toBe(2 * 50000 + (15000 - 1000));

    const { certificatePem } = await signatureService.getCertificadoActivo(tenant.id);
    expect(signatureService.verifySignature(doc.xml_dte, certificatePem)).toBe(true);

    const detalle = await detalleRepo.listByDocumento(result.documentoId, tenant.id);
    expect(detalle).toHaveLength(2);
  });

  test('folios consecutivos entre documentos del mismo tenant/tipo', async () => {
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
    expect(r1.folio).toBe(1);
    expect(r2.folio).toBe(2);
  });

  test('una Nota de Credito (61) referencia correctamente la Factura original', async () => {
    const factura = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente Ejemplo' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });

    const nc = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 61,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente Ejemplo' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
      referenciaDocumentoId: factura.documentoId,
      razonReferencia: 'Anula Factura por error',
    });

    const ncDoc = await documentosRepo.getById(nc.documentoId, tenant.id);
    expect(ncDoc.referencia_documento_id).toBe(factura.documentoId);
    expect(ncDoc.xml_dte).toContain('<Referencia>');
    expect(ncDoc.xml_dte).toContain(`<FolioRef>${factura.folio}</FolioRef>`);
    expect(ncDoc.xml_dte).toContain('<TpoDocRef>33</TpoDocRef>');
  });

  test('una Nota de Credito (61) exige referenciaDocumentoId', async () => {
    await expect(
      orchestrator.emitir({
        tenantId: tenant.id,
        tipoDte: 61,
        receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
        items: [{ productoId: productos[0].id, cantidad: 1 }],
      })
    ).rejects.toThrow(orchestrator.OrchestratorError);
  });

  test('sin certificado vigente, no se asigna folio (falla antes)', async () => {
    // tenant nuevo sin certificado ni CAF
    const { pool } = require('../../../db/pool');
    const nuevo = await pool.query(
      `INSERT INTO tenants (rut, razon_social, giro, direccion, comuna, ambiente_sii)
       VALUES ('22222222-2', 'Sin Certificado SpA', 'Giro', 'Dir', 'Comuna', 'certificacion') RETURNING id`
    );
    const tenantSinCert = nuevo.rows[0].id;

    await expect(
      orchestrator.emitir({
        tenantId: tenantSinCert,
        tipoDte: 33,
        receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
        items: [{ productoId: productos[0].id, cantidad: 1 }],
      })
    ).rejects.toThrow(/certificado/);

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantSinCert]);
  });

  test('REGLA DURA: si el pipeline falla despues de asignar folio, el folio NO se reutiliza', async () => {
    const { pool } = require('../../../db/pool');

    const folioAntes = (
      await pool.query('SELECT folio_actual FROM tenant_caf WHERE tenant_id = $1 AND tipo_dte = 33', [tenant.id])
    ).rows[0].folio_actual;

    const original = mockClient.enviarDte;
    mockClient.enviarDte = async () => {
      throw new Error('SII caido (simulado)');
    };

    let documentoIdConError;
    try {
      await expect(
        orchestrator.emitir({
          tenantId: tenant.id,
          tipoDte: 33,
          receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
          items: [{ productoId: productos[0].id, cantidad: 1 }],
          fechaEmision: '2026-08-10',
        })
      ).rejects.toThrow(orchestrator.OrchestratorError);
    } finally {
      mockClient.enviarDte = original;
    }

    const folioDespues = (
      await pool.query('SELECT folio_actual FROM tenant_caf WHERE tenant_id = $1 AND tipo_dte = 33', [tenant.id])
    ).rows[0].folio_actual;
    expect(folioDespues).toBe(folioAntes + 1); // el folio avanzo y quedo consumido

    const docs = await documentosRepo.listByTenant(tenant.id, { estadoInterno: 'error' });
    expect(docs).toHaveLength(1);
    expect(docs[0].folio).toBe(folioAntes);

    // Un siguiente documento exitoso debe recibir el folio SIGUIENTE, nunca el que quedo en error.
    const siguiente = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '66666666-6', razonSocial: 'Cliente' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });
    expect(siguiente.folio).toBe(folioDespues);
  });
});
