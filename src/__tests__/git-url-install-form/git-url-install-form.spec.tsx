// @vitest-environment jsdom
// 「从 Git URL 安装」输入行:Enter 提交 + 安装中不丢焦点。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitUrlInstallForm } from '../../plugins/GitUrlInstallForm';

afterEach(() => cleanup());

function deferred() {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderForm(install: (url: string) => Promise<boolean>) {
  render(
    <GitUrlInstallForm
      ariaLabel="Git URL"
      placeholder="https://github.com/x/y.git"
      installLabel="安装"
      installingLabel="安装中…"
      install={install}
    />,
  );
  return {
    input: screen.getByRole('textbox', { name: 'Git URL' }) as HTMLInputElement,
    button: () => screen.getByRole('button') as HTMLButtonElement,
  };
}

describe('GitUrlInstallForm · Enter 提交', () => {
  it('输入 URL 后按 Enter → install(trim 后的 URL)一次', async () => {
    const install = vi.fn(async () => true);
    const { input } = renderForm(install);
    fireEvent.change(input, { target: { value: '  https://x/y.git  ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('https://x/y.git');
  });

  it('IME 组合中的 Enter(isComposing / keyCode 229)→ 不安装', async () => {
    const install = vi.fn(async () => true);
    const { input } = renderForm(install);
    fireEvent.change(input, { target: { value: 'https://x/y.git' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('空输入按 Enter → 不安装', async () => {
    const install = vi.fn(async () => true);
    const { input } = renderForm(install);
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(install).not.toHaveBeenCalled();
  });
});

describe('GitUrlInstallForm · 安装中焦点', () => {
  it('安装中输入框 readOnly(不 disabled),焦点留在输入框;再按 Enter 不重复安装', async () => {
    const d = deferred();
    const install = vi.fn(() => d.promise);
    const { input } = renderForm(install);
    fireEvent.change(input, { target: { value: 'https://x/y.git' } });
    input.focus();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(install).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve(true);
      await d.promise;
    });
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('');
  });

  it('点按钮发起的安装结束后 → 焦点回到输入框', async () => {
    const d = deferred();
    const install = vi.fn(() => d.promise);
    const { input, button } = renderForm(install);
    fireEvent.change(input, { target: { value: 'https://x/y.git' } });
    button().focus();
    await act(async () => {
      fireEvent.click(button());
    });
    // busy 时按钮 disabled:真实浏览器里焦点随之掉回 body(jsdom 不模拟),这里显式模拟
    button().blur();
    await act(async () => {
      d.resolve(false);
      await d.promise;
    });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('https://x/y.git');
  });
});
