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
