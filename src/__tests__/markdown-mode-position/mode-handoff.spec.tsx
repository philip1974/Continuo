// @vitest-environment jsdom
// BDD:Markdown 切换 源码 / 编辑 / 预览 时按源码行交接阅读位置与光标(见同目录 README「交接」)。
// CodeMirror 与 Milkdown 都用真实实例;jsdom 无布局,顶部可见行的测量由 e2e(tests/e2e/markdown-mode-position.spec.ts)覆盖,
// 这里钉交接契约:谁记、谁取、同模式不取、光标按行带过去。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { EditorView } from '@codemirror/view';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { ThemeContext } from '../../theme/ThemeProvider';
import { createTab, useEditorStore } from '../../stores/editor.store';
import {
  clearEditorViewStates,
  renameEditorViewStates,
  retainEditorViewStates,
  saveMarkdownModeAnchor,
  takeMarkdownModeAnchor,
} from '../../panels/Editor/editor-view-state-cache';
import { parseMarkdownTree, sourceLineAtPos, type PmNode, type RemarkLike } from '../../panels/Editor/markdown-position-map';

const instances = vi.hoisted(() => [] as CrepeType[]);

vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

const TAB = '/w/doc.md';
const DOC = ['# Title', '', 'Para one', '', '- a', '- b', '', '```js', 'x = 1', 'y = 2', '```', '', 'End', ''].join('\n');
//            1          2   3           4   5      6      7   8        9        10       11     12  13

interface PmView {
  state: { doc: PmNode & { resolve(p: number): unknown }; selection: { head: number; constructor: { near(p: unknown): unknown } }; tr: { setSelection(s: unknown): unknown } };
  dispatch(tr: unknown): void;
}

function withTheme(node: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>{node}</ThemeContext.Provider>;
}

async function waitCrepe(): Promise<{ crepe: CrepeType; view: PmView }> {
  for (let i = 0; i < 200; i++) {
    const crepe = instances.at(-1);
    try {
      const view = crepe?.editor.ctx.get<PmView, 'editorView'>('editorView');
      // 就绪回调(listener.mounted)已跑过:同批 mounted 回调设置的可访问名称已在
      if (crepe && view?.state && document.querySelector('.ProseMirror[aria-label]')) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        return { crepe, view };
      }
    } catch {
      /* 尚未就绪 */
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

const nextFrames = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

function cursorSourceLine(crepe: CrepeType, view: PmView): number {
  const tree = parseMarkdownTree(crepe.editor.ctx.get<RemarkLike, 'remark'>('remark'), DOC);
  return sourceLineAtPos(view.state.doc, tree, view.state.selection.head);
}

beforeEach(() => {
  clearEditorViewStates();
  useEditorStore.setState({ tabs: [createTab(TAB, DOC)], activeTabId: TAB });
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  instances.length = 0;
  vi.restoreAllMocks();
});

describe('锚点存取(editor-view-state-cache)', () => {
  it('另一模式才取用,取一次即清;同模式重挂(切 tab 回来 / 外部修改重载)不取用', () => {
    saveMarkdownModeAnchor(TAB, { mode: 'source', topLine: 40 });
    expect(takeMarkdownModeAnchor(TAB, 'source')).toBeUndefined();
    expect(takeMarkdownModeAnchor(TAB, 'preview')).toBeUndefined(); // 已被清掉
    saveMarkdownModeAnchor(TAB, { mode: 'source', topLine: 40, cursorLine: 41 });
    expect(takeMarkdownModeAnchor(TAB, 'preview')).toEqual({ mode: 'source', topLine: 40, cursorLine: 41 });
    expect(takeMarkdownModeAnchor(TAB, 'preview')).toBeUndefined();
  });

  it('重命名跟随新 id;关闭 tab 丢弃', () => {
    saveMarkdownModeAnchor(TAB, { mode: 'edit', topLine: 7 });
    renameEditorViewStates([[TAB, '/w/x.md']], () => undefined);
    expect(takeMarkdownModeAnchor('/w/x.md', 'source')).toEqual({ mode: 'edit', topLine: 7 });
    saveMarkdownModeAnchor('/w/x.md', { mode: 'edit', topLine: 7 });
    retainEditorViewStates(() => false);
    expect(takeMarkdownModeAnchor('/w/x.md', 'source')).toBeUndefined();
  });
});

describe('源码视图(CodeMirror)', () => {
  it('从编辑模式切来:光标落到编辑模式光标所在行的行首', async () => {
    saveMarkdownModeAnchor(TAB, { mode: 'edit', topLine: 5, cursorLine: 9 });
    const { container } = render(withTheme(<CodeEditor tabId={TAB} value={DOC} fileName={TAB} forceLanguage="markdown" />));
    await act(async () => {});
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(9);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(9).from);
  });

  it('非 Markdown 文件的代码编辑器不取用锚点', async () => {
    saveMarkdownModeAnchor('/w/a.ts', { mode: 'edit', topLine: 1, cursorLine: 2 });
    useEditorStore.setState({ tabs: [createTab('/w/a.ts', 'a\nb\n')], activeTabId: '/w/a.ts' });
    const { container } = render(withTheme(<CodeEditor tabId="/w/a.ts" value={'a\nb\n'} fileName="/w/a.ts" />));
    await act(async () => {});
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(view.state.selection.main.head).toBe(0);
  });

  it('卸载(切到编辑 / 预览)时记下顶部可见行与光标行', async () => {
    const { container, unmount } = render(withTheme(<CodeEditor tabId={TAB} value={DOC} fileName={TAB} forceLanguage="markdown" />));
    await act(async () => {});
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    view.dispatch({ selection: { anchor: view.state.doc.line(10).from + 2 } });
    unmount();
    expect(takeMarkdownModeAnchor(TAB, 'edit')).toMatchObject({ mode: 'source', topLine: 1, cursorLine: 10 });
  });
});

describe('编辑 / 预览视图(Milkdown)', () => {
  it('从源码切到编辑:光标落到源码光标行对应的块(代码块内精确到行)', async () => {
    saveMarkdownModeAnchor(TAB, { mode: 'source', topLine: 1, cursorLine: 10 });
    render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} />);
    const { crepe, view } = await waitCrepe();
    await nextFrames(); // 列表项节点视图在挂载后下一帧恢复它记下的选区;光标须在其后设置
    expect(cursorSourceLine(crepe, view)).toBe(10);
  });

  it('预览只读:不动光标', async () => {
    saveMarkdownModeAnchor(TAB, { mode: 'source', topLine: 1, cursorLine: 10 });
    render(<MilkdownEditor tabId={TAB} fileName={TAB} readonly defaultValue={DOC} />);
    const { crepe, view } = await waitCrepe();
    await nextFrames();
    expect(cursorSourceLine(crepe, view)).toBe(1);
  });

  it('卸载时记下锚点:编辑模式带光标行,预览不带', async () => {
    // jsdom 无布局:给每个块一个非零外框,顶部可见块 = 第一个块
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20));
    const edit = render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} />);
    const { crepe, view } = await waitCrepe();
    const tree = parseMarkdownTree(crepe.editor.ctx.get<RemarkLike, 'remark'>('remark'), DOC);
    const { posForSourceLine } = await import('../../panels/Editor/markdown-position-map');
    const near = view.state.selection.constructor.near(view.state.doc.resolve(posForSourceLine(view.state.doc, tree, 6)!));
    view.dispatch(view.state.tr.setSelection(near));
    edit.unmount();
    expect(takeMarkdownModeAnchor(TAB, 'source')).toEqual({ mode: 'edit', topLine: 1, cursorLine: 6 });

    render(<MilkdownEditor tabId={TAB} fileName={TAB} readonly defaultValue={DOC} />);
    await waitCrepe();
    cleanup();
    expect(takeMarkdownModeAnchor(TAB, 'source')).toEqual({ mode: 'preview', topLine: 1 });
  });
});
