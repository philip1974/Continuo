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

beforeEach(() => {
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
    currentFsScope: null,
  });
});
afterEach(() => cleanup());

// 排队后弹窗会从 A 直接换成 B(按钮位置不变、B 默认全选)。对 A 的「授予」连点两下,第二下不能落到 B 上。
describe('PermissionPrompt — 排队切换时防连点误授', () => {
  it('A 结算后立刻出现的 B:短时间内的点击被忽略,之后才生效', async () => {
    vi.useFakeTimers();
    try {
      const a = usePermissionPromptStore.getState().request('plugin.a', ['fs']);
      const b = usePermissionPromptStore.getState().request('plugin.b', ['shell']);
      render(<PermissionPrompt />);
      const grantButton = (): HTMLButtonElement =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).at(-1)!;

      fireEvent.click(grantButton()); // 授予 A
      expect(await a).toEqual(['fs']);
      expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('plugin.b');

      fireEvent.click(grantButton()); // 连点的第二下,落在 B 的按钮上
      expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('plugin.b');

      act(() => void vi.advanceTimersByTime(600));
      fireEvent.click(grantButton()); // 用户看清后再点
      expect(await b).toEqual(['shell']);
    } finally {
      vi.useRealTimers();
    }
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
    fireEvent.click(checkboxes[0]!); // 取消 fs
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
    fireEvent.click(checkboxes[1]!); // 取消 network,只剩 fs
    const grantBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent?.includes('授权选中'))!;
    fireEvent.click(grantBtn);
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
    fireEvent.click(denyBtn);
    expect(await promise!).toEqual([]);
  });

  it('全选按钮 → 把所有 checkbox 勾上', () => {
    render(<PermissionPrompt />);
    act(() => {
      void usePermissionPromptStore.getState().request('com.x', ['fs', 'shell']);
    });
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '.wm-modal-content input[type="checkbox"]',
    );
    // 先取消两个
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    expect(Array.from(checkboxes).every((c) => !c.checked)).toBe(true);
    // 点全选
    const selectAll = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '全选')!;
    fireEvent.click(selectAll);
    expect(Array.from(checkboxes).every((c) => c.checked)).toBe(true);
  });
});
