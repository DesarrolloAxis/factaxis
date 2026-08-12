'use strict';

/**
 * services/dte/envio.service.js
 *
 * Construcción del sobre EnvioDTE (Carátula + SetDTE con los Documento(s)
 * ya firmados individualmente), firma del sobre completo, y envío al
 * webservice del SII.
 */

const enviosRepo = require('../../db/repositories/envios.repo');
const signatureService = require('./signature.service');
const siiAuth = require('./sii-auth.service');
const { getClient } = require('./sii-client');

class EnvioError extends Error {}

// RUT fijo del SII como receptor de todo EnvioDTE.
const RUT_SII = '60803000-K';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Construye el bloque <Caratula>. `subTotales` es un arreglo
 * [{ tipoDte, cantidad }] — normalmente un solo tipo de documento por
 * envío en esta fase (33 o 61, nunca mezclados).
 */
function buildCaratula({ rutEmisor, rutEnvia, fechaResolucion, nroResolucion, subTotales, timestamp }) {
  const subTotDte = subTotales
    .map((s) => `<SubTotDTE><TpoDTE>${s.tipoDte}</TpoDTE><NroDTE>${s.cantidad}</NroDTE></SubTotDTE>`)
    .join('');

  return (
    `<Caratula version="1.0">` +
    `<RutEmisor>${escapeXml(rutEmisor)}</RutEmisor>` +
    `<RutEnvia>${escapeXml(rutEnvia)}</RutEnvia>` +
    `<RutReceptor>${RUT_SII}</RutReceptor>` +
    `<FchResol>${fechaResolucion}</FchResol>` +
    `<NroResol>${nroResolucion}</NroResol>` +
    `<TmstFirmaEnv>${timestamp || new Date().toISOString().slice(0, 19)}</TmstFirmaEnv>` +
    subTotDte +
    `</Caratula>`
  );
}

/**
 * Arma el EnvioDTE sin firmar: <EnvioDTE ID="..."><SetDTE ID="SetDoc">
 * <Caratula/>{documentos firmados}</SetDTE></EnvioDTE>.
 *
 * `documentosFirmadosXml` es un arreglo de strings XML de <Documento>,
 * cada uno YA firmado individualmente (ver signature.service.signDocumento).
 */
function buildEnvioDte({
  rutEmisor,
  rutEnvia,
  fechaResolucion,
  nroResolucion,
  documentosFirmadosXml,
  tipoDte,
  setDteId = 'SetDoc',
}) {
  if (!Array.isArray(documentosFirmadosXml) || documentosFirmadosXml.length === 0) {
    throw new EnvioError('buildEnvioDte requiere al menos un documento firmado');
  }

  const caratula = buildCaratula({
    rutEmisor,
    rutEnvia,
    fechaResolucion,
    nroResolucion,
    subTotales: [{ tipoDte, cantidad: documentosFirmadosXml.length }],
  });

  const setDte = `<SetDTE ID="${setDteId}">${caratula}${documentosFirmadosXml.join('')}</SetDTE>`;

  // OJO: EnvioDTE_v10.xsd (schema real del SII) solo declara el atributo
  // "version" en <EnvioDTE> — el atributo "ID" NO existe ahí, pertenece a
  // <SetDTE>. Agregarlo (como hacía una versión anterior de este código)
  // produce un rechazo real del SII: "SCH-00001: Invalid Schema Name"
  // (confirmado contra maullin.sii.cl, CASO 4816286-1 folio 30). La firma
  // del sobre referencia el ID de SetDTE, no uno inventado en EnvioDTE —
  // ver signEnvioDte más abajo.
  return (
    `<EnvioDTE xmlns="http://www.sii.cl/SiiDte" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioDTE_v10.xsd" ` +
    `version="1.0">${setDte}</EnvioDTE>`
  );
}

/**
 * Firma el EnvioDTE completo. La Signature referencia el <SetDTE ID="...">
 * (único elemento con ID en el sobre) y se inserta como hermana suya
 * dentro de <EnvioDTE> — la estructura real que exige el SII (ver
 * EnvioDTE_v10.xsd: secuencia SetDTE, ds:Signature).
 */
function signEnvioDte(envioDteXml, { privateKeyPem, certificatePem, setDteId = 'SetDoc' }) {
  return signatureService.signEnvioDte(envioDteXml, { privateKeyPem, certificatePem, setDteId });
}

/**
 * Envía el EnvioDTE firmado al SII (o al mock) y persiste el resultado en
 * dte_envios. Requiere un token vigente (lo obtiene automáticamente vía
 * sii-auth.service si no se pasa uno).
 */
async function enviar({ tenantId, tenant, dteDocumentoId, tipoDte, folio, envioDteXmlFirmado, clientMode, token }) {
  if (!tenantId || !tenant || !dteDocumentoId || !envioDteXmlFirmado) {
    throw new EnvioError('enviar requiere tenantId, tenant, dteDocumentoId y envioDteXmlFirmado');
  }

  const authToken = token || (await siiAuth.getToken(tenantId, { clientMode }));
  const client = getClient(clientMode);

  let trackId;
  try {
    const result = await client.enviarDte(
      tenant.ambiente_sii,
      { envioDteXml: envioDteXmlFirmado, rutEmisor: tenant.rut, rutEnvia: tenant.rut, tipoDte, folio },
      authToken
    );
    trackId = result.trackId;
  } catch (err) {
    // Persistimos el intento fallido igual — el folio ya fue consumido y
    // el documento no debe quedar "flotando" sin registro de qué pasó.
    await enviosRepo.insert({
      tenantId,
      dteDocumentoId,
      trackId: null,
      estadoSii: 'rechazado',
      glosaRespuesta: `Error de comunicación con el SII: ${err.message}`,
    });
    throw new EnvioError(`Fallo el envío al SII: ${err.message}`);
  }

  const envio = await enviosRepo.insert({
    tenantId,
    dteDocumentoId,
    trackId,
    estadoSii: 'enviado',
  });

  return { trackId, envioId: envio.id };
}

module.exports = { buildCaratula, buildEnvioDte, signEnvioDte, enviar, EnvioError, RUT_SII };
