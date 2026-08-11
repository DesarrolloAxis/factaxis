'use strict';

/**
 * Vault de secretos del módulo DTE.
 *
 * Regla no negociable: la clave privada de un certificado digital (.pfx) y
 * las claves RSA de un CAF NUNCA se guardan en texto plano ni se loguean.
 * Este módulo es el único punto del código autorizado a manejar esas claves
 * en claro, y solo transitoriamente en memoria durante la firma
 * (ver ted.service.js / signature.service.js).
 *
 * Provider seleccionable vía VAULT_PROVIDER:
 *   - "local"                 -> AES-256-GCM sobre una tabla Postgres
 *                                 (vault_secrets), solo para dev/test.
 *   - "aws-secrets-manager"   -> stub, ver providers/aws-secrets-manager.provider.js
 *   - "hashicorp-vault"       -> stub, ver providers/hashicorp-vault.provider.js
 *
 * Cambiar de provider es un cambio de configuración (env var), no de código
 * que llama a este servicio: putSecret/getSecret/deleteSecret tienen la
 * misma firma sin importar el backend.
 */

const localProvider = require('./providers/local.provider');
const awsProvider = require('./providers/aws-secrets-manager.provider');
const hashicorpProvider = require('./providers/hashicorp-vault.provider');

function resolveProvider(providerName) {
  const name = providerName || process.env.VAULT_PROVIDER || 'local';
  switch (name) {
    case 'local':
      return localProvider;
    case 'aws-secrets-manager':
      return awsProvider;
    case 'hashicorp-vault':
      return hashicorpProvider;
    default:
      throw new Error(`[vault] VAULT_PROVIDER desconocido: "${name}"`);
  }
}

/**
 * Guarda un secreto (Buffer o string) y devuelve una referencia opaca
 * (`ref`) para recuperarlo después. `kind` es 'tenant_certificado' o
 * 'caf_rsa_key', usado solo para auditoría/organización, nunca para
 * saltarse el aislamiento por tenant.
 *
 * @param {object} params
 * @param {number} params.tenantId
 * @param {'tenant_certificado'|'caf_rsa_key'} params.kind
 * @param {Buffer|string} params.value
 * @param {object} [deps]
 * @returns {Promise<string>} ref
 */
async function putSecret({ tenantId, kind, value }, deps = {}) {
  if (!tenantId) throw new Error('[vault] putSecret requiere tenantId');
  if (!kind) throw new Error('[vault] putSecret requiere kind');
  if (value === undefined || value === null) throw new Error('[vault] putSecret requiere value');
  const provider = resolveProvider(deps.providerName);
  return provider.putSecret({ tenantId, kind, value });
}

/**
 * Recupera el valor en claro de un secreto. SIEMPRE se exige tenantId y se
 * valida que el secreto pertenezca a ese tenant — un ref de otro tenant
 * lanza error, incluso si el ref "existe".
 *
 * @param {object} params
 * @param {string} params.ref
 * @param {number} params.tenantId
 * @returns {Promise<Buffer>}
 */
async function getSecret({ ref, tenantId }, deps = {}) {
  if (!ref) throw new Error('[vault] getSecret requiere ref');
  if (!tenantId) throw new Error('[vault] getSecret requiere tenantId');
  const provider = resolveProvider(deps.providerName);
  return provider.getSecret({ ref, tenantId });
}

async function deleteSecret({ ref, tenantId }, deps = {}) {
  if (!ref) throw new Error('[vault] deleteSecret requiere ref');
  if (!tenantId) throw new Error('[vault] deleteSecret requiere tenantId');
  const provider = resolveProvider(deps.providerName);
  return provider.deleteSecret({ ref, tenantId });
}

module.exports = { putSecret, getSecret, deleteSecret };
