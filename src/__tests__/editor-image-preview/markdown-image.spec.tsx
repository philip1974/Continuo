// @vitest-environment jsdom
// Markdown 图片:相对路径按文档目录解析、经受控通道(workspaceOnly)加载;https / data 原样;http / file 不加载;
// 失败渲染 alt 占位;源文本不被改写(真实 Crepe)。行为见同目录 README。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { resolveMarkdownImageSource } from '../../panels/Editor/markdown-image-view';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { t } from '../../i18n';

const mocks = vi.hoisted(() => ({ readImage: vi.fn(), instances: [] as CrepeType[] }));

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
  coApi: { fs: { readImage: mocks.readImage } },
}));

const MD = '/w/docs/a.md';
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  mocks.readImage.mockReset();
  mocks.readImage.mockResolvedValue({ ok: true, data: { dataUrl: DATA_URL, size: 8 } });
});
afterEach(() => {
  cleanup();
  mocks.instances.length = 0;
});

describe('resolveMarkdownImageSource', () => {
  it('相对 / 绝对本地路径 → 按文档目录解析成本地文件(含 %20 解码、.. 折叠)', () => {
    expect(resolveMarkdownImageSource('./q.png', MD)).toEqual({ kind: 'file', absPath: '/w/docs/q.png' });
    expect(resolveMarkdownImageSource('../img/my%20q.png', MD)).toEqual({ kind: 'file', absPath: '/w/img/my q.png' });
    expect(resolveMarkdownImageSource('/w/q.gif', MD)).toEqual({ kind: 'file', absPath: '/w/q.gif' });
  });

  it('https / data:image → 原样加载', () => {
    expect(resolveMarkdownImageSource('https://x.test/a.png', MD)).toEqual({ kind: 'url', url: 'https://x.test/a.png' });
    expect(resolveMarkdownImageSource(DATA_URL, MD)).toEqual({ kind: 'url', url: DATA_URL });
  });

  it('http / file: / 其它协议 / 非图片扩展名 / 空 → 不加载', () => {
    for (const src of ['http://x.test/a.png', 'file:///etc/a.png', 'javascript:alert(1)', './notes.txt', './a.svg', '', 'data:text/html,x']) {
      expect(resolveMarkdownImageSource(src, MD)).toBeNull();
    }
  });
});

async function waitMounted(): Promise<CrepeType> {
  for (let i = 0; i < 100; i++) {
    const crepe = mocks.instances.at(-1);
    if (crepe) {
      try {
        if (crepe.editor.ctx.get<{ state?: unknown }, 'editorView'>('editorView').state) {
          await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
          });
          return crepe;
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

interface TypingView {
  readonly state: {
    readonly selection: { readonly from: number; readonly to: number };
    readonly tr: { insertText(text: string, from: number, to: number): unknown };
  };
  dispatch(tr: unknown): void;
  someProp(name: 'handleTextInput', f: (fn: (...args: unknown[]) => boolean) => boolean): boolean | undefined;
}

/** 逐字键入:先交给 handleTextInput(输入规则在此生效),无人处理则按默认插入(同浏览器输入路径)。 */
function typeText(view: TypingView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(ch, from, to);
    if (!view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert))) view.dispatch(insert());
  }
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Milkdown 渲染 Markdown 图片(真实 Crepe)', () => {
  it.each([false, true])('相对图片经 readImage(workspaceOnly)加载为 data URL,源文本不变(readonly=%s)', async (readonly) => {
    const { container } = render(
      <MilkdownEditor tabId={MD} fileName={MD} defaultValue={'![logo](./q.png)\n'} readonly={readonly} />,
    );
    const crepe = await waitMounted();
    await flush();
    expect(mocks.readImage).toHaveBeenCalledWith('/w/docs/q.png', { workspaceOnly: true, documentPath: MD });
    const img = container.querySelector('.co-md-image img')!;
    expect(img.getAttribute('src')).toBe(DATA_URL);
    expect(img.getAttribute('alt')).toBe('logo');
    expect(crepe.getMarkdown()).toContain('![logo](./q.png)');
  });

  it('加载失败(工作区外等)→ alt 文字占位,无 <img>', async () => {
    mocks.readImage.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'outside workspace' });
    const { container } = render(<MilkdownEditor tabId={MD} fileName={MD} defaultValue={'![logo](../../etc/q.png)\n'} />);
    await waitMounted();
    await flush();
    expect(container.querySelector('.co-md-image img')).toBeNull();
    const ph = container.querySelector('.ProseMirror [role="img"]')!;
    expect(ph.textContent).toContain('logo');
    expect(ph.getAttribute('aria-label')).toBe(t('editor.md.image_unavailable', { name: 'logo' }));
  });

  // 对齐 Milkdown 默认(commonmark insertImageInputRule)与 VSCode Markdown 编辑:键入完整图片语法即成图片,
  // 不再被转义成文本 `!\[pic]\(./img/a.jpg)` 保存。
  it('编辑模式键入 `![pic](./img/a.jpg)` → 图片节点(经受控通道加载),序列化回原样', async () => {
    const { container } = render(<MilkdownEditor tabId={MD} fileName={MD} defaultValue={''} />);
    const crepe = await waitMounted();
    const view = crepe.editor.ctx.get<TypingView, 'editorView'>('editorView');
    act(() => typeText(view, '![pic](./img/a.jpg)'));
    await flush();
    expect(mocks.readImage).toHaveBeenCalledWith('/w/docs/img/a.jpg', expect.objectContaining({ workspaceOnly: true }));
    expect(container.querySelector('.co-md-image img')?.getAttribute('alt')).toBe('pic');
    const md = crepe.getMarkdown();
    expect(md).toContain('![pic](./img/a.jpg)');
    expect(md).not.toContain('\\[');
  });

  it('http 图片不请求、直接 alt 占位;https 原样作为 src', async () => {
    const { container } = render(
      <MilkdownEditor
        tabId={MD}
        fileName={MD}
        defaultValue={'![a](http://x.test/a.png) ![b](https://x.test/b.png)\n'}
      />,
    );
    await waitMounted();
    await flush();
    expect(mocks.readImage).not.toHaveBeenCalled();
    const imgs = container.querySelectorAll('.co-md-image img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('src')).toBe('https://x.test/b.png');
    expect(container.querySelector('.ProseMirror [role="img"]')!.textContent).toContain('a');
  });
});
