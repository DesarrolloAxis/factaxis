-- Historial de envíos de un documento al webservice del SII (EnvioDTE) y
-- su estado. Un documento puede tener más de una fila si hubo reintentos.
CREATE TABLE dte_envios (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  dte_documento_id  BIGINT NOT NULL REFERENCES dte_documentos (id) ON DELETE CASCADE,
  track_id          VARCHAR(50), -- asignado por el SII al recibir el EnvioDTE
  fecha_envio       TIMESTAMPTZ NOT NULL DEFAULT now(),
  estado_sii        VARCHAR(20) NOT NULL DEFAULT 'enviado'
                      CONSTRAINT chk_dte_envios_estado CHECK (
                        estado_sii IN ('enviado', 'en_proceso', 'aceptado', 'rechazado', 'reparo')
                      ),
  glosa_respuesta   TEXT,
  xml_respuesta     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dte_envios_tenant_id ON dte_envios (tenant_id);
CREATE INDEX idx_dte_envios_documento_id ON dte_envios (dte_documento_id);

-- El poller consulta periódicamente todos los envíos aún no resueltos,
-- siempre acotado por tenant.
CREATE INDEX idx_dte_envios_pendientes
  ON dte_envios (tenant_id, estado_sii)
  WHERE estado_sii IN ('enviado', 'en_proceso');

CREATE INDEX idx_dte_envios_track_id ON dte_envios (track_id);

COMMENT ON TABLE dte_envios IS 'Historial de envíos al webservice del SII y su estado (track_id, glosa, XML de respuesta).';
