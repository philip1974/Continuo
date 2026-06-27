// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { CreateInput } from '../../panels/Explorer/CreateInput';

afterEach(() => cleanup());

function setup(over: Partial<Parameters<typeof CreateInput>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <CreateInput
      type="file"
      parentDir="/proj"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...over}
    />,
  );
  const input = utils.container.querySelector('input')!;
  return { ...utils, input, onSubmit, onCancel };
}

function fireKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

describe('CreateInput — 渲染', () => {
  it('type=file → placeholder「新建文件名…」+ 父目录显示', () => {
    const { container, input } = setup({ type: 'file', parentDir: '/proj' });
    expect(input.placeholder).toBe('新建文件名…');
    expect(container.textContent).toContain('在: /proj');
  });

  it('type=dir → placeholder「新建文件夹名…」', () => {
    const { input } = setup({ type: 'dir' });
    expect(input.placeholder).toBe('新建文件夹名…');
  });
});

describe('CreateInput — 键盘行为', () => {
  it('Enter + 非空 → onSubmit(trim 后),onCancel 不调', () => {
    const { input, onSubmit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '  hello.ts  ' } });
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith('hello.ts');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Enter + 全空白 → onCancel,onSubmit 不调', () => {
    const { input, onSubmit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '   ' } });
    fireKey(input, 'Enter');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // race(R82):父层 setCreating(null)(卸载)等 React commit,快速双 Enter 会两次 onSubmit →
  // 并发两次 createFile/createDir(第二笔 EEXIST 报错)。submittedRef once 守卫:只提交一次。
  it('R82 快速双 Enter → onSubmit 只调一次(once 守卫)', () => {
    const { input, onSubmit, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireKey(input, 'Enter');
    fireKey(input, 'Enter'); // commit/卸载前的第二次 Enter
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('a.ts');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Enter + 空字符串 → onCancel', () => {
    const { input, onSubmit, onCancel } = setup();
    fireKey(input, 'Enter');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Esc → onCancel,onSubmit 不调', () => {
    const { input, onSubmit, onCancel } = setup();
    fireEvent.change(input, { target: { value: 'hello' } });
    fireKey(input, 'Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('CreateInput — E290 leaf 名长度截断(before-IPC 输入截断族)', () => {
  it('超长 paste → 受控 value 截断到 FS_NAME_MAX(255),不整段进 React state', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'x'.repeat(10_000) } });
    // onChange slice(FS_NAME_MAX)→ 受控 value 重渲染后 ≤ 255。
    expect(input.value.length).toBe(255);
  });

  it('超长 paste 后 Enter → onSubmit 收到 ≤ FS_NAME_MAX 的名(不跨 IPC 放大)', () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: 'a'.repeat(5_000) } });
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0]![0] as string).length).toBe(255);
  });

  it('原生 maxLength 属性兜底 = FS_NAME_MAX', () => {
    const { input } = setup();
    expect(input.maxLength).toBe(255);
  });
});

describe('CreateInput — 关闭按钮', () => {
  it('点叉号 → onCancel', () => {
    const { container, onCancel } = setup();
    const cancelBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.getAttribute('aria-label') === '取消')!;
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('CreateInput — 卸载', () => {
  it('卸载后 Enter 不再触发 onSubmit', () => {
    const { input, unmount, onSubmit } = setup();
    fireEvent.change(input, { target: { value: 'x.ts' } });
    unmount();
    fireKey(input, 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
