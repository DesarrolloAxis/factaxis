#!/usr/bin/env node
'use strict';

/**
 * scripts/ingest-caf-real.js
 *
 * Ingesta un CAF (Código de Autorización de Folios) REAL entregado por el
 * SII para un tenant. Llama exactamente al mismo
 * caf.service.ingestarCaf(...) que ya usa POST /api/dte/setup/caf —
 * la diferencia es que muestra un preview (RUT emisor, tipo de documento,
 * rango de folios, fecha de autorización) antes de comprometerse a nada,
 * con confirmación interactiva.
 *
 * El CAF trae en claro la llave privada RSA (<RSASK>) que el SII genera
 * para firmar el TED de ese rango de folios — es tan sensible como la
 * llave privada de un certificado .pfx. Este script NUNCA imprime ni
 * loguea esa llave, ni el XML crudo completo del CAF.
 *
 * ingestarCaf() ya valida que el RUT emisor del CAF coincida con el RUT
 * del tenant — si no coincide, falla ahí (no hace falta que este script
 * lo revalide).
 *
 * Uso (una vez por tipo de documento — el SII entrega un CAF por tipo):
 *   node scripts/ingest-caf-real.js --caf /ruta/al/CAF33.xml [--tenant-rut 78138404-6] [--yes]
 *   node scripts/ingest-caf-real.js --caf /ruta/al/CAF61.xml [--tenant-rut 78138404-6] [--yes]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pool } = require('../db/pool');
const tenantsRepo = require('../db/repositories/tenants.repo');
const cafService = require('../services/dte/caf.service');
const rutUtil = require('../services/dte/util/rut.util');

const DEFAULT_TENANT_RUT = '78138404-6'; // ALMASEND SpA — tenant piloto

function parseArgs(argv) {
  const args = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--caf') args.caf = argv[++i];
    else if (a === '--tenant-rut') args.tenantRut = argv[++i];
    else if (a === '--yes' || a === '-y') args.yes = true;
    else {
      console.error(`[ingest-caf] argumento desconocido: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function promptVisible(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.caf) {
    console.error('Uso: node scripts/ingest-caf-real.js --caf <ruta.xml> [--tenant-rut <RUT>] [--yes]');
    process.exitCode = 1;
    return;
  }

  const cafPath = path.resolve(args.caf);
  if (!fs.existsSync(cafPath)) {
    console.error(`[ingest-caf] no existe el archivo: ${cafPath}`);
    process.exitCode = 1;
    return;
  }
  const xmlString = fs.readFileSync(cafPath, 'utf8');
  console.log(`[ingest-caf] leído ${cafPath} (${xmlString.length} caracteres)`);

  // parseCaf() no toca la DB ni el vault — solo lee el XML. Su resultado
  // incluye privateKeyPem/publicKeyPem (la llave RSA del CAF): NUNCA se
  // imprimen ni se loguean acá, solo se usan los campos públicos del preview.
  let caf;
  try {
    caf = cafService.parseCaf(xmlString);
  } catch (err) {
    console.error(`[ingest-caf] CAF inválido: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const tenantRut = args.tenantRut || DEFAULT_TENANT_RUT;
  const tenant = await tenantsRepo.getByRut(tenantRut);
  if (!tenant) {
    console.error(`[ingest-caf] no existe ningún tenant con RUT ${tenantRut}`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log('\n--- Preview del CAF (nada de esto es secreto) ---');
  console.log(`RUT emisor (del CAF): ${caf.rutEmisor}`);
  console.log(`Razón social:         ${caf.razonSocial}`);
  console.log(`Tipo DTE:             ${caf.tipoDte}`);
  console.log(`Rango de folios:      ${caf.folioDesde} → ${caf.folioHasta}`);
  console.log(`Fecha autorización:   ${caf.fechaAutorizacion}`);
  console.log(`Tenant destino:       ${tenant.razon_social} (id ${tenant.id}, RUT ${tenant.rut})`);
  console.log('----------------------------------------------------\n');

  if (!rutUtil.iguales(caf.rutEmisor, tenant.rut)) {
    // ingestarCaf() ya rechaza esto formalmente; esto es solo una advertencia temprana.
    console.warn('[ingest-caf] ⚠ el RUT emisor del CAF no coincide con el RUT del tenant — la ingesta va a fallar.');
  }

  if (!args.yes) {
    const answer = await promptVisible(
      `¿Ingestar este CAF (folios ${caf.folioDesde}-${caf.folioHasta}, tipo ${caf.tipoDte}) para el tenant de arriba? (escribe "si" para continuar): `
    );
    if (answer.toLowerCase() !== 'si' && answer.toLowerCase() !== 'sí') {
      console.log('[ingest-caf] cancelado por el usuario.');
      await pool.end();
      return;
    }
  }

  const result = await cafService.ingestarCaf({ tenantId: tenant.id, xmlString });

  console.log(
    `\n[ingest-caf] listo. CAF id=${result.id} para tenant ${result.tenantId}, tipo_dte=${result.tipoDte}, ` +
      `folios ${result.folioDesde}-${result.folioHasta} (próximo a asignar: ${result.folioActual}), estado=${result.estado}.`
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[ingest-caf] FAILED:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { main };
