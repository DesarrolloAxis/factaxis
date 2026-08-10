-- Tabla raíz del modelo multi-tenant. Cada fila es una empresa (RUT) que
-- emite DTEs de forma independiente: certificado, CAF y folios propios.
CREATE TABLE tenants (
  id                  BIGSERIAL PRIMARY KEY,
  rut                 VARCHAR(12) NOT NULL, -- formato 78138404-6 (sin puntos)
  razon_social        VARCHAR(200) NOT NULL,
  giro                VARCHAR(200) NOT NULL,
  direccion           VARCHAR(250) NOT NULL,
  comuna              VARCHAR(100) NOT NULL,
  ambiente_sii        VARCHAR(20) NOT NULL DEFAULT 'certificacion'
                        CONSTRAINT chk_tenants_ambiente_sii
                        CHECK (ambiente_sii IN ('certificacion', 'produccion')),
  nro_resolucion_sii  VARCHAR(20),
  fecha_resolucion_sii DATE,
  activo              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_tenants_rut ON tenants (rut);
CREATE INDEX idx_tenants_activo ON tenants (activo);

COMMENT ON TABLE tenants IS 'Empresas (RUT) del ERP. Raíz del aislamiento multi-tenant: certificado, CAF y folios nunca se comparten entre filas de esta tabla.';
COMMENT ON COLUMN tenants.ambiente_sii IS 'Ambiente SII configurado para este tenant: certificacion (maullin.sii.cl) o produccion (palena.sii.cl).';
