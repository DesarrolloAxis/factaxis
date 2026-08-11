ALTER TABLE dte_documentos DROP CONSTRAINT chk_dte_documentos_tipo_dte;
ALTER TABLE dte_documentos ADD CONSTRAINT chk_dte_documentos_tipo_dte CHECK (tipo_dte IN (33, 61));

ALTER TABLE tenant_caf DROP CONSTRAINT chk_tenant_caf_tipo_dte;
ALTER TABLE tenant_caf ADD CONSTRAINT chk_tenant_caf_tipo_dte CHECK (tipo_dte IN (33, 61));

ALTER TABLE tenants DROP COLUMN acteco;
