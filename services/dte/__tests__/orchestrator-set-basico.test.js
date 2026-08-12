'use strict';

/**
 * Tests para los ajustes que surgieron de revisar el SET BASICO real de
 * certificación del SII (atención 4816286) para ALMASEND SpA: estructura
 * <DTE> real, Acteco/TasaIVA, RutEnvia = mandatario, CodRef, y Notas de
 * Crédito/Débito "sin detalle" (solo texto).
 */

process.env.SII_CLIENT_MODE = 'mock';

const orchestrator = require('../dte.orchestrator');
const signatureService = require('../signature.service');
const documentosRepo = require('../../../db/repositories/documentos.repo');
const {
  resetDteTables,
  getAlmasendTenant,
  getAlmasendProductos,
  setupCertificadoYCaf,
  closePool,
} = require('../test-support/testHelpers');
const mockClient = require('../sii-client/mock.client');
const { buildSelfSignedCertFixture } = require('../__fixtures__/generate-cert-fixture');
const { pool } = require('../../../db/pool');

describe('dte.orchestrator — ajustes del SET BASICO real', () => {
  let tenant;
  let productos;

  beforeEach(async () => {
    mockClient.__mock__.reset();
    await resetDteTables();
    tenant = await getAlmasendTenant();
    productos = await getAlmasendProductos();
    await setupCertificadoYCaf(tenant.id, { tiposDte: [33, 56, 61], folioHasta: 20 });
  });

  afterAll(async () => {
    await closePool();
  });

  test('el tenant ALMASEND tiene giro/direccion/acteco reales (migracion 012)', async () => {
    expect(tenant.acteco).toBe('631100');
    expect(tenant.giro).toContain('TECNOLOGIA');
    expect(tenant.comuna).toBe('Villa Alemana');
  });

  test('el Documento firmado queda estructurado como <DTE><Documento/><Signature/></DTE>', async () => {
    const result = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });

    const doc = await documentosRepo.getById(result.documentoId, tenant.id);
    expect(doc.xml_dte).toMatch(/^<DTE xmlns="http:\/\/www\.sii\.cl\/SiiDte"[^>]*version="1\.0">/);
    expect(doc.xml_dte).toContain('</Documento><Signature');
    expect(doc.xml_dte.trim().endsWith('</DTE>')).toBe(true);

    const { certificatePem } = await signatureService.getCertificadoActivo(tenant.id);
    expect(signatureService.verifySignature(doc.xml_dte, certificatePem)).toBe(true);
  });

  test('el Documento incluye Acteco del emisor y TasaIVA en Totales', async () => {
    const result = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });
    const doc = await documentosRepo.getById(result.documentoId, tenant.id);
    expect(doc.xml_dte).toContain('<Acteco>631100</Acteco>');
    expect(doc.xml_dte).toContain('<TasaIVA>19</TasaIVA>');
  });

  test('RutEnvia en la Caratula es el RUT del certificado (mandatario), no el del tenant', async () => {
    // Ingesta un certificado a nombre de una persona natural distinta del RUT del tenant.
    const cert = buildSelfSignedCertFixture({ rut: '16891500-4', commonName: 'GUILLERMO JOSE ZEDAN LEON' });
    await signatureService.ingestarCertificado({
      tenantId: tenant.id,
      pfxBuffer: cert.pfxBuffer,
      password: cert.password,
      rutCertificado: '16891500-4',
      vigenciaDesde: '2026-01-01',
      vigenciaHasta: '2027-01-01',
    });

    let envioXmlCapturado;
    const original = mockClient.enviarDte;
    mockClient.enviarDte = async (ambiente, params, token) => {
      envioXmlCapturado = params.envioDteXml;
      return original(ambiente, params, token);
    };
    try {
      await orchestrator.emitir({
        tenantId: tenant.id,
        tipoDte: 33,
        receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
        items: [{ productoId: productos[0].id, cantidad: 1 }],
        fechaEmision: '2026-08-10',
      });
    } finally {
      mockClient.enviarDte = original;
    }

    expect(envioXmlCapturado).toContain(`<RutEmisor>${tenant.rut}</RutEmisor>`);
    expect(envioXmlCapturado).toContain('<RutEnvia>16891500-4</RutEnvia>');
  });

  test('el EnvioDTE no lleva ID en <EnvioDTE> (solo en <SetDTE>) — SCH-00001 real del SII', async () => {
    // Regresión: el SII rechazó un envío real (CASO 4816286-1, folio 30)
    // con "SCH-00001: Invalid Schema Name" porque el código viejo le
    // ponía ID="SetDoc" a <EnvioDTE>, atributo que EnvioDTE_v10.xsd no
    // declara (solo declara "version"). El ID real vive en <SetDTE>, y
    // es lo que la Signature del sobre debe referenciar.
    let envioXmlCapturado;
    const original = mockClient.enviarDte;
    mockClient.enviarDte = async (ambiente, params, token) => {
      envioXmlCapturado = params.envioDteXml;
      return original(ambiente, params, token);
    };
    try {
      await orchestrator.emitir({
        tenantId: tenant.id,
        tipoDte: 33,
        receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
        items: [{ productoId: productos[0].id, cantidad: 1 }],
        fechaEmision: '2026-08-10',
      });
    } finally {
      mockClient.enviarDte = original;
    }

    expect(envioXmlCapturado).not.toMatch(/<EnvioDTE[^>]*\bID=/);
    expect(envioXmlCapturado).toMatch(/^<EnvioDTE[^>]*>\s*<SetDTE ID="[^"]+">/);

    const { certificatePem } = await signatureService.getCertificadoActivo(tenant.id);
    // El sobre trae 2 firmas: la del Documento (dentro de DTE) y la del
    // SetDTE (la del sobre completo) — ambas deben validar.
    expect(signatureService.verifySignature(envioXmlCapturado, certificatePem, { signatureIndex: 0 })).toBe(true);
    expect(signatureService.verifySignature(envioXmlCapturado, certificatePem, { signatureIndex: 1 })).toBe(true);
  });

  test('Nota de Credito "corrige texto" (soloReferencia): sin Detalle, monto 0, con CodRef', async () => {
    const factura = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });

    const nc = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 61,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      referenciaDocumentoId: factura.documentoId,
      razonReferencia: 'CORRIGE GIRO DEL RECEPTOR',
      codRefReferencia: 2,
      soloReferencia: true,
      fechaEmision: '2026-08-10',
    });

    const ncDoc = await documentosRepo.getById(nc.documentoId, tenant.id);
    expect(Number(ncDoc.monto_total)).toBe(0);
    expect(ncDoc.xml_dte).not.toContain('<Detalle>');
    expect(ncDoc.xml_dte).toContain('<CodRef>2</CodRef>');
    expect(ncDoc.xml_dte).toContain('<RazonRef>CORRIGE GIRO DEL RECEPTOR</RazonRef>');

    const { certificatePem } = await signatureService.getCertificadoActivo(tenant.id);
    expect(signatureService.verifySignature(ncDoc.xml_dte, certificatePem)).toBe(true);
  });

  test('emitir sin items y sin soloReferencia sigue exigiendo detalle', async () => {
    await expect(
      orchestrator.emitir({
        tenantId: tenant.id,
        tipoDte: 33,
        receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
        fechaEmision: '2026-08-10',
      })
    ).rejects.toThrow(orchestrator.OrchestratorError);
  });

  test('Nota de Debito (56) referenciando una Nota de Credito, con CodRef=1 (anula)', async () => {
    const factura = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 33,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      items: [{ productoId: productos[0].id, cantidad: 1 }],
      fechaEmision: '2026-08-10',
    });

    const nc = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 61,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      referenciaDocumentoId: factura.documentoId,
      razonReferencia: 'CORRIGE GIRO DEL RECEPTOR',
      codRefReferencia: 2,
      soloReferencia: true,
      fechaEmision: '2026-08-10',
    });

    const nd = await orchestrator.emitir({
      tenantId: tenant.id,
      tipoDte: 56,
      receptor: { rut: '60803000-K', razonSocial: 'IMPUESTOS INTERNOS CHILE' },
      referenciaDocumentoId: nc.documentoId,
      razonReferencia: 'ANULA NOTA DE CREDITO ELECTRONICA',
      codRefReferencia: 1,
      soloReferencia: true,
      fechaEmision: '2026-08-10',
    });

    expect(nd.tipoDte).toBe(56);
    const ndDoc = await documentosRepo.getById(nd.documentoId, tenant.id);
    expect(ndDoc.referencia_documento_id).toBe(nc.documentoId);
    expect(ndDoc.xml_dte).toContain('<TpoDocRef>61</TpoDocRef>');
    expect(ndDoc.xml_dte).toContain('<CodRef>1</CodRef>');

    const { certificatePem } = await signatureService.getCertificadoActivo(tenant.id);
    expect(signatureService.verifySignature(ndDoc.xml_dte, certificatePem)).toBe(true);
  });

  test('tenant_caf acepta tipo_dte 56 (Nota de Debito)', async () => {
    const { rows } = await pool.query(
      'SELECT tipo_dte FROM tenant_caf WHERE tenant_id = $1 AND tipo_dte = 56',
      [tenant.id]
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
