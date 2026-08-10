'use strict';

/**
 * Punto único de acceso al cliente del SII. Selecciona mock o SOAP real
 * según SII_CLIENT_MODE (env var) o el override explícito pasado por el
 * caller — así los tests pueden forzar 'mock' sin tocar el entorno.
 *
 * Toda la interfaz pública (getSeed/getToken/enviarDte/queryEstUp) es
 * idéntica entre ambos clientes: sii-auth.service.js, envio.service.js y
 * consulta.service.js no necesitan saber cuál está activo.
 */

const mockClient = require('./mock.client');
const soapClient = require('./soap.client');

function getClient(mode) {
  const resolvedMode = mode || process.env.SII_CLIENT_MODE || 'mock';
  if (resolvedMode === 'mock') return mockClient;
  if (resolvedMode === 'soap') return soapClient;
  throw new Error(`[sii-client] SII_CLIENT_MODE desconocido: "${resolvedMode}" (usar "mock" o "soap")`);
}

module.exports = { getClient };
