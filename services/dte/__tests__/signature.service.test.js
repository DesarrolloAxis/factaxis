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

    // EnvioDTE_v10.xsd (schema real del SII) solo declara "version" en
    // <EnvioDTE> — el ID vive en <SetDTE>, y es a ESE ID que la Signature
    // del sobre debe referenciar (ver hallazgo real en envio.service.js).
    const envioXml = `<EnvioDTE><SetDTE ID="SetDoc"><Caratula></Caratula>${signedDoc}</SetDTE></EnvioDTE>`;
    const signedEnvio = sigService.signEnvioDte(envioXml, { privateKeyPem, certificatePem, setDteId: 'SetDoc' });

    expect(signedEnvio).not.toMatch(/<EnvioDTE[^>]*\bID=/);
    // ambas firmas (la del Documento interno y la del sobre) deben validar
    expect(sigService.verifySignature(signedEnvio, certificatePem, { signatureIndex: 0 })).toBe(true);
    expect(sigService.verifySignature(signedEnvio, certificatePem, { signatureIndex: 1 })).toBe(true);
  });

  test('C14N "plain" arrastra el namespace del ancestro: firmar el DTE sin xmlns propio invalida la firma al embeberlo en EnvioDTE', () => {
    // Bug real encontrado contra el SII (CASO 4816286-1, folio 30): el SII
    // exige C14N "plain" (no exclusive-c14n), y esa variante SÍ incluye en
    // la forma canónica del nodo raíz de un subset firmado los namespaces
    // heredados de ancestros — aunque esos ancestros no existan todavía al
    // momento de firmar. Si <DTE> no declara sus propios xmlns (calcados
    // de los que declarará el <EnvioDTE> que lo va a envolver), el digest
    // cambia apenas se arma el sobre real y la firma del Documento queda
    // inválida — sin que el schema ni el envío mismo fallen por otra
    // razón. dte.orchestrator.js ya replica esto (ver ese archivo).
    const { privateKeyPem, certificatePem } = sigService.parsePfx(cert.pfxBuffer, cert.password);
    const docXml = '<Documento ID="F4T33"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>4</Folio></IdDoc></Encabezado></Documento>';

    const dteSinNamespace = `<DTE version="1.0">${docXml}</DTE>`;
    const dteFirmadoSinNamespace = sigService.signDocumentoEnDte(dteSinNamespace, {
      privateKeyPem,
      certificatePem,
      documentoId: 'F4T33',
    });
    const envioConNamespace = (dte) =>
      `<EnvioDTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<SetDTE ID="SetDoc"><Caratula></Caratula>${dte}</SetDTE></EnvioDTE>`;

    // Standalone valida, pero embebido en un EnvioDTE con xmlns real ya no:
    expect(sigService.verifySignature(dteFirmadoSinNamespace, certificatePem)).toBe(true);
    expect(
      sigService.verifySignature(envioConNamespace(dteFirmadoSinNamespace), certificatePem, { signatureIndex: 0 })
    ).toBe(false);

    // Fix: declarar en el DTE standalone los mismos xmlns que tendrá el
    // EnvioDTE ancestro final — la forma canónica queda estable.
    const dteConNamespace = `<DTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="1.0">${docXml}</DTE>`;
    const dteFirmadoConNamespace = sigService.signDocumentoEnDte(dteConNamespace, {
      privateKeyPem,
      certificatePem,
      documentoId: 'F4T33',
    });
    expect(
      sigService.verifySignature(envioConNamespace(dteFirmadoConNamespace), certificatePem, { signatureIndex: 0 })
    ).toBe(true);
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
