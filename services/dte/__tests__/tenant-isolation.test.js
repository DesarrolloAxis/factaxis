'use strict';

/**
 * Test de aislamiento multi-tenant (estático, sin DB).
 *
 * Escanea el código fuente de todo el módulo DTE (db/, services/dte/,
 * jobs/, routes/, middleware/) buscando cada llamada a `.query(...)` con
 * un string SQL literal, y verifica que toda consulta que toque una
 * tabla `tenant_*` / `dte_*` (o `productos`, `vault_secrets`) incluya un
 * filtro `tenant_id` — la única excepción legítima es `tenants` misma,
 * donde el rol de "tenant_id" lo cumple la columna `id` (ver
 * db/repositories/tenants.repo.js), y el listado explícito de todos los
 * tenants activos (`listActivos`, usado por el poller para iterar
 * tenant por tenant, no para leer datos de negocio).
 *
 * Esto no reemplaza tests de integración (ver los demás archivos de esta
 * carpeta), pero atrapa la clase de bug más peligrosa: un desarrollador
 * agrega un query nuevo a una tabla protegida (tenant_x, dte_x) y se
 * olvida del WHERE.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['db', 'services/dte', 'jobs', 'routes', 'middleware'];
const IGNORE_DIR_SEGMENTS = ['__tests__', '__fixtures__', 'test-support', 'node_modules'];

const GUARDED_TABLES = [
  'tenant_certificados',
  'tenant_caf',
  'dte_documentos',
  'dte_detalle',
  'dte_envios',
  'dte_eventos_receptor',
  'vault_secrets',
  'productos',
];

// { archivo relativo: [snippets de query permitidos sin tenant_id explícito] }
// Cada excepción debe justificarse en comentario — no agregar sin revisar
// con criterio de seguridad.
const ALLOWLIST = [
  {
    file: path.join('db', 'repositories', 'tenants.repo.js'),
    reason: 'tenants no tiene columna tenant_id: su propio id cumple ese rol, o es un listado explícito de sistema',
  },
];

function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    if (IGNORE_DIR_SEGMENTS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(listJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function extractSqlTemplateLiterals(source) {
  // Extrae contenidos de template literals sin interpolación (nuestras
  // queries no interpolan nombres de tabla/columna, solo usan $1, $2...).
  const matches = [];
  const regex = /`([^`]*)`/gs;
  let m;
  while ((m = regex.exec(source)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

function referencesGuardedTable(sql) {
  return GUARDED_TABLES.find((table) => new RegExp(`\\b${table}\\b`, 'i').test(sql));
}

function hasTenantIdFilter(sql) {
  return /\btenant_id\b/i.test(sql);
}

describe('aislamiento multi-tenant: toda query a tablas tenant_*/dte_* filtra por tenant_id', () => {
  const allFiles = SCAN_DIRS.flatMap((dir) => listJsFiles(path.join(ROOT, dir)));
  expect(allFiles.length).toBeGreaterThan(5); // sanity check: el scan realmente encontró archivos

  test.each(allFiles.map((f) => [path.relative(ROOT, f)]))('%s', (relFile) => {
    const isAllowlisted = ALLOWLIST.some((entry) => entry.file === relFile);
    if (isAllowlisted) {
      return; // revisado manualmente, ver ALLOWLIST arriba
    }

    const source = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
    const sqlSnippets = extractSqlTemplateLiterals(source);

    const infractores = sqlSnippets.filter((sql) => referencesGuardedTable(sql) && !hasTenantIdFilter(sql));

    if (infractores.length > 0) {
      throw new Error(
        `${relFile} tiene ${infractores.length} query(s) a una tabla protegida sin filtro tenant_id:\n` +
          infractores.map((s) => `  - ${s.replace(/\s+/g, ' ').trim()}`).join('\n')
      );
    }
  });
});
