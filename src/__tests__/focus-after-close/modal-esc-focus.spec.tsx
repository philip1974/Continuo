// @vitest-environment jsdom
// BDD:Quick Open / 命令面板 Esc 关闭后焦点回到打开前的元素;命令自己移走的焦点不被还原覆盖。见同目录 README 第 1 条。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 30, size: 30, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(async () => ({ ok: true as const, data: [] })),
}));

import { Modal } from '../../design/Modal';
import { CommandPalette } from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

let editor: HTMLElement;
beforeEach(() => {
  // 打开弹窗前的焦点所在(编辑器 / Explorer 行)
  editor = document.createElement('div');
  editor.tabIndex = -1;
  editor.dataset.testid = 'editor';
  document.body.appendChild(editor);
  editor.focus();
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useQuickOpenStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    results: [],
    resultsRoot: '/work',
    loading: false,
    scanFailed: false,
  });
});
afterEach(() => {
  cleanup();
  editor.remove();
});

describe('Esc 关闭 Quick Open / 命令面板 → 焦点回到打开前的元素', () => {
  it('Quick Open:输入框获焦,Esc 后焦点回到编辑器', async () => {
    useQuickOpenStore.setState({ isOpen: true });
    const { getByRole } = render(<QuickOpenModal />);
    await act(nextFrame);
    expect(document.activeElement).toBe(getByRole('combobox'));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(document.activeElement).toBe(editor);
  });

  it('命令面板:输入框获焦,Esc 后焦点回到编辑器', async () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'x.run', title: 'Run X', fn: vi.fn() });
    render(<CommandPalette commands={registry} />);
    act(() => useCommandPaletteStore.getState().open());
    await act(nextFrame);
    expect((document.activeElement as HTMLElement).getAttribute('role')).toBe('combobox');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(document.activeElement).toBe(editor);
  });

  it('命令面板执行的命令自己移走焦点 → 关闭时不还原覆盖', async () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    const registry = new CommandRegistry();
    registry.register({ id: 'focus.target', title: 'Focus Target', fn: () => target.focus() });
    render(<CommandPalette commands={registry} />);
    act(() => useCommandPaletteStore.getState().open());
    await act(nextFrame);

    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(document.activeElement).toBe(target);
    target.remove();
  });
});

describe('Modal 关闭时的焦点还原', () => {
  it('关闭期间焦点被移到弹窗外的元素 → 不还原到打开前的元素', () => {
    const other = document.createElement('button');
    document.body.appendChild(other);
    const { rerender } = render(
      <Modal visible>
        <button type="button">in</button>
      </Modal>,
    );
    // 关闭前移走焦点的总是用户操作触发的代码(如命令面板 Enter 执行的命令);用户操作前程序抢走焦点会被 Modal 拉回
    //(见 design-system-modal「打开后焦点被程序抢走」)。
    fireEvent.keyDown(document.body, { key: 'Enter' });
    other.focus();
    rerender(
      <Modal visible={false}>
        <button type="button">in</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

/** src 下(不含测试)所有 .tsx。 */
function listTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') listTsx(p, out);
    } else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('Modal 内的初始焦点只用 data-autofocus', () => {
  it('渲染 Modal 的组件不用 React autoFocus(commit 期就聚焦,Modal 记下的「打开前焦点」会变成弹窗内元素)', () => {
    const offenders = listTsx(join(process.cwd(), 'src')).filter((f) => {
      // 去掉行注释(注释里会提到 autoFocus)后查 JSX 属性
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      return src.includes('<Modal') && /\sautoFocus\b/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
