'use strict';

/**
 * Tests del parsing de respuestas SOAP crudas del cliente real
 * (services/dte/sii-client/soap.client.js). No pegan a la red — verifican
 * que extractSoapReturn() maneje los dos formatos de escape que usan
 * distintas implementaciones SOAP Java clásicas (CDATA vs entidades XML),
 * y con/sin prefijo de namespace.
 */

const { extractSoapReturn, buildEnviarDteBody } = require('../sii-client/soap.client');

describe('soap.client — extractSoapReturn', () => {
  test('extrae contenido envuelto en CDATA', () => {
    const body =
      '<soapenv:Envelope><soapenv:Body><getSeedResponse>' +
      '<getSeedReturn><![CDATA[<SII:RESPUESTA><SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR>' +
      '<SII:RESP_BODY><SEMILLA>123456789</SEMILLA></SII:RESP_BODY></SII:RESPUESTA>]]></getSeedReturn>' +
      '</getSeedResponse></soapenv:Body></soapenv:Envelope>';
    const inner = extractSoapReturn(body, 'getSeedReturn');
    expect(inner).toContain('<SEMILLA>123456789</SEMILLA>');
  });

  test('extrae contenido escapado como entidades XML', () => {
    const body =
      '<soapenv:Envelope><soapenv:Body><getSeedResponse>' +
      '<getSeedReturn>&lt;SII:RESPUESTA&gt;&lt;SEMILLA&gt;987654321&lt;/SEMILLA&gt;&lt;/SII:RESPUESTA&gt;</getSeedReturn>' +
      '</getSeedResponse></soapenv:Body></soapenv:Envelope>';
    const inner = extractSoapReturn(body, 'getSeedReturn');
    expect(inner).toBe('<SII:RESPUESTA><SEMILLA>987654321</SEMILLA></SII:RESPUESTA>');
  });

  test('tolera prefijo de namespace en el elemento', () => {
    const body = '<Body><ns1:getTokenReturn><![CDATA[<TOKEN>abc</TOKEN>]]></ns1:getTokenReturn></Body>';
    const inner = extractSoapReturn(body, 'getTokenReturn');
    expect(inner).toBe('<TOKEN>abc</TOKEN>');
  });

  test('tolera atributos en el tag de apertura (formato real del SII: xsi:type="xsd:string")', () => {
    // Respuesta real observada contra maullin.sii.cl (CASO 4816286-1, folio 31).
    const body =
      '<soapenv:Envelope><soapenv:Body>' +
      '<getSeedResponse soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<getSeedReturn xsi:type="xsd:string">&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?&gt;' +
      '&lt;SII:RESPUESTA xmlns:SII=&quot;http://www.sii.cl/XMLSchema&quot;&gt;' +
      '&lt;SII:RESP_BODY&gt;&lt;SEMILLA&gt;1662115112888&lt;/SEMILLA&gt;&lt;/SII:RESP_BODY&gt;' +
      '&lt;SII:RESP_HDR&gt;&lt;ESTADO&gt;00&lt;/ESTADO&gt;&lt;/SII:RESP_HDR&gt;' +
      '&lt;/SII:RESPUESTA&gt;</getSeedReturn>' +
      '</getSeedResponse></soapenv:Body></soapenv:Envelope>';
    const inner = extractSoapReturn(body, 'getSeedReturn');
    expect(inner).toContain('<SEMILLA>1662115112888</SEMILLA>');
    expect(inner).toContain('<ESTADO>00</ESTADO>');
  });

  test('devuelve null si el elemento no existe', () => {
    const body = '<Body><otraCosa/></Body>';
    expect(extractSoapReturn(body, 'getSeedReturn')).toBeNull();
  });
});

describe('soap.client — buildEnviarDteBody', () => {
  // Regresión de un rechazo real del SII ("SCH-00001: Invalid Schema
  // Name", CASO 4816286-1 folio 30) que persistía incluso con el schema
  // (EnvioDTE sin ID) y la firma (C14N) ya corregidos — el XML no
  // declaraba encoding y el SII histórico espera ISO-8859-1.
  test('declara el prólogo XML con encoding ISO-8859-1 antes del elemento raíz', () => {
    const { body } = buildEnviarDteBody({
      envioDteXml: '<EnvioDTE version="1.0"><SetDTE ID="SetDoc"/></EnvioDTE>',
      rutEmisor: '78138404-6',
      rutEnvia: '78138404-6',
    });
    const raw = body.toString('latin1');
    expect(raw).toContain('<?xml version="1.0" encoding="ISO-8859-1"?><EnvioDTE');
    expect(raw).toContain('Content-Type: text/xml; charset=ISO-8859-1');
  });

  test('codifica tildes/eñe como bytes ISO-8859-1, no como UTF-8 multibyte', () => {
    const { body } = buildEnviarDteBody({
      envioDteXml: '<EnvioDTE version="1.0"><RznSoc>Cajón Peña SpA</RznSoc></EnvioDTE>',
      rutEmisor: '78138404-6',
      rutEnvia: '78138404-6',
    });
    // "ó" en latin1 es un solo byte (0xF3); en UTF-8 serían dos (0xC3 0xB3).
    expect(body.includes(Buffer.from([0xf3]))).toBe(true);
    expect(body.toString('latin1')).toContain('Cajón Peña SpA');
  });

  test('el orden y nombres de los campos del multipart no cambian (rutSender→dvSender→rutCompany→dvCompany→archivo)', () => {
    const { body } = buildEnviarDteBody({
      envioDteXml: '<EnvioDTE version="1.0"/>',
      rutEmisor: '78138404-6',
      rutEnvia: '16891500-4',
    });
    const raw = body.toString('latin1');
    const order = ['name="rutSender"', 'name="dvSender"', 'name="rutCompany"', 'name="dvCompany"', 'name="archivo"'];
    const positions = order.map((needle) => raw.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(raw).toContain('name="rutSender"\r\n\r\n16891500'); // rutEnvia, no rutEmisor
  });
});
