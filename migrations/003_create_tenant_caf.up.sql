-- CAF (Código de Autorización de Folios) por tenant y tipo de documento.
-- Un tenant puede tener varios rangos de folios vigentes/agotados/vencidos
-- para el mismo tipo_dte a lo largo del tiempo.
CREATE TABLE tenant_caf (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  tipo_dte          SMALLINT NOT NULL
                      CONSTRAINT chk_tenant_caf_tipo_dte CHECK (tipo_dte IN (33, 61)), -- Factura (33) y Nota de Crédito (61) en esta fase
  folio_desde       INTEGER NOT NULL,
  folio_hasta       INTEGER NOT NULL,
  folio_actual      INTEGER NOT NULL, -- próximo folio a asignar; avanza con SELECT ... FOR UPDATE
  archivo_caf       TEXT NOT NULL, -- XML completo del CAF entregado por el SII, CON LA CLAVE PRIVADA (RSASK) REDACTADA
  caf_key_ref       TEXT NOT NULL, -- referencia opaca al vault donde vive la clave privada RSA real del CAF
  fecha_solicitud   DATE NOT NULL,
  fecha_vencimiento DATE NOT NULL,
  estado            VARCHAR(20) NOT NULL DEFAULT 'vigente'
                      CONSTRAINT chk_tenant_caf_estado CHECK (estado IN ('vigente', 'agotado', 'vencido')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenant_caf_rango CHECK (folio_hasta >= folio_desde),
  CONSTRAINT chk_tenant_caf_actual_en_rango CHECK (folio_actual BETWEEN folio_desde AND folio_hasta + 1)
  -- folio_actual == folio_hasta + 1 significa "rango agotado"
);

CREATE INDEX idx_tenant_caf_tenant_id ON tenant_caf (tenant_id);

-- Búsqueda rápida del CAF vigente a usar para asignar el próximo folio de
-- un tipo de documento dado, siempre acotada por tenant.
CREATE INDEX idx_tenant_caf_tenant_tipo_estado
  ON tenant_caf (tenant_id, tipo_dte, estado);

-- No permitir dos CAF del mismo tenant/tipo con rangos de folio solapados.
CREATE UNIQUE INDEX uq_tenant_caf_rango
  ON tenant_caf (tenant_id, tipo_dte, folio_desde, folio_hasta);

COMMENT ON TABLE tenant_caf IS 'Folios (CAF) autorizados por el SII, por tenant y tipo de documento. Nunca se comparten folios entre tenants.';
COMMENT ON COLUMN tenant_caf.archivo_caf IS 'XML del CAF tal como lo entrega el SII, con el nodo RSASK (clave privada) redactado/reemplazado — la clave real solo vive en el vault (caf_key_ref).';
COMMENT ON COLUMN tenant_caf.caf_key_ref IS 'Referencia opaca (id de secreto) en el vault para la clave privada RSA de este CAF, usada para firmar el TED. Nunca exponer en respuestas de API.';
COMMENT ON COLUMN tenant_caf.folio_actual IS 'Próximo folio disponible a asignar. Debe mutarse únicamente dentro de una transacción con SELECT ... FOR UPDATE sobre esta fila.';
