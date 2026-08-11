'use strict';

/**
 * Stub del provider AWS Secrets Manager. Implementar cuando se decida usar
 * AWS como backend de secretos en producción.
 *
 * Diseño esperado (no implementado aún):
 *  - putSecret: CreateSecretCommand / PutSecretValueCommand, con
 *    SecretId = `factaxis/dte/${kind}/${tenantId}/${uuid}`. Devolver ese
 *    SecretId completo como `ref` (es opaco para el resto del código).
 *  - getSecret: GetSecretValueCommand por SecretId; validar que el
 *    SecretId contenga el tenantId esperado antes de devolver el valor
 *    (defensa en profundidad, igual que el provider local).
 *  - deleteSecret: DeleteSecretCommand con ForceDeleteWithoutRecovery
 *    solo si así se decide operacionalmente (por defecto dejar el
 *    recovery window de AWS).
 *  - Requiere @aws-sdk/client-secrets-manager y credenciales IAM con
 *    permiso mínimo (solo el prefijo factaxis/dte/*).
 *
 * Activar con VAULT_PROVIDER=aws-secrets-manager en el entorno.
 */

const NOT_IMPLEMENTED =
  '[vault:aws-secrets-manager] provider no implementado todavía. ' +
  'Ver services/dte/providers/aws-secrets-manager.provider.js para el diseño esperado.';

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
