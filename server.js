'use strict';

require('dotenv').config();
const express = require('express');
const dteRoutes = require('./routes/dte.routes');

const app = express();
app.use(express.json({ limit: '5mb' })); // certificados/CAF en base64 pueden ser pesados

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/dte', dteRoutes);

// Manejador de errores centralizado. Nunca filtra stack traces ni datos
// sensibles (certificado_ref, claves) al cliente.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[server] error no manejado:', err.message);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Error interno' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] factaxis DTE escuchando en :${PORT}`);
  });
}

module.exports = app;
