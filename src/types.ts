// ============================================================
// OpenAI Responses API — what Codex sends/expects
// ============================================================

export interface ResponsesRequest {
  model: string;
  /** Simple string or structured items */
  input: string | ResponsesInputItem[];
  tools?: ResponsesTool[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  previous_response_id?: string;
  top_p?: number;
  truncation?: 'auto' | 'disabled';
  store?: boolean;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: ResponsesContentPart[] | string;
  id?: string;
  status?: string;
}

export interface ResponsesFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'input_image'; image_url?: { url: string; detail?: string }; source?: ImageSource }
  | { type: 'refusal'; refusal: string };

export interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

// ============================================================
// Session store — tracks responses so previous_response_id works
// ============================================================

export interface StoredResponse {
  id: string;
  previousId?: string;
  model: string;
  instructions?: string;
  tools?: ResponsesTool[];
  /** New input items sent in the original request */
  inputItems: ResponsesInputItem[];
  /** Items produced by the model (assistant text, function calls) */
  outputItems: ResponsesInputItem[];
  /** Full accumulated history up to and including this response */
  accumulatedHistory: ResponsesInputItem[];
  createdAt: number;
}

// ============================================================
// OpenAI Chat Completions — one of the backend formats
// ============================================================

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

// ============================================================
// Anthropic Messages API — one of the backend formats
// ============================================================

export interface AnthropicRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  max_tokens: number;
  top_p?: number;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContentBlock[] };

export type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

// ============================================================
// Google Gemini API — one of the backend formats
// ============================================================

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { role: 'user'; parts: GeminiPart[] };
  tools?: GeminiToolBlock[];
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiToolBlock {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

// ============================================================
// Internal
// ============================================================

export type BackendType = 'openai' | 'anthropic' | 'gemini';
