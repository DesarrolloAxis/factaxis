'use strict';

/**
 * services/dte/ted.service.js
 *
 * Construcción del bloque DD (Datos del Documento) y cálculo/firma del TED
 * (Timbre Electrónico), usando la clave RSA privada del CAF del rango de
 * folios correspondiente (SHA1withRSA, tal como exige el SII).
 *
 * El TED es un sello que va dentro del propio XML del documento (nodo
 * <TED>) y es lo que un lector de códigos de barra/PDF417 valida contra el
 * SII. No confundir con la firma XMLDSig del documento completo, que hace
 * signature.service.js con el certificado del tenant.
 */

const forge = require('node-forge');

class TedError extends Error {}

/**
 * Extrae el bloque <CAF version="...">...</CAF> (DA + FRMA, sin RSASK) tal
 * cual debe insertarse dentro del TED, a partir del XML de CAF almacenado
 * en tenant_caf.archivo_caf (que ya viene con la clave privada redactada).
 */
function extraerBloqueCaf(archivoCafXml) {
  const match = archivoCafXml.match(/<CAF\b[\s\S]*?<\/CAF>/);
  if (!match) {
    throw new TedError('No se pudo extraer el bloque <CAF> del archivo_caf almacenado');
  }
  return match[0];
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Construye el bloque <DD>...</DD> (sin firmar) a partir de los datos del
 * documento. `primerItemGlosa` corresponde al nodo IT1, obligatorio: el
 * SII exige el nombre/glosa del primer ítem del detalle.
 */
function buildDD({
  rutEmisor,
  tipoDte,
  folio,
  fechaEmision,
  rutReceptor,
  razonSocialReceptor,
  montoTotal,
  primerItemGlosa,
  bloqueCaf,
  timestamp = new Date().toISOString().slice(0, 19),
}) {
  // OJO: montoTotal puede ser legítimamente 0 (Notas de Crédito/Débito de
  // "corrige texto", sin efecto en montos) — no usar !montoTotal, que
  // trataría 0 como "falta".
  if (!rutEmisor || !tipoDte || !folio || !fechaEmision || !rutReceptor || montoTotal == null || !bloqueCaf) {
    throw new TedError('buildDD: faltan campos obligatorios para construir el bloque DD');
  }

  return (
    `<DD>` +
    `<RE>${escapeXml(rutEmisor)}</RE>` +
    `<TD>${tipoDte}</TD>` +
    `<F>${folio}</F>` +
    `<FE>${fechaEmision}</FE>` +
    `<RR>${escapeXml(rutReceptor)}</RR>` +
    `<RSR>${escapeXml(razonSocialReceptor || '')}</RSR>` +
    `<MNT>${Math.round(Number(montoTotal))}</MNT>` +
    `<IT1>${escapeXml((primerItemGlosa || '').slice(0, 40))}</IT1>` +
    `${bloqueCaf}` +
    `<TSTED>${timestamp}</TSTED>` +
    `</DD>`
  );
}

/**
 * Firma el bloque DD (SHA1withRSA) con la clave privada del CAF y devuelve
 * la firma en base64 (FRMT).
 *
 * @param {string} ddXml - bloque <DD>...</DD> tal cual se incluirá en el TED
 * @param {string} privateKeyPem - clave privada RSA del CAF, EN CLARO, solo en memoria
 *   (obtenida vía vault.service.getSecret justo antes de llamar aquí; nunca loguear este valor)
 */
function signDD(ddXml, privateKeyPem) {
  let privateKey;
  try {
    privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  } catch (err) {
    throw new TedError(`Clave privada de CAF inválida: ${err.message}`);
  }
  const md = forge.md.sha1.create();
  md.update(ddXml, 'utf8');
  const signatureBytes = privateKey.sign(md);
  return forge.util.encode64(signatureBytes);
}

/** Verifica una firma FRMT contra su DD y la llave pública del CAF (uso en tests). */
function verifyDD(ddXml, frmtBase64, publicKeyPem) {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const md = forge.md.sha1.create();
  md.update(ddXml, 'utf8');
  const signatureBytes = forge.util.decode64(frmtBase64);
  return publicKey.verify(md.digest().bytes(), signatureBytes);
}

/**
 * Arma el TED completo: <TED version="1.0"><DD>...</DD><FRMT ...>firma</FRMT></TED>
 */
function buildTed(ddParams, privateKeyPem) {
  const ddXml = buildDD(ddParams);
  const frmt = signDD(ddXml, privateKeyPem);
  return `<TED version="1.0">${ddXml}<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT></TED>`;
}

module.exports = { buildDD, signDD, verifyDD, buildTed, extraerBloqueCaf, TedError };
