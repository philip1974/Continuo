// a11y(A27):Radix 右键菜单关闭焦点还原策略。默认保留还原(Esc/普通项关闭),仅「新建/
// 重命名」一次性跳过(它们随后打开自聚焦输入框,还原会抢焦点)。
import { describe, it, expect, vi } from 'vitest';
import { createMenuFocusRestore } from '../../panels/Explorer/menu-close-focus';

function fakeEvent() {
  return { preventDefault: vi.fn() };
}

describe('a11y(A27) menu-close-focus 焦点还原策略', () => {
  it('默认(未 skipOnce)→ 不 preventDefault,保留 Radix 焦点还原', () => {
    const fr = createMenuFocusRestore();
    const e = fakeEvent();
    fr.onCloseAutoFocus(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('skipOnce 后下一次关闭 → preventDefault(跳过还原)', () => {
    const fr = createMenuFocusRestore();
    fr.skipOnce();
    const e = fakeEvent();
    fr.onCloseAutoFocus(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('skipOnce 是一次性:再次关闭恢复默认还原', () => {
    const fr = createMenuFocusRestore();
    fr.skipOnce();
    const e1 = fakeEvent();
    fr.onCloseAutoFocus(e1); // 消费 skip
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    const e2 = fakeEvent();
    fr.onCloseAutoFocus(e2); // 已恢复默认
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });
});
