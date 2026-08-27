-- nro_resolucion_sii/fecha_resolucion_sii quedaban en NULL para ALMASEND
-- (nunca se configuraron tras la migración 009). El orquestador
-- (dte.orchestrator.js) cae en un default silencioso cuando faltan:
-- NroResol='0' y FchResol=fechaEmision (¡la fecha de HOY, no la fecha real
-- de autorización!) -- un valor casi con certeza incorrecto que el SII
-- puede rechazar al validarlo contra su propio registro del RUT.
--
-- Resolución Exenta N°80 de 2014: la resolución genérica que el SII
-- publicó habilitando a todos los contribuyentes elegibles para emitir
-- DTE sin trámite de resolución individual -- es la que aplica a ALMASEND.
UPDATE tenants
SET
  nro_resolucion_sii = '80',
  fecha_resolucion_sii = '2014-08-22'
WHERE rut = '78138404-6';
