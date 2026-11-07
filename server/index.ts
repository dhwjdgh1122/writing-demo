import express from 'express';
import { createApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { loadLocalProvider } from './llm/config.js';

const app = createApp(loadLocalProvider());
const clientPath = fileURLToPath(new URL('../client', import.meta.url));
app.use(express.static(clientPath));
const port = Number(process.env.PORT || 5173);
const server = app.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exit(1); });
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
