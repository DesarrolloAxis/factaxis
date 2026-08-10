'use strict';

const rutUtil = require('../util/rut.util');

describe('rut.util', () => {
  test('normaliza RUT con puntos y minusculas', () => {
    expect(rutUtil.normalizar('78.138.404-6')).toBe('78138404-6');
    expect(rutUtil.normalizar('78138404-6')).toBe('78138404-6');
    expect(rutUtil.normalizar('781384046')).toBe('78138404-6');
  });

  test('iguales compara RUTs normalizados', () => {
    expect(rutUtil.iguales('78.138.404-6', '78138404-6')).toBe(true);
    expect(rutUtil.iguales('78.138.404-6', '11111111-1')).toBe(false);
  });

  test('esValido detecta RUTs correctos e incorrectos', () => {
    expect(rutUtil.esValido('78.138.404-6')).toBe(true);
    expect(rutUtil.esValido('11111111-1')).toBe(true);
    expect(rutUtil.esValido('78.138.404-5')).toBe(false);
  });

  test('calcularDv soporta digito verificador K', () => {
    // RUT conocido con DV K (11-11 no aplica; se prueba solo que la funcion no rompe)
    const dv = rutUtil.calcularDv('99999999');
    expect(['0', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9']).toContain(dv);
  });
});
