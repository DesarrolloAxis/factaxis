'use strict';

const cafService = require('../caf.service');
const { buildCafXml } = require('../__fixtures__/generate-caf-fixture');
const { resetDteTables, getAlmasendTenant, closePool } = require('../test-support/testHelpers');

describe('caf.service', () => {
  let tenantId;

  beforeEach(async () => {
    await resetDteTables();
    const tenant = await getAlmasendTenant();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await closePool();
  });

  test('parseCaf extrae los campos del bloque DA', () => {
    const { xml } = buildCafXml({
      rutEmisor: '78138404-6',
      razonSocial: 'ALMASEND SpA',
      tipoDte: 33,
      folioDesde: 1,
      folioHasta: 50,
      fechaAutorizacion: '2026-01-01',
    });
    const parsed = cafService.parseCaf(xml);
    expect(parsed.rutEmisor).toBe('78138404-6');
    expect(parsed.tipoDte).toBe(33);
    expect(parsed.folioDesde).toBe(1);
    expect(parsed.folioHasta).toBe(50);
    expect(parsed.privateKeyPem).toMatch(/PRIVATE KEY/);
  });

  test('parseCaf lanza CafValidationError con XML invalido', () => {
    expect(() => cafService.parseCaf('<no-es-un-caf/>')).toThrow(cafService.CafValidationError);
  });

  test('ingestarCaf rechaza un CAF cuyo RUT emisor no coincide con el tenant', async () => {
    const { xml } = buildCafXml({
      rutEmisor: '11111111-1', // no es ALMASEND
      razonSocial: 'Otra Empresa',
      tipoDte: 33,
      folioDesde: 1,
      folioHasta: 10,
      fechaAutorizacion: '2026-01-01',
    });
    await expect(cafService.ingestarCaf({ tenantId, xmlString: xml })).rejects.toThrow(cafService.CafValidationError);
  });

  test('ingestarCaf guarda el CAF con la clave privada redactada', async () => {
    const { xml } = buildCafXml({
      rutEmisor: '78138404-6',
      razonSocial: 'ALMASEND SpA',
      tipoDte: 33,
      folioDesde: 1,
      folioHasta: 10,
      fechaAutorizacion: '2026-01-01',
    });
    const caf = await cafService.ingestarCaf({ tenantId, xmlString: xml });
    expect(caf.folioDesde).toBe(1);
    expect(caf.folioHasta).toBe(10);
    expect(caf.folioActual).toBe(1);

    const { pool } = require('../../../db/pool');
    const { rows } = await pool.query('SELECT archivo_caf FROM tenant_caf WHERE id = $1', [caf.id]);
    expect(rows[0].archivo_caf).not.toContain('PRIVATE KEY');
    expect(rows[0].archivo_caf).toContain('REDACTED');
  });

  test('asignarFolio entrega folios consecutivos sin duplicados bajo concurrencia', async () => {
    const { xml } = buildCafXml({
      rutEmisor: '78138404-6',
      razonSocial: 'ALMASEND SpA',
      tipoDte: 33,
      folioDesde: 1,
      folioHasta: 20,
      fechaAutorizacion: '2026-01-01',
    });
    await cafService.ingestarCaf({ tenantId, xmlString: xml });

    const resultados = await Promise.all(Array.from({ length: 15 }, () => cafService.asignarFolio(tenantId, 33)));
    const folios = resultados.map((r) => r.folio).sort((a, b) => a - b);
    expect(folios).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(new Set(folios).size).toBe(15); // sin duplicados
  });

  test('asignarFolio lanza FoliosAgotadosError cuando el rango se agota', async () => {
    const { xml } = buildCafXml({
      rutEmisor: '78138404-6',
      razonSocial: 'ALMASEND SpA',
      tipoDte: 33,
      folioDesde: 1,
      folioHasta: 2,
      fechaAutorizacion: '2026-01-01',
    });
    await cafService.ingestarCaf({ tenantId, xmlString: xml });

    await cafService.asignarFolio(tenantId, 33);
    await cafService.asignarFolio(tenantId, 33);
    await expect(cafService.asignarFolio(tenantId, 33)).rejects.toThrow(cafService.FoliosAgotadosError);
  });

  test('asignarFolio no cruza folios entre tenants distintos', async () => {
    const { pool } = require('../../../db/pool');
    const otro = await pool.query(
      `INSERT INTO tenants (rut, razon_social, giro, direccion, comuna, ambiente_sii)
       VALUES ('11111111-1', 'Otra Empresa', 'Giro', 'Dir', 'Comuna', 'certificacion') RETURNING id`
    );
    const otroTenantId = otro.rows[0].id;

    const cafAlmasend = buildCafXml({
      rutEmisor: '78138404-6', razonSocial: 'ALMASEND SpA', tipoDte: 33, folioDesde: 1, folioHasta: 5, fechaAutorizacion: '2026-01-01',
    });
    await cafService.ingestarCaf({ tenantId, xmlString: cafAlmasend.xml });

    const cafOtro = buildCafXml({
      rutEmisor: '11111111-1', razonSocial: 'Otra Empresa', tipoDte: 33, folioDesde: 1, folioHasta: 5, fechaAutorizacion: '2026-01-01',
    });
    await cafService.ingestarCaf({ tenantId: otroTenantId, xmlString: cafOtro.xml });

    const folioA = await cafService.asignarFolio(tenantId, 33);
    const folioB = await cafService.asignarFolio(otroTenantId, 33);
    // ambos parten en folio 1: son rangos independientes por tenant, no un contador global
    expect(folioA.folio).toBe(1);
    expect(folioB.folio).toBe(1);

    await pool.query('DELETE FROM tenant_caf WHERE tenant_id = $1', [otroTenantId]);
    await pool.query('DELETE FROM vault_secrets WHERE tenant_id = $1', [otroTenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [otroTenantId]);
  });
});
