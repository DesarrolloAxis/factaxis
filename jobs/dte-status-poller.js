'use strict';

/**
 * jobs/dte-status-poller.js
 *
 * Job periódico que recorre todos los tenants activos, consulta el
 * estado (QueryEstUp) de sus envíos aún no resueltos (estado_sii IN
 * ('enviado','en_proceso')) y actualiza dte_envios / dte_documentos.
 *
 * Cada tenant se procesa de forma aislada: un error en un tenant no debe
 * detener el polling de los demás. Cada consulta usa siempre el token del
 * tenant correspondiente (sii-auth.service ya lo cachea por tenant).
 *
 * Uso:
 *   node jobs/dte-status-poller.js          # corre una vez y termina
 *   npm run poller:dte                      # idem
 *
 * En producción, este script se invoca desde un scheduler (cron de
 * Railway, node-cron embebido en el server, etc.) — ver runForever() más
 * abajo para dejarlo corriendo con node-cron dentro del mismo proceso del
 * ERP si se prefiere no depender de un scheduler externo.
 */

require('dotenv').config();
const tenantsRepo = require('../db/repositories/tenants.repo');
const enviosRepo = require('../db/repositories/envios.repo');
const consultaService = require('../services/dte/consulta.service');
const { pool } = require('../db/pool');

/** Corre un ciclo completo de polling (todos los tenants activos). Devuelve un resumen. */
async function runOnce({ clientMode } = {}) {
  const tenants = await tenantsRepo.listActivos();
  const resumen = { tenants: 0, consultados: 0, actualizados: 0, errores: [] };

  for (const tenant of tenants) {
    resumen.tenants += 1;
    let pendientes;
    try {
      pendientes = await enviosRepo.listPendientesByTenant(tenant.id);
    } catch (err) {
      resumen.errores.push({ tenantId: tenant.id, error: `listPendientesByTenant: ${err.message}` });
      continue;
    }

    for (const envio of pendientes) {
      resumen.consultados += 1;
      try {
        const { estadoSii } = await consultaService.consultarEstado({
          tenantId: tenant.id,
          tenant,
          envio,
          clientMode,
        });
        if (estadoSii !== envio.estado_sii) {
          resumen.actualizados += 1;
        }
      } catch (err) {
        resumen.errores.push({
          tenantId: tenant.id,
          envioId: envio.id,
          trackId: envio.track_id,
          error: err.message,
        });
      }
    }
  }

  return resumen;
}

/** Deja el poller corriendo dentro del proceso actual con node-cron (opcional). */
function runForever({ cronExpression = process.env.DTE_POLLER_CRON || '*/5 * * * *', clientMode } = {}) {
  const cron = require('node-cron');
  // eslint-disable-next-line no-console
  console.log(`[dte-status-poller] programado con cron "${cronExpression}"`);
  return cron.schedule(cronExpression, async () => {
    const resumen = await runOnce({ clientMode });
    // eslint-disable-next-line no-console
    console.log('[dte-status-poller]', JSON.stringify(resumen));
  });
}

if (require.main === module) {
  runOnce()
    .then((resumen) => {
      // eslint-disable-next-line no-console
      console.log('[dte-status-poller]', JSON.stringify(resumen, null, 2));
      return pool.end();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[dte-status-poller] error fatal', err);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { runOnce, runForever };
