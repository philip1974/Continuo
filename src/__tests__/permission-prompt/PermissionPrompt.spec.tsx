// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import {
  copySelectedPermissions,
  PermissionPrompt,
} from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';

// 指针点击(浏览器里鼠标 click 的 detail ≥ 1;fireEvent.click 默认 detail=0,会被当作键盘激活,授予按钮对键盘
// 激活另有「停顿后的有意按键」要求,见 keyboard-grant-guard 规范)。
const pointerClick = (el: Element): boolean => fireEvent.click(el, { detail: 1 });

beforeEach(() => {
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
    currentFsScope: null,
  });
});
afterEach(() => cleanup());

// 排队后弹窗会从 A 直接换成 B(按钮位置不变、B 默认预选)。对 A 的「授予」连点两下,第二下不能落到 B 上。
describe('PermissionPrompt — 排队切换时防连点误授', () => {
  it('A 结算后立刻出现的 B:短时间内的点击被忽略,之后才生效', async () => {
    vi.useFakeTimers();
    try {
      const a = usePermissionPromptStore.getState().request('plugin.a', ['fs']);
      const b = usePermissionPromptStore.getState().request('plugin.b', ['network']);
      render(<PermissionPrompt />);
      const grantButton = (): HTMLButtonElement =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).at(-1)!;

      act(() => void vi.advanceTimersByTime(600)); // 首次出现的防误触延迟过后
      pointerClick(grantButton()); // 授予 A
      expect(await a).toEqual(['fs']);
      expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('plugin.b');

      pointerClick(grantButton()); // 连点的第二下,落在 B 的按钮上
      expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('plugin.b');

      // Esc(键重复)/ 点遮罩同样走 Modal 的 onClose → denyAll,也要被守卫挡住
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.keyDown(document.querySelector('.wm-modal-content')!, { key: 'Escape' });
      expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('plugin.b');

      act(() => void vi.advanceTimersByTime(600));
      pointerClick(grantButton()); // 用户看清后再点
      expect(await b).toEqual(['network']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// fs-scope 弹窗同样排队切换(A→B 按钮位置不变);弹窗类型切换(fs-scope↔manifest)也一样。
// 场景:插件同时发两个 requestScope(A 只读普通目录,B 为 `~` 读写),对 A 的「授权」双击 → 第二下不能永久授予 B。
describe('PermissionPrompt — fs-scope 排队 / 类型切换时防连点误授', () => {
  const scopeReq = (requestId: string, path: string, mode: 'r' | 'rw') =>
    usePermissionPromptStore.getState().requestFsScope({
      requestId,
      pluginId: 'plugin.x',
      scopes: [{ path, mode, displayPath: path }],
    });
  const lastButton = (): HTMLButtonElement =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers();
    usePermissionPromptStore.setState({ fsScopePending: {}, fsScopeQueue: [], currentFsScope: null });
  });
  afterEach(() => {
    usePermissionPromptStore.setState({ fsScopePending: {}, fsScopeQueue: [], currentFsScope: null });
    vi.useRealTimers();
  });

  it('fs-scope A 授权后立刻出现的 B:连点 / Esc / 拒绝都被忽略,guard 过后才可授权', async () => {
    let bDecision: string | null = null;
    const a = scopeReq('req-a', '/tmp/docs', 'r');
    void scopeReq('req-b', '/Users/me', 'rw').then((d) => (bDecision = d));
    render(<PermissionPrompt />);

    act(() => void vi.advanceTimersByTime(600)); // 首次出现的防误触延迟过后
    pointerClick(lastButton()); // 授权 A
    expect(await a).toBe('grant');
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('req-b');

    pointerClick(lastButton()); // 双击的第二下,落在 B 的「授权」上
    await act(async () => {});
    expect(bDecision).toBeNull();
    // Esc(键重复)/ 拒绝按钮同样受守卫约束(避免 B 被误拒,也与 manifest 弹窗一致)
    fireEvent.keyDown(document, { key: 'Escape' });
    const denyB = Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).at(-2)!;
    pointerClick(denyB);
    await act(async () => {});
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('req-b');
    expect(bDecision).toBeNull();

    act(() => void vi.advanceTimersByTime(600));
    pointerClick(lastButton()); // 用户看清后再点
    await act(async () => {});
    expect(bDecision).toBe('grant');
  });

  it('fs-scope → manifest 切换:插队出现的 manifest 弹窗(全新挂载)短时间内忽略授予', async () => {
    const a = scopeReq('req-a', '/tmp/docs', 'r');
    render(<PermissionPrompt />);
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('req-a');

    // 用户正要点 A 的「授权」时,manifest 请求到达并优先显示(按钮位置相同)
    let granted: readonly string[] | null = null;
    act(() => {
      void usePermissionPromptStore.getState().request('plugin.m', ['network']).then((g) => (granted = g));
    });
    pointerClick(lastButton()); // 本想点 A,落在 manifest「授权选中」
    await act(async () => {});
    expect(granted).toBeNull();
    expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('plugin.m');

    act(() => void vi.advanceTimersByTime(600));
    pointerClick(lastButton());
    await act(async () => {});
    expect(granted).toEqual(['network']);
    // 回到 fs-scope A(又一次类型切换),A 仍未决
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('req-a');
    act(() => void vi.advanceTimersByTime(600));
    pointerClick(lastButton());
    expect(await a).toBe('grant');
  });

  it('manifest → fs-scope 切换:manifest 授予后立刻出现的 fs-scope 短时间内忽略授权', async () => {
    let bDecision: string | null = null;
    void scopeReq('req-b', '/Users/me', 'rw').then((d) => (bDecision = d));
    const m = usePermissionPromptStore.getState().request('plugin.m', ['fs']);
    render(<PermissionPrompt />);

    act(() => void vi.advanceTimersByTime(600)); // 首次出现的防误触延迟过后
    pointerClick(lastButton()); // 授予 manifest
    expect(await m).toEqual(['fs']);
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('req-b');

    pointerClick(lastButton());
    await act(async () => {});
    expect(bDecision).toBeNull();

    act(() => void vi.advanceTimersByTime(600));
    pointerClick(lastButton());
    await act(async () => {});
    expect(bDecision).toBe('grant');
  });
});

describe('PermissionPrompt — 勾选不打断焦点', () => {
  // Modal 的焦点 / 键盘 effect 依赖 onClose 的引用;每次渲染换一个新的 onClose,勾选一次就会把焦点先还给
  // 弹窗外、再跳回弹窗内第一个元素。
  it('勾选权限项后焦点仍在该勾选框上', async () => {
    void usePermissionPromptStore.getState().request('plugin.a', ['fs', 'network', 'shell']);
    render(<PermissionPrompt />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const boxes = Array.from(
      document.querySelectorAll<HTMLElement>('.wm-modal-content [role=checkbox], .wm-modal-content input[type=checkbox]'),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    const target = boxes[2]!;
    target.focus();
    pointerClick(target);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(target);
    usePermissionPromptStore.getState().denyAll();
  });
});

describe('PermissionPrompt UI', () => {
  it('pluginId 模板 prefix/suffix 使用 memoized parts,不在 JSX IIFE 中重复拆分', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/permissions/PermissionPrompt.tsx'),
      'utf8',
    );

    expect(src).toContain('const promptBodyParts = useMemo(');
    expect(src).toContain('const fsScopeBodyParts = useMemo(');
    expect(src).toContain('promptBodyParts.prefix');
    expect(src).toContain('fsScopeBodyParts.prefix');
    expect(src).not.toContain('const parts = splitPluginIdTemplate(');
  });

  it('复制勾选权限时单趟扫描 Set,不调用 Array.from', () => {
    const selected = new Set(['fs', 'network'] as const);
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      expect(copySelectedPermissions(selected)).toEqual(['fs', 'network']);
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(copySelectedPermissions.toString()).not.toContain('out.push(');
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('复制空勾选权限时复用稳定空数组', () => {
    expect(copySelectedPermissions(new Set())).toEqual([]);
    expect(copySelectedPermissions(new Set())).toBe(
      copySelectedPermissions(new Set()),
    );
  });

  it('无 pending → 不渲染', () => {
    const { container } = render(<PermissionPrompt />);
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  // a11y(A13):Modal 现为 role=dialog(A10),须经 aria-labelledby 关联标题,否则 AT 进
  // 弹窗只听到无名 dialog。断言 dialog 有可访问名(= 标题文本)。
  it('a11y · 弹窗是有可访问名的 role=dialog', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('com.x', ['fs']);
    });
    const dialog = document.querySelector('.wm-modal-content')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    const title = document.getElementById(labelledby!);
    expect(title?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  // shell 例外(默认不勾选),见 shell-not-preselected.spec.tsx
  it('pending 渲染 + 默认全选', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('com.x', ['fs', 'network']);
    });
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '.wm-modal-content input[type="checkbox"]',
    );
    expect(checkboxes.length).toBe(2);
    expect(Array.from(checkboxes).every((c) => c.checked)).toBe(true);
  });

  it('pluginId 模板拆分不通过 split(marker) 物化 parts 数组', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      render(<PermissionPrompt />);
      act(() => {
        void usePermissionPromptStore.getState().request('com.x', ['fs']);
      });
      expect(document.querySelector('.wm-modal-content code')?.textContent).toBe(
        'com.x',
      );
      const markerCalls = splitSpy.mock.calls.filter(
        ([sep]) => typeof sep === 'string' && sep === ' __PID__ ',
      );
      expect(markerCalls).toHaveLength(0);
    } finally {
      splitSpy.mockRestore();
    }
  });

  it('点击 checkbox 切换勾选,授权按钮显数量', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('com.x', ['fs', 'network']);
    });
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '.wm-modal-content input[type="checkbox"]',
    );
    pointerClick(checkboxes[0]!); // 取消 fs
    expect(checkboxes[0]!.checked).toBe(false);
    // topic-21: i18n 文案 '授权选中（1）'（全角括号）
    expect(document.querySelector('.wm-modal-content')?.textContent).toContain(
      '授权选中（1）',
    );
  });

  it('授权选中 → grant 触发,Promise resolve 含勾选', async () => {
    render(<PermissionPrompt />);
    let promise: Promise<readonly string[]> | null = null;
    act(() => {
      promise = usePermissionPromptStore
        .getState()
        .request('com.x', ['fs', 'network']) as Promise<readonly string[]>;
    });
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '.wm-modal-content input[type="checkbox"]',
    );
    pointerClick(checkboxes[1]!); // 取消 network,只剩 fs
    // 首次出现的防误触延迟过后才可授予(见 first-appearance-grant-guard.spec.tsx)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 550));
    });
    const grantBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent?.includes('授权选中'))!;
    pointerClick(grantBtn);
    expect(await promise!).toEqual(['fs']);
  });

  it('全部拒绝按钮 → resolve []', async () => {
    render(<PermissionPrompt />);
    let promise: Promise<readonly string[]> | null = null;
    act(() => {
      promise = usePermissionPromptStore
        .getState()
        .request('com.x', ['fs']) as Promise<readonly string[]>;
    });
    const denyBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent?.includes('全部拒绝'))!;
    pointerClick(denyBtn);
    expect(await promise!).toEqual([]);
  });

  // shell 例外(「全选」不含它)与防误触延迟,见 select-all-and-checkbox-guard.spec.tsx
  it('全选按钮 → 把所有 checkbox 勾上', async () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('com.x', ['fs', 'network']);
    });
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '.wm-modal-content input[type="checkbox"]',
    );
    // 先全部取消
    pointerClick(checkboxes[0]!);
    pointerClick(checkboxes[1]!);
    expect(Array.from(checkboxes).every((c) => !c.checked)).toBe(true);
    // 「全选」是授予方向:出现延迟过后才有效
    await act(async () => {
      await new Promise((r) => setTimeout(r, 550));
    });
    // 点全选
    const selectAll = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '全选')!;
    pointerClick(selectAll);
    expect(Array.from(checkboxes).every((c) => c.checked)).toBe(true);
  });
});
