const vscode = require('vscode');
const https = require('https');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION: Known endpoints and their available models
// Add new endpoints and models here as needed
// ═══════════════════════════════════════════════════════════════
const KNOWN_ENDPOINTS = {
    "https://api.genai.mil/v1/chat/completions": {
        label: "Chat Completions API",
        defaultModel: "gemini-2.5-flash",
        models: ["gemini-2.5-flash", "gemini-2.5-pro"]
    },
    "https://genai.mil/api/v1": {
        label: "GenAI API v1",
        defaultModel: "default-model-for-v1",
        models: ["default-model-for-v1"]
    }
};

// ═══════════════════════════════════════════════════════════════
// HELPER: Get VS Code configuration
// ═══════════════════════════════════════════════════════════════
function getConfig() {
    const config = vscode.workspace.getConfiguration('genai-mil');
    return {
        apiKey: config.get('apiKey') || '',
        endpoint: config.get('endpoint') || '',
        model: config.get('model') || '',
        pemPath: config.get('pemPath') || '',
        update: function (key, value) {
            return config.update(key, value, true);
        }
    };
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Write file to workspace or prompt save dialog
// ═══════════════════════════════════════════════════════════════
async function writeFileToWorkspace(filename, content, openBeside) {
    const encoder = new TextEncoder();

    if (vscode.workspace.workspaceFolders) {
        const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(workspaceUri, filename);

        // Check if file exists
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
            if (overwrite !== 'Yes') {
                return false;
            }
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
            saveLabel: 'Save File'
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

    const wsUri = vscode.workspace.workspaceFolders[0].uri;
    const fileUri = vscode.Uri.joinPath(wsUri, filename);

    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
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
        // File does not exist, create it
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage('File created: ' + filename);
        return true;
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Make HTTPS POST request with streaming
// ═══════════════════════════════════════════════════════════════
function streamRequest(endpoint, apiKey, model, messages, onData, onDone, onError, pemPath) {
    let url;
    try {
        url = new URL(endpoint);
    } catch (e) {
        onError(new Error('Invalid endpoint URL: ' + endpoint));
        return;
    }

    const payload = JSON.stringify({
        model: model,
        messages: messages,
        stream: true
    });

    const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    // Add PEM certificate if provided
    if (pemPath) {
        try {
            options.ca = fs.readFileSync(pemPath);
        } catch (e) {
            // Continue without PEM if file cannot be read
        }
    }

    const req = https.request(options, function (res) {
        // Handle non-200 status codes
        if (res.statusCode < 200 || res.statusCode >= 300) {
            let errorBody = '';
            res.on('data', function (chunk) { errorBody += chunk.toString(); });
            res.on('end', function () {
                onError(new Error('HTTP ' + res.statusCode + ': ' + (errorBody || res.statusMessage)));
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

                    if (data === '[DONE]') {
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.choices &&
                            parsed.choices[0] &&
                            parsed.choices[0].delta &&
                            parsed.choices[0].delta.content) {
                            onData(parsed.choices[0].delta.content);
                        }
                    } catch (e) {
                        // Skip invalid JSON
                    }
                }
            }
        });

        res.on('end', function () {
            onDone();
        });

        res.on('error', function (err) {
            onError(err);
        });
    });

    req.on('error', function (err) {
        onError(err);
    });

    req.setTimeout(60000, function () {
        req.destroy(new Error('Request timed out after 60 seconds'));
    });

    req.write(payload);
    req.end();
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

    // ─────────────────────────────────────────────
    // COMMAND: Set API Key
    // ─────────────────────────────────────────────
    const setApiKeyCommand = vscode.commands.registerCommand('genai-mil.setApiKey', async function () {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your GenAI.mil API Key',
            password: true,
            placeHolder: 'YOUR_API_KEY',
            ignoreFocusOut: true
        });
        if (apiKey) {
            const config = getConfig();
            await config.update('apiKey', apiKey);
            vscode.window.showInformationMessage('API Key saved successfully');
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Select Endpoint (includes custom)
    // ─────────────────────────────────────────────
    const selectEndpointCommand = vscode.commands.registerCommand('genai-mil.selectEndpoint', async function () {
        // Build quick pick items from known endpoints
        const items = [];
        for (const url in KNOWN_ENDPOINTS) {
            items.push({
                label: KNOWN_ENDPOINTS[url].label,
                description: url,
                value: url
            });
        }
        // Add custom endpoint option
        items.push({
            label: '✏️ Enter Custom Endpoint',
            description: 'Type in a custom API URL',
            value: '__custom__'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select API Endpoint'
        });

        if (!selected) {
            return;
        }

        let endpointUrl = selected.value;

        // Handle custom endpoint
        if (endpointUrl === '__custom__') {
            endpointUrl = await vscode.window.showInputBox({
                prompt: 'Enter the full API endpoint URL',
                placeHolder: 'https://your-api.example.com/v1/chat/completions',
                ignoreFocusOut: true,
                validateInput: function (value) {
                    try {
                        new URL(value);
                        return null;
                    } catch (e) {
                        return 'Please enter a valid URL';
                    }
                }
            });

            if (!endpointUrl) {
                return;
            }
        }

        const config = getConfig();
        await config.update('endpoint', endpointUrl);

        // Auto-set model if endpoint is known
        const known = KNOWN_ENDPOINTS[endpointUrl];
        if (known && known.defaultModel) {
            await config.update('model', known.defaultModel);
            vscode.window.showInformationMessage('Endpoint set to: ' + endpointUrl + ' | Model: ' + known.defaultModel);
        } else {
            // Prompt for model name if custom endpoint
            const modelName = await vscode.window.showInputBox({
                prompt: 'Enter the model name for this endpoint',
                placeHolder: 'e.g., gpt-4, gemini-2.5-flash',
                ignoreFocusOut: true
            });
            if (modelName) {
                await config.update('model', modelName);
                vscode.window.showInformationMessage('Endpoint set to: ' + endpointUrl + ' | Model: ' + modelName);
            } else {
                vscode.window.showInformationMessage('Endpoint set to: ' + endpointUrl);
            }
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Select Model
    // ─────────────────────────────────────────────
    const selectModelCommand = vscode.commands.registerCommand('genai-mil.selectModel', async function () {
        const config = getConfig();
        const endpoint = config.endpoint;
        const known = KNOWN_ENDPOINTS[endpoint];

        if (known && known.models && known.models.length > 0) {
            // Show known models for this endpoint
            const items = known.models.map(function (m) {
                return {
                    label: m,
                    description: m === known.defaultModel ? '(default)' : ''
                };
            });
            // Add custom model option
            items.push({
                label: '✏️ Enter Custom Model',
                description: 'Type in a custom model name'
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a model for ' + endpoint
            });

            if (!selected) {
                return;
            }

            if (selected.label === '✏️ Enter Custom Model') {
                const customModel = await vscode.window.showInputBox({
                    prompt: 'Enter the model name',
                    placeHolder: 'e.g., gpt-4, gemini-2.5-flash',
                    ignoreFocusOut: true
                });
                if (customModel) {
                    await config.update('model', customModel);
                    vscode.window.showInformationMessage('Model set to: ' + customModel);
                }
            } else {
                await config.update('model', selected.label);
                vscode.window.showInformationMessage('Model set to: ' + selected.label);
            }
        } else {
            // Custom endpoint - just ask for model name
            const customModel = await vscode.window.showInputBox({
                prompt: 'Enter the model name for ' + endpoint,
                placeHolder: 'e.g., gpt-4, gemini-2.5-flash',
                value: config.model,
                ignoreFocusOut: true
            });
            if (customModel) {
                await config.update('model', customModel);
                vscode.window.showInformationMessage('Model set to: ' + customModel);
            }
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Set PEM Certificate
    // ─────────────────────────────────────────────
    const setPemCertCommand = vscode.commands.registerCommand('genai-mil.setPemCert', async function () {
        const action = await vscode.window.showQuickPick([
            { label: '📂 Browse for PEM file', value: 'browse' },
            { label: '🗑️ Clear PEM certificate', value: 'clear' }
        ], {
            placeHolder: 'Set or clear PEM certificate'
        });

        if (!action) {
            return;
        }

        const config = getConfig();

        if (action.value === 'clear') {
            await config.update('pemPath', '');
            vscode.window.showInformationMessage('PEM Certificate cleared');
            return;
        }

        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'PEM Certificate': ['pem', 'crt', 'cer'],
                'All Files': ['*']
            },
            openLabel: 'Select PEM Certificate'
        });

        if (fileUri && fileUri[0]) {
            const pemPath = fileUri[0].fsPath;
            // Validate the PEM file exists and is readable
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
    // COMMAND: Open Chat
    // ─────────────────────────────────────────────
    const openChatCommand = vscode.commands.registerCommand('genai-mil.openChat', function () {
        const panel = vscode.window.createWebviewPanel(
            'genaiMilChat',
            'GenAI.mil Chat',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        let chatHistory = [];

        panel.webview.html = getWebviewContent(chatHistory, false);

        panel.webview.onDidReceiveMessage(async function (message) {
            const config = getConfig();

            // ─────────────────────────────────────
            // CLEAR CHAT
            // ─────────────────────────────────────
            if (message.command === 'clearChat') {
                chatHistory = [];
                panel.webview.html = getWebviewContent(chatHistory, false);
                return;
            }

            // ─────────────────────────────────────
            // SEND MESSAGE
            // ─────────────────────────────────────
            if (message.command === 'send') {
                if (!config.apiKey) {
                    vscode.window.showErrorMessage('API Key not set. Run "GenAI.mil: Set API Key" first.');
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
                panel.webview.html = getWebviewContent(chatHistory, true);

                const apiMessages = [SYSTEM_PROMPT].concat(chatHistory);

                let aiMessage = '';

                streamRequest(
                    config.endpoint,
                    config.apiKey,
                    config.model,
                    apiMessages,
                    function (content) {
                        aiMessage += content;
                        panel.webview.postMessage({ command: 'stream', text: aiMessage });
                    },
                    function () {
                        chatHistory.push({ role: 'assistant', content: aiMessage });
                        panel.webview.html = getWebviewContent(chatHistory, false);
                    },
                    function (error) {
                        chatHistory.push({ role: 'assistant', content: 'Error: ' + error.message });
                        panel.webview.html = getWebviewContent(chatHistory, false);
                        vscode.window.showErrorMessage('GenAI.mil Error: ' + error.message);
                    },
                    config.pemPath
                );
            }

            // ─────────────────────────────────────
            // CREATE FILE
            // ─────────────────────────────────────
            if (message.command === 'createFile') {
                await writeFileToWorkspace(message.filename, message.content, true);
            }

            // ─────────────────────────────────────
            // EDIT FILE
            // ─────────────────────────────────────
            if (message.command === 'editFile') {
                await editFileInWorkspace(message.filename, message.content);
            }

            // ─────────────────────────────────────
            // INSERT AT CURSOR
            // ─────────────────────────────────────
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

            // ─────────────────────────────────────
            // SAVE CHAT
            // ─────────────────────────────────────
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
                    saveLabel: 'Save Chat History',
                    filters: {
                        'Markdown': ['md'],
                        'Text': ['txt']
                    }
                });

                if (saveUri) {
                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(saveUri, encoder.encode(chatContent));
                    vscode.window.showInformationMessage('Chat saved to ' + saveUri.fsPath);
                }
            }
        });
    });

    // Register all commands
    context.subscriptions.push(
        setApiKeyCommand,
        selectEndpointCommand,
        selectModelCommand,
        setPemCertCommand,
        openChatCommand
    );
}

// ═══════════════════════════════════════════════════════════════
// WEBVIEW HTML
// ═══════════════════════════════════════════════════════════════
function getWebviewContent(chatHistory, loading) {
    let chatHtml = '';

    for (let i = 0; i < chatHistory.length; i++) {
        const msg = chatHistory[i];
        const isUser = msg.role === 'user';
        const who = isUser ? 'You' : 'GenAI';
        const bgColor = isUser ? '#e3f2fd' : '#f5f5f5';
        const borderColor = isUser ? '#007acc' : '#4caf50';
        const icon = isUser ? '👤' : '🤖';

        let content = escapeHtml(msg.content);

        // Parse code blocks with filename: ```language:filename
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
                    '</div>' +
                    '</div>' +
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
                    '</div>' +
                    '</div>' +
                    '<pre><code>' + code + '</code></pre>' +
                    '</div>';
            }
        );

        // Parse inline code
        content = content.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

        // Newlines to <br>
        content = content.replace(/\n/g, '<br>');

        chatHtml += '<div class="message" style="background:' + bgColor + ';border-left:4px solid ' + borderColor + ';">' +
            '<b>' + icon + ' ' + who + ':</b><br>' + content +
            '</div>';
    }

    if (loading) {
        chatHtml += '<div class="message loading"><em>⏳ GenAI is thinking...</em></div>';
    }

    // Get current config for status bar
    const config = getConfig();
    const statusInfo = 'Endpoint: ' + (config.endpoint || 'Not set') + ' | Model: ' + (config.model || 'Not set');

    return '<!DOCTYPE html>' +
        '<html lang="en">' +
        '<head>' +
        '<style>' +
        'body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; padding: 0; background: #fff; color: #333; }' +
        '.container { display: flex; flex-direction: column; height: 100vh; padding: 12px; box-sizing: border-box; }' +
        'h2 { margin: 0 0 4px 0; color: #007acc; font-size: 18px; }' +
        '.status-bar { font-size: 11px; color: #666; margin-bottom: 8px; padding: 4px 8px; background: #f0f0f0; border-radius: 4px; }' +
        '.toolbar { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }' +
        '.toolbar button { padding: 4px 10px; font-size: 12px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: #f0f0f0; }' +
        '.toolbar button:hover { background: #e0e0e0; }' +
        '#chat { flex: 1; overflow-y: auto; border: 1px solid #ddd; border-radius: 6px; padding: 10px; background: #fafafa; margin-bottom: 8px; }' +
        '.message { margin-bottom: 10px; padding: 10px; border-radius: 6px; word-wrap: break-word; }' +
        '.loading { background: #fff3e0 !important; border-left: 4px solid #ff9800 !important; }' +
        '.code-block { background: #1e1e1e; color: #d4d4d4; border-radius: 6px; margin: 8px 0; overflow: hidden; }' +
        '.code-header { background: #333; color: #fff; padding: 6px 10px; display: flex; align-items: center; justify-content: space-between; font-size: 12px; flex-wrap: wrap; gap: 6px; }' +
        '.code-actions { display: flex; gap: 4px; flex-wrap: wrap; }' +
        '.code-btn { padding: 3px 8px; font-size: 11px; cursor: pointer; border: 1px solid #555; border-radius: 3px; background: #444; color: #fff; }' +
        '.code-btn:hover { background: #666; }' +
        'pre { margin: 0; padding: 12px; overflow-x: auto; font-size: 13px; }' +
        'code { font-family: "Consolas", "Courier New", monospace; }' +
        '.inline-code { background: #e8e8e8; padding: 2px 5px; border-radius: 3px; font-size: 13px; }' +
        '#form { display: flex; gap: 8px; }' +
        '#input { flex: 1; padding: 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; outline: none; }' +
        '#input:focus { border-color: #007acc; }' +
        '#form button { padding: 10px 20px; font-size: 14px; cursor: pointer; border: none; border-radius: 6px; background: #007acc; color: #fff; }' +
        '#form button:hover { background: #005a9e; }' +
        '.empty-state { color: #999; text-align: center; padding: 40px; font-size: 14px; }' +
        '</style>' +
        '</head>' +
        '<body>' +
        '<div class="container">' +
        '<h2>🤖 GenAI.mil Chat</h2>' +
        '<div class="status-bar">' + escapeHtml(statusInfo) + '</div>' +
        '<div class="toolbar">' +
        '<button id="saveChatBtn">💾 Save Chat</button>' +
        '<button id="clearChatBtn">🗑️ Clear Chat</button>' +
        '</div>' +
        '<div id="chat">' +
        (chatHtml || '<div class="empty-state">Start a conversation...<br><br>Try: "Create a Python script called hello.py that prints Hello World"</div>') +
        '</div>' +
        '<form id="form">' +
        '<input id="input" type="text" placeholder="Ask me to write code, create a file, edit a file..." autofocus />' +
        '<button type="submit">Send</button>' +
        '</form>' +
        '</div>' +
        '<script>' +
        'var vscode = acquireVsCodeApi();' +
        'document.getElementById("form").addEventListener("submit", function(e) {' +
        '    e.preventDefault();' +
        '    var text = document.getElementById("input").value;' +
        '    if (text.trim()) {' +
        '        vscode.postMessage({ command: "send", text: text });' +
        '        document.getElementById("input").value = "";' +
        '    }' +
        '});' +
        'document.getElementById("saveChatBtn").addEventListener("click", function() {' +
        '    vscode.postMessage({ command: "saveChat" });' +
        '});' +
        'document.getElementById("clearChatBtn").addEventListener("click", function() {' +
        '    vscode.postMessage({ command: "clearChat" });' +
        '});' +
        'document.getElementById("chat").addEventListener("click", function(e) {' +
        '    var btn = e.target.closest(".code-btn");' +
        '    if (!btn) return;' +
        '    var codeBlock = btn.closest(".code-block");' +
        '    var codeEl = codeBlock.querySelector("code");' +
        '    var code = codeEl.textContent;' +
        '    var action = btn.getAttribute("data-action");' +
        '    var filename = btn.getAttribute("data-filename");' +
        '    if (action === "create") {' +
        '        vscode.postMessage({ command: "createFile", filename: filename, content: code });' +
        '    } else if (action === "edit") {' +
        '        vscode.postMessage({ command: "editFile", filename: filename, content: code });' +
        '    } else if (action === "insert") {' +
        '        vscode.postMessage({ command: "insertAtCursor", content: code });' +
        '    }' +
        '});' +
        'window.addEventListener("message", function(event) {' +
        '    var message = event.data;' +
        '    if (message.command === "stream") {' +
        '        var chatDiv = document.getElementById("chat");' +
        '        var lastMsg = chatDiv.querySelector(".message:last-child");' +
        '        if (lastMsg && lastMsg.classList.contains("loading")) {' +
        '            lastMsg.innerHTML = "<b>🤖 GenAI:</b><br>" + message.text.replace(/\\n/g, "<br>");' +
        '        }' +
        '    }' +
        '});' +
        'var chatDiv = document.getElementById("chat");' +
        'chatDiv.scrollTop = chatDiv.scrollHeight;' +
        '</script>' +
        '</body>' +
        '</html>';
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Escape HTML
// ═══════════════════════════════════════════════════════════════
function escapeHtml(text) {
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"');
}

// ═══════════════════════════════════════════════════════════════
// DEACTIVATION
// ═══════════════════════════════════════════════════════════════
function deactivate() {}

module.exports = {
    activate,
    deactivate
};