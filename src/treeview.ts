import * as vscode from 'vscode';
import * as path from 'path';
import { Finding, Severity } from './types';
import { RobinCommentManager } from './comments';

export type TreeItemType = 'file' | 'finding';

export class FindingTreeItem extends vscode.TreeItem {
  public readonly itemType: TreeItemType;
  public readonly finding?: Finding;
  public readonly filePath?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: TreeItemType,
    finding?: Finding,
    filePath?: string
  ) {
    super(label, collapsibleState);
    this.itemType = itemType;
    this.finding = finding;
    this.filePath = filePath;

    if (itemType === 'file') {
      this.iconPath = vscode.ThemeIcon.File;
      this.contextValue = 'robinFileGroup';
    } else if (itemType === 'finding' && finding) {
      this.description = `L${finding.startLine}`;
      this.tooltip = `${finding.severity}: ${finding.title}\n\n${finding.explanation}`;
      this.iconPath = this.getIconForSeverity(finding.severity);
      this.contextValue = 'robinFindingItem';

      // Clicking jumps to the exact line in editor
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [
          vscode.Uri.file(path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', finding.filePath)),
          {
            selection: new vscode.Range(
              Math.max(0, finding.startLine - 1),
              0,
              Math.max(0, finding.endLine - 1),
              0
            ),
          },
        ],
      };
    }
  }

  private getIconForSeverity(severity: Severity): vscode.ThemeIcon {
    switch (severity) {
      case 'CRITICAL':
        return new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground'));
      case 'HIGH':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      case 'MEDIUM':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
      case 'LOW':
        return new vscode.ThemeIcon('info', new vscode.ThemeColor('editorInfo.foreground'));
    }
  }
}

export class RobinFindingsTreeProvider implements vscode.TreeDataProvider<FindingTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FindingTreeItem | undefined | null | void> =
    new vscode.EventEmitter<FindingTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData: vscode.Event<FindingTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private commentManager: RobinCommentManager;

  constructor(commentManager: RobinCommentManager) {
    this.commentManager = commentManager;
    this.commentManager.onFindingsChanged(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: FindingTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: FindingTreeItem): Thenable<FindingTreeItem[]> {
    const findings = this.commentManager.getActiveFindings();

    if (findings.length === 0) {
      return Promise.resolve([]);
    }

    if (!element) {
      // Group by file
      const fileMap = new Map<string, Finding[]>();
      for (const finding of findings) {
        const list = fileMap.get(finding.filePath) || [];
        list.push(finding);
        fileMap.set(finding.filePath, list);
      }

      const fileItems: FindingTreeItem[] = [];
      for (const [file, items] of fileMap.entries()) {
        const item = new FindingTreeItem(
          `${file} (${items.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'file',
          undefined,
          file
        );
        fileItems.push(item);
      }

      return Promise.resolve(fileItems);
    }

    if (element.itemType === 'file' && element.filePath) {
      const fileFindings = findings.filter((f) => f.filePath === element.filePath);
      const childItems = fileFindings.map((f) => {
        return new FindingTreeItem(
          `[${f.severity}] ${f.title}`,
          vscode.TreeItemCollapsibleState.None,
          'finding',
          f
        );
      });

      return Promise.resolve(childItems);
    }

    return Promise.resolve([]);
  }
}
