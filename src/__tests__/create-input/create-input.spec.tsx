// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, cleanup } from '@testing-library/react';
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

function fireKey(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

describe('CreateInput — 渲染', () => {
  it('type=file → placeholder「新建文件名…」+ 父目录显示', () => {
    const { container, input } = setup({ type: 'file', parentDir: '/proj' });
    expect(input.placeholder).toBe('新建文件名…');
    expect(container.textContent).toContain('在：/proj');
  });

  it('传 rootPath:父目录显示相对 workspace 的路径(根目录显示 workspace 名),完整路径放 title', () => {
    const nested = setup({ parentDir: '/home/u/proj/src/components', rootPath: '/home/u/proj' });
    const label = nested.getByText('在：src/components');
    expect(label.getAttribute('title')).toBe('/home/u/proj/src/components');
    cleanup();
    const atRoot = setup({ parentDir: '/home/u/proj', rootPath: '/home/u/proj' });
    expect(atRoot.getByText('在：proj').getAttribute('title')).toBe('/home/u/proj');
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

  // IME:拼音 / 日文输入法组合中按 Enter 是确认候选词、Esc 是取消组合,不是提交 / 取消新建。
  it('IME 组合中的 Enter / Esc(isComposing 或 keyCode 229)→ 不提交也不取消;组合结束后普通 Enter 照常提交', () => {
    const { input, onSubmit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '中文' } });
    fireKey(input, 'Enter', { isComposing: true });
    fireKey(input, 'Escape', { isComposing: true });
    fireKey(input, 'Enter', { keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith('中文');
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

describe('CreateInput — 提交失败可重试 + 内联错误', () => {
  it('onSubmit 结果为 false(创建失败)→ once 守卫复位,再按 Enter 重新提交', async () => {
    const onSubmit = vi.fn(async () => false);
    const { input } = setup({ onSubmit });
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireKey(input, 'Enter');
    await act(async () => {});
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('onSubmit 结果为 true(成功,等父层卸载)→ 仍只提交一次', async () => {
    const onSubmit = vi.fn(async () => true);
    const { input } = setup({ onSubmit });
    fireEvent.change(input, { target: { value: 'a.ts' } });
    fireKey(input, 'Enter');
    await act(async () => {});
    fireKey(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('error → 输入框下方 role=alert 显示原因,输入框 aria-invalid 并关联描述', () => {
    const { input, getByRole } = setup({ error: '已存在' });
    const alert = getByRole('alert');
    expect(alert.textContent).toBe('已存在');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('无 error → 不渲染提示,aria-invalid 缺省', () => {
    const { input, queryByRole } = setup();
    expect(queryByRole('alert')).toBeNull();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('修改输入 → 回调 onEdit(父层据此清除错误)', () => {
    const onEdit = vi.fn();
    const { input } = setup({ error: '已存在', onEdit });
    fireEvent.change(input, { target: { value: 'b.ts' } });
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe('CreateInput — 失焦(VSCode InlineEditInputBox 同款)', () => {
  const tick = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  function focusIn(input: HTMLInputElement) {
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
  }
  function outsideButton(): HTMLButtonElement {
    return document.body.appendChild(document.createElement('button'));
  }

  it('有名字时焦点移到输入条之外 → onSubmit(trim 后)', async () => {
    const { input, onSubmit, onCancel } = setup();
    focusIn(input);
    fireEvent.change(input, { target: { value: '  b.ts ' } });
    const other = outsideButton();
    act(() => other.focus());
    await tick();
    // 第二参数标明是失焦提交:失败时父层直接放弃并 toast(不留无焦点的孤立输入条)
    expect(onSubmit).toHaveBeenCalledWith('b.ts', 'blur');
    expect(onCancel).not.toHaveBeenCalled();
    other.remove();
  });

  it('空名时焦点移到之外 → onCancel("blur")(父层据此不把焦点拉回树)', async () => {
    const { input, onSubmit, onCancel } = setup();
    focusIn(input);
    const other = outsideButton();
    act(() => other.focus());
    await tick();
    expect(onCancel).toHaveBeenCalledWith('blur');
    expect(onSubmit).not.toHaveBeenCalled();
    other.remove();
  });

  it('上次提交失败(错误提示还在)时失焦 → 放弃,不再重复提交', async () => {
    const { input, onSubmit, onCancel } = setup({ error: '已存在' });
    focusIn(input);
    fireEvent.change(input, { target: { value: 'dup.ts' } });
    const other = outsideButton();
    act(() => other.focus());
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('blur');
    other.remove();
  });

  it('焦点移到输入条里的 ✕ 按钮 → 继续编辑(随后点击 = 放弃,不先提交)', async () => {
    const { input, container, onSubmit, onCancel } = setup();
    focusIn(input);
    fireEvent.change(input, { target: { value: 'c.ts' } });
    const cancelBtn = container.querySelector<HTMLButtonElement>('button[aria-label="取消"]')!;
    act(() => cancelBtn.focus());
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('失焦但 activeElement 仍是输入框(窗口失焦:切应用 / 输入法切换)→ 继续编辑', async () => {
    const { input, onSubmit, onCancel } = setup();
    focusIn(input);
    fireEvent.change(input, { target: { value: 'd.ts' } });
    act(() => {
      input.dispatchEvent(new FocusEvent('blur'));
    });
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Enter 已提交 / Esc 已放弃之后的失焦不再处理', async () => {
    const a = setup();
    focusIn(a.input);
    fireEvent.change(a.input, { target: { value: 'e.ts' } });
    fireKey(a.input, 'Enter');
    const other = outsideButton();
    act(() => other.focus());
    await tick();
    expect(a.onSubmit).toHaveBeenCalledTimes(1);
    expect(a.onCancel).not.toHaveBeenCalled();
    cleanup();
    const b = setup();
    focusIn(b.input);
    fireKey(b.input, 'Escape');
    act(() => other.focus());
    await tick();
    expect(b.onCancel).toHaveBeenCalledTimes(1);
    expect(b.onCancel).toHaveBeenCalledWith();
    other.remove();
  });
});

// VSCode InlineEditInputBox + validateFileName:边输入边校验(如同目录已存在同名项),有错时 Enter 不提交、失焦放弃。
describe('CreateInput — 实时校验(validate)', () => {
  const tick = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  const validate = (name: string) => (name.trim() === 'dup.ts' ? '已存在 dup.ts' : null);

  it('输入即校验:无效 → 下方 role=alert 提示、aria-invalid;改正后提示消失', () => {
    const { input, queryByRole } = setup({ validate });
    fireEvent.change(input, { target: { value: 'dup.ts' } });
    expect(queryByRole('alert')?.textContent).toBe('已存在 dup.ts');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: 'dup2.ts' } });
    expect(queryByRole('alert')).toBeNull();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('有校验错误时 Enter → 不提交也不取消,输入保留', () => {
    const { input, onSubmit, onCancel } = setup({ validate });
    fireEvent.change(input, { target: { value: 'dup.ts' } });
    fireKey(input, 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(input.value).toBe('dup.ts');
  });

  it('有校验错误时失焦 → onCancel("blur"),不提交', async () => {
    const { input, onSubmit, onCancel } = setup({ validate });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'dup.ts' } });
    const other = document.body.appendChild(document.createElement('button'));
    act(() => other.focus());
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('blur');
    other.remove();
  });

  it('提交失败的 error 优先于校验结果显示', () => {
    const { input, queryByRole } = setup({ validate, error: '权限不足' });
    fireEvent.change(input, { target: { value: 'dup.ts' } });
    expect(queryByRole('alert')?.textContent).toBe('权限不足');
  });
});

describe('createNameConflict(新建实时重名判定)', () => {
  it('与已加载子项同名 → 返回规范化后的名字;平台感知大小写;空名 / 嵌套名不判', async () => {
    const { createNameConflict } = await import('../../panels/Explorer/path-utils');
    const siblings = ['bravo.ts', 'alpha'];
    expect(createNameConflict('  bravo.ts ', siblings, true)).toBe('bravo.ts');
    expect(createNameConflict('ALPHA', siblings, true)).toBe('ALPHA');
    expect(createNameConflict('ALPHA', siblings, false)).toBeNull();
    expect(createNameConflict('delta.ts', siblings, true)).toBeNull();
    expect(createNameConflict('   ', siblings, true)).toBeNull();
    expect(createNameConflict('alpha/new.ts', siblings, true)).toBeNull();
    // NFD(Finder 给的名字)与 NFC 视为同名
    expect(createNameConflict('café.ts', ['café.ts'], true)).toBe('café.ts');
  });
});
