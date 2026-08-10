-- Líneas de detalle de un documento. Incluye tenant_id denormalizado desde
-- dte_documentos (a pesar de no estar listado explícitamente en el diseño
-- original) para poder exigir el filtro tenant_id en esta tabla sin
-- depender de un JOIN — ver requisito de aislamiento no negociable.
CREATE TABLE dte_detalle (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  dte_documento_id  BIGINT NOT NULL REFERENCES dte_documentos (id) ON DELETE CASCADE,
  linea             SMALLINT NOT NULL,
  producto_id       BIGINT NOT NULL REFERENCES productos (id) ON DELETE RESTRICT,
  cantidad          NUMERIC(14, 4) NOT NULL,
  precio_unitario   NUMERIC(14, 4) NOT NULL,
  descuento         NUMERIC(14, 4) NOT NULL DEFAULT 0,
  monto_item        NUMERIC(14, 2) NOT NULL,
  CONSTRAINT chk_dte_detalle_cantidad CHECK (cantidad > 0)
);

CREATE INDEX idx_dte_detalle_tenant_id ON dte_detalle (tenant_id);
CREATE INDEX idx_dte_detalle_documento_id ON dte_detalle (dte_documento_id);
CREATE INDEX idx_dte_detalle_producto_id ON dte_detalle (producto_id);
CREATE UNIQUE INDEX uq_dte_detalle_documento_linea ON dte_detalle (dte_documento_id, linea);

COMMENT ON TABLE dte_detalle IS 'Líneas de detalle de un dte_documentos.';
