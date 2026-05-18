// topic-19 P0-3: 用 TypeScript Compiler API 扫 scope 内的 string literals，
// 检测 user-visible 中/英文 hardcode 是否漏迁到 catalog。
//
// 度量 = scope 内 *.ts/*.tsx 内的 StringLiteral / NoSubstitutionTemplateLiteral
// 中 CJK([一-龥]) 命中数，允许 allowlist 显式豁免。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../..');

const SCOPE_DIRS = [
  'src/core-plugins',
  'src/panels/Editor',
  'src/panels/Explorer',
  'src/panels/Terminal',
  'src/plugins/command-palette',
  'src/plugins/settings',
  'src/plugins/permissions',
  'src/plugins/quick-open',
  'src/plugins/registries',
  'src/shell/dock',
  'src/shell/AgentAuthPrompt.tsx',
  'src/shell/StatusBar.tsx',
  'src/shell/IconSidebar.tsx',
  'src/marketplace/MarketplaceTab.tsx',
];

const CJK = /[一-鿿㐀-䶿]/;

/** 文件级豁免：仍允许残留中文（动态 / dev signal / 独立 follow-up topic）。 */
const FILE_ALLOWLIST: ReadonlyArray<string> = [
  // useTerminal.ts 大量中文注释；console.warn 是 dev signal
  'src/panels/Terminal/useTerminal.ts',
  // helper 模块（drop-handlers / tree-config / file-icon / clipboard-store / ContextMenu / mutate-actions 等）
  'src/panels/Explorer/tree-config.ts',
  'src/panels/Explorer/file-icon.tsx',
  'src/panels/Explorer/drop-handlers.ts',
  'src/panels/Explorer/clipboard-store.ts',
  'src/panels/Explorer/ContextMenu.tsx',
  // SettingItem 内的 enum option label（块/下划线/竖线 等），topic-19 暂不迁
  'src/core-plugins/TerminalTabPlugin.ts',
  // SettingItem 内的 group/description 字段，topic-19 暂不迁
  'src/core-plugins/EditorTabPlugin.ts',
  'src/core-plugins/ExplorerTabPlugin.ts',
  'src/core-plugins/GeneralTabPlugin.ts',
  // LanguageSettingPlugin 的 enum option '中文'/'한국어' 是语言自称写法不翻译
  'src/core-plugins/LanguageSettingPlugin.ts',
  // editor-file-actions.ts: throw new Error 是 dev signal，用户经 notify.error 看到的是不同消息
  'src/panels/Editor/editor-file-actions.ts',
  // registry console.warn 全是 dev signal — 7 个 registry 文件
  'src/plugins/registries/CommandRegistry.ts',
  'src/plugins/registries/EditorActionRegistry.ts',
  'src/plugins/registries/ExplorerContextMenuRegistry.ts',
  'src/plugins/registries/PanelRegistry.ts',
  'src/plugins/registries/RibbonRegistry.ts',
  'src/plugins/registries/SettingItemRegistry.ts',
  'src/plugins/registries/SettingTabRegistry.ts',
  'src/plugins/registries/StatusBarRegistry.ts',
  // topic-20 已迁完 PluginsTabContent / SettingsPanel / SettingItemRow，allowlist 移除
];

/** 单字面量豁免：某文件特定子串允许保留（动态 fallback 等）。 */
const SUBSTRING_ALLOWLIST: ReadonlyArray<{
  readonly file: string;
  readonly substring: string;
}> = [
  // DockShell console.warn 是 dev signal
  { file: 'src/shell/dock/DockShell.tsx', substring: 'fromJSON' },
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function shouldSkipFile(rel: string): boolean {
  if (FILE_ALLOWLIST.includes(rel)) return true;
  if (/\.spec\.(ts|tsx)$/.test(rel)) return true;
  if (rel.includes('__tests__')) return true;
  return false;
}

function isSubstringAllowed(rel: string, text: string): boolean {
  return SUBSTRING_ALLOWLIST.some(
    (rule) => rule.file === rel && text.includes(rule.substring),
  );
}

function walkDir(absPath: string, out: string[]): void {
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (/\.(ts|tsx)$/.test(absPath)) out.push(absPath);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const e of fs.readdirSync(absPath)) {
    walkDir(path.join(absPath, e), out);
  }
}

function scanFile(absPath: string, rel: string): Violation[] {
  const source = fs.readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      const text = node.text;
      if (CJK.test(text) && !isSubstringAllowed(rel, text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push({ file: rel, line: line + 1, text });
      }
    } else if (ts.isTemplateExpression(node)) {
      // head + middle/tail are TemplateLiteral nodes — check raw text
      const headText = node.head.text;
      if (CJK.test(headText) && !isSubstringAllowed(rel, headText)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.head.getStart(sf));
        violations.push({ file: rel, line: line + 1, text: headText });
      }
      for (const span of node.templateSpans) {
        const spanText = span.literal.text;
        if (CJK.test(spanText) && !isSubstringAllowed(rel, spanText)) {
          const { line } = sf.getLineAndCharacterOfPosition(span.literal.getStart(sf));
          violations.push({ file: rel, line: line + 1, text: spanText });
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return violations;
}

describe('topic-19 hardcode-regression: scope 内 CJK string literal 限额', () => {
  it('scope 内 user-visible string literal CJK 命中数 ≤ 5 (allowlist 外)', () => {
    const allFiles: string[] = [];
    for (const dir of SCOPE_DIRS) {
      const abs = path.join(ROOT, dir);
      if (fs.existsSync(abs)) walkDir(abs, allFiles);
    }

    const violations: Violation[] = [];
    for (const abs of allFiles) {
      const rel = path.relative(ROOT, abs);
      if (shouldSkipFile(rel)) continue;
      violations.push(...scanFile(abs, rel));
    }

    if (violations.length > 5) {
      // 详细列表 — 让人能定位漏迁的 hardcode
      const detail = violations
        .map((v) => `  ${v.file}:${v.line}  "${v.text}"`)
        .join('\n');
      throw new Error(
        `topic-19 AC2 违规：${violations.length} > 5 条 CJK hardcode 漏迁\n${detail}`,
      );
    }
    expect(violations.length).toBeLessThanOrEqual(5);
  });
});
