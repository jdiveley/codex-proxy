# GenAI.mil Connector for VS Code

Connect to GenAI.mil APIs directly from Visual Studio Code - no Node.js installation required!

## Features

✓ Connect to both GenAI.mil API endpoints  
✓ Real-time streaming responses  
✓ Secure API key storage in VS Code settings  
✓ Easy endpoint switching  
✓ No external dependencies

## Quick Start

### Installation

1. Download or create the extension folder `genai-mil-extension`
2. Copy it to your VS Code extensions directory:
   - **Windows**: `%USERPROFILE%\.vscode\extensions\genai-mil-extension`
   - **macOS/Linux**: `~/.vscode/extensions/genai-mil-extension`
3. Restart VS Code
4. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
5. Type "GenAI.mil" to see available commands

### First Time Setup

1. Open Command Palette: `Ctrl+Shift+P`
2. Run: **"GenAI.mil: Set API Key"**
3. Enter your API key
4. (Optional) Run: **"GenAI.mil: Select Endpoint"** to choose your preferred endpoint

### Usage

1. Press `Ctrl+Shift+P`
2. Run: **"GenAI.mil: Send Query"**
3. Enter your question
4. View the streaming response in the output panel

## Available Commands

- **GenAI.mil: Send Query** - Send a query to the API
- **GenAI.mil: Set API Key** - Configure your API key
- **GenAI.mil: Select Endpoint** - Choose between available endpoints

## Configuration

Access settings via File → Preferences → Settings, then search for "GenAI.mil":

- **API Key**: Your GenAI.mil API key (stored securely)
- **Endpoint**: API endpoint URL
- **Model**: Model to use (default: gemini-2.5-flash)

## Supported Endpoints

1. `https://api.genai.mil/v1/chat/completions` (default)
2. `https://genai.mil/api/v1`

## Troubleshooting

**Extension not appearing?**
- Make sure the folder is in the correct extensions directory
- Restart VS Code completely
- Check the extension is enabled in Extensions view

**API errors?**
- Verify your API key is correct
- Check your network connection
- Ensure the endpoint URL is accessible

## Privacy & Security

- API keys are stored in VS Code's secure configuration
- No data is sent to third parties
- All communication is directly with GenAI.mil servers

## License

MIT