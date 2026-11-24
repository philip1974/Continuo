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

  it('面板卸载时退订 location 变化', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
    const loc = createLocationApi();
    render(<EditorPanel api={loc.api} />);
    cleanup();
    expect(loc.dispose).toHaveBeenCalledTimes(1);
  });
});
