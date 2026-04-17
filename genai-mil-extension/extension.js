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
        authType: "x-api-key",
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
        modelsEndpoint: null
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
    const known = KNOWN_ENDPOINTS[endpoint];
    return known && known.apiFormat === 'asksage';
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Generate a secret storage key per endpoint
// ═══════════════════════════════════════════════════════════════
function getApiKeySecretName(endpoint) {
    try {
        const url = new URL(endpoint);
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
// HELPER: Make HTTPS GET request (for fetching models)
// ═══════════════════════════════════════════════════════════════
function httpsGet(endpoint, apiKey, authType, pemPath) {
    return new Promise(function (resolve, reject) {
        let url;
        try {
            url = new URL(endpoint);
        } catch (e) {
            reject(new Error('Invalid URL: ' + endpoint));
            return;
        }

        const headers = getAuthHeaders(apiKey, authType);
        delete headers['Content-Type'];

        const options = {
            hostname: url.hostname,
            port:     url.port || 443,
            path:     url.pathname + (url.search || ''),
            method:   'GET',
            headers:  headers
        };

        applyPemCert(options, pemPath);

        const req = https.request(options, function (res) {
            let body = '';
            res.on('data', function (chunk) { body += chunk.toString(); });
            res.on('end', function () {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('HTTP ' + res.statusCode + ': ' + body));
                } else {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                }
            });
        });

        req.on('error', function (err) { reject(err); });
        req.setTimeout(30000, function () {
            req.destroy(new Error('Request timed out'));
        });
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Ask Sage Army API request
// POST /server/query
// Body: { message: "...", model: "..." }
// Auth: x-api-key header
// Response: { response: "..." }
// ═══════════════════════════════════════════════════════════════
function askSageRequest(endpoint, apiKey, model, messages, onData, onDone, onError, pemPath) {
    let url;
    try {
        url = new URL(endpoint);
    } catch (e) {
        onError(new Error('Invalid endpoint URL: ' + endpoint));
        return;
    }

    // Build a single message string from the messages array
    // Ask Sage Army uses a flat { message, model } format
    let fullMessage = '';

    // Add system prompt context if present
    const systemMsg = messages.find(function (m) { return m.role === 'system'; });
    if (systemMsg) {
        fullMessage += systemMsg.content + '\n\n';
    }

    // Add conversation history as context, then the final user message
    const nonSystemMessages = messages.filter(function (m) { return m.role !== 'system'; });

    if (nonSystemMessages.length > 1) {
        // Include prior turns as context
        for (let i = 0; i < nonSystemMessages.length - 1; i++) {
            const m = nonSystemMessages[i];
            const prefix = m.role === 'user' ? 'User: ' : 'Assistant: ';
            fullMessage += prefix + m.content + '\n\n';
        }
        // Final user message
        const lastMsg = nonSystemMessages[nonSystemMessages.length - 1];
        fullMessage += lastMsg.content;
    } else if (nonSystemMessages.length === 1) {
        fullMessage += nonSystemMessages[0].content;
    }

    const payload = JSON.stringify({
        message: fullMessage.trim(),
        model:   model
    });

    console.log('GenAI.mil: Ask Sage Army request to ' + endpoint);
    console.log('GenAI.mil: Model: ' + model);
    console.log('GenAI.mil: Payload length: ' + payload.length);
    console.log('GenAI.mil: API Key length: ' + (apiKey ? apiKey.length : 0));
    console.log('GenAI.mil: API Key preview: ' + (apiKey ? apiKey.substring(0, 8) + '...' : 'MISSING'));

    const options = {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + (url.search || ''),
        method:   'POST',
        headers: {
            'Content-Type':   'application/json',
            'x-api-key':      apiKey.trim(),
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    applyPemCert(options, pemPath);

    const req = https.request(options, function (res) {
        console.log('GenAI.mil: Ask Sage Army response status: ' + res.statusCode);

        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errorBody = '';
            res.on('data', function (chunk) { errorBody += chunk.toString(); });
            res.on('end', function () {
                console.log('GenAI.mil: Error response body: ' + errorBody);
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
            console.log('GenAI.mil: Ask Sage Army raw response: ' + body);
            try {
                const parsed = JSON.parse(body);

                // Ask Sage returns { response: "text" }
                // Also handle alternate field names just in case
                const responseText =
                    parsed.response  ||
                    parsed.message   ||
                    parsed.content   ||
                    parsed.text      ||
                    parsed.answer    ||
                    parsed.output    ||
                    JSON.stringify(parsed);

                onData(responseText);
                onDone();

            } catch (e) {
                console.log('GenAI.mil: Failed to parse response: ' + e.message);
                onError(new Error('Failed to parse Ask Sage response: ' + e.message + ' | Raw: ' + body));
            }
        });

        res.on('error', function (err) { onError(err); });
    });

    req.on('error', function (err) {
        console.log('GenAI.mil: Request error: ' + err.message);
        onError(err);
    });

    req.setTimeout(120000, function () {
        req.destroy(new Error('Request timed out after 120 seconds'));
    });

    req.write(payload);
    req.end();
}

// ═══════════════════════════════════════════════════════════════
// HELPER: OpenAI-compatible streaming request
// ═══════════════════════════════════════════════════════════════
function openAIStreamRequest(endpoint, apiKey, model, messages, onData, onDone, onError, pemPath, authType, temperature, maxTokens) {
    let url;
    try {
        url = new URL(endpoint);
    } catch (e) {
        onError(new Error('Invalid endpoint URL: ' + endpoint));
        return;
    }

    const payload = JSON.stringify({
        model:       model,
        messages:    messages,
        stream:      true,
        temperature: temperature,
        max_tokens:  maxTokens
    });

    const headers = getAuthHeaders(apiKey, authType);
    headers['Content-Length'] = Buffer.byteLength(payload);

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
                    if (parsed.error && parsed.error.message) {
                        errorMsg += parsed.error.message;
                    } else {
                        errorMsg += errorBody;
                    }
                } catch (e) {
                    errorMsg += errorBody || res.statusMessage;
                }
                onError(new Error(errorMsg));
            });
            return;
        }

        let buffer = '';

        res.on('data', function (chunk) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') { continue; }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.choices &&
                            parsed.choices[0] &&
                            parsed.choices[0].delta &&
                            parsed.choices[0].delta.content) {
                            onData(parsed.choices[0].delta.content);
                        }
                    } catch (e) {
                        // Skip invalid JSON chunks
                    }
                }
            }
        });

        res.on('end',   function () { onDone(); });
        res.on('error', function (err) { onError(err); });
    });

    req.on('error', function (err) { onError(err); });
    req.setTimeout(120000, function () {
        req.destroy(new Error('Request timed out after 120 seconds'));
    });

    req.write(payload);
    req.end();
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Unified request router
// ═══════════════════════════════════════════════════════════════
function sendRequest(endpoint, apiKey, model, messages, onData, onDone, onError, pemPath, authType, temperature, maxTokens) {
    if (isAskSageFormat(endpoint)) {
        askSageRequest(
            endpoint, apiKey, model, messages,
            onData, onDone, onError, pemPath
        );
    } else {
        openAIStreamRequest(
            endpoint, apiKey, model, messages,
            onData, onDone, onError,
            pemPath, authType, temperature, maxTokens
        );
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Write file to workspace or prompt save dialog
// ═══════════════════════════════════════════════════════════════
async function writeFileToWorkspace(filename, content, openBeside) {
    const encoder = new TextEncoder();

    if (vscode.workspace.workspaceFolders) {
        const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(workspaceUri, filename);

        let fileExists = false;
        try {
            await vscode.workspace.fs.stat(fileUri);
            fileExists = true;
        } catch (e) {
            fileExists = false;
        }

        if (fileExists) {
            const overwrite = await vscode.window.showWarningMessage(
                'File "' + filename + '" already exists. Overwrite?',
                'Yes', 'No'
            );
            if (overwrite !== 'Yes') { return false; }
        }

        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
        vscode.window.showInformationMessage('File created: ' + filename);

        if (openBeside) {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }

        return true;

    } else {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(filename),
            saveLabel:  'Save File'
        });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
            vscode.window.showInformationMessage('File saved: ' + uri.fsPath);
            if (openBeside) {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
            return true;
        }
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Edit existing file or create if not found
// ═══════════════════════════════════════════════════════════════
async function editFileInWorkspace(filename, content) {
    if (!vscode.workspace.workspaceFolders) {
        vscode.window.showErrorMessage('Open a workspace folder first to edit files.');
        return false;
    }

    const wsUri   = vscode.workspace.workspaceFolders[0].uri;
    const fileUri = vscode.Uri.joinPath(wsUri, filename);

    try {
        const doc    = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

        const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
        );

        await editor.edit(function (editBuilder) {
            editBuilder.replace(fullRange, content);
        });

        vscode.window.showInformationMessage('File updated: ' + filename);
        return true;

    } catch (e) {
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage('File created: ' + filename);
        return true;
    }
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = {
    role: 'system',
    content: 'You are a helpful coding assistant inside VS Code. ' +
        'When the user asks you to create or edit a file, respond with the full file content wrapped in a code block. ' +
        'Always include the filename on the first line of the code block like this:\n' +
        '```language:path/to/filename.ext\n' +
        'code here\n' +
        '```\n' +
        'If editing an existing file, include the complete updated file content. ' +
        'Always provide complete, working code.'
};

// ═══════════════════════════════════════════════════════════════
// ACTIVATION
// ═══════════════════════════════════════════════════════════════
function activate(context) {
    console.log('GenAI.mil extension is now active');

    const secretStorage = context.secrets;
    let activeChatPanel = null;

    // ─────────────────────────────────────────────
    // COMMAND: Set API Key (per endpoint)
    // ─────────────────────────────────────────────
    const setApiKeyCommand = vscode.commands.registerCommand('genai-mil.setApiKey', async function () {
        const config = getConfig();

        const items = [];
        for (const url in KNOWN_ENDPOINTS) {
            items.push({
                label:       KNOWN_ENDPOINTS[url].label,
                description: url,
                value:       url
            });
        }
        if (config.endpoint && !KNOWN_ENDPOINTS[config.endpoint]) {
            items.unshift({
                label:       'Current Endpoint',
                description: config.endpoint,
                value:       config.endpoint
            });
        }
        items.push({
            label:       '✏️ Enter Custom Endpoint URL',
            description: 'Set key for a different endpoint',
            value:       '__custom__'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Which endpoint is this API key for?'
        });

        if (!selected) { return; }

        let targetEndpoint = selected.value;

        if (targetEndpoint === '__custom__') {
            targetEndpoint = await vscode.window.showInputBox({
                prompt:         'Enter the endpoint URL this API key is for',
                placeHolder:    'https://your-api.example.com/v1/chat/completions',
                ignoreFocusOut: true,
                validateInput:  function (value) {
                    try { new URL(value); return null; }
                    catch (e) { return 'Please enter a valid URL'; }
                }
            });
            if (!targetEndpoint) { return; }
        }

        const apiKey = await vscode.window.showInputBox({
            prompt:         'Enter the API Key for ' + targetEndpoint,
            password:       true,
            placeHolder:    'YOUR_API_KEY',
            ignoreFocusOut: true
        });

        if (apiKey) {
            const trimmedKey = apiKey.trim();
            const secretName = getApiKeySecretName(targetEndpoint);
            await secretStorage.store(secretName, trimmedKey);

            let hostname = '';
            try { hostname = new URL(targetEndpoint).hostname; }
            catch (e) { hostname = targetEndpoint; }

            vscode.window.showInformationMessage(
                'API Key saved securely for ' + hostname +
                ' (' + trimmedKey.length + ' chars). Stored in OS credential manager.'
            );
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Delete API Key
    // ─────────────────────────────────────────────
    const deleteApiKeyCommand = vscode.commands.registerCommand('genai-mil.deleteApiKey', async function () {
        const config = getConfig();

        const items = [];
        for (const url in KNOWN_ENDPOINTS) {
            items.push({
                label:       KNOWN_ENDPOINTS[url].label,
                description: url,
                value:       url
            });
        }
        if (config.endpoint && !KNOWN_ENDPOINTS[config.endpoint]) {
            items.unshift({
                label:       'Current Endpoint',
                description: config.endpoint,
                value:       config.endpoint
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Delete API key for which endpoint?'
        });

        if (!selected) { return; }

        const confirm = await vscode.window.showWarningMessage(
            'Delete API key for ' + selected.description + '?',
            'Yes', 'No'
        );

        if (confirm === 'Yes') {
            const secretName = getApiKeySecretName(selected.value);
            await secretStorage.delete(secretName);
            vscode.window.showInformationMessage('API Key deleted for ' + selected.description);
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Select Endpoint
    // ─────────────────────────────────────────────
    const selectEndpointCommand = vscode.commands.registerCommand('genai-mil.selectEndpoint', async function () {
        const items = [];
        for (const url in KNOWN_ENDPOINTS) {
            const known = KNOWN_ENDPOINTS[url];
            items.push({
                label:       known.label,
                description: url,
                detail:      known.apiFormat === 'asksage'
                    ? '🏛️ Ask Sage Army Format | Auth: ' + known.authType
                    : '🔵 OpenAI Compatible | Auth: ' + known.authType,
                value:       url
            });
        }
        items.push({
            label:       '✏️ Enter Custom Endpoint',
            description: 'Type in a custom API URL',
            value:       '__custom__'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select API Endpoint'
        });

        if (!selected) { return; }

        let endpointUrl = selected.value;

        if (endpointUrl === '__custom__') {
            endpointUrl = await vscode.window.showInputBox({
                prompt:         'Enter the full API endpoint URL',
                placeHolder:    'https://your-api.example.com/v1/chat/completions',
                ignoreFocusOut: true,
                validateInput:  function (value) {
                    try { new URL(value); return null; }
                    catch (e) { return 'Please enter a valid URL'; }
                }
            });
            if (!endpointUrl) { return; }
        }

        const config = getConfig();
        await config.update('endpoint', endpointUrl);

        const known = KNOWN_ENDPOINTS[endpointUrl];
        if (known) {
            if (known.authType) {
                await config.update('authType', known.authType);
            }
            if (known.defaultModel) {
                await config.update('model', known.defaultModel);
                vscode.window.showInformationMessage(
                    'Endpoint: ' + known.label +
                    ' | Model: ' + known.defaultModel +
                    ' | Auth: ' + (known.authType || 'bearer')
                );
            }
        } else {
            const modelName = await vscode.window.showInputBox({
                prompt:         'Enter the model name for this endpoint',
                placeHolder:    'e.g., gpt-4o, gemini-2.5-flash',
                ignoreFocusOut: true
            });
            if (modelName) {
                await config.update('model', modelName.trim());
                vscode.window.showInformationMessage(
                    'Endpoint: ' + endpointUrl + ' | Model: ' + modelName.trim()
                );
            }
        }

        const secretName  = getApiKeySecretName(endpointUrl);
        const existingKey = await secretStorage.get(secretName);
        if (!existingKey) {
            const setKey = await vscode.window.showWarningMessage(
                'No API key found for this endpoint. Set one now?',
                'Yes', 'Later'
            );
            if (setKey === 'Yes') {
                await vscode.commands.executeCommand('genai-mil.setApiKey');
            }
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Select Model
    // ─────────────────────────────────────────────
    const selectModelCommand = vscode.commands.registerCommand('genai-mil.selectModel', async function () {
        const config = getConfig();
        const known  = KNOWN_ENDPOINTS[config.endpoint];

        if (known && known.models && known.models.length > 0) {
            const items = known.models.map(function (m) {
                return {
                    label:       m,
                    description: m === known.defaultModel ? '(default)' : ''
                };
            });

            if (known.modelsEndpoint) {
                items.push({
                    label:       '🔄 Fetch Models from API',
                    description: 'Query the API for available models'
                });
            }

            items.push({
                label:       '✏️ Enter Custom Model',
                description: 'Type in a custom model name'
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a model for ' + (known.label || config.endpoint)
            });

            if (!selected) { return; }

            if (selected.label === '🔄 Fetch Models from API') {
                await vscode.commands.executeCommand('genai-mil.fetchModels');
                return;
            }

            if (selected.label === '✏️ Enter Custom Model') {
                const customModel = await vscode.window.showInputBox({
                    prompt:         'Enter the model name',
                    placeHolder:    'e.g., gpt-4o, gemini-2.5-flash',
                    ignoreFocusOut: true
                });
                if (customModel) {
                    await config.update('model', customModel.trim());
                    vscode.window.showInformationMessage('Model set to: ' + customModel.trim());
                }
            } else {
                await config.update('model', selected.label);
                vscode.window.showInformationMessage('Model set to: ' + selected.label);
            }

        } else {
            const customModel = await vscode.window.showInputBox({
                prompt:         'Enter the model name for ' + config.endpoint,
                placeHolder:    'e.g., gpt-4o, gemini-2.5-flash',
                value:          config.model,
                ignoreFocusOut: true
            });
            if (customModel) {
                await config.update('model', customModel.trim());
                vscode.window.showInformationMessage('Model set to: ' + customModel.trim());
            }
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Fetch Available Models from API
    // ─────────────────────────────────────────────
    const fetchModelsCommand = vscode.commands.registerCommand('genai-mil.fetchModels', async function () {
        const config     = getConfig();
        const known      = KNOWN_ENDPOINTS[config.endpoint];
        const secretName = getApiKeySecretName(config.endpoint);
        const apiKey     = await secretStorage.get(secretName);

        if (!apiKey) {
            vscode.window.showErrorMessage('No API key found. Set one first with "GenAI.mil: Set API Key".');
            return;
        }

        // Ask Sage Army does not have a /models endpoint
        if (isAskSageFormat(config.endpoint)) {
            vscode.window.showInformationMessage(
                'Ask Sage Army does not expose a /models endpoint. Using pre-configured model list.'
            );
            await vscode.commands.executeCommand('genai-mil.selectModel');
            return;
        }

        const baseUrl    = getBaseUrl(config.endpoint);
        const modelsPath = (known && known.modelsEndpoint) ? known.modelsEndpoint : '/v1/models';
        const modelsUrl  = baseUrl + modelsPath;
        const authType   = getEffectiveAuthType(config.endpoint, config.authType);

        try {
            vscode.window.showInformationMessage('Fetching models from ' + modelsUrl + '...');

            const response = await httpsGet(modelsUrl, apiKey, authType, config.pemPath);

            let models = [];
            if (response && response.data && Array.isArray(response.data)) {
                models = response.data.map(function (m) {
                    return {
                        label:       m.id || m.name || m,
                        description: m.owned_by ? 'by ' + m.owned_by : ''
                    };
                });
            } else if (Array.isArray(response)) {
                models = response.map(function (m) {
                    return {
                        label:       typeof m === 'string' ? m : (m.id || m.name || JSON.stringify(m)),
                        description: ''
                    };
                });
            }

            if (models.length === 0) {
                vscode.window.showWarningMessage('No models returned from the API.');
                return;
            }

            const selected = await vscode.window.showQuickPick(models, {
                placeHolder: 'Select a model (' + models.length + ' available)'
            });

            if (selected) {
                await config.update('model', selected.label);
                vscode.window.showInformationMessage('Model set to: ' + selected.label);
            }

        } catch (error) {
            vscode.window.showErrorMessage('Failed to fetch models: ' + error.message);
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Set Auth Type
    // ─────────────────────────────────────────────
    const setAuthTypeCommand = vscode.commands.registerCommand('genai-mil.setAuthType', async function () {
        const selected = await vscode.window.showQuickPick([
            { label: 'Bearer Token',     description: 'Authorization: Bearer YOUR_KEY (default)',      value: 'bearer'    },
            { label: 'API Key Header',   description: 'api-key: YOUR_KEY',                             value: 'api-key'   },
            { label: 'X-API-Key Header', description: 'x-api-key: YOUR_KEY (Ask Sage Army)',           value: 'x-api-key' },
            { label: 'Basic Auth',       description: 'Authorization: Basic YOUR_KEY',                 value: 'basic'     }
        ], {
            placeHolder: 'Select authentication type'
        });

        if (selected) {
            const config = getConfig();
            await config.update('authType', selected.value);
            vscode.window.showInformationMessage('Auth type set to: ' + selected.label);
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Set PEM Certificate
    // ─────────────────────────────────────────────
    const setPemCertCommand = vscode.commands.registerCommand('genai-mil.setPemCert', async function () {
        const action = await vscode.window.showQuickPick([
            { label: '📂 Browse for PEM file',         value: 'browse' },
            { label: '🌐 Use NODE_EXTRA_CA_CERTS env',  value: 'env'    },
            { label: '🗑️ Clear PEM certificate',        value: 'clear'  }
        ], {
            placeHolder: 'Set or clear PEM certificate'
        });

        if (!action) { return; }

        const config = getConfig();

        if (action.value === 'clear') {
            await config.update('pemPath', '');
            vscode.window.showInformationMessage(
                'PEM Certificate cleared. Will use NODE_EXTRA_CA_CERTS if set.'
            );
            return;
        }

        if (action.value === 'env') {
            const envPath = process.env.NODE_EXTRA_CA_CERTS;
            if (envPath) {
                vscode.window.showInformationMessage(
                    'NODE_EXTRA_CA_CERTS is set to: ' + envPath +
                    '. The extension will use this automatically.'
                );
            } else {
                vscode.window.showWarningMessage(
                    'NODE_EXTRA_CA_CERTS is not set. ' +
                    'Set it in Windows User Environment Variables and restart VSCode.'
                );
            }
            return;
        }

        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles:   true,
            canSelectFolders: false,
            canSelectMany:    false,
            filters: {
                'PEM Certificate': ['pem', 'crt', 'cer'],
                'All Files':       ['*']
            },
            openLabel: 'Select PEM Certificate'
        });

        if (fileUri && fileUri[0]) {
            const pemPath = fileUri[0].fsPath;
            try {
                fs.accessSync(pemPath, fs.constants.R_OK);
                await config.update('pemPath', pemPath);
                vscode.window.showInformationMessage('PEM Certificate set: ' + pemPath);
            } catch (e) {
                vscode.window.showErrorMessage('Cannot read PEM file: ' + pemPath);
            }
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Show Current Settings
    // ─────────────────────────────────────────────
    const showSettingsCommand = vscode.commands.registerCommand('genai-mil.showSettings', async function () {
        const config     = getConfig();
        const known      = KNOWN_ENDPOINTS[config.endpoint];
        const secretName = getApiKeySecretName(config.endpoint);
        const apiKey     = await secretStorage.get(secretName);
        const authType   = getEffectiveAuthType(config.endpoint, config.authType);
        const envPem     = process.env.NODE_EXTRA_CA_CERTS;

        let hostname = '';
        try { hostname = new URL(config.endpoint).hostname; }
        catch (e) { hostname = config.endpoint; }

        const info = [
            '═══ GenAI.mil Extension Settings ═══',
            'Endpoint:    ' + (config.endpoint || 'Not set'),
            'Format:      ' + (known ? known.apiFormat.toUpperCase() : 'Unknown/Custom'),
            'Model:       ' + (config.model    || 'Not set'),
            'Auth Type:   ' + authType,
            'Temperature: ' + config.temperature,
            'Max Tokens:  ' + config.maxTokens,
            '',
            '═══ Security ═══',
            'API Key (' + hostname + '): ' + (apiKey
                ? '****' + apiKey.slice(-4) + ' (' + apiKey.length + ' chars)'
                : 'Not set'),
            'Key Storage:         OS Credential Manager (encrypted)',
            'PEM Cert:            ' + (config.pemPath || 'Not set'),
            'NODE_EXTRA_CA_CERTS: ' + (envPem || 'Not set')
        ].join('\n');

        vscode.window.showInformationMessage(info, { modal: true });
    });

    // ─────────────────────────────────────────────
    // COMMAND: Open Chat
    // ─────────────────────────────────────────────
    const openChatCommand = vscode.commands.registerCommand('genai-mil.openChat', function () {
        if (activeChatPanel) {
            activeChatPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'genaiMilChat',
            'GenAI.mil Chat',
            vscode.ViewColumn.One,
            {
                enableScripts:           true,
                retainContextWhenHidden: true,
                localResourceRoots:      []
            }
        );

        activeChatPanel = panel;
        let chatHistory = [];

        function refreshWebview(loading) {
            const config = getConfig();
            panel.webview.html = getWebviewContent(chatHistory, loading, config);
        }

        refreshWebview(false);

        panel.onDidDispose(function () {
            activeChatPanel = null;
        });

        panel.webview.onDidReceiveMessage(async function (message) {
            const config     = getConfig();
            const secretName = getApiKeySecretName(config.endpoint);
            const apiKey     = await secretStorage.get(secretName);
            const authType   = getEffectiveAuthType(config.endpoint, config.authType);

            if (message.command === 'clearChat') {
                chatHistory = [];
                refreshWebview(false);
                return;
            }

            if (message.command === 'changeModel') {
                await vscode.commands.executeCommand('genai-mil.selectModel');
                refreshWebview(false);
                return;
            }

            if (message.command === 'changeEndpoint') {
                await vscode.commands.executeCommand('genai-mil.selectEndpoint');
                refreshWebview(false);
                return;
            }

            if (message.command === 'fetchModels') {
                await vscode.commands.executeCommand('genai-mil.fetchModels');
                refreshWebview(false);
                return;
            }

            if (message.command === 'send') {
                if (!apiKey) {
                    vscode.window.showErrorMessage(
                        'No API key found for this endpoint. Run "GenAI.mil: Set API Key" first.'
                    );
                    return;
                }
                if (!config.endpoint) {
                    vscode.window.showErrorMessage('Endpoint not set. Run "GenAI.mil: Select Endpoint" first.');
                    return;
                }
                if (!config.model) {
                    vscode.window.showErrorMessage('Model not set. Run "GenAI.mil: Select Model" first.');
                    return;
                }

                const userMessage = message.text;
                chatHistory.push({ role: 'user', content: userMessage });
                refreshWebview(true);

                const apiMessages = [SYSTEM_PROMPT].concat(chatHistory);
                let aiMessage = '';

                sendRequest(
                    config.endpoint,
                    apiKey,
                    config.model,
                    apiMessages,
                    function (content) {
                        aiMessage += content;
                        panel.webview.postMessage({ command: 'stream', text: aiMessage });
                    },
                    function () {
                        chatHistory.push({ role: 'assistant', content: aiMessage });
                        refreshWebview(false);
                    },
                    function (error) {
                        chatHistory.push({ role: 'assistant', content: '❌ Error: ' + error.message });
                        refreshWebview(false);
                        vscode.window.showErrorMessage('GenAI.mil Error: ' + error.message);
                    },
                    config.pemPath,
                    authType,
                    config.temperature,
                    config.maxTokens
                );
            }

            if (message.command === 'createFile') {
                await writeFileToWorkspace(message.filename, message.content, true);
            }

            if (message.command === 'editFile') {
                await editFileInWorkspace(message.filename, message.content);
            }

            if (message.command === 'insertAtCursor') {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    await activeEditor.edit(function (editBuilder) {
                        editBuilder.insert(activeEditor.selection.active, message.content);
                    });
                    vscode.window.showInformationMessage('Code inserted at cursor');
                } else {
                    vscode.window.showErrorMessage('No active editor. Open a file first.');
                }
            }

            if (message.command === 'saveChat') {
                let chatContent = '';
                for (let j = 0; j < chatHistory.length; j++) {
                    const who = chatHistory[j].role === 'user' ? '## You' : '## GenAI';
                    chatContent += who + '\n\n' + chatHistory[j].content + '\n\n---\n\n';
                }

                const defaultSaveUri = vscode.workspace.workspaceFolders
                    ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'chat-history.md')
                    : undefined;

                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: defaultSaveUri,
                    saveLabel:  'Save Chat History',
                    filters: {
                        'Markdown': ['md'],
                        'Text':     ['txt']
                    }
                });

                if (saveUri) {
                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(saveUri, encoder.encode(chatContent));
                    vscode.window.showInformationMessage('Chat saved to ' + saveUri.fsPath);
                }
            }

            // ─────────────────────────────────────────────
            // DEBUG COMMAND: Show API key info in console
            // ─────────────────────────────────────────────
            if (message.command === 'debugApiKey') {
                const debugKey = await secretStorage.get(getApiKeySecretName(config.endpoint));
                console.log('GenAI.mil DEBUG:');
                console.log('  Endpoint:      ' + config.endpoint);
                console.log('  Model:         ' + config.model);
                console.log('  Auth Type:     ' + authType);
                console.log('  API Key set:   ' + (debugKey ? 'YES' : 'NO'));
                console.log('  API Key len:   ' + (debugKey ? debugKey.length : 0));
                console.log('  API Key start: ' + (debugKey ? debugKey.substring(0, 8) + '...' : 'N/A'));
                console.log('  PEM Path:      ' + config.pemPath);
                console.log('  NODE_EXTRA_CA: ' + (process.env.NODE_EXTRA_CA_CERTS || 'Not set'));
                vscode.window.showInformationMessage(
                    'Debug info logged to console (Help > Toggle Developer Tools > Console)'
                );
            }
        });
    });

    // ─────────────────────────────────────────────
    // STATUS BAR BUTTON
    // ─────────────────────────────────────────────
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.text    = '$(comment-discussion) GenAI Chat';
    statusBarItem.tooltip = 'Open GenAI.mil Chat';
    statusBarItem.command = 'genai-mil.openChat';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        setApiKeyCommand,
        deleteApiKeyCommand,
        selectEndpointCommand,
        selectModelCommand,
        fetchModelsCommand,
        setAuthTypeCommand,
        setPemCertCommand,
        showSettingsCommand,
        openChatCommand
    );
}

// ═══════════════════════════════════════════════════════════════
// WEBVIEW HTML
// ═══════════════════════════════════════════════════════════════
function getWebviewContent(chatHistory, loading, config) {
    let chatHtml = '';

    for (let i = 0; i < chatHistory.length; i++) {
        const msg    = chatHistory[i];
        const isUser = msg.role === 'user';
        const who    = isUser ? 'You' : 'GenAI';
        const icon   = isUser ? '👤' : '🤖';
        const msgClass = isUser ? 'message user-message' : 'message ai-message';

        let content = escapeHtml(msg.content);

        // Parse code blocks with filename
        content = content.replace(
            /```(\w+):([^\n]+)\n([\s\S]*?)```/g,
            function (match, lang, filename, code) {
                const safeFilename = filename.trim();
                return '<div class="code-block">' +
                    '<div class="code-header">' +
                    '<span>📄 ' + safeFilename + ' (' + lang + ')</span>' +
                    '<div class="code-actions">' +
                    '<button class="code-btn" data-filename="' + safeFilename + '" data-action="create">💾 Create File</button>' +
                    '<button class="code-btn" data-filename="' + safeFilename + '" data-action="edit">✏️ Apply Edit</button>' +
                    '<button class="code-btn" data-action="insert">📋 Insert at Cursor</button>' +
                    '</div></div>' +
                    '<pre><code>' + code + '</code></pre>' +
                    '</div>';
            }
        );

        // Parse regular code blocks
        content = content.replace(
            /```(\w*)\n([\s\S]*?)```/g,
            function (match, lang, code) {
                return '<div class="code-block">' +
                    '<div class="code-header">' +
                    '<span>Code' + (lang ? ' (' + lang + ')' : '') + '</span>' +
                    '<div class="code-actions">' +
                    '<button class="code-btn" data-action="insert">📋 Insert at Cursor</button>' +
                    '</div></div>' +
                    '<pre><code>' + code + '</code></pre>' +
                    '</div>';
            }
        );

        // Inline code
        content = content.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

        // Newlines
        content = content.replace(/\n/g, '<br>');

        chatHtml += '<div class="' + msgClass + '">' +
            '<b>' + icon + ' ' + who + ':</b><br>' + content +
            '</div>';
    }

    if (loading) {
        chatHtml += '<div class="message loading"><em>⏳ GenAI is thinking...</em></div>';
    }

    const known          = KNOWN_ENDPOINTS[config.endpoint];
    const statusEndpoint = known ? known.label : (config.endpoint || 'Not set');
    const statusModel    = config.model    || 'Not set';
    const statusFormat   = known
        ? (known.apiFormat === 'asksage' ? '🏛️ Ask Sage Army' : '🔵 OpenAI')
        : '❓ Custom';
    const certStatus     = process.env.NODE_EXTRA_CA_CERTS
        ? '🔒 DoD Cert ✅'
        : (config.pemPath ? '🔒 PEM Set ✅' : '⚠️ No Cert');

    return '<!DOCTYPE html>' +
        '<html lang="en"><head><meta charset="UTF-8"><style>' +
        'body{font-family:var(--vscode-font-family,"Segoe UI",Arial,sans-serif);' +
        'font-size:var(--vscode-font-size,13px);margin:0;padding:0;' +
        'background:var(--vscode-editor-background,#1e1e1e);' +
        'color:var(--vscode-editor-foreground,#cccccc);}' +
        '.container{display:flex;flex-direction:column;height:100vh;padding:12px;box-sizing:border-box;}' +
        'h2{margin:0 0 4px 0;color:var(--vscode-textLink-foreground,#3794ff);font-size:16px;}' +
        '.status-bar{font-size:11px;color:var(--vscode-descriptionForeground,#999);' +
        'margin-bottom:8px;padding:6px 8px;' +
        'background:var(--vscode-sideBar-background,#252526);' +
        'border:1px solid var(--vscode-widget-border,#454545);border-radius:4px;' +
        'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;}' +
        '.status-info{display:flex;gap:12px;flex-wrap:wrap;align-items:center;}' +
        '.status-actions{display:flex;gap:4px;flex-wrap:wrap;}' +
        '.status-btn{padding:2px 8px;font-size:11px;cursor:pointer;' +
        'border:1px solid var(--vscode-button-border,#454545);border-radius:3px;' +
        'background:var(--vscode-button-secondaryBackground,#3a3d41);' +
        'color:var(--vscode-button-secondaryForeground,#cccccc);}' +
        '.status-btn:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e);}' +
        '.toolbar{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;}' +
        '.toolbar button{padding:4px 10px;font-size:12px;cursor:pointer;' +
        'border:1px solid var(--vscode-button-border,#454545);border-radius:4px;' +
        'background:var(--vscode-button-secondaryBackground,#3a3d41);' +
        'color:var(--vscode-button-secondaryForeground,#cccccc);}' +
        '.toolbar button:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e);}' +
        '#chat{flex:1;overflow-y:auto;' +
        'border:1px solid var(--vscode-widget-border,#454545);border-radius:6px;' +
        'padding:10px;background:var(--vscode-editor-background,#1e1e1e);margin-bottom:8px;}' +
        '.message{margin-bottom:10px;padding:10px;border-radius:6px;word-wrap:break-word;}' +
        '.user-message{background:var(--vscode-textBlockQuote-background,#2a2d2e);' +
        'border-left:4px solid var(--vscode-textLink-foreground,#3794ff);}' +
        '.ai-message{background:var(--vscode-editor-inactiveSelectionBackground,#3a3d41);' +
        'border-left:4px solid var(--vscode-terminal-ansiGreen,#4caf50);}' +
        '.loading{background:var(--vscode-inputValidation-warningBackground,#352a05)!important;' +
        'border-left:4px solid var(--vscode-inputValidation-warningBorder,#ff9800)!important;}' +
        '.code-block{background:var(--vscode-textCodeBlock-background,#0a0a0a);' +
        'color:var(--vscode-editor-foreground,#d4d4d4);border-radius:6px;margin:8px 0;' +
        'overflow:hidden;border:1px solid var(--vscode-widget-border,#454545);}' +
        '.code-header{background:var(--vscode-editorGroupHeader-tabsBackground,#252526);' +
        'color:var(--vscode-foreground,#cccccc);padding:6px 10px;' +
        'display:flex;align-items:center;justify-content:space-between;font-size:12px;' +
        'flex-wrap:wrap;gap:6px;}' +
        '.code-actions{display:flex;gap:4px;flex-wrap:wrap;}' +
        '.code-btn{padding:3px 8px;font-size:11px;cursor:pointer;' +
        'border:1px solid var(--vscode-button-border,#454545);border-radius:3px;' +
        'background:var(--vscode-button-secondaryBackground,#3a3d41);' +
        'color:var(--vscode-button-secondaryForeground,#cccccc);}' +
        '.code-btn:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e);}' +
        'pre{margin:0;padding:12px;overflow-x:auto;font-size:13px;}' +
        'code{font-family:var(--vscode-editor-font-family,"Consolas","Courier New",monospace);' +
        'font-size:var(--vscode-editor-font-size,13px);}' +
        '.inline-code{background:var(--vscode-textCodeBlock-background,#0a0a0a);' +
        'padding:2px 5px;border-radius:3px;font-size:13px;}' +
        '#form{display:flex;gap:8px;}' +
        '#input{flex:1;padding:10px;font-size:14px;' +
        'border:1px solid var(--vscode-input-border,#454545);border-radius:6px;outline:none;' +
        'background:var(--vscode-input-background,#3c3c3c);' +
        'color:var(--vscode-input-foreground,#cccccc);}' +
        '#input:focus{border-color:var(--vscode-focusBorder,#007fd4);}' +
        '#input::placeholder{color:var(--vscode-input-placeholderForeground,#999);}' +
        '#form button{padding:10px 20px;font-size:14px;cursor:pointer;' +
        'border:none;border-radius:6px;' +
        'background:var(--vscode-button-background,#0e639c);' +
        'color:var(--vscode-button-foreground,#ffffff);}' +
        '#form button:hover{background:var(--vscode-button-hoverBackground,#1177bb);}' +
        '.empty-state{color:var(--vscode-descriptionForeground,#999);' +
        'text-align:center;padding:40px;font-size:14px;}' +
        '#chat::-webkit-scrollbar{width:10px;}' +
        '#chat::-webkit-scrollbar-track{background:transparent;}' +
        '#chat::-webkit-scrollbar-thumb{' +
        'background:var(--vscode-scrollbarSlider-background,#79797966);border-radius:5px;}' +
        '#chat::-webkit-scrollbar-thumb:hover{' +
        'background:var(--vscode-scrollbarSlider-hoverBackground,#646464b3);}' +
        '</style></head><body>' +
        '<div class="container">' +
        '<h2>🤖 GenAI.mil Chat</h2>' +
        '<div class="status-bar">' +
        '<div class="status-info">' +
        '<span>🌐 ' + escapeHtml(statusEndpoint) + '</span>' +
        '<span>🤖 ' + escapeHtml(statusModel) + '</span>' +
        '<span>' + statusFormat + '</span>' +
        '<span>' + certStatus + '</span>' +
        '</div>' +
        '<div class="status-actions">' +
        '<button class="status-btn" id="changeModelBtn">Change Model</button>' +
        '<button class="status-btn" id="fetchModelsBtn">Fetch Models</button>' +
        '<button class="status-btn" id="changeEndpointBtn">Change Endpoint</button>' +
        '</div></div>' +
        '<div class="toolbar">' +
        '<button id="saveChatBtn">💾 Save Chat</button>' +
        '<button id="clearChatBtn">🗑️ Clear Chat</button>' +
        '<button id="debugBtn">🔍 Debug API Key</button>' +
        '</div>' +
        '<div id="chat">' +
        (chatHtml || '<div class="empty-state">' +
            'Start a conversation...<br><br>' +
            '🏛️ <b>Ask Sage Army</b>: api.genai.army.mil<br>' +
            '🔵 <b>GenAI.mil</b>: api.genai.mil<br><br>' +
            'Try: "Create a Python script called hello.py that prints Hello World"<br><br>' +
            '<a href="https://docs.genai.army.mil/docs/api-documentation/api-endpoints.html" ' +
            'style="color:var(--vscode-textLink-foreground,#3794ff);">📖 API Documentation</a>' +
            '</div>') +
        '</div>' +
        '<form id="form">' +
        '<input id="input" type="text" ' +
        'placeholder="Ask me to write code, create files, or answer questions..." />' +
        '<button type="submit">Send</button>' +
        '</form></div>' +
        '<script>' +
        'var vscode=acquireVsCodeApi();' +

        // Form submit
        'document.getElementById("form").addEventListener("submit",function(e){' +
        'e.preventDefault();' +
        'var text=document.getElementById("input").value;' +
        'if(text.trim()){' +
        'vscode.postMessage({command:"send",text:text});' +
        'document.getElementById("input").value="";' +
        '}});' +

        // Toolbar buttons
        'document.getElementById("saveChatBtn").addEventListener("click",function(){' +
        'vscode.postMessage({command:"saveChat"});});' +
        'document.getElementById("clearChatBtn").addEventListener("click",function(){' +
        'vscode.postMessage({command:"clearChat"});});' +
        'document.getElementById("debugBtn").addEventListener("click",function(){' +
        'vscode.postMessage({command:"debugApiKey"});});' +

        // Status bar buttons
        'document.getElementById("changeModelBtn").addEventListener("click",function(){' +
        'vscode.postMessage({command:"changeModel"});});' +
        'document.getElementById("fetchModelsBtn").addEventListener("click",function(){' +
        'vscode.postMessage({command:"fetchModels"});});' +
        'document.getElementById("changeEndpointBtn").addEventListener("click",function(){' +
        'vscode.postMessage({command:"changeEndpoint"});});' +

        // Code block buttons
        'document.getElementById("chat").addEventListener("click",function(e){' +
        'var btn=e.target.closest(".code-btn");if(!btn)return;' +
        'var codeBlock=btn.closest(".code-block");' +
        'var codeEl=codeBlock.querySelector("code");' +
        'var code=codeEl.textContent;' +
        'var action=btn.getAttribute("data-action");' +
        'var filename=btn.getAttribute("data-filename");' +
        'if(action==="create"){vscode.postMessage({command:"createFile",filename:filename,content:code});}' +
        'else if(action==="edit"){vscode.postMessage({command:"editFile",filename:filename,content:code});}' +
        'else if(action==="insert"){vscode.postMessage({command:"insertAtCursor",content:code});}' +
        '});' +

        // Streaming message handler
        'window.addEventListener("message",function(event){' +
        'var message=event.data;' +
        'if(message.command==="stream"){' +
        'var chatDiv=document.getElementById("chat");' +
        'var lastMsg=chatDiv.querySelector(".message:last-child");' +
        'if(lastMsg&&lastMsg.classList.contains("loading")){' +
        'lastMsg.innerHTML="<b>🤖 GenAI:</b><br>"+message.text.replace(/\\n/g,"<br>");' +
        'chatDiv.scrollTop=chatDiv.scrollHeight;' +
        '}' +
        '}});' +

        // Scroll to bottom and focus input
        'var chatDiv=document.getElementById("chat");' +
        'chatDiv.scrollTop=chatDiv.scrollHeight;' +
        'setTimeout(function(){' +
        'var inp=document.getElementById("input");' +
        'if(inp){inp.focus();}' +
        '},100);' +

        '</script></body></html>';
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Escape HTML
// ═══════════════════════════════════════════════════════════════
function escapeHtml(text) {
    return String(text)
        .replace(/&/g,  '&')
        .replace(/</g,  '<')
        .replace(/>/g,  '>')
        .replace(/"/g,  '"');
}

// ═══════════════════════════════════════════════════════════════
// DEACTIVATION
// ═══════════════════════════════════════════════════════════════
function deactivate() {}

module.exports = { activate, deactivate };