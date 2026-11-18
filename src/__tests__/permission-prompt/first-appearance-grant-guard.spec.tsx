// @vitest-environment jsdom
// 安全:插件权限弹窗(manifest 权限 / fs-scope 文件夹授权)的出现时机由插件决定。弹窗**首次出现**后的一小段时间内,
// 授予方向的鼠标 / 键盘激活无效(用户正在打字 / 点击时弹窗抢焦点,落进来的按键 / 点击不能变成授予);拒绝与 Esc
// 立即可用;初始焦点在拒绝按钮。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { PROMPT_GRANT_ARM_DELAY_MS } from '../../lib/use-prompt-grant-guard';

const store = () => usePermissionPromptStore.getState();
const buttons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'));
/** 两种弹窗的按钮顺序都以「拒绝」「授予」收尾。 */
const grantButton = (): HTMLButtonElement => buttons().at(-1)!;
const denyButton = (): HTMLButtonElement => buttons().at(-2)!;
const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const flush = (): Promise<void> => act(async () => {});

/** 发起一个请求(弹窗随之出现),返回其结算结果的读取器(未结算 → null)。 */
function track<T>(start: () => Promise<T>): () => Promise<T | null> {
  let settled: T | null = null;
  act(() => {
    void start().then((v) => (settled = v));
  });
  return async () => {
    await flush();
    return settled;
  };
}
const manifest = (pluginId: string, perms: readonly ('fs' | 'network' | 'shell' | 'clipboard')[]) =>
  track(() => store().request(pluginId, perms));
const fsScope = (requestId: string) =>
  track(() =>
    store().requestFsScope({
      requestId,
      pluginId: 'plugin.x',
      scopes: [{ path: '/Users/me', mode: 'rw', displayPath: '~' }],
    }),
  );

function resetStore(): void {
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
    fsScopePending: {},
    fsScopeQueue: [],
    currentFsScope: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  render(<PermissionPrompt />);
});
afterEach(() => {
  cleanup();
  resetStore();
  vi.useRealTimers();
});

describe('manifest 权限弹窗:首次出现的防误触延迟', () => {
  it(`出现后 ${PROMPT_GRANT_ARM_DELAY_MS}ms 内鼠标 / 键盘激活「授权选中」无效,弹窗保持;之后有效`, async () => {
    const granted = manifest('plugin.a', ['fs', 'network']);
    fireEvent.click(grantButton());
    // 键盘激活(Enter / Space 落在按钮上)在浏览器里就是一次 detail=0 的 click
    fireEvent.click(grantButton(), { detail: 0 });
    advance(PROMPT_GRANT_ARM_DELAY_MS - 1);
    fireEvent.click(grantButton());
    expect(await granted()).toBeNull();
    expect(store().pending?.pluginId).toBe('plugin.a');

    advance(1);
    fireEvent.click(grantButton());
    expect(await granted()).toEqual(['fs', 'network']);
  });

  it('「全部拒绝」出现后立即可用', async () => {
    const granted = manifest('plugin.a', ['fs']);
    fireEvent.click(denyButton());
    expect(await granted()).toEqual([]);
  });

  it('Esc 出现后立即可用(按全部拒绝收口)', async () => {
    const granted = manifest('plugin.a', ['fs']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await granted()).toEqual([]);
  });

  it('初始焦点在「全部拒绝」(不在勾选框 / 授予按钮上)', () => {
    manifest('plugin.a', ['fs', 'shell']);
    advance(50);
    expect(document.activeElement).toBe(denyButton());
  });

  it('上一个落定、空闲一段时间后再出现的弹窗同样重新计时', async () => {
    const a = manifest('plugin.a', ['fs']);
    advance(PROMPT_GRANT_ARM_DELAY_MS);
    fireEvent.click(grantButton());
    expect(await a()).toEqual(['fs']);
    expect(store().pending).toBeNull();

    advance(10_000);
    const b = manifest('plugin.b', ['network']);
    fireEvent.click(grantButton());
    expect(await b()).toBeNull();
    advance(PROMPT_GRANT_ARM_DELAY_MS);
    fireEvent.click(grantButton());
    expect(await b()).toEqual(['network']);
  });

  it('排队切换到下一个请求:重新计时,焦点回到「全部拒绝」(按住的 Enter 不会在延迟过后落到新请求的授予上)', async () => {
    const a = manifest('plugin.a', ['fs']);
    const b = manifest('plugin.b', ['network']);
    advance(PROMPT_GRANT_ARM_DELAY_MS);
    grantButton().focus();
    fireEvent.click(grantButton());
    expect(await a()).toEqual(['fs']);
    expect(store().pending?.pluginId).toBe('plugin.b');

    advance(PROMPT_GRANT_ARM_DELAY_MS - 1);
    fireEvent.click(grantButton());
    expect(await b()).toBeNull();
    expect(document.activeElement).toBe(denyButton());

    advance(1);
    fireEvent.click(grantButton());
    expect(await b()).toEqual(['network']);
  });
});

describe('fs-scope 文件夹授权弹窗:首次出现的防误触延迟', () => {
  it(`出现后 ${PROMPT_GRANT_ARM_DELAY_MS}ms 内鼠标 / 键盘激活「授权」无效,弹窗保持;之后有效`, async () => {
    const decision = fsScope('req-a');
    fireEvent.click(grantButton());
    fireEvent.click(grantButton(), { detail: 0 });
    advance(PROMPT_GRANT_ARM_DELAY_MS - 1);
    fireEvent.click(grantButton());
    expect(await decision()).toBeNull();
    expect(store().currentFsScope?.requestId).toBe('req-a');

    advance(1);
    fireEvent.click(grantButton());
    expect(await decision()).toBe('grant');
  });

  it('「拒绝」出现后立即可用', async () => {
    const decision = fsScope('req-a');
    fireEvent.click(denyButton());
    expect(await decision()).toBe('deny');
  });

  it('Esc 出现后立即可用(按拒绝收口)', async () => {
    const decision = fsScope('req-a');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await decision()).toBe('deny');
  });

  it('初始焦点在「拒绝」', () => {
    fsScope('req-a');
    advance(50);
    expect(document.activeElement).toBe(denyButton());
  });
});
