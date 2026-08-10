'use strict';

/**
 * Genera un certificado autofirmado + su .pfx en memoria, para tests y
 * para poder ejercitar el pipeline completo antes de que el certificado
 * real de ALMASEND esté tramitado con el SII. NO USAR EN PRODUCCIÓN.
 */

const forge = require('node-forge');

function buildSelfSignedCertFixture({ rut, commonName, password = 'test-password' }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'countryName', value: 'CL' },
    // El SII exige el RUT del titular como serialNumber en el subject (OID 2.5.4.5).
    { type: '2.5.4.5', value: rut },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // autofirmado
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const pfxDer = forge.asn1.toDer(p12Asn1).getBytes();
  const pfxBuffer = Buffer.from(pfxDer, 'binary');

  return {
    pfxBuffer,
    password,
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
  };
}

module.exports = { buildSelfSignedCertFixture };
