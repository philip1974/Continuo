// @vitest-environment jsdom
// Markdown 编辑视图(真实 Crepe)里粘贴截图:不再写 `![](blob:…)` —— 图片经主进程存到文档旁,文档里是相对路径;
// 粘贴的 HTML 里 data: / blob: 图片被丢掉并提示;一次撤销撤回插入。行为见同目录 README。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { undo } from '@milkdown/kit/prose/history';
import type { EditorView } from '@milkdown/kit/prose/view';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { t } from '../../i18n';

const mocks = vi.hoisted(() => ({
  instances: [] as CrepeType[],
  saveDocumentImage: vi.fn(),
  getPathForFile: vi.fn(() => ''),
  warn: vi.fn(),
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
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readImage: vi.fn(async () => ({ ok: true, data: { dataUrl: 'data:image/png;base64,AA==', size: 1 } })),
      saveDocumentImage: mocks.saveDocumentImage,
    },
    window: { getPathForFile: mocks.getPathForFile },
  },
}));
vi.mock('../../notifications/notify', () => ({ notify: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));

const MD = '/w/docs/a.md';

interface PmViewLike {
  readonly state: { readonly doc: unknown };
  readonly dom: HTMLElement;
  someProp(name: string, f: (fn: (...args: unknown[]) => unknown) => unknown): unknown;
  pasteHTML(html: string, event?: Event): boolean;
}

async function mounted(): Promise<{ crepe: CrepeType; view: PmViewLike }> {
  for (let i = 0; i < 100; i++) {
    const crepe = mocks.instances.at(-1);
    if (crepe) {
      try {
        const view = crepe.editor.ctx.get<PmViewLike, 'editorView'>('editorView');
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

// jsdom 没有 ClipboardEvent / DragEvent(上传插件按 instanceof 判断事件类型)
class FakeClipboardEvent extends Event {
  constructor(readonly clipboardData: { files: File[]; getData: (t: string) => string }) {
    super('paste', { bubbles: true, cancelable: true });
  }
}
class FakeDragEvent extends Event {}
const globals = globalThis as { ClipboardEvent?: unknown; DragEvent?: unknown };
const savedGlobals = { ClipboardEvent: globals.ClipboardEvent, DragEvent: globals.DragEvent };
beforeAll(() => {
  globals.ClipboardEvent = FakeClipboardEvent;
  globals.DragEvent = FakeDragEvent;
});
afterAll(() => {
  globals.ClipboardEvent = savedGlobals.ClipboardEvent;
  globals.DragEvent = savedGlobals.DragEvent;
});

async function paste(view: PmViewLike, files: File[]): Promise<void> {
  const event = new FakeClipboardEvent({ files, getData: () => '' });
  await act(async () => {
    view.someProp('handlePaste', (f) => f(view, event, null));
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const png = (name = 'image.png') => new File([new Uint8Array([0x89, 0x50])], name, { type: 'image/png' });

beforeEach(() => {
  useWorkspaceStore.setState({ root: '/w' });
  mocks.saveDocumentImage.mockReset();
  mocks.saveDocumentImage.mockImplementation(async (_doc: string, name: string) => ({
    ok: true,
    data: `/w/docs/${name === 'image.png' ? 'my shot.png' : name}`,
  }));
  mocks.getPathForFile.mockReset();
  mocks.getPathForFile.mockReturnValue('');
  mocks.warn.mockReset();
});
afterEach(() => {
  cleanup();
  mocks.instances.length = 0;
});

describe('Markdown 编辑视图粘贴图片(真实 Crepe)', () => {
  it('粘贴截图 → 存到文档旁,文档里是相对路径(空格 → `<…>`),没有 blob: / data:', async () => {
    render(<MilkdownEditor tabId={MD} fileName={MD} defaultValue={'hello\n'} />);
    const { crepe, view } = await mounted();
    await paste(view, [png()]);
    expect(mocks.saveDocumentImage).toHaveBeenCalledWith(MD, 'image.png', expect.any(Uint8Array));
    const md = crepe.getMarkdown();
    expect(md).toContain('![](<my shot.png>)');
    expect(md).not.toMatch(/blob:|data:/);
    // 一次撤销撤回插入(图片文件留着)
    const pm = view as unknown as EditorView;
    act(() => {
      undo(pm.state, pm.dispatch);
    });
    expect(crepe.getMarkdown()).toBe('hello\n');
  });

  it('Finder 拖来、工作区内的图片 → 直接引用相对路径,不复制', async () => {
    mocks.getPathForFile.mockReturnValue('/w/assets/logo.png');
    render(<MilkdownEditor tabId={MD} fileName={MD} defaultValue={'hello\n'} />);
    const { crepe, view } = await mounted();
    await paste(view, [png('logo.png')]);
    expect(mocks.saveDocumentImage).not.toHaveBeenCalled();
    expect(crepe.getMarkdown()).toContain('![](../assets/logo.png)');
  });

  it('存不下来 → 什么都不插(文档不变)', async () => {
    mocks.saveDocumentImage.mockResolvedValue({ ok: false, code: 'FS_DENIED' });
    render(<MilkdownEditor tabId={MD} fileName={MD} defaultValue={'hello\n'} />);
    const { crepe, view } = await mounted();
    await paste(view, [png()]);
    expect(crepe.getMarkdown()).toBe('hello\n');
  });

  it('粘贴的 HTML 里 data: 图片被丢掉并提示,其余内容照常粘贴', async () => {
    render(<MilkdownEditor tabId={MD} fileName={MD} defaultValue={'hello\n'} />);
    const { crepe, view } = await mounted();
    await act(async () => {
      const html = '<p>pasted<img src="data:image/png;base64,iVBORw0KGgo=" alt="x"></p>';
      view.pasteHTML(html, new FakeClipboardEvent({ files: [], getData: (type) => (type === 'text/html' ? html : '') }));
    });
    const md = crepe.getMarkdown();
    expect(md).toContain('pasted');
    expect(md).not.toContain('data:');
    expect(mocks.warn).toHaveBeenCalledWith(t('editor.media.inline_image_skipped'));
  });
});
