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
 *
 * Los formatos de request/response de este archivo están verificados
 * contra los manuales oficiales del SII (no por analogía):
 *   - "Manual de Desarrollador Autenticación Automática" OI2007_AUTAUTOM_MDE_1.9
 *     (CrSeed.jws / GetTokenFromSeed.jws — WSDL, parámetros, tabla de
 *     estados de salida completa).
 *   - "Manual de Desarrollador Externo Consulta de Estado de Upload Dte"
 *     (WSDL de QueryEstUp.jws — getEstUp(RutCompania, DvCompania, TrackId,
 *     Token), NO lleva RutReceptor/DvReceptor; ese parámetro pertenece a
 *     QueryEstDte.jws, un servicio distinto que consulta el estado de un
 *     DTE puntual por folio, no el de un envío por trackId).
 *   - "Manual Desarrollador Externo Envío Automático Documentos
 *     Tributarios Electrónicos" OI2003_UPDTE_MDE_1.5 (DTEUpload — headers
 *     requeridos, incluyendo el User-Agent con "PROG 1.0" sin el cual el
 *     servidor puede no devolver el formato XML; estructura completa de
 *     <RECEPCIONDTE> y tabla de códigos STATUS).
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

/**
 * Envía un sobre SOAP 1.1 armado a mano por HTTPS POST y devuelve el body
 * de la respuesta. Declara xmlns:xsi/xmlns:xsd en el Envelope (igual que
 * el ejemplo oficial del manual de Autenticación Automática) — sin esto,
 * cualquier body que use un atributo `xsi:type` (como getToken(), que usa
 * `<pszXml xsi:type="xsd:string">`) revienta con
 * SAXParseException/"prefix xsi ... is not bound" en el servidor real del
 * SII. Confirmado contra maullin.sii.cl (no es una suposición): un CAF
 * real se gastó averiguando esto — no volver a esta versión sin xsi/xsd.
 */
function soapRequest(host, path, soapAction, bodyXml) {
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope ' +
    'xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:SOAPENC="http://schemas.xmlsoap.org/soap/encoding/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
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

/** Extrae todas las ocurrencias de un tag repetido (p.ej. <ERROR>...</ERROR> dentro de <DETAIL>). */
function extractTagAll(xml, tag) {
  if (!xml) return [];
  const matches = xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'));
  return Array.from(matches, (m) => m[1]);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Tabla de estados de CrSeed.jws — Manual Autenticación Automática, punto 5.2.2.
 * "00" es éxito; el resto son errores.
 */
const CRSEED_ESTADOS = {
  '00': 'OK genera Semilla',
  '-1': 'No se registró línea en el Archivo de Configuración',
  '-2': 'Error de retorno (BD)',
};

async function getSeed(ambiente) {
  const host = hostFor(ambiente);
  const { statusCode, body } = await soapRequest(host, '/DTEWS/CrSeed.jws', '""', '<getSeed/>');
  if (statusCode !== 200) {
    throw new Error(`[sii-client:soap] CrSeed.jws respondió HTTP ${statusCode}: ${body}`);
  }

  const inner = extractSoapReturn(body, 'getSeedReturn');
  const semilla = inner && extractTag(inner, 'SEMILLA');
  if (!semilla) {
    const estado = inner && extractTag(inner, 'ESTADO');
    const glosa = (inner && extractTag(inner, 'GLOSA')) || CRSEED_ESTADOS[estado] || null;
    throw new Error(
      `[sii-client:soap] CrSeed.jws no devolvió SEMILLA` +
        (estado ? ` (ESTADO ${estado}${glosa ? `: ${glosa}` : ''})` : '') +
        `. Respuesta cruda: ${body}`
    );
  }
  return { semilla, raw: body };
}

/**
 * Tabla de estados de GetTokenFromSeed.jws — Manual Autenticación
 * Automática, punto 5.2.2. "00" es éxito; el resto son errores (casi
 * siempre por XML de semilla firmada mal formado o firma inválida).
 */
const GETTOKEN_ESTADOS = {
  '00': 'Token Creado',
  '01': 'XML inválido (IOException) en valSignedXml',
  '02': 'XML inválido (SAXException) en valSignedXml',
  '03': 'XML inválido (ParserConfigurationException) en valSignedXml',
  '04': 'XML inválido: elemento "Signature" no existe (valSignedXml)',
  '05': 'XML inválido: firma inválida (valSignedXml)',
  '06': 'XML inválido: elemento "Semilla" no existe (getSeed)',
  '07': 'Error interno (MessageException)',
  '08': 'Error de retorno (parámetros incorrectos, semilla vencida/inexistente, o no se pudo crear el token)',
  '09': 'Error interno (MessageException)',
  '10': 'Error de retorno de datos / no pudo crear o actualizar el token',
  '11': 'XML inválido: elemento "Certificate" no existe (getCertificado)',
  '12': 'Error interno (MessageException)',
  '21': 'Firma inválida: la llave pública no coincide con la del certificado',
  '-3': 'Error en autenticación',
  '-07': 'Error de parseo del RUT — verificar que el usuario esté habilitado para autenticación con Certificado Digital',
};

async function getToken(ambiente, semillaFirmadaXml) {
  const host = hostFor(ambiente);
  const ns = `https://${host}/DTEWS/GetTokenFromSeed.jws`;
  const requestBody =
    `<m:getToken xmlns:m="${ns}">` +
    `<pszXml xsi:type="xsd:string">${escapeXml(semillaFirmadaXml)}</pszXml>` +
    `</m:getToken>`;
  const { statusCode, body } = await soapRequest(host, '/DTEWS/GetTokenFromSeed.jws', '""', requestBody);
  if (statusCode !== 200) {
    throw new Error(`[sii-client:soap] GetTokenFromSeed.jws respondió HTTP ${statusCode}: ${body}`);
  }

  const inner = extractSoapReturn(body, 'getTokenReturn');
  const token = inner && extractTag(inner, 'TOKEN');
  if (!token) {
    const estado = inner && extractTag(inner, 'ESTADO');
    const glosa = (inner && extractTag(inner, 'GLOSA')) || GETTOKEN_ESTADOS[estado] || null;
    throw new Error(
      `[sii-client:soap] GetTokenFromSeed.jws no devolvió TOKEN` +
        (estado ? ` (ESTADO ${estado}${glosa ? `: ${glosa}` : ''})` : '') +
        `. Respuesta cruda: ${body}`
    );
  }
  return { token, raw: body };
}

/**
 * Tabla de STATUS de DTEUpload — Manual Envío Automático DTE,
 * OI2003_UPDTE_MDE_1.5, punto 2.1. "0" es éxito (con TRACKID); el resto
 * son rechazos.
 */
const DTEUPLOAD_STATUS = {
  0: 'Upload OK',
  1: 'El Sender no tiene permiso para enviar',
  2: 'Error en tamaño del archivo (muy grande o muy chico)',
  3: 'Archivo cortado (tamaño <> al parámetro size)',
  5: 'No está autenticado',
  6: 'Empresa no autorizada a enviar archivos',
  7: 'Esquema inválido',
  8: 'Error en la firma del documento',
  9: 'Sistema bloqueado',
};

/**
 * Envío del EnvioDTE al SII. A diferencia de semilla/token/consulta, esto
 * NO es una llamada SOAP: es un POST multipart/form-data a
 * /cgi_dte/UPL/DTEUpload con el token en la cookie y el XML como archivo
 * adjunto.
 *
 * El header User-Agent con "PROG 1.0" es obligatorio según el manual del
 * SII: sin él, el servidor puede no devolver el formato de salida en XML
 * (asume un browser real y responde distinto) — NO quitar.
 */
/**
 * Arma el body multipart/form-data (RFC1867) para DTEUpload, sin tocar la
 * red — separado de enviarDte() para poder testear la construcción sola.
 *
 * El SII histórico espera el XML declarado (y codificado) en ISO-8859-1,
 * no UTF-8 — convención heredada de los '2000 que sigue vigente hoy
 * (documentada en múltiples integraciones reales de terceros). Sin la
 * declaración de encoding, un parser legacy puede rechazar el documento
 * como "SCH-00001: Invalid Schema Name" apenas el contenido trae tildes
 * (confirmado contra maullin.sii.cl, CASO 4816286-1 folio 30 — el
 * rechazo persistía incluso con el schema y la firma ya corregidos). El
 * prólogo XML va ANTES del elemento raíz, así que no afecta ningún digest
 * XMLDSig (esos se calculan sobre subárboles ya firmados).
 *
 * OJO: esto asume que el contenido solo usa caracteres Latin-1 (tildes,
 * eñe, etc. — el caso real de nombres/giros en español). Un caracter
 * fuera de ese rango (comillas tipográficas, guión largo, emoji) se
 * corrompería silenciosamente al codificar como latin1 — no debería
 * aparecer en datos de negocio reales, pero si el SII vuelve a rechazar
 * por caracteres raros, revisar acá primero.
 *
 * `rutEnvia` debe ser el RUT del titular del certificado usado para
 * autenticar (puede ser una persona natural distinta de la empresa
 * emisora) -- ver envio.service.js#enviar. Un mismatch acá es motivo de
 * rechazo por parte del SII (valida contra la identidad del Token).
 */
function buildEnviarDteBody({ envioDteXml, rutEmisor, rutEnvia }) {
  const [rutEmisorNum, dvEmisor] = String(rutEmisor).split('-');
  const [rutEnviaNum, dvEnvia] = String(rutEnvia || rutEmisor).split('-');

  const boundary = `----factaxisBoundary${Date.now()}`;
  const fileFieldName = 'archivo';
  const fileName = 'envio.xml';

  const envioDteXmlConProlog = `<?xml version="1.0" encoding="ISO-8859-1"?>${envioDteXml}`;

  const parts = [
    `--${boundary}\r\n` + `Content-Disposition: form-data; name="rutSender"\r\n\r\n${rutEnviaNum}\r\n`,
    `--${boundary}\r\n` + `Content-Disposition: form-data; name="dvSender"\r\n\r\n${dvEnvia}\r\n`,
    `--${boundary}\r\n` + `Content-Disposition: form-data; name="rutCompany"\r\n\r\n${rutEmisorNum}\r\n`,
    `--${boundary}\r\n` + `Content-Disposition: form-data; name="dvCompany"\r\n\r\n${dvEmisor}\r\n`,
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: text/xml; charset=ISO-8859-1\r\n\r\n${envioDteXmlConProlog}\r\n`,
    `--${boundary}--\r\n`,
  ];
  const body = Buffer.from(parts.join(''), 'latin1');
  return { body, boundary };
}

function enviarDte(ambiente, { envioDteXml, rutEmisor, rutEnvia }, token) {
  const host = hostFor(ambiente);
  const { body, boundary } = buildEnviarDteBody({ envioDteXml, rutEmisor, rutEnvia });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path: '/cgi_dte/UPL/DTEUpload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          // Requerido por el SII para que la respuesta venga en XML (ver
          // Manual Envío Automático DTE, Cap. 2 "Requerimientos del Request")
          // — el CGI legacy de DTEUpload asume un browser real y puede
          // responder distinto sin un User-Agent reconocible. Mismo valor
          // que usan tanto el ejemplo oficial del SII (ejem_upload.txt)
          // como clientes históricos como niclabs/DTE
          // (UPLOAD_SII_HEADER_VALUE). https.request de Node no manda
          // User-Agent por defecto — no quitar esta línea.
          'User-Agent': 'Mozilla/4.0 (compatible; PROG 1.0; Windows NT 5.0; YComp 5.0.2.4)',
          Connection: 'Keep-Alive',
          'Cache-Control': 'no-cache',
          Cookie: `TOKEN=${token}`,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`[sii-client:soap] DTEUpload respondió HTTP ${res.statusCode}: ${raw}`));
            return;
          }

          const statusRaw = extractTag(raw, 'STATUS');
          const status = statusRaw === null ? null : Number(statusRaw);
          const trackId = extractTag(raw, 'TRACKID');

          if (status === 0 && trackId) {
            resolve({ trackId, raw });
            return;
          }

          const glosaStatus = status !== null ? DTEUPLOAD_STATUS[status] || 'Error interno' : null;
          const errores = extractTagAll(raw, 'ERROR');
          const detalle = errores.length ? ` — detalle: ${errores.join(' | ')}` : '';
          reject(
            new Error(
              `[sii-client:soap] DTEUpload rechazado` +
                (status !== null ? ` (STATUS ${status}${glosaStatus ? `: ${glosaStatus}` : ''})` : ' (sin STATUS ni TRACKID reconocibles)') +
                `${detalle}. Respuesta cruda: ${raw}`
            )
          );
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
  // WSDL oficial de QueryEstUp.jws: getEstUp(RutCompania, DvCompania,
  // TrackId, Token) — solo 4 parámetros. NO lleva RutReceptor/DvReceptor;
  // esos pertenecen a QueryEstDte.jws (consulta de un DTE puntual por
  // folio), un servicio distinto.
  const [rutNum, dv] = String(rutEmisor).split('-');
  const requestBody =
    `<getEstUp>` +
    `<RutCompania>${escapeXml(rutNum)}</RutCompania>` +
    `<DvCompania>${escapeXml(dv)}</DvCompania>` +
    `<TrackId>${escapeXml(trackId)}</TrackId>` +
    `<Token>${escapeXml(token)}</Token>` +
    `</getEstUp>`;
  const { statusCode, body } = await soapRequest(host, '/DTEWS/QueryEstUp.jws', '""', requestBody);
  if (statusCode !== 200) {
    throw new Error(`[sii-client:soap] QueryEstUp.jws respondió HTTP ${statusCode}: ${body}`);
  }

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
  buildEnviarDteBody,
};
