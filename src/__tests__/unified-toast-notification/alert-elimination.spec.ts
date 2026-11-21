// topic-15 unified-toast-notification: business alert() elimination regex and TypeScript AST guards. BDD 先行,源实现 Op3-Op11 落地后才会通过。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...walk(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '');
}

function alertCalls(file: string): Array<{ file: string; pos: number }> {
  const text = readFileSync(file, 'utf-8');
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Array<{ file: string; pos: number }> = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'alert'
    ) {
      hits.push({ file: path.relative(ROOT, file), pos: node.getStart(sf) });
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return hits;
}

describe('unified-toast-notification: alert elimination', () => {
  it('T10 regex scan finds no business alert(...) calls in src outside __tests__', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const stripped = stripCommentsAndStrings(readFileSync(file, 'utf-8'));
      if (/(?<!['"\\])\balert\s*\(/.test(stripped)) {
        hits.push(path.relative(ROOT, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it("T10b TypeScript compiler API finds no CallExpression named 'alert'", () => {
    const hits = walk(SRC).flatMap(alertCalls);
    expect(hits).toEqual([]);
  });
});
