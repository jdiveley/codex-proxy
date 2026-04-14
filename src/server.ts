/**
 * Codex Proxy — main entry point
 *
 * Exposes a Responses API-compatible HTTP server that translates requests
 * to various LLM backends (OpenAI Chat Completions, Anthropic Messages,
 * Google Gemini) and streams back Responses API SSE events.
 *
 * Usage:
 *   cp .env.example .env && $EDITOR .env
 *   npm run dev        # or: npm run build && npm start
 *
 * Point Codex at:
 *   OPENAI_BASE_URL=http://localhost:8080
 *   OPENAI_API_KEY=anything   (proxy validates with the real backend)
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { getConfig, detectBackend } from './config.js';
import { sessions } from './session.js';
import { initSSE, writeSSE, writeSSEDone, newId, debugLog } from './utils.js';
import { toOpenAI, streamOpenAI } from './backends/openai.js';
import { toAnthropic, streamAnthropic } from './backends/anthropic.js';
import { toGemini, streamGemini } from './backends/gemini.js';
import type { ResponsesRequest, ResponsesInputItem, StoredResponse } from './types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// --------------------------------------------------------------------------
// Health
// --------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.json({ service: 'codex-proxy', status: 'ok' });
});

// --------------------------------------------------------------------------
// GET /v1/models — minimal model list so Codex can enumerate models
// --------------------------------------------------------------------------

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-4o',               object: 'model', created: 0, owned_by: 'openai' },
      { id: 'gpt-4o-mini',          object: 'model', created: 0, owned_by: 'openai' },
      { id: 'o3',                   object: 'model', created: 0, owned_by: 'openai' },
      { id: 'o4-mini',              object: 'model', created: 0, owned_by: 'openai' },
      { id: 'claude-opus-4-5',      object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-5',    object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5',     object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'gemini-2.0-flash',     object: 'model', created: 0, owned_by: 'google' },
      { id: 'gemini-1.5-pro',       object: 'model', created: 0, owned_by: 'google' },
    ],
  });
});

// --------------------------------------------------------------------------
// GET /v1/responses/:id — retrieve a stored response (Codex may call this)
// --------------------------------------------------------------------------

app.get('/v1/responses/:id', (req, res) => {
  const stored = sessions.get(req.params.id);
  if (!stored) {
    res.status(404).json({ error: { message: 'Response not found', type: 'not_found' } });
    return;
  }
  res.json({
    id: stored.id,
    object: 'response',
    created_at: Math.floor(stored.createdAt / 1000),
    status: 'completed',
    model: stored.model,
    output: stored.outputItems,
    instructions: stored.instructions ?? null,
    tools: stored.tools ?? [],
  });
});

// --------------------------------------------------------------------------
// POST /v1/responses — main proxy endpoint
// --------------------------------------------------------------------------

app.post('/v1/responses', async (req: Request, res: Response, _next: NextFunction) => {
  const body = req.body as ResponsesRequest;

  if (!body.model) {
    res.status(400).json({ error: { message: '"model" is required', type: 'invalid_request' } });
    return;
  }

  debugLog('request', body);

  // Resolve history + inherited settings from previous_response_id chain
  const { history, instructions, tools } = sessions.buildHistory(
    body.previous_response_id,
    body.instructions,
    body.tools,
  );

  const config = getConfig();
  const backend = detectBackend(body.model);

  // Pre-generate the response ID so we can store the session after streaming
  const responseId = newId('resp');

  // Normalise the current input items for session storage
  const currentInputItems: ResponsesInputItem[] = Array.isArray(body.input)
    ? body.input
    : [{ type: 'message', role: 'user', content: body.input }];

  initSSE(res);

  let outputItems: ResponsesInputItem[] = [];

  try {
    if (backend === 'anthropic') {
      const anthropicReq = toAnthropic(body, history, instructions, tools, config.defaultMaxTokens);
      outputItems = await streamAnthropic(body, anthropicReq, res, responseId);
    } else if (backend === 'gemini') {
      const gemReq = toGemini(body, history, instructions, tools, config.defaultMaxTokens);
      outputItems = await streamGemini(body, gemReq, res, responseId);
    } else {
      const chatReq = toOpenAI(body, history, instructions, tools, config.defaultMaxTokens);
      outputItems = await streamOpenAI(body, chatReq, res, responseId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[proxy] Backend error:', message);
    try {
      writeSSE(res, 'error', { type: 'error', error: { type: 'server_error', message } });
      writeSSEDone(res);
    } catch { /* response already closed */ }
    res.end();
    return;
  }

  // Persist session for future previous_response_id lookups
  const stored: StoredResponse = {
    id: responseId,
    previousId: body.previous_response_id,
    model: body.model,
    instructions: instructions,
    tools: tools,
    inputItems: currentInputItems,
    outputItems,
    accumulatedHistory: [...history, ...currentInputItems, ...outputItems],
    createdAt: Date.now(),
  };
  sessions.set(stored);

  res.end();
});

// --------------------------------------------------------------------------
// 404 fallback
// --------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

const config = getConfig();
app.listen(config.port, () => {
  console.log(`[proxy] Listening on http://localhost:${config.port}`);
  console.log(`[proxy] Backend base:       ${config.backendBaseUrl}`);
  console.log(`[proxy] OpenAI endpoint:    ${config.openaiBaseUrl}/chat/completions`);
  console.log(`[proxy] Anthropic endpoint: ${config.anthropicBaseUrl}/messages`);
  console.log(`[proxy] Gemini endpoint:    ${config.geminiBaseUrl}/models/{model}:streamGenerateContent`);
  console.log(`[proxy] Debug logging:      ${config.debug}`);
  console.log('');
  console.log(`[proxy] Configure Codex with:`);
  console.log(`[proxy]   OPENAI_BASE_URL=http://localhost:${config.port}`);
  console.log(`[proxy]   OPENAI_API_KEY=dummy   # proxy handles real auth`);
});
