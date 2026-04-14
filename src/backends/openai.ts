/**
 * Backend: OpenAI Chat Completions  ↔  Responses API
 *
 * Translates a ResponsesRequest → ChatCompletionRequest, calls the backend,
 * then translates the SSE stream back to Responses API events.
 */

import type { Response as ExpressResponse } from 'express';
import {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesContentPart,
  ChatCompletionRequest,
  ChatMessage,
  ChatTool,
  ChatToolCall,
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

function contentToChat(
  content: ResponsesContentPart[] | string,
): string | import('../types.js').ChatContentPart[] {
  if (typeof content === 'string') return content;
  if (!hasImages(content)) return extractText(content);

  return content.map((p) => {
    if (p.type === 'input_text' || p.type === 'output_text') {
      return { type: 'text' as const, text: p.text };
    }
    if (p.type === 'input_image') {
      if (p.image_url) return { type: 'image_url' as const, image_url: p.image_url };
      if (p.source) {
        const src = p.source as ImageSource;
        return {
          type: 'image_url' as const,
          image_url: { url: `data:${src.media_type};base64,${src.data}` },
        };
      }
    }
    return { type: 'text' as const, text: '' };
  });
}

export function toOpenAI(
  request: ResponsesRequest,
  history: ResponsesInputItem[],
  instructions: string | undefined,
  tools: ResponsesTool[] | undefined,
  defaultMaxTokens: number,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  // Normalise the current input into items
  const currentItems: ResponsesInputItem[] = Array.isArray(request.input)
    ? request.input
    : [{ type: 'message', role: 'user', content: request.input }];

  // Merge history + current input
  const allItems = [...history, ...currentItems];

  // Convert items → messages, grouping consecutive function calls into a
  // single assistant turn with tool_calls[], followed by tool result messages.
  let pendingToolCalls: ChatToolCall[] = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    }
  };

  for (const item of allItems) {
    if (item.type === 'message') {
      flushToolCalls();
      messages.push({
        role: item.role as 'user' | 'assistant' | 'system',
        content: contentToChat(item.content),
      });
    } else if (item.type === 'function_call') {
      pendingToolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === 'function_call_output') {
      flushToolCalls();
      messages.push({ role: 'tool', content: item.output, tool_call_id: item.call_id });
    }
  }
  flushToolCalls();

  const chatReq: ChatCompletionRequest = {
    model: request.model,
    messages,
    stream: true,
  };

  const resolvedTools = tools ?? request.tools;
  if (resolvedTools && resolvedTools.length > 0) {
    chatReq.tools = resolvedTools.map(
      (t): ChatTool => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          ...(t.strict !== undefined ? { strict: t.strict } : {}),
        },
      }),
    );
  }

  if (request.temperature !== undefined) chatReq.temperature = request.temperature;
  if (request.max_output_tokens !== undefined) {
    chatReq.max_tokens = request.max_output_tokens;
  } else {
    chatReq.max_tokens = defaultMaxTokens;
  }
  if (request.top_p !== undefined) chatReq.top_p = request.top_p;

  return chatReq;
}

// ---- Response streaming translation --------------------------------------

/**
 * Call the Chat Completions endpoint and stream back Responses API SSE events.
 * Returns the list of output items produced (for session storage).
 */
export async function streamOpenAI(
  request: ResponsesRequest,
  chatReq: ChatCompletionRequest,
  res: ExpressResponse,
  responseId: string,
): Promise<ResponsesInputItem[]> {
  const config = getConfig();
  const url = `${config.openaiBaseUrl}/chat/completions`;

  debugLog('openai:request', { url, body: chatReq });

  const upstream = await fetch(url, buildFetchOptions('POST', chatReq));

  if (!upstream.ok) {
    const errBody = await upstream.text();
    debugLog('openai:error', { status: upstream.status, body: errBody });
    throw new Error(`Backend error ${upstream.status}: ${errBody}`);
  }

  if (!upstream.body) throw new Error('No body from backend');

  const createdAt = Math.floor(Date.now() / 1000);
  const outputItems: ResponsesInputItem[] = [];

  // Emit response.created
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

  // State for the current output item(s)
  let outputIndex = -1;
  let textItemId = '';
  let textAccum = '';
  let textStarted = false;

  // Tool call accumulator: index → {id, name, args}
  const toolCallMap = new Map<number, { id: string; callId: string; name: string; args: string }>();
  let toolCallsStarted = false;

  const finishTextItem = () => {
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

  const finishToolCalls = () => {
    if (!toolCallsStarted) return;
    for (const [, tc] of toolCallMap) {
      writeSSE(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: tc.id,
        output_index: outputIndex,
        arguments: tc.args,
      });
      const fcItem: ResponsesInputItem = {
        type: 'function_call',
        id: tc.id,
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.args,
        status: 'completed',
      };
      writeSSE(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: fcItem,
      });
      outputItems.push(fcItem);
      outputIndex++;
    }
    toolCallMap.clear();
    toolCallsStarted = false;
  };

  for await (const { data } of parseSSEStream(upstream.body)) {
    if (data === '[DONE]') break;

    let chunk: {
      choices?: Array<{
        index: number;
        delta: {
          content?: string | null;
          role?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };

    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }

    debugLog('openai:chunk', chunk);

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;

    // ---- Text delta ----
    if (delta.content != null && delta.content !== '') {
      if (!textStarted) {
        outputIndex++;
        textItemId = newId('msg');
        textAccum = '';
        textStarted = true;

        writeSSE(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            id: textItemId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        });
        writeSSE(res, 'response.content_part.added', {
          type: 'response.content_part.added',
          item_id: textItemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        });
      }

      textAccum += delta.content;
      writeSSE(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }

    // ---- Tool call deltas ----
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let entry = toolCallMap.get(tc.index);
        if (!entry) {
          // First time we see this tool call index — allocate a new output item
          if (!toolCallsStarted) {
            toolCallsStarted = true;
            finishTextItem();
          }
          outputIndex++;
          const tcId = newId('fc');
          const callId = tc.id ?? newId('call');
          entry = { id: tcId, callId, name: tc.function?.name ?? '', args: '' };
          toolCallMap.set(tc.index, entry);

          writeSSE(res, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: {
              id: tcId,
              type: 'function_call',
              status: 'in_progress',
              name: entry.name,
              call_id: callId,
              arguments: '',
            },
          });
        }

        if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        if (tc.function?.arguments) {
          entry.args += tc.function.arguments;
          writeSSE(res, 'response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: entry.id,
            output_index: outputIndex,
            delta: tc.function.arguments,
          });
        }
      }
    }

    // ---- finish_reason ----
    if (choice.finish_reason) {
      finishTextItem();
      finishToolCalls();
    }
  }

  // Fallback finish in case finish_reason was not present
  finishTextItem();
  finishToolCalls();

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
