import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MainAppModule = {
  init: () => Promise<void> | void;
};

const entryImplementationPath = resolve(process.cwd(), 'src/main.tsx');
const mainAppImplementationPath = resolve(process.cwd(), 'src/main-app.ts');
const entryModulePath = '@/main';
const spikeModulePath = '@/spikes/plugin-isolation';
const mainAppModulePath = '@/main-app';
const describeIfImplemented = existsSync(entryImplementationPath) && existsSync(mainAppImplementationPath)
  ? describe
  : describe.skip;
const mainAppAstCase = existsSync(mainAppImplementationPath) ? it : it.skip;

async function runEntry(search: string): Promise<void> {
  vi.stubGlobal('location', { search });
  await import(entryModulePath);
  await vi.dynamicImportSettled();
}

describeIfImplemented('topic 45 thin renderer entry', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads only the spike module when ?spike=plugin-isolation is present', async () => {
    const run = vi.fn();
    const init = vi.fn();
    vi.doMock(spikeModulePath, () => ({ run }));
    vi.doMock(mainAppModulePath, () => ({ init }));

    await runEntry('?spike=plugin-isolation');

    expect(run).toHaveBeenCalledOnce();
    expect(init).not.toHaveBeenCalled();
  });

  it('loads only main-app.init when spike query is absent', async () => {
    const run = vi.fn();
    const init = vi.fn();
    vi.doMock(spikeModulePath, () => ({ run }));
    vi.doMock(mainAppModulePath, () => ({ init }));

    await runEntry('');

    expect(init).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not import main-app at all on the spike route', async () => {
    const run = vi.fn();
    const mainAppFactory = vi.fn((): MainAppModule => ({ init: vi.fn() }));
    vi.doMock(spikeModulePath, () => ({ run }));
    vi.doMock(mainAppModulePath, mainAppFactory);

    await runEntry('?spike=plugin-isolation');

    expect(mainAppFactory).not.toHaveBeenCalled();
  });

  it('does not import the spike module at all on the normal app route', async () => {
    const init = vi.fn();
    const spikeFactory = vi.fn(() => ({ run: vi.fn() }));
    vi.doMock(spikeModulePath, spikeFactory);
    vi.doMock(mainAppModulePath, () => ({ init }));

    await runEntry('');

    expect(spikeFactory).not.toHaveBeenCalled();
  });

  it('keeps main-app strict-init as a callable function export', async () => {
    const mainAppModule = (await vi.importActual(mainAppModulePath)) as MainAppModule;

    expect(typeof mainAppModule.init).toBe('function');
  });
});

describe('topic 45 main-app top-level AST contract', () => {
  mainAppAstCase('allows only inert top-level statements in src/main-app.ts', () => {
    const sourceText = readFileSync(mainAppImplementationPath, 'utf8');
    const source = ts.createSourceFile(
      mainAppImplementationPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const disallowed = source.statements.filter((statement) => !isAllowedTopLevelStatement(statement));

    expect(disallowed.map((statement) => ts.SyntaxKind[statement.kind])).toEqual([]);
  });
});

function isAllowedTopLevelStatement(statement: ts.Statement): boolean {
  if (
    ts.isImportDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isFunctionDeclaration(statement)
  ) {
    return true;
  }

  if (ts.isVariableStatement(statement)) {
    const declarationList = statement.declarationList;
    const isConstOrLet =
      (declarationList.flags & ts.NodeFlags.Const) !== 0 ||
      (declarationList.flags & ts.NodeFlags.Let) !== 0;
    return isConstOrLet && declarationList.declarations.every(hasAllowedInitializer);
  }

  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
    const expression = statement.expression.expression;
    return (
      expression.kind === ts.SyntaxKind.ImportKeyword &&
      statement.expression.arguments.length === 1 &&
      ts.isStringLiteral(statement.expression.arguments[0]!) &&
      statement.expression.arguments[0]!.text.endsWith('.css')
    );
  }

  return false;
}

function hasAllowedInitializer(declaration: ts.VariableDeclaration): boolean {
  if (!declaration.initializer) return true;
  return (
    ts.isArrowFunction(declaration.initializer) ||
    ts.isStringLiteral(declaration.initializer) ||
    ts.isNumericLiteral(declaration.initializer) ||
    declaration.initializer.kind === ts.SyntaxKind.TrueKeyword ||
    declaration.initializer.kind === ts.SyntaxKind.FalseKeyword ||
    declaration.initializer.kind === ts.SyntaxKind.NullKeyword
  );
}
