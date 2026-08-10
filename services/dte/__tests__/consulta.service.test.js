'use strict';

process.env.SII_CLIENT_MODE = 'mock';

const sigService = require('../signature.service');
const envioService = require('../envio.service');
const consultaService = require('../consulta.service');
const documentosRepo = require('../../../db/repositories/documentos.repo');
const { resetDteTables, getAlmasendTenant, setupCertificadoYCaf, closePool } = require('../test-support/testHelpers');
const mockClient = require('../sii-client/mock.client');

async function enviarDocumentoDePrueba(tenant, folio) {
  const { privateKeyPem, certificatePem } = await sigService.getCertificadoActivo(tenant.id);
  const docXml = `<Documento ID="F${folio}T33"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>${folio}</Folio></IdDoc></Encabezado></Documento>`;
  const signedDoc = sigService.signDocumento(docXml, { privateKeyPem, certificatePem, documentoId: `F${folio}T33` });
  const envioXml = envioService.buildEnvioDte({
    rutEmisor: tenant.rut,
    rutEnvia: tenant.rut,
    fechaResolucion: '2024-01-01',
    nroResolucion: '80',
    documentosFirmadosXml: [signedDoc],
    tipoDte: 33,
  });
  const signedEnvio = envioService.signEnvioDte(envioXml, { privateKeyPem, certificatePem });

  const doc = await documentosRepo.insert({
    tenantId: tenant.id,
    tipoDte: 33,
    folio,
    fechaEmision: '2026-08-10',
    rutReceptor: '66666666-6',
    razonSocialReceptor: 'Cliente Ejemplo',
    montoNeto: 1000,
    montoIva: 190,
    montoTotal: 1190,
    estadoInterno: 'emitido',
  });

  const { envioId } = await envioService.enviar({
    tenantId: tenant.id,
    tenant,
    dteDocumentoId: doc.id,
    tipoDte: 33,
    folio,
    envioDteXmlFirmado: signedEnvio,
  });

  const { pool } = require('../../../db/pool');
  const { rows } = await pool.query('SELECT * FROM dte_envios WHERE id = $1', [envioId]);
  return { doc, envio: rows[0] };
}

describe('consulta.service (mock)', () => {
  let tenant;

  beforeEach(async () => {
    mockClient.__mock__.reset();
    mockClient.__mock__.setConsultasParaResolver(2);
    await resetDteTables();
    tenant = await getAlmasendTenant();
    await setupCertificadoYCaf(tenant.id, { tiposDte: [] });
  });

  afterAll(async () => {
    await closePool();
  });

  test('consultarEstado progresa en_proceso -> aceptado y actualiza dte_documentos', async () => {
    const { doc, envio } = await enviarDocumentoDePrueba(tenant, 1);

    const r1 = await consultaService.consultarEstado({ tenantId: tenant.id, tenant, envio });
    expect(r1.estadoSii).toBe('en_proceso');
    expect(r1.estadoInterno).toBeNull();

    const { pool } = require('../../../db/pool');
    const envioActualizado = (await pool.query('SELECT * FROM dte_envios WHERE id = $1', [envio.id])).rows[0];
    const r2 = await consultaService.consultarEstado({ tenantId: tenant.id, tenant, envio: envioActualizado });
    expect(r2.estadoSii).toBe('aceptado');
    expect(r2.estadoInterno).toBe('aceptado');

    const docFinal = await documentosRepo.getById(doc.id, tenant.id);
    expect(docFinal.estado_interno).toBe('aceptado');
  });

  test('consultarEstado exige envio con track_id', async () => {
    await expect(
      consultaService.consultarEstado({ tenantId: tenant.id, tenant, envio: { id: 1 } })
    ).rejects.toThrow(consultaService.ConsultaError);
  });
});
