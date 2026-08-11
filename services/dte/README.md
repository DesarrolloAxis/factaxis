# Módulo DTE — Facturador Electrónico multi-tenant

Motor propio de Documento Tributario Electrónico (DTE) para el ERP, sin
depender de un proveedor externo (Haulmer, OpenFactura, etc.). Cubre
**Factura Electrónica (33)** y **Nota de Crédito Electrónica (61)**.
Boleta electrónica, guía de despacho y facturación de compra quedan fuera
de esta fase.

Tenant piloto: **ALMASEND SpA**, RUT `78.138.404-6` — único tenant
cargado inicialmente (ver `migrations/009_seed_tenant_almasend.up.sql`).

## Multi-tenant por diseño

El motor (código de `/services/dte/`) es compartido entre todos los
tenants, pero **certificado digital, folios (CAF) y documentos nunca se
comparten**:

- `tenants.id` identifica a cada empresa (RUT propio).
- `tenant_certificados` guarda una *referencia* al certificado en el vault
  (nunca la clave privada en texto plano), con a lo más un certificado
  `activo` por tenant.
- `tenant_caf` guarda los rangos de folios autorizados por el SII, por
  tenant y tipo de documento, con su propia clave RSA (también solo por
  referencia al vault).
- Todas las tablas `dte_*` llevan `tenant_id` (algunas de forma
  denormalizada, ej. `dte_detalle`, para poder filtrar sin JOIN) y todo
  índice/unique constraint relevante está acotado por tenant — en
  particular `uq_dte_documentos_tenant_tipo_folio`, que hace literalmente
  imposible a nivel de DB que dos documentos del mismo tenant/tipo
  compartan folio.
- `services/dte/__tests__/tenant-isolation.test.js` escanea estáticamente
  todo el módulo y falla el build si aparece una query nueva contra una
  tabla `tenant_*`/`dte_*` sin `tenant_id` en el WHERE.

## Arquitectura

```
migrations/                  SQL versionado (up/down), ver abajo
db/
  pool.js                    Pool pg + withTransaction()
  repositories/               Toda la SQL del módulo vive acá, siempre con tenant_id
services/dte/
  vault.service.js           Abstracción de secretos (provider local | AWS | HashiCorp)
  providers/                 Implementaciones del vault
  caf.service.js             Parsing/ingesta de CAF + asignación atómica de folios
  ted.service.js             Bloque DD + firma SHA1withRSA con la llave del CAF -> TED
  signature.service.js       Firma XMLDSig (Documento y EnvioDTE) + parsing de .pfx
  sii-auth.service.js        GetSeed -> firmar semilla -> GetToken, cacheado por tenant
  envio.service.js           Carátula + SetDTE -> EnvioDTE, firma del sobre, envío
  consulta.service.js        QueryEstUp de un track_id puntual
  dte.orchestrator.js        Coordina el flujo completo de emisión
  sii-client/                mock.client.js y soap.client.js (misma interfaz)
  util/rut.util.js           Normalización/validación de RUT
  __fixtures__/               Generadores de CAF/certificado de prueba (NO usar en prod)
  __tests__/                  Tests (Jest) — usan el mock del SII
  test-support/testHelpers.js Helpers de test (reset de tablas, seed de cert+CAF)
jobs/
  dte-status-poller.js        Job que consulta track_id pendientes y actualiza estado
routes/dte.routes.js          Endpoints de prueba (setup + emisión + consulta)
middleware/tenant.middleware.js  Resuelve req.tenant desde el header X-Tenant-Rut
server.js                     Express app
```

### Flujo de emisión (`dte.orchestrator.emitir`)

```
venta_erp (confirmada)
  -> validar tenant activo + certificado vigente
  -> asignar folio (transacción con SELECT ... FOR UPDATE sobre tenant_caf) + crear
     dte_documentos en estado 'borrador' + dte_detalle   <-- se COMITEA acá
  -> generar XML del Documento (encabezado + detalle)
  -> calcular y firmar el TED con la clave RSA del CAF (ted.service)
  -> firmar el Documento completo con el certificado del tenant (signature.service)
  -> armar EnvioDTE (Carátula + SetDTE + Documento firmado)          (envio.service)
  -> firmar el EnvioDTE completo
  -> autenticar contra el SII (GetSeed/GetToken)                     (sii-auth.service)
  -> enviar el EnvioDTE, guardar track_id en dte_envios              (envio.service)
```

**Regla dura, no negociable:** un folio asignado nunca se reutiliza. Por
eso el paso de "asignar folio + crear documento" se comitea en su propia
transacción; todo lo que viene después corre fuera de esa transacción. Si
algo falla ahí (firma, red, el SII rechaza), el documento queda en
`estado_interno = 'error'` pero el folio sigue consumido — ver el test
`REGLA DURA` en `services/dte/__tests__/orchestrator.test.js`.

## Cómo correr las migraciones

```bash
cp .env.example .env   # y completar DATABASE_URL + VAULT_MASTER_KEY
npm install

npm run migrate:up       # aplica todas las migraciones pendientes
npm run migrate:status   # muestra cuáles están aplicadas
npm run migrate:down     # revierte la última
```

`VAULT_MASTER_KEY` debe ser 32 bytes en base64, p.ej.:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

Las migraciones fueron verificadas de punta a punta contra PostgreSQL 16
real: `up` completo, `down` completo (reversión total) y `up` de nuevo,
sin errores.

## Cómo correr los tests

Los tests son de integración real contra Postgres (no mocks de DB) — el
plan de negocio depende de comportamiento de DB real (FOR UPDATE,
constraints únicos, transacciones), así que mockear `pg` habría dado
falsa confianza. Lo que SÍ se mockea siempre es el SII (`sii-client/mock.client.js`).

```bash
npm test              # jest --runInBand (obligatorio: los tests comparten
                       # el tenant ALMASEND y NO son seguros en paralelo)
```

`jest.config.js` corre las migraciones automáticamente antes de la suite
(`globalSetup`). Los tests asumen `DATABASE_URL` apunta a una base de
**pruebas** (nunca producción) — cada archivo de test hace `TRUNCATE` de
las tablas `dte_*`/`tenant_certificados`/`tenant_caf`/`vault_secrets`
entre corridas.

## Mock del SII vs. SII real

`services/dte/sii-client/` expone una única interfaz
(`getSeed`, `getToken`, `enviarDte`, `queryEstUp`) con dos implementaciones:

| | `mock.client.js` | `soap.client.js` |
|---|---|---|
| Uso | Desarrollo/tests, sin red externa | Ambiente real del SII |
| Selección | `SII_CLIENT_MODE=mock` (default) | `SII_CLIENT_MODE=soap` |
| Estado | En memoria, simula enviado→en_proceso→aceptado | Llama a maullin.sii.cl / palena.sii.cl según `tenants.ambiente_sii` |

**Ningún servicio de negocio (`sii-auth`, `envio`, `consulta`,
`orchestrator`) sabe cuál está activo** — todos llaman a
`getClient()` de `sii-client/index.js`. Cambiar de mock a real es
**solo una variable de entorno**, no un cambio de código.

### Qué falta ajustar cuando el certificado + CAF de ALMASEND estén listos

1. **Ingestar el certificado real**: `POST /api/dte/setup/certificado`
   (o `signatureService.ingestarCertificado(...)` directo) con el `.pfx`
   real en base64 y su contraseña. Verificar que el RUT del certificado
   corresponda al RUT del tenant.
2. **Ingestar el/los CAF de certificación**: `POST /api/dte/setup/caf`
   con el XML tal cual lo entrega el SII (tipo 33 y tipo 61 por
   separado). `caf.service.ingestarCaf` valida que el RUT emisor del CAF
   coincida con el tenant.
3. **Cambiar `SII_CLIENT_MODE=soap`** y `tenants.ambiente_sii='certificacion'`.
4. **`services/dte/sii-client/soap.client.js` — YA PROBADO contra el SII
   real (ambiente de certificación), con un hallazgo importante:** el
   paquete npm `soap` (basado en parseo de WSDL) **no sirve** para
   `CrSeed.jws` / `GetTokenFromSeed.jws` / `QueryEstUp.jws` — esos
   webservices están publicados en estilo SOAP "RPC" antiguo y la
   librería falla con `invalid message definition for rpc style binding`
   al intentar `soap.createClientAsync(wsdl)`. La solución (ya aplicada):
   armar el sobre SOAP 1.1 a mano y mandarlo por HTTPS directo
   (`soapRequest()` en ese archivo), sin depender del parseo de WSDL.

   **Confirmado contra una respuesta real de `CrSeed.jws`** (CASO
   4816286-1, folio 31, ambiente de certificación): el SII devuelve el
   contenido de `getSeedReturn` escapado como entidades XML (no CDATA), y
   el tag de apertura trae un atributo — `<getSeedReturn
   xsi:type="xsd:string">...</getSeedReturn>`, no `<getSeedReturn>` a
   secas. La primera versión de `extractSoapReturn()` no toleraba ese
   atributo y fallaba con "No se pudo extraer SEMILLA de la respuesta"
   aunque la llamada SOAP en sí había funcionado (`ESTADO=00`, semilla
   real recibida). Ya corregido: el regex de `extractSoapReturn()` ahora
   acepta atributos arbitrarios en el tag de apertura. Sigue sin
   confirmarse el formato exacto de `GetTokenFromSeed.jws` y
   `QueryEstUp.jws` (se asume el mismo patrón por analogía, pero falta
   probarlo en un envío real completo). Lo que SÍ queda confirmado: la
   red desde Railway alcanza `maullin.sii.cl` sin problema, y el
   intercambio SOAP de semilla funciona de punta a punta contra el
   ambiente real.

   **`getSeed`/`getToken` ya confirmados de punta a punta contra el SII
   real** (ver arriba). `enviarDte` (POST multipart a `DTEUpload`) llegó a
   ejecutarse contra el servidor real por primera vez y el SII respondió
   con una página HTML genérica: *"HA OCURRIDO UN ERROR EN EL UPLOAD DEL
   ARCHIVO DE DOCUMENTOS TRIBUTARIOS ELECTRONICOS"* — o sea, el POST llegó
   y fue reconocido como intento de upload, pero algo del formato no
   pasó. Investigando contra referencias públicas (el ejemplo oficial
   `ejem_upload.txt` del propio sitio del SII, y la librería histórica
   `niclabs/DTE`), confirmamos que el orden y nombres de los campos
   multipart (`rutSender`→`dvSender`→`rutCompany`→`dvCompany`→`archivo`)
   ya eran correctos, pero **faltaba el header `User-Agent`** — tanto el
   ejemplo oficial del SII como `niclabs/DTE`
   (`UPLOAD_SII_HEADER_VALUE`) mandan explícitamente
   `Mozilla/4.0 (compatible; PROG 1.0; Windows NT 5.0; YComp 5.0.2.4)`,
   y `https.request` de Node no manda ningún `User-Agent` por defecto —
   es la hipótesis más probable de por qué el CGI legacy rechazó el
   request. Ya agregado. Sigue pendiente de confirmar contra un envío
   real exitoso.

   Pendiente de validar contra respuestas reales:
   - Que el fix del `User-Agent` efectivamente resuelva el error de
     upload (próximo intento).
   - El formato de respuesta de `GetTokenFromSeed.jws` (¿mismo patrón de
     `xsi:type` + entidades que `CrSeed.jws`? probablemente sí, ya que
     `CrSeed.jws` lo confirmó, pero falta ver una respuesta real de
     `GetTokenFromSeed.jws` específicamente).
   - El mapeo de códigos de estado de `mapEstadoSii()` — es una
     aproximación razonable, no una tabla oficial confirmada.
5. **Algoritmo de firma**: el pipeline usa SHA1withRSA / rsa-sha1 (lo
   histórico del SII, y lo que exige LibreDTE hoy). Si el set de pruebas
   de certificación rechaza por algoritmo, el cambio es acotado: las
   constantes `SHA1`/`RSA_SHA1` en `signature.service.js` y el hash en
   `ted.service.js`.
6. Correr el set de pruebas de certificación del SII contra ALMASEND y
   ajustar según los rechazos (`glosa_respuesta` en `dte_envios` queda
   registrada para cada intento).

### Nota sobre XMLDSig y `xml-crypto`

Al firmar el `EnvioDTE` (que envuelve un `Documento` ya firmado — dos
firmas anidadas en el mismo XML) se detectó que la librería `xml-crypto`
calcula el digest de la referencia usando serialización DOM plana si el
transform de la referencia no incluye explícitamente el algoritmo de
canonicalización (C14N) — **no basta con** `canonicalizationAlgorithm`
del `SignedXml` (eso solo canonicaliza `<SignedInfo>`). El resultado era
un digest inestable entre firma y verificación en documentos con varios
atributos `ID`. La corrección (agregar C14N a `ref.transforms` en
`signature.service.js#signElement`) está comentada in-line — no
quitarla.

## Seguridad (no negociable)

- La clave privada de un certificado (.pfx) y la clave RSA de un CAF
  nunca se guardan en texto plano ni se loguean. `vault.service.js` es el
  único punto autorizado a manejarlas en claro, y solo transitoriamente
  en memoria durante la firma.
- Provider `local` (`VAULT_PROVIDER=local`, default): AES-256-GCM sobre
  una tabla Postgres (`vault_secrets`), cifrado con `VAULT_MASTER_KEY`.
  Pensado para dev/test. Para producción usar
  `VAULT_PROVIDER=aws-secrets-manager` o `hashicorp-vault` — los
  providers están *stubbeados* con el diseño esperado en
  `services/dte/providers/`, pendientes de implementar contra la cuenta
  real que se decida usar.
- `certificado_ref` y `caf_key_ref` nunca se devuelven en ninguna
  respuesta de API (ver `db/repositories/*.repo.js`: ningún `SELECT`
  expuesto por rutas incluye esas columnas).
- Toda query a tablas `tenant_*`/`dte_*` filtra por `tenant_id` — ver
  `services/dte/__tests__/tenant-isolation.test.js`.

## Qué NO implementa esta fase (a propósito)

- Boleta electrónica, guía de despacho, factura de compra.
- Lógica de negocio de `dte_eventos_receptor` (la tabla existe, el
  procesamiento de acuse de recibo/reclamo/aceptación comercial queda
  para una fase posterior).
- La certificación real ante el SII (Sprint 5): depende de trámites
  externos (certificado digital + CAF de certificación) que corren en
  paralelo a este desarrollo.
