// @vitest-environment jsdom
// 安全:manifest 权限弹窗默认预选声明的权限,但 `shell`(等同于完全访问本机)不预选 —— 须用户主动勾选(或点「全选」)
// 才会授予,不能随一次「授权选中」顺手给出。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { PROMPT_GRANT_ARM_DELAY_MS } from '../../lib/use-prompt-grant-guard';
import type { PermissionKey } from '../../plugins/permissions';

const store = () => usePermissionPromptStore.getState();
const buttons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'));
const grantButton = (): HTMLButtonElement => buttons().at(-1)!;
const selectAllButton = (): HTMLButtonElement => buttons()[0]!;
const checkboxes = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll<HTMLInputElement>('.wm-modal-content input[type="checkbox"]'));
/** 等过弹窗出现后的防误触延迟(见 first-appearance-grant-guard.spec.tsx)。 */
const waitArmed = (): void => act(() => void vi.advanceTimersByTime(PROMPT_GRANT_ARM_DELAY_MS));

/** 发起一个 manifest 权限请求(弹窗随之出现),返回其结算结果的读取器(未结算 → null)。 */
function manifest(
  pluginId: string,
  perms: readonly PermissionKey[],
): () => Promise<readonly PermissionKey[] | null> {
  let settled: readonly PermissionKey[] | null = null;
  act(() => {
    void store()
      .request(pluginId, perms)
      .then((v) => (settled = v));
  });
  return async () => {
    await act(async () => {});
    return settled;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  usePermissionPromptStore.setState({ pending: null, resolve: null, currentFsScope: null });
  render(<PermissionPrompt />);
});
afterEach(() => {
  cleanup();
  usePermissionPromptStore.setState({ pending: null, resolve: null, currentFsScope: null });
  vi.useRealTimers();
});

describe('manifest 权限弹窗:shell 默认不勾选', () => {
  it('声明的权限里 shell 不预选,其余照旧预选;直接「授权选中」不含 shell', async () => {
    const granted = manifest('plugin.a', ['fs', 'shell', 'network', 'clipboard', 'mcp-tools']);
    expect(checkboxes().map((c) => c.checked)).toEqual([true, false, true, true, true]);
    waitArmed();
    fireEvent.click(grantButton());
    expect(await granted()).toEqual(['fs', 'network', 'clipboard', 'mcp-tools']);
  });

  it('只声明 shell:默认一项都不选,直接「授权选中」等于全部拒绝', async () => {
    const granted = manifest('plugin.a', ['shell']);
    expect(checkboxes().map((c) => c.checked)).toEqual([false]);
    waitArmed();
    fireEvent.click(grantButton());
    expect(await granted()).toEqual([]);
  });

  it('用户主动勾选 shell 后才会被授予', async () => {
    const granted = manifest('plugin.a', ['fs', 'shell']);
    fireEvent.click(checkboxes()[1]!);
    waitArmed();
    fireEvent.click(grantButton());
    expect(await granted()).toEqual(['fs', 'shell']);
  });

  it('「全选」是用户的主动操作,包含 shell', async () => {
    const granted = manifest('plugin.a', ['shell', 'fs']);
    fireEvent.click(selectAllButton());
    expect(checkboxes().every((c) => c.checked)).toBe(true);
    waitArmed();
    fireEvent.click(grantButton());
    expect(await granted()).toEqual(['shell', 'fs']);
  });

  it('排队切换到的下一个请求同样不预选 shell', async () => {
    const a = manifest('plugin.a', ['fs']);
    const b = manifest('plugin.b', ['shell', 'clipboard']);
    waitArmed();
    fireEvent.click(grantButton());
    expect(await a()).toEqual(['fs']);
    expect(checkboxes().map((c) => c.checked)).toEqual([false, true]);
    waitArmed();
    fireEvent.click(grantButton());
    expect(await b()).toEqual(['clipboard']);
  });
});
