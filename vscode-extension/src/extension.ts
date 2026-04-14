import * as vscode from 'vscode';
import { ProxyServer } from './proxy/server';
import { setLogger } from './proxy/utils';
import { ProxyConfig } from './proxy/types';

let server: ProxyServer | null = null;
let statusBar: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

// ---- Config ---------------------------------------------------------------

function readConfig(): ProxyConfig {
  const cfg = vscode.workspace.getConfiguration('codex-proxy');
  const backendBaseUrl = (cfg.get<string>('backendBaseUrl') ?? 'https://api.openai.com').replace(/\/$/, '');

  const openaiBaseUrl =
    (cfg.get<string>('openaiBaseUrl') ?? '').replace(/\/$/, '') ||
    (backendBaseUrl.includes('api.openai.com')
      ? `${backendBaseUrl}/v1`
      : `${backendBaseUrl}/server/openai/v1`);

  const anthropicBaseUrl =
    (cfg.get<string>('anthropicBaseUrl') ?? '').replace(/\/$/, '') ||
    (backendBaseUrl.includes('api.anthropic.com')
      ? `${backendBaseUrl}/v1`
      : `${backendBaseUrl}/server/anthropic/v1`);

  const geminiBaseUrl =
    (cfg.get<string>('geminiBaseUrl') ?? '').replace(/\/$/, '') ||
    (backendBaseUrl.includes('generativelanguage.googleapis.com')
      ? `${backendBaseUrl}/v1beta`
      : `${backendBaseUrl}/server/google/v1beta`);

  return {
    port: cfg.get<number>('port') ?? 8080,
    backendBaseUrl,
    apiToken: cfg.get<string>('apiToken') ?? '',
    openaiBaseUrl,
    anthropicBaseUrl,
    geminiBaseUrl,
    defaultMaxTokens: cfg.get<number>('defaultMaxTokens') ?? 8192,
    debug: cfg.get<boolean>('debug') ?? false,
  };
}

// ---- Status bar -----------------------------------------------------------

function updateStatusBar(): void {
  if (!server?.isRunning) {
    statusBar.text = '$(cloud-slash) Proxy: Stopped';
    statusBar.tooltip = 'Codex Proxy is not running. Click to start.';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.command = 'codex-proxy.start';
  } else {
    const port = readConfig().port;
    statusBar.text = `$(cloud) Proxy: ${port}`;
    statusBar.tooltip =
      `Codex Proxy running on port ${port}\n` +
      `Set OPENAI_BASE_URL=http://localhost:${port} in Codex\n` +
      `Click to show output`;
    statusBar.backgroundColor = undefined;
    statusBar.command = 'codex-proxy.showOutput';
  }
}

// ---- Start / stop helpers ------------------------------------------------

async function startProxy(): Promise<void> {
  const config = readConfig();

  if (!config.apiToken) {
    const choice = await vscode.window.showWarningMessage(
      'Codex Proxy: API token is not configured. Requests to the backend will fail.',
      'Open Settings',
      'Start Anyway',
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'codex-proxy.apiToken');
      return;
    }
    if (choice !== 'Start Anyway') return;
  }

  try {
    if (!server) {
      server = new ProxyServer(config);
    } else {
      await server.reconfigure(config);
    }
    await server.start();
    outputChannel.appendLine(`[proxy] Started on http://127.0.0.1:${config.port}`);
    outputChannel.appendLine(`[proxy] Backend: ${config.backendBaseUrl}`);
    outputChannel.appendLine(`[proxy] Configure Codex with:`);
    outputChannel.appendLine(`[proxy]   OPENAI_BASE_URL=http://localhost:${config.port}`);
    outputChannel.appendLine(`[proxy]   OPENAI_API_KEY=dummy`);
    updateStatusBar();
    void vscode.window.showInformationMessage(
      `Codex Proxy started on port ${config.port}`,
      'Copy Env Config',
    ).then((choice) => {
      if (choice === 'Copy Env Config') vscode.commands.executeCommand('codex-proxy.copyConfig');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[proxy] Failed to start: ${message}`);
    updateStatusBar();
    void vscode.window.showErrorMessage(`Codex Proxy failed to start: ${message}`);
  }
}

async function stopProxy(): Promise<void> {
  if (!server?.isRunning) {
    void vscode.window.showInformationMessage('Codex Proxy is not running.');
    return;
  }
  await server.stop();
  outputChannel.appendLine('[proxy] Stopped');
  updateStatusBar();
}

// ---- Extension lifecycle --------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Output channel — logs from the proxy server go here
  outputChannel = vscode.window.createOutputChannel('Codex Proxy');
  setLogger((msg) => outputChannel.appendLine(msg));

  // Status bar item — right side of the bar
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.show();
  updateStatusBar();

  // ---- Commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand('codex-proxy.start', () => startProxy()),

    vscode.commands.registerCommand('codex-proxy.stop', () => stopProxy()),

    vscode.commands.registerCommand('codex-proxy.restart', async () => {
      outputChannel.appendLine('[proxy] Restarting...');
      await stopProxy();
      await startProxy();
    }),

    vscode.commands.registerCommand('codex-proxy.showOutput', () => {
      outputChannel.show(true);
    }),

    vscode.commands.registerCommand('codex-proxy.copyConfig', async () => {
      const port = readConfig().port;
      const envStr = `OPENAI_BASE_URL=http://localhost:${port}\nOPENAI_API_KEY=dummy`;
      await vscode.env.clipboard.writeText(envStr);
      void vscode.window.showInformationMessage('Codex environment variables copied to clipboard.');
    }),

    // Restart when relevant settings change
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      const keys = [
        'codex-proxy.port',
        'codex-proxy.backendBaseUrl',
        'codex-proxy.apiToken',
        'codex-proxy.openaiBaseUrl',
        'codex-proxy.anthropicBaseUrl',
        'codex-proxy.geminiBaseUrl',
        'codex-proxy.defaultMaxTokens',
        'codex-proxy.debug',
      ];
      if (keys.some((k) => e.affectsConfiguration(k))) {
        if (server?.isRunning) {
          outputChannel.appendLine('[proxy] Configuration changed — restarting...');
          await server.reconfigure(readConfig());
          updateStatusBar();
        }
      }
    }),

    statusBar,
    outputChannel,
  );

  // Auto-start if configured
  const autoStart = vscode.workspace.getConfiguration('codex-proxy').get<boolean>('autoStart') ?? true;
  if (autoStart) {
    outputChannel.appendLine('[proxy] Auto-starting...');
    await startProxy();
  }
}

export async function deactivate(): Promise<void> {
  if (server?.isRunning) {
    await server.stop();
  }
}
