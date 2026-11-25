// openFile(path, { line }) 的冷加载 / 并发契约(复审发现的回归):
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

function tabFixture(path = '/work/a.ts') {
  return {
    id: path,
    filePath: path,
    content: 'one\ntwo',
    originalContent: 'one\ntwo',
    dirty: false,
  };
}

async function loadSubject(opts: {
  preload?: () => Promise<void>;
  scrollModule?: () => Promise<{ scrollToLine: typeof scrollToLine }>;
  tabs?: ReturnType<typeof tabFixture>[];
  activeTabId?: string;
  mode?: 'edit' | 'source';
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
    tabs: opts.tabs ?? [tabFixture()],
    activeTabId: opts.activeTabId ?? '/work/a.ts',
    mode: opts.mode ?? 'edit',
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
    expect(scrollToLine).toHaveBeenCalledWith(view, 2, undefined, undefined);
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
    expect(scrollToLine).toHaveBeenCalledWith(newView, 2, undefined, undefined);
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

  // 复审 r3 #2:切 tab / Source→Edit 后 store 已同步变化,但旧 view 要到 useEffect cleanup 才
  // unregister —— 这一窗口内 Map 仍是旧 view。只调 switchTab / setMode(不手工 unregister),
  // 须按 store 当前态判定未应用,不得对即将销毁的旧 view 跳行并谎报 lineApplied:true。
  function gatedScrollModule() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    return {
      release,
      started,
      scrollModule: async () => {
        markStarted();
        await gate;
        return { scrollToLine };
      },
    };
  }

  it('C7 加载期间切到另一个 tab(旧 view 尚未 cleanup)→ tab-not-mounted,不跳旧 view', async () => {
    const g = gatedScrollModule();
    const { coApp, useEditorStore } = await loadSubject({
      scrollModule: g.scrollModule,
      tabs: [tabFixture(), tabFixture('/work/b.ts')],
    });
    useEditorStore.getState().registerView('/work/a.ts', fakeView('a'));

    const pending = coApp.editor.openFile('/work/a.ts', { line: 2 });
    await g.started;
    useEditorStore.getState().switchTab('/work/b.ts');
    g.release();

    expect(await pending).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'tab-not-mounted',
    });
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it('C8 加载期间 Markdown Source→Edit(旧 CodeMirror view 尚未 cleanup)→ milkdown-engine,不跳旧 view', async () => {
    const g = gatedScrollModule();
    const { coApp, useEditorStore } = await loadSubject({
      scrollModule: g.scrollModule,
      tabs: [tabFixture('/work/a.md')],
      activeTabId: '/work/a.md',
      mode: 'source',
    });
    useEditorStore.getState().registerView('/work/a.md', fakeView('md-src'));

    const pending = coApp.editor.openFile('/work/a.md', { line: 2 });
    await g.started;
    useEditorStore.getState().setMode('edit');
    g.release();

    expect(await pending).toEqual({
      ok: true,
      lineApplied: false,
      reason: 'milkdown-engine',
    });
    expect(scrollToLine).not.toHaveBeenCalled();
  });

  it('C5 scrollToLine chunk 加载失败 → { ok:false, code:EXCEPTION },不 reject', async () => {
    const { coApp, useEditorStore } = await loadSubject({
      scrollModule: async () => {
        throw new Error('chunk load failed');
      },
    });
    useEditorStore.getState().registerView('/work/a.ts', fakeView('v'));

    // vitest 会把 mock 工厂抛错包装成自己的消息,这里只钉结果形态
    await expect(coApp.editor.openFile('/work/a.ts', { line: 2 })).resolves.toEqual({
      ok: false,
      code: 'EXCEPTION',
      message: expect.any(String),
    });
  });

  it('C6 CodeEditor 引擎预加载失败 → { ok:false, code:EXCEPTION },不 reject', async () => {
    const { coApp } = await loadSubject({
      preload: async () => {
        throw new Error('engine chunk failed');
      },
    });

    await expect(coApp.editor.openFile('/work/a.ts', { line: 2 })).resolves.toEqual({
      ok: false,
      code: 'EXCEPTION',
      message: 'engine chunk failed',
    });
  });
});
