# Codex Proxy

A proxy that lets [OpenAI Codex CLI](https://github.com/openai/codex) talk to LLM backends other than OpenAI. Codex speaks only the OpenAI Responses API — this proxy accepts those requests and translates them to whichever backend you configure, then translates the streaming response back.

**Supported backends:**
- OpenAI Chat Completions (`gpt-4o`, `o3`, `o4-mini`, …)
- Anthropic Messages API (`claude-*`)
- Google Gemini (`gemini-*`)
- [Ask Sage](https://www.asksage.ai/) DoD/DoW endpoint — all of the above via a single base URL

Full tool use and SSE streaming are supported for all three backends.

---

## How it works

```
Codex CLI
    │  POST /v1/responses  (OpenAI Responses API)
    ▼
Codex Proxy  ──── detects model family ────►  OpenAI Chat Completions
                                         ────►  Anthropic Messages
                                         ────►  Google Gemini
    │  Responses API SSE events
    ▼
Codex CLI
```

The proxy detects which backend to use from the model name prefix (`claude-` → Anthropic, `gemini-` → Gemini, everything else → OpenAI). It maintains an in-memory session store to support Codex's `previous_response_id` conversation chaining.

---

## Installation

Requires Node.js 18+.

```bash
git clone https://github.com/jdiveley/codex-proxy
cd codex-proxy
npm install
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
BACKEND_BASE_URL=https://api.openai.com   # or your backend base URL
API_TOKEN=your-api-key-or-token
```

---

## Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

Then point Codex at the proxy:

```bash
export OPENAI_BASE_URL=http://localhost:8080
export OPENAI_API_KEY=dummy        # proxy handles real auth
codex
```

---

## Configuration

All configuration is via environment variables (`.env` file supported).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the proxy listens on |
| `BACKEND_BASE_URL` | `https://api.openai.com` | Base URL of the LLM backend |
| `API_TOKEN` | — | Bearer token sent to the backend |
| `DEFAULT_MAX_TOKENS` | `8192` | Fallback max tokens when Codex doesn't specify |
| `SESSION_TTL_MS` | `3600000` | How long to keep `previous_response_id` sessions (ms) |
| `DEBUG` | `false` | Log full request/response bodies |
| `OPENAI_BASE_URL` | *(derived)* | Override the OpenAI Chat Completions endpoint |
| `ANTHROPIC_BASE_URL` | *(derived)* | Override the Anthropic Messages endpoint |
| `GEMINI_BASE_URL` | *(derived)* | Override the Gemini endpoint |
| `CERT_PATH` / `KEY_PATH` / `CA_PATH` | — | Client TLS cert for mutual TLS environments |

### Backend URL derivation

When only `BACKEND_BASE_URL` is set, per-provider paths are derived automatically:

| Backend base | OpenAI path | Anthropic path | Gemini path |
|---|---|---|---|
| `https://api.openai.com` | `/v1` | — | — |
| `https://api.anthropic.com` | — | `/v1` | — |
| `https://generativelanguage.googleapis.com` | — | — | `/v1beta` |
| Any other (e.g. Ask Sage) | `/server/openai/v1` | `/server/anthropic/v1` | `/server/google/v1beta` |

For Ask Sage: set `BACKEND_BASE_URL=https://sage.ask-sage.ai` and `API_TOKEN=<your sage token>`. All three model families will route correctly through their respective Ask Sage endpoints.

---

## VS Code Extension

A self-contained VS Code extension is included in [`vscode-extension/`](vscode-extension/). It runs the proxy in-process (no separate terminal needed) with a status bar indicator, output channel, and settings UI.

### Install from VSIX

```bash
cd vscode-extension
npm install
npm run build
npm run package          # → codex-proxy-0.1.0.vsix
code --install-extension codex-proxy-0.1.0.vsix
```

### Features

- **Status bar** — shows `Proxy: 8080` (running) or `Proxy: Stopped`; click to open logs or start
- **Commands** (Command Palette → `Codex Proxy: …`): Start, Stop, Restart, Show Output, Copy Codex Environment Variables
- **Auto-start** on VS Code launch (configurable)
- **Auto-restart** when settings change

### Extension settings

All settings are under `codex-proxy.*` in VS Code settings:

| Setting | Default | Description |
|---|---|---|
| `apiToken` | — | Backend API token (stored as secret) |
| `backendBaseUrl` | `https://api.openai.com` | Same derivation logic as the standalone proxy |
| `port` | `8080` | Proxy listen port |
| `autoStart` | `true` | Start automatically when VS Code opens |
| `defaultMaxTokens` | `8192` | Fallback max tokens |
| `debug` | `false` | Verbose logging to Output channel |
| `openaiBaseUrl` / `anthropicBaseUrl` / `geminiBaseUrl` | *(derived)* | Per-provider endpoint overrides |

---

## Supported models (advertised to Codex)

The proxy returns this list from `GET /v1/models`:

| Model | Backend |
|---|---|
| `gpt-4o`, `gpt-4o-mini`, `o3`, `o4-mini` | OpenAI Chat Completions |
| `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` | Anthropic Messages |
| `gemini-2.0-flash`, `gemini-1.5-pro` | Google Gemini |

Any model name can be passed — the list above is only what Codex sees when enumerating models. Backend routing is determined by prefix matching at request time, so models not in this list still work (e.g. `claude-3-5-sonnet-20241022`).

---

## Project structure

```
codex-proxy/
├── src/
│   ├── server.ts          # Express HTTP server, request routing
│   ├── config.ts          # Env var config + model→backend detection
│   ├── session.ts         # In-memory store for previous_response_id chains
│   ├── types.ts           # All TypeScript types (Responses API, Chat, Anthropic, Gemini)
│   ├── utils.ts           # SSE parser, fetch helpers, logging
│   └── backends/
│       ├── openai.ts      # Responses API ↔ Chat Completions
│       ├── anthropic.ts   # Responses API ↔ Anthropic Messages
│       └── gemini.ts      # Responses API ↔ Gemini
└── vscode-extension/
    ├── src/
    │   ├── extension.ts   # VS Code activate/deactivate, commands, status bar
    │   └── proxy/         # Embedded proxy (mirrors src/ above, no Express)
    ├── esbuild.mjs        # Bundles everything into dist/extension.js (CJS)
    └── resources/
        └── icon.png
```
