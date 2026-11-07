import { createServer } from 'vite';
import { createApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { loadLocalProvider } from './llm/config.js';

const app = createApp(loadLocalProvider());
const vite = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);
const port = Number(process.env.PORT || 5173);
const server = app.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exit(1); });
async function stop() { await vite.close(); server.close(() => process.exit(0)); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
