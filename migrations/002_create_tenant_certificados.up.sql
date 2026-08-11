-- Certificados digitales de firma electrónica, uno o más por tenant
-- (se permite historial: certificado vencido + certificado vigente).
-- La clave privada NUNCA se guarda aquí: certificado_ref apunta a un
-- secreto en el vault (services/dte/vault.service.js).
CREATE TABLE tenant_certificados (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  certificado_ref   TEXT NOT NULL, -- referencia opaca al vault, nunca la clave en sí
  rut_certificado   VARCHAR(12) NOT NULL, -- RUT del titular del certificado (persona o empresa)
  vigencia_desde    DATE NOT NULL,
  vigencia_hasta    DATE NOT NULL,
  activo            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenant_certificados_vigencia CHECK (vigencia_hasta > vigencia_desde)
);

CREATE INDEX idx_tenant_certificados_tenant_id ON tenant_certificados (tenant_id);

-- A lo más un certificado activo por tenant a la vez (evita ambigüedad de
-- cuál usar para firmar). Desactivar el anterior antes de activar uno nuevo.
CREATE UNIQUE INDEX uq_tenant_certificados_activo_por_tenant
  ON tenant_certificados (tenant_id)
  WHERE activo = true;

COMMENT ON TABLE tenant_certificados IS 'Certificados de firma electrónica por tenant. certificado_ref es una referencia al vault, jamás la clave privada en texto plano.';
COMMENT ON COLUMN tenant_certificados.certificado_ref IS 'Referencia opaca (id de secreto) en el vault donde vive el .pfx cifrado. Nunca exponer en respuestas de API.';
