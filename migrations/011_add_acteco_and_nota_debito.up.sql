-- Ajustes surgidos de revisar el SET BASICO real de certificación del SII
-- para ALMASEND SpA (atención 4816286):
--
-- 1. El Emisor de un Documento debe declarar su código de actividad
--    económica (<Acteco>). Se agrega como columna del tenant (puede tener
--    más de un giro/acteco en la vida real, pero para esta fase basta uno).
-- 2. El SET BASICO exige un caso de Nota de Débito Electrónica (tipo 56)
--    además de Factura (33) y Nota de Crédito (61) — se amplía el check
--    de tipo_dte en las tablas que lo restringían a {33, 61}.

ALTER TABLE tenants ADD COLUMN acteco VARCHAR(10);
COMMENT ON COLUMN tenants.acteco IS 'Código de actividad económica (SII) usado en el Emisor de cada Documento.';

ALTER TABLE tenant_caf DROP CONSTRAINT chk_tenant_caf_tipo_dte;
ALTER TABLE tenant_caf ADD CONSTRAINT chk_tenant_caf_tipo_dte CHECK (tipo_dte IN (33, 56, 61));

ALTER TABLE dte_documentos DROP CONSTRAINT chk_dte_documentos_tipo_dte;
ALTER TABLE dte_documentos ADD CONSTRAINT chk_dte_documentos_tipo_dte CHECK (tipo_dte IN (33, 56, 61));
