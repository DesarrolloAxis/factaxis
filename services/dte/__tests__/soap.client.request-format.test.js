'use strict';

/**
 * Tests de los formatos de request/response del cliente SOAP real contra
 * los hallazgos verificados en los manuales oficiales del SII (ver
 * comentarios en services/dte/sii-client/soap.client.js). No pegan a la
 * red — mockean el módulo `https` de Node para capturar exactamente lo
 * que se manda y simular lo que el SII devuelve.
 */

jest.mock('https');
const https = require('https');

/** Configura https.request para responder con statusCode/body fijos, y devuelve un getter para inspeccionar la última request armada. */
function mockHttpsOnce({ statusCode = 200, body = '' }) {
  let lastOptions;
  let lastWrittenBody = '';
  https.request.mockImplementationOnce((options, callback) => {
    lastOptions = options;
    const res = {
      statusCode,
      setEncoding: jest.fn(),
      on: (event, handler) => {
        if (event === 'data') handler(body);
        if (event === 'end') handler();
      },
    };
    callback(res);
    return {
      on: jest.fn(),
      write: (chunk) => {
        lastWrittenBody += chunk.toString('utf8');
      },
      end: jest.fn(),
    };
  });
  return {
    getOptions: () => lastOptions,
    getWrittenBody: () => lastWrittenBody,
  };
}

describe('soap.client — queryEstUp (WSDL real de QueryEstUp.jws)', () => {
  test('manda solo RutCompania/DvCompania/TrackId/Token — NO RutReceptor/DvReceptor', async () => {
    const soapClient = require('../sii-client/soap.client');
    const capture = mockHttpsOnce({
      statusCode: 200,
      body: '<Body><getEstUpReturn><ESTADO>DOK</ESTADO><GLOSA>DTE Recibido</GLOSA></getEstUpReturn></Body>',
    });

    await soapClient.queryEstUp('certificacion', { trackId: '39', rutEmisor: '78138404-6' }, 'TOKEN123');

    const sent = capture.getWrittenBody();
    expect(sent).toContain('<RutCompania>78138404</RutCompania>');
    expect(sent).toContain('<DvCompania>6</DvCompania>');
    expect(sent).toContain('<TrackId>39</TrackId>');
    expect(sent).toContain('<Token>TOKEN123</Token>');
    expect(sent).not.toContain('RutReceptor');
    expect(sent).not.toContain('DvReceptor');
  });
});

describe('soap.client — enviarDte (DTEUpload)', () => {
  test('manda el header User-Agent con "PROG 1.0" (requerido por el SII para respuesta en XML)', async () => {
    const soapClient = require('../sii-client/soap.client');
    const capture = mockHttpsOnce({
      statusCode: 200,
      body: '<RECEPCIONDTE><STATUS>0</STATUS><TRACKID>39</TRACKID></RECEPCIONDTE>',
    });

    await soapClient.enviarDte(
      'certificacion',
      { envioDteXml: '<EnvioDTE/>', rutEmisor: '78138404-6' },
      'TOKEN123'
    );

    expect(capture.getOptions().headers['User-Agent']).toEqual(expect.stringContaining('PROG 1.0'));
  });

  test('STATUS 0 con TRACKID resuelve con el trackId', async () => {
    const soapClient = require('../sii-client/soap.client');
    mockHttpsOnce({
      statusCode: 200,
      body: '<RECEPCIONDTE><STATUS>0</STATUS><TRACKID>39</TRACKID></RECEPCIONDTE>',
    });

    const result = await soapClient.enviarDte(
      'certificacion',
      { envioDteXml: '<EnvioDTE/>', rutEmisor: '78138404-6' },
      'TOKEN123'
    );
    expect(result.trackId).toBe('39');
  });

  test('STATUS 7 (esquema inválido) rechaza con el detalle de <ERROR> incluido', async () => {
    const soapClient = require('../sii-client/soap.client');
    mockHttpsOnce({
      statusCode: 200,
      body:
        '<RECEPCIONDTE><STATUS>7</STATUS>' +
        '<DETAIL><ERROR>LSX-00265: attribute "version" value "3.2" is wrong</ERROR></DETAIL></RECEPCIONDTE>',
    });

    let error;
    try {
      await soapClient.enviarDte('certificacion', { envioDteXml: '<EnvioDTE/>', rutEmisor: '78138404-6' }, 'TOKEN123');
    } catch (err) {
      error = err;
    }
    expect(error.message).toMatch(/Esquema inválido/);
    expect(error.message).toMatch(/LSX-00265/);
  });

  test('STATUS 8 (firma inválida) rechaza con glosa clara', async () => {
    const soapClient = require('../sii-client/soap.client');
    mockHttpsOnce({ statusCode: 200, body: '<RECEPCIONDTE><STATUS>8</STATUS></RECEPCIONDTE>' });

    await expect(
      soapClient.enviarDte('certificacion', { envioDteXml: '<EnvioDTE/>', rutEmisor: '78138404-6' }, 'TOKEN123')
    ).rejects.toThrow(/firma del documento/);
  });
});

describe('soap.client — getToken (GetTokenFromSeed.jws)', () => {
  test('ESTADO 05 (firma inválida) sin TOKEN rechaza con la glosa oficial', async () => {
    const soapClient = require('../sii-client/soap.client');
    mockHttpsOnce({
      statusCode: 200,
      body:
        '<Body><getTokenReturn>&lt;SII:RESPUESTA&gt;&lt;SII:RESP_HDR&gt;' +
        '&lt;ESTADO&gt;05&lt;/ESTADO&gt;&lt;/SII:RESP_HDR&gt;&lt;/SII:RESPUESTA&gt;</getTokenReturn></Body>',
    });

    await expect(soapClient.getToken('certificacion', '<getToken/>')).rejects.toThrow(/firma inválida/);
  });

  test('REGRESIÓN: el Envelope declara xmlns:xsi/xmlns:xsd (requerido por el atributo xsi:type de pszXml)', async () => {
    // Confirmado contra maullin.sii.cl real: sin esta declaración, el SII
    // rechaza con SAXParseException "prefix xsi ... is not bound" (HTTP 500) —
    // no es una suposición, costó un CAF real de certificación depurarlo.
    const soapClient = require('../sii-client/soap.client');
    const capture = mockHttpsOnce({
      statusCode: 200,
      body: '<Body><getTokenReturn>&lt;SII:RESPUESTA&gt;&lt;SII:RESP_BODY&gt;&lt;TOKEN&gt;abc&lt;/TOKEN&gt;&lt;/SII:RESP_BODY&gt;&lt;/SII:RESPUESTA&gt;</getTokenReturn></Body>',
    });

    await soapClient.getToken('certificacion', '<getToken/>');

    const sent = capture.getWrittenBody();
    expect(sent).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(sent).toContain('xmlns:xsd="http://www.w3.org/2001/XMLSchema"');
    expect(sent).toContain('xsi:type="xsd:string"');
  });
});
