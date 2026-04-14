import { randomUUID } from 'crypto';
import type { Response as ExpressResponse } from 'express';
import { getConfig } from './config.js';

// ---- ID generation --------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// ---- SSE helpers ----------------------------------------------------------

/**
 * Set response headers for SSE and flush any Express buffers.
 */
export function initSSE(res: ExpressResponse): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/**
 * Write a single SSE event to the Express response.
 */
export function writeSSE(res: ExpressResponse, eventType: string, data: unknown): void {
  const json = JSON.stringify(data);
  res.write(`event: ${eventType}\ndata: ${json}\n\n`);
}

/**
 * Write the SSE termination sentinel.
 */
export function writeSSEDone(res: ExpressResponse): void {
  res.write('data: [DONE]\n\n');
}

// ---- Upstream SSE parser --------------------------------------------------

/**
 * Async generator that yields parsed SSE events from a fetch Response body.
 * Each yielded item is `{ event: string | null, data: string }`.
 * Lines that are `data: [DONE]` are yielded as-is so callers can detect stream end.
 */
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
    buffer = lines.pop() ?? ''; // keep incomplete last line

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      } else if (line === '') {
        // Blank line — dispatch event
        if (dataLines.length > 0) {
          const data = dataLines.join('\n');
          yield { event: currentEvent, data };
          dataLines.length = 0;
          currentEvent = null;
        }
      }
      // Ignore comment lines (starting with ':')
    }
  }

  // Flush remaining
  if (dataLines.length > 0) {
    yield { event: currentEvent, data: dataLines.join('\n') };
  }
}

type StreamReadResult = { done: false; value: Uint8Array } | { done: true; value: undefined };

/** Adapt a Node.js Readable stream to a minimal Web ReadableStream reader */
function nodeStreamToWebReader(
  stream: NodeJS.ReadableStream,
): ReadableStreamDefaultReader<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let resolve: ((v: StreamReadResult) => void) | null = null;
  let done = false;

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
    done = true;
    if (resolve) {
      resolve({ done: true, value: undefined });
    }
  });

  return {
    read(): Promise<StreamReadResult> {
      if (chunks.length > 0) {
        return Promise.resolve({ done: false, value: chunks.shift()! });
      }
      if (done) {
        return Promise.resolve({ done: true, value: undefined });
      }
      return new Promise((r) => {
        resolve = r;
      });
    },
    releaseLock() {},
    cancel() {},
    closed: Promise.resolve(),
  } as ReadableStreamDefaultReader<Uint8Array>;
}

// ---- Fetch with optional client cert -------------------------------------

export function buildFetchOptions(
  method: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  const config = getConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiToken}`,
    ...extraHeaders,
  };

  return {
    method,
    headers,
    body: JSON.stringify(body),
  };
}

// ---- Debug logging -------------------------------------------------------

export function debugLog(label: string, data: unknown): void {
  if (getConfig().debug) {
    console.log(`[proxy][${label}]`, JSON.stringify(data, null, 2));
  }
}

// ---- Content extraction helpers ------------------------------------------

import type { ResponsesContentPart } from './types.js';

/** Extract plain text from Responses API content (ignores images) */
export function extractText(content: ResponsesContentPart[] | string): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'input_text' || p.type === 'output_text')
    .map((p) => (p as { type: string; text: string }).text)
    .join('');
}

/** Check if content contains any images */
export function hasImages(content: ResponsesContentPart[] | string): boolean {
  if (typeof content === 'string') return false;
  return content.some((p) => p.type === 'input_image');
}
