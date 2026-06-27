import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  Button,
  IconButton,
  MenuItem,
  NavRailButton,
  SegmentedControl,
  TabNav,
  TabNavItem,
} from '../../design';

afterEach(() => cleanup());

describe('Button data-attr 契约', () => {
  it('默认 variant=primary size=md', () => {
    const { container } = render(<Button>OK</Button>);
    const btn = container.querySelector('button')!;
    expect(btn.dataset.variant).toBe('primary');
    expect(btn.dataset.size).toBe('md');
    expect(btn.className).toContain('wm-button');
  });

  it('variant=outlined(Continuo 扩展)正确写入 data-variant', () => {
    const { container } = render(<Button variant="outlined">Open</Button>);
    expect(container.querySelector('button')!.dataset.variant).toBe('outlined');
  });

  it('className 合并而非覆盖 wm-button', () => {
    const { container } = render(<Button className="extra">x</Button>);
    const cls = container.querySelector('button')!.className;
    expect(cls).toContain('wm-button');
    expect(cls).toContain('extra');
  });

  it('disabled + onClick:点击不触发', () => {
    const fn = vi.fn();
    const { container } = render(
      <Button disabled onClick={fn}>
        x
      </Button>,
    );
    fireEvent.click(container.querySelector('button')!);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('size=xs 写入 data-size', () => {
    const { container } = render(<IconButton size="xs">×</IconButton>);
    expect(container.querySelector('button')!.dataset.size).toBe('xs');
  });
});

describe('MenuItem', () => {
  it('role=menuitem,variant=danger 时 data-variant 正确', () => {
    const { container } = render(
      <MenuItem variant="danger" onClick={() => {}}>
        Delete
      </MenuItem>,
    );
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('role')).toBe('menuitem');
    expect(btn.dataset.variant).toBe('danger');
  });

  // a11y(A31,A29 同族):role=menuitem 须移出普通 Tab 顺序(焦点由 useMenuKeyboard 程序管理)。
  it('a11y · role=menuitem 不在 Tab 顺序(tabIndex=-1)', () => {
    const { container } = render(<MenuItem onClick={() => {}}>X</MenuItem>);
    expect(container.querySelector('button')!.tabIndex).toBe(-1);
  });
});

describe('NavRailButton', () => {
  it('active=true 渲染 __active-bar 子元素 + aria-pressed=true', () => {
    const { container } = render(
      <NavRailButton title="Files" active onClick={() => {}}>
        F
      </NavRailButton>,
    );
    const btn = container.querySelector('button')!;
    expect(btn.dataset.active).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.wm-nav-rail-button__active-bar')).not.toBeNull();
  });

  it('active=false 不渲染 active-bar', () => {
    const { container } = render(
      <NavRailButton title="Files" active={false} onClick={() => {}}>
        F
      </NavRailButton>,
    );
    expect(container.querySelector('.wm-nav-rail-button__active-bar')).toBeNull();
  });

  // a11y(A32):非 toggle 用法(不传 active)不应暴露 aria-pressed,否则 AT 误读成切换按钮。
  it('a11y · 不传 active → 无 aria-pressed(普通按钮);传 active → 有', () => {
    const { container: plain } = render(
      <NavRailButton title="Run" onClick={() => {}}>
        R
      </NavRailButton>,
    );
    expect(plain.querySelector('button')!.hasAttribute('aria-pressed')).toBe(
      false,
    );
    const { container: toggleOff } = render(
      <NavRailButton title="Explorer" active={false} onClick={() => {}}>
        E
      </NavRailButton>,
    );
    expect(
      toggleOff.querySelector('button')!.getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

describe('SegmentedControl', () => {
  it('泛型 onChange 收到正确 id, active 段写 data-active=true', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons[0]?.dataset.active).toBe('true');
    expect(buttons[1]?.dataset.active).toBe('false');
    fireEvent.click(buttons[1]!);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  // a11y(A24,A23 同族):role=radiogroup 须配 WAI-ARIA radio 键盘模型 —— roving tabindex
  // (仅选中项可 Tab)+ 方向键自动激活(移焦并切换选中,Home/End 首尾,循环)。
  it('a11y · roving tabindex + 方向键自动激活切换', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role=radio]'),
    );
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]); // 仅选中可 Tab
    const group = container.querySelector('[role=radiogroup]')!;
    // ArrowRight from 'a' → 选中 'b'(自动激活)
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    // ArrowLeft from 'a'(value 未受控更新)→ 循环到末 'c'
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    // End → 'c',Home → 'a'
    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('a');
  });
});

describe('TabNav + TabNavItem', () => {
  it('dirty=true 渲染 __dirty-dot;onClose 提供时渲染 __close 按钮', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem dirty onSelect={() => {}} onClose={() => {}}>
          file.md
        </TabNavItem>
      </TabNav>,
    );
    expect(container.querySelector('.wm-tab-nav-item__dirty-dot')).not.toBeNull();
    expect(container.querySelector('.wm-tab-nav-item__close')).not.toBeNull();
  });

  // a11y(A106):closeLabel prop(caller 注入本地化)→ 关闭按钮 aria-label;未提供回退英文默认。
  it('a11y · closeLabel prop 注入 → 关闭按钮用之;未提供回退 Close {title}', () => {
    const injected = render(
      <TabNav>
        <TabNavItem
          title="/x.md"
          closeLabel="关闭 x.md"
          onSelect={() => {}}
          onClose={() => {}}
        >
          x.md
        </TabNavItem>
      </TabNav>,
    );
    expect(
      injected.container.querySelector('button[aria-label="关闭 x.md"]'),
    ).not.toBeNull();
    cleanup();
    // 未提供 closeLabel → design 层英文回退(无 i18n 依赖)
    const fallback = render(
      <TabNav>
        <TabNavItem title="y.md" onSelect={() => {}} onClose={() => {}}>
          y.md
        </TabNavItem>
      </TabNav>,
    );
    expect(
      fallback.container.querySelector('button[aria-label="Close y.md"]'),
    ).not.toBeNull();
  });

  // a11y(A107):tablist 须有可访问名(ariaLabel prop,caller 注入);未提供则无 aria-label。
  it('a11y · TabNav ariaLabel prop → role=tablist 有可访问名', () => {
    const withLabel = render(
      <TabNav ariaLabel="编辑器标签">
        <TabNavItem active onSelect={() => {}}>
          a
        </TabNavItem>
      </TabNav>,
    );
    const tablist = withLabel.container.querySelector('[role=tablist]');
    expect(tablist!.getAttribute('aria-label')).toBe('编辑器标签');
  });

  // a11y(A23):role=tablist 须配 WAI-ARIA 键盘模型 —— roving tabindex(仅 active tab 在 Tab
  // 顺序)+ 方向键在 tab 间移焦(Home/End 跳首尾,左右循环)。
  it('a11y · roving tabindex + 方向键导航', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem active onSelect={() => {}}>
          a
        </TabNavItem>
        <TabNavItem onSelect={() => {}}>b</TabNavItem>
        <TabNavItem onSelect={() => {}}>c</TabNavItem>
      </TabNav>,
    );
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role=tab]'),
    );
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]); // 仅 active 可 Tab
    const tablist = container.querySelector('[role=tablist]')!;
    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tablist, { key: 'ArrowRight' }); // 末→首循环
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' }); // 首→末循环
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
  });

  // a11y(A35):dirty tab 须把「未保存」状态经 aria-describedby 暴露给 AT(视觉圆点 aria-hidden);
  // clean tab 不暴露。dirtyLabel 由调用方(EditorHeader)传本地化文本(design 层无 i18n)。
  it('a11y · dirty tab 经 aria-describedby 暴露未保存状态', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem active dirty dirtyLabel="未保存的更改" onSelect={() => {}}>
          a.ts
        </TabNavItem>
      </TabNav>,
    );
    const tab = container.querySelector<HTMLButtonElement>('[role=tab]')!;
    const descId = tab.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    const desc = container.querySelector(`[id="${descId}"]`)!;
    expect(desc.getAttribute('aria-label')).toBe('未保存的更改');
  });

  it('a11y · clean tab 不暴露 aria-describedby;无 dirtyLabel 的 dirty tab 圆点仍 aria-hidden', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem active onSelect={() => {}}>
          clean
        </TabNavItem>
        <TabNavItem dirty onSelect={() => {}}>
          nolabel
        </TabNavItem>
      </TabNav>,
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]');
    expect(tabs[0]!.hasAttribute('aria-describedby')).toBe(false); // clean
    expect(tabs[1]!.hasAttribute('aria-describedby')).toBe(false); // dirty 但无 dirtyLabel
    const dot = container.querySelector('.wm-tab-nav-item__dirty-dot')!;
    expect(dot.getAttribute('aria-hidden')).toBe('true'); // 回退:仍装饰性隐藏
  });

  // a11y(A29,A23 后续):tablist 内只有 active tab 在 Tab 顺序;close 按钮须移出 Tab 顺序
  // (tabIndex=-1),改由聚焦 tab 后 Delete/Backspace 触发关闭。
  it('a11y · close 按钮不在 Tab 顺序 + tab 聚焦 Delete/Backspace 关闭', () => {
    const onClose = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem active onSelect={() => {}} onClose={onClose}>
          a
        </TabNavItem>
      </TabNav>,
    );
    const closeBtn = container.querySelector<HTMLButtonElement>(
      '.wm-tab-nav-item__close',
    )!;
    expect(closeBtn.tabIndex).toBe(-1); // 移出 Tab 顺序
    const tab = container.querySelector<HTMLButtonElement>('[role=tab]')!;
    fireEvent.keyDown(tab, { key: 'Delete' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tab, { key: 'Backspace' });
    expect(onClose).toHaveBeenCalledTimes(2);
    // 普通键不触发关闭
    fireEvent.keyDown(tab, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('无 onClose 时不渲染 close 按钮', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={() => {}}>file.md</TabNavItem>
      </TabNav>,
    );
    expect(container.querySelector('.wm-tab-nav-item__close')).toBeNull();
  });

  it('close 按钮点击 stopPropagation,onSelect 不被触发', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={onSelect} onClose={onClose}>
          file.md
        </TabNavItem>
      </TabNav>,
    );
    fireEvent.click(container.querySelector('.wm-tab-nav-item__close')!);
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // 回归 issue #19:opt-in rename。双击 select 区触发 onRename,onSelect
  // 仍触发(double-click = 两次 click,React 也会先发 click 再发 dblclick)。
  it('双击 tab body 触发 onRename(opt-in)', () => {
    const onRename = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={() => {}} onRename={onRename}>
          term-1
        </TabNavItem>
      </TabNav>,
    );
    fireEvent.doubleClick(container.querySelector('.wm-tab-nav-item__select')!);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('未传 onRename → 双击不抛、不影响 select 行为', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={onSelect}>file.md</TabNavItem>
      </TabNav>,
    );
    expect(() =>
      fireEvent.doubleClick(
        container.querySelector('.wm-tab-nav-item__select')!,
      ),
    ).not.toThrow();
  });
});
