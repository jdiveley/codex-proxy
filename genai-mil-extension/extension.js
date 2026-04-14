// ═══════════════════════════════════════════════════════════════
// GenAI.mil VS Code Extension - Full Interactive Chat
// with File Creation, Editing, and Code Insertion
// ═══════════════════════════════════════════════════════════════

const vscode = require('vscode');

// ───────────────────────────────────────────────────────────────
// ACTIVATION
// ───────────────────────────────────────────────────────────────
function activate(context) {
    console.log('GenAI.mil extension is now active');

    // ─────────────────────────────────────────────
    // COMMAND: Set API Key
    // ─────────────────────────────────────────────
    let setApiKeyCommand = vscode.commands.registerCommand('genai-mil.setApiKey', async function () {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your GenAI.mil API Key',
            password: true,
            placeHolder: 'YOUR_API_KEY',
            ignoreFocusOut: true
        });
        if (apiKey) {
            await vscode.workspace.getConfiguration('genai-mil').update('apiKey', apiKey, true);
            vscode.window.showInformationMessage('✓ API Key saved successfully');
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Select Endpoint
    // ─────────────────────────────────────────────
    let selectEndpointCommand = vscode.commands.registerCommand('genai-mil.selectEndpoint', async function () {
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
            vscode.window.showInformationMessage('✓ Endpoint set to: ' + endpoint.label);
        }
    });

    // ─────────────────────────────────────────────
    // COMMAND: Open Chat
    // ─────────────────────────────────────────────
    let openChatCommand = vscode.commands.registerCommand('genai-mil.openChat', function () {

        // Create the webview panel
        const panel = vscode.window.createWebviewPanel(
            'genaiMilChat',
            'GenAI.mil Chat',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Chat history array stores all messages
        let chatHistory = [];

        // Set initial HTML
        panel.webview.html = getWebviewContent(chatHistory, false);

        // ─────────────────────────────────────────
        // Handle all messages from the webview
        // ─────────────────────────────────────────
        panel.webview.onDidReceiveMessage(async message => {
            const config = vscode.workspace.getConfiguration('genai-mil');
            const apiKey = config.get('apiKey');
            const endpoint = config.get('endpoint');
            const model = config.get('model');

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

                const userMessage = message.text;

                // Add user message to history
                chatHistory.push({ role: 'user', content: userMessage });
                panel.webview.html = getWebviewContent(chatHistory, true);

                try {
                    // Build the messages array with system prompt
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

                    // Make the API request
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Authorization': 'Bearer ' + apiKey,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: model,
                            messages: apiMessages,
                            stream: true
                        })
                    });

                    // Check for HTTP errors
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
                    }

                    // Read the streaming response
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let aiMessage = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }

                        buffer += decoder.decode(value, { stream: true });

                        // Process Server-Sent Events line by line
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
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
                                        aiMessage += parsed.choices[0].delta.content;
                                        // Send streaming update to webview
                                        panel.webview.postMessage({
                                            command: 'stream',
                                            text: aiMessage
                                        });
                                    }
                                } catch (e) {
                                    // Skip invalid JSON chunks
                                }
                            }
                        }
                    }

                    // Add completed AI message to history
                    chatHistory.push({ role: 'assistant', content: aiMessage });
                    panel.webview.html = getWebviewContent(chatHistory, false);

                } catch (error) {
                    // Handle errors
                    chatHistory.push({ role: 'assistant', content: 'Error: ' + error.message });
                    panel.webview.html = getWebviewContent(chatHistory, false);
                    vscode.window.showErrorMessage('GenAI.mil Error: ' + error.message);
                }
            }

            // ─────────────────────────────────────
            // CREATE A NEW FILE
            // ─────────────────────────────────────
            if (message.command === 'createFile') {
                const filename = message.filename;
                const content = message.content;

                if (vscode.workspace.workspaceFolders) {
                    const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
                    const fileUri = vscode.Uri.joinPath(workspaceUri, filename);

                    // Check if file already exists
                    let fileExists = false;
                    try {
                        await vscode.workspace.fs.stat(fileUri);
                        fileExists = true;
                    } catch (e) {
                        fileExists = false;
                    }

                    // Confirm overwrite if file exists
                    if (fileExists) {
                        const overwrite = await vscode.window.showWarningMessage(
                            'File "' + filename + '" already exists. Overwrite?',
                            'Yes', 'No'
                        );
                        if (overwrite !== 'Yes') {
                            return;
                        }
                    }

                    // Write the file
                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
                    vscode.window.showInformationMessage('✓ File created: ' + filename);

                    // Open the file in a side editor
                    const doc = await vscode.workspace.openTextDocument(fileUri);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

                } else {
                    // No workspace open - use save dialog
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(filename),
                        saveLabel: 'Save File'
                    });
                    if (uri) {
                        const encoder = new TextEncoder();
                        await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
                        vscode.window.showInformationMessage('✓ File saved: ' + uri.fsPath);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                    }
                }
            }

            // ─────────────────────────────────────
            // EDIT AN EXISTING FILE
            // ─────────────────────────────────────
            if (message.command === 'editFile') {
                const filename = message.filename;
                const content = message.content;

                if (vscode.workspace.workspaceFolders) {
                    const workspaceUri = vscode.workspace.workspaceFolders[0].uri;
                    const fileUri = vscode.Uri.joinPath(workspaceUri, filename);

                    try {
                        // Open the existing file
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

                        // Replace entire file content with new content
                        const fullRange = new vscode.Range(
                            doc.positionAt(0),
                            doc.positionAt(doc.getText().length)
                        );

                        await editor.edit(function (editBuilder) {
                            editBuilder.replace(fullRange, content);
                        });

                        vscode.window.showInformationMessage('✓ File updated: ' + filename);

                    } catch (e) {
                        // File does not exist - create it instead
                        const encoder = new TextEncoder();
                        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                        vscode.window.showInformationMessage('✓ File created: ' + filename);
                    }
                } else {
                    vscode.window.showErrorMessage('Open a workspace folder first to edit files.');
                }
            }

            // ─────────────────────────────────────
            // INSERT CODE AT CURSOR POSITION
            // ─────────────────────────────────────
            if (message.command === 'insertAtCursor') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    await editor.edit(function (editBuilder) {
                        editBuilder.insert(editor.selection.active, message.content);
                    });
                    vscode.window.showInformationMessage('✓ Code inserted at cursor');
                } else {
                    vscode.window.showErrorMessage('No active editor. Open a file first.');
                }
            }

            // ─────────────────────────────────────
            // SAVE ENTIRE CHAT HISTORY
            // ─────────────────────────────────────
            if (message.command === 'saveChat') {
                // Format chat as markdown
                const chatContent = chatHistory.map(function (msg) {
                    const who = msg.role === 'user' ? '## You' : '## GenAI';
                    return who + '\n\n' + msg.content + '\n';
                }).join('\n---\n\n');

                // Show save dialog
                const defaultUri = vscode.workspace.workspaceFolders
                    ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'chat-history.md')
                    : undefined;

                const uri = await vscode.window.showSaveDialog({
                    defaultUri: defaultUri,
                    saveLabel: 'Save Chat History',
                    filters: {
                        'Markdown': ['md'],
                        'Text': ['txt']
                    }
                });

                if (uri) {
                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(uri, encoder.encode(chatContent));
                    vscode.window.showInformationMessage('✓ Chat saved to ' + uri.fsPath);
                }
            }
        });
    });

    // Register all commands
    context.subscriptions.push(setApiKeyCommand, selectEndpointCommand, openChatCommand);
}

// ───────────────────────────────────────────────────────────────
// WEBVIEW HTML CONTENT GENERATOR
// ───────────────────────────────────────────────────────────────
function getWebviewContent(chatHistory, loading) {

    // Build chat messages HTML
    let chatHtml = '';

    for (let i = 0; i < chatHistory.length; i++) {
        const msg = chatHistory[i];
        const isUser = msg.role === 'user';
        const who = isUser ? 'You' : 'GenAI';
        const bgColor = isUser ? '#e3f2fd' : '#f5f5f5';
        const borderColor = isUser ? '#007acc' : '#4caf50';
        const icon = isUser ? '👤' : '🤖';

        // Escape HTML in the message content
        let content = escapeHtml(msg.content);

        // Parse code blocks with filename pattern: ```language:filename
        content = content.replace(
            /```(\w+):([^\n]+)\n([\s\S]*?)```/g,
            function (match, lang, filename, code) {
                const safeFilename = filename.trim();
                const safeCode = code.replace(/'/g, ''').replace(/\\/g, '\\\\');
                return '<div class="code-block">' +
                    '<div class="code-header">' +
                    '<span>📄 ' + safeFilename + ' (' + lang + ')</span>' +
                    '<div class="code-actions">' +
                    '<button class="code-btn create-btn" data-filename="' + safeFilename + '" data-action="create">💾 Create File</button>' +
                    '<button class="code-btn edit-btn" data-filename="' + safeFilename + '" data-action="edit">✏️ Apply Edit</button>' +
                    '<button class="code-btn insert-btn" data-action="insert">📋 Insert at Cursor</button>' +
                    '</div>' +
                    '</div>' +
                    '<pre><code>' + code + '</code></pre>' +
                    '</div>';
            }
        );

        // Parse regular code blocks without filename
        content = content.replace(
            /```(\w*)\n([\s\S]*?)```/g,
            function (match, lang, code) {
                return '<div class="code-block">' +
                    '<div class="code-header">' +
                    '<span>Code' + (lang ? ' (' + lang + ')' : '') + '</span>' +
                    '<div class="code-actions">' +
                    '<button class="code-btn insert-btn" data-action="insert">📋 Insert at Cursor</button>' +
                    '</div>' +
                    '</div>' +
                    '<pre><code>' + code + '</code></pre>' +
                    '</div>';
            }
        );

        // Parse inline code
        content = content.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

        // Convert newlines to <br>
        content = content.replace(/\n/g, '<br>');

        chatHtml += '<div class="message" style="background:' + bgColor + ';border-left:4px solid ' + borderColor + ';">' +
            '<b>' + icon + ' ' + who + ':</b><br>' + content +
            '</div>';
    }

    // Show loading indicator
    if (loading) {
        chatHtml += '<div class="message loading"><em>⏳ GenAI is thinking...</em></div>';
    }

    // Return the full HTML page
    return '<!DOCTYPE html>' +
        '<html lang="en">' +
        '<head>' +
        '<style>' +
        'body {' +
        '    font-family: "Segoe UI", Arial, sans-serif;' +
        '    margin: 0;' +
        '    padding: 0;' +
        '    background: #fff;' +
        '    color: #333;' +
        '}' +
        '.container {' +
        '    display: flex;' +
        '    flex-direction: column;' +
        '    height: 100vh;' +
        '    padding: 12px;' +
        '    box-sizing: border-box;' +
        '}' +
        'h2 {' +
        '    margin: 0 0 8px 0;' +
        '    color: #007acc;' +
        '    font-size: 18px;' +
        '}' +
        '.toolbar {' +
        '    display: flex;' +
        '    gap: 8px;' +
        '    margin-bottom: 8px;' +
        '}' +
        '.toolbar button {' +
        '    padding: 4px 10px;' +
        '    font-size: 12px;' +
        '    cursor: pointer;' +
        '    border: 1px solid #ccc;' +
        '    border-radius: 4px;' +
        '    background: #f0f0f0;' +
        '}' +
        '.toolbar button:hover {' +
        '    background: #e0e0e0;' +
        '}' +
        '#chat {' +
        '    flex: 1;' +
        '    overflow-y: auto;' +
        '    border: 1px solid #ddd;' +
        '    border-radius: 6px;' +
        '    padding: 10px;' +
        '    background: #fafafa;' +
        '    margin-bottom: 8px;' +
        '}' +
        '.message {' +
        '    margin-bottom: 10px;' +
        '    padding: 10px;' +
        '    border-radius: 6px;' +
        '    word-wrap: break-word;' +
        '}' +
        '.loading {' +
        '    background: #fff3e0 !important;' +
        '    border-left: 4px solid #ff9800 !important;' +
        '}' +
        '.code-block {' +
        '    background: #1e1e1e;' +
        '    color: #d4d4d4;' +
        '    border-radius: 6px;' +
        '    margin: 8px 0;' +
        '    overflow: hidden;' +
        '}' +
        '.code-header {' +
        '    background: #333;' +
        '    color: #fff;' +
        '    padding: 6px 10px;' +
        '    display: flex;' +
        '    align-items: center;' +
        '    justify-content: space-between;' +
        '    font-size: 12px;' +
        '    flex-wrap: wrap;' +
        '    gap: 6px;' +
        '}' +
        '.code-actions {' +
        '    display: flex;' +
        '    gap: 4px;' +
        '    flex-wrap: wrap;' +
        '}' +
        '.code-btn {' +
        '    padding: 3px 8px;' +
        '    font-size: 11px;' +
        '    cursor: pointer;' +
        '    border: 1px solid #555;' +
        '    border-radius: 3px;' +
        '    background: #444;' +
        '    color: #fff;' +
        '}' +
        '.code-btn:hover {' +
        '    background: #666;' +
        '}' +
        'pre {' +
        '    margin: 0;' +
        '    padding: 12px;' +
        '    overflow-x: auto;' +
        '    font-size: 13px;' +
        '}' +
        'code {' +
        '    font-family: "Consolas", "Courier New", monospace;' +
        '}' +
        '.inline-code {' +
        '    background: #e8e8e8;' +
        '    padding: 2px 5px;' +
        '    border-radius: 3px;' +
        '    font-size: 13px;' +
        '}' +
        '#form {' +
        '    display: flex;' +
        '    gap: 8px;' +
        '}' +
        '#input {' +
        '    flex: 1;' +
        '    padding: 10px;' +
        '    font-size: 14px;' +
        '    border: 1px solid #ccc;' +
        '    border-radius: 6px;' +
        '    outline: none;' +
        '}' +
        '#input:focus {' +
        '    border-color: #007acc;' +
        '}' +
        '#form button {' +
        '    padding: 10px 20px;' +
        '    font-size: 14px;' +
        '    cursor: pointer;' +
        '    border: none;' +
        '    border-radius: 6px;' +
        '    background: #007acc;' +
        '    color: #fff;' +
        '}' +
        '#form button:hover {' +
        '    background: #005a9e;' +
        '}' +
        '.empty-state {' +
        '    color: #999;' +
        '    text-align: center;' +
        '    padding: 40px;' +
        '    font-size: 14px;' +
        '}' +
        '</style>' +
        '</head>' +
        '<body>' +
        '<div class="container">' +
        '    <h2>🤖 GenAI.mil Chat</h2>' +
        '    <div class="toolbar">' +
        '        <button id="saveChatBtn">💾 Save Chat</button>' +
        '        <button id="clearChatBtn">🗑️ Clear Chat</button>' +
        '    </div>' +
        '    <div id="chat">' +
        (chatHtml || '<div class="empty-state">Start a conversation...<br><br>Try: "Create a Python script called hello.py that prints Hello World"</div>') +
        '    </div>' +
        '    <form id="form">' +
        '        <input id="input" type="text" placeholder="Ask me to write code, create a file, edit a file..." autofocus />' +
        '        <button type="submit">Send</button>' +
        '    </form>' +
        '</div>' +
        '<script>' +
        '    const vscode = acquireVsCodeApi();' +
        '' +
        '    // Send message on form submit' +
        '    document.getElementById("form").addEventListener("submit", function(e) {' +
        '        e.preventDefault();' +
        '        var text = document.getElementById("input").value;' +
        '        if (text.trim()) {' +
        '            vscode.postMessage({ command: "send", text: text });' +
        '            document.getElementById("input").value = "";' +
        '        }' +
        '    });' +
        '' +
        '    // Save chat button' +
        '    document.getElementById("saveChatBtn").addEventListener("click", function() {' +
        '        vscode.postMessage({ command: "saveChat" });' +
        '    });' +
        '' +
        '    // Clear chat button' +
        '    document.getElementById("clearChatBtn").addEventListener("click", function() {' +
        '        vscode.postMessage({ command: "clearChat" });' +
        '    });' +
        '' +
        '    // Handle code block button clicks using event delegation' +
        '    document.getElementById("chat").addEventListener("click", function(e) {' +
        '        var btn = e.target.closest(".code-btn");' +
        '        if (!btn) return;' +
        '' +
        '        var codeBlock = btn.closest(".code-block");' +
        '        var codeEl = codeBlock.querySelector("code");' +
        '        var code = codeEl.textContent;' +
        '        var action = btn.getAttribute("data-action");' +
        '        var filename = btn.getAttribute("data-filename");' +
        '' +
        '        if (action === "create") {' +
        '            vscode.postMessage({ command: "createFile", filename: filename, content: code });' +
        '        } else if (action === "edit") {' +
        '            vscode.postMessage({ command: "editFile", filename: filename, content: code });' +
        '        } else if (action === "insert") {' +
        '            vscode.postMessage({ command: "insertAtCursor", content: code });' +
        '        }' +
        '    });' +
        '' +
        '    // Handle streaming updates from extension' +
        '    window.addEventListener("message", function(event) {' +
        '        var message = event.data;' +
        '        if (message.command === "stream") {' +
        '            var chatDiv = document.getElementById("chat");' +
        '            var lastMsg = chatDiv.querySelector(".message:last-child");' +
        '            if (lastMsg && lastMsg.classList.contains("loading")) {' +
        '                lastMsg.innerHTML = "<b>🤖 GenAI:</b><br>" + message.text.replace(/\\n/g, "<br>");' +
        '            }' +
        '        }' +
        '    });' +
        '' +
        '    // Auto-scroll chat to bottom' +
        '    var chatDiv = document.getElementById("chat");' +
        '    chatDiv.scrollTop = chatDiv.scrollHeight;' +
        '</script>' +
        '</body>' +
        '</html>';
}

// ───────────────────────────────────────────────────────────────
// HELPER: Escape HTML special characters
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

// Export
module.exports = {
    activate,
    deactivate
};