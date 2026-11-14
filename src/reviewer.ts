import * as vscode from 'vscode';
import { getExtensionConfig } from './config';
import { getLocalDiff } from './git';
import { GeminiClient } from './gemini';
import { WorkspaceToolbox } from './tools';
import { buildUserPrompt, getRobinSystemPrompt } from './prompts';
import { GeminiContent } from './types';
import { RobinCommentManager } from './comments';

export async function runLocalReview(
  commentManager: RobinCommentManager
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Local Robin: Please open a workspace folder to review code.');
    return;
  }

  const workspaceRoots = workspaceFolders ? workspaceFolders.map((f) => f.uri.fsPath) : [];
  const activeEditor = vscode.window.activeTextEditor;
  const activeFilePath = activeEditor ? activeEditor.document.uri.fsPath : undefined;
  const config = getExtensionConfig();

  if (!config.geminiApiKey) {
    const action = await vscode.window.showErrorMessage(
      'Local Robin: Google Gemini API Key is required.',
      'Open Settings'
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'localRobin.geminiApiKey');
    }
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Local Robin Reviewer',
      cancellable: true,
    },
    async (progress, token) => {
      try {
        // Step 1: Extract Git Diff from active file repo or workspace
        progress.report({ message: 'Resolving Git repository & extracting diff...' });
        const diffResult = await getLocalDiff(activeFilePath, workspaceRoots);
        const repoRoot = diffResult.gitRoot;

        if (!diffResult.diff.trim()) {
          vscode.window.showInformationMessage(`Local Robin: [${repoRoot}] working tree is clean. No code changes to review.`);
          return;
        }

        if (diffResult.isFallback) {
          vscode.window.showInformationMessage(`Local Robin: No uncommitted changes in [${repoRoot}]. Reviewing latest commit (HEAD~1).`);
        }

        progress.report({ message: `Inspecting ${diffResult.changedFiles.length} changed file(s)...` });

        // Step 2: Initialize Agentic Toolbox & Gemini Client for resolved repo
        const toolbox = new WorkspaceToolbox(repoRoot);
        const geminiClient = new GeminiClient(config);
        const systemPrompt = getRobinSystemPrompt(config.maxTurns);
        const userPrompt = buildUserPrompt(diffResult.annotatedDiff, diffResult.changedFiles);

        const history: GeminiContent[] = [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ];

        let turn = 0;
        let completed = false;

        // Step 3: Multi-turn agentic investigation loop
        while (turn < config.maxTurns && !completed) {
          if (token.isCancellationRequested) {
            vscode.window.showInformationMessage('Local Robin: Review cancelled by user.');
            return;
          }

          turn++;
          progress.report({
            message: `Turn ${turn}/${config.maxTurns}: Reasoning & verifying context with Gemini...`,
          });

          const abortController = new AbortController();
          token.onCancellationRequested(() => abortController.abort());

          const response = await geminiClient.generateTurn(
            systemPrompt,
            history,
            abortController.signal
          );

          if (response.toolCalls.length === 0) {
            completed = true;
            break;
          }

          // Record assistant turn in history
          history.push({
            role: 'model',
            parts: response.toolCalls.map((tc) => ({
              functionCall: {
                name: tc.name,
                args: tc.args,
              },
            })),
          });

          // Execute tool calls locally
          for (const call of response.toolCalls) {
            if (token.isCancellationRequested) {
              return;
            }

            progress.report({
              message: `Turn ${turn}: Running tool "${call.name}"...`,
            });

            const result = await toolbox.executeTool(call.name, call.args);

            // Record function response in history
            history.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: call.name,
                    response: result,
                  },
                },
              ],
            });
          }
        }

        // Step 4: Process and render findings
        const findings = toolbox.getFindings();
        const activeFindings = findings.filter((f) => !commentManager.isDismissed(f.id));

        commentManager.displayFindings(repoRoot, activeFindings);

        if (activeFindings.length === 0) {
          vscode.window.showInformationMessage(
            '✅ Local Robin: Review passed! No logic bugs, security risks, or race conditions found.'
          );
        } else {
          vscode.window.showWarningMessage(
            `Local Robin: Found ${activeFindings.length} issue(s). Inline comments and sidebar updated.`
          );
          // Auto reveal findings view in activity bar
          vscode.commands.executeCommand('workbench.view.extension.robin-container');
        }
      } catch (err) {
        if (token.isCancellationRequested) {
          return;
        }
        vscode.window.showErrorMessage(
          `Local Robin Review failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );
}
