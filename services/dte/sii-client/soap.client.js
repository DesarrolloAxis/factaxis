'use strict';

/**
 * Cliente real contra los webservices del SII. Implementa la misma
 * interfaz que mock.client.js (getSeed, getToken, enviarDte, queryEstUp),
 * así que activar el ambiente real es solo un cambio de configuración
 * (SII_CLIENT_MODE=soap) — ver services/dte/README.md.
 *
 * *** IMPORTANTE — hallazgo real de certificación (ver README) ***
 * getSeed/getToken/queryEstUp NO usan el paquete npm `soap`: los
 * webservices clásicos del SII (CrSeed.jws, GetTokenFromSeed.jws,
 * QueryEstUp.jws) están publicados en estilo SOAP "RPC" antiguo, que esa
 * librería no logra parsear ("invalid message definition for rpc style
 * binding" al intentar `soap.createClientAsync(wsdl)"). En su lugar,
 * armamos el sobre SOAP a mano y lo mandamos por HTTPS directo — patrón
 * común en integraciones Node.js con el SII por el mismo motivo.
 */

const https = require('https');

const HOSTS = {
  certificacion: 'maullin.sii.cl',
  produccion: 'palena.sii.cl',
};

function hostFor(ambiente) {
  const host = HOSTS[ambiente];
  if (!host) throw new Error(`[sii-client:soap] ambiente desconocido: "${ambiente}"`);
  return host;
}

/** Envía un sobre SOAP 1.1 armado a mano por HTTPS POST y devuelve el body de la respuesta. */
function soapRequest(host, path, soapAction, bodyXml) {
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<SOAP-ENV:Body>' +
    bodyXml +
    '</SOAP-ENV:Body>' +
    '</SOAP-ENV:Envelope>';
  const body = Buffer.from(envelope, 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': body.length,
          SOAPAction: soapAction,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function unescapeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extrae el contenido de un elemento de respuesta SOAP (p.ej.
 * <getSeedReturn>...</getSeedReturn>), tolerando prefijo de namespace
 * (<ns1:getSeedReturn>), atributos en el tag de apertura (el SII real
 * devuelve <getSeedReturn xsi:type="xsd:string">...), envoltura CDATA, y
 * contenido XML escapado como entidades (&lt;SEMILLA&gt;...) — los dos
 * formatos que usan distintas implementaciones SOAP Java clásicas como
 * las del SII. Devuelve XML "limpio" listo para extractTag().
 */
function extractSoapReturn(soapBody, elementName) {
  const match = soapBody.match(
    new RegExp(`<(?:\\w+:)?${elementName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${elementName}>`)
  );
  if (!match) return null;
  let inner = match[1].trim();
  const cdataMatch = inner.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdataMatch) inner = cdataMatch[1];
  if (inner.includes('&lt;')) inner = unescapeXmlEntities(inner);
  return inner;
}

/** Extrae el contenido de un tag simple (p.ej. <SEMILLA>123</SEMILLA>) de un XML ya "limpio". */
function extractTag(xml, tag) {
  const match = xml && xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getSeed(ambiente) {
  const host = hostFor(ambiente);
  const { body } = await soapRequest(host, '/DTEWS/CrSeed.jws', '""', '<getSeed/>');
  const inner = extractSoapReturn(body, 'getSeedReturn');
  const semilla = inner && extractTag(inner, 'SEMILLA');
  if (!semilla) {
    throw new Error(`[sii-client:soap] No se pudo extraer SEMILLA de la respuesta: ${body}`);
  }
  return { semilla, raw: body };
}

async function getToken(ambiente, semillaFirmadaXml) {
  const host = hostFor(ambiente);
  const requestBody = `<getToken><pszXml>${escapeXml(semillaFirmadaXml)}</pszXml></getToken>`;
  const { body } = await soapRequest(host, '/DTEWS/GetTokenFromSeed.jws', '""', requestBody);
  const inner = extractSoapReturn(body, 'getTokenReturn');
  const token = inner && extractTag(inner, 'TOKEN');
  if (!token) {
    throw new Error(`[sii-client:soap] No se pudo extraer TOKEN de la respuesta: ${body}`);
  }
  return { token, raw: body };
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
          // El CGI legacy de DTEUpload rechaza (o al menos no se puede
          // descartar que rechace) requests sin un User-Agent reconocible —
          // este es el valor que usan tanto el ejemplo oficial del SII
          // (ejem_upload.txt) como clientes históricos como niclabs/DTE
          // (UPLOAD_SII_HEADER_VALUE). https.request de Node no manda
          // User-Agent por defecto.
          'User-Agent': 'Mozilla/4.0 (compatible; PROG 1.0; Windows NT 5.0; YComp 5.0.2.4)',
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
  const [rutNum, dv] = String(rutEmisor).split('-');
  const requestBody =
    `<getEstUp>` +
    `<RutCompania>${escapeXml(rutNum)}</RutCompania>` +
    `<DvCompania>${escapeXml(dv)}</DvCompania>` +
    `<RutReceptor>${escapeXml(rutNum)}</RutReceptor>` +
    `<DvReceptor>${escapeXml(dv)}</DvReceptor>` +
    `<TrackId>${escapeXml(trackId)}</TrackId>` +
    `<Token>${escapeXml(token)}</Token>` +
    `</getEstUp>`;
  const { body } = await soapRequest(host, '/DTEWS/QueryEstUp.jws', '""', requestBody);
  const inner = extractSoapReturn(body, 'getEstUpReturn') || body;
  const estadoRaw = extractTag(inner, 'ESTADO');
  const glosa = extractTag(inner, 'GLOSA');

  return { estado: mapEstadoSii(estadoRaw), glosa, xmlRespuesta: inner };
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

module.exports = {
  getSeed,
  getToken,
  enviarDte,
  queryEstUp,
  mapEstadoSii,
  // exportados para tests / diagnóstico de respuestas SOAP crudas del SII:
  extractSoapReturn,
  soapRequest,
};
