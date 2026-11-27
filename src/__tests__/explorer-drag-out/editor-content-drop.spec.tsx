// @vitest-environment jsdom
// BDD:资源管理器的文件拖到编辑器**内容区**(对齐 VSCode):只打开,不把路径插进当前文档(代码文件 / Markdown 源码 / Markdown
// 编辑视图都一样,事件照常冒泡给 dockview 打开 / 拆分);按住 ⇧ 放到文本上 = 插入(Markdown:相对文档的链接 / 图片引用;
// 其它文件:相对工作区根的路径),此时 dockview 不接收、不打开。见同目录 README「行为 5」。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { EXPLORER_DRAG_MIME } from '@/lib/explorer-drag';

const mocks = vi.hoisted(() => ({ instances: [] as CrepeType[] }));
vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      mocks.instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_id: string, fallback: T) => fallback }));
vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { readImage: vi.fn(async () => ({ ok: false, code: 'FS_NOT_FOUND' })) }, window: { getPathForFile: () => '' } },
}));
vi.mock('@/notifications/notify', () => ({ notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { codeMirrorMediaDrop } from '@/panels/Editor/codemirror-media-drop';
import { MilkdownEditor } from '@/panels/Editor/MilkdownEditor';
import { isShiftDropIntoText, trackExplorerEditorDrop } from '@/shell/dock/explorer-editor-drop';
import { useWorkspaceStore } from '@/stores/workspace.store';

const ENTRIES = [
  { path: '/w/src/a.ts', isDirectory: false },
  { path: '/w/docs/img/logo.png', isDirectory: false },
  { path: '/w/src', isDirectory: true },
];

function explorerDrop(opts: { shiftKey?: boolean; entries?: unknown } = {}): Event {
  const data = new Map<string, string>([
    [EXPLORER_DRAG_MIME, JSON.stringify(opts.entries ?? ENTRIES)],
    ['text/plain', '/w/src/a.ts\n/w/docs/img/logo.png'],
  ]);
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { types: [EXPLORER_DRAG_MIME, 'text/uri-list', 'text/plain'], files: [], getData: (f: string) => data.get(f) ?? '' } },
    shiftKey: { value: opts.shiftKey ?? false },
    clientX: { value: 0 },
    clientY: { value: 0 },
  });
  return event;
}

beforeAll(() => {
  // jsdom 没有布局:CodeMirror 聚焦 / 滚动时量选区
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  cleanup();
  mocks.instances.length = 0;
});

function codeView(doc: string, path: string, markdown: boolean): { view: EditorView; bubbled: () => number } {
  const parent = document.createElement('div');
  document.body.append(parent);
  let bubbled = 0;
  parent.addEventListener('drop', () => bubbled++);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [codeMirrorMediaDrop({ documentPath: () => path, markdown, deps: { workspaceRoot: () => '/w' } as never })],
    }),
    parent,
  });
  view.posAtCoords = (() => doc.length) as never;
  views.push(view);
  return { view, bubbled: () => bubbled };
}

describe('CodeMirror(代码文件 / Markdown 源码)', () => {
  it.each([
    ['代码文件', '/w/src/b.ts', false],
    ['Markdown 源码', '/w/docs/a.md', true],
  ] as const)('%s:放下不插入路径,事件冒泡给 dockview 打开', (_name, path, markdown) => {
    const { view, bubbled } = codeView('x', path, markdown);
    view.contentDOM.dispatchEvent(explorerDrop());
    expect(view.state.doc.toString()).toBe('x');
    expect(bubbled()).toBe(1);
  });

  it('代码文件 ⇧ 放下:插入相对工作区根的路径(文件夹不插),空格分隔', () => {
    const { view } = codeView('x', '/w/src/b.ts', false);
    view.contentDOM.dispatchEvent(explorerDrop({ shiftKey: true }));
    expect(view.state.doc.toString()).toBe('xsrc/a.ts docs/img/logo.png');
  });

  it('Markdown 源码 ⇧ 放下:插入相对文档的链接(图片为图片引用)', () => {
    const { view } = codeView('', '/w/docs/a.md', true);
    view.contentDOM.dispatchEvent(explorerDrop({ shiftKey: true }));
    expect(view.state.doc.toString()).toBe('[text](../src/a.ts) ![alt text](img/logo.png)');
  });
});

interface PmLike {
  readonly state: unknown;
  readonly dom: HTMLElement;
}

async function mountedMilkdown(): Promise<{ crepe: CrepeType; view: PmLike }> {
  for (let i = 0; i < 100; i++) {
    const crepe = mocks.instances.at(-1);
    if (crepe) {
      try {
        const view = crepe.editor.ctx.get<PmLike, 'editorView'>('editorView');
        if (view.state) {
          await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
          });
          return { crepe, view };
        }
      } catch {
        /* 尚未就绪 */
      }
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

describe('Markdown 编辑视图(真实 Crepe)', () => {
  it('放下不改文档;⇧ 放下插入相对文档的链接 / 图片', async () => {
    useWorkspaceStore.setState({ root: '/w' });
    const { container } = render(<MilkdownEditor tabId="/w/docs/a.md" fileName="/w/docs/a.md" defaultValue={'hello\n'} />);
    const { crepe, view } = await mountedMilkdown();
    let bubbled = 0;
    container.addEventListener('drop', () => bubbled++);
    await act(async () => {
      view.dom.dispatchEvent(explorerDrop());
    });
    expect(crepe.getMarkdown()).toBe('hello\n');
    expect(bubbled).toBe(1);
    await act(async () => {
      view.dom.dispatchEvent(explorerDrop({ shiftKey: true }));
    });
    const md = crepe.getMarkdown();
    expect(md).toContain('[a.ts](../src/a.ts)');
    expect(md).toContain('![](img/logo.png)');
    expect(md).not.toContain('/w/src/a.ts');
  });

  it('放下后编辑器随即销毁(放下即打开别的文件 / 关 tab):拖放指示线的延迟隐藏不抛错', async () => {
    useWorkspaceStore.setState({ root: '/w' });
    const { unmount } = render(<MilkdownEditor tabId="/w/docs/a.md" fileName="/w/docs/a.md" defaultValue={'hello\n'} />);
    const { crepe, view } = await mountedMilkdown();
    // 截下放下时排定的计时器(拖放指示线 30ms 后隐藏),编辑器销毁后再手动触发
    const pending: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      pending.push(fn);
      return 0;
    }) as never);
    try {
      await act(async () => {
        view.dom.dispatchEvent(explorerDrop());
      });
    } finally {
      spy.mockRestore();
    }
    expect(pending.length).toBeGreaterThan(0);
    unmount();
    for (let i = 0; i < 100 && crepe.editor.status !== 'Destroyed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(crepe.editor.status).toBe('Destroyed');
    for (const fn of pending) expect(fn).not.toThrow();
  });
});

describe('dockview 放置区与 ⇧', () => {
  function setup() {
    let overL: ((e: unknown) => void) | null = null;
    let dropL: ((e: unknown) => void) | null = null;
    const open = vi.fn();
    trackExplorerEditorDrop(
      {
        onUnhandledDragOverEvent: (l: (e: unknown) => void) => ((overL = l), { dispose() {} }),
        onDidDrop: (l: (e: unknown) => void) => ((dropL = l), { dispose() {} }),
      } as never,
      open,
    );
    return { open, over: (e: unknown) => overL!(e), drop: (e: unknown) => dropL!(e) };
  }
  const editable = () => {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    el.append(inner);
    return inner;
  };
  const group = { activePanel: { id: 'editor', view: { contentComponent: 'editor' } } };
  const dt = { types: [EXPLORER_DRAG_MIME], getData: () => JSON.stringify([{ path: '/w/a.ts', isDirectory: false }]) };

  it('⇧ 在可编辑文本上:不显示放置高亮、放下不打开;不按 ⇧ / 不在文本上照常', () => {
    const { open, over, drop } = setup();
    let accepted = 0;
    const ev = (shiftKey: boolean, target: unknown) => ({
      nativeEvent: { dataTransfer: dt, shiftKey, target },
      target: 'content',
      position: 'center',
      group,
      getData: () => undefined,
      accept: () => accepted++,
    });
    over(ev(true, editable()));
    drop(ev(true, editable()));
    expect(accepted).toBe(0);
    expect(open).not.toHaveBeenCalled();
    over(ev(false, editable()));
    drop(ev(false, editable()));
    over(ev(true, document.createElement('div')));
    expect(accepted).toBe(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(isShiftDropIntoText({ shiftKey: true, target: editable() } as never)).toBe(true);
  });
});
