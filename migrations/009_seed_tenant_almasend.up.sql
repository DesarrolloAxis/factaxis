-- Tenant piloto: ALMASEND SpA. Único tenant cargado inicialmente, usado
-- para correr el set de pruebas de certificación del SII.
-- Certificado y CAF NO se siembran aquí: se ingestan vía
-- services/dte/caf.service.js / la carga del certificado cuando los
-- trámites externos con el SII estén resueltos (ver README).
INSERT INTO tenants (
  rut, razon_social, giro, direccion, comuna, ambiente_sii, activo
) VALUES (
  '78138404-6',
  'ALMASEND SpA',
  'Servicios de almacenamiento y despacho',
  'Por definir',
  'Por definir',
  'certificacion',
  true
);

-- Productos de ejemplo para poder ejercitar el endpoint de prueba
-- end-to-end sin depender de un módulo de catálogo real.
INSERT INTO productos (tenant_id, sku, nombre, precio_unitario, activo)
SELECT id, 'SKU-DEMO-001', 'Servicio de almacenamiento (demo)', 50000, true
FROM tenants WHERE rut = '78138404-6';

INSERT INTO productos (tenant_id, sku, nombre, precio_unitario, activo)
SELECT id, 'SKU-DEMO-002', 'Servicio de despacho (demo)', 15000, true
FROM tenants WHERE rut = '78138404-6';
