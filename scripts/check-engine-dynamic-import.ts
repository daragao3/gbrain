#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const MARKER = 'engine-dynamic-import-ok';
const files = process.argv.slice(2);
const violations: string[] = [];
const readErrors: string[] = [];

for (const file of files) {
  let sourceText: string;
  try {
    sourceText = await readFile(file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    readErrors.push(`ERROR: cannot read input file ${file}: ${detail}`);
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

  function hasMarkerComment(sourceLine: string): boolean {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      sourceLine,
    );
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (
        (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) &&
        scanner.getTokenText().includes(MARKER)
      ) return true;
    }
    return false;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
      const sourceLine = lines[line] ?? '';
      if (!hasMarkerComment(sourceLine)) {
        violations.push(`  ${file}:${line + 1}:${sourceLine}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

for (const error of readErrors) console.error(error);

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

if (readErrors.length > 0) process.exit(1);

console.log(`check-engine-dynamic-import: ok (${files.length} file(s) scanned)`);
