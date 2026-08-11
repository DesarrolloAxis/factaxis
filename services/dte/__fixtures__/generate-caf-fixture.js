'use strict';

/**
 * Genera un XML de CAF con la misma forma que entrega el SII, firmado con
 * una llave RSA generada localmente (no es un CAF real del SII — sirve
 * solo para tests/desarrollo con el mock). Se usa desde los tests y desde
 * scripts/seed-almasend.js.
 */

const forge = require('node-forge');

function buildCafXml({ rutEmisor, razonSocial, tipoDte, folioDesde, folioHasta, fechaAutorizacion, idk = 100 }) {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const privatePem = forge.pki.privateKeyToPem(keypair.privateKey);
  const publicPem = forge.pki.publicKeyToPem(keypair.publicKey);

  const modulusB64 = forge.util.encode64(
    forge.util.hexToBytes(keypair.publicKey.n.toString(16).padStart(256, '0'))
  );
  const exponentB64 = forge.util.encode64(forge.util.hexToBytes(keypair.publicKey.e.toString(16)));

  const da =
    `<DA>` +
    `<RE>${rutEmisor}</RE>` +
    `<RS>${razonSocial}</RS>` +
    `<TD>${tipoDte}</TD>` +
    `<RNG><D>${folioDesde}</D><H>${folioHasta}</H></RNG>` +
    `<FA>${fechaAutorizacion}</FA>` +
    `<RSAPK><M>${modulusB64}</M><E>${exponentB64}</E></RSAPK>` +
    `<IDK>${idk}</IDK>` +
    `</DA>`;

  // Firma simulada del SII sobre el bloque DA (en un CAF real la firma la
  // hace el SII con SU llave; aquí solo necesitamos que el campo exista
  // con forma válida para que el parser lo lea).
  const md = forge.md.sha1.create();
  md.update(da, 'utf8');
  const frma = forge.util.encode64(md.digest().getBytes());

  const xml =
    `<AUTORIZACION>` +
    `<CAF version="1.0">${da}<FRMA algoritmo="SHA1withRSA">${frma}</FRMA></CAF>` +
    `<RSASK>${privatePem}</RSASK>` +
    `<RSAPUBK>${publicPem}</RSAPUBK>` +
    `</AUTORIZACION>`;

  return { xml, privateKeyPem: privatePem, publicKeyPem: publicPem };
}

module.exports = { buildCafXml };
