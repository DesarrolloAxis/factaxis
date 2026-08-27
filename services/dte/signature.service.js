'use strict';

/**
 * services/dte/signature.service.js
 *
 * Firma XMLDSig del documento DTE completo y del sobre EnvioDTE, usando el
 * certificado digital del tenant (nunca compartido entre tenants).
 *
 * Convenciones que exige el SII y que replicamos aquí:
 *  - Canonicalización C14N "plain" (no exclusive-c14n).
 *  - Digest SHA1, firma RSA-SHA1 (SII histórico; ver README para el caso
 *    de que futuros rechazos pidan SHA256 — es un cambio de una constante).
 *  - Firma "enveloped" (queda como último hijo del elemento firmado).
 *  - El elemento firmado debe tener un atributo ID único (p.ej. Documento
 *    ID="F1T33", SetDTE ID="SetDoc") — el caller es responsable de haberlo
 *    incluido en el XML antes de llamar a este servicio.
 *  - KeyInfo con el certificado X509 del firmante (obligatorio para que el
 *    SII pueda validar la cadena de confianza).
 */

const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');
const vault = require('./vault.service');
const certificadosRepo = require('../../db/repositories/certificados.repo');

class SignatureError extends Error {}

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

/**
 * Extrae { privateKeyPem, certificatePem } de un archivo .pfx/.p12 del
 * certificado digital del tenant.
 *
 * @param {Buffer} pfxBuffer
 * @param {string} password
 */
function parsePfx(pfxBuffer, password) {
  let p12Asn1;
  try {
    p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
  } catch (err) {
    throw new SignatureError(`No se pudo leer el archivo .pfx: ${err.message}`);
  }

  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  } catch (err) {
    // No asumir "contraseña incorrecta": node-forge lanza el mismo tipo de
    // error genérico también cuando el .pfx usa un algoritmo de cifrado que
    // no soporta (p.ej. RC2-40-CBC en certificados antiguos) con la
    // contraseña correcta. Incluir err.message es la única forma de
    // distinguir un caso del otro sin adivinar.
    throw new SignatureError(`No se pudo abrir el .pfx (contraseña incorrecta, archivo corrupto, o algoritmo de cifrado no soportado): ${err.message}`);
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag =
    (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0] ||
    (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = (certBags[forge.pki.oids.certBag] || [])[0];

  if (!keyBag || !certBag) {
    throw new SignatureError('El .pfx no contiene una llave privada y/o certificado válidos');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(keyBag.key),
    certificatePem: forge.pki.certificateToPem(certBag.cert),
  };
}

/**
 * Ingesta un certificado digital (.pfx) para un tenant: lo abre con la
 * contraseña dada, guarda {privateKeyPem, certificatePem} en el vault (la
 * contraseña del .pfx se descarta de inmediato, nunca se persiste), marca
 * cualquier certificado previo del tenant como inactivo y crea la fila en
 * tenant_certificados apuntando al secreto nuevo.
 */
async function ingestarCertificado({ tenantId, pfxBuffer, password, rutCertificado, vigenciaDesde, vigenciaHasta }) {
  const { privateKeyPem, certificatePem } = parsePfx(pfxBuffer, password);

  const certificadoRef = await vault.putSecret({
    tenantId,
    kind: 'tenant_certificado',
    value: JSON.stringify({ privateKeyPem, certificatePem }),
  });

  await certificadosRepo.desactivarTodos(tenantId);
  const row = await certificadosRepo.insert({
    tenantId,
    certificadoRef,
    rutCertificado,
    vigenciaDesde,
    vigenciaHasta,
  });

  return { id: row.id, tenantId, rutCertificado: row.rut_certificado, vigenciaHasta: row.vigencia_hasta };
}

/**
 * Recupera del vault la llave privada + certificado en claro del
 * certificado ACTIVO y vigente de un tenant, listos para firmar. Solo
 * debe usarse justo antes de firmar; nunca cachear ni loguear el
 * resultado.
 */
async function getCertificadoActivo(tenantId) {
  const cert = await certificadosRepo.getActivoVigente(tenantId);
  if (!cert) {
    throw new SignatureError(`Tenant ${tenantId} no tiene un certificado digital activo y vigente`);
  }
  const raw = await vault.getSecret({ ref: cert.certificado_ref, tenantId });
  const { privateKeyPem, certificatePem } = JSON.parse(raw.toString('utf8'));
  return { privateKeyPem, certificatePem, rutCertificado: cert.rut_certificado, vigenciaHasta: cert.vigencia_hasta };
}

/** Certificado en PEM -> base64 "puro" (sin headers), como lo espera KeyInfo/X509Certificate. */
function certPemToBase64(certificatePem) {
  return certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\r?\n/g, '')
    .trim();
}

/**
 * Firma (enveloped) el elemento `elementLocalName` (con atributo
 * ID=elementId) dentro de `xmlString`, usando la llave/certificado dados.
 * Devuelve el XML completo con el nodo <Signature> agregado.
 *
 * Por defecto la Signature se inserta como último hijo del MISMO elemento
 * referenciado (firma "enveloped" clásica: Documento contiene su propia
 * Signature). Si se pasa `containerLocalName` distinto de
 * `elementLocalName`, la Signature se inserta como último hijo de ESE otro
 * elemento en cambio (hermano del elemento referenciado, no descendiente)
 * — es la convención real que usa el SII para el DTE: `<DTE><Documento
 * ID=".."/><Signature/></DTE>`, donde Signature referencia a Documento por
 * su ID pero vive como hermano suyo, no anidada dentro. Ambas formas son
 * criptográficamente válidas (XMLDSig no exige que la Signature esté
 * dentro del elemento que firma), pero el schema del SII espera la
 * segunda para el DTE — ver signDocumentoEnDte.
 */
function signElement(xmlString, { privateKeyPem, certificatePem, elementLocalName, elementId, containerLocalName }) {
  if (!privateKeyPem || !certificatePem) {
    throw new SignatureError('signElement requiere privateKeyPem y certificatePem');
  }
  if (!elementLocalName || !elementId) {
    throw new SignatureError('signElement requiere elementLocalName y elementId');
  }
  if (!xmlString.includes(`ID="${elementId}"`) && !xmlString.includes(`Id="${elementId}"`)) {
    throw new SignatureError(
      `El XML no contiene un atributo ID="${elementId}" en <${elementLocalName}> — agrégalo antes de firmar`
    );
  }
  const insertInto = containerLocalName || elementLocalName;

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
  });

  sig.addReference({
    xpath: `//*[local-name(.)='${elementLocalName}']`,
    // OJO: el transform de canonicalización (C14N) debe declararse también
    // acá, en la referencia — no basta con canonicalizationAlgorithm del
    // SignedXml (eso solo canonicaliza <SignedInfo>). Sin este segundo
    // transform, xml-crypto serializa el nodo referenciado con un
    // toString() de DOM plano (no C14N real) y el digest queda inestable
    // entre firma y verificación en documentos con varios elementos con
    // atributo ID — costó bastante depurar esto, no quitarlo.
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
    uri: `#${elementId}`,
    isEmptyUri: false,
  });

  sig.computeSignature(xmlString, {
    location: { reference: `//*[local-name(.)='${insertInto}']`, action: 'append' },
  });

  return sig.getSignedXml();
}

/**
 * Firma el documento COMPLETO con una referencia de URI vacía (uri=""),
 * en vez de referenciar un elemento por su atributo ID. Es la convención
 * que usa el SII para firmar la semilla en el flujo de autenticación
 * (GetSeed -> firmar <getToken><item><Semilla>...</Semilla></item></getToken> -> GetToken):
 * no hay un ID que referenciar, se firma "todo el documento actual".
 */
function signWholeDocument(xmlString, { privateKeyPem, certificatePem }) {
  if (!privateKeyPem || !certificatePem) {
    throw new SignatureError('signWholeDocument requiere privateKeyPem y certificatePem');
  }

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
  });

  sig.addReference({
    xpath: '/*',
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
    uri: '',
    isEmptyUri: true,
  });

  sig.computeSignature(xmlString, {
    location: { reference: '/*', action: 'append' },
  });

  return sig.getSignedXml();
}

/**
 * Firma el nodo <Documento ID="..."> completo de una Factura/Nota de
 * Crédito ya armada (con TED incluido), con la Signature ENVELOPED dentro
 * del propio Documento. Válido criptográficamente, pero NO es la
 * estructura que espera el schema del SII (EnvioDTE_v10.xsd) — usar
 * signDocumentoEnDte para eso. Se mantiene por compatibilidad/tests.
 */
function signDocumento(documentoXml, { privateKeyPem, certificatePem, documentoId }) {
  return signElement(documentoXml, {
    privateKeyPem,
    certificatePem,
    elementLocalName: 'Documento',
    elementId: documentoId,
  });
}

/**
 * Firma un <Documento ID="..."> ya envuelto en <DTE version="1.0">...
 * </DTE>, dejando la Signature como HERMANA de Documento dentro de DTE
 * (no anidada en Documento) — la estructura real que usa el SII:
 *
 *   <DTE version="1.0">
 *     <Documento ID="F1T33">...</Documento>
 *     <Signature>...Reference URI="#F1T33"...</Signature>
 *   </DTE>
 *
 * `dteXml` debe ser exactamente `<DTE version="1.0">` + el Documento sin
 * firmar + `</DTE>` (ver dte.orchestrator.js).
 */
function signDocumentoEnDte(dteXml, { privateKeyPem, certificatePem, documentoId }) {
  return signElement(dteXml, {
    privateKeyPem,
    certificatePem,
    elementLocalName: 'Documento',
    elementId: documentoId,
    containerLocalName: 'DTE',
  });
}

/**
 * Firma el sobre <EnvioDTE ID="..."> completo (Carátula + SetDTE con los
 * documentos ya firmados individualmente dentro).
 */
function signEnvioDte(envioDteXml, { privateKeyPem, certificatePem, envioId }) {
  return signElement(envioDteXml, {
    privateKeyPem,
    certificatePem,
    elementLocalName: 'EnvioDTE',
    elementId: envioId,
  });
}

/**
 * Verifica una firma XMLDSig dentro de `signedXmlString` (uso en tests y en
 * validaciones internas). Un documento puede tener más de un nodo
 * <Signature> (p.ej. un EnvioDTE trae la firma del sobre + la firma propia
 * de cada Documento anidado) — `signatureIndex` (0-based, en orden de
 * aparición en el documento) permite elegir cuál validar; por defecto la
 * última (la más "externa" en el flujo de firma: primero se firma el
 * Documento, después el EnvioDTE que lo envuelve).
 */
function verifySignature(signedXmlString, certificatePem, { signatureIndex = -1 } = {}) {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(signedXmlString, 'text/xml');
  const signatureNodes = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  const idx = signatureIndex < 0 ? signatureNodes.length + signatureIndex : signatureIndex;
  const signatureNode = signatureNodes[idx];
  if (!signatureNode) {
    throw new SignatureError('No se encontró un nodo <Signature> en el XML en el índice solicitado');
  }
  const sig = new SignedXml({ publicCert: certificatePem });
  sig.loadSignature(signatureNode);
  return sig.checkSignature(signedXmlString);
}

module.exports = {
  parsePfx,
  ingestarCertificado,
  getCertificadoActivo,
  certPemToBase64,
  signElement,
  signWholeDocument,
  signDocumento,
  signDocumentoEnDte,
  signEnvioDte,
  verifySignature,
  SignatureError,
};
