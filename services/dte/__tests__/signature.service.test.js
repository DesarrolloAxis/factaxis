'use strict';

const sigService = require('../signature.service');
const { buildSelfSignedCertFixture } = require('../__fixtures__/generate-cert-fixture');

describe('signature.service', () => {
  let cert;

  beforeAll(() => {
    cert = buildSelfSignedCertFixture({ rut: '78138404-6', commonName: 'ALMASEND SpA' });
  });

  test('parsePfx extrae llave privada y certificado desde un .pfx', () => {
    const parsed = sigService.parsePfx(cert.pfxBuffer, cert.password);
    expect(parsed.privateKeyPem).toMatch(/PRIVATE KEY/);
    expect(parsed.certificatePem).toMatch(/BEGIN CERTIFICATE/);
  });

  test('parsePfx lanza error con contraseña incorrecta', () => {
    expect(() => sigService.parsePfx(cert.pfxBuffer, 'contraseña-incorrecta')).toThrow(sigService.SignatureError);
  });

  test('signDocumento produce una firma XMLDSig valida', () => {
    const { privateKeyPem, certificatePem } = sigService.parsePfx(cert.pfxBuffer, cert.password);
    const docXml = '<Documento ID="F1T33"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>1</Folio></IdDoc></Encabezado></Documento>';
    const signed = sigService.signDocumento(docXml, { privateKeyPem, certificatePem, documentoId: 'F1T33' });
    expect(signed).toContain('<Signature');
    expect(sigService.verifySignature(signed, certificatePem)).toBe(true);
  });

  test('verifySignature detecta un documento alterado tras firmarlo', () => {
    const { privateKeyPem, certificatePem } = sigService.parsePfx(cert.pfxBuffer, cert.password);
    const docXml = '<Documento ID="F2T33"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>2</Folio></IdDoc></Encabezado></Documento>';
    const signed = sigService.signDocumento(docXml, { privateKeyPem, certificatePem, documentoId: 'F2T33' });
    const tampered = signed.replace('<Folio>2</Folio>', '<Folio>999</Folio>');
    expect(sigService.verifySignature(tampered, certificatePem)).toBe(false);
  });

  test('signEnvioDte firma correctamente un EnvioDTE que ya contiene un Documento firmado (firmas anidadas)', () => {
    const { privateKeyPem, certificatePem } = sigService.parsePfx(cert.pfxBuffer, cert.password);
    const docXml = '<Documento ID="F3T33"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>3</Folio></IdDoc></Encabezado></Documento>';
    const signedDoc = sigService.signDocumento(docXml, { privateKeyPem, certificatePem, documentoId: 'F3T33' });

    const envioXml = `<EnvioDTE ID="SetDoc"><SetDTE ID="SetDocInner"><Caratula></Caratula>${signedDoc}</SetDTE></EnvioDTE>`;
    const signedEnvio = sigService.signEnvioDte(envioXml, { privateKeyPem, certificatePem, envioId: 'SetDoc' });

    // ambas firmas (la del Documento interno y la del sobre) deben validar
    expect(sigService.verifySignature(signedEnvio, certificatePem, { signatureIndex: 0 })).toBe(true);
    expect(sigService.verifySignature(signedEnvio, certificatePem, { signatureIndex: 1 })).toBe(true);
  });

  test('signWholeDocument firma con referencia de URI vacia (uso: semilla SII)', () => {
    const { privateKeyPem, certificatePem } = sigService.parsePfx(cert.pfxBuffer, cert.password);
    const semillaXml = '<getToken><item><Semilla>123456789</Semilla></item></getToken>';
    const signed = sigService.signWholeDocument(semillaXml, { privateKeyPem, certificatePem });
    expect(sigService.verifySignature(signed, certificatePem)).toBe(true);
  });

  test('signElement exige que el XML ya tenga el atributo ID declarado', () => {
    const { privateKeyPem, certificatePem } = sigService.parsePfx(cert.pfxBuffer, cert.password);
    const docXml = '<Documento><Encabezado/></Documento>';
    expect(() =>
      sigService.signDocumento(docXml, { privateKeyPem, certificatePem, documentoId: 'F1T33' })
    ).toThrow(sigService.SignatureError);
  });
});
