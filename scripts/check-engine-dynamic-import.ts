#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const MARKER = 'engine-dynamic-import-ok';
const files = process.argv.slice(2);
const violations: string[] = [];

for (const file of files) {
  let sourceText: string;
  try {
    sourceText = await readFile(file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: cannot read input file ${file}: ${detail}`);
    process.exitCode = 1;
    continue;
  }

  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = sourceText.split(/\r?\n/);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
      const sourceLine = lines[line] ?? '';
      if (!sourceLine.includes(MARKER)) {
        violations.push(`  ${file}:${line + 1}:${sourceLine}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (process.exitCode) process.exit(process.exitCode);

if (violations.length > 0) {
  console.error('ERROR: unreviewed dynamic import on an engine-live path:');
  console.error();
  console.error(violations.join('\n'));
  console.error();
  console.error('Prefer a static top-level import. If lazy loading is load-bearing,');
  console.error("append 'engine-dynamic-import-ok' to that exact line and document");
  console.error('the startup or soft-failure boundary that requires it.');
  process.exit(1);
}

console.log(`check-engine-dynamic-import: ok (${files.length} file(s) scanned)`);
