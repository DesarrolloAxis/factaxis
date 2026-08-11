-- Eventos que el receptor de un documento reporta sobre él (acuse de
-- recibo, reclamo, aceptación comercial). Modelo creado en esta fase;
-- la lógica de negocio (ingesta, endpoints, notificaciones) queda para
-- una fase posterior — ver README del módulo.
CREATE TABLE dte_eventos_receptor (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  dte_documento_id  BIGINT NOT NULL REFERENCES dte_documentos (id) ON DELETE CASCADE,
  tipo_evento       VARCHAR(30) NOT NULL
                      CONSTRAINT chk_dte_eventos_receptor_tipo CHECK (
                        tipo_evento IN ('acuse_recibo', 'reclamo', 'aceptacion_comercial')
                      ),
  fecha_evento      TIMESTAMPTZ NOT NULL,
  rut_emisor_evento VARCHAR(12) NOT NULL, -- RUT de quien reporta el evento (el receptor del DTE)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dte_eventos_receptor_tenant_id ON dte_eventos_receptor (tenant_id);
CREATE INDEX idx_dte_eventos_receptor_documento_id ON dte_eventos_receptor (dte_documento_id);

COMMENT ON TABLE dte_eventos_receptor IS 'Eventos reportados por el receptor de un DTE. Modelo únicamente en esta fase; lógica de negocio pendiente.';
