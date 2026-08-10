'use strict';

/**
 * Stub del provider HashiCorp Vault. Implementar cuando se decida usar
 * Vault (KV v2 o el motor Transit) como backend de secretos en producción.
 *
 * Diseño esperado (no implementado aún):
 *  - putSecret: escribir en `secret/data/factaxis/dte/${kind}/${tenantId}/${uuid}`
 *    (KV v2) usando un token con policy acotada a ese prefijo. Devolver la
 *    path completa como `ref`.
 *  - getSecret: leer esa misma path; validar que contenga el tenantId
 *    esperado antes de devolver el valor.
 *  - deleteSecret: soft-delete vía KV v2 (mantener metadata/versiones para
 *    auditoría) salvo que se requiera destroy explícito.
 *  - Alternativa más fuerte: usar el motor Transit de Vault para firmar/
 *    descifrar sin que la clave privada salga nunca del servidor Vault
 *    (Vault hace la operación criptográfica, no factaxis). Si se opta por
 *    esto, signature.service.js y ted.service.js deberían delegar la
 *    operación de firma a este provider en vez de pedir la clave en claro.
 *
 * Activar con VAULT_PROVIDER=hashicorp-vault en el entorno.
 */

const NOT_IMPLEMENTED =
  '[vault:hashicorp-vault] provider no implementado todavía. ' +
  'Ver services/dte/providers/hashicorp-vault.provider.js para el diseño esperado.';

async function putSecret() {
  throw new Error(NOT_IMPLEMENTED);
}

async function getSecret() {
  throw new Error(NOT_IMPLEMENTED);
}

async function deleteSecret() {
  throw new Error(NOT_IMPLEMENTED);
}

module.exports = { putSecret, getSecret, deleteSecret };
