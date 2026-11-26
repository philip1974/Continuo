// @vitest-environment jsdom
// Editor 弹出 / 收回 popout 后已挂载编辑器按面板所在文档取选区(见同目录 README.md)。
// 真实 CodeMirror / Crepe:把 EditorPanel 的 DOM 移进 iframe 子文档(模拟 dockview popout 只移 DOM、不重挂 React),
// 再触发面板 location 变化。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewPanelApi } from 'dockview-react';
import { EditorView } from '@codemirror/view';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { makeChildDocument, type ChildDocument } from '../_helpers/child-document';
import { flushMacrotasks, flushMicrotasks } from '../_helpers/async';

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
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({ notify: { warn: vi.fn(), error: vi.fn() } }));

type LocationApi = Pick<DockviewPanelApi, 'onDidLocationChange'>;
type LocationListener = Parameters<DockviewPanelApi['onDidLocationChange']>[0];

function createLocationApi() {
  const listeners = new Set<LocationListener>();
  const dispose = vi.fn();
  const api = {
    onDidLocationChange: (listener: LocationListener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          dispose();
          listeners.delete(listener);
        },
      };
    },
  } as unknown as LocationApi;
  return {
    api,
    dispose,
    fire: (type: 'popout' | 'grid') => {
      const event = (
        type === 'popout'
          ? { location: { type: 'popout', getWindow: () => window } }
          : { location: { type: 'grid' } }
      ) as Parameters<LocationListener>[0];
      for (const l of [...listeners]) l(event);
    },
  };
}

interface PmView {
  readonly root: Document | ShadowRoot;
  readonly state?: unknown;
  readonly dom: HTMLElement;
  updateRoot(): void;
}

function pmViewOf(crepe: CrepeType): PmView {
  return crepe.editor.ctx.get<PmView, 'editorView'>('editorView');
}

async function waitFor<T>(probe: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    let v: T | null | undefined = null;
    try {
      v = probe();
    } catch {
      /* 尚未就绪 */
    }
    if (v) return v;
    await act(async () => {
      await flushMacrotasks();
    });
  }
  throw new Error('等待超时');
}

async function renderPanel(api: LocationApi): Promise<HTMLElement> {
  const { container } = render(<EditorPanel api={api} />);
  return container;
}

/** 模拟 dockview popout:面板 DOM 移进另一文档(jsdom appendChild 跨文档即 adopt),再发 location 变化。 */
async function moveTo(
  container: HTMLElement,
  host: HTMLElement,
  loc: ReturnType<typeof createLocationApi>,
  type: 'popout' | 'grid',
): Promise<void> {
  host.appendChild(container);
  loc.fire(type);
  await act(async () => {
    await flushMicrotasks(2);
  });
}

let child: ChildDocument;

/** jsdom 的 Range 无布局方法,CodeMirror 测量时会报错刷屏;主窗与子窗(iframe 各有一份 Range)都补空实现。 */
function stubRangeLayout(win: Window): void {
  const proto = (win as Window & typeof globalThis).Range.prototype;
  if (!proto.getClientRects) Object.defineProperty(proto, 'getClientRects', { value: () => [] });
  if (!proto.getBoundingClientRect) {
    Object.defineProperty(proto, 'getBoundingClientRect', {
      value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    });
  }
}

beforeEach(() => {
  child = makeChildDocument();
  stubRangeLayout(window);
  stubRangeLayout(child.win);
  instances.length = 0;
});
afterEach(() => {
  cleanup();
  child.dispose();
  vi.restoreAllMocks();
});

describe('Editor popout:已挂载编辑器跟随面板所在文档', () => {
  it('代码文件:弹出后 CodeMirror root = 子窗文档,收回后回到主窗文档;视图不重建', async () => {
    useEditorStore.setState({
      tabs: [createTab('/w/a.ts', 'const a = 1;\n')],
      activeTabId: '/w/a.ts',
      mode: 'edit',
    });
    const setRoot = vi.spyOn(EditorView.prototype, 'setRoot');
    const loc = createLocationApi();
    const container = await renderPanel(loc.api);
    const cmEl = await waitFor(() => container.querySelector<HTMLElement>('.cm-editor'));
    const view = EditorView.findFromDOM(cmEl)!;
    expect(view.root).toBe(document);

    await moveTo(container, child.host, loc, 'popout');
    expect(EditorView.findFromDOM(cmEl)).toBe(view);
    expect(setRoot).toHaveBeenCalledWith(child.doc);
    expect(view.root).toBe(child.doc);

    await moveTo(container, document.body, loc, 'grid');
    expect(setRoot).toHaveBeenLastCalledWith(document);
    expect(view.root).toBe(document);
  });

  // VSCode Move Editor Group into New Window:光标 / 选区不变。CodeMirror 缓存「上次写入 / 读到的 DOM 选区」:节点随面板
  // 移进子窗后缓存与光标位置仍「等价」,focus 时便不把 state 选区写进子窗文档;子窗随后报告的默认起点选区覆盖 state
  //(光标回到第 1 行,接着输入插到文件开头)。
  it('代码文件:弹出 / 收回后获焦,DOM 选区按 state 写进所在文档(光标不回到第 1 行),多次往返同理', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    useEditorStore.setState({ tabs: [createTab('/w/a.ts', text)], activeTabId: '/w/a.ts', mode: 'edit' });
    const loc = createLocationApi();
    const container = await renderPanel(loc.api);
    const cmEl = await waitFor(() => container.querySelector<HTMLElement>('.cm-editor'));
    const view = EditorView.findFromDOM(cmEl)!;
    const head = view.state.doc.line(30).from + 3;
    view.focus();
    view.dispatch({ selection: { anchor: head } });
    const domHead = (doc: Document) => {
      const sel = doc.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.focusNode) return null;
      return view.posAtDOM(sel.focusNode, sel.focusOffset);
    };
    expect(domHead(document)).toBe(head);

    for (const [host, doc, type] of [
      [child.host, child.doc, 'popout'],
      [document.body, document, 'grid'],
      [child.host, child.doc, 'popout'],
    ] as const) {
      // 移走前另一文档的选区留在别处(主窗焦点转走 / 子窗旧选区),模拟真实窗口
      (doc === document ? document : child.doc).getSelection()?.removeAllRanges();
      await moveTo(container, host, loc, type);
      view.focus();
      expect(domHead(doc)).toBe(head);
      expect(view.state.selection.main.head).toBe(head);
    }
  });

  it('代码文件:移动落定(重绑)前焦点已进新文档里的编辑器 → 重绑时按 state 写 DOM 选区', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    useEditorStore.setState({ tabs: [createTab('/w/a.ts', text)], activeTabId: '/w/a.ts', mode: 'edit' });
    const loc = createLocationApi();
    const container = await renderPanel(loc.api);
    const cmEl = await waitFor(() => container.querySelector<HTMLElement>('.cm-editor'));
    const view = EditorView.findFromDOM(cmEl)!;
    const head = view.state.doc.line(20).from;
    view.focus();
    view.dispatch({ selection: { anchor: head } });

    child.host.appendChild(container);
    view.focus(); // root 仍是主窗文档:不归它管,不写选区
    // 移动落定距获焦已久(CodeMirror「获焦 200ms 内起点选区按 state 复位」的兜底不再生效)
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
    loc.fire('popout');
    await act(async () => {
      await flushMicrotasks(2);
    });
    const sel = child.doc.getSelection()!;
    expect(child.doc.activeElement).toBe(view.contentDOM);
    expect(sel.focusNode && view.posAtDOM(sel.focusNode, sel.focusOffset)).toBe(head);
  });

  it('Markdown 编辑:ProseMirror updateRoot 后 root = 子窗文档,正文代码块的 CodeMirror 同步;收回同理', async () => {
    useEditorStore.setState({
      tabs: [createTab('/w/a.md', '# T\n\n```js\nlet x = 1;\n```\n')],
      activeTabId: '/w/a.md',
      mode: 'edit',
    });
    const loc = createLocationApi();
    const container = await renderPanel(loc.api);
    const pm = await waitFor(() => {
      const crepe = instances.at(-1);
      const v = crepe ? pmViewOf(crepe) : null;
      return v?.state ? v : null;
    });
    const blockEl = await waitFor(() => container.querySelector<HTMLElement>('.cm-editor'));
    const block = EditorView.findFromDOM(blockEl)!;
    const updateRoot = vi.spyOn(pm, 'updateRoot');
    expect(pm.root).toBe(document);

    await moveTo(container, child.host, loc, 'popout');
    expect(updateRoot).toHaveBeenCalled();
    expect(pm.root).toBe(child.doc);
    expect(block.root).toBe(child.doc);
    expect(pmViewOf(instances.at(-1)!)).toBe(pm);

    await moveTo(container, document.body, loc, 'grid');
    expect(pm.root).toBe(document);
    expect(block.root).toBe(document);
  });

  it('Markdown 编辑:ProseMirror 的 selectionchange 监听随弹出 / 收回迁移(旧文档移除、新文档挂上)', async () => {
    useEditorStore.setState({
      tabs: [createTab('/w/a.md', '# T\n')],
      activeTabId: '/w/a.md',
      mode: 'edit',
    });
    const loc = createLocationApi();
    const container = await renderPanel(loc.api);
    const pm = await waitFor(() => {
      const crepe = instances.at(-1);
      const v = crepe ? (pmViewOf(crepe) as PmView & { domObserver?: { onSelectionChange: EventListener } }) : null;
      return v?.state ? v : null;
    });
    const handler = pm.domObserver!.onSelectionChange;
    const selectionCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([type, fn]) => type === 'selectionchange' && fn === handler).length;
    const mainAdd = vi.spyOn(document, 'addEventListener');
    const mainRemove = vi.spyOn(document, 'removeEventListener');
    const childAdd = vi.spyOn(child.doc, 'addEventListener');
    const childRemove = vi.spyOn(child.doc, 'removeEventListener');

    await moveTo(container, child.host, loc, 'popout');
    expect(selectionCalls(mainRemove)).toBe(1);
    expect(selectionCalls(childAdd)).toBe(1);

    await moveTo(container, document.body, loc, 'grid');
    expect(selectionCalls(childRemove)).toBe(1);
    expect(selectionCalls(mainAdd)).toBe(1);
  });

  it('面板卸载时退订 location 变化', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
    const loc = createLocationApi();
    render(<EditorPanel api={loc.api} />);
    cleanup();
    expect(loc.dispose).toHaveBeenCalledTimes(1);
  });
});
