// @vitest-environment jsdom
// 真实 Crepe(不 mock):盘符路径 / co: / vscode: 链接的地址在 Edit 里显示、往返、确认编辑后都不被清空。
// 回归:@milkdown/preset-commonmark ≥7.22 的 sanitizeLinkHref 只放行 http/https/mailto/tel/ftp,
// 把 `C:` 当 scheme → 盘符路径与自定义 scheme 的 DOM href 为空(点击 / 复制失效),链接气泡不改内容
// 直接确认会把 mark 的 href 换成 "" → 保存成 `[x]()`。修复 = renderer 构建 / dev / vitest(milkdown-patched project)都经过
// scripts/vite-milkdown-link-href.ts 的补丁。见同目录 README。
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { patchSanitizeLinkHref } from '../../../scripts/vite-milkdown-link-href';
import { resolveLink } from '../../panels/Editor/link-resolve';

const ROOT = path.resolve(__dirname, '../../..');

const editors: Crepe[] = [];

async function open(markdown: string): Promise<{ crepe: Crepe; root: HTMLElement }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
  });
  editors.push(crepe);
  await crepe.create();
  return { crepe, root };
}

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

interface LinkMark { type: { name: string }; attrs: { href: string } }
interface PmView {
  state: { doc: { descendants: (f: (node: { isText: boolean; marks: LinkMark[]; nodeSize: number }, pos: number) => void) => void } };
}

/** 打开第一个链接的编辑气泡,不改内容直接回车确认(用户「看一眼地址再回车」)。 */
async function confirmFirstLinkUnchanged(crepe: Crepe, root: HTMLElement): Promise<void> {
  const ctx = crepe.editor.ctx;
  const view = ctx.get<PmView, 'editorView'>('editorView');
  let hit: { mark: LinkMark; from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    const mark = node.isText ? node.marks.find((m) => m.type.name === 'link') : undefined;
    if (mark && !hit) hit = { mark, from: pos, to: pos + node.nodeSize };
  });
  expect(hit, '文档里没有链接').not.toBeNull();
  const { mark, from, to } = hit!;
  ctx.get<{ editLink: (m: LinkMark, f: number, t: number) => void }, 'linkTooltipAPICtx'>('linkTooltipAPICtx')
    .editLink(mark, from, to);
  await Promise.resolve();
  const input = (root.ownerDocument.querySelector('.milkdown-link-edit input') as HTMLInputElement | null);
  expect(input, '链接编辑气泡未出现').not.toBeNull();
  expect(input!.value).toBe(mark.attrs.href);
  input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

const CASES = [
  ['盘符路径', '[x](C:/proj/a.md)', 'C:/proj/a.md'],
  ['co: scheme', '[y](co://open?x)', 'co://open?x'],
  ['vscode: scheme', '[z](vscode://file/a)', 'vscode://file/a'],
] as const;

describe('Markdown 链接地址在 Milkdown 里不被清空', () => {
  describe.each(CASES)('%s', (_name, markdown, href) => {
    it('解析 → 序列化不变,渲染出的 <a> 带原地址', async () => {
      const { crepe, root } = await open(`${markdown}\n`);
      expect.soft(crepe.getMarkdown().trim()).toBe(markdown);
      expect.soft(root.querySelector('.ProseMirror a')?.getAttribute('href')).toBe(href);
    });

    it('打开链接编辑气泡不改内容直接确认,保存的地址不变', async () => {
      const { crepe, root } = await open(`${markdown}\n`);
      await confirmFirstLinkUnchanged(crepe, root);
      expect(crepe.getMarkdown().trim()).toBe(markdown);
    });
  });

  it('盘符绝对路径链接的地址点击可解析为文件', async () => {
    const { root } = await open('[x](C:/proj/a.md)\n');
    const href = root.querySelector('.ProseMirror a')?.getAttribute('href') ?? '';
    expect(resolveLink(href, 'C:/proj/cur.md')).toEqual({ kind: 'file', absPath: 'C:/proj/a.md' });
  });

  it('javascript: 链接仍被拦:渲染出的 <a> 不带该地址', async () => {
    const { root } = await open('[bad](javascript:alert(1))\n');
    const a = root.querySelector('.ProseMirror a');
    expect(a?.getAttribute('href') ?? '').not.toMatch(/javascript/i);
  });
});

describe('补丁本身', () => {
  // pnpm 布局:crepe → kit → preset-commonmark 都是同级 node_modules/@milkdown 下的符号链接
  const sibling = (dir: string, name: string): string => realpathSync(path.join(realpathSync(dir), '..', name));
  const kit = sibling(path.join(ROOT, 'node_modules/@milkdown/crepe'), 'kit');
  const file = path.join(sibling(kit, 'preset-commonmark'), 'lib/index.js');
  const load = (code: string): ((href: string) => string) => {
    const start = code.indexOf('//#region src/mark/sanitize-href.ts');
    const end = code.indexOf('//#endregion', start);
    return new Function(`${code.slice(start, end)}; return sanitizeLinkHref;`)() as (href: string) => string;
  };

  it('上游产物仍会清空盘符路径与 co: / vscode:(上游若已修,删补丁)', () => {
    const sanitize = load(readFileSync(file, 'utf-8'));
    expect(sanitize('C:/proj/a.md')).toBe('');
    expect(sanitize('co://open?x')).toBe('');
  });

  it('补丁后:盘符路径(/ 与 \\)、co: / vscode: 原样放行;javascript: / data: / vbscript: / file: 仍清空', () => {
    const sanitize = load(patchSanitizeLinkHref(readFileSync(file, 'utf-8')));
    for (const ok of ['C:/proj/a.md', 'c:\\proj\\a.md', 'co://open?x', 'VSCODE://file/a', 'https://e.com', './a.md']) {
      expect(sanitize(ok)).toBe(ok);
    }
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', 'java\tscript:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'C:', 'C:x']) {
      expect(sanitize(bad), bad).toBe('');
    }
  });

  it('锚点对不上(上游改了实现)时直接报错,不静默放过', () => {
    expect(() => patchSanitizeLinkHref('var unrelated=1;')).toThrow(/preset-commonmark/);
  });

  it('renderer 构建、dev 预打包与 vitest 都经过补丁', () => {
    const config = readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf-8');
    const renderer = config.slice(config.indexOf('renderer:'));
    expect(renderer).toMatch(/milkdownLinkHrefPlugin\(\)/);
    expect(renderer).toMatch(/esbuildOptions:\s*\{\s*plugins:\s*\[milkdownLinkHrefEsbuildPlugin\(\)\]/);
    const workspace = readFileSync(path.join(ROOT, 'vitest.workspace.ts'), 'utf-8');
    expect(workspace).toMatch(/plugins:\s*\[milkdownLinkHrefPlugin\(\)\][\s\S]*?name:\s*'milkdown-patched'/);
  });
});
