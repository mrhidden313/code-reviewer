import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { Finding, GeminiFunctionDeclaration, Severity } from './types';
import { getLocalDiff } from './git';

export const TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: 'get_local_diff',
    description: 'Get the current local git diff of modified, staged, or unstaged changes with line number annotations.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'read_file_context',
    description: 'Read the full contents or a specific line range from a workspace file to verify declarations, callers, and full implementation context.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: {
          type: 'STRING',
          description: 'Workspace-relative file path, e.g. src/auth.ts',
        },
        startLine: {
          type: 'INTEGER',
          description: 'First line to read (1-based). Default is 1.',
        },
        endLine: {
          type: 'INTEGER',
          description: 'Last line to read (inclusive). If omitted, reads up to 500 lines.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'search_codebase',
    description: 'Search workspace files for a text pattern or regex to inspect where functions, classes, or types are used across the project.',
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: {
          type: 'STRING',
          description: 'Text pattern or regex to search for in files.',
        },
        filePattern: {
          type: 'STRING',
          description: 'Optional glob pattern to restrict search, e.g. **/*.ts or src/**/*.py',
        },
        caseSensitive: {
          type: 'BOOLEAN',
          description: 'Whether search is case-sensitive. Default false.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'report_finding',
    description: 'Report a confirmed, actionable code issue, security vulnerability, logic bug, or race condition.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filePath: {
          type: 'STRING',
          description: 'Workspace-relative file path where the bug exists.',
        },
        startLine: {
          type: 'INTEGER',
          description: 'First line number (1-based) in the new file that is affected.',
        },
        endLine: {
          type: 'INTEGER',
          description: 'Last line number (1-based, inclusive) in the new file that is affected.',
        },
        severity: {
          type: 'STRING',
          description: 'Severity level: CRITICAL, HIGH, MEDIUM, or LOW.',
        },
        title: {
          type: 'STRING',
          description: 'Concise summary title of the issue (e.g. "Unhandled Promise Rejection" or "SQL Injection via unsanitized query").',
        },
        explanation: {
          type: 'STRING',
          description: 'Detailed explanation of why this is a real problem and what will fail at runtime.',
        },
        suggestedFix: {
          type: 'STRING',
          description: 'Exact drop-in replacement code for the lines between startLine and endLine.',
        },
      },
      required: ['filePath', 'startLine', 'endLine', 'severity', 'title', 'explanation', 'suggestedFix'],
    },
  },
];

export class WorkspaceToolbox {
  private workspaceRoot: string;
  private collectedFindings: Finding[] = [];

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  public getFindings(): Finding[] {
    return [...this.collectedFindings];
  }

  public clearFindings(): void {
    this.collectedFindings = [];
  }

  public async executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
      case 'get_local_diff': {
        const diffResult = await getLocalDiff(this.workspaceRoot);
        return {
          annotatedDiff: diffResult.annotatedDiff,
          changedFiles: diffResult.changedFiles,
        };
      }

      case 'read_file_context': {
        const rawFilePath = String(args.filePath || '');
        const startLine = Math.max(1, typeof args.startLine === 'number' ? args.startLine : 1);
        const endLine = typeof args.endLine === 'number' ? Math.max(startLine, args.endLine) : startLine + 500;

        return await this.readFileContext(rawFilePath, startLine, endLine);
      }

      case 'search_codebase': {
        const pattern = String(args.pattern || '');
        const filePattern = typeof args.filePattern === 'string' && args.filePattern.trim() ? args.filePattern.trim() : '**/*';
        const caseSensitive = Boolean(args.caseSensitive);

        return await this.searchCodebase(pattern, filePattern, caseSensitive);
      }

      case 'report_finding': {
        return this.recordFinding(args);
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  private async readFileContext(relativeFilePath: string, startLine: number, endLine: number): Promise<Record<string, unknown>> {
    const cleanPath = relativeFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const fullPath = path.resolve(this.workspaceRoot, cleanPath);

    // Enforce workspace root jail
    if (!fullPath.startsWith(this.workspaceRoot)) {
      return { error: `Access denied: path is outside the workspace.` };
    }

    try {
      const uri = vscode.Uri.file(fullPath);
      const uint8 = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(uint8).toString('utf8');
      const lines = text.split('\n');
      const totalLines = lines.length;

      const safeStart = Math.min(startLine, totalLines);
      const safeEnd = Math.min(endLine, totalLines);

      const numberedLines: string[] = [];
      for (let i = safeStart; i <= safeEnd; i++) {
        const numStr = String(i).padStart(5, ' ');
        numberedLines.push(`${numStr} | ${lines[i - 1]}`);
      }

      return {
        filePath: cleanPath,
        startLine: safeStart,
        endLine: safeEnd,
        totalLines,
        content: numberedLines.join('\n'),
      };
    } catch (err) {
      return {
        error: `Could not read file "${cleanPath}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async searchCodebase(pattern: string, filePattern: string, caseSensitive: boolean): Promise<Record<string, unknown>> {
    if (!pattern.trim()) {
      return { matches: [] };
    }

    try {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
      } catch {
        // Fall back to escaped literal search
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
      }

      const files = await vscode.workspace.findFiles(
        filePattern,
        '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode-test/**}',
        200
      );

      const matches: Array<{ file: string; line: number; text: string }> = [];

      for (const fileUri of files) {
        if (matches.length >= 50) {
          break;
        }

        try {
          const uint8 = await vscode.workspace.fs.readFile(fileUri);
          const content = Buffer.from(uint8).toString('utf8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const relPath = path.relative(this.workspaceRoot, fileUri.fsPath).replace(/\\/g, '/');
              matches.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim().slice(0, 300),
              });
              if (matches.length >= 50) {
                break;
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      return {
        totalMatches: matches.length,
        matches,
      };
    } catch (err) {
      return {
        error: `Search error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private recordFinding(args: Record<string, unknown>): Record<string, unknown> {
    const filePath = String(args.filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const startLine = Number(args.startLine) || 1;
    const endLine = Number(args.endLine) || startLine;
    const severityStr = String(args.severity || 'MEDIUM').toUpperCase();
    
    let severity: Severity = 'MEDIUM';
    if (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severityStr)) {
      severity = severityStr as Severity;
    }

    const title = String(args.title || 'Code Issue');
    const explanation = String(args.explanation || '');
    const suggestedFix = String(args.suggestedFix || '');

    // Generate deterministic hash ID for tracking and dismissal
    const hash = createHash('sha256')
      .update(`${filePath}:${startLine}:${endLine}:${title}`)
      .digest('hex')
      .slice(0, 16);

    const finding: Finding = {
      id: hash,
      filePath,
      startLine,
      endLine,
      severity,
      title,
      explanation,
      suggestedFix,
    };

    // Prevent duplicate entries
    const existingIndex = this.collectedFindings.findIndex((f) => f.id === finding.id);
    if (existingIndex >= 0) {
      this.collectedFindings[existingIndex] = finding;
    } else {
      this.collectedFindings.push(finding);
    }

    return { status: 'recorded', id: finding.id };
  }
}
