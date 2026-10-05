import express from 'express';
import path from 'node:path';

const app = express();
const browser = path.resolve('dist/frontend/browser');
// Match the production static origin. API calls must be provided by each browser test.
app.use('/api', (_request, response) => response.status(501).json({ message: 'Unmocked E2E API request' }));
app.use(express.static(browser));
app.get('*', (_request, response) => response.sendFile(path.join(browser, 'index.html')));
app.listen(48674, '127.0.0.1');
