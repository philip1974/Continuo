// @vitest-environment jsdom
// BDD:资源管理器选中项跟随活动编辑器(VSCode explorer.autoReveal)。见同目录 README.md。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';
import { useEditorStore } from '../../stores/editor.store';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  scrolledTo: [] as number[],
  // 目录 → 挂起其 listDir 直到调用返回的 release(模拟慢盘 / 网络盘上逐级展开父目录)
  gates: new Map<string, Promise<void>>(),
}));

const fsTree = new Map<string, FileEntry[]>();
const dir = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, isDirectory: true });
const file = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, isDirectory: false });

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => {
        await h.gates.get(p);
        return { ok: true, data: fsTree.get(p) ?? [] };
      }),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: (i: number) => h.scrolledTo.push(i),
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn(async () => ({ ok: true })) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) => (key in h.settings ? h.settings[key] : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { EXPLORER_AUTO_REVEAL } from '../../plugins/settings/core-setting-specs';

const row = (p: string) => document.querySelector<HTMLElement>(`[title="${p}"]`);
const selected = (p: string) => row(p)?.getAttribute('aria-selected') === 'true';

function openInEditor(path: string): void {
  act(() => {
    useEditorStore.setState({
      tabs: [{ id: path, filePath: path, content: '', originalContent: '', dirty: false }],
      activeTabId: path,
    });
  });
}

async function mount() {
  const r = render(
    <>
      <button type="button" data-testid="outside">outside</button>
      <FolderTree root="/work" />
    </>,
  );
  await waitFor(() => expect(row('/work/top.ts')).not.toBeNull());
  return r;
}

beforeEach(() => {
  h.settings = {};
  h.scrolledTo = [];
  h.gates.clear();
  fsTree.clear();
  fsTree.set('/work', [dir('/work/src'), dir('/work/node_modules'), file('/work/top.ts')]);
  fsTree.set('/work/src', [dir('/work/src/deep'), file('/work/src/a.ts')]);
  fsTree.set('/work/src/deep', [file('/work/src/deep/b.ts')]);
  fsTree.set('/work/node_modules', [dir('/work/node_modules/pkg')]);
  fsTree.set('/work/node_modules/pkg', [file('/work/node_modules/pkg/index.js')]);
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  cleanup();
});

describe('资源管理器跟随活动编辑器(explorer.autoReveal,默认开)', () => {
  it('设置项:explorer.autoReveal,布尔,默认开(VSCode 同)', () => {
    expect(EXPLORER_AUTO_REVEAL.id).toBe('explorer.autoReveal');
    expect(EXPLORER_AUTO_REVEAL.type).toBe('boolean');
    expect(EXPLORER_AUTO_REVEAL.default).toBe(true);
  });

  it('活动编辑器换成深层文件(⌘P / 终端链接打开)→ 逐级展开父目录,选中该文件并设为树焦点项,滚动入视野', async () => {
    await mount();
    const outside = document.querySelector<HTMLElement>('[data-testid="outside"]')!;
    outside.focus();
    openInEditor('/work/src/deep/b.ts');
    await waitFor(() => expect(row('/work/src/deep/b.ts')).not.toBeNull());
    expect(row('/work/src')!.getAttribute('aria-expanded')).toBe('true');
    expect(row('/work/src/deep')!.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(selected('/work/src/deep/b.ts')).toBe(true));
    expect(row('/work/src/deep/b.ts')!.getAttribute('tabindex')).toBe('0');
    expect(h.scrolledTo.length).toBeGreaterThan(0);
    // 不抢焦点:DOM 焦点留在原处(VSCode autoReveal 只改选中 / 焦点项)
    expect(document.activeElement).toBe(outside);
  });

  it('切到另一文件 → 旧选中项取消,新文件选中', async () => {
    await mount();
    openInEditor('/work/top.ts');
    await waitFor(() => expect(selected('/work/top.ts')).toBe(true));
    openInEditor('/work/src/a.ts');
    await waitFor(() => expect(selected('/work/src/a.ts')).toBe(true));
    expect(selected('/work/top.ts')).toBe(false);
  });

  it('工作区外的文件 → 树不变', async () => {
    await mount();
    openInEditor('/work/top.ts');
    await waitFor(() => expect(selected('/work/top.ts')).toBe(true));
    openInEditor('/elsewhere/x.ts');
    await new Promise((r) => setTimeout(r, 50));
    expect(selected('/work/top.ts')).toBe(true);
  });

  it('node_modules 下的文件不跟随(VSCode explorer.autoRevealExclude 默认)', async () => {
    await mount();
    openInEditor('/work/node_modules/pkg/index.js');
    await new Promise((r) => setTimeout(r, 50));
    expect(row('/work/node_modules')!.getAttribute('aria-expanded')).toBe('false');
    expect(row('/work/node_modules/pkg/index.js')).toBeNull();
  });

  it('等待定位期间(父目录还在加载)用户在树里点了别的行 → 定位作废,加载完不抢回选中 / 焦点项', async () => {
    await mount();
    let release!: () => void;
    h.gates.set('/work/src/deep', new Promise<void>((r) => (release = r)));
    openInEditor('/work/src/deep/b.ts');
    await waitFor(() => expect(row('/work/src/deep')).not.toBeNull());
    // 用户点了一个目录(不换活动编辑器)
    act(() => {
      fireEvent.click(row('/work/node_modules')!);
    });
    await waitFor(() => expect(selected('/work/node_modules')).toBe(true));
    await act(async () => release());
    await waitFor(() => expect(row('/work/src/deep/b.ts')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(selected('/work/src/deep/b.ts')).toBe(false);
    expect(selected('/work/node_modules')).toBe(true);
    expect(row('/work/node_modules')!.getAttribute('tabindex')).toBe('0');
  });

  it('关掉 explorer.autoReveal → 不展开、不改选中', async () => {
    h.settings = { 'explorer.autoReveal': false };
    await mount();
    openInEditor('/work/src/a.ts');
    await new Promise((r) => setTimeout(r, 50));
    expect(row('/work/src')!.getAttribute('aria-expanded')).toBe('false');
    expect(row('/work/src/a.ts')).toBeNull();
  });
});
