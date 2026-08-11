'use strict';

const { pool } = require('../pool');

/** Inserta todas las líneas de detalle de un documento en una sola transacción. */
async function insertMany(tenantId, dteDocumentoId, lineas, client = pool) {
  const inserted = [];
  for (const [idx, linea] of lineas.entries()) {
    const { rows } = await client.query(
      `INSERT INTO dte_detalle
         (tenant_id, dte_documento_id, linea, producto_id, cantidad, precio_unitario, descuento, monto_item)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, linea, producto_id, cantidad, precio_unitario, descuento, monto_item`,
      [
        tenantId,
        dteDocumentoId,
        idx + 1,
        linea.productoId,
        linea.cantidad,
        linea.precioUnitario,
        linea.descuento || 0,
        linea.montoItem,
      ]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

async function listByDocumento(dteDocumentoId, tenantId, client = pool) {
  const { rows } = await client.query(
    `SELECT dd.id, dd.linea, dd.producto_id, p.nombre AS producto_nombre,
            dd.cantidad, dd.precio_unitario, dd.descuento, dd.monto_item
     FROM dte_detalle dd
     JOIN productos p ON p.id = dd.producto_id AND p.tenant_id = dd.tenant_id
     WHERE dd.dte_documento_id = $1 AND dd.tenant_id = $2
     ORDER BY dd.linea ASC`,
    [dteDocumentoId, tenantId]
  );
  return rows;
}

module.exports = { insertMany, listByDocumento };
