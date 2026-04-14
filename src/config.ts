import { BackendType } from './types.js';

export interface Config {
  port: number;
  backendBaseUrl: string;
  apiToken: string;
  /** Per-provider base URL overrides (without trailing slash) */
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  geminiBaseUrl: string;
  defaultMaxTokens: number;
  sessionTtlMs: number;
  debug: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const backendBaseUrl = (process.env.BACKEND_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
  const apiToken = process.env.API_TOKEN ?? process.env.OPENAI_API_KEY ?? '';

  if (!apiToken) {
    console.warn('[proxy] WARNING: API_TOKEN is not set — backend requests will likely fail.');
  }

  // Derive per-provider URLs from the base, unless explicitly overridden.
  // Ask Sage layout:  {base}/server/openai/v1, {base}/server/anthropic/v1, {base}/server/google/v1beta
  // Direct OpenAI:    https://api.openai.com/v1
  // Direct Anthropic: https://api.anthropic.com/v1
  // Direct Gemini:    https://generativelanguage.googleapis.com/v1beta
  const openaiBaseUrl =
    (process.env.OPENAI_BASE_URL ?? '').replace(/\/$/, '') ||
    (backendBaseUrl.includes('api.openai.com') ? backendBaseUrl + '/v1' : backendBaseUrl + '/server/openai/v1');

  const anthropicBaseUrl =
    (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/$/, '') ||
    (backendBaseUrl.includes('api.anthropic.com') ? backendBaseUrl + '/v1' : backendBaseUrl + '/server/anthropic/v1');

  const geminiBaseUrl =
    (process.env.GEMINI_BASE_URL ?? '').replace(/\/$/, '') ||
    (backendBaseUrl.includes('generativelanguage.googleapis.com') ? backendBaseUrl + '/v1beta' : backendBaseUrl + '/server/google/v1beta');

  _config = {
    port: parseInt(process.env.PORT ?? '8080', 10),
    backendBaseUrl,
    apiToken,
    openaiBaseUrl,
    anthropicBaseUrl,
    geminiBaseUrl,
    defaultMaxTokens: parseInt(process.env.DEFAULT_MAX_TOKENS ?? '8192', 10),
    sessionTtlMs: parseInt(process.env.SESSION_TTL_MS ?? String(60 * 60 * 1000), 10),
    debug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
    certPath: process.env.CERT_PATH,
    keyPath: process.env.KEY_PATH,
    caPath: process.env.CA_PATH,
  };

  return _config;
}

/** Detect which backend to use based on model name */
export function detectBackend(model: string): BackendType {
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('claude')) return 'anthropic';
  if (m.startsWith('gemini') || m.includes('gemini')) return 'gemini';
  return 'openai';
}
