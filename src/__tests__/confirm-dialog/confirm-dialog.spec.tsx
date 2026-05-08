// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { ConfirmDialog } from '../../panels/Explorer/ConfirmDialog';

afterEach(() => cleanup());

function renderD(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return render(
    <ConfirmDialog
      open
      title="确认删除"
      description="此操作不可撤销"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...over}
    />,
  );
}

describe('ConfirmDialog', () => {
  it('open=false → 不渲染', () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="t"
        description="d"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  it('open=true → 渲染 title + description + 默认按钮', () => {
    renderD({ description: '危险动作' });
    const modal = document.querySelector('.wm-modal-content')!;
    expect(modal.textContent).toContain('确认删除');
    expect(modal.textContent).toContain('危险动作');
    expect(modal.textContent).toContain('确认');
    expect(modal.textContent).toContain('取消');
  });

  it('confirmLabel / cancelLabel 覆盖默认文案', () => {
    renderD({
      title: '删除',
      confirmLabel: 'YES',
      cancelLabel: 'NO',
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toContain('YES');
    expect(labels).toContain('NO');
    expect(labels).not.toContain('确认');
    expect(labels).not.toContain('取消');
  });

  it('destructive=true → 确认按钮 data-variant="danger"', () => {
    renderD({ destructive: true });
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    const confirm = Array.from(buttons).find((b) => b.textContent === '确认')!;
    expect(confirm.getAttribute('data-variant')).toBe('danger');
  });

  it('destructive=false(默认) → 确认按钮 primary', () => {
    renderD();
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '.wm-modal-content button',
    );
    const confirm = Array.from(buttons).find((b) => b.textContent === '确认')!;
    expect(confirm.getAttribute('data-variant')).toBe('primary');
  });

  it('点确认 → onConfirm 被调,onCancel 不调', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderD({ onConfirm, onCancel });
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '确认')!;
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('点取消 → onCancel 被调', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderD({ onConfirm, onCancel });
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '取消')!;
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
