// @vitest-environment jsdom
// BDD:从 Finder 拖磁盘文件到编辑器(见同目录 README 行为表):不按 ⇧ → 打开(当前文档不变,绝不把文件内容插进来);
// 按住 ⇧ → 插入路径 / 链接;Markdown 里的图片照旧存图插入(fb5a41fd)。编辑器面板(这里用带 data-editor-group-id 的父元素 +
// openOsDroppedFiles 模拟 EditorPanel 的 onDrop)打开编辑器内容没认领的文件。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Crepe as CrepeType } from '@milkdown/crepe';

const mocks = vi.hoisted(() => ({
  instances: [] as CrepeType[],
  paths: new Map<File, string>(),
}));
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
  coApi: {
    fs: {
      readImage: vi.fn(async () => ({ ok: false, code: 'FS_NOT_FOUND' })),
      saveDocumentImage: vi.fn(async (doc: string, name: string) => ({ ok: true, data: `${doc.slice(0, doc.lastIndexOf('/'))}/${name}` })),
    },
    window: { getPathForFile: (f: File) => mocks.paths.get(f) ?? '' },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { codeMirrorMediaDrop } from '@/panels/Editor/codemirror-media-drop';
import { MilkdownEditor } from '@/panels/Editor/MilkdownEditor';
import { openOsDroppedFiles } from '@/panels/Editor/os-file-drop';
import { useWorkspaceStore } from '@/stores/workspace.store';

function diskFile(path: string, type = ''): File {
  const f = new File(['FILE CONTENT MUST NOT BE INSERTED'], path.slice(path.lastIndexOf('/') + 1), { type });
  mocks.paths.set(f, path);
  return f;
}
const TXT = () => diskFile('/outside/notes.txt', 'text/plain');
const PNG = () => diskFile('/outside/pic.png', 'image/png');

/** Finder 拖放:types 只有 Files,每个 item 可判定为文件(isDirectory 由参数给)。 */
function osDrop(files: File[], opts: { shiftKey?: boolean; directories?: boolean[] } = {}): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        types: ['Files'],
        files,
        items: files.map((_f, i) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: opts.directories?.[i] ?? false }) })),
        getData: () => '',
      },
    },
    shiftKey: { value: opts.shiftKey ?? false },
    clientX: { value: 0 },
    clientY: { value: 0 },
  });
  return event;
}

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

let open = vi.fn();
beforeEach(() => {
  open = vi.fn();
  useWorkspaceStore.setState({ root: '/w' });
});

/** 模拟 EditorPanel:组根元素上的 drop(冒泡阶段)→ openOsDroppedFiles(event, 组 id)。 */
function panel(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-editor-group-id', 'editor-2');
  root.addEventListener('drop', (e) => openOsDroppedFiles(e as DragEvent, 'editor-2', open));
  document.body.append(root);
  return root;
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  cleanup();
  document.body.replaceChildren();
  mocks.instances.length = 0;
  mocks.paths.clear();
});

function codeView(doc: string, path: string, markdown: boolean, readOnly = false): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [codeMirrorMediaDrop({ documentPath: () => path, markdown }), EditorState.readOnly.of(readOnly)],
    }),
    parent: panel(),
  });
  view.posAtCoords = (() => doc.length) as never;
  views.push(view);
  return view;
}

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

describe('代码编辑器(CodeMirror)', async () => {
  it('拖入工作区外的 txt:当前文档不变(不插入文件内容),在该组打开被拖文件', async () => {
    const view = codeView('const a = 1;\n', '/w/src/code.ts', false);
    view.contentDOM.dispatchEvent(osDrop([TXT()]));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('const a = 1;\n');
    expect(open).toHaveBeenCalledWith(['/outside/notes.txt'], 'editor-2');
  });

  it('拖入 png → 打开(图片预览);多个文件 → 全部打开', async () => {
    const view = codeView('x', '/w/src/code.ts', false);
    view.contentDOM.dispatchEvent(osDrop([PNG()]));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    view.contentDOM.dispatchEvent(osDrop([TXT(), PNG(), diskFile('/w/src/other.ts')]));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('x');
    expect(open.mock.calls).toEqual([
      [['/outside/pic.png'], 'editor-2'],
      [['/outside/notes.txt', '/outside/pic.png', '/w/src/other.ts'], 'editor-2'],
    ]);
  });

  it('按住 ⇧:插入路径(工作区内相对工作区根,其余绝对路径),不打开', async () => {
    const view = codeView('x', '/w/src/code.ts', false);
    view.contentDOM.dispatchEvent(osDrop([diskFile('/w/src/other.ts'), TXT()], { shiftKey: true }));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('xsrc/other.ts /outside/notes.txt');
    expect(open).not.toHaveBeenCalled();
  });

  it('只读编辑器:不插入,打开', async () => {
    const view = codeView('x', '/w/src/code.ts', false, true);
    view.contentDOM.dispatchEvent(osDrop([TXT()], { shiftKey: true }));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('x');
    expect(open).toHaveBeenCalledWith(['/outside/notes.txt'], 'editor-2');
  });

  it('拖入的有文件夹:编辑器不插入、面板不当文件打开(交给窗口级打开为工作区)', async () => {
    const view = codeView('x', '/w/src/code.ts', false);
    view.contentDOM.dispatchEvent(osDrop([diskFile('/outside/dir'), TXT()], { directories: [true, false] }));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('x');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('Markdown 源码视图(CodeMirror)', async () => {
  it('txt → 打开、文档不变;⇧ → 插入相对文档的链接、不打开', async () => {
    const view = codeView('# A\n', '/w/docs/a.md', true);
    view.contentDOM.dispatchEvent(osDrop([TXT()]));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('# A\n');
    expect(open).toHaveBeenCalledWith(['/outside/notes.txt'], 'editor-2');
    open.mockClear();
    view.contentDOM.dispatchEvent(osDrop([TXT()], { shiftKey: true }));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('# A\n[text](../../outside/notes.txt)');
    expect(open).not.toHaveBeenCalled();
  });

  it('png(不按 ⇧)→ 照旧存到文档旁并插入图片引用,不打开;同时拖的 txt 打开', async () => {
    const view = codeView('', '/w/docs/a.md', true);
    view.contentDOM.dispatchEvent(osDrop([PNG(), TXT()]));
    await flush(); // CodeMirror 内建 drop 用 FileReader 异步读文件:等它跑完再断言
    expect(view.state.doc.toString()).toBe('![alt text](pic.png)');
    expect(open).toHaveBeenCalledWith(['/outside/notes.txt'], 'editor-2');
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
          await flush();
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
  // jsdom 没有布局:ProseMirror 接着处理 drop 时取落点;drop 指示器 30 ms 后收起(等它跑完再卸载)
  beforeAll(() => {
    document.elementFromPoint ??= () => null;
    // jsdom 没有 DragEvent(Crepe 上传器按 instanceof 判断;这里合成的是普通 Event,上传器不接手,只验证面板不打开图片)
    (globalThis as { DragEvent?: unknown }).DragEvent ??= class extends Event {};
  });
  afterEach(() => act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  }));

  it('txt → 打开、文档不变;⇧ → 插入链接节点、不打开', async () => {
    const root = panel();
    render(<MilkdownEditor tabId="/w/docs/a.md" fileName="/w/docs/a.md" defaultValue={'hello\n'} />, { container: root });
    const { crepe, view } = await mountedMilkdown();
    await act(async () => {
      view.dom.dispatchEvent(osDrop([TXT()]));
    });
    expect(crepe.getMarkdown()).toBe('hello\n');
    expect(open).toHaveBeenCalledWith(['/outside/notes.txt'], 'editor-2');
    open.mockClear();
    await act(async () => {
      view.dom.dispatchEvent(osDrop([TXT()], { shiftKey: true }));
    });
    expect(crepe.getMarkdown()).toContain('[notes.txt](../../outside/notes.txt)');
    expect(open).not.toHaveBeenCalled();
  });

  it('png → 不由面板打开(交给 Crepe 上传器存图插入)', async () => {
    const root = panel();
    render(<MilkdownEditor tabId="/w/docs/a.md" fileName="/w/docs/a.md" defaultValue={'hello\n'} />, { container: root });
    const { view } = await mountedMilkdown();
    await act(async () => {
      view.dom.dispatchEvent(osDrop([PNG()]));
    });
    expect(open).not.toHaveBeenCalled();
  });
});
