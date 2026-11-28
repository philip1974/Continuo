// BDD: third-party-notices / 移植 / 复制自 VSCode(MIT)的代码与数据在 LICENSE-3RD-PARTY.md 里登记,且随安装包分发
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const notice = readFileSync(path.join(ROOT, 'LICENSE-3RD-PARTY.md'), 'utf8');

/** 「Visual Studio Code」一节(到下一个二级标题为止)。 */
function vscodeSection(): string {
  const start = notice.indexOf('## Visual Studio Code (microsoft/vscode) · MIT License');
  expect(start).toBeGreaterThanOrEqual(0);
  const next = notice.indexOf('\n## ', start + 1);
  return notice.slice(start, next === -1 ? undefined : next);
}

function listedFiles(): string[] {
  return [...vscodeSection().matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|css|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('LICENSE-3RD-PARTY.md:Visual Studio Code', () => {
  it('有 VSCode 一节:© Microsoft Corporation、仓库地址、MIT 全文', () => {
    const section = vscodeSection();
    expect(section).toContain('© Microsoft Corporation');
    expect(section).toContain('https://github.com/microsoft/vscode');
    const text = notice.slice(notice.indexOf('## MIT License text (Visual Studio Code)'));
    expect(text).toContain('Copyright (c) 2015 - present Microsoft Corporation');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('清单里的文件都存在', () => {
    const files = listedFiles();
    expect(files).toContain('src/panels/Editor/unicode-ambiguous-data.ts');
    for (const f of files) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  it('文件头声明移植 / 复制自 VSCode 的源码都已登记', () => {
    const listed = new Set(listedFiles());
    const marked = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'electron'))]
      .filter((f) => /Ported from microsoft\/vscode|原样取自 VSCode/.test(readFileSync(f, 'utf8').slice(0, 600)))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(marked.length).toBeGreaterThanOrEqual(3);
    expect(marked.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('打包:LICENSE-3RD-PARTY.md 进 extraResources(安装包 resources/licenses/)', () => {
    const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    const extra = yml.slice(yml.indexOf('\nextraResources:'), yml.indexOf('\nextraMetadata:'));
    expect(extra).toMatch(/- from: LICENSE-3RD-PARTY\.md\s+to: licenses\/LICENSE-3RD-PARTY\.md/);
  });
});
