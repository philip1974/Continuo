import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp } from '@/plugins/co-app';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { scrollToLine } from '@/panels/Editor/scrollToLine';
import { useEditorStore } from '@/stores/editor.store';

vi.mock('@/panels/Editor/editor-file-actions', () => ({
  openFileByPath: vi.fn(),
}));

vi.mock('@/panels/Editor/scrollToLine', () => ({
  scrollToLine: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { readFile: vi.fn(), writeFile: vi.fn() } },
}));

const mockedOpenFileByPath = vi.mocked(openFileByPath);
const mockedScrollToLine = vi.mocked(scrollToLine);
const view = { id: 'view' };

beforeEach(() => {
  vi.clearAllMocks();
  mockedOpenFileByPath.mockResolvedValue({ ok: true, data: undefined });
  mockedScrollToLine.mockReturnValue('applied');
  useEditorStore.setState({
    tabs: [
      {
        id: '/work/a.ts',
        filePath: '/work/a.ts',
        content: 'one\ntwo',
        originalContent: 'one\ntwo',
        dirty: false,
      },
    ],
    activeTabId: '/work/a.ts',
    mode: 'edit',
    waitForViewRef: vi.fn(async () => view),
  } as unknown as Partial<ReturnType<typeof useEditorStore.getState>>);
});

describe('app.editor.openFile line jump', () => {
  it('T1 scrolls a CodeMirror file to the requested line', async () => {
    const result = await coApp.editor.openFile('/work/a.ts', { line: 2 });

    expect(useEditorStore.getState().waitForViewRef).toHaveBeenCalledWith(
      '/work/a.ts',
      500,
    );
    expect(mockedScrollToLine).toHaveBeenCalledWith(view, 2);
    expect(result).toEqual({ ok: true, lineApplied: true });
  });

  it('T1b line jump tab lookup 走单趟 helper,不调用 tabs.find', async () => {
    const tabs = useEditorStore.getState().tabs;
    const findSpy = vi.spyOn(tabs, 'find');

    try {
      const result = await coApp.editor.openFile('/work/a.ts', { line: 2 });

      expect(result).toEqual({ ok: true, lineApplied: true });
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('T2 does not scroll when line is omitted', async () => {
    const result = await coApp.editor.openFile('/work/a.ts');

    expect(mockedScrollToLine).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'no-line-arg',
    });
  });

  // 跨平台(codex 复查 P2,X10 的 SDK 兄弟):Windows 上插件传的 path 与既有 tab id 仅大小写
  // 不同时,须用 pathEquals 找到 tab 并用其真实 id 查 viewRef,否则行号跳转失败。
  it('T-win Windows 大小写不同 path → 用已开 tab 真实 id 查 viewRef 并跳行', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      const waitForViewRef = vi.fn(async () => view);
      useEditorStore.setState({
        tabs: [
          {
            id: 'C:\\Work\\a.ts',
            filePath: 'C:\\Work\\a.ts',
            content: 'one\ntwo',
            originalContent: 'one\ntwo',
            dirty: false,
          },
        ],
        activeTabId: 'C:\\Work\\a.ts',
        mode: 'edit',
        waitForViewRef,
      } as unknown as Partial<ReturnType<typeof useEditorStore.getState>>);

      const result = await coApp.editor.openFile('c:\\work\\a.ts', { line: 2 });

      expect(waitForViewRef).toHaveBeenCalledWith('C:\\Work\\a.ts', 500);
      expect(mockedScrollToLine).toHaveBeenCalledWith(view, 2);
      expect(result).toEqual({ ok: true, lineApplied: true });
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });
});
