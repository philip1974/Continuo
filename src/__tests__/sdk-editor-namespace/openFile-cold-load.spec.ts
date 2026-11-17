// openFile(path, { line }) 的冷加载 / 并发契约(复审 eeae2535 / 6f5d3a8c 引入的回归):
// - 冷路径:Editor 面板与 CodeEditor 都是 lazy chunk。带 line 的 openFile 须主动预加载 CodeEditor
//   引擎,且挂载等待的计时从模块就绪后开始 —— 慢加载(>500ms)不得误报 tab-not-mounted。
// - 并发:等待模块期间 view 被替换(切 tab / 切 mode 重挂)→ 只对当前注册的 view 跳行,
//   不对已销毁的旧 view 跳行并谎报成功。
// - 错误契约:scrollToLine / 引擎 chunk 加载失败 → 返回 { ok:false, code:'EXCEPTION' },不 reject。
//
// 每个用例 resetModules + doMock,让动态 import 的 mock 工厂各自生效。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';

const scrollToLine = vi.fn((..._args: unknown[]) => 'applied' as const);

function tabFixture() {
  return {
    id: '/work/a.ts',
    filePath: '/work/a.ts',
    content: 'one\ntwo',
    originalContent: 'one\ntwo',
    dirty: false,
  };
}

async function loadSubject(opts: {
  preload?: () => Promise<void>;
  scrollModule?: () => Promise<{ scrollToLine: typeof scrollToLine }>;
}) {
  vi.resetModules();
  vi.doMock('@/panels/Editor/editor-file-actions', () => ({
    openFileByPath: vi.fn(async () => ({ ok: true, data: undefined })),
  }));
  vi.doMock('@/lib/co-api', () => ({
    coApi: { fs: { readFile: vi.fn(), writeFile: vi.fn() } },
  }));
  vi.doMock('@/panels/Editor/editor-engine-loaders', () => ({
    preloadCodeEditorEngine: vi.fn(opts.preload ?? (async () => undefined)),
  }));
  vi.doMock(
    '@/panels/Editor/scrollToLine',
    opts.scrollModule ?? (async () => ({ scrollToLine })),
  );
  const { coApp } = await import('@/plugins/co-app');
  const { useEditorStore } = await import('@/stores/editor.store');
  const loaders = await import('@/panels/Editor/editor-engine-loaders');
  useEditorStore.setState({
    tabs: [tabFixture()],
    activeTabId: '/work/a.ts',
    mode: 'edit',
    viewRefs: new Map(),
  });
  return { coApp, useEditorStore, loaders };
}

function fakeView(name: string): EditorView {
  return { name } as unknown as EditorView;
}

beforeEach(() => {
  scrollToLine.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('@/panels/Editor/editor-file-actions');
  vi.doUnmock('@/lib/co-api');
  vi.doUnmock('@/panels/Editor/editor-engine-loaders');
  vi.doUnmock('@/panels/Editor/scrollToLine');
});

describe('app.editor.openFile 冷加载与并发', () => {
  it('C1 冷路径:主动预加载 CodeEditor 引擎;引擎加载慢于 500ms 仍跳行成功', async () => {
    const { coApp, useEditorStore, loaders } = await loadSubject({
      preload: () => new Promise<void>((r) => setTimeout(r, 800)),
    });
    vi.useFakeTimers();
    const view = fakeView('cold');
    // 引擎就绪后 50ms CodeEditor 挂载完成、注册 view
    setTimeout(() => useEditorStore.getState().registerView('/work/a.ts', view), 850);

    const pending = coApp.editor.openFile('/work/a.ts', { line: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(loaders.preloadCodeEditorEngine).toHaveBeenCalledTimes(1);
    expect(scrollToLine).toHaveBeenCalledWith(view, 2);
    expect(result).toEqual({ ok: true, lineApplied: true });
  });

  it('C2 引擎就绪后 500ms 内仍未挂载 → tab-not-mounted(超时仍有界)', async () => {
    const { coApp } = await loadSubject({});
    vi.useFakeTimers();

    const pending = coApp.editor.openFile('/work/a.ts', { line: 2 });
    await vi.advanceTimersByTimeAsync(600);

    expect(await pending).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'tab-not-mounted',
    });
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it('C3 加载 scrollToLine 期间 view 被替换 → 对新 view 跳行,不碰已卸载的旧 view', async () => {
    let releaseImport!: () => void;
    const gate = new Promise<void>((r) => {
      releaseImport = r;
    });
    let importStarted!: () => void;
    const started = new Promise<void>((r) => {
      importStarted = r;
    });
    const { coApp, useEditorStore } = await loadSubject({
      scrollModule: async () => {
        importStarted();
        await gate;
        return { scrollToLine };
      },
    });
    const oldView = fakeView('old');
    const newView = fakeView('new');
    useEditorStore.getState().registerView('/work/a.ts', oldView);

    const pending = coApp.editor.openFile('/work/a.ts', { line: 2 });
    await started;
    // 用户在 chunk 加载期间切走再切回 / Source↔Edit:旧 view unregister+destroy,新 view 注册
    useEditorStore.getState().unregisterView('/work/a.ts', oldView);
    useEditorStore.getState().registerView('/work/a.ts', newView);
    releaseImport();

    expect(await pending).toEqual({ ok: true, lineApplied: true });
    expect(scrollToLine).toHaveBeenCalledTimes(1);
    expect(scrollToLine).toHaveBeenCalledWith(newView, 2);
  });

  it('C4 加载 scrollToLine 期间 view 被卸载且不再挂载 → 未应用,不谎报成功', async () => {
    let releaseImport!: () => void;
    const gate = new Promise<void>((r) => {
      releaseImport = r;
    });
    let importStarted!: () => void;
    const started = new Promise<void>((r) => {
      importStarted = r;
    });
    const { coApp, useEditorStore } = await loadSubject({
      scrollModule: async () => {
        importStarted();
        await gate;
        return { scrollToLine };
      },
    });
    const oldView = fakeView('old');
    useEditorStore.getState().registerView('/work/a.ts', oldView);

    const pending = coApp.editor.openFile('/work/a.ts', { line: 2 });
    await started;
    useEditorStore.getState().unregisterView('/work/a.ts', oldView);
    vi.useFakeTimers();
    releaseImport();
    await vi.advanceTimersByTimeAsync(600);

    expect(await pending).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'tab-not-mounted',
    });
    expect(scrollToLine).not.toHaveBeenCalled();
  });
});
