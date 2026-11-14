import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GeminiClient } from './gemini';
import { getExtensionConfig } from './config';
import { GeminiContent, GeminiFunctionDeclaration } from './types';
import { resolveTargetGitRoot } from './git';
import { WorkspaceToolbox } from './tools';
import { RobinCommentManager } from './comments';
import { runLocalReview } from './reviewer';

const CHAT_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: 'read_workspace_file',
    description: 'Read the contents or lines of a file in the workspace.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: { type: 'STRING', description: 'Relative path of the file.' },
        startLine: { type: 'INTEGER', description: 'Starting line number (1-based).' },
        endLine: { type: 'INTEGER', description: 'Ending line number (inclusive).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'list_directory_files',
    description: 'List files and directories in a workspace folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        dirPath: { type: 'STRING', description: 'Relative folder path, or empty for root.' },
      },
    },
  },
  {
    name: 'search_in_workspace',
    description: 'Search for text or regex across workspace files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Text pattern or function name to search.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'trigger_code_review',
    description: 'Trigger a full Local Robin code review on the active Git repository.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];

export class RobinChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'robinChatView';
  private _view?: vscode.WebviewView;
  private chatHistory: GeminiContent[] = [];
  private commentManager: RobinCommentManager;
  private extensionContext: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext, commentManager: RobinCommentManager) {
    this.extensionContext = context;
    this.commentManager = commentManager;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionContext.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: { type: string; text?: string; command?: string }) => {
      switch (data.type) {
        case 'sendMessage': {
          if (data.text) {
            await this.handleUserMessage(data.text);
          }
          break;
        }
        case 'quickAction': {
          if (data.command === 'reviewChanges') {
            await runLocalReview(this.commentManager);
          } else if (data.command === 'clearReviews') {
            this.commentManager.clearAllThreads();
            this.sendSystemMessage('All review comments cleared.');
          } else if (data.command === 'detectRepo') {
            await this.announceActiveRepo();
          }
          break;
        }
      }
    });

    // Notify initial detected repo status
    setTimeout(() => {
      this.announceActiveRepo();
    }, 500);
  }

  public async announceActiveRepo(): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? activeEditor.document.uri.fsPath : undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoots = workspaceFolders ? workspaceFolders.map((f) => f.uri.fsPath) : [];

    const repoRoot = await resolveTargetGitRoot(activeFile, workspaceRoots);
    const repoName = repoRoot ? path.basename(repoRoot) : 'No Git repo detected';
    const filePath = activeFile ? path.basename(activeFile) : 'None';

    this.postMessageToWebview({
      type: 'statusUpdate',
      repoName,
      activeFile: filePath,
    });
  }

  private sendSystemMessage(text: string): void {
    this.postMessageToWebview({
      type: 'addMessage',
      sender: 'robin',
      text,
    });
  }

  private postMessageToWebview(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  private async handleUserMessage(userPrompt: string): Promise<void> {
    const config = getExtensionConfig();
    if (!config.geminiApiKey) {
      this.sendSystemMessage('⚠️ Google Gemini API Key is missing. Please set it in Settings under `localRobin.geminiApiKey`.');
      return;
    }

    // Add user message to UI
    this.postMessageToWebview({
      type: 'addMessage',
      sender: 'user',
      text: userPrompt,
    });

    this.postMessageToWebview({ type: 'setLoading', loading: true });

    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? activeEditor.document.uri.fsPath : undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoots = workspaceFolders ? workspaceFolders.map((f) => f.uri.fsPath) : [];

    const repoRoot = (await resolveTargetGitRoot(activeFile, workspaceRoots)) || (workspaceRoots[0] ?? '.');

    const systemPrompt = `You are Local Robin, an expert AI Software Architect and Code Companion.
You have direct access to the developer's local workspace, files, and git repositories.
Target project root: ${repoRoot}
Active file: ${activeFile || 'None'}

You can talk in English, Urdu, or a natural mix as the user prefers.
Be helpful, sharp, and concise. Explain root causes clearly.
When asked to check code, use tools to read the file and inspect it.
If the user asks to review changes, call trigger_code_review.`;

    const client = new GeminiClient(config);

    // Initialize or continue conversation history
    this.chatHistory.push({
      role: 'user',
      parts: [{ text: userPrompt }],
    });

    try {
      let turn = 0;
      let finalAnswer = '';

      while (turn < 4) {
        turn++;
        const response = await client.generateTurn(systemPrompt, this.chatHistory, undefined, CHAT_TOOLS);

        if (response.toolCalls.length === 0) {
          finalAnswer = response.text;
          break;
        }

        // Add model tool calls to history
        this.chatHistory.push({
          role: 'model',
          parts: response.toolCalls.map((tc) => ({
            functionCall: { name: tc.name, args: tc.args },
          })),
        });

        // Execute tools
        for (const call of response.toolCalls) {
          const toolResult = await this.executeChatTool(call.name, call.args, repoRoot);
          this.chatHistory.push({
            role: 'user',
            parts: [{ functionResponse: { name: call.name, response: toolResult } }],
          });
        }
      }

      if (finalAnswer.trim()) {
        this.sendSystemMessage(finalAnswer);
      } else {
        this.sendSystemMessage('✅ Action completed.');
      }
    } catch (err) {
      this.sendSystemMessage(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.postMessageToWebview({ type: 'setLoading', loading: false });
    }
  }

  private async executeChatTool(
    name: string,
    args: Record<string, unknown>,
    repoRoot: string
  ): Promise<Record<string, unknown>> {
    const toolbox = new WorkspaceToolbox(repoRoot);

    switch (name) {
      case 'read_workspace_file': {
        const filePath = String(args.filePath || '');
        const startLine = Number(args.startLine) || 1;
        const endLine = Number(args.endLine) || startLine + 300;
        return await toolbox.executeTool('read_file_context', { filePath, startLine, endLine });
      }
      case 'search_in_workspace': {
        const query = String(args.query || '');
        return await toolbox.executeTool('search_codebase', { pattern: query });
      }
      case 'list_directory_files': {
        const dirPath = String(args.dirPath || '.');
        const target = path.resolve(repoRoot, dirPath);
        try {
          const entries = fs.readdirSync(target, { withFileTypes: true });
          const items = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return { files: items.slice(0, 100) };
        } catch (e) {
          return { error: String(e) };
        }
      }
      case 'trigger_code_review': {
        await runLocalReview(this.commentManager);
        return { status: 'Code review initiated in editor.' };
      }
      default:
        return { error: `Tool ${name} not found.` };
    }
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local Robin Chat</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      margin: 0;
      padding: 10px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
    .header {
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      margin-bottom: 8px;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      margin-bottom: 4px;
    }
    .quick-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .chat-container {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 8px;
      padding-right: 4px;
    }
    .message {
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      max-width: 85%;
    }
    .message.robin {
      align-self: flex-start;
      background: var(--vscode-editor-inactiveSelectionBackground);
      color: var(--vscode-foreground);
      border-left: 3px solid var(--vscode-activityBarBadge-background);
      max-width: 95%;
    }
    .input-box {
      display: flex;
      gap: 6px;
      border-top: 1px solid var(--vscode-sideBar-border);
      padding-top: 8px;
    }
    textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      font-family: inherit;
      font-size: 12px;
      resize: none;
      height: 38px;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 0 12px;
      cursor: pointer;
      font-weight: bold;
    }
    .loading-dots {
      font-style: italic;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div id="repoBadge" class="badge">Git: Scanning...</div>
    <div class="quick-actions">
      <button class="btn btn-primary" onclick="triggerAction('reviewChanges')">🔍 Review Changes</button>
      <button class="btn" onclick="triggerAction('clearReviews')">🧹 Clear</button>
      <button class="btn" onclick="triggerAction('detectRepo')">🔄 Sync</button>
    </div>
  </div>

  <div class="chat-container" id="chatContainer">
    <div class="message robin">🦅 <b>Local Robin AI Companion</b><br>Main aapke kisi bhi folder ya file ko inspect kar sakta hoon aur review chala sakta hoon. Mujhse Roman Urdu ya English mein pooch sakte hain!</div>
  </div>

  <div id="loadingIndicator" class="loading-dots">Robin is thinking & inspecting files...</div>

  <div class="input-box">
    <textarea id="promptInput" placeholder="Kuch bhi poochein ya file check karwayen..." onkeydown="handleKey(event)"></textarea>
    <button class="send-btn" onclick="sendPrompt()">➤</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chatContainer');
    const promptInput = document.getElementById('promptInput');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const repoBadge = document.getElementById('repoBadge');

    function triggerAction(cmd) {
      vscode.postMessage({ type: 'quickAction', command: cmd });
    }

    function sendPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      vscode.postMessage({ type: 'sendMessage', text: text });
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'addMessage') {
        const div = document.createElement('div');
        div.className = 'message ' + msg.sender;
        div.textContent = msg.text;
        chatContainer.appendChild(div);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      } else if (msg.type === 'setLoading') {
        loadingIndicator.style.display = msg.loading ? 'block' : 'none';
        chatContainer.scrollTop = chatContainer.scrollHeight;
      } else if (msg.type === 'statusUpdate') {
        repoBadge.textContent = 'Git: ' + msg.repoName + (msg.activeFile !== 'None' ? ' • ' + msg.activeFile : '');
      }
    });
  </script>
</body>
</html>`;
  }
}
