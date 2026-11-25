import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp } from '@/plugins/co-app';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { scrollToLine } from '@/panels/Editor/scrollToLine';
import { useEditorStore } from '@/stores/editor.store';
import { revealInMarkdown } from '@/panels/Editor/markdown-reveal-registry';
import type { EditorView } from '@codemirror/view';

vi.mock('@/panels/Editor/editor-file-actions', () => ({
  openFileByPath: vi.fn(),
}));

vi.mock('@/panels/Editor/scrollToLine', () => ({
  scrollToLine: vi.fn(),
}));

vi.mock('@/panels/Editor/markdown-reveal-registry', () => ({
  revealInMarkdown: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { readFile: vi.fn(), writeFile: vi.fn() } },
}));

const mockedOpenFileByPath = vi.mocked(openFileByPath);
const mockedScrollToLine = vi.mocked(scrollToLine);
const mockedReveal = vi.mocked(revealInMarkdown);
const view = { id: 'view' } as unknown as EditorView;

beforeEach(() => {
  vi.clearAllMocks();
  mockedOpenFileByPath.mockResolvedValue({ ok: true, data: undefined });
  mockedScrollToLine.mockReturnValue('applied');
  mockedReveal.mockResolvedValue('applied');
});

function setMarkdownState(mode: 'edit' | 'source', content = '# title') {
  useEditorStore.setState({
    tabs: [
      {
        id: '/work/readme.md',
        filePath: '/work/readme.md',
        content,
        originalContent: content,
        dirty: false,
      },
    ],
    activeTabId: '/work/readme.md',
    mode,
    // view 须同时是 viewRefs 中的当前注册值:openFile 跳行前按 viewRefs 复核 view 未被替换
    viewRefs: new Map([['/work/readme.md', view]]),
    waitForViewRef: vi.fn(async () => view),
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
}

describe('app.editor.openFile markdown(Milkdown 定位 / 源码模式走 CodeMirror)', () => {
  it('T1 Markdown 编辑模式(Milkdown):行 / 列 / 长度交给 Milkdown 视图定位并选中,不走 CodeMirror', async () => {
    setMarkdownState('edit');

    const result = await coApp.editor.openFile('/work/readme.md', { line: 3, column: 2, length: 4 });

    expect(mockedScrollToLine).not.toHaveBeenCalled();
    expect(mockedReveal).toHaveBeenCalledWith('/work/readme.md', { line: 3, column: 2, length: 4 });
    expect(result).toEqual({ ok: true, lineApplied: true });
  });

  it('T1b Milkdown 定位结果映射:行号超出 → line-out-of-range;视图未就绪 → tab-not-mounted;抛错 → EXCEPTION', async () => {
    setMarkdownState('edit');
    mockedReveal.mockResolvedValueOnce('out-of-range');
    expect(await coApp.editor.openFile('/work/readme.md', { line: 99 })).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'line-out-of-range',
    });
    mockedReveal.mockResolvedValueOnce('not-mounted');
    expect(await coApp.editor.openFile('/work/readme.md', { line: 1 })).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'tab-not-mounted',
    });
    mockedReveal.mockRejectedValueOnce(new Error('boom'));
    expect(await coApp.editor.openFile('/work/readme.md', { line: 1 })).toEqual({
      ok: false,
      code: 'EXCEPTION',
      message: 'boom',
    });
  });

  it('T2 treats markdown source mode as CodeMirror', async () => {
    setMarkdownState('source');

    const result = await coApp.editor.openFile('/work/readme.md', { line: 3 });

    expect(useEditorStore.getState().waitForViewRef).toHaveBeenCalledWith(
      '/work/readme.md',
      500,
    );
    expect(mockedScrollToLine).toHaveBeenCalledWith(view, 3, undefined, undefined);
    expect(result).toEqual({ ok: true, lineApplied: true });
  });

  it('T3 treats unsafe markdown edit mode as CodeMirror', async () => {
    setMarkdownState('edit', '---\nid: demo\n---\n# title\n');

    const result = await coApp.editor.openFile('/work/readme.md', { line: 10 });

    expect(useEditorStore.getState().waitForViewRef).toHaveBeenCalledWith(
      '/work/readme.md',
      500,
    );
    expect(mockedScrollToLine).toHaveBeenCalledWith(view, 10, undefined, undefined);
    expect(result).toEqual({ ok: true, lineApplied: true });
  });
});
