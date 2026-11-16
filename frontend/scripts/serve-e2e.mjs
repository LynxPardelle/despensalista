import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const app = express();
const browser = path.resolve('dist/frontend/browser');
const publicPages = new Map([
  ['/', readFileSync(path.join(browser, 'index.html'), 'utf8')],
  ['/planes', readFileSync(path.join(browser, 'planes/index.html'), 'utf8')],
  ['/privacidad', readFileSync(path.join(browser, 'privacidad/index.html'), 'utf8')],
  ['/terminos-plus-hogar', readFileSync(path.join(browser, 'terminos-plus-hogar/index.html'), 'utf8')],
]);
const appShell = readFileSync(path.join(browser, 'index.csr.html'), 'utf8');

// Match the production static origin. API calls must be provided by each browser test.
app.use('/api', (_request, response) => response.status(501).json({ message: 'Unmocked E2E API request' }));
app.get('/pantry', (request, _response, next) => {
  if (request.query.e2eDisconnect === '1') {
    request.socket.destroy();
  } else {
    next();
  }
});
app.get('*', (request, response, next) => {
  if (path.extname(request.path)) return next();

  const pathname = request.path.replace(/\/$/, '') || '/';
  return response.type('html').send(publicPages.get(pathname) ?? appShell);
});
app.use(express.static(browser));
app.listen(48674, '127.0.0.1');
