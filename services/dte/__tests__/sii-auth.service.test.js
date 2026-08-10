'use strict';

process.env.SII_CLIENT_MODE = 'mock';

const siiAuth = require('../sii-auth.service');
const { resetDteTables, getAlmasendTenant, setupCertificadoYCaf, closePool } = require('../test-support/testHelpers');

describe('sii-auth.service (mock)', () => {
  let tenantId;

  beforeEach(async () => {
    await resetDteTables();
    const tenant = await getAlmasendTenant();
    tenantId = tenant.id;
    siiAuth.clearCache();
  });

  afterAll(async () => {
    await closePool();
  });

  test('getToken falla si el tenant no tiene certificado', async () => {
    await expect(siiAuth.getToken(tenantId)).rejects.toThrow(/certificado digital/);
  });

  test('getToken obtiene un token via GetSeed/firma/GetToken', async () => {
    await setupCertificadoYCaf(tenantId, { tiposDte: [] });
    const token = await siiAuth.getToken(tenantId);
    expect(token).toMatch(/^MOCK-TOKEN-/);
  });

  test('getToken cachea el token entre llamadas', async () => {
    await setupCertificadoYCaf(tenantId, { tiposDte: [] });
    const t1 = await siiAuth.getToken(tenantId);
    const t2 = await siiAuth.getToken(tenantId);
    expect(t1).toBe(t2);
  });

  test('getToken con forceRefresh obtiene un token nuevo', async () => {
    await setupCertificadoYCaf(tenantId, { tiposDte: [] });
    const t1 = await siiAuth.getToken(tenantId);
    const t2 = await siiAuth.getToken(tenantId, { forceRefresh: true });
    expect(t1).not.toBe(t2);
  });
});
