-- Documento tributario electrónico emitido por un tenant.
CREATE TABLE dte_documentos (
  id                      BIGSERIAL PRIMARY KEY,
  tenant_id               BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  tipo_dte                SMALLINT NOT NULL
                            CONSTRAINT chk_dte_documentos_tipo_dte CHECK (tipo_dte IN (33, 61)),
  folio                   INTEGER NOT NULL,
  fecha_emision           DATE NOT NULL,
  rut_receptor            VARCHAR(12) NOT NULL,
  razon_social_receptor   VARCHAR(200) NOT NULL,
  monto_neto              NUMERIC(14, 2) NOT NULL DEFAULT 0,
  monto_iva               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  monto_total             NUMERIC(14, 2) NOT NULL DEFAULT 0,
  xml_dte                 TEXT, -- XML del documento firmado (se completa tras firmar)
  estado_interno          VARCHAR(20) NOT NULL DEFAULT 'borrador'
                            CONSTRAINT chk_dte_documentos_estado CHECK (
                              estado_interno IN ('borrador', 'emitido', 'enviado', 'aceptado', 'rechazado', 'anulado', 'error')
                            ),
  referencia_documento_id BIGINT REFERENCES dte_documentos (id) ON DELETE RESTRICT, -- self-FK: NC que referencia la factura que anula/corrige
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dte_documentos_tenant_id ON dte_documentos (tenant_id);
CREATE INDEX idx_dte_documentos_tenant_estado ON dte_documentos (tenant_id, estado_interno);
CREATE INDEX idx_dte_documentos_referencia ON dte_documentos (referencia_documento_id);

-- Regla dura del SII: nunca puede haber dos documentos con el mismo folio
-- para el mismo tipo dentro de un mismo tenant (aunque uno haya quedado en
-- estado "error" tras un fallo de envío — el folio ya se consumió).
CREATE UNIQUE INDEX uq_dte_documentos_tenant_tipo_folio
  ON dte_documentos (tenant_id, tipo_dte, folio);

COMMENT ON TABLE dte_documentos IS 'Documentos tributarios electrónicos (Factura 33 / Nota de Crédito 61) por tenant.';
COMMENT ON COLUMN dte_documentos.referencia_documento_id IS 'Para Notas de Crédito (61): documento que anulan/corrigen. NULL para Facturas (33).';
COMMENT ON COLUMN dte_documentos.estado_interno IS 'Ciclo de vida interno del ERP, independiente de estado_sii (ver dte_envios): borrador -> emitido -> enviado -> aceptado|rechazado|anulado; error si falló el pipeline tras asignar folio.';
