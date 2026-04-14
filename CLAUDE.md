# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A proxy that lets OpenAI Codex CLI (which speaks only the OpenAI **Responses API**) talk to other LLM backends — OpenAI Chat Completions, Anthropic Messages, and Google Gemini. The proxy translates both directions: request format and SSE streaming response events.

The repo has two independent packages:
- **Root** (`/`) — standalone Node.js proxy server (Express, ESM, runs via `npm start`)
- **`vscode-extension/`** — VS Code extension that embeds the same proxy logic (no Express, Node `http` module, CJS bundle via esbuild)

## Commands

### Standalone proxy (root)
```bash
npm run dev          # tsx watch — hot reload, reads .env
npm run build        # tsc → dist/
npm start            # node dist/server.js
npm run lint         # tsc --noEmit
```

### VS Code extension (`cd vscode-extension/`)
```bash
npm run build        # esbuild → dist/extension.js (~41KB CJS bundle)
npm run build:watch  # watch mode
npm run lint         # tsc --noEmit
npm run package      # vsce package → codex-proxy-0.1.0.vsix
code --install-extension codex-proxy-0.1.0.vsix
```

## Configuration

### Standalone proxy
Copy `.env.example` → `.env`. Key variables:
- `BACKEND_BASE_URL` — base URL of the backend (default: `https://api.openai.com`)
- `API_TOKEN` — Bearer token sent to the backend
- `PORT` — proxy listen port (default: 8080)
- `DEBUG=true` — logs full request/response bodies
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `GEMINI_BASE_URL` — override derived per-provider paths

**URL derivation logic** (same in both packages): if `BACKEND_BASE_URL` is a direct provider URL (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`), standard paths are appended. Otherwise (e.g. Ask Sage: `sage.ask-sage.ai`), Ask Sage's path layout is assumed: `/server/openai/v1`, `/server/anthropic/v1`, `/server/google/v1beta`.

### Pointing Codex at the proxy
```bash
export OPENAI_BASE_URL=http://localhost:8080
export OPENAI_API_KEY=dummy   # proxy handles real auth
```

## Architecture

### Request flow
```
Codex → POST /v1/responses
          ↓
        server.ts (or proxy/server.ts in extension)
          ↓ detectBackend(model)  ← model name prefix determines backend
          ↓
        backends/{openai,anthropic,gemini}.ts
          to*()   — translate ResponsesRequest → backend request format
          stream*() — call backend, parse SSE, emit Responses API events
          ↓
        Responses API SSE back to Codex
```

### Session store (`session.ts`)
Codex sends only *new* input items per turn and references prior context via `previous_response_id`. The session store keeps `accumulatedHistory` per response ID — the full flat list of all prior input + output items. On each new request, `buildHistory()` returns the accumulated list so backends receive the complete message history.

### Backend modules (each handles both directions)

Each backend file exports two functions:
- `to*()` — converts `ResponsesInputItem[]` history + current `ResponsesRequest` → backend request object. Handles message role mapping, image content, and tool call/result pairing.
- `stream*()` — calls the backend, parses its SSE format, emits the correct Responses API SSE events (`response.created` → `response.output_item.added` → `response.output_text.delta` → ... → `response.completed`), and returns the list of output items for session storage.

Tool call streaming differences across backends:
- **OpenAI**: arguments arrive as streaming deltas indexed by `tool_calls[].index`
- **Anthropic**: tool use arrives as a `content_block` of type `tool_use` with `input_json_delta` deltas
- **Gemini**: full `functionCall` args arrive in a single chunk (no streaming deltas)

### Extension vs. standalone differences

| | Standalone | Extension |
|---|---|---|
| HTTP server | Express | Node `http` module |
| Module format | ESM (`.js` imports required) | CJS (esbuild bundle) |
| Config source | `process.env` / `.env` | `vscode.workspace.getConfiguration('codex-proxy')` |
| Logging | `console.log` | VS Code Output Channel via `setLogger()` in `utils.ts` |
| Session lifecycle | Process lifetime (singleton `sessions`) | `ProxyServer` class instance; `SessionStore.start()/stop()` |

The extension's `ProxyServer` class (`vscode-extension/src/proxy/server.ts`) wraps the HTTP server so `extension.ts` can start/stop/reconfigure it across VS Code's `activate`/`deactivate` lifecycle. Config changes trigger `server.reconfigure()` which restarts the listener if it was running.

### SSE parsing (`utils.ts` / `proxy/utils.ts`)
`parseSSEStream()` is an async generator that handles both Web `ReadableStream` (from native `fetch`) and Node `ReadableStream` (via an adapter shim). It yields `{ event, data }` objects and is used identically in all three backends.
