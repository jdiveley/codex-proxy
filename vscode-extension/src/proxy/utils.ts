import { randomUUID } from 'crypto';
import * as http from 'http';
import { ResponsesContentPart, ProxyConfig } from './types';

// ---- ID generation --------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// ---- Logging --------------------------------------------------------------

type Logger = (msg: string) => void;
let _logger: Logger = (msg) => console.log(msg);

export function setLogger(fn: Logger): void {
  _logger = fn;
}

export function log(msg: string): void {
  _logger(msg);
}

export function debugLog(config: ProxyConfig, label: string, data: unknown): void {
  if (config.debug) {
    _logger(`[${label}] ${JSON.stringify(data, null, 2)}`);
  }
}

// ---- HTTP helpers ---------------------------------------------------------

export function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- SSE helpers ----------------------------------------------------------

export function initSSE(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function writeSSE(res: http.ServerResponse, eventType: string, data: unknown): void {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function writeSSEDone(res: http.ServerResponse): void {
  res.write('data: [DONE]\n\n');
}

// ---- Upstream SSE parser --------------------------------------------------

type StreamReadResult = { done: false; value: Uint8Array } | { done: true; value: undefined };

function nodeStreamToWebReader(
  stream: NodeJS.ReadableStream,
): ReadableStreamDefaultReader<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let resolve: ((v: StreamReadResult) => void) | null = null;
  let isDone = false;

  stream.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ done: false, value: new Uint8Array(bytes) });
    } else {
      chunks.push(new Uint8Array(bytes));
    }
  });

  stream.on('end', () => {
    isDone = true;
    resolve?.({ done: true, value: undefined });
  });

  return {
    read(): Promise<StreamReadResult> {
      if (chunks.length > 0) return Promise.resolve({ done: false, value: chunks.shift()! });
      if (isDone) return Promise.resolve({ done: true, value: undefined });
      return new Promise((r) => { resolve = r; });
    },
    releaseLock() {},
    cancel() { return Promise.resolve(); },
    closed: Promise.resolve(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): AsyncGenerator<{ event: string | null; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | null = null;
  const dataLines: string[] = [];

  const reader =
    'getReader' in body ? body.getReader() : nodeStreamToWebReader(body as NodeJS.ReadableStream);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      } else if (line === '') {
        if (dataLines.length > 0) {
          yield { event: currentEvent, data: dataLines.join('\n') };
          dataLines.length = 0;
          currentEvent = null;
        }
      }
    }
  }
  if (dataLines.length > 0) yield { event: currentEvent, data: dataLines.join('\n') };
}

// ---- Fetch helpers --------------------------------------------------------

export function buildFetchOptions(
  method: string,
  body: unknown,
  config: ProxyConfig,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// ---- Content helpers ------------------------------------------------------

export function extractText(content: ResponsesContentPart[] | string): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'input_text' || p.type === 'output_text')
    .map((p) => (p as { text: string }).text)
    .join('');
}

export function hasImages(content: ResponsesContentPart[] | string): boolean {
  if (typeof content === 'string') return false;
  return content.some((p) => p.type === 'input_image');
}
