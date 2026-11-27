// @vitest-environment jsdom
// Markdown 源码视图(CodeMirror)里粘贴截图 / 拖入图片:存成文档旁的文件后插入 `![alt text](相对路径)` 并选中 alt 占位;
// 存图期间的输入不丢、插入点随之映射;一次撤销撤回插入;剪贴板有文字时照常粘贴文字;存不下来什么都不插。
// 代码文件不接图片。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';

vi.mock('../../notifications/notify', () => ({ notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../lib/co-api', () => ({ coApi: {} }));

import { codeMirrorMediaDrop } from '../../panels/Editor/codemirror-media-drop';
import type { MediaStoreDeps } from '../../panels/Editor/editor-media-drop';

const DOC = '/w/docs/a.md';
let views: EditorView[] = [];

function makeView(doc: string, opts: { markdown?: boolean; deps: MediaStoreDeps; path?: string }): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [history(), codeMirrorMediaDrop({ documentPath: () => opts.path ?? DOC, markdown: opts.markdown ?? true, deps: opts.deps })],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function deferredDeps(): { deps: MediaStoreDeps; resolve: () => void } {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  return {
    resolve,
    deps: {
      getPathForFile: () => '',
      workspaceRoot: () => '/w',
      readBytes: async () => new Uint8Array([0x89]),
      saveImage: async (_d, name) => {
        await gate;
        return { ok: true, data: `/w/docs/${name === 'image.png' ? 'image 1.png' : name}` };
      },
    },
  };
}

function clipboardEvent(files: File[], text = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  return event;
}

const png = () => new File([new Uint8Array([0x89])], 'image.png', { type: 'image/png' });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  views = [];
  // jsdom 没有布局:CodeMirror 滚动到选区时量 Range
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  for (const v of views) v.destroy();
});

describe('Markdown 源码视图粘贴图片', () => {
  it('粘贴截图 → 存图完成后插入相对路径(空格 → `<…>`)并选中 alt 占位;期间的输入保留在插入点之前', async () => {
    const { deps, resolve } = deferredDeps();
    const view = makeView('ab', { deps });
    view.dispatch({ selection: { anchor: 1 } });
    const event = clipboardEvent([png()]);
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // 存图期间在插入点前输入
    view.dispatch({ changes: { from: 0, insert: 'X' } });
    resolve();
    await settle();
    await settle();
    expect(view.state.doc.toString()).toBe('Xa![alt text](<image 1.png>)b');
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe('alt text');
    expect(view.state.doc.toString()).not.toMatch(/blob:|data:/);
    // 一次撤销撤回插入(之前的输入另算一步)
    undo(view);
    expect(view.state.doc.toString()).toBe('Xab');
  });

  it('剪贴板里有文字 → 不拦截(照常粘贴文字)', () => {
    const { deps } = deferredDeps();
    const view = makeView('', { deps });
    const event = clipboardEvent([png()], 'hello');
    view.contentDOM.dispatchEvent(event);
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('存不下来(写入失败)→ 什么都不插', async () => {
    const view = makeView('ab', {
      deps: {
        getPathForFile: () => '',
        workspaceRoot: () => '/w',
        readBytes: async () => new Uint8Array([1]),
        saveImage: async () => ({ ok: false as const, code: 'FS_DENIED', message: 'denied' }),
      },
    });
    view.contentDOM.dispatchEvent(clipboardEvent([png()]));
    await settle();
    await settle();
    expect(view.state.doc.toString()).toBe('ab');
  });

  it('代码文件(非 Markdown)不接图片粘贴', async () => {
    const { deps } = deferredDeps();
    const view = makeView('ab', { deps, markdown: false, path: '/w/a.ts' });
    view.contentDOM.dispatchEvent(clipboardEvent([png()]));
    await settle();
    expect(view.state.doc.toString()).toBe('ab');
  });
});
