const vscode = require('vscode');
const https = require('https');
const fs = require('fs');

// Helper: Make HTTPS POST request with streaming support and optional PEM certificate
function streamRequest(endpoint, apiKey, model, messages, onData, onDone, onError, pemPath) {
    const url = new URL(endpoint);

    const payload = JSON.stringify({
        model: model,
        messages: messages,
        stream: true
    });

    const options = {
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

    // Add PEM certificate if provided
    if (pemPath) {
        try {
            options.ca = fs.readFileSync(pemPath);
        } catch (e) {
            // If PEM file cannot be read, continue without it
        }
    }

    const req = https.request(options, function (res) {
        let buffer = '';

        res.on('data', function (chunk) {
            buffer += chunk.toString();

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
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

    req.write(payload);
    req.end();
}

function activate(context) {
    console.log('GenAI.mil extension is now active');

    // Set API Key Command
    const setApiKeyCommand = vscode.commands.registerCommand('genai-mil.setApiKey', async function () {
        const apiKey = await vscode.window.showInputBox({
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

    // Select Endpoint Command
    const selectEndpointCommand = vscode.commands.registerCommand('genai-mil.selectEndpoint', async function () {
        const endpoint = await vscode.window.showQuickPick([
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

    // Set PEM Certificate Command
    const setPemCertCommand = vscode.commands.registerCommand('genai-mil.setPemCert', async function () {
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
            await vscode.workspace.getConfiguration('genai-mil').update('pemPath', pemPath, true);
            vscode.window.showInformationMessage('PEM Certificate set: ' + pemPath);
        }
    });

    // Open Chat Command
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
            const config = vscode.workspace.getConfiguration('genai-mil');
            const apiKey = config.get('apiKey');
            const endpoint = config.get('endpoint');
            const model = config.get('model');
            const pemPath = config.get('pemPath');

            // Clear Chat
            if (message.command === 'clearChat') {
                chatHistory = [];
                panel.webview.html = getWebviewContent(chatHistory, false);
                return;
            }

            // Send Message
            if (message.command === 'send') {
                if (!apiKey) {
                    vscode.window.showErrorMessage('API Key not set. Run "GenAI.mil: Set API Key" first.');
                    return;
                }

                const userMessage = message.text;
                chatHistory.push({ role: 'user', content: userMessage });
                panel.webview.html = getWebviewContent(chatHistory, true);

                const apiMessages = [
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
                    },
                    ...chatHistory
                ];

                let aiMessage = '';

                streamRequest(
                    endpoint,
                    apiKey,
                    model,
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
                    pemPath
                );
            }

            // Create File
            if (message.command === 'createFile') {
                const filename = message.filename;
                const content = message.content;

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
                        if (overwrite !== 'Yes') {
                            return;
                        }
                    }

                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
                    vscode.window.showInformationMessage('File created: ' + filename);

                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

                } else {
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(filename),
                        saveLabel: 'Save File'
                    });
                    if (uri) {
                        const enc = new TextEncoder();
                        await vscode.workspace.fs.writeFile(uri, enc.encode(content));
                        vscode.window.showInformationMessage('File saved: ' + uri.fsPath);
                        const d = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(d, vscode.ViewColumn.Beside);
                    }
                }
            }

            // Edit File
            if (message.command === 'editFile') {
                const editFilename = message.filename;
                const editContent = message.content;

                if (vscode.workspace.workspaceFolders) {
                    const wsUri = vscode.workspace.workspaceFolders[0].uri;
                    const editFileUri = vscode.Uri.joinPath(wsUri, editFilename);

                    try {
                        const editDoc = await vscode.workspace.openTextDocument(editFileUri);
                        const editor = await vscode.window.showTextDocument(editDoc, vscode.ViewColumn.Beside);

                        const fullRange = new vscode.Range(
                            editDoc.positionAt(0),
                            editDoc.positionAt(editDoc.getText().length)
                        );

                        await editor.edit(function (editBuilder) {
                            editBuilder.replace(fullRange, editContent);
                        });

                        vscode.window.showInformationMessage('File updated: ' + editFilename);

                    } catch (e) {
                        const enc2 = new TextEncoder();
                        await vscode.workspace.fs.writeFile(editFileUri, enc2.encode(editContent));
                        const newDoc = await vscode.workspace.openTextDocument(editFileUri);
                        await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside);
                        vscode.window.showInformationMessage('File created: ' + editFilename);
                    }
                } else {
                    vscode.window.showErrorMessage('Open a workspace folder first to edit files.');
                }
            }

            // Insert at Cursor
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

            // Save Chat
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
                    const enc3 = new TextEncoder();
                    await vscode.workspace.fs.writeFile(saveUri, enc3.encode(chatContent));
                    vscode.window.showInformationMessage('Chat saved to ' + saveUri.fsPath);
                }
            }
        });
    });

    context.subscriptions.push(setApiKeyCommand, selectEndpointCommand, setPemCertCommand, openChatCommand);
}

// Webview HTML content
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

function escapeHtml(text) {
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};