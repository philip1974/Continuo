// @vitest-environment jsdom
// perf:首次打开文件时编辑引擎 chunk 与 readFile 并行预热。
// 此前 Explorer 单击 / Quick Open 回车 → openFileByPath 先 await readFile、openTab 提交后 EditorPanel 才渲染
// lazy 引擎并开始拉 chunk(CodeMirror / Milkdown),两段串行。现在 openFileByPath 在 readFile 之前按扩展名与当前
// mode(getEffectiveMode 同口径)fire-and-forget 预热共享 loader;Quick Open 面板挂载即预热 CodeEditor。
// 失败不缓存由 loader 保证;预热失败不影响打开结果。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  loadEditorPanelModule: vi.fn(() => Promise.resolve({})),
  loadCodeEditorModule: vi.fn(() => Promise.resolve({})),
  loadMilkdownEditorModule: vi.fn(() => Promise.resolve({})),
  preloadCodeEditorEngine: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../panels/Editor/editor-engine-loaders', () => h);
vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../../lib/co-api', () => ({
  coApi: { fs: { readFile: vi.fn(), writeFile: vi.fn(), listDir: vi.fn() } },
}));

import { openFileByPath, type EditorFileDeps } from '../../panels/Editor/editor-file-actions';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { IpcResult } from '../../lib/fs/types';

function pendingRead() {
  let resolve!: (r: IpcResult<string>) => void;
  const readFile = vi.fn(
    () =>
      new Promise<IpcResult<string>>((r) => {
        resolve = r;
      }),
  );
  const deps: EditorFileDeps = {
    fs: { readFile, writeFile: vi.fn() },
  };
  return { deps, readFile, resolve: (data: string) => resolve({ ok: true, data }) };
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  for (const fn of Object.values(h)) fn.mockClear();
});
afterEach(() => cleanup());

describe('openFileByPath — readFile 之前预热编辑引擎', () => {
  it('代码文件:readFile resolve 前已发起 Editor 面板 + CodeEditor 加载,不加载 Milkdown', async () => {
    const { deps, readFile, resolve } = pendingRead();
    const done = openFileByPath('/w/a.ts', deps);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(h.loadCodeEditorModule).toHaveBeenCalledTimes(1);
    expect(h.loadEditorPanelModule).toHaveBeenCalledTimes(1);
    expect(h.loadMilkdownEditorModule).not.toHaveBeenCalled();
    expect(h.loadCodeEditorModule.mock.invocationCallOrder[0]!).toBeLessThan(
      readFile.mock.invocationCallOrder[0]!,
    );
    resolve('const a = 1');
    await expect(done).resolves.toEqual({ ok: true, data: undefined });
  });

  it('Markdown + edit/preview 模式:预热 Milkdown;source 模式:预热 CodeEditor', async () => {
    const md = pendingRead();
    const p1 = openFileByPath('/w/a.md', md.deps);
    expect(h.loadMilkdownEditorModule).toHaveBeenCalledTimes(1);
    expect(h.loadCodeEditorModule).not.toHaveBeenCalled();
    md.resolve('# a');
    await p1;

    for (const fn of Object.values(h)) fn.mockClear();
    useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'preview' });
    const pv = pendingRead();
    const p3 = openFileByPath('/w/c.md', pv.deps);
    expect(h.loadMilkdownEditorModule).toHaveBeenCalledTimes(1);
    expect(h.loadCodeEditorModule).not.toHaveBeenCalled();
    pv.resolve('# c');
    await p3;

    for (const fn of Object.values(h)) fn.mockClear();
    useEditorStore.setState({ mode: 'source' });
    const src = pendingRead();
    const p2 = openFileByPath('/w/b.md', src.deps);
    expect(h.loadCodeEditorModule).toHaveBeenCalledTimes(1);
    expect(h.loadMilkdownEditorModule).not.toHaveBeenCalled();
    src.resolve('# b');
    await p2;
  });

  it('已打开的 tab 只切换,不预热', async () => {
    useEditorStore.setState({ tabs: [createTab('/w/a.ts', 'x')], activeTabId: null });
    const { deps, readFile } = pendingRead();
    await openFileByPath('/w/a.ts', deps);
    expect(readFile).not.toHaveBeenCalled();
    expect(h.loadCodeEditorModule).not.toHaveBeenCalled();
  });

  it('预热失败不影响打开结果(不产生未处理 rejection)', async () => {
    h.loadCodeEditorModule.mockImplementationOnce(() => Promise.reject(new Error('chunk')));
    h.loadEditorPanelModule.mockImplementationOnce(() => Promise.reject(new Error('chunk')));
    const { deps, resolve } = pendingRead();
    const done = openFileByPath('/w/a.ts', deps);
    resolve('x');
    await expect(done).resolves.toEqual({ ok: true, data: undefined });
    expect(useEditorStore.getState().activeTabId).toBe('/w/a.ts');
  });
});

describe('QuickOpen 挂载即预热 CodeEditor', () => {
  it('面板打开(body 挂载)→ 调用 preloadCodeEditorEngine;关闭态不调用', () => {
    useWorkspaceStore.setState({ root: '/w', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: false });
    render(<QuickOpenModal />);
    expect(h.preloadCodeEditorEngine).not.toHaveBeenCalled();
    cleanup();
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    expect(h.preloadCodeEditorEngine).toHaveBeenCalled();
  });
});
