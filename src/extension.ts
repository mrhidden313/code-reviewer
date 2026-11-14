import * as vscode from 'vscode';
import { RobinCommentManager } from './comments';
import { RobinFindingsTreeProvider } from './treeview';
import { RobinChatViewProvider } from './chatView';
import { runLocalReview } from './reviewer';

export function activate(context: vscode.ExtensionContext): void {
  // Initialize Comment Controller & Manager
  const commentManager = new RobinCommentManager(context);

  // Initialize Sidebar Webview Chat Provider
  const chatProvider = new RobinChatViewProvider(context, commentManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RobinChatViewProvider.viewType, chatProvider)
  );

  // Sync active repo on editor switch
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      chatProvider.announceActiveRepo();
    })
  );

  // Initialize Sidebar TreeView
  const treeProvider = new RobinFindingsTreeProvider(commentManager);
  vscode.window.registerTreeDataProvider('robinFindingsView', treeProvider);

  // Register Core Commands
  const reviewChangesCmd = vscode.commands.registerCommand('localRobin.reviewChanges', async () => {
    await runLocalReview(commentManager);
  });

  const clearReviewsCmd = vscode.commands.registerCommand('localRobin.clearReviews', () => {
    commentManager.clearAllThreads();
    vscode.window.showInformationMessage('Local Robin: All review comments cleared.');
  });

  const refreshFindingsCmd = vscode.commands.registerCommand('localRobin.refreshFindings', () => {
    treeProvider.refresh();
  });

  const applyFixCmd = vscode.commands.registerCommand('localRobin.applyFix', async (args?: { findingId?: string }) => {
    const findingId = args?.findingId;
    if (!findingId) {
      vscode.window.showWarningMessage('No finding ID specified for apply fix.');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    await commentManager.applyFix(findingId, workspaceFolders[0].uri.fsPath);
  });

  const dismissFindingCmd = vscode.commands.registerCommand('localRobin.dismissFinding', async (args?: { findingId?: string }) => {
    const findingId = args?.findingId;
    if (!findingId) {
      vscode.window.showWarningMessage('No finding ID specified for dismiss.');
      return;
    }

    await commentManager.dismissFinding(findingId);
  });

  context.subscriptions.push(
    reviewChangesCmd,
    clearReviewsCmd,
    refreshFindingsCmd,
    applyFixCmd,
    dismissFindingCmd
  );
}

export function deactivate(): void {
  // Clean-up handled automatically by context.subscriptions
}
