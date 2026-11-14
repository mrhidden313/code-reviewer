import * as vscode from 'vscode';
import * as path from 'path';
import { Finding } from './types';

export class RobinCommentManager {
  private commentController: vscode.CommentController;
  private context: vscode.ExtensionContext;
  private activeThreads: Map<string, { thread: vscode.CommentThread; finding: Finding }> = new Map();
  private onFindingsChangedEmitter = new vscode.EventEmitter<Finding[]>();
  public readonly onFindingsChanged = this.onFindingsChangedEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.commentController = vscode.comments.createCommentController(
      'localRobin',
      'Local Robin Code Reviewer'
    );
    context.subscriptions.push(this.commentController);
  }

  public getActiveFindings(): Finding[] {
    return Array.from(this.activeThreads.values()).map((entry) => entry.finding);
  }

  public isDismissed(findingId: string): boolean {
    return Boolean(this.context.workspaceState.get<boolean>(`dismissed:${findingId}`));
  }

  public async setDismissed(findingId: string, dismissed: boolean): Promise<void> {
    await this.context.workspaceState.update(`dismissed:${findingId}`, dismissed);
  }

  public displayFindings(workspaceRoot: string, findings: Finding[]): void {
    // Clear previously active threads before mounting new ones
    this.clearAllThreads();

    for (const finding of findings) {
      if (this.isDismissed(finding.id)) {
        continue;
      }

      const fullPath = path.resolve(workspaceRoot, finding.filePath);
      const uri = vscode.Uri.file(fullPath);

      // VS Code Ranges are 0-based
      const startLine = Math.max(0, finding.startLine - 1);
      const endLine = Math.max(0, finding.endLine - 1);
      const range = new vscode.Range(startLine, 0, endLine, 0);

      const thread = this.commentController.createCommentThread(uri, range, []);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.label = `Robin Review [${finding.severity}]`;

      const severityBadge = this.getSeverityIcon(finding.severity);
      
      const body = new vscode.MarkdownString();
      body.isTrusted = true;
      body.supportHtml = true;

      const applyFixArgs = encodeURIComponent(JSON.stringify({ findingId: finding.id }));
      const dismissArgs = encodeURIComponent(JSON.stringify({ findingId: finding.id }));

      body.appendMarkdown(`### ${severityBadge} ${finding.title}\n\n`);
      body.appendMarkdown(`${finding.explanation}\n\n`);
      
      if (finding.suggestedFix.trim()) {
        body.appendMarkdown(`**Suggested Fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`\n\n`);
      }

      body.appendMarkdown(`---\n`);
      body.appendMarkdown(`[$(check) Apply Fix](command:localRobin.applyFix?${applyFixArgs}) &nbsp;&nbsp;|&nbsp;&nbsp; [$(close) Dismiss](command:localRobin.dismissFinding?${dismissArgs})`);

      const comment: vscode.Comment = {
        author: {
          name: 'Local Robin',
        },
        body,
        mode: vscode.CommentMode.Preview,
        contextValue: 'robinComment',
      };

      thread.comments = [comment];
      this.activeThreads.set(finding.id, { thread, finding });
    }

    this.onFindingsChangedEmitter.fire(this.getActiveFindings());
  }

  public async applyFix(findingId: string, workspaceRoot: string): Promise<boolean> {
    const entry = this.activeThreads.get(findingId);
    if (!entry) {
      vscode.window.showWarningMessage(`Finding not found or already resolved.`);
      return false;
    }

    const { thread, finding } = entry;
    if (!finding.suggestedFix.trim()) {
      vscode.window.showWarningMessage('No suggested fix provided for this finding.');
      return false;
    }

    const fullPath = path.resolve(workspaceRoot, finding.filePath);
    const uri = vscode.Uri.file(fullPath);

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const startLine = Math.max(0, finding.startLine - 1);
      const endLine = Math.min(document.lineCount - 1, Math.max(0, finding.endLine - 1));

      // Range covers the entire lines from startLine:0 to endLine:lineEnd
      const targetLine = document.lineAt(endLine);
      const range = new vscode.Range(startLine, 0, endLine, targetLine.range.end.character);

      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, finding.suggestedFix);

      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        // Save document and cleanup thread
        await document.save();
        thread.dispose();
        this.activeThreads.delete(findingId);
        this.onFindingsChangedEmitter.fire(this.getActiveFindings());
        vscode.window.showInformationMessage(`Applied fix for: "${finding.title}"`);
        return true;
      } else {
        vscode.window.showErrorMessage(`Failed to apply workspace edit.`);
        return false;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error applying fix: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  public async dismissFinding(findingId: string): Promise<void> {
    const entry = this.activeThreads.get(findingId);
    if (entry) {
      entry.thread.dispose();
      this.activeThreads.delete(findingId);
    }

    await this.setDismissed(findingId, true);
    this.onFindingsChangedEmitter.fire(this.getActiveFindings());
    vscode.window.showInformationMessage('Finding dismissed.');
  }

  public clearAllThreads(): void {
    for (const { thread } of this.activeThreads.values()) {
      thread.dispose();
    }
    this.activeThreads.clear();
    this.onFindingsChangedEmitter.fire([]);
  }

  private getSeverityIcon(severity: string): string {
    switch (severity.toUpperCase()) {
      case 'CRITICAL':
        return '🚨 **CRITICAL**';
      case 'HIGH':
        return '🔴 **HIGH**';
      case 'MEDIUM':
        return '🟡 **MEDIUM**';
      case 'LOW':
        return '🔵 **LOW**';
      default:
        return '⚠️ **ISSUE**';
    }
  }
}
