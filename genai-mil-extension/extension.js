const vscode = require('vscode');
const https = require('https');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION: Known endpoints and their available models
// ═══════════════════════════════════════════════════════════════
const KNOWN_ENDPOINTS = {
    "https://api.genai.army.mil/server/query": {
        label: "Ask Sage Army (api.genai.army.mil)",
        baseUrl: "https://api.genai.army.mil",
        defaultModel: "gpt-4.1-gov",
        apiFormat: "asksage",
        authType: "x-access-tokens",
        models: [
            "gpt-4.1-gov",
            "gpt-4.1-mini-gov",
            "gpt-5.1-gov",
            "google-gemini-2.5-flash",
            "google-gemini-2.5-pro",
            "google-gemini-2.5-flash-image",
            "google-claude-45-sonnet",
            "google-claude-45-haiku",
            "google-claude-45-opus",
            "aws-bedrock-nova-pro-gov",
            "aws-bedrock-nova-micro-gov",
            "aws-bedrock-nova-lite-gov",
            "google-imagen-4",
            "google-veo-3-fast"
        ],
        modelsEndpoint: "/server/get-models"
    },
    "https://api.genai.mil/v1/chat/completions": {
        label: "GenAI.mil Chat Completions",
        baseUrl: "https://api.genai.mil",
        defaultModel: "gemini-2.5-flash",
        apiFormat: "openai",
        authType: "bearer",
        models: [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano",
            "o4-mini",
            "claude-sonnet-4",
            "claude-3.5-sonnet",
            "claude-3.5-haiku"
        ],
        modelsEndpoint: "/v1/models"
    },
    "https://api.asksage.ai/v1/chat/completions": {
        label: "Ask Sage Chat Completions",
        baseUrl: "https://api.asksage.ai",
        defaultModel: "gemini-2.5-flash",
        apiFormat: "openai",
        authType: "bearer",
        models: [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano",
            "o4-mini",
            "claude-sonnet-4",
            "claude-3.5-sonnet",
            "claude-3.5-haiku"
        ],
        modelsEndpoint: "/v1/models"
    }
};

// ═══════════════════════════════════════════════════════════════
// HELPER: Check if endpoint uses Ask Sage Army format
// ═══════════════════════════════════════════════════════════════
function isAskSageFormat(endpoint) {
    const normalized = (endpoint || '').trim().replace(/\/$/, '');
    for (const key in KNOWN_ENDPOINTS) {
        if (key.trim().replace(/\/$/, '') === normalized) {
            return KNOWN_ENDPOINTS[key].apiFormat === 'asksage';
        }
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Generate a secret storage key per endpoint
// ═══════════════════════════════════════════════════════════════
function getApiKeySecretName(endpoint) {
    try {
        const normalized = (endpoint || '').trim().replace(/\/$/, '');
        const url = new URL(normalized);
        return 'genai-mil.apiKey.' + url.hostname;
    } catch (e) {
        return 'genai-mil.apiKey.default';
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Get base URL from endpoint
// ═══════════════════════════════════════════════════════════════
function getBaseUrl(endpoint) {
    try {
        const url = new URL(endpoint);
        return url.protocol + '//' + url.hostname + (url.port ? ':' + url.port : '');
    } catch (e) {
        return endpoint;
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Get VS Code configuration
// ═══════════════════════════════════════════════════════════════
function getConfig() {
    const config = vscode.workspace.getConfiguration('genai-mil');
    return {
        endpoint:    (config.get('endpoint')    || '').trim(),
        model:       (config.get('model')       || '').trim(),
        pemPath:     (config.get('pemPath')     || '').trim(),
        authType:    (config.get('authType')    || 'bearer').trim(),
        temperature: config.get('temperature')  || 0.7,
        maxTokens:   config.get('maxTokens')    || 4096,
        update: function (key, value) {
            return config.update(key, value, true);
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Get effective auth type for endpoint
// ═══════════════════════════════════════════════════════════════
function getEffectiveAuthType(endpoint, configAuthType) {
    const known = KNOWN_ENDPOINTS[endpoint];
    if (known && known.authType) {
        return known.authType;
    }
    return configAuthType || 'bearer';
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Build auth headers based on auth type
// ═══════════════════════════════════════════════════════════════
function getAuthHeaders(apiKey, authType) {
    const headers = {
        'Content-Type': 'application/json'
    };
    switch (authType) {
        case 'api-key':
            headers['api-key'] = apiKey;
            break;
        case 'x-api-key':
            headers['x-api-key'] = apiKey;
            break;
        case 'x-access-tokens':
            headers['x-access-tokens'] = apiKey;
            break;
        case 'ANTHROPIC_AUTH_TOKEN':
            headers['ANTHROPIC_AUTH_TOKEN'] = apiKey;
            break;
        case 'basic':
            headers['Authorization'] = 'Basic ' + apiKey;
            break;
        case 'bearer':
        default:
            headers['Authorization'] = 'Bearer ' + apiKey;
            break;
    }
    return headers;
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Load DoD PEM certificate into HTTPS options
// Supports both explicit pemPath and NODE_EXTRA_CA_CERTS
// ═══════════════════════════════════════════════════════════════
function applyPemCert(options, pemPath) {
    if (pemPath) {
        try {
            options.ca = fs.readFileSync(pemPath);
            return;
        } catch (e) {
            console.warn('GenAI.mil: Could not read PEM file at ' + pemPath + ': ' + e.message);
        }
    }
    const envPem = process.env.NODE_EXTRA_CA_CERTS;
    if (envPem) {
        try {
            options.ca = fs.readFileSync(envPem);
            return;
        } catch (e) {
            console.warn('GenAI.mil: Could not read NODE_EXTRA_CA_CERTS at ' + envPem + ': ' + e.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Ask Sage Army API request (native)
// POST /server/query
// Headers: x-access-tokens
// Body: { model, message }
// ═══════════════════════════════════════════════════════════════
function askSageRequest(endpoint, apiKey, model, messages, onData, onDone, onError, pemPath) {
    let url;
    try {
        url = new URL(endpoint);
    } catch (e) {
        onError(new Error('Invalid endpoint URL: ' + endpoint));
        return;
    }

    // Build message body
    let system;
    const history = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            system = (system ? system + '\n' : '') + msg.content;
        } else if (msg.role === 'user') {
            history.push({ user: "me", message: msg.content });
        } else if (msg.role === 'assistant') {
            history.push({ user: "gpt", message: msg.content });
        }
    }
    let body;
    if (history.length === 1) {
        body = {
            model: model,
            message: history[0].message,
            limit_references: 0
        };
    } else {
        body = {
            model: model,
            message: history,
            limit_references: 0
        };
    }
    if (system) body.system_prompt = system;

    const payload = JSON.stringify(body);

    const headers = {
        'Content-Type': 'application/json',
        'x-access-tokens': apiKey.trim(),
        'Content-Length': Buffer.byteLength(payload)
    };

    const options = {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + (url.search || ''),
        method:   'POST',
        headers:  headers
    };

    applyPemCert(options, pemPath);

    const req = https.request(options, function (res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errorBody = '';
            res.on('data', function (chunk) { errorBody += chunk.toString(); });
            res.on('end', function () {
                let errorMsg = 'HTTP ' + res.statusCode + ': ';
                try {
                    const parsed = JSON.parse(errorBody);
                    errorMsg += parsed.message || parsed.error || parsed.detail || errorBody;
                } catch (e) {
                    errorMsg += errorBody || res.statusMessage;
                }
                onError(new Error(errorMsg));
            });
            return;
        }

        let body = '';
        res.on('data', function (chunk) { body += chunk.toString(); });
        res.on('end', function () {
            try {
                const parsed = JSON.parse(body);
                const responseText =
                    parsed.response ||
                    parsed.message  ||
                    parsed.content  ||
                    parsed.text     ||
                    parsed.answer   ||
                    parsed.output   ||
                    JSON.stringify(parsed);

                onData(responseText);
                onDone();

            } catch (e) {
                onError(new Error('Failed to parse Ask Sage response: ' + e.message + ' | Raw: ' + body));
            }
        });

        res.on('error', function (err) { onError(err); });
    });

    req.on('error', function (err) { onError(err); });
    req.setTimeout(120000, function () {
        req.destroy(new Error('Request timed out after 120 seconds'));
    });

    req.write(payload);
    req.end();
}

// ... (rest of your extension.js remains unchanged, including openAIStreamRequest, sendRequest, etc.)

// Make sure to update KNOWN_ENDPOINTS, getAuthHeaders, and askSageRequest as above.

module.exports = { activate, deactivate };