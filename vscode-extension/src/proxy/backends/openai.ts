import * as http from 'http';
import {
  ResponsesRequest, ResponsesInputItem, ResponsesTool, ResponsesContentPart,
  ChatCompletionRequest, ChatMessage, ChatTool, ChatToolCall, ImageSource, ProxyConfig,
} from '../types';
import { newId, writeSSE, writeSSEDone, parseSSEStream, buildFetchOptions, extractText, hasImages, debugLog } from '../utils';

// ---- Request translation --------------------------------------------------

function contentToChat(content: ResponsesContentPart[] | string): string | import('../types').ChatContentPart[] {
  if (typeof content === 'string') return content;
  if (!hasImages(content)) return extractText(content);
  return content.map((p) => {
    if (p.type === 'input_text' || p.type === 'output_text') return { type: 'text' as const, text: p.text };
    if (p.type === 'input_image') {
      if (p.image_url) return { type: 'image_url' as const, image_url: p.image_url };
      if (p.source) {
        const s = p.source as ImageSource;
        return { type: 'image_url' as const, image_url: { url: `data:${s.media_type};base64,${s.data}` } };
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
  config: ProxyConfig,
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (instructions) messages.push({ role: 'system', content: instructions });

  const currentItems: ResponsesInputItem[] = Array.isArray(request.input)
    ? request.input
    : [{ type: 'message', role: 'user', content: request.input }];

  let pendingToolCalls: ChatToolCall[] = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    }
  };

  for (const item of [...history, ...currentItems]) {
    if (item.type === 'message') {
      flushToolCalls();
      messages.push({ role: item.role as 'user' | 'assistant' | 'system', content: contentToChat(item.content) });
    } else if (item.type === 'function_call') {
      pendingToolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_output') {
      flushToolCalls();
      messages.push({ role: 'tool', content: item.output, tool_call_id: item.call_id });
    }
  }
  flushToolCalls();

  const chatReq: ChatCompletionRequest = { model: request.model, messages, stream: true };

  const resolvedTools = tools ?? request.tools;
  if (resolvedTools?.length) {
    chatReq.tools = resolvedTools.map((t): ChatTool => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) },
    }));
  }

  if (request.temperature !== undefined) chatReq.temperature = request.temperature;
  chatReq.max_tokens = request.max_output_tokens ?? config.defaultMaxTokens;
  if (request.top_p !== undefined) chatReq.top_p = request.top_p;

  return chatReq;
}

// ---- Response streaming ---------------------------------------------------

export async function streamOpenAI(
  request: ResponsesRequest,
  chatReq: ChatCompletionRequest,
  res: http.ServerResponse,
  responseId: string,
  config: ProxyConfig,
): Promise<ResponsesInputItem[]> {
  const url = `${config.openaiBaseUrl}/chat/completions`;
  debugLog(config, 'openai:request', { url, body: chatReq });

  const upstream = await fetch(url, buildFetchOptions('POST', chatReq, config));
  if (!upstream.ok) {
    const errBody = await upstream.text();
    throw new Error(`Backend error ${upstream.status}: ${errBody}`);
  }
  if (!upstream.body) throw new Error('No body from backend');

  const createdAt = Math.floor(Date.now() / 1000);
  const outputItems: ResponsesInputItem[] = [];

  writeSSE(res, 'response.created', {
    type: 'response.created',
    response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress', model: request.model, output: [], instructions: request.instructions ?? null, tools: request.tools ?? [] },
  });

  let outputIndex = -1;
  let textItemId = '';
  let textAccum = '';
  let textStarted = false;
  const toolCallMap = new Map<number, { id: string; callId: string; name: string; args: string }>();
  let toolCallsStarted = false;

  const finishTextItem = () => {
    if (!textStarted) return;
    writeSSE(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: textItemId, output_index: outputIndex, content_index: 0, text: textAccum });
    writeSSE(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: textItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: textAccum, annotations: [] } });
    const msgItem: ResponsesInputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textAccum, annotations: [] }], id: textItemId, status: 'completed' };
    writeSSE(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: msgItem });
    outputItems.push(msgItem);
    textStarted = false;
  };

  const finishToolCalls = () => {
    if (!toolCallsStarted) return;
    for (const [, tc] of toolCallMap) {
      writeSSE(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: tc.id, output_index: outputIndex, arguments: tc.args });
      const fcItem: ResponsesInputItem = { type: 'function_call', id: tc.id, call_id: tc.callId, name: tc.name, arguments: tc.args, status: 'completed' };
      writeSSE(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: fcItem });
      outputItems.push(fcItem);
      outputIndex++;
    }
    toolCallMap.clear();
    toolCallsStarted = false;
  };

  for await (const { data } of parseSSEStream(upstream.body)) {
    if (data === '[DONE]') break;
    let chunk: { choices?: Array<{ index: number; delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> };
    try { chunk = JSON.parse(data); } catch { continue; }
    debugLog(config, 'openai:chunk', chunk);

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta.content) {
      if (!textStarted) {
        outputIndex++;
        textItemId = newId('msg');
        textAccum = '';
        textStarted = true;
        writeSSE(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        writeSSE(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: textItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '' } });
      }
      textAccum += delta.content;
      writeSSE(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: textItemId, output_index: outputIndex, content_index: 0, delta: delta.content });
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let entry = toolCallMap.get(tc.index);
        if (!entry) {
          if (!toolCallsStarted) { toolCallsStarted = true; finishTextItem(); }
          outputIndex++;
          const tcId = newId('fc');
          const callId = tc.id ?? newId('call');
          entry = { id: tcId, callId, name: tc.function?.name ?? '', args: '' };
          toolCallMap.set(tc.index, entry);
          writeSSE(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: tcId, type: 'function_call', status: 'in_progress', name: entry.name, call_id: callId, arguments: '' } });
        }
        if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        if (tc.function?.arguments) {
          entry.args += tc.function.arguments;
          writeSSE(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: entry.id, output_index: outputIndex, delta: tc.function.arguments });
        }
      }
    }

    if (choice.finish_reason) { finishTextItem(); finishToolCalls(); }
  }

  finishTextItem();
  finishToolCalls();

  writeSSE(res, 'response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', created_at: createdAt, status: 'completed', model: request.model, output: outputItems, instructions: request.instructions ?? null, tools: request.tools ?? [] } });
  writeSSEDone(res);
  return outputItems;
}
