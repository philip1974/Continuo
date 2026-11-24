// @vitest-environment jsdom
// 真实 Crepe(不 mock):输入法组合(中文拼音 / 韩文)期间的 Enter / Esc / 方向键属于输入法,链接气泡与斜杠菜单不得处理。
// 上游 @milkdown/components 链接气泡输入框与 @milkdown/crepe 斜杠菜单(window 捕获阶段)的 keydown 不判组合:
// 拼音组合中 Enter 上屏字母 → 未上屏拼音被存成地址并关闭气泡;Esc 撤销拼音 → 取消整次链接编辑 / 关闭斜杠菜单;
// 选候选的方向键同时移动菜单高亮。修复 = scripts/vite-milkdown-link-href.ts 的构建期补丁(milkdown-patched project
// 同样经过)。见同目录 README。
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { patchCrepeSlashMenuKeydown, patchLinkTooltipConfirm } from '../../../scripts/vite-milkdown-link-href';

const ROOT = path.resolve(__dirname, '../../..');
const editors: Crepe[] = [];

interface PmView {
  dom: HTMLElement;
  hasFocus: () => boolean;
  state: {
    doc: { descendants: (f: (node: { isText: boolean; marks: LinkMark[]; nodeSize: number }, pos: number) => void) => void };
    tr: { insertText: (text: string) => unknown };
  };
  dispatch: (tr: unknown) => void;
}
interface LinkMark { type: { name: string }; attrs: { href: string } }

async function open(markdown: string): Promise<{ crepe: Crepe; root: HTMLElement; view: PmView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    // Cursor(虚拟光标)在 jsdom 里取不到 Range.getClientRects,与本规范无关,关掉。
    features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false, [Crepe.Feature.Cursor]: false },
  });
  editors.push(crepe);
  await crepe.create();
  return { crepe, root, view: crepe.editor.ctx.get<PmView, 'editorView'>('editorView') };
}

// jsdom 无布局:Range 没有 getClientRects / getBoundingClientRect(斜杠菜单定位 coordsAtPos 用到),给空矩形。
const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
beforeAll(() => {
  Range.prototype.getClientRects = () => [EMPTY_RECT] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => EMPTY_RECT as DOMRect;
});

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** 组合中的按键:Chromium 组合期 keydown 带 isComposing=true、keyCode=229。两个信号各自足以判定。 */
function composingKey(key: string, signal: 'isComposing' | 'keyCode229' = 'isComposing'): KeyboardEvent {
  const init: KeyboardEventInit & { keyCode?: number } =
    signal === 'isComposing' ? { key, isComposing: true } : { key, keyCode: 229 };
  return new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
}
const plainKey = (key: string) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

async function openLinkEdit(crepe: Crepe, root: HTMLElement): Promise<HTMLInputElement> {
  const ctx = crepe.editor.ctx;
  const view = ctx.get<PmView, 'editorView'>('editorView');
  let hit: { mark: LinkMark; from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    const mark = node.isText ? node.marks.find((m) => m.type.name === 'link') : undefined;
    if (mark && !hit) hit = { mark, from: pos, to: pos + node.nodeSize };
  });
  const { mark, from, to } = hit!;
  ctx.get<{ editLink: (m: LinkMark, f: number, t: number) => void }, 'linkTooltipAPICtx'>('linkTooltipAPICtx')
    .editLink(mark, from, to);
  await Promise.resolve();
  const input = root.ownerDocument.querySelector('.milkdown-link-edit input') as HTMLInputElement | null;
  expect(input, '链接编辑气泡未出现').not.toBeNull();
  return input!;
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const linkEditShown = (): boolean =>
  document.querySelector('.milkdown-link-edit')?.getAttribute('data-show') === 'true';

describe('链接气泡:输入法组合中的 Enter / Esc 交给输入法', () => {
  it.each(['isComposing', 'keyCode229'] as const)('组合中 Enter(%s)不保存未上屏的拼音、不关闭气泡;组合结束后 Enter 照常保存', async (signal) => {
    const { crepe, root } = await open('[x](https://e.com)\n');
    const input = await openLinkEdit(crepe, root);
    typeInto(input, 'https://e.com/ni');
    input.dispatchEvent(composingKey('Enter', signal));
    await tick();
    expect(crepe.getMarkdown().trim()).toBe('[x](https://e.com)');
    expect(linkEditShown()).toBe(true);

    typeInto(input, 'https://e.com/你');
    input.dispatchEvent(plainKey('Enter'));
    await tick();
    expect(crepe.getMarkdown().trim()).toBe('[x](https://e.com/你)');
  });

  it('组合中 Esc 只撤销拼音,不取消整次链接编辑;组合结束后 Esc 照常取消', async () => {
    const { crepe, root } = await open('[x](https://e.com)\n');
    const input = await openLinkEdit(crepe, root);
    input.dispatchEvent(composingKey('Escape'));
    await tick();
    expect(linkEditShown()).toBe(true);

    input.dispatchEvent(plainKey('Escape'));
    await tick();
    expect(linkEditShown()).toBe(false);
  });
});

/** 在空段落敲 `/` 打开斜杠菜单(jsdom 里 contenteditable 拿不到焦点,hasFocus 打桩)。 */
async function openSlashMenu(view: PmView): Promise<HTMLElement> {
  view.hasFocus = () => true;
  view.dispatch(view.state.tr.insertText('/'));
  // 菜单节点在首次(防抖后的)update 才挂进 DOM
  const find = () => document.querySelector<HTMLElement>('.milkdown-slash-menu');
  for (let i = 0; i < 20 && find()?.dataset.show !== 'true'; i++) await tick(10);
  const menu = find();
  expect(menu?.dataset.show, '斜杠菜单未出现').toBe('true');
  await tick(); // Vue watchEffect 在下一轮挂上 window 捕获监听
  return menu!;
}

const hoverIndex = (menu: HTMLElement): string | null =>
  menu.querySelector('li.hover')?.getAttribute('data-index') ?? null;

describe('斜杠菜单:输入法组合中的 Enter / Esc / 方向键交给输入法', () => {
  it.each(['isComposing', 'keyCode229'] as const)('组合中 Esc(%s)不关闭菜单;组合结束后 Esc 照常关闭', async (signal) => {
    const { view } = await open('\n');
    const menu = await openSlashMenu(view);
    view.dom.dispatchEvent(composingKey('Escape', signal));
    await tick();
    expect(menu.dataset.show).toBe('true');

    view.dom.dispatchEvent(plainKey('Escape'));
    await tick();
    expect(menu.dataset.show).toBe('false');
  });

  it('组合中 Enter 不执行高亮项(不把段落变成别的块),菜单保持打开', async () => {
    const { crepe, view } = await open('\n');
    const menu = await openSlashMenu(view);
    const before = crepe.getMarkdown();
    view.dom.dispatchEvent(composingKey('Enter'));
    await tick();
    expect(crepe.getMarkdown()).toBe(before);
    expect(menu.dataset.show).toBe('true');
  });

  it('组合中方向键(选候选)不移动菜单高亮;组合结束后照常移动', async () => {
    const { view } = await open('\n');
    const menu = await openSlashMenu(view);
    const start = hoverIndex(menu);
    view.dom.dispatchEvent(composingKey('ArrowDown'));
    await tick();
    expect(hoverIndex(menu)).toBe(start);

    view.dom.dispatchEvent(plainKey('ArrowDown'));
    await tick();
    expect(hoverIndex(menu)).not.toBe(start);
  });
});

describe('补丁本身', () => {
  const crepeDir = realpathSync(path.join(ROOT, 'node_modules/@milkdown/crepe'));
  const sibling = (dir: string, name: string): string => realpathSync(path.join(realpathSync(dir), '..', name));
  const tooltip = path.join(sibling(sibling(crepeDir, 'kit'), 'components'), 'lib/link-tooltip/index.js');
  // 主入口(`@milkdown/crepe`,MilkdownEditor 用)内联了 block-edit;子路径入口 feature/block-edit 同样修补。
  const SLASH_BUNDLES = ['lib/esm/index.js', 'lib/esm/feature/block-edit/index.js'];
  const GUARD = 'if (e.isComposing || e.keyCode === 229) return;';

  it('链接气泡:上游产物 keydown 不判组合;补丁后在 stopPropagation 之后、Enter / Esc 分支之前返回', () => {
    const code = readFileSync(tooltip, 'utf-8');
    expect(code).not.toContain(GUARD);
    const patched = patchLinkTooltipConfirm(code);
    expect(patched).toMatch(/const onKeydown = \(e\) => \{\s*e\.stopPropagation\(\);\s*if \(e\.isComposing \|\| e\.keyCode === 229\) return;\s*if \(e\.key === "Enter"\)/);
  });

  it.each(SLASH_BUNDLES)('斜杠菜单(%s):上游产物不判组合;补丁后 onKeydown 开头即返回', (rel) => {
    const code = readFileSync(path.join(crepeDir, rel), 'utf-8');
    expect(code).not.toContain(GUARD);
    expect(patchCrepeSlashMenuKeydown(code)).toMatch(
      /const onKeydown = \(e\) => \{\s*if \(e\.isComposing \|\| e\.keyCode === 229\) return;\s*const \{ size, groups \} = groupInfo\.value;/,
    );
  });

  it('锚点对不上(上游改了实现)时直接报错,不静默放过', () => {
    expect(() => patchCrepeSlashMenuKeydown('var unrelated=1;')).toThrow(/crepe/);
  });

  it('renderer 构建、dev 预打包与 vitest 都经过 Crepe 补丁', () => {
    const src = readFileSync(path.join(ROOT, 'scripts/vite-milkdown-link-href.ts'), 'utf-8');
    // 同一插件(milkdownLinkHrefPlugin / EsbuildPlugin)按路径分派:Crepe 两个入口都在 PATCHED_BUNDLE 里
    expect(src).toMatch(/CREPE_SLASH_BUNDLE\.test\(id\)\) return patchCrepeSlashMenuKeydown\(code\)/);
    expect(src).toMatch(/PATCHED_BUNDLE = new RegExp\([^)]*CREPE_SLASH_BUNDLE\.source/);
    const workspace = readFileSync(path.join(ROOT, 'vitest.workspace.ts'), 'utf-8');
    expect(workspace).toMatch(/MILKDOWN_PATCHED_INCLUDE = \[[^\]]*editor-markdown-ime-composition/);
  });
});
