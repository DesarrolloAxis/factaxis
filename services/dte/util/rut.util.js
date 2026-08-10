'use strict';

/** Normaliza un RUT a formato "12345678-9" (sin puntos, guión, DV en mayúscula). */
function normalizar(rut) {
  if (!rut) return '';
  const limpio = String(rut).replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  if (limpio.includes('-')) return limpio;
  return `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
}

function iguales(rutA, rutB) {
  return normalizar(rutA) === normalizar(rutB);
}

/** Calcula el dígito verificador de un RUT (sin DV) usando módulo 11. */
function calcularDv(rutSinDv) {
  let suma = 0;
  let multiplo = 2;
  const digitos = String(rutSinDv).replace(/\D/g, '').split('').reverse();
  for (const d of digitos) {
    suma += Number(d) * multiplo;
    multiplo = multiplo === 7 ? 2 : multiplo + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

function esValido(rut) {
  const normalizado = normalizar(rut);
  const [cuerpo, dv] = normalizado.split('-');
  if (!cuerpo || !dv) return false;
  return calcularDv(cuerpo) === dv.toUpperCase();
}

module.exports = { normalizar, iguales, calcularDv, esValido };
