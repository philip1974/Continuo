// @vitest-environment jsdom
// BDD: workspace-scan-unreadable / Quick Open:扫描结果带跳过的目录数 → 列表照常,下方 role=status 提示
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { setLocale } from '@/i18n';
import type { FileEntry } from '../../../electron/shared/fs-entry';

const entry = (p: string): FileEntry => ({ path: p, name: p.split('/').pop()!, isDirectory: false });

function installFs(scanFiles: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', { value: { fs: { scanFiles } }, writable: true, configurable: true });
  captureLmApi();
}

beforeEach(() => {
  setLocale('zh');
  _resetLmApiForTest();
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], resultsRoot: null, loading: false, scanFailed: false, skippedDirs: 0 });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  setLocale('en');
});

describe('walkWorkspaceFiles', () => {
  it('透传 main 报告的 skippedDirs(经 fs:scan-files)', async () => {
    const r = await walkWorkspaceFiles({
      rootPath: '/proj',
      listDir: async () => ({ ok: true, data: { entries: [entry('/proj/a.ts')], skippedDirs: 3 } }),
    });
    expect(r).toMatchObject({ ok: true, skippedDirs: 3 });
    if (r.ok) expect(r.data.map((f) => f.relPath)).toEqual(['a.ts']);
  });
});

describe('QuickOpenModal', () => {
  it('有不可读目录 → 列表照常,并提示「已跳过 N 个无法读取的目录」(role=status)', async () => {
    const scanFiles = vi.fn().mockResolvedValue({ ok: true, data: { entries: [entry('/proj/a.ts')], skippedDirs: 2 } });
    installFs(scanFiles);
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => expect(document.querySelectorAll('ul li')).toHaveLength(1));
    const status = document.querySelector('.wm-modal-content [role=status]');
    expect(status?.textContent).toBe('已跳过 2 个无法读取的目录');
    expect(scanFiles).toHaveBeenCalledWith('/proj', expect.objectContaining({ withStats: false }));
  });

  it('没有跳过 → 不显示提示', async () => {
    installFs(vi.fn().mockResolvedValue({ ok: true, data: { entries: [entry('/proj/a.ts')], skippedDirs: 0 } }));
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    useQuickOpenStore.setState({ isOpen: true });
    render(<QuickOpenModal />);
    await waitFor(() => expect(document.querySelectorAll('ul li')).toHaveLength(1));
    expect(document.querySelector('.wm-modal-content [role=status]')).toBeNull();
  });
});
