// Explicit live smoke test: up to TWO Elice generations, never part of npm test.
// Uses Elice settings without changing LLM_PROVIDER in .env or a running server.
import { loadEnvFile } from 'node:process';
import { once } from 'node:events';
import { providerFromEnv } from '../server/llm/config.ts';
import { createApp } from '../server/app.ts';

try { loadEnvFile('.env'); }
catch (error) { if (error.code !== 'ENOENT') { console.error('로컬 설정 파일을 읽지 못했습니다.'); process.exit(1); } }

let server;
try {
  const provider = providerFromEnv({ ...process.env, LLM_PROVIDER: 'elice' });
  if (!provider.configured) throw new Error('ELICE_SETTINGS_REQUIRED');
  server = createApp(provider).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const sourceText = '금요일까지 자료를 보내 주세여.';
  async function request(route, input) {
    const started = Date.now();
    const response = await fetch(`${base}/api/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(50_000),
    });
    const result = await response.json();
    if (!response.ok) {
      console.error(JSON.stringify({ step: route, status: response.status, code: result.error?.code, elapsedMs: Date.now() - started }));
      throw new Error('LIVE_CHECK_FAILED');
    }
    console.log(JSON.stringify({ step: route, status: response.status, elapsedMs: Date.now() - started, result }));
    return result;
  }
  const correction = await request('corrections', { requestId: 'elice-smoke-correction', sourceText });
  await request('explanations', { requestId: 'elice-smoke-explanation', sourceText, candidates: correction.candidates });
  console.log('엘리스 교정·설명 API 확인 완료. 품질 전반·교육 지원 한도 검증과는 별개입니다.');
} catch (error) {
  // Never print raw upstream exceptions, URLs containing credentials or headers.
  const known = ['ELICE_SETTINGS_REQUIRED', 'LIVE_CHECK_FAILED'];
  console.error(known.includes(error.message) ? error.message : 'ELICE_CHECK_FAILED');
  process.exitCode = 1;
} finally {
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}
