-- Almacenamiento del proveedor "local" del vault (services/dte/vault.service.js).
-- Solo se usa cuando VAULT_PROVIDER=local (desarrollo/pruebas). En producción
-- se espera VAULT_PROVIDER=aws-secrets-manager o hashicorp-vault, y esta
-- tabla queda vacía/sin uso — ver services/dte/README.md.
--
-- El contenido nunca se guarda en texto plano: se cifra con AES-256-GCM
-- usando VAULT_MASTER_KEY (o una KMS key en un despliegue real) antes de
-- insertarse, y solo se descifra en memoria al momento de firmar.
CREATE TABLE vault_secrets (
  id          BIGSERIAL PRIMARY KEY,
  ref         UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  kind        VARCHAR(30) NOT NULL
                CONSTRAINT chk_vault_secrets_kind CHECK (kind IN ('tenant_certificado', 'caf_rsa_key')),
  ciphertext  BYTEA NOT NULL,
  iv          BYTEA NOT NULL,
  auth_tag    BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- gen_random_uuid() vive en pgcrypto en versiones antiguas de PG; PG13+
-- la trae integrada. Si falla en un entorno viejo, habilitar la extensión:
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX uq_vault_secrets_ref ON vault_secrets (ref);
CREATE INDEX idx_vault_secrets_tenant_id ON vault_secrets (tenant_id);

COMMENT ON TABLE vault_secrets IS 'Backend del proveedor local del vault DTE. Solo ciphertext — nunca claves en texto plano. No usar en producción (usar AWS Secrets Manager / HashiCorp Vault).';
