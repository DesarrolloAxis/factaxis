DELETE FROM productos WHERE tenant_id = (SELECT id FROM tenants WHERE rut = '78138404-6');
DELETE FROM tenants WHERE rut = '78138404-6';
