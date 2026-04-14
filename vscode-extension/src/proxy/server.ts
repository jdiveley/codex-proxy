import * as http from 'http';
import { SessionStore } from './session';
import { newId, log, initSSE, writeSSE, writeSSEDone, jsonResponse, readBody } from './utils';
import { toOpenAI, streamOpenAI } from './backends/openai';
import { toAnthropic, streamAnthropic } from './backends/anthropic';
import { toGemini, streamGemini } from './backends/gemini';
import { ProxyConfig, ResponsesRequest, ResponsesInputItem, StoredResponse } from './types';

/** Detect which backend to use based on model name */
function detectBackend(model: string): 'openai' | 'anthropic' | 'gemini' {
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('claude')) return 'anthropic';
  if (m.startsWith('gemini') || m.includes('gemini')) return 'gemini';
  return 'openai';
}

const MODELS = [
  { id: 'gpt-4o',            object: 'model', created: 0, owned_by: 'openai' },
  { id: 'gpt-4o-mini',       object: 'model', created: 0, owned_by: 'openai' },
  { id: 'o3',                object: 'model', created: 0, owned_by: 'openai' },
  { id: 'o4-mini',           object: 'model', created: 0, owned_by: 'openai' },
  { id: 'claude-opus-4-5',   object: 'model', created: 0, owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-5', object: 'model', created: 0, owned_by: 'anthropic' },
  { id: 'claude-haiku-4-5',  object: 'model', created: 0, owned_by: 'anthropic' },
  { id: 'gemini-2.0-flash',  object: 'model', created: 0, owned_by: 'google' },
  { id: 'gemini-1.5-pro',    object: 'model', created: 0, owned_by: 'google' },
];

export class ProxyServer {
  private server: http.Server | null = null;
  private sessions = new SessionStore();
  private config: ProxyConfig;

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Start the HTTP server. Resolves when listening, rejects on error. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) { resolve(); return; }

      this.sessions.start(60 * 60 * 1000);
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.once('error', (err) => {
        this.server = null;
        reject(err);
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        log(`[proxy] Listening on http://127.0.0.1:${this.config.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP server gracefully. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.sessions.stop();
      this.server.close(() => {
        this.server = null;
        log('[proxy] Server stopped');
        resolve();
      });
      // Force-close any keep-alive connections
      this.server.closeAllConnections?.();
    });
  }

  /** Update config and restart the server if it was running. */
  async reconfigure(config: ProxyConfig): Promise<void> {
    const wasRunning = this.isRunning;
    if (wasRunning) await this.stop();
    this.config = config;
    if (wasRunning) await this.start();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);

    if (req.method === 'GET' && url.pathname === '/') {
      jsonResponse(res, 200, { service: 'codex-proxy', status: 'ok' });
    } else if (req.method === 'GET' && url.pathname === '/v1/models') {
      jsonResponse(res, 200, { object: 'list', data: MODELS });
    } else if (req.method === 'GET' && url.pathname.startsWith('/v1/responses/')) {
      this.handleGetResponse(req, res, url.pathname.split('/')[3]);
    } else if (req.method === 'POST' && url.pathname === '/v1/responses') {
      this.handlePostResponses(req, res).catch((err) => {
        log(`[proxy] Unhandled error: ${err}`);
        if (!res.headersSent) jsonResponse(res, 500, { error: { message: String(err) } });
        else res.end();
      });
    } else {
      jsonResponse(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  }

  private handleGetResponse(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): void {
    const stored = this.sessions.get(id);
    if (!stored) {
      jsonResponse(res, 404, { error: { message: 'Response not found', type: 'not_found' } });
      return;
    }
    jsonResponse(res, 200, {
      id: stored.id,
      object: 'response',
      created_at: Math.floor(stored.createdAt / 1000),
      status: 'completed',
      model: stored.model,
      output: stored.outputItems,
      instructions: stored.instructions ?? null,
      tools: stored.tools ?? [],
    });
  }

  private async handlePostResponses(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: ResponsesRequest;
    try {
      body = JSON.parse(await readBody(req)) as ResponsesRequest;
    } catch {
      jsonResponse(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request' } });
      return;
    }

    if (!body.model) {
      jsonResponse(res, 400, { error: { message: '"model" is required', type: 'invalid_request' } });
      return;
    }

    const { history, instructions, tools } = this.sessions.buildHistory(
      body.previous_response_id,
      body.instructions,
      body.tools,
    );

    const responseId = newId('resp');
    const backend = detectBackend(body.model);
    const config = this.config;

    const currentInputItems: ResponsesInputItem[] = Array.isArray(body.input)
      ? body.input
      : [{ type: 'message', role: 'user', content: body.input }];

    initSSE(res);

    let outputItems: ResponsesInputItem[] = [];
    try {
      if (backend === 'anthropic') {
        const req2 = toAnthropic(body, history, instructions, tools, config);
        outputItems = await streamAnthropic(body, req2, res, responseId, config);
      } else if (backend === 'gemini') {
        const req2 = toGemini(body, history, instructions, tools, config);
        outputItems = await streamGemini(body, req2, res, responseId, config);
      } else {
        const req2 = toOpenAI(body, history, instructions, tools, config);
        outputItems = await streamOpenAI(body, req2, res, responseId, config);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[proxy] Backend error: ${message}`);
      try {
        writeSSE(res, 'error', { type: 'error', error: { type: 'server_error', message } });
        writeSSEDone(res);
      } catch { /* response already closed */ }
      res.end();
      return;
    }

    // Store for future previous_response_id lookups
    const stored: StoredResponse = {
      id: responseId,
      previousId: body.previous_response_id,
      model: body.model,
      instructions,
      tools,
      inputItems: currentInputItems,
      outputItems,
      accumulatedHistory: [...history, ...currentInputItems, ...outputItems],
      createdAt: Date.now(),
    };
    this.sessions.set(stored);

    res.end();
  }
}
