/**
 * Backend: Google Gemini API  ↔  Responses API
 *
 * Translates a ResponsesRequest → GeminiRequest, calls the backend with
 * server-sent events (streamGenerateContent?alt=sse), and translates
 * the responses back to Responses API SSE events.
 */

import type { Response as ExpressResponse } from 'express';
import {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesContentPart,
  GeminiRequest,
  GeminiContent,
  GeminiPart,
  GeminiToolBlock,
  ImageSource,
} from '../types.js';
import { getConfig } from '../config.js';
import {
  newId,
  writeSSE,
  writeSSEDone,
  parseSSEStream,
  buildFetchOptions,
  extractText,
  hasImages,
  debugLog,
} from '../utils.js';

// ---- Request translation --------------------------------------------------

function contentToGemini(content: ResponsesContentPart[] | string): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!hasImages(content)) return [{ text: extractText(content) }];

  return content
    .map((p): GeminiPart | null => {
      if (p.type === 'input_text' || p.type === 'output_text') return { text: p.text };
      if (p.type === 'input_image') {
        if (p.source) {
          const src = p.source as ImageSource;
          return { inlineData: { mimeType: src.media_type, data: src.data } };
        }
        if (p.image_url?.url.startsWith('data:')) {
          const [meta, data] = p.image_url.url.split(',');
          const mimeType = meta.replace('data:', '').replace(';base64', '');
          return { inlineData: { mimeType, data } };
        }
      }
      return null;
    })
    .filter((p): p is GeminiPart => p !== null);
}

export function toGemini(
  request: ResponsesRequest,
  history: ResponsesInputItem[],
  instructions: string | undefined,
  tools: ResponsesTool[] | undefined,
  defaultMaxTokens: number,
): GeminiRequest {
  const currentItems: ResponsesInputItem[] = Array.isArray(request.input)
    ? request.input
    : [{ type: 'message', role: 'user', content: request.input }];

  const allItems = [...history, ...currentItems];

  // Gemini requires strictly alternating user/model turns.
  // We accumulate parts per turn and merge same-role consecutive items.
  const contents: GeminiContent[] = [];

  let currentRole: 'user' | 'model' | null = null;
  let currentParts: GeminiPart[] = [];

  const flush = () => {
    if (currentRole && currentParts.length > 0) {
      contents.push({ role: currentRole, parts: currentParts });
    }
    currentParts = [];
  };

  const ensure = (role: 'user' | 'model') => {
    if (currentRole !== role) {
      flush();
      currentRole = role;
    }
    return currentParts;
  };

  for (const item of allItems) {
    if (item.type === 'message') {
      if (item.role === 'system') continue; // handled via systemInstruction
      const gemRole = item.role === 'assistant' ? 'model' : 'user';
      ensure(gemRole).push(...contentToGemini(item.content));
    } else if (item.type === 'function_call') {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        args = { _raw: item.arguments };
      }
      ensure('model').push({ functionCall: { name: item.name, args } });
    } else if (item.type === 'function_call_output') {
      let response: Record<string, unknown>;
      try {
        response = JSON.parse(item.output) as Record<string, unknown>;
      } catch {
        response = { output: item.output };
      }
      // Gemini function responses are user-turn parts
      ensure('user').push({ functionResponse: { name: '_result', response } });
    }
  }
  flush();

  const gemReq: GeminiRequest = { contents };

  if (instructions) {
    gemReq.systemInstruction = { role: 'user', parts: [{ text: instructions }] };
  }

  const resolvedTools = tools ?? request.tools;
  if (resolvedTools && resolvedTools.length > 0) {
    const block: GeminiToolBlock = {
      functionDeclarations: resolvedTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
    gemReq.tools = [block];
  }

  gemReq.generationConfig = {
    maxOutputTokens: request.max_output_tokens ?? defaultMaxTokens,
  };
  if (request.temperature !== undefined) gemReq.generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) gemReq.generationConfig.topP = request.top_p;

  return gemReq;
}

// ---- Response streaming translation --------------------------------------

export async function streamGemini(
  request: ResponsesRequest,
  gemReq: GeminiRequest,
  res: ExpressResponse,
  responseId: string,
): Promise<ResponsesInputItem[]> {
  const config = getConfig();
  // Strip provider prefix from model name for Gemini URL
  const modelName = request.model.replace(/^models\//, '');
  const url = `${config.geminiBaseUrl}/models/${modelName}:streamGenerateContent?alt=sse`;

  debugLog('gemini:request', { url, body: gemReq });

  // Gemini uses an API key query param OR Bearer token depending on deployment.
  // For Ask Sage, Bearer is correct. For direct Google API, use key= param.
  const upstream = await fetch(url, buildFetchOptions('POST', gemReq));

  if (!upstream.ok) {
    const errBody = await upstream.text();
    debugLog('gemini:error', { status: upstream.status, body: errBody });
    throw new Error(`Backend error ${upstream.status}: ${errBody}`);
  }

  if (!upstream.body) throw new Error('No body from backend');

  const createdAt = Math.floor(Date.now() / 1000);
  const outputItems: ResponsesInputItem[] = [];

  writeSSE(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'in_progress',
      model: request.model,
      output: [],
      instructions: request.instructions ?? null,
      tools: request.tools ?? [],
    },
  });

  let outputIndex = -1;
  let textItemId = '';
  let textAccum = '';
  let textStarted = false;

  const openTextItem = () => {
    outputIndex++;
    textItemId = newId('msg');
    textAccum = '';
    textStarted = true;

    writeSSE(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { id: textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    writeSSE(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: textItemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });
  };

  const closeTextItem = () => {
    if (!textStarted) return;
    writeSSE(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: textItemId,
      output_index: outputIndex,
      content_index: 0,
      text: textAccum,
    });
    writeSSE(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: textItemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: textAccum, annotations: [] },
    });
    const msgItem: ResponsesInputItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: textAccum, annotations: [] }],
      id: textItemId,
      status: 'completed',
    };
    writeSSE(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: msgItem,
    });
    outputItems.push(msgItem);
    textStarted = false;
  };

  for await (const { data } of parseSSEStream(upstream.body)) {
    if (data === '[DONE]') break;

    let chunk: {
      candidates?: Array<{
        content?: {
          role?: string;
          parts?: GeminiPart[];
        };
        finishReason?: string;
      }>;
    };

    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }

    debugLog('gemini:chunk', chunk);

    const candidate = chunk.candidates?.[0];
    if (!candidate?.content?.parts) continue;

    for (const part of candidate.content.parts) {
      if ('text' in part && part.text) {
        if (!textStarted) openTextItem();
        textAccum += part.text;
        writeSSE(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: textItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: part.text,
        });
      } else if ('functionCall' in part && part.functionCall) {
        closeTextItem();
        outputIndex++;
        const fcItemId = newId('fc');
        const callId = newId('call');
        const { name, args } = part.functionCall;
        const argsStr = JSON.stringify(args ?? {});

        writeSSE(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            id: fcItemId,
            type: 'function_call',
            status: 'in_progress',
            name,
            call_id: callId,
            arguments: '',
          },
        });
        // Gemini gives us the full args in one chunk — emit as a single delta
        writeSSE(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: fcItemId,
          output_index: outputIndex,
          delta: argsStr,
        });
        writeSSE(res, 'response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: fcItemId,
          output_index: outputIndex,
          arguments: argsStr,
        });
        const fcItem: ResponsesInputItem = {
          type: 'function_call',
          id: fcItemId,
          call_id: callId,
          name,
          arguments: argsStr,
          status: 'completed',
        };
        writeSSE(res, 'response.output_item.done', {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: fcItem,
        });
        outputItems.push(fcItem);
      }
    }
  }

  closeTextItem();

  writeSSE(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'completed',
      model: request.model,
      output: outputItems,
      instructions: request.instructions ?? null,
      tools: request.tools ?? [],
    },
  });

  writeSSEDone(res);
  return outputItems;
}
