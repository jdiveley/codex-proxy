// ═══════════════════════════════════════════════════════════════
// GenAI.mil VS Code Extension - Full Interactive Chat
// Uses only built-in VS Code and Node.js core modules
// No external dependencies required
// ═══════════════════════════════════════════════════════════════

const vscode = require('vscode');
const https = require('https');

// ───────────────────────────────────────────────────────────────
// HELPER: Make HTTPS POST request with streaming support
// ───────────────────────────────────────────────────────────────
function streamRequest(endpoint, apiKey, model, messages, onData, onDone, onError) {
    var url = new URL(endpoint);

    var payload = JSON.stringify({
        model: model,
        messages: messages,
        stream: true
    });

    var options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    var req = https.request(options, function (res) {
        var buffer = '';

        res.on('data', function (chunk) {
            buffer += chunk.toString();

            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.startsWith('data: ')) {
                    var data = line.slice(6).trim();

                    if (data === '[DONE]') {
                        continue;
                    }

                    try {
                        var parsed = JSON.parse(data);
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

    req.write(payload);
    req.end();
}

// ───────────────────────────────────────────────────────────────
// ACTIVATION
// ───────────────────────────────────────────────────────────────
function activate(context) {
    console.log('GenAI.mil extension is now active');

    // ─────────────────────────────────────────────
    // COMMAND: Set API Key
    // ─────────────────────────────────────────────
    var setApiKeyCommand = vscode.commands.registerCommand('genai-mil.setApiKey', async function () {
        var apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your GenAI.mil API Key',
            password: true,
            placeHolder: 'YOUR_API_KEY',
            ignoreFocusOut: true
        });
        if (apiKey) {
            await vscode.workspace.getConfiguration('genai-mil').update('apiKey', apiKey, true);
            vscode.window.showInformationMessage('API Key saved successfully');
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Select Endpoint
    // ─────────────────────────────────────────────
    var selectEndpointCommand = vscode.commands.registerCommand('genai-mil.selectEndpoint', async function () {
        var endpoint = await vscode.window.showQuickPick([
            {
                label: 'Chat Completions API',
                description: 'https://api.genai.mil/v1/chat/completions',
                value: 'https://api.genai.mil/v1/chat/completions'
            },
            {
                label: 'GenAI API v1',
                description: 'https://genai.mil/api/v1',
                value: 'https://genai.mil/api/v1'
            }
        ], {
            placeHolder: 'Select API Endpoint'
        });
        if (endpoint) {
            await vscode.workspace.getConfiguration('genai-mil').update('endpoint', endpoint.value, true);
            vscode.window.showInformationMessage('Endpoint set to: ' + endpoint.label);
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Open Chat
    // ─────────────────────────────────────────────
    var openChatCommand = vscode.commands.registerCommand('genai-mil.openChat', function () {

        // Create the webview panel
        var panel = vscode.window.createWebviewPanel(
            'genaiMilChat',
            'GenAI.mil Chat',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Chat history
        var chatHistory = [];

        // Set initial HTML
        panel.webview.html = getWebviewContent(chatHistory, false);

        // ─────────────────────────────────────────
        // Handle messages from the webview
        // ─────────────────────────────────────────
        panel.webview.onDidReceiveMessage(async function (message) {
            var config = vscode.workspace.getConfiguration('genai-mil');
            var apiKey = config.get('apiKey');
            var endpoint = config.get('endpoint');
            var model = config.get('model');

            // ─────────────────────────────────────
            // CLEAR CHAT
            // ─────────────────────────────────────
            if (message.command === 'clearChat') {
                chatHistory = [];
                panel.webview.html = getWebviewContent(chatHistory, false);
                return;
            }

            // ─────────────────────────────────────
            // SEND MESSAGE TO API
            // ─────────────────────────────────────
            if (message.command === 'send') {

                // Validate API key
                if (!apiKey) {
                    vscode.window.showErrorMessage('API Key not set. Run "GenAI.mil: Set API Key" first.');
                    return;
                }

                var userMessage = message.text;

                // Add user message to history
                chatHistory.push({ role: 'user', content: userMessage });
                panel.webview.html = getWebviewContent(chatHistory, true);

                // Build messages with system prompt
                var apiMessages = [
                    {
                        role: 'system',
                        content: 'You are a helpful coding assistant inside VS Code. ' +
                            'When the user asks you to create or edit a file, respond with the full file content wrapped in a code block. ' +
                            'Always include the filename on the first line of the code block like this:\n' +
                            '```language:path/to/filename.ext\n' +
                            'code here\n' +
                            '```\n' +
                            'If editing an existing file, include the complete updated file content. ' +
                            'Always provide complete, working code.'
                    }
                ];

                // Add chat history to messages
                for (var i = 0; i < chatHistory.length; i++) {
                    apiMessages.push(chatHistory[i]);
                }

                // Collect the AI response
                var aiMessage = '';

                // Make the streaming request
                streamRequest(
                    endpoint,
                    apiKey,
                    model,
                    apiMessages,
                    // onData callback - called for each chunk
                    function (content) {
                        aiMessage += content;
                        panel.webview.postMessage({
                            command: 'stream',
                            text: aiMessage
                        });
                    },
                    // onDone callback - called when stream ends
                    function () {
                        chatHistory.push({ role: 'assistant', content: aiMessage });
                        panel.webview.html = getWebviewContent(chatHistory, false);
                    },
                    // onError callback - called on error
                    function (error) {
                        chatHistory.push({ role: 'assistant', content: 'Error: ' + error.message });
                        panel.webview.html = getWebviewContent(chatHistory, false);
                        vscode.window.showErrorMessage('GenAI.mil Error: ' + error.message);
                    }
                );
            }

            // ─────────────────────────────────────
            // CREATE A NEW FILE
            // ─────────────────────────────────────
            if (message.command === 'createFile') {
                var filename = message.filename;
                var content = message.content;

                if (vscode.workspace.workspaceFolders) {
                    var workspaceUri = vscode.workspace.workspaceFolders[0].uri;
                    var fileUri = vscode.Uri.joinPath(workspaceUri, filename);

                    // Check if file exists
                    var fileExists = false;
                    try {
                        await vscode.workspace.fs.stat(fileUri);
                        fileExists = true;
                    } catch (e) {
                        fileExists = false;
                    }

                    if (fileExists) {
                        var overwrite = await vscode.window.showWarningMessage(
                            'File "' + filename + '" already exists. Overwrite?',
                            'Yes', 'No'
                        );
                        if (overwrite !== 'Yes') {
                            return;
                        }
                    }

                    // Write the file
                    var encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
                    vscode.window.showInformationMessage('File created: ' + filename);

                    // Open the file
                    var doc = await vscode.workspace.openTextDocument(fileUri);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

                } else {
                    var uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(filename),
                        saveLabel: 'Save File'
                    });
                    if (uri) {
                        var enc = new TextEncoder();
                        await vscode.workspace.fs.writeFile(uri, enc.encode(content));
                        vscode.window.showInformationMessage('File saved: ' + uri.fsPath);
                        var d = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(d, vscode.ViewColumn.Beside);
                    }
                }
            }

            // ─────────────────────────────────────
            // EDIT AN EXISTING FILE
            // ─────────────────────────────────────
            if (message.command === 'editFile') {
                var editFilename = message.filename;
                var editContent = message.content;

                if (vscode.workspace.workspaceFolders) {
                    var wsUri = vscode.workspace.workspaceFolders[0].uri;
                    var editFileUri = vscode.Uri.joinPath(wsUri, editFilename);

                    try {
                        var editDoc = await vscode.workspace.openTextDocument(editFileUri);
                        var editor = await vscode.window.showTextDocument(editDoc, vscode.ViewColumn.Beside);

                        var fullRange = new vscode.Range(
                            editDoc.positionAt(0),
                            editDoc.positionAt(editDoc.getText().length)
                        );

                        await editor.edit(function (editBuilder) {
                            editBuilder.replace(fullRange, editContent);
                        });

                        vscode.window.showInformationMessage('File updated: ' + editFilename);

                    } catch (e) {
                        var enc2 = new TextEncoder();
                        await vscode.workspace.fs.writeFile(editFileUri, enc2.encode(editContent));
                        var newDoc = await vscode.workspace.openTextDocument(editFileUri);
                        await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside);
                        vscode.window.showInformationMessage('File created: ' + editFilename);
                    }
                } else {
                    vscode.window.showErrorMessage('Open a workspace folder first to edit files.');
                }
            }

            // ─────────────────────────────────────
            // INSERT CODE AT CURSOR
            // ─────────────────────────────────────
            if (message.command === 'insertAtCursor') {
                var activeEditor = vscode.window.activeTextEditor;
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
            // SAVE CHAT HISTORY
            // ─────────────────────────────────────
            if (message.command === 'saveChat') {
                var chatContent = '';
                for (var j = 0; j < chatHistory.length; j++) {
                    var who = chatHistory[j].role === 'user' ? '## You' : '## GenAI';
                    chatContent += who + '\n\n' + chatHistory[j].content + '\n\n---\n\n';
                }

                var defaultSaveUri = vscode.workspace.workspaceFolders
                    ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'chat-history.md')
                    : undefined;

                var saveUri = await vscode.window.showSaveDialog({
                    defaultUri: defaultSaveUri,
                    saveLabel: 'Save Chat History',
                    filters: {
                        'Markdown': ['md'],
                        'Text': ['txt']
                    }
                });

                if (saveUri) {
                    var enc3 = new TextEncoder();
                    await vscode.workspace.fs.writeFile(saveUri, enc3.encode(chatContent));
                    vscode.window.showInformationMessage('Chat saved to ' + saveUri.fsPath);
                }
            }
        });
    });

    // Register all commands
    context.subscriptions.push(setApiKeyCommand, selectEndpointCommand, openChatCommand);
}

// ───────────────────────────────────────────────────────────────
// WEBVIEW HTML CONTENT
// ───────────────────────────────────────────────────────────────
function getWebviewContent(chatHistory, loading) {

    var chatHtml = '';

    for (var i = 0; i < chatHistory.length; i++) {
        var msg = chatHistory[i];
        var isUser = msg.role === 'user';
        var who = isUser ? 'You' : 'GenAI';
        var bgColor = isUser ? '#e3f2fd' : '#f5f5f5';
        var borderColor = isUser ? '#007acc' : '#4caf50';
        var icon = isUser ? '👤' : '🤖';

        var content = escapeHtml(msg.content);

        // Parse code blocks with filename: ```language:filename
        content = content.replace(
            /```(\w+):([^\n]+)\n([\s\S]*?)```/g,
            function (match, lang, filename, code) {
                var safeFilename = filename.trim();
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

    return '<!DOCTYPE html>' +
        '<html lang="en">' +
        '<head>' +
        '<style>' +
        'body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; padding: 0; background: #fff; color: #333; }' +
        '.container { display: flex; flex-direction: column; height: 100vh; padding: 12px; box-sizing: border-box; }' +
        'h2 { margin: 0 0 8px 0; color: #007acc; font-size: 18px; }' +
        '.toolbar { display: flex; gap: 8px; margin-bottom: 8px; }' +
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

// ───────────────────────────────────────────────────────────────
// HELPER: Escape HTML
// ───────────────────────────────────────────────────────────────
function escapeHtml(text) {
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"');
}

// ───────────────────────────────────────────────────────────────
// DEACTIVATION
// ───────────────────────────────────────────────────────────────
function deactivate() {}

module.exports = {
    activate,
    deactivate
};