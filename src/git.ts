import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface LocalDiffResult {
  diff: string;
  annotatedDiff: string;
  changedFiles: string[];
  gitRoot: string;
  isFallback?: boolean;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function getGitRoot(workspacePath: string): Promise<string | null> {
  try {
    let checkDir = workspacePath;
    try {
      if (fs.existsSync(checkDir) && fs.statSync(checkDir).isFile()) {
        checkDir = path.dirname(checkDir);
      }
    } catch {
      // ignore
    }
    const root = await runGit(['rev-parse', '--show-toplevel'], checkDir);
    return root.trim();
  } catch {
    return null;
  }
}

/**
 * Searches for Git repositories inside root directory up to maxDepth.
 */
export function findGitRepositories(rootDir: string, currentDepth = 0, maxDepth = 4): string[] {
  if (currentDepth > maxDepth) {
    return [];
  }

  const found: string[] = [];
  try {
    const gitDir = path.join(rootDir, '.git');
    if (fs.existsSync(gitDir)) {
      found.push(rootDir);
      return found;
    }

    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out' || name === '.vscode' || name.startsWith('.')) {
          continue;
        }
        const subPath = path.join(rootDir, name);
        found.push(...findGitRepositories(subPath, currentDepth + 1, maxDepth));
        if (found.length >= 5) {
          break;
        }
      }
    }
  } catch {
    // Ignore inaccessible directories
  }

  return found;
}

export async function resolveTargetGitRoot(targetPath?: string, workspaceRoots: string[] = []): Promise<string | null> {
  // 1. If targetPath (e.g. active file) is provided, inspect its directory
  if (targetPath) {
    const activeGit = await getGitRoot(targetPath);
    if (activeGit) {
      return activeGit;
    }
  }

  // 2. Inspect each workspace root directly
  for (const root of workspaceRoots) {
    const directGit = await getGitRoot(root);
    if (directGit) {
      return directGit;
    }
  }

  // 3. Sub-repo auto-discovery in workspace folders
  for (const root of workspaceRoots) {
    const discovered = findGitRepositories(root);
    if (discovered.length > 0) {
      return discovered[0];
    }
  }

  return null;
}

export async function getLocalDiff(targetPath?: string, workspaceRoots: string[] = []): Promise<LocalDiffResult> {
  const gitRoot = await resolveTargetGitRoot(targetPath, workspaceRoots);
  if (!gitRoot) {
    throw new Error('No Git repository detected in the active file folder or workspace.');
  }

  // 1. Check staged + unstaged changes against HEAD
  let rawDiff = await runGit(['diff', 'HEAD'], gitRoot);
  let isFallback = false;

  // 2. If working tree has no uncommitted diff, check untracked or fall back to HEAD~1
  if (!rawDiff.trim()) {
    try {
      rawDiff = await runGit(['diff', 'HEAD~1'], gitRoot);
      isFallback = true;
    } catch {
      rawDiff = '';
    }
  }

  if (!rawDiff.trim()) {
    return {
      diff: '',
      annotatedDiff: '',
      changedFiles: [],
      gitRoot,
    };
  }

  // 3. Extract changed file paths
  const changedFiles = extractChangedFilesFromDiff(rawDiff);

  // 4. Build line-number annotated diff (Robin standard for precise line targeting)
  const annotatedDiff = annotateDiffLines(rawDiff);

  return {
    diff: rawDiff,
    annotatedDiff,
    changedFiles,
    gitRoot,
    isFallback,
  };
}

export function extractChangedFilesFromDiff(diff: string): string[] {
  const files: Set<string> = new Set();
  const diffHeaderRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;

  while ((match = diffHeaderRegex.exec(diff)) !== null) {
    const filePath = match[2];
    if (filePath && filePath !== '/dev/null') {
      files.add(filePath);
    }
  }

  return Array.from(files);
}

/**
 * Annotates diff with exact line numbers in the target (new) file
 * Line numbers match what Robin's LLM prompt expects.
 */
export function annotateDiffLines(diff: string): string {
  const lines = diff.split('\n');
  const annotated: string[] = [];
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentNewLine = parseInt(hunkMatch[1], 10);
        inHunk = true;
      }
      annotated.push(line);
    } else if (inHunk) {
      if (line.startsWith('+')) {
        const lineStr = String(currentNewLine).padStart(5, ' ');
        annotated.push(`${lineStr} ${line}`);
        currentNewLine++;
      } else if (line.startsWith('-')) {
        // Deleted line has no new line number
        annotated.push(`      ${line}`);
      } else if (line.startsWith(' ')) {
        const lineStr = String(currentNewLine).padStart(5, ' ');
        annotated.push(`${lineStr} ${line}`);
        currentNewLine++;
      } else {
        annotated.push(line);
      }
    } else {
      annotated.push(line);
    }
  }

  return annotated.join('\n');
}
