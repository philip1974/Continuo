// BDD: third-party-notices / 移植 / 复制自 VSCode(MIT)的代码与数据在 LICENSE-3RD-PARTY.md 里登记,且随安装包分发
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const notice = readFileSync(path.join(ROOT, 'LICENSE-3RD-PARTY.md'), 'utf8');

/** 二级标题含 heading 的那一节(到下一个二级标题为止)。 */
function section(heading: string): string {
  const start = notice.indexOf(`\n## ${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = notice.indexOf('\n## ', start + 1);
  return notice.slice(start, next === -1 ? undefined : next);
}

/** 「Visual Studio Code」一节。 */
function vscodeSection(): string {
  return section('Visual Studio Code (microsoft/vscode) · MIT License');
}

function listedFilesIn(text: string): string[] {
  return [...text.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]!);
}

function listedFiles(): string[] {
  return listedFilesIn(vscodeSection());
}

/**
 * 源码注释里的来源标记 → 上游仓库(owner/repo):「Ported from <owner>/<repo>」;旧写法「原样取自 VSCode」= microsoft/vscode。
 * 文件头与文件中段的段注释(`//` 与块注释,含 CSS)都算:只有一段移植的文件把标记写在那一段上方。
 * 声明在哪个仓库,就必须登记在标题带「(<owner>/<repo>)」的那一节。
 */
function markedRepos(source: string): string[] {
  const comments = (source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []).join('\n');
  const repos = [...comments.matchAll(/Ported from ([\w.-]+\/[\w.-]+)/g)].map((m) => m[1]!);
  if (/原样取自 VSCode/.test(comments)) repos.push('microsoft/vscode');
  return [...new Set(repos)];
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

function allSources(): string[] {
  return [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'electron'))].map((f) =>
    path.relative(ROOT, f).split(path.sep).join('/'),
  );
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
    const marked = allSources()
      .filter((f) => markedRepos(readFileSync(path.join(ROOT, f), 'utf8')).includes('microsoft/vscode'));
    expect(marked.length).toBeGreaterThanOrEqual(3);
    expect(marked.filter((f) => !listed.has(f))).toEqual([]);
  });

  it('段注释(文件中段、CSS 块注释)里的标记也识别:高对比度色板与 theme.css 的 HC 值', () => {
    expect(markedRepos('a {}\n/* x\n * Ported from microsoft/vscode (MIT)\n */\n.b {}')).toEqual(['microsoft/vscode']);
    expect(markedRepos('const a = 1;\n// Ported from codemirror/search\nfunction f() {}')).toEqual(['codemirror/search']);
    expect(markedRepos("const s = 'Ported from microsoft/vscode';")).toEqual([]);
    for (const f of ['src/styles/design-tokens.css', 'src/styles/theme.css']) {
      expect(markedRepos(readFileSync(path.join(ROOT, f), 'utf8')), f).toContain('microsoft/vscode');
    }
  });

  it('打包:LICENSE-3RD-PARTY.md 进 extraResources(安装包 resources/licenses/)', () => {
    const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    const extra = yml.slice(yml.indexOf('\nextraResources:'), yml.indexOf('\nextraMetadata:'));
    expect(extra).toMatch(/- from: LICENSE-3RD-PARTY\.md\s+to: licenses\/LICENSE-3RD-PARTY\.md/);
  });
});

describe('LICENSE-3RD-PARTY.md:文件头来源标记(通用)', () => {
  it('任何「Ported from <owner>/<repo>」都登记在标题带该仓库的一节里', () => {
    const missing: string[] = [];
    for (const f of allSources()) {
      for (const repo of markedRepos(readFileSync(path.join(ROOT, f), 'utf8'))) {
        const start = notice.search(new RegExp(`\\n## [^\\n]*\\(${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
        const next = start < 0 ? -1 : notice.indexOf('\n## ', start + 1);
        const text = start < 0 ? '' : notice.slice(start, next === -1 ? undefined : next);
        if (!listedFilesIn(text).includes(f)) missing.push(`${f} ← ${repo}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('CodeMirror(codemirror/search)一节:版权、仓库地址、MIT 全文,登记了 codemirror-find', () => {
    const cm = section('CodeMirror (codemirror/search) · MIT License');
    expect(cm).toContain('https://github.com/codemirror/search');
    expect(listedFilesIn(cm)).toContain('src/panels/Editor/codemirror-find.ts');
    expect(cm).toContain('lastMatchIn');
    expect(cm).toContain('prevMatchInRange');
    const text = notice.slice(notice.indexOf('## MIT License text (CodeMirror)'));
    expect(text).toContain('Copyright (C) 2018-2021 by Marijn Haverbeke');
    expect(text).toContain('Permission is hereby granted, free of charge');
  });
});
