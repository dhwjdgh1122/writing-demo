import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createGeminiProvider } from './gemini.js';
import { createEliceProvider } from './elice.js';
import { ProviderError, unavailableProvider, type CorrectionProvider } from './provider.js';

export function providerFromEnv(env: NodeJS.ProcessEnv): CorrectionProvider {
  const provider = env.LLM_PROVIDER?.trim();
  if (!provider) return unavailableProvider;
  if (provider === 'elice') {
    const apiKey = env.ELICE_API_KEY?.trim();
    const model = env.ELICE_MODEL?.trim();
    const baseUrl = env.ELICE_BASE_URL?.trim();
    if (!apiKey || !model || !baseUrl) return unavailableProvider;
    return createEliceProvider({ apiKey, model, baseUrl });
  }
  if (provider !== 'gemini') throw new ProviderError('configuration');
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) return unavailableProvider;
  return createGeminiProvider({ apiKey, model });
}

// npm runs scripts from the package root in both dev and built modes.
export function loadLocalProvider(): CorrectionProvider {
  try { loadEnvFile(resolve(process.cwd(), '.env')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('서버의 .env 파일을 읽을 수 없습니다. 파일 접근 권한을 확인해주세요.');
  }
  return providerFromEnv(process.env);
}
