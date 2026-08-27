'use strict';

process.env.SII_CLIENT_MODE = 'mock';

const sigService = require('../signature.service');
const envioService = require('../envio.service');
const enviosRepo = require('../../../db/repositories/envios.repo');
const documentosRepo = require('../../../db/repositories/documentos.repo');
const { resetDteTables, getAlmasendTenant, setupCertificadoYCaf, closePool } = require('../test-support/testHelpers');
const mockClient = require('../sii-client/mock.client');

describe('envio.service (mock)', () => {
  let tenant;

  beforeEach(async () => {
    mockClient.__mock__.reset();
    await resetDteTables();
    tenant = await getAlmasendTenant();
    await setupCertificadoYCaf(tenant.id, { tiposDte: [] });
  });

  afterAll(async () => {
    await closePool();
  });

  test('buildEnvioDte: <EnvioDTE> no lleva atributo ID (solo "version") — EnvioDTE_v10.xsd real del SII', () => {
    // Regresión de un rechazo real del SII: "SCH-00001: Invalid Schema
    // Name" al mandar <EnvioDTE ... ID="SetDoc">, que el schema no
    // declara. El único ID del sobre vive en <SetDTE>.
    const envioXml = envioService.buildEnvioDte({
      rutEmisor: tenant.rut,
      rutEnvia: tenant.rut,
      fechaResolucion: '2024-01-01',
      nroResolucion: '80',
      documentosFirmadosXml: ['<Documento/>'],
      tipoDte: 33,
      setDteId: 'SetDoc',
    });
    expect(envioXml).not.toMatch(/<EnvioDTE[^>]*\bID=/);
    expect(envioXml).toContain('<SetDTE ID="SetDoc">');
  });

  test('build + sign + enviar: EnvioDTE queda firmado y dte_envios registra el track_id', async () => {
    const { privateKeyPem, certificatePem } = await sigService.getCertificadoActivo(tenant.id);
    const docXml = '<Documento ID="F1T33"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>1</Folio></IdDoc></Encabezado></Documento>';
    const signedDoc = sigService.signDocumento(docXml, { privateKeyPem, certificatePem, documentoId: 'F1T33' });

    const envioXml = envioService.buildEnvioDte({
      rutEmisor: tenant.rut,
      rutEnvia: tenant.rut,
      fechaResolucion: '2024-01-01',
      nroResolucion: '80',
      documentosFirmadosXml: [signedDoc],
      tipoDte: 33,
    });
    const signedEnvio = envioService.signEnvioDte(envioXml, { privateKeyPem, certificatePem });
    expect(sigService.verifySignature(signedEnvio, certificatePem)).toBe(true);

    const doc = await documentosRepo.insert({
      tenantId: tenant.id,
      tipoDte: 33,
      folio: 1,
      fechaEmision: '2026-08-10',
      rutReceptor: '66666666-6',
      razonSocialReceptor: 'Cliente Ejemplo',
      montoNeto: 50000,
      montoIva: 9500,
      montoTotal: 59500,
      estadoInterno: 'emitido',
    });

    const { trackId, envioId } = await envioService.enviar({
      tenantId: tenant.id,
      tenant,
      dteDocumentoId: doc.id,
      tipoDte: 33,
      folio: 1,
      envioDteXmlFirmado: signedEnvio,
    });

    expect(trackId).toMatch(/^MOCK-/);
    const envios = await enviosRepo.listPendientesByTenant(tenant.id);
    expect(envios.find((e) => e.id === envioId)).toBeTruthy();
  });

  test('enviar propaga rutEnvia (titular del certificado) al cliente SII, no tenant.rut', async () => {
    // Regresión: rutEnvia quedaba hardcodeado a tenant.rut, ignorando el
    // RUT real del titular del certificado (rutCertificado) -- descubierto
    // al probar contra el SII real, donde el DTEUpload usa este campo para
    // validar el sender contra la identidad detrás del token.
    const doc = await documentosRepo.insert({
      tenantId: tenant.id,
      tipoDte: 33,
      folio: 3,
      fechaEmision: '2026-08-10',
      rutReceptor: '66666666-6',
      razonSocialReceptor: 'Cliente Ejemplo',
      montoNeto: 1000,
      montoIva: 190,
      montoTotal: 1190,
      estadoInterno: 'emitido',
    });

    const original = mockClient.enviarDte;
    let capturedArgs;
    mockClient.enviarDte = async (ambiente, args, token) => {
      capturedArgs = args;
      return original(ambiente, args, token);
    };
    try {
      await envioService.enviar({
        tenantId: tenant.id,
        tenant, // tenant.rut = 78138404-6 (ALMASEND)
        dteDocumentoId: doc.id,
        tipoDte: 33,
        folio: 3,
        envioDteXmlFirmado: '<EnvioDTE ID="X"></EnvioDTE>',
        rutEnvia: '16891500-4', // RUT del titular del certificado, distinto del tenant
      });
    } finally {
      mockClient.enviarDte = original;
    }

    expect(capturedArgs.rutEnvia).toBe('16891500-4');
    expect(capturedArgs.rutEmisor).toBe(tenant.rut);
  });

  test('enviar persiste el fallo si el envio al SII lanza un error', async () => {
    const doc = await documentosRepo.insert({
      tenantId: tenant.id,
      tipoDte: 33,
      folio: 2,
      fechaEmision: '2026-08-10',
      rutReceptor: '66666666-6',
      razonSocialReceptor: 'Cliente Ejemplo',
      montoNeto: 1000,
      montoIva: 190,
      montoTotal: 1190,
      estadoInterno: 'emitido',
    });

    const original = mockClient.enviarDte;
    mockClient.enviarDte = async () => {
      throw new Error('caido');
    };
    try {
      await expect(
        envioService.enviar({
          tenantId: tenant.id,
          tenant,
          dteDocumentoId: doc.id,
          tipoDte: 33,
          folio: 2,
          envioDteXmlFirmado: '<EnvioDTE ID="X"></EnvioDTE>',
        })
      ).rejects.toThrow(envioService.EnvioError);
    } finally {
      mockClient.enviarDte = original;
    }

    const { pool } = require('../../../db/pool');
    const { rows } = await pool.query('SELECT estado_sii FROM dte_envios WHERE dte_documento_id = $1', [doc.id]);
    expect(rows[0].estado_sii).toBe('rechazado');
  });
});
