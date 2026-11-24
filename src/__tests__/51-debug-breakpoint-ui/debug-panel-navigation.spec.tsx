// @vitest-environment jsdom
// Debug 面板交互(对齐 VSCode):点栈帧 / 断点打开源码并定位到行;变量值悬停看全文;对象变量可展开(树、键盘);
// 进入变量页自动加载第一个作用域。见同目录 README。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  openFile: vi.fn(),
  notifyError: vi.fn(),
  getVariables: vi.fn(),
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    debug: {
      onEvent: vi.fn(() => () => undefined),
      subscribe: vi.fn(async () => ({ ok: true, data: { sessions: [] } })),
      getStack: vi.fn(),
      getVariables: h.getVariables,
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: h.openFile } } }));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import { DebugPanel } from '../../panels/Debug/DebugPanel';
import { resetDebugStoreForTest, useDebugStore } from '../../stores/debug.store';
import { setLocale } from '../../i18n';

const page = (variables: Array<{ name: string; value: string; variables_reference?: number }>) => ({
  ok: true,
  data: { variables, truncated: false },
});

function seedStoppedSession(): void {
  useDebugStore.setState({
    activeSessionId: 's1',
    sessions: new Map([
      [
        's1',
        {
          id: 's1',
          breakpoints: [{ file: '/repo/b.ts', line: 3, verified: true }],
          frames: [
            { id: 7, name: 'inner', source_path: '/repo/a.ts', line: 14 },
            { id: 8, name: 'outer', source_path: '/repo/c.ts', line: 40 },
          ],
          scopes: [
            { name: 'Local', variables_reference: 44, expensive: false },
            { name: 'Global', variables_reference: 45, expensive: true },
          ],
          variableRefs: new Map(),
          stopped: { reason: 'breakpoint', stopSeq: 1, file: '/repo/a.ts', line: 14 },
          lastStoppedOrder: 1,
        },
      ],
    ]),
  });
}

beforeEach(() => {
  setLocale('en');
  h.openFile.mockReset();
  h.openFile.mockResolvedValue({ ok: true, lineApplied: true });
  h.notifyError.mockReset();
  h.getVariables.mockReset();
  h.getVariables.mockImplementation(async ({ variablesReference }: { variablesReference: number }) => {
    if (variablesReference === 44) {
      return page([
        { name: 'sum', value: '21', variables_reference: 0 },
        { name: 'obj', value: '{a: 1, b: {…}}', variables_reference: 50 },
        { name: 'other', value: 'x', variables_reference: 0 },
      ]);
    }
    if (variablesReference === 50) {
      return page([
        { name: 'a', value: '1', variables_reference: 0 },
        { name: 'b', value: '{…}', variables_reference: 51 },
      ]);
    }
    return page([]);
  });
  seedStoppedSession();
});

afterEach(() => {
  cleanup();
  resetDebugStoreForTest();
});

describe('点栈帧 / 断点 → 打开源码并定位到行', () => {
  it('点栈帧 → editor.openFile(source_path, { line })', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('button', { name: /outer/ }));
    await waitFor(() => expect(h.openFile).toHaveBeenCalledWith('/repo/c.ts', { line: 40 }));
  });

  it('点断点 → editor.openFile(file, { line })', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Breakpoints' }));
    fireEvent.click(screen.getByRole('button', { name: /\/repo\/b\.ts:3/ }));
    await waitFor(() => expect(h.openFile).toHaveBeenCalledWith('/repo/b.ts', { line: 3 }));
  });

  it('打开失败(ok:false)→ 提示,不静默', async () => {
    h.openFile.mockResolvedValueOnce({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('button', { name: /inner/ }));
    await waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
    expect(h.notifyError.mock.calls[0]![1]).toMatchObject({ code: 'FS_NOT_FOUND' });
  });

  it('栈帧无源码路径 → 不可点(不调用 openFile)', () => {
    useDebugStore.setState((s) => {
      const cur = s.sessions.get('s1')!;
      return {
        sessions: new Map([['s1', { ...cur, frames: [{ id: 9, name: 'native', line: 0 }] }]]),
      };
    });
    render(<DebugPanel />);
    const btn = screen.getByRole('button', { name: /native/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe('源码跳转 · 非绝对路径', () => {
  beforeEach(seedStoppedSession);
  it('适配器给的非绝对伪路径(如 node 内部模块)→ 不可点,不弹 INVALID_PATH', () => {
    useDebugStore.setState((s) => {
      const cur = s.sessions.get('s1')!;
      return {
        sessions: new Map([['s1', { ...cur, frames: [{ id: 9, name: 'internal', source_path: 'node:internal/timers', line: 3 }] }]]),
      };
    });
    render(<DebugPanel />);
    const btn = screen.getByRole('button', { name: /internal/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(h.openFile).not.toHaveBeenCalled();
  });
});

describe('变量页', () => {
  it('进入变量页自动加载第一个作用域(不必点「加载」),其余作用域仍可手动加载', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    await waitFor(() => expect(screen.getByText('sum')).toBeTruthy());
    expect(h.getVariables).toHaveBeenCalledTimes(1);
    expect(h.getVariables).toHaveBeenCalledWith({ sessionId: 's1', variablesReference: 44 });
    expect(screen.getByRole('button', { name: 'Load Global' })).toBeTruthy();
  });

  it('变量值悬停可看全文(title)', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    await waitFor(() => expect(screen.getByText('{a: 1, b: {…}}')).toBeTruthy());
    expect(screen.getByText('{a: 1, b: {…}}').getAttribute('title')).toBe('{a: 1, b: {…}}');
  });

  it('对象变量是可展开的树节点:点击展开加载子变量,再点收起', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const tree = await screen.findByRole('tree', { name: 'Local' });
    expect(tree).toBeTruthy();
    const obj = await screen.findByRole('treeitem', { name: /obj/ });
    expect(obj.getAttribute('aria-expanded')).toBe('false');
    // 标量变量不是可展开节点
    expect(screen.getByRole('treeitem', { name: /sum/ }).hasAttribute('aria-expanded')).toBe(false);

    fireEvent.click(obj);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /^a/ })).toBeTruthy());
    expect(h.getVariables).toHaveBeenCalledWith({ sessionId: 's1', variablesReference: 50 });
    expect(obj.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: /^a/ }).getAttribute('aria-level')).toBe('2');

    fireEvent.click(obj);
    expect(obj.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: /^a/ })).toBeNull();
  });

  it('键盘:方向键移动焦点,→ / Enter 展开,← 收起或回到父节点', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const sum = await screen.findByRole('treeitem', { name: /sum/ });
    const obj = screen.getByRole('treeitem', { name: /obj/ });
    sum.focus();

    fireEvent.keyDown(sum, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(obj);

    fireEvent.keyDown(obj, { key: 'ArrowRight' });
    await waitFor(() => expect(obj.getAttribute('aria-expanded')).toBe('true'));
    const childA = await screen.findByRole('treeitem', { name: /^a/ });

    // 已展开再按 → 进入第一个子节点
    fireEvent.keyDown(obj, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(childA);

    // 子节点按 ← 回到父节点
    fireEvent.keyDown(childA, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(obj);

    // 父节点按 ← 收起
    fireEvent.keyDown(obj, { key: 'ArrowLeft' });
    expect(obj.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(obj, { key: 'Enter' });
    await waitFor(() => expect(obj.getAttribute('aria-expanded')).toBe('true'));

    fireEvent.keyDown(obj, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(sum);
  });
});
