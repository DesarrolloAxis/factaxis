'use strict';

/**
 * Simulador del webservice del SII. Implementa la misma interfaz que
 * soap.client.js (getSeed, getToken, enviarDte, queryEstUp) para poder
 * ejercitar todo el pipeline (sii-auth, envio, consulta, orchestrator,
 * poller) sin depender de que el certificado digital y el CAF de
 * certificación de ALMASEND ya estén tramitados con el SII.
 *
 * Estado en memoria únicamente — se reinicia con el proceso. `reset()` lo
 * limpia explícitamente (usado entre tests).
 */

const { v4: uuidv4 } = require('uuid');

/** trackId -> { estado, glosa, xmlRespuesta, consultas } */
const envios = new Map();

/**
 * Cuántas veces hay que consultar QueryEstUp antes de que el mock "resuelva"
 * el documento (simula el delay real del SII entre enviado -> en_proceso ->
 * aceptado/rechazado). Configurable para tests.
 */
let CONSULTAS_PARA_RESOLVER = 2;

function setConsultasParaResolver(n) {
  CONSULTAS_PARA_RESOLVER = n;
}

function reset() {
  envios.clear();
  CONSULTAS_PARA_RESOLVER = 2;
}

async function getSeed(_ambiente) {
  // El SII responde una semilla numérica de unos pocos dígitos.
  const semilla = String(Math.floor(100000000 + Math.random() * 899999999));
  return { semilla };
}

async function getToken(_ambiente, _semillaFirmadaXml) {
  // En el mock no validamos la firma de la semilla (eso se prueba contra
  // el ambiente real de certificación). Token opaco con TTL simulado.
  const token = `MOCK-TOKEN-${uuidv4()}`;
  return { token };
}

async function enviarDte(_ambiente, { envioDteXml, rutEmisor, rutEnvia, tipoDte, folio }, _token) {
  if (!envioDteXml || !envioDteXml.includes('<EnvioDTE')) {
    throw new Error('[sii-client:mock] enviarDte: el XML no parece un EnvioDTE válido');
  }
  const trackId = `MOCK-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  envios.set(trackId, {
    estado: 'en_proceso',
    glosa: 'Envio recibido, en proceso de validacion (mock)',
    xmlRespuesta: null,
    consultas: 0,
    rutEmisor,
    rutEnvia,
    tipoDte,
    folio,
  });
  return { trackId };
}

async function queryEstUp(_ambiente, { trackId, rutEmisor }, _token) {
  const envio = envios.get(trackId);
  if (!envio) {
    throw new Error(`[sii-client:mock] queryEstUp: trackId ${trackId} desconocido`);
  }
  if (envio.rutEmisor && rutEmisor && envio.rutEmisor !== rutEmisor) {
    throw new Error('[sii-client:mock] queryEstUp: rutEmisor no coincide con el emisor original del envio');
  }

  envio.consultas += 1;
  if (envio.consultas >= CONSULTAS_PARA_RESOLVER && envio.estado === 'en_proceso') {
    envio.estado = 'aceptado';
    envio.glosa = 'DTE recibido conforme (mock)';
    envio.xmlRespuesta =
      `<RESPUESTA_ENVIO_DTE><ESTADO>0</ESTADO><GLOSA>DTE recibido conforme</GLOSA>` +
      `<TRACKID>${trackId}</TRACKID></RESPUESTA_ENVIO_DTE>`;
  }

  return {
    estado: envio.estado,
    glosa: envio.glosa,
    xmlRespuesta: envio.xmlRespuesta,
  };
}

module.exports = {
  getSeed,
  getToken,
  enviarDte,
  queryEstUp,
  // utilidades exclusivas del mock, no forman parte de la interfaz común:
  __mock__: { reset, setConsultasParaResolver, envios },
};
