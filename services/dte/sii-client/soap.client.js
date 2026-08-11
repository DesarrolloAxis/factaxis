'use strict';

/**
 * Cliente real contra los webservices del SII. Implementa la misma
 * interfaz que mock.client.js (getSeed, getToken, enviarDte, queryEstUp),
 * así que activar el ambiente real es solo un cambio de configuración
 * (SII_CLIENT_MODE=soap) — ver services/dte/README.md.
 *
 * *** IMPORTANTE ***
 * Este cliente NO ha podido probarse contra el SII real todavía (depende
 * del certificado digital y CAF de certificación de ALMASEND, que son
 * trámites externos en curso). Las URLs, nombres de operación SOAP y el
 * formato exacto del multipart de envío están tomados de la documentación
 * pública del SII y de implementaciones de referencia (LibreDTE), pero
 * DEBEN validarse/ajustarse en cuanto haya certificado+CAF disponibles y
 * se puedan correr las pruebas de certificación reales. Ver README.
 */

const https = require('https');
const soap = require('soap');

const HOSTS = {
  certificacion: 'maullin.sii.cl',
  produccion: 'palena.sii.cl',
};

const WSDL = {
  semilla: (host) => `https://${host}/DTEWS/CrSeed.jws?WSDL`,
  token: (host) => `https://${host}/DTEWS/GetTokenFromSeed.jws?WSDL`,
  consulta: (host) => `https://${host}/DTEWS/QueryEstUp.jws?WSDL`,
};

function hostFor(ambiente) {
  const host = HOSTS[ambiente];
  if (!host) throw new Error(`[sii-client:soap] ambiente desconocido: "${ambiente}"`);
  return host;
}

/** Extrae el contenido de un tag simple de una respuesta XML-en-string del SII. */
function extractTag(xml, tag) {
  const match = xml && xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

async function getSeed(ambiente) {
  const host = hostFor(ambiente);
  const client = await soap.createClientAsync(WSDL.semilla(host));
  const [result] = await client.getSeedAsync({});
  // La respuesta viene envuelta en un XML dentro del campo `getSeedReturn`.
  const raw = result?.getSeedReturn;
  const semilla = extractTag(raw, 'SEMILLA');
  if (!semilla) {
    throw new Error(`[sii-client:soap] No se pudo extraer SEMILLA de la respuesta: ${raw}`);
  }
  return { semilla, raw };
}

async function getToken(ambiente, semillaFirmadaXml) {
  const host = hostFor(ambiente);
  const client = await soap.createClientAsync(WSDL.token(host));
  const [result] = await client.getTokenAsync({ pszXml: semillaFirmadaXml });
  const raw = result?.getTokenReturn;
  const token = extractTag(raw, 'TOKEN');
  if (!token) {
    throw new Error(`[sii-client:soap] No se pudo extraer TOKEN de la respuesta: ${raw}`);
  }
  return { token, raw };
}

/**
 * Envío del EnvioDTE al SII. A diferencia de semilla/token/consulta, esto
 * NO es una llamada SOAP: es un POST multipart/form-data a
 * /cgi_dte/UPL/DTEUpload con el token en la cookie/header y el XML como
 * archivo adjunto.
 */
function enviarDte(ambiente, { envioDteXml, rutEmisor, rutEnvia }, token) {
  const host = hostFor(ambiente);
  const [rutEmisorNum] = String(rutEmisor).split('-');
  const [rutEnviaNum] = String(rutEnvia || rutEmisor).split('-');

  const boundary = `----factaxisBoundary${Date.now()}`;
  const fileFieldName = 'archivo';
  const fileName = 'envio.xml';

  const parts = [
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="rutSender"\r\n\r\n${rutEnviaNum}\r\n`,
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="dvSender"\r\n\r\n${String(rutEnvia || rutEmisor).split('-')[1]}\r\n`,
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="rutCompany"\r\n\r\n${rutEmisorNum}\r\n`,
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="dvCompany"\r\n\r\n${String(rutEmisor).split('-')[1]}\r\n`,
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: text/xml\r\n\r\n${envioDteXml}\r\n`,
    `--${boundary}--\r\n`,
  ];
  const body = Buffer.from(parts.join(''), 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path: '/cgi_dte/UPL/DTEUpload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Cookie: `TOKEN=${token}`,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const trackId = extractTag(raw, 'TRACKID');
          if (!trackId) {
            reject(new Error(`[sii-client:soap] No se pudo extraer TRACKID de la respuesta: ${raw}`));
            return;
          }
          resolve({ trackId, raw });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function queryEstUp(ambiente, { trackId, rutEmisor }, token) {
  const host = hostFor(ambiente);
  const client = await soap.createClientAsync(WSDL.consulta(host));
  const [rutNum, dv] = String(rutEmisor).split('-');
  const [result] = await client.getEstUpAsync({
    RutEmpresa: rutNum,
    DvEmpresa: dv,
    Token: token,
    TrackId: trackId,
  });
  const raw = result?.getEstUpReturn;
  const estadoRaw = extractTag(raw, 'ESTADO');
  const glosa = extractTag(raw, 'GLOSA');

  return { estado: mapEstadoSii(estadoRaw), glosa, xmlRespuesta: raw };
}

/**
 * El SII devuelve códigos numéricos/strings de estado que hay que mapear
 * al enum interno de dte_envios.estado_sii. Esta tabla es la mejor
 * aproximación disponible sin poder probar contra el ambiente real —
 * AJUSTAR según las respuestas reales de certificación.
 */
function mapEstadoSii(estadoRaw) {
  const normalizado = String(estadoRaw || '').toUpperCase();
  if (['EPR', 'PROCESANDO', 'RECIBIDO'].includes(normalizado)) return 'en_proceso';
  if (['DOK', 'ACEPTADO'].includes(normalizado)) return 'aceptado';
  if (['RCH', 'RECHAZADO', 'FAU', 'FAN'].includes(normalizado)) return 'rechazado';
  if (['RPR', 'REPARO'].includes(normalizado)) return 'reparo';
  return 'en_proceso';
}

module.exports = { getSeed, getToken, enviarDte, queryEstUp, mapEstadoSii };
