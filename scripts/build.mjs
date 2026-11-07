import { build as buildClient } from 'vite';
import { build as buildServer } from 'esbuild';

await buildClient();
await buildServer({ entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node20' });
