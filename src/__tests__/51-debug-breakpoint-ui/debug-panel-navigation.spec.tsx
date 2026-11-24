// @vitest-environment jsdom
// Debug 面板交互(对齐 VSCode):点栈帧 / 断点打开源码并定位到行;变量值悬停看全文;对象变量可展开(树、键盘);
// 进入变量页自动加载第一个作用域。见同目录 README。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

import { DebugPanel, RUNNING_ANNOUNCE_DELAY_MS } from '../../panels/Debug/DebugPanel';
import { prepareAnnouncer } from '../../lib/announce';
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
    fireEvent.click(screen.getByRole('button', { name: /b\.ts:3/ }));
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

// APG Tree View / VSCode 变量视图:roving tabindex —— 整棵树只有一个 tabindex=0,跟随焦点;Tab 离开再回来回到
// 上次的节点。收起父节点时其内的焦点记忆回到该父节点。
describe('变量树 · roving tabindex', () => {
  const tabbables = () =>
    screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0');

  it('初始只有第一个节点可 Tab 到;↓ 移动后 tabindex=0 跟到焦点节点', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const sum = await screen.findByRole('treeitem', { name: /sum/ });
    expect(tabbables()).toEqual([sum]);
    sum.focus();
    fireEvent.keyDown(sum, { key: 'ArrowDown' });
    const obj = screen.getByRole('treeitem', { name: /obj/ });
    fireEvent.keyDown(obj, { key: 'ArrowDown' });
    const other = screen.getByRole('treeitem', { name: /other/ });
    expect(document.activeElement).toBe(other);
    expect(tabbables()).toEqual([other]);
  });

  it('焦点在子节点时收起父节点(点击)→ 父节点成为唯一可 Tab 到的节点', async () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const obj = await screen.findByRole('treeitem', { name: /obj/ });
    fireEvent.click(obj);
    const childA = await screen.findByRole('treeitem', { name: /^a/ });
    act(() => childA.focus());
    expect(tabbables()).toEqual([childA]);
    fireEvent.click(obj);
    expect(tabbables()).toEqual([obj]);
  });
});

describe('变量树 · 加载中 / 加载更多', () => {
  it('展开尚未加载完的对象 → 该节点 aria-busy,加载完成后去掉', async () => {
    let release: () => void = () => undefined;
    h.getVariables.mockImplementation(async ({ variablesReference }: { variablesReference: number }) => {
      if (variablesReference === 44) return page([{ name: 'obj', value: '{…}', variables_reference: 50 }]);
      await new Promise<void>((res) => {
        release = res;
      });
      return page([{ name: 'a', value: '1', variables_reference: 0 }]);
    });
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const obj = await screen.findByRole('treeitem', { name: /obj/ });
    fireEvent.click(obj);
    expect(obj.getAttribute('aria-busy')).toBe('true');
    release();
    await screen.findByRole('treeitem', { name: /^a/ });
    expect(obj.hasAttribute('aria-busy')).toBe(false);
  });

  it('「加载更多」是树节点:↓ 可到达,Enter 加载下一页,焦点移到新加载的第一项;点击不收起父节点', async () => {
    h.getVariables.mockImplementation(
      async ({ variablesReference, start }: { variablesReference: number; start?: number }) => {
        if (variablesReference === 44) return page([{ name: 'obj', value: '{…}', variables_reference: 50 }]);
        if (variablesReference === 50 && start === undefined) {
          return { ok: true, data: { variables: [{ name: 'a', value: '1' }], truncated: true, next_start: 1 } };
        }
        if (variablesReference === 50 && start === 1) {
          return { ok: true, data: { variables: [{ name: 'b', value: '2' }], truncated: true, next_start: 2 } };
        }
        return page([{ name: 'c', value: '3' }]);
      },
    );
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    const obj = await screen.findByRole('treeitem', { name: /obj/ });
    fireEvent.click(obj);
    const childA = await screen.findByRole('treeitem', { name: /^a/ });
    childA.focus();
    fireEvent.keyDown(childA, { key: 'ArrowDown' });
    const more = screen.getByRole('treeitem', { name: 'Load more' });
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute('aria-level')).toBe('2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    fireEvent.keyDown(more, { key: 'Enter' });
    const childB = await screen.findByRole('treeitem', { name: /^b/ });
    await waitFor(() => expect(document.activeElement).toBe(childB));
    expect(h.getVariables).toHaveBeenLastCalledWith({ sessionId: 's1', variablesReference: 50, start: 1 });

    // 点击「加载更多」只加载,不冒泡成父节点的展开 / 收起
    fireEvent.click(screen.getByRole('treeitem', { name: 'Load more' }));
    await screen.findByRole('treeitem', { name: /^c/ });
    expect(obj.getAttribute('aria-expanded')).toBe('true');
  });
});

// VSCode:停下时 aria.status 播报「已在断点处暂停」及位置;继续运行不急着播(连按单步不堆积)。
// 播报走全局 announce()(src/lib/announce,见 live-announcer),面板被 dockview 隐藏(DOM 不在文档)时照样播。
describe('停点 / 恢复运行播报', () => {
  beforeEach(() => prepareAnnouncer(document));
  afterEach(() => {
    vi.useRealTimers();
    for (const el of document.querySelectorAll('[data-live-announcer]')) el.remove();
  });
  /** 主窗全局 polite 播报区里现存的播报(按顺序)。 */
  const spoken = () =>
    [...document.querySelectorAll('[data-live-announcer] [aria-live="polite"] > *')].map((el) => el.textContent ?? '');
  const setStopped = (stopped: Record<string, unknown> | undefined, id = 's1') =>
    useDebugStore.setState((s) => {
      const cur = s.sessions.get(id) ?? s.sessions.get('s1')!;
      const sessions = new Map(s.sessions);
      sessions.set(id, { ...cur, id, stopped } as typeof cur);
      return { sessions, activeSessionId: stopped ? id : s.activeSessionId };
    });

  it('挂载时不播报;新的一停 → 「Paused on 原因 at 文件:行」;继续运行稍后播「running」', () => {
    vi.useFakeTimers();
    render(<DebugPanel />);
    expect(spoken()).toEqual([]);
    act(() => setStopped(undefined));
    expect(spoken()).toEqual([]);
    act(() => vi.advanceTimersByTime(RUNNING_ANNOUNCE_DELAY_MS));
    expect(spoken()).toEqual(['running']);
    act(() => setStopped({ reason: 'step', stopSeq: 2, file: '/repo/a.ts', line: 20 }));
    expect(spoken()).toEqual(['running', 'Paused on step at a.ts:20']);
  });

  it('快速连续单步:继续运行后很快又停下 → 不播「running」,只播新停点;同一位置同文本也每次都播', () => {
    vi.useFakeTimers();
    render(<DebugPanel />);
    for (let seq = 2; seq <= 4; seq++) {
      act(() => setStopped(undefined));
      act(() => vi.advanceTimersByTime(50));
      act(() => setStopped({ reason: 'step', stopSeq: seq, file: '/repo/a.ts', line: 20 }));
    }
    act(() => vi.advanceTimersByTime(RUNNING_ANNOUNCE_DELAY_MS * 2));
    expect(spoken()).toEqual(['Paused on step at a.ts:20', 'Paused on step at a.ts:20', 'Paused on step at a.ts:20']);
  });

  it('面板 DOM 不在文档(dockview 隐藏的面板)时停点照样播报', () => {
    const detached = document.createElement('div');
    render(<DebugPanel />, { container: detached });
    act(() => setStopped({ reason: 'breakpoint', stopSeq: 2, file: '/repo/c.ts', line: 40 }));
    expect(spoken()).toEqual(['Paused on breakpoint at c.ts:40']);
  });

  it('多个调试会话 → 播报带会话名', () => {
    render(<DebugPanel />);
    act(() => setStopped({ reason: 'breakpoint', stopSeq: 2, file: '/repo/c.ts', line: 40 }, 's2'));
    expect(spoken()).toEqual(['s2: Paused on breakpoint at c.ts:40']);
  });

  it('停点位置稍后才到 → 等位置到了再播一次(不先播一遍无位置的)', () => {
    render(<DebugPanel />);
    act(() => setStopped({ reason: 'breakpoint', stopSeq: 2 }));
    expect(spoken()).toEqual([]);
    act(() => setStopped({ reason: 'breakpoint', stopSeq: 2, file: '/repo/c.ts', line: 40 }));
    expect(spoken()).toEqual(['Paused on breakpoint at c.ts:40']);
  });

  it('位置一直没到(取栈失败)→ 稍后只播「Paused: 原因」', () => {
    vi.useFakeTimers();
    render(<DebugPanel />);
    act(() => setStopped({ reason: 'exception', stopSeq: 2 }));
    expect(spoken()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(spoken()).toEqual(['Paused: exception']);
  });

  it('zh:全角冒号与逗号', () => {
    setLocale('zh');
    render(<DebugPanel />);
    act(() => setStopped({ reason: 'breakpoint', stopSeq: 2, file: '/repo/a.ts', line: 3 }));
    expect(spoken()).toEqual(['已暂停：breakpoint，a.ts:3']);
  });
});
