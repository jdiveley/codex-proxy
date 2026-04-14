// This extension uses only VS Code's built-in APIs - no external dependencies needed

/**
 * Activates the extension
 * @param {any} context - VS Code extension context
 */
function activate(context) {
    // Get VS Code API (available globally in extension host)
    const vscode = require('vscode');
    
    console.log('GenAI.mil extension is now active');

    // Command: Set API Key
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

    // Command: Select Endpoint
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
            vscode.window.showInformationMessage(`✓ Endpoint set to: ${endpoint.label}`);
        }
    });

    // Command: Send Query
    let queryCommand = vscode.commands.registerCommand('genai-mil.query', async function () {
        const config = vscode.workspace.getConfiguration('genai-mil');
        const apiKey = config.get('apiKey');
        const endpoint = config.get('endpoint');
        const model = config.get('model');

        // Validate API key
        if (!apiKey) {
            const setKey = await vscode.window.showErrorMessage(
                'API Key not set. Would you like to set it now?',
                'Yes', 'No'
            );
            if (setKey === 'Yes') {
                await vscode.commands.executeCommand('genai-mil.setApiKey');
            }
            return;
        }

        // Get user query
        const userQuery = await vscode.window.showInputBox({
            prompt: 'Enter your query for GenAI.mil',
            placeHolder: 'What would you like to ask?',
            ignoreFocusOut: true
        });

        if (!userQuery) {
            return;
        }

        // Create output channel
        const outputChannel = vscode.window.createOutputChannel('GenAI.mil Response');
        outputChannel.show(true);
        outputChannel.clear();
        outputChannel.appendLine('═══════════════════════════════════════════════════');
        outputChannel.appendLine('GenAI.mil Query');
        outputChannel.appendLine('═══════════════════════════════════════════════════');
        outputChannel.appendLine(`Query: ${userQuery}`);
        outputChannel.appendLine(`Endpoint: ${endpoint}`);
        outputChannel.appendLine(`Model: ${model}`);
        outputChannel.appendLine('═══════════════════════════════════════════════════\n');

        // Send query with progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Querying GenAI.mil...",
            cancellable: false
        }, async (progress) => {
            try {
                // Use fetch API (available in VS Code's extension host)
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: "user", content: userQuery }],
                        stream: true
                    })
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                // Handle streaming response
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                outputChannel.appendLine('Response:\n');

                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        outputChannel.appendLine('\n\n═══════════════════════════════════════════════════');
                        outputChannel.appendLine('Stream Complete');
                        outputChannel.appendLine('═══════════════════════════════════════════════════');
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    
                    // Process Server-Sent Events
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
                                // Extract content from delta
                                if (parsed.choices?.[0]?.delta?.content) {
                                    outputChannel.append(parsed.choices[0].delta.content);
                                }
                            } catch (e) {
                                // Skip invalid JSON
                            }
                        }
                    }
                }

                vscode.window.showInformationMessage('✓ Query completed successfully');

            } catch (error) {
                vscode.window.showErrorMessage(`Error: ${error.message}`);
                outputChannel.appendLine(`\n\n❌ Error: ${error.message}`);
                outputChannel.appendLine(`\nStack: ${error.stack}`);
            }
        });
    });

    // Register all commands
    context.subscriptions.push(queryCommand, setApiKeyCommand, selectEndpointCommand);
}

/**
 * Deactivates the extension
 */
function deactivate() {}

// Export activation functions
module.exports = {
    activate,
    deactivate
};