# factaxis

ERP SaaS multi-tenant para pymes chilenas. Stack: React 19 / Vite /
Tailwind (frontend, no incluido en este sprint) + Node.js / Express /
PostgreSQL (backend) / Railway.

## Módulo Facturador Electrónico (DTE)

Este sprint entrega el módulo nativo de Facturación Electrónica (DTE):
Factura Electrónica (33) y Nota de Crédito Electrónica (61), multi-tenant
desde el diseño, con el pipeline completo (folios, TED, firma XMLDSig,
autenticación y envío al SII) testeable end-to-end contra un simulador
del SII mientras se resuelven los trámites de certificado digital y CAF
de certificación con la empresa piloto (ALMASEND SpA).

Ver **[services/dte/README.md](services/dte/README.md)** para la
arquitectura completa, cómo correr migraciones/tests, y cómo pasar del
simulador al SII real.

## Quickstart

```bash
cp .env.example .env
# completar DATABASE_URL (Postgres) y VAULT_MASTER_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

npm install
npm run migrate:up
npm test

npm start   # levanta el servidor Express en :3000 (o $PORT)
```

Endpoint de prueba end-to-end (usa el tenant ALMASEND por defecto —
header `X-Tenant-Rut` para probar otro tenant si se agrega uno):

```bash
curl -X POST localhost:3000/api/dte/test/emitir \
  -H 'Content-Type: application/json' \
  -d '{
    "tipoDte": 33,
    "receptor": {"rut": "66666666-6", "razonSocial": "Cliente Ejemplo"},
    "items": [{"productoId": 1, "cantidad": 2}]
  }'
```
