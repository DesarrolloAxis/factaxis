'use strict';

/**
 * Provider "local" del vault: cifra con AES-256-GCM usando VAULT_MASTER_KEY
 * y persiste el ciphertext en la tabla vault_secrets. Pensado para
 * desarrollo/tests, NO para producción (ahí usar AWS Secrets Manager o
 * HashiCorp Vault — ver los otros providers en este directorio).
 *
 * VAULT_MASTER_KEY debe ser una clave de 32 bytes en base64. En un
 * despliegue real, esa clave a su vez debería administrarse con una KMS
 * (ej. envelope encryption), no vivir suelta en una env var — para el
 * alcance de este sprint, una env var es el mínimo aceptable descrito en
 * el requisito de seguridad ("al menos cifrado at-rest con una KMS key").
 */

const crypto = require('crypto');
const { pool } = require('../../../db/pool');

const ALGORITHM = 'aes-256-gcm';

function getMasterKey() {
  const b64 = process.env.VAULT_MASTER_KEY;
  if (!b64) {
    throw new Error('[vault:local] VAULT_MASTER_KEY no configurada');
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('[vault:local] VAULT_MASTER_KEY debe decodificar a 32 bytes (AES-256)');
  }
  return key;
}

async function putSecret({ tenantId, kind, value }) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const { rows } = await pool.query(
    `INSERT INTO vault_secrets (tenant_id, kind, ciphertext, iv, auth_tag)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ref`,
    [tenantId, kind, ciphertext, iv, authTag]
  );
  return rows[0].ref;
}

async function getSecret({ ref, tenantId }) {
  const key = getMasterKey();
  const { rows } = await pool.query(
    `SELECT tenant_id, ciphertext, iv, auth_tag FROM vault_secrets WHERE ref = $1`,
    [ref]
  );
  if (rows.length === 0) {
    throw new Error('[vault:local] secreto no encontrado');
  }
  const row = rows[0];
  // Defensa en profundidad: aunque el ref sea válido, si no pertenece al
  // tenant que lo solicita, se rechaza. Nunca se filtra en el mensaje de
  // error a qué tenant sí pertenece.
  if (String(row.tenant_id) !== String(tenantId)) {
    throw new Error('[vault:local] acceso denegado: el secreto no pertenece a este tenant');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, row.iv);
  decipher.setAuthTag(row.auth_tag);
  const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  return plaintext;
}

async function deleteSecret({ ref, tenantId }) {
  const { rowCount } = await pool.query(
    `DELETE FROM vault_secrets WHERE ref = $1 AND tenant_id = $2`,
    [ref, tenantId]
  );
  if (rowCount === 0) {
    throw new Error('[vault:local] secreto no encontrado o no pertenece a este tenant');
  }
}

module.exports = { putSecret, getSecret, deleteSecret };
