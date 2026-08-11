'use strict';

/**
 * Tests del parsing de respuestas SOAP crudas del cliente real
 * (services/dte/sii-client/soap.client.js). No pegan a la red — verifican
 * que extractSoapReturn() maneje los dos formatos de escape que usan
 * distintas implementaciones SOAP Java clásicas (CDATA vs entidades XML),
 * y con/sin prefijo de namespace.
 */

const { extractSoapReturn } = require('../sii-client/soap.client');

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

  test('devuelve null si el elemento no existe', () => {
    const body = '<Body><otraCosa/></Body>';
    expect(extractSoapReturn(body, 'getSeedReturn')).toBeNull();
  });
});
