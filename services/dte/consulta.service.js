'use strict';

/**
 * services/dte/consulta.service.js
 *
 * Consulta el estado de un envío (QueryEstUp) usando su track_id, y
 * actualiza dte_envios (y opcionalmente dte_documentos.estado_interno)
 * con el resultado. Usado tanto bajo demanda (endpoint) como desde
 * jobs/dte-status-poller.js.
 */

const enviosRepo = require('../../db/repositories/envios.repo');
const documentosRepo = require('../../db/repositories/documentos.repo');
const siiAuth = require('./sii-auth.service');
const { getClient } = require('./sii-client');

class ConsultaError extends Error {}

/**
 * Mapea el estado de dte_envios (más específico) al estado_interno de
 * dte_documentos (ciclo de vida del ERP).
 */
function mapEstadoInterno(estadoSii) {
  switch (estadoSii) {
    case 'aceptado':
      return 'aceptado';
    case 'rechazado':
      return 'rechazado';
    default:
      return null; // enviado / en_proceso / reparo: no cambia el estado_interno todavía
  }
}

/**
 * Consulta al SII el estado de un track_id puntual y persiste el
 * resultado. `envio` es la fila de dte_envios (debe incluir al menos
 * id, tenant_id, dte_documento_id, track_id).
 */
async function consultarEstado({ tenantId, tenant, envio, clientMode }) {
  if (!tenantId || !tenant || !envio || !envio.track_id) {
    throw new ConsultaError('consultarEstado requiere tenantId, tenant y envio con track_id');
  }

  const token = await siiAuth.getToken(tenantId, { clientMode });
  const client = getClient(clientMode);

  const { estado, glosa, xmlRespuesta } = await client.queryEstUp(
    tenant.ambiente_sii,
    { trackId: envio.track_id, rutEmisor: tenant.rut },
    token
  );

  const updated = await enviosRepo.updateEstado(envio.id, tenantId, {
    estadoSii: estado,
    glosaRespuesta: glosa,
    xmlRespuesta,
  });

  const estadoInterno = mapEstadoInterno(estado);
  if (estadoInterno) {
    await documentosRepo.updateEstado(envio.dte_documento_id, tenantId, estadoInterno);
  }

  return { estadoSii: updated.estado_sii, estadoInterno };
}

module.exports = { consultarEstado, mapEstadoInterno, ConsultaError };
