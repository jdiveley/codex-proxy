import * as http from 'http';
import {
  ResponsesRequest, ResponsesInputItem, ResponsesTool, ResponsesContentPart,
  GeminiRequest, GeminiContent, GeminiPart, GeminiToolBlock, ImageSource, ProxyConfig,
} from '../types';
import { newId, writeSSE, writeSSEDone, parseSSEStream, buildFetchOptions, extractText, hasImages, debugLog } from '../utils';

// ---- Request translation --------------------------------------------------

function contentToGemini(content: ResponsesContentPart[] | string): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!hasImages(content)) return [{ text: extractText(content) }];
  return content.map((p): GeminiPart | null => {
    if (p.type === 'input_text' || p.type === 'output_text') return { text: p.text };
    if (p.type === 'input_image') {
      if (p.source) { const s = p.source as ImageSource; return { inlineData: { mimeType: s.media_type, data: s.data } }; }
      if (p.image_url?.url.startsWith('data:')) {
        const [meta, data] = p.image_url.url.split(',');
        return { inlineData: { mimeType: meta.replace('data:', '').replace(';base64', ''), data } };
      }
    }
    return null;
  }).filter((p): p is GeminiPart => p !== null);
}

export function toGemini(
  request: ResponsesRequest,
  history: ResponsesInputItem[],
  instructions: string | undefined,
  tools: ResponsesTool[] | undefined,
  config: ProxyConfig,
): GeminiRequest {
  const currentItems: ResponsesInputItem[] = Array.isArray(request.input)
    ? request.input
    : [{ type: 'message', role: 'user', content: request.input }];

  const contents: GeminiContent[] = [];
  let currentRole: 'user' | 'model' | null = null;
  let currentParts: GeminiPart[] = [];

  const flush = () => {
    if (currentRole && currentParts.length > 0) contents.push({ role: currentRole, parts: currentParts });
    currentParts = [];
  };
  const ensure = (role: 'user' | 'model') => {
    if (currentRole !== role) { flush(); currentRole = role; }
    return currentParts;
  };

  for (const item of [...history, ...currentItems]) {
    if (item.type === 'message') {
      if (item.role === 'system') continue;
      ensure(item.role === 'assistant' ? 'model' : 'user').push(...contentToGemini(item.content));
    } else if (item.type === 'function_call') {
      let args: Record<string, unknown>;
      try { args = JSON.parse(item.arguments) as Record<string, unknown>; } catch { args = { _raw: item.arguments }; }
      ensure('model').push({ functionCall: { name: item.name, args } });
    } else if (item.type === 'function_call_output') {
      let response: Record<string, unknown>;
      try { response = JSON.parse(item.output) as Record<string, unknown>; } catch { response = { output: item.output }; }
      ensure('user').push({ functionResponse: { name: '_result', response } });
    }
  }
  flush();

  const gemReq: GeminiRequest = { contents };
  if (instructions) gemReq.systemInstruction = { role: 'user', parts: [{ text: instructions }] };

  const resolvedTools = tools ?? request.tools;
  if (resolvedTools?.length) {
    gemReq.tools = [{ functionDeclarations: resolvedTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }

  gemReq.generationConfig = { maxOutputTokens: request.max_output_tokens ?? config.defaultMaxTokens };
  if (request.temperature !== undefined) gemReq.generationConfig.temperature = request.temperature;
  if (request.top_p !== undefined) gemReq.generationConfig.topP = request.top_p;

  return gemReq;
}

// ---- Response streaming ---------------------------------------------------

export async function streamGemini(
  request: ResponsesRequest,
  gemReq: GeminiRequest,
  res: http.ServerResponse,
  responseId: string,
  config: ProxyConfig,
): Promise<ResponsesInputItem[]> {
  const modelName = request.model.replace(/^models\//, '');
  const url = `${config.geminiBaseUrl}/models/${modelName}:streamGenerateContent?alt=sse`;
  debugLog(config, 'gemini:request', { url, body: gemReq });

  const upstream = await fetch(url, buildFetchOptions('POST', gemReq, config));
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

  const openTextItem = () => {
    outputIndex++;
    textItemId = newId('msg');
    textAccum = '';
    textStarted = true;
    writeSSE(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    writeSSE(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: textItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '' } });
  };

  const closeTextItem = () => {
    if (!textStarted) return;
    writeSSE(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: textItemId, output_index: outputIndex, content_index: 0, text: textAccum });
    writeSSE(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: textItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: textAccum, annotations: [] } });
    const msgItem: ResponsesInputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textAccum, annotations: [] }], id: textItemId, status: 'completed' };
    writeSSE(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: msgItem });
    outputItems.push(msgItem);
    textStarted = false;
  };

  for await (const { data } of parseSSEStream(upstream.body)) {
    if (data === '[DONE]') break;
    let chunk: { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }> };
    try { chunk = JSON.parse(data); } catch { continue; }
    debugLog(config, 'gemini:chunk', chunk);

    const candidate = chunk.candidates?.[0];
    if (!candidate?.content?.parts) continue;

    for (const part of candidate.content.parts) {
      if ('text' in part && part.text) {
        if (!textStarted) openTextItem();
        textAccum += part.text;
        writeSSE(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: textItemId, output_index: outputIndex, content_index: 0, delta: part.text });
      } else if ('functionCall' in part && part.functionCall) {
        closeTextItem();
        outputIndex++;
        const fcItemId = newId('fc');
        const callId = newId('call');
        const { name, args } = part.functionCall;
        const argsStr = JSON.stringify(args ?? {});
        writeSSE(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: fcItemId, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '' } });
        writeSSE(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: fcItemId, output_index: outputIndex, delta: argsStr });
        writeSSE(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: fcItemId, output_index: outputIndex, arguments: argsStr });
        const fcItem: ResponsesInputItem = { type: 'function_call', id: fcItemId, call_id: callId, name, arguments: argsStr, status: 'completed' };
        writeSSE(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: fcItem });
        outputItems.push(fcItem);
      }
    }
  }

  closeTextItem();
  writeSSE(res, 'response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', created_at: createdAt, status: 'completed', model: request.model, output: outputItems, instructions: request.instructions ?? null, tools: request.tools ?? [] } });
  writeSSEDone(res);
  return outputItems;
}
