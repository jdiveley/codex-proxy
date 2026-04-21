const vscode = require('vscode');
const https = require('https');

// Store API key in memory for demo (use VSCode SecretStorage for production)
let apiKey = "";

// Command: Set API Key
function setApiKeyCommand() {
  vscode.window.showInputBox({
    prompt: 'Enter your Ask Sage Army API Key',
    password: true
  }).then(key => {
    if (key) {
      apiKey = key.trim();
      vscode.window.showInformationMessage('API Key set!');
    }
  });
}

// Command: Open Chat
function openChatCommand() {
  const panel = vscode.window.createWebviewPanel(
    'genaiMilChat',
    'GenAI.mil Chat',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  let chatHistory = [];

  function render(loading) {
    let chatHtml = chatHistory.map(msg => {
      const who = msg.role === 'user' ? 'You' : 'GenAI';
      return `<div style="margin-bottom:8px;"><b>${who}:</b><br>${msg.content}</div>`;
    }).join('');
    if (loading) chatHtml += `<div><em>⏳ GenAI is thinking...</em></div>`;

    panel.webview.html = `
      <html>
      <body style="font-family:sans-serif;">
        <h2>GenAI.mil Chat</h2>
        <div style="height:300px;overflow:auto;border:1px solid #ccc;padding:8px;margin-bottom:8px;">${chatHtml}</div>
        <form id="form">
          <input id="input" type="text" style="width:80%;" placeholder="Type your message..." />
          <button type="submit">Send</button>
        </form>
        <script>
          const vscode = acquireVsCodeApi();
          document.getElementById('form').addEventListener('submit', function(e){
            e.preventDefault();
            const val = document.getElementById('input').value;
            if(val.trim()) {
              vscode.postMessage({ command: 'send', text: val });
              document.getElementById('input').value = '';
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  render(false);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'send') {
      const userMsg = message.text;
      chatHistory.push({ role: 'user', content: userMsg });
      render(true);

      // Send to Ask Sage Army
      if (!apiKey) {
        chatHistory.push({ role: 'assistant', content: '❌ API Key not set. Run "GenAI.mil: Set API Key".' });
        render(false);
        return;
      }

      const data = JSON.stringify({
        model: 'gpt-4.1-gov',
        message: userMsg
      });

      const options = {
        hostname: 'api.genai.army.mil',
        port: 443,
        path: '/server/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-tokens': apiKey,
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const reply = parsed.response || parsed.message || parsed.text || JSON.stringify(parsed);
            chatHistory.push({ role: 'assistant', content: reply });
          } catch (e) {
            chatHistory.push({ role: 'assistant', content: '❌ Error parsing response.' });
          }
          render(false);
        });
      });

      req.on('error', (err) => {
        chatHistory.push({ role: 'assistant', content: '❌ Network error: ' + err.message });
        render(false);
      });

      req.write(data);
      req.end();
    }
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('genai-mil.openChat', openChatCommand),
    vscode.commands.registerCommand('genai-mil.setApiKey', setApiKeyCommand)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };