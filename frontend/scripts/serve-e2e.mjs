import express from 'express';
import path from 'node:path';

const app = express();
const browser = path.resolve('dist/frontend/browser');
// Match the production static origin. API calls must be provided by each browser test.
app.use('/api', (_request, response) => response.status(501).json({ message: 'Unmocked E2E API request' }));
app.get('/pantry', (request, _response, next) => {
  if (request.query.e2eDisconnect === '1') {
    request.socket.destroy();
  } else {
    next();
  }
});
app.get(['/planes', '/privacidad', '/terminos-plus-hogar'], (request, response) => {
  response.sendFile(path.join(browser, request.path, 'index.html'));
});
app.get('*', (request, response, next) => {
  if (request.path === '/' || path.extname(request.path)) return next();
  return response.sendFile(path.join(browser, 'index.csr.html'));
});
app.use(express.static(browser));
app.listen(48674, '127.0.0.1');
