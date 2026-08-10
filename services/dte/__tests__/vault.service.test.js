'use strict';

process.env.VAULT_PROVIDER = process.env.VAULT_PROVIDER || 'local';

const vault = require('../vault.service');
const { resetDteTables, getAlmasendTenant, closePool } = require('../test-support/testHelpers');

describe('vault.service (provider local)', () => {
  let tenantId;
  let otroTenantId = 999999; // no existe realmente, solo para probar rechazo cross-tenant

  beforeAll(async () => {
    await resetDteTables();
    const tenant = await getAlmasendTenant();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await closePool();
  });

  test('putSecret + getSecret hace roundtrip del valor en claro', async () => {
    const ref = await vault.putSecret({ tenantId, kind: 'caf_rsa_key', value: 'secreto-123' });
    const value = await vault.getSecret({ ref, tenantId });
    expect(value.toString('utf8')).toBe('secreto-123');
  });

  test('el ciphertext nunca se guarda en texto plano en vault_secrets', async () => {
    const { pool } = require('../../../db/pool');
    const ref = await vault.putSecret({ tenantId, kind: 'caf_rsa_key', value: 'no-deberia-verse-en-claro' });
    const { rows } = await pool.query('SELECT ciphertext FROM vault_secrets WHERE ref = $1', [ref]);
    expect(rows[0].ciphertext.toString('utf8')).not.toContain('no-deberia-verse-en-claro');
  });

  test('getSecret rechaza acceso cross-tenant aunque el ref exista', async () => {
    const ref = await vault.putSecret({ tenantId, kind: 'caf_rsa_key', value: 'solo-de-almasend' });
    await expect(vault.getSecret({ ref, tenantId: otroTenantId })).rejects.toThrow(/no pertenece a este tenant/);
  });

  test('putSecret exige tenantId, kind y value', async () => {
    await expect(vault.putSecret({ kind: 'caf_rsa_key', value: 'x' })).rejects.toThrow();
    await expect(vault.putSecret({ tenantId, value: 'x' })).rejects.toThrow();
    await expect(vault.putSecret({ tenantId, kind: 'caf_rsa_key' })).rejects.toThrow();
  });

  test('deleteSecret elimina el secreto', async () => {
    const ref = await vault.putSecret({ tenantId, kind: 'caf_rsa_key', value: 'a-borrar' });
    await vault.deleteSecret({ ref, tenantId });
    await expect(vault.getSecret({ ref, tenantId })).rejects.toThrow(/no encontrado/);
  });
});
