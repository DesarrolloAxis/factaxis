'use strict';

/**
 * services/dte/dte.orchestrator.js
 *
 * Coordina el flujo completo de emisión de un DTE (Factura 33 o Nota de
 * Crédito 61), a partir de una venta ya confirmada en el ERP:
 *
 *   validar tenant (certificado vigente + folios disponibles)
 *   -> asignar folio (transacción atómica, FOR UPDATE)
 *   -> generar XML del Documento (encabezado + detalle)
 *   -> calcular y firmar TED con la clave RSA del CAF
 *   -> firmar el Documento completo con el certificado del tenant (XMLDSig)
 *   -> armar EnvioDTE (Carátula + SetDTE + Documento firmado)
 *   -> firmar el EnvioDTE completo
 *   -> autenticar contra el SII (GetSeed/GetToken)
 *   -> enviar el EnvioDTE, guardar track_id en dte_envios
 *
 * Regla dura del SII: un folio asignado NUNCA se reutiliza, ni siquiera si
 * el pipeline falla después de asignarlo. Por eso la asignación de folio +
 * la creación del documento (estado 'borrador') se hacen y se COMMITEAN en
 * una transacción propia (paso 1); todo lo que viene después (generar XML,
 * firmar, enviar) corre fuera de esa transacción — si algo falla ahí, el
 * documento queda marcado estado_interno='error' pero el folio sigue
 * consumido.
 */

const { pool, withTransaction } = require('../../db/pool');
const tenantsRepo = require('../../db/repositories/tenants.repo');
const documentosRepo = require('../../db/repositories/documentos.repo');
const detalleRepo = require('../../db/repositories/detalle.repo');
const productosRepo = require('../../db/repositories/productos.repo');

const cafService = require('./caf.service');
const tedService = require('./ted.service');
const signatureService = require('./signature.service');
const envioService = require('./envio.service');
const siiAuth = require('./sii-auth.service');
const vault = require('./vault.service');

class OrchestratorError extends Error {}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const IVA_TASA = 0.19;

function calcularMontos(lineas) {
  const montoNeto = lineas.reduce((acc, l) => acc + l.montoItem, 0);
  const montoIva = Math.round(montoNeto * IVA_TASA);
  const montoTotal = montoNeto + montoIva;
  return { montoNeto, montoIva, montoTotal };
}

/**
 * Paso 1: valida el tenant, asigna folio y deja el documento creado en
 * estado 'borrador' junto con su detalle. Todo en una única transacción
 * que se comitea al final — el folio queda consumido pase lo que pase
 * después.
 */
async function _crearBorradorConFolio({
  tenantId,
  tipoDte,
  receptor,
  items,
  fechaEmision,
  referenciaDocumentoId,
  soloReferencia,
}) {
  const tenant = await tenantsRepo.getById(tenantId);
  if (!tenant || !tenant.activo) {
    throw new OrchestratorError(`Tenant ${tenantId} no existe o está inactivo`);
  }

  // Validar certificado vigente ANTES de tocar folios: si no hay
  // certificado, no tiene sentido consumir un folio que no se podrá firmar.
  await signatureService.getCertificadoActivo(tenantId);

  if (!soloReferencia && (!items || items.length === 0)) {
    throw new OrchestratorError('El documento requiere al menos una línea de detalle (o soloReferencia: true)');
  }

  return withTransaction(async (client) => {
    const { folio, cafId, cafKeyRef } = await cafService.asignarFolio(tenantId, tipoDte, client);

    let lineas = [];
    let montoNeto = 0;
    let montoIva = 0;
    let montoTotal = 0;

    if (!soloReferencia) {
      for (const item of items) {
        const producto = await productosRepo.getById(item.productoId, tenantId, client);
        if (!producto) {
          throw new OrchestratorError(`Producto ${item.productoId} no existe para este tenant`);
        }
        const precioUnitario = item.precioUnitario ?? Number(producto.precio_unitario);
        const descuento = item.descuento || 0;
        const montoItem = Math.round(item.cantidad * precioUnitario - descuento);
        lineas.push({
          productoId: producto.id,
          nombre: producto.nombre,
          cantidad: item.cantidad,
          precioUnitario,
          descuento,
          montoItem,
        });
      }
      ({ montoNeto, montoIva, montoTotal } = calcularMontos(lineas));
    }

    const documento = await documentosRepo.insert(
      {
        tenantId,
        tipoDte,
        folio,
        fechaEmision,
        rutReceptor: receptor.rut,
        razonSocialReceptor: receptor.razonSocial,
        montoNeto,
        montoIva,
        montoTotal,
        estadoInterno: 'borrador',
        referenciaDocumentoId: referenciaDocumentoId || null,
      },
      client
    );

    if (lineas.length > 0) {
      await detalleRepo.insertMany(tenantId, documento.id, lineas, client);
    }

    return {
      tenant,
      documentoId: documento.id,
      folio,
      cafId,
      cafKeyRef,
      lineas,
      montoNeto,
      montoIva,
      montoTotal,
    };
  });
}

/**
 * Construye el bloque <Referencia> para una Nota de Crédito/Débito
 * (tipo 61/56). `codRef` es opcional: 1=Anula Documento Referencia,
 * 2=Corrige Texto Documento Referencia, 3=Corrige Montos. El SII no lo
 * exige siempre, pero certificación lo pide explícito en los casos de
 * anulación/corrección de texto.
 */
async function _buildReferenciaXml(tenantId, referenciaDocumentoId, razonRef, codRef, client) {
  const original = await documentosRepo.getById(referenciaDocumentoId, tenantId, client);
  if (!original) {
    throw new OrchestratorError(`Documento de referencia ${referenciaDocumentoId} no existe para este tenant`);
  }
  return {
    xml:
      `<Referencia>` +
      `<NroLinRef>1</NroLinRef>` +
      `<TpoDocRef>${original.tipo_dte}</TpoDocRef>` +
      `<FolioRef>${original.folio}</FolioRef>` +
      `<FchRef>${new Date(original.fecha_emision).toISOString().slice(0, 10)}</FchRef>` +
      (codRef ? `<CodRef>${codRef}</CodRef>` : '') +
      `<RazonRef>${escapeXml(razonRef || 'Anula Documento')}</RazonRef>` +
      `</Referencia>`,
    original,
  };
}

function buildEncabezado({ tenant, tipoDte, folio, fechaEmision, receptor, montos }) {
  return (
    `<Encabezado>` +
    `<IdDoc><TipoDTE>${tipoDte}</TipoDTE><Folio>${folio}</Folio><FchEmis>${fechaEmision}</FchEmis></IdDoc>` +
    `<Emisor>` +
    `<RUTEmisor>${escapeXml(tenant.rut)}</RUTEmisor>` +
    `<RznSoc>${escapeXml(tenant.razon_social)}</RznSoc>` +
    `<GiroEmis>${escapeXml(tenant.giro)}</GiroEmis>` +
    (tenant.acteco ? `<Acteco>${escapeXml(tenant.acteco)}</Acteco>` : '') +
    `<DirOrigen>${escapeXml(tenant.direccion)}</DirOrigen>` +
    `<CmnaOrigen>${escapeXml(tenant.comuna)}</CmnaOrigen>` +
    `</Emisor>` +
    `<Receptor>` +
    `<RUTRecep>${escapeXml(receptor.rut)}</RUTRecep>` +
    `<RznSocRecep>${escapeXml(receptor.razonSocial)}</RznSocRecep>` +
    `</Receptor>` +
    `<Totales>` +
    `<MntNeto>${montos.montoNeto}</MntNeto>` +
    `<TasaIVA>${Math.round(IVA_TASA * 100)}</TasaIVA>` +
    `<IVA>${montos.montoIva}</IVA>` +
    `<MntTotal>${montos.montoTotal}</MntTotal>` +
    `</Totales>` +
    `</Encabezado>`
  );
}

function buildDetalleXml(lineas) {
  return lineas
    .map(
      (l, idx) =>
        `<Detalle>` +
        `<NroLinDet>${idx + 1}</NroLinDet>` +
        `<NmbItem>${escapeXml(l.nombre.slice(0, 80))}</NmbItem>` +
        `<QtyItem>${l.cantidad}</QtyItem>` +
        `<PrcItem>${l.precioUnitario}</PrcItem>` +
        (l.descuento ? `<DescuentoMonto>${l.descuento}</DescuentoMonto>` : '') +
        `<MontoItem>${l.montoItem}</MontoItem>` +
        `</Detalle>`
    )
    .join('');
}

/**
 * Emite un DTE completo de principio a fin. `input`:
 *   tenantId, tipoDte (33|56|61), receptor: {rut, razonSocial},
 *   items: [{ productoId, cantidad, precioUnitario?, descuento? }],
 *   fechaEmision (YYYY-MM-DD), referenciaDocumentoId? (obligatorio para 56/61),
 *   razonReferencia?, codRefReferencia? (1=Anula, 2=Corrige texto, 3=Corrige montos),
 *   soloReferencia? (true = NC/ND "de texto", sin detalle ni montos — items no requeridos),
 *   resolucion: { nroResolucion, fechaResolucion },
 *   clientMode? ('mock'|'soap', override para tests)
 */
async function emitir(input) {
  const {
    tenantId,
    tipoDte,
    receptor,
    items,
    fechaEmision = new Date().toISOString().slice(0, 10),
    referenciaDocumentoId,
    razonReferencia,
    codRefReferencia,
    soloReferencia = false,
    resolucion,
    clientMode,
  } = input;

  if (![33, 56, 61].includes(tipoDte)) {
    throw new OrchestratorError('tipoDte debe ser 33 (Factura), 56 (Nota de Débito) o 61 (Nota de Crédito) en esta fase');
  }
  if ((tipoDte === 61 || tipoDte === 56) && !referenciaDocumentoId) {
    throw new OrchestratorError('Una Nota de Crédito (61) o Débito (56) requiere referenciaDocumentoId');
  }
  if (!receptor || !receptor.rut) {
    throw new OrchestratorError('emitir requiere receptor.rut');
  }

  // --- Paso 1 (transacción propia, se comitea): folio + borrador ---
  const { tenant, documentoId, folio, cafKeyRef, lineas, montoNeto, montoIva, montoTotal } =
    await _crearBorradorConFolio({
      tenantId,
      tipoDte,
      receptor,
      items,
      fechaEmision,
      referenciaDocumentoId,
      soloReferencia,
    });

  // --- Paso 2 en adelante: fuera de la transacción. Cualquier error de
  // acá para abajo marca el documento como 'error' pero NO libera el folio. ---
  try {
    const documentoIdXml = `F${folio}T${tipoDte}`;

    let referenciaXml = '';
    if (tipoDte === 61 || tipoDte === 56) {
      const { xml } = await _buildReferenciaXml(tenantId, referenciaDocumentoId, razonReferencia, codRefReferencia);
      referenciaXml = xml;
    }

    const encabezadoXml = buildEncabezado({
      tenant,
      tipoDte,
      folio,
      fechaEmision,
      receptor,
      montos: { montoNeto, montoIva, montoTotal },
    });
    const detalleXml = buildDetalleXml(lineas);

    // TED: requiere la clave privada RSA del CAF, solo en memoria.
    const cafArchivo = await _getArchivoCaf(tenantId, folio, tipoDte);
    const bloqueCaf = tedService.extraerBloqueCaf(cafArchivo);
    const cafPrivateKeyPem = (await vault.getSecret({ ref: cafKeyRef, tenantId })).toString('utf8');
    const tedXml = tedService.buildTed(
      {
        rutEmisor: tenant.rut,
        tipoDte,
        folio,
        fechaEmision,
        rutReceptor: receptor.rut,
        razonSocialReceptor: receptor.razonSocial,
        montoTotal,
        primerItemGlosa: lineas[0]?.nombre || razonReferencia || '',
        bloqueCaf,
      },
      cafPrivateKeyPem
    );

    const timestampFirma = new Date().toISOString().slice(0, 19);
    const documentoXmlSinFirma =
      `<Documento ID="${documentoIdXml}">` +
      encabezadoXml +
      referenciaXml +
      detalleXml +
      tedXml +
      `<TmstFirma>${timestampFirma}</TmstFirma>` +
      `</Documento>`;

    const { privateKeyPem, certificatePem, rutCertificado } = await signatureService.getCertificadoActivo(tenantId);

    // Documento + Signature como hermanos dentro de <DTE> (estructura real
    // del SII — ver signature.service.signDocumentoEnDte).
    const dteXmlSinFirma = `<DTE version="1.0">${documentoXmlSinFirma}</DTE>`;
    const dteFirmado = signatureService.signDocumentoEnDte(dteXmlSinFirma, {
      privateKeyPem,
      certificatePem,
      documentoId: documentoIdXml,
    });

    await documentosRepo.setXmlYEstado(documentoId, tenantId, dteFirmado, 'emitido');

    const envioXml = envioService.buildEnvioDte({
      rutEmisor: tenant.rut,
      // RutEnvia = RUT del titular del certificado (mandatario), que
      // puede ser una persona natural distinta de la empresa emisora —
      // caso típico cuando el certificado está a nombre del representante.
      rutEnvia: rutCertificado || tenant.rut,
      fechaResolucion: resolucion?.fechaResolucion || tenant.fecha_resolucion_sii || fechaEmision,
      nroResolucion: resolucion?.nroResolucion ?? tenant.nro_resolucion_sii ?? '0',
      documentosFirmadosXml: [dteFirmado],
      tipoDte,
      envioId: 'SetDoc',
      setDteId: 'SetDocInner',
    });
    const envioFirmado = envioService.signEnvioDte(envioXml, {
      privateKeyPem,
      certificatePem,
      envioId: 'SetDoc',
    });

    await siiAuth.getToken(tenantId, { clientMode });

    const { trackId } = await envioService.enviar({
      tenantId,
      tenant,
      dteDocumentoId: documentoId,
      tipoDte,
      folio,
      envioDteXmlFirmado: envioFirmado,
      clientMode,
      // Mismo RUT que se usó como RutEnvia en la Carátula (línea arriba):
      // debe coincidir con el titular del certificado usado para
      // autenticar (GetToken), no necesariamente con la empresa emisora.
      rutEnvia: rutCertificado || tenant.rut,
    });

    await documentosRepo.updateEstado(documentoId, tenantId, 'enviado');

    return { documentoId, tipoDte, folio, trackId, estadoInterno: 'enviado' };
  } catch (err) {
    await documentosRepo.updateEstado(documentoId, tenantId, 'error').catch(() => {
      /* si ni siquiera esto se puede persistir, el error original es el que importa */
    });
    throw new OrchestratorError(
      `Emisión falló tras asignar folio ${folio} (documento ${documentoId} queda en estado 'error', folio NO se reutiliza): ${err.message}`
    );
  }
}

/** Ubica el archivo_caf (XML redactado) del rango que contiene `folio` para tipoDte. */
async function _getArchivoCaf(tenantId, folio, tipoDte) {
  const { rows } = await pool.query(
    `SELECT archivo_caf FROM tenant_caf
     WHERE tenant_id = $1 AND tipo_dte = $2 AND folio_desde <= $3 AND folio_hasta >= $3
     LIMIT 1`,
    [tenantId, tipoDte, folio]
  );
  if (!rows[0]) {
    throw new OrchestratorError(`No se encontró el CAF que contiene el folio ${folio} (tipo ${tipoDte})`);
  }
  return rows[0].archivo_caf;
}

module.exports = { emitir, calcularMontos, OrchestratorError };
