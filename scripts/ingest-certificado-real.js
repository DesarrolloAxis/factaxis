#!/usr/bin/env node
'use strict';

/**
 * scripts/ingest-certificado-real.js
 *
 * Ingesta un certificado digital REAL (.pfx/.p12) de un tenant, para
 * reemplazar el "workaround" en test-support/testHelpers.js (que solo usa
 * certificados autofirmados de prueba). Este script llama exactamente al
 * mismo signatureService.ingestarCertificado(...) que usa
 * POST /api/dte/setup/certificado — la única diferencia es que valida y
 * muestra un preview del certificado (titular, vigencia real leída del
 * propio .pfx) antes de comprometerse a nada, y nunca imprime ni loguea
 * la contraseña, la llave privada, ni el contenido del .pfx.
 *
 * La CONTRASEÑA del .pfx NUNCA se pasa como argumento de línea de
 * comandos (quedaría en el historial del shell / en `ps`). Dos formas de
 * dársela:
 *   1. export CERT_PASSWORD='...'   (en tu propia terminal, no la pegues acá)
 *   2. Dejarla vacía: el script la pide con un prompt que no la muestra en pantalla.
 *
 * Uso:
 *   node scripts/ingest-certificado-real.js \
 *     --pfx /ruta/al/certificado.pfx \
 *     --rut-certificado 12345678-9 \
 *     [--tenant-rut 78138404-6]        # default: ALMASEND (tenant piloto)
 *     [--yes]                          # salta la confirmación interactiva
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const forge = require('node-forge');
const { pool } = require('../db/pool');
const tenantsRepo = require('../db/repositories/tenants.repo');
const signatureService = require('../services/dte/signature.service');

const DEFAULT_TENANT_RUT = '78138404-6'; // ALMASEND SpA — tenant piloto

function parseArgs(argv) {
  const args = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pfx') args.pfx = argv[++i];
    else if (a === '--rut-certificado') args.rutCertificado = argv[++i];
    else if (a === '--tenant-rut') args.tenantRut = argv[++i];
    else if (a === '--yes' || a === '-y') args.yes = true;
    else {
      console.error(`[ingest-certificado] argumento desconocido: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

/** Prompt que NO muestra en pantalla lo que se escribe (para la contraseña del .pfx). */
function promptHidden(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';
    const onData = (char) => {
      char = char.toString('utf8');
      if (char === '\n' || char === '\r' || char === '') {
        stdin.setRawMode(wasRaw || false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '') {
        process.stdout.write('\n');
        process.exit(1);
      } else if (char === '' || char === '\b') {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on('data', onData);
  });
}

function promptVisible(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function toIsoDate(forgeDate) {
  return forgeDate.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.pfx) {
    console.error('Uso: node scripts/ingest-certificado-real.js --pfx <ruta.pfx> --rut-certificado <RUT> [--tenant-rut <RUT>] [--yes]');
    process.exitCode = 1;
    return;
  }
  if (!args.rutCertificado) {
    console.error('[ingest-certificado] falta --rut-certificado (RUT del titular/representante del certificado)');
    process.exitCode = 1;
    return;
  }

  const pfxPath = path.resolve(args.pfx);
  if (!fs.existsSync(pfxPath)) {
    console.error(`[ingest-certificado] no existe el archivo: ${pfxPath}`);
    process.exitCode = 1;
    return;
  }
  const pfxBuffer = fs.readFileSync(pfxPath);
  console.log(`[ingest-certificado] leído ${pfxPath} (${pfxBuffer.length} bytes)`);

  const password = process.env.CERT_PASSWORD || (await promptHidden('Contraseña del .pfx (no se muestra en pantalla): '));
  if (!password) {
    console.error('[ingest-certificado] contraseña vacía — abortando');
    process.exitCode = 1;
    return;
  }

  // Solo lee metadatos públicos del certificado (titular, vigencia) para el
  // preview — parsePfx() es el único punto que toca la llave privada, y esta
  // función nunca la imprime ni la loguea.
  let certificatePem;
  try {
    ({ certificatePem } = signatureService.parsePfx(pfxBuffer, password));
  } catch (err) {
    console.error(`[ingest-certificado] no se pudo abrir el .pfx: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const cert = forge.pki.certificateFromPem(certificatePem);
  const cn = cert.subject.getField('CN');
  const vigenciaDesde = toIsoDate(cert.validity.notBefore);
  const vigenciaHasta = toIsoDate(cert.validity.notAfter);
  const vigente = Date.now() >= cert.validity.notBefore.getTime() && Date.now() <= cert.validity.notAfter.getTime();

  const tenantRut = args.tenantRut || DEFAULT_TENANT_RUT;
  const tenant = await tenantsRepo.getByRut(tenantRut);
  if (!tenant) {
    console.error(`[ingest-certificado] no existe ningún tenant con RUT ${tenantRut}`);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log('\n--- Preview del certificado (nada de esto es secreto) ---');
  console.log(`Titular (CN):        ${cn ? cn.value : '(no encontrado)'}`);
  console.log(`Vigencia:             ${vigenciaDesde} → ${vigenciaHasta} ${vigente ? '(vigente hoy)' : '(⚠ NO vigente hoy)'}`);
  console.log(`RUT certificado dado: ${args.rutCertificado}`);
  console.log(`Tenant destino:       ${tenant.razon_social} (id ${tenant.id}, RUT ${tenant.rut})`);
  console.log('-----------------------------------------------------------\n');

  if (!vigente) {
    console.error('[ingest-certificado] el certificado NO está vigente hoy — abortando (usa --yes si de verdad quieres ingestarlo igual)');
    if (!args.yes) {
      process.exitCode = 1;
      await pool.end();
      return;
    }
  }

  if (!args.yes) {
    const answer = await promptVisible('¿Ingestar este certificado para el tenant de arriba? Esto desactiva cualquier certificado previo. (escribe "si" para continuar): ');
    if (answer.toLowerCase() !== 'si' && answer.toLowerCase() !== 'sí') {
      console.log('[ingest-certificado] cancelado por el usuario.');
      await pool.end();
      return;
    }
  }

  const result = await signatureService.ingestarCertificado({
    tenantId: tenant.id,
    pfxBuffer,
    password,
    rutCertificado: args.rutCertificado,
    vigenciaDesde,
    vigenciaHasta,
  });

  console.log(`\n[ingest-certificado] listo. Certificado id=${result.id} activo para tenant ${result.tenantId}, vigente hasta ${result.vigenciaHasta}.`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[ingest-certificado] FAILED:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { main };
