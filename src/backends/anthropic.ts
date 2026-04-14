/**
 * Backend: Anthropic Messages API  ↔  Responses API
 *
 * Translates a ResponsesRequest → AnthropicRequest, calls the backend,
 * then translates the SSE stream back to Responses API events.
 */

import type { Response as ExpressResponse } from 'express';
import {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesContentPart,
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
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

function contentToAnthropic(
  content: ResponsesContentPart[] | string,
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  if (!hasImages(content)) return extractText(content);

  return content
    .map((p): AnthropicContentBlock | null => {
      if (p.type === 'input_text' || p.type === 'output_text') {
        return { type: 'text', text: p.text };
      }
      if (p.type === 'input_image') {
        if (p.source) {
          const src = p.source as ImageSource;
          return {
            type: 'image',
            source: { type: 'base64', media_type: src.media_type, data: src.data },
          };
        }
        if (p.image_url) {
          const url = p.image_url.url;
          if (url.startsWith('data:')) {
            const [meta, data] = url.split(',');
            const media_type = meta.replace('data:', '').replace(';base64', '');
            return { type: 'image', source: { type: 'base64', media_type, data } };
          }
          return { type: 'image', source: { type: 'url', url } };
        }
      }
      return null;
    })
    .filter((b): b is AnthropicContentBlock => b !== null);
}

export function toAnthropic(
  request: ResponsesRequest,
  history: ResponsesInputItem[],
  instructions: string | undefined,
  tools: ResponsesTool[] | undefined,
  defaultMaxTokens: number,
): AnthropicRequest {
  // Normalise current input
  const currentItems: ResponsesInputItem[] = Array.isArray(request.input)
    ? request.input
    : [{ type: 'message', role: 'user', content: request.input }];

  const allItems = [...history, ...currentItems];

  // Build Anthropic messages — user/assistant turns must alternate.
  // Function calls go into the assistant turn as tool_use blocks,
  // and function results go into the next user turn as tool_result blocks.
  const messages: AnthropicMessage[] = [];

  // We accumulate blocks for the current role before pushing
  type PendingTurn = { role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] };
  let pending: PendingTurn | null = null;

  const flush = () => {
    if (pending && pending.blocks.length > 0) {
      messages.push({ role: pending.role, content: pending.blocks });
    }
    pending = null;
  };

  const ensure = (role: 'user' | 'assistant') => {
    if (pending?.role !== role) {
      flush();
      pending = { role, blocks: [] };
    }
    return pending!.blocks;
  };

  for (const item of allItems) {
    if (item.type === 'message') {
      // system role is handled via the top-level `system` field — skip here
      if (item.role === 'system') continue;
      const role = item.role as 'user' | 'assistant';
      const blocks = ensure(role);
      const content = contentToAnthropic(item.content);
      if (typeof content === 'string') {
        blocks.push({ type: 'text', text: content });
      } else {
        blocks.push(...content);
      }
    } else if (item.type === 'function_call') {
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        args = item.arguments;
      }
      ensure('assistant').push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: args,
      });
    } else if (item.type === 'function_call_output') {
      ensure('user').push({
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: item.output,
      });
    }
  }
  flush();

  const anthropicReq: AnthropicRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_output_tokens ?? defaultMaxTokens,
    stream: true,
  };

  if (instructions) anthropicReq.system = instructions;

  const resolvedTools = tools ?? request.tools;
  if (resolvedTools && resolvedTools.length > 0) {
    anthropicReq.tools = resolvedTools.map(
      (t): AnthropicTool => ({
        name: t.name,
        description: t.description,
        input_schema: (t.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }),
    );
  }

  if (request.temperature !== undefined) anthropicReq.temperature = request.temperature;
  if (request.top_p !== undefined) anthropicReq.top_p = request.top_p;

  return anthropicReq;
}

// ---- Response streaming translation --------------------------------------

export async function streamAnthropic(
  request: ResponsesRequest,
  anthropicReq: AnthropicRequest,
  res: ExpressResponse,
  responseId: string,
): Promise<ResponsesInputItem[]> {
  const config = getConfig();
  const url = `${config.anthropicBaseUrl}/messages`;

  debugLog('anthropic:request', { url, body: anthropicReq });

  const upstream = await fetch(
    url,
    buildFetchOptions('POST', anthropicReq, {
      'anthropic-version': '2023-06-01',
      'x-api-key': config.apiToken,
      // Remove default Bearer auth for Anthropic (uses x-api-key),
      // unless going through a proxy like Ask Sage that wants Bearer.
    }),
  );

  if (!upstream.ok) {
    const errBody = await upstream.text();
    debugLog('anthropic:error', { status: upstream.status, body: errBody });
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

  // Track open content blocks by their Anthropic index
  interface TextBlock {
    kind: 'text';
    itemId: string;
    outputIndex: number;
    accum: string;
  }
  interface ToolBlock {
    kind: 'tool';
    itemId: string;
    callId: string;
    name: string;
    outputIndex: number;
    argsAccum: string;
  }
  type Block = TextBlock | ToolBlock;

  const blocks = new Map<number, Block>();
  let nextOutputIndex = -1;

  const finishBlock = (b: Block) => {
    if (b.kind === 'text') {
      writeSSE(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: b.itemId,
        output_index: b.outputIndex,
        content_index: 0,
        text: b.accum,
      });
      writeSSE(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: b.itemId,
        output_index: b.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: b.accum, annotations: [] },
      });
      const msgItem: ResponsesInputItem = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: b.accum, annotations: [] }],
        id: b.itemId,
        status: 'completed',
      };
      writeSSE(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: b.outputIndex,
        item: msgItem,
      });
      outputItems.push(msgItem);
    } else {
      writeSSE(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: b.itemId,
        output_index: b.outputIndex,
        arguments: b.argsAccum,
      });
      const fcItem: ResponsesInputItem = {
        type: 'function_call',
        id: b.itemId,
        call_id: b.callId,
        name: b.name,
        arguments: b.argsAccum,
        status: 'completed',
      };
      writeSSE(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: b.outputIndex,
        item: fcItem,
      });
      outputItems.push(fcItem);
    }
  };

  for await (const { event, data } of parseSSEStream(upstream.body)) {
    if (data === '[DONE]') break;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      continue;
    }

    debugLog('anthropic:chunk', { event, msg });

    const type = (msg.type as string) ?? event ?? '';

    if (type === 'content_block_start') {
      const index = msg.index as number;
      const cb = msg.content_block as { type: string; id?: string; name?: string };
      nextOutputIndex++;

      if (cb.type === 'text') {
        const itemId = newId('msg');
        const block: TextBlock = { kind: 'text', itemId, outputIndex: nextOutputIndex, accum: '' };
        blocks.set(index, block);

        writeSSE(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: nextOutputIndex,
          item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
        writeSSE(res, 'response.content_part.added', {
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: nextOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        });
      } else if (cb.type === 'tool_use') {
        const itemId = newId('fc');
        const callId = cb.id ?? newId('call');
        const name = cb.name ?? '';
        const block: ToolBlock = {
          kind: 'tool',
          itemId,
          callId,
          name,
          outputIndex: nextOutputIndex,
          argsAccum: '',
        };
        blocks.set(index, block);

        writeSSE(res, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: nextOutputIndex,
          item: {
            id: itemId,
            type: 'function_call',
            status: 'in_progress',
            name,
            call_id: callId,
            arguments: '',
          },
        });
      }
    } else if (type === 'content_block_delta') {
      const index = msg.index as number;
      const delta = msg.delta as { type: string; text?: string; partial_json?: string };
      const block = blocks.get(index);
      if (!block) continue;

      if (delta.type === 'text_delta' && delta.text && block.kind === 'text') {
        block.accum += delta.text;
        writeSSE(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: block.itemId,
          output_index: block.outputIndex,
          content_index: 0,
          delta: delta.text,
        });
      } else if (delta.type === 'input_json_delta' && delta.partial_json && block.kind === 'tool') {
        block.argsAccum += delta.partial_json;
        writeSSE(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: block.itemId,
          output_index: block.outputIndex,
          delta: delta.partial_json,
        });
      }
    } else if (type === 'content_block_stop') {
      const index = msg.index as number;
      const block = blocks.get(index);
      if (block) {
        finishBlock(block);
        blocks.delete(index);
      }
    }
    // message_start, message_delta, message_stop, ping — no action needed
  }

  // Flush any remaining open blocks
  for (const block of blocks.values()) finishBlock(block);
  blocks.clear();

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
