// @vitest-environment jsdom
// perf E2:EditorPanel 按需加载编辑引擎 —— CodeEditor(CodeMirror + 语言包)与 MilkdownEditor
// (Crepe/ProseMirror/katex)各自 lazy。Welcome 不加载任何引擎;代码文件只加载 CodeEditor;
// Markdown edit 只加载 Milkdown。vi.mock 工厂在模块首次被 import 时才执行,用它观测「是否加载」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ loaded: [] as string[] }));

vi.mock('../../panels/Editor/CodeEditor', () => {
  h.loaded.push('code');
  return {
    CodeEditor: ({ value }: { value: string }) => (
      <div data-testid="code-editor">{value}</div>
    ),
  };
});
vi.mock('../../panels/Editor/MilkdownEditor', () => {
  h.loaded.push('milkdown');
  return {
    MilkdownEditor: ({ defaultValue }: { defaultValue: string }) => (
      <div data-testid="milkdown-editor">{defaultValue}</div>
    ),
  };
});
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';

function tab(id: string, content: string) {
  return { id, filePath: id, content, originalContent: content, dirty: false };
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
});
afterEach(() => cleanup());

describe('perf E2 — EditorPanel 按需 lazy 加载编辑引擎', () => {
  it('EditorPanel 源码不静态 import CodeEditor / MilkdownEditor', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/panels/Editor/EditorPanel.tsx'),
      'utf-8',
    );
    expect(src).not.toMatch(/^import [^;]*from '\.\/CodeEditor';/m);
    expect(src).not.toMatch(/^import [^;]*from '\.\/MilkdownEditor';/m);
  });

  // 顺序敏感:模块缓存跨用例保留,依次验证 Welcome(无)→ 代码(只 code)→ md(再加 milkdown)。
  it('Welcome 不加载引擎;代码文件只加载 CodeEditor;Markdown edit 再加载 Milkdown', async () => {
    render(<EditorPanel />);
    await act(async () => {});
    expect(h.loaded).toEqual([]);

    act(() => {
      useEditorStore.setState({ tabs: [tab('/a.ts', 'const a = 1')], activeTabId: '/a.ts' });
    });
    expect((await screen.findByTestId('code-editor')).textContent).toBe('const a = 1');
    expect(h.loaded).toEqual(['code']);

    act(() => {
      useEditorStore.setState((s) => ({
        tabs: [...s.tabs, tab('/b.md', '# hi')],
        activeTabId: '/b.md',
      }));
    });
    expect((await screen.findByTestId('milkdown-editor')).textContent).toBe('# hi');
    expect(screen.queryByTestId('code-editor')).toBeNull();
    expect(h.loaded).toEqual(['code', 'milkdown']);

    // 引擎已加载后切回代码 tab:同步渲染,不再闪 fallback
    act(() => {
      useEditorStore.getState().switchTab('/a.ts');
    });
    expect(screen.getByTestId('code-editor').textContent).toBe('const a = 1');
    expect(screen.queryByTestId('milkdown-editor')).toBeNull();
  });
});

// 复审 #1:EditorPanel 的引擎 lazy 与 co-app 的 openFile({line}) 预加载共用同一加载 promise;
// 失败不缓存(引擎错误边界「重试」须能重新发起 import)。
describe('perf E2 — 编辑引擎共享加载器', () => {
  it('loadCodeEditorModule 多次调用返回同一 promise(EditorPanel 与 co-app 共用)', async () => {
    const { loadCodeEditorModule } = await import('../../panels/Editor/editor-engine-loaders');
    const a = loadCodeEditorModule();
    expect(loadCodeEditorModule()).toBe(a);
    await a;
    expect(loadCodeEditorModule()).toBe(a);
  });

  it('cachedLoader:rejection 不缓存,下次调用重新加载', async () => {
    const { cachedLoader } = await import('../../panels/Editor/editor-engine-loaders');
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce('ok');
    const loader = cachedLoader(load);
    await expect(loader()).rejects.toThrow('chunk failed');
    await expect(loader()).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
