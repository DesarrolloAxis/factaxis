'use strict';

/**
 * services/dte/caf.service.js
 *
 * Parsing e ingesta de archivos CAF (XML del SII), validación de RUT
 * emisor vs tenant, y asignación atómica de folios.
 *
 * El CAF trae, entre otras cosas, un par de llaves RSA (<RSASK> privada,
 * <RSAPUBK> pública) que el SII genera exclusivamente para firmar el TED
 * de los documentos de ese rango de folios. La llave privada NUNCA se
 * persiste en claro: se guarda en el vault (vault.service.js) y el XML
 * que se guarda en tenant_caf.archivo_caf tiene el nodo <RSASK> redactado.
 */

const { XMLParser } = require('fast-xml-parser');
const { withTransaction } = require('../../db/pool');
const cafRepo = require('../../db/repositories/caf.repo');
const tenantsRepo = require('../../db/repositories/tenants.repo');
const vault = require('./vault.service');
const rutUtil = require('./util/rut.util');

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

class CafValidationError extends Error {}
class FoliosAgotadosError extends Error {}

/**
 * Parsea el XML de un CAF y devuelve sus campos relevantes en un objeto
 * plano. No toca la base de datos ni el vault.
 */
function parseCaf(xmlString) {
  let parsed;
  try {
    parsed = xmlParser.parse(xmlString);
  } catch (err) {
    throw new CafValidationError(`XML de CAF inválido: ${err.message}`);
  }

  const autorizacion = parsed.AUTORIZACION;
  if (!autorizacion || !autorizacion.CAF || !autorizacion.CAF.DA) {
    throw new CafValidationError('Estructura de CAF inválida: falta AUTORIZACION/CAF/DA');
  }

  const da = autorizacion.CAF.DA;
  const rsask = autorizacion.RSASK;
  const rsapubk = autorizacion.RSAPUBK;

  if (!rsask) {
    throw new CafValidationError('CAF sin nodo RSASK (llave privada)');
  }

  const folioDesde = Number(da.RNG?.D);
  const folioHasta = Number(da.RNG?.H);
  const tipoDte = Number(da.TD);

  if (!da.RE || !folioDesde || !folioHasta || !tipoDte) {
    throw new CafValidationError('CAF incompleto: faltan campos obligatorios en DA (RE, TD, RNG)');
  }
  if (folioHasta < folioDesde) {
    throw new CafValidationError('CAF inválido: RNG.H es menor que RNG.D');
  }

  return {
    rutEmisor: rutUtil.normalizar(da.RE),
    razonSocial: da.RS,
    tipoDte,
    folioDesde,
    folioHasta,
    fechaAutorizacion: da.FA,
    idk: da.IDK,
    rsaModulusB64: da.RSAPK?.M,
    rsaExponentB64: da.RSAPK?.E,
    privateKeyPem: typeof rsask === 'string' ? rsask.trim() : String(rsask).trim(),
    publicKeyPem: rsapubk ? (typeof rsapubk === 'string' ? rsapubk.trim() : String(rsapubk)) : null,
  };
}

/** Devuelve el XML original con el contenido de <RSASK> reemplazado. */
function redactarClavePrivada(xmlString) {
  return xmlString.replace(
    /<RSASK>[\s\S]*?<\/RSASK>/,
    '<RSASK>[REDACTED - clave privada movida al vault, ver tenant_caf.caf_key_ref]</RSASK>'
  );
}

/**
 * Ingesta un CAF nuevo para un tenant: valida que el RUT emisor del CAF
 * coincida con el RUT del tenant, guarda la clave privada en el vault, y
 * persiste la fila en tenant_caf con el XML redactado.
 *
 * @param {object} params
 * @param {number} params.tenantId
 * @param {string} params.xmlString - contenido completo del CAF entregado por el SII
 * @param {number} [params.vigenciaMeses] - ventana operativa de renovación (el SII no expira el CAF en sí)
 */
async function ingestarCaf({ tenantId, xmlString, vigenciaMeses = 6 }) {
  const tenant = await tenantsRepo.getById(tenantId);
  if (!tenant) {
    throw new CafValidationError(`Tenant ${tenantId} no existe`);
  }

  const caf = parseCaf(xmlString);

  if (!rutUtil.iguales(caf.rutEmisor, tenant.rut)) {
    throw new CafValidationError(
      `RUT emisor del CAF (${caf.rutEmisor}) no coincide con el RUT del tenant (${tenant.rut})`
    );
  }

  const cafKeyRef = await vault.putSecret({
    tenantId,
    kind: 'caf_rsa_key',
    value: caf.privateKeyPem,
  });

  const fechaSolicitud = caf.fechaAutorizacion || new Date().toISOString().slice(0, 10);
  const fechaVencimiento = addMonths(fechaSolicitud, vigenciaMeses);

  const row = await cafRepo.insert({
    tenantId,
    tipoDte: caf.tipoDte,
    folioDesde: caf.folioDesde,
    folioHasta: caf.folioHasta,
    folioActual: caf.folioDesde,
    archivoCaf: redactarClavePrivada(xmlString),
    cafKeyRef,
    fechaSolicitud,
    fechaVencimiento,
  });

  return {
    id: row.id,
    tenantId,
    tipoDte: row.tipo_dte,
    folioDesde: row.folio_desde,
    folioHasta: row.folio_hasta,
    folioActual: row.folio_actual,
    estado: row.estado,
  };
}

function addMonths(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Asigna atómicamente el siguiente folio disponible para tenant_id/tipo_dte.
 * Usa SELECT ... FOR UPDATE dentro de una transacción para evitar folios
 * duplicados bajo ventas concurrentes: dos llamadas simultáneas para el
 * mismo tenant se serializan sobre la fila del CAF.
 *
 * Si se pasa un `client` externo, se asume que YA está dentro de una
 * transacción (uso típico: el orquestador, que necesita que la asignación
 * de folio y la creación del dte_documento sean atómicas juntas). Si no se
 * pasa, esta función abre y cierra su propia transacción.
 *
 * @returns {Promise<{folio:number, cafId:number, cafKeyRef:string}>}
 */
async function asignarFolio(tenantId, tipoDte, client) {
  const run = async (c) => {
    const caf = await cafRepo.lockCafConFolioDisponible(c, tenantId, tipoDte);
    if (!caf) {
      throw new FoliosAgotadosError(
        `No hay folios disponibles para tenant ${tenantId} / tipo_dte ${tipoDte}. Se requiere ingestar un nuevo CAF.`
      );
    }
    const folio = caf.folio_actual;
    await cafRepo.consumirFolio(c, tenantId, caf.id, folio);
    return { folio, cafId: caf.id, cafKeyRef: caf.caf_key_ref };
  };

  if (client) return run(client);
  return withTransaction(run);
}

module.exports = {
  parseCaf,
  ingestarCaf,
  asignarFolio,
  redactarClavePrivada,
  CafValidationError,
  FoliosAgotadosError,
};
