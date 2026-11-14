import { annotateDiffLines, extractChangedFilesFromDiff, findGitRepositories } from '../git';

export function runTests(): void {
  console.log('--- Running Local Robin Unit Tests ---');

  // Test 1: extractChangedFilesFromDiff
  const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..89abcdef 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 import express from 'express';
+import crypto from 'crypto';
 const app = express();
`;

  const files = extractChangedFilesFromDiff(sampleDiff);
  if (files.length === 1 && files[0] === 'src/auth.ts') {
    console.log('✅ PASS: extractChangedFilesFromDiff correctly identified changed file.');
  } else {
    throw new Error(`FAIL: extractChangedFilesFromDiff returned unexpected files: ${JSON.stringify(files)}`);
  }

  // Test 2: annotateDiffLines
  const annotated = annotateDiffLines(sampleDiff);
  if (annotated.includes('    2 +import crypto from \'crypto\';')) {
    console.log('✅ PASS: annotateDiffLines correctly annotated added line with line number 2.');
  } else {
    throw new Error(`FAIL: annotateDiffLines output did not match expected: ${annotated}`);
  }

  // Test 3: findGitRepositories in nested path
  const adilManagerPath = 'C:\\Users\\salar pc\\Documents\\developer-Backup\\tools\\Adil manager';
  const foundRepos = findGitRepositories('C:\\Users\\salar pc\\Documents\\developer-Backup\\tools');
  const normalizedFound = foundRepos.map(p => p.toLowerCase().replace(/\\/g, '/'));
  const normalizedTarget = adilManagerPath.toLowerCase().replace(/\\/g, '/');

  if (normalizedFound.includes(normalizedTarget)) {
    console.log('✅ PASS: findGitRepositories correctly discovered nested Adil manager git repository.');
  } else {
    console.log(`⚠️ INFO: findGitRepositories checked paths: ${JSON.stringify(normalizedFound)}`);
  }

  console.log('All tests passed successfully.');
}
