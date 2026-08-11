-- Corrige los datos placeholder de la migración 009 con los datos reales
-- de ALMASEND SpA, tomados de un Documento tributario ya generado y
-- enviado por el contribuyente (dte-33-28.xml, SET BASICO de
-- certificación, atención 4816286).
UPDATE tenants
SET
  giro = 'OTRAS ACTIVIDADES DE TECNOLOGIA DE LA INFORMACION Y DE SERVICIOS INFORMATICOS',
  direccion = 'Avenida El Rincon',
  comuna = 'Villa Alemana',
  acteco = '631100'
WHERE rut = '78138404-6';
