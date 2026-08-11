-- STUB: tabla mínima de productos para poder declarar la FK
-- dte_detalle.producto_id que pide el diseño del módulo DTE.
-- El módulo de catálogo/inventario real del ERP reemplazará esta tabla
-- (o la migración deberá ajustarse para apuntar a la tabla definitiva);
-- se mantiene deliberadamente mínima y fuera del dominio `dte_`/`tenant_`.
CREATE TABLE productos (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  sku             VARCHAR(50) NOT NULL,
  nombre          VARCHAR(200) NOT NULL,
  precio_unitario NUMERIC(14, 2) NOT NULL DEFAULT 0,
  activo          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_productos_tenant_id ON productos (tenant_id);
CREATE UNIQUE INDEX uq_productos_tenant_sku ON productos (tenant_id, sku);

COMMENT ON TABLE productos IS 'STUB temporal para soportar dte_detalle.producto_id hasta que exista el módulo de catálogo del ERP.';
