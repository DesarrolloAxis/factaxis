'use strict';

const ted = require('../ted.service');
const { buildCafXml } = require('../__fixtures__/generate-caf-fixture');

describe('ted.service', () => {
  let fixture;
  let bloqueCaf;

  beforeAll(() => {
    fixture = buildCafXml({
      rutEmisor: '78138404-6',
      razonSocial: 'ALMASEND SpA',
      tipoDte: 33,
      folioDesde: 1,
      folioHasta: 100,
      fechaAutorizacion: '2026-01-01',
    });
    bloqueCaf = ted.extraerBloqueCaf(fixture.xml);
  });

  test('extraerBloqueCaf obtiene el bloque <CAF> sin la clave privada', () => {
    expect(bloqueCaf).toContain('<RE>78138404-6</RE>');
    expect(bloqueCaf).not.toContain('RSASK');
    expect(bloqueCaf).not.toContain('PRIVATE KEY');
  });

  test('buildDD arma el bloque DD con los campos obligatorios', () => {
    const dd = ted.buildDD({
      rutEmisor: '78138404-6',
      tipoDte: 33,
      folio: 1,
      fechaEmision: '2026-08-10',
      rutReceptor: '66666666-6',
      razonSocialReceptor: 'Cliente Ejemplo',
      montoTotal: 59500,
      primerItemGlosa: 'Servicio de almacenamiento',
      bloqueCaf,
    });
    expect(dd).toContain('<RE>78138404-6</RE>');
    expect(dd).toContain('<TD>33</TD>');
    expect(dd).toContain('<F>1</F>');
    expect(dd).toContain('<MNT>59500</MNT>');
    expect(dd).toContain(bloqueCaf);
  });

  test('buildDD lanza error si faltan campos obligatorios', () => {
    expect(() => ted.buildDD({})).toThrow(ted.TedError);
  });

  test('signDD produce una firma que verifica contra la llave publica del CAF', () => {
    const dd = ted.buildDD({
      rutEmisor: '78138404-6',
      tipoDte: 33,
      folio: 5,
      fechaEmision: '2026-08-10',
      rutReceptor: '66666666-6',
      razonSocialReceptor: 'Cliente Ejemplo',
      montoTotal: 10000,
      primerItemGlosa: 'Item',
      bloqueCaf,
    });
    const frmt = ted.signDD(dd, fixture.privateKeyPem);
    expect(ted.verifyDD(dd, frmt, fixture.publicKeyPem)).toBe(true);
  });

  test('verifyDD detecta un DD alterado (tamper)', () => {
    const dd = ted.buildDD({
      rutEmisor: '78138404-6',
      tipoDte: 33,
      folio: 5,
      fechaEmision: '2026-08-10',
      rutReceptor: '66666666-6',
      razonSocialReceptor: 'Cliente Ejemplo',
      montoTotal: 10000,
      primerItemGlosa: 'Item',
      bloqueCaf,
    });
    const frmt = ted.signDD(dd, fixture.privateKeyPem);
    const ddAlterado = dd.replace('<MNT>10000</MNT>', '<MNT>999999</MNT>');
    expect(ted.verifyDD(ddAlterado, frmt, fixture.publicKeyPem)).toBe(false);
  });

  test('buildTed arma el TED completo con FRMT', () => {
    const tedXml = ted.buildTed(
      {
        rutEmisor: '78138404-6',
        tipoDte: 33,
        folio: 7,
        fechaEmision: '2026-08-10',
        rutReceptor: '66666666-6',
        razonSocialReceptor: 'Cliente Ejemplo',
        montoTotal: 1000,
        primerItemGlosa: 'Item',
        bloqueCaf,
      },
      fixture.privateKeyPem
    );
    expect(tedXml).toMatch(/^<TED version="1.0">/);
    expect(tedXml).toContain('<FRMT algoritmo="SHA1withRSA">');
    expect(tedXml).toContain('</TED>');
  });
});
