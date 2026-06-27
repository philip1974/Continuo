// @vitest-environment jsdom
// a11y(A112,A111 后续):虚拟列表 combobox 的 aria-activedescendant 只能指向真实挂载的 option。
// 选中项逻辑有效但不在 getVirtualItems() 渲染窗口内时,aria-activedescendant 须移除(否则悬空)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(),
}));

// 窄渲染窗口 mock:无论 count 多大,只渲染 index 0..2(模拟真实虚拟化的可视窗口)。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 3) }, (_, i) => ({
        index: i,
        start: i * 28,
        size: 28,
        key: i,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import {
  useQuickOpenStore,
  type QuickOpenFile,
} from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';

const walkMock = walkWorkspaceFiles as unknown as ReturnType<typeof vi.fn>;

function file(name: string): QuickOpenFile {
  return {
    name,
    relPath: name,
    relPathLower: name.toLowerCase(),
    absPath: `/proj/${name}`,
  };
}

function installFs(): void {
  Object.defineProperty(window, 'api', {
    value: {
      fs: {
        listDir: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        readFile: vi.fn().mockResolvedValue({ ok: true, data: '' }),
      },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  walkMock.mockReset();
  walkMock.mockReturnValue(new Promise(() => {})); // 永不 resolve,不覆盖直接塞的 store.results
  useQuickOpenStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    results: [],
    loading: false,
    scanFailed: false,
  });
  useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('a11y(A112) — 虚拟列表 combobox activedescendant 须指向已挂载 option', () => {
  it('selectedIndex 有效但在渲染窗口外 → aria-activedescendant 移除', () => {
    installFs();
    const many = Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`));
    // selectedIndex=30:逻辑有效(<50)但不在窄窗口 0..2 内 → activedescendant 应为 null。
    useQuickOpenStore.setState({
      isOpen: true,
      results: many,
      loading: false,
      selectedIndex: 30,
    });
    const { container } = render(<QuickOpenModal />);
    const input = container.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('selectedIndex 在渲染窗口内 → aria-activedescendant 指向该 option', () => {
    installFs();
    const many = Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`));
    useQuickOpenStore.setState({
      isOpen: true,
      results: many,
      loading: false,
      selectedIndex: 1, // 在窗口 0..2 内
    });
    const { container } = render(<QuickOpenModal />);
    const input = container.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    const ad = input.getAttribute('aria-activedescendant');
    expect(ad).toBe('quick-open-option-1');
    // 指向真实挂载的 option
    expect(container.querySelector(`#${ad}`)).not.toBeNull();
  });
});
