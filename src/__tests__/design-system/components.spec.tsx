import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRef } from 'react';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  KeyCap,
  MenuItem,
  NavRailButton,
  SegmentedControl,
  TabNav,
  TabNavItem,
  TruncateStart,
} from '../../design';

afterEach(() => cleanup());

describe('Card', () => {
  it('tone 直接写入 data-tone,未传时不输出且不通过条件对象 spread 分配', () => {
    const neutral = render(<Card>Neutral</Card>);
    const neutralCard = neutral.container.querySelector('.wm-card')!;
    expect(neutralCard.hasAttribute('data-tone')).toBe(false);
    cleanup();

    const toned = render(<Card tone="assistant">Assistant</Card>);
    expect(toned.container.querySelector<HTMLElement>('.wm-card')!.dataset.tone).toBe(
      'assistant',
    );

    const src = readFileSync(join(process.cwd(), 'src/design/Card.tsx'), 'utf8');
    expect(src).toContain('data-tone={tone ?? undefined}');
    expect(src).not.toContain("...(tone != null ? { 'data-tone': tone } : {})");
  });
});

describe('Badge', () => {
  it('默认 variant=neutral size=sm(胶囊);size=xs 写入 data-size', () => {
    const { container, rerender } = render(<Badge>x</Badge>);
    const el = container.querySelector('.wm-badge')!;
    expect(el.getAttribute('data-variant')).toBe('neutral');
    expect(el.getAttribute('data-size')).toBe('sm');
    rerender(<Badge size="xs" variant="accent-soft">x</Badge>);
    expect(el.getAttribute('data-size')).toBe('xs');
    expect(el.getAttribute('data-variant')).toBe('accent-soft');
  });

  it('className 合并而非覆盖 wm-badge', () => {
    const { container } = render(<Badge className="uppercase">x</Badge>);
    expect(container.querySelector('span')!.className).toBe('wm-badge uppercase');
  });
});

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

describe('KeyCap', () => {
  it('className 合并而非覆盖 wm-keycap', () => {
    const { container } = render(<KeyCap className="extra">K</KeyCap>);
    const cls = container.querySelector('kbd')!.className;
    expect(cls).toContain('wm-keycap');
    expect(cls).toContain('extra');
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

  // 可作 Radix 菜单原语(ContextMenu.Item asChild)的子元素:Radix 经 Slot 注入 ref / data-highlighted /
  // onKeyDown / onPointerMove 等,MenuItem 须透传到 button,否则方向键漫游与高亮失效。
  it('透传 ref 与其余 button 属性(data-* / 事件),onClick 可省略', () => {
    const ref = createRef<HTMLButtonElement>();
    const onKeyDown = vi.fn();
    const { container } = render(
      <MenuItem ref={ref} data-highlighted="" onKeyDown={onKeyDown}>
        X
      </MenuItem>,
    );
    const btn = container.querySelector('button')!;
    expect(ref.current).toBe(btn);
    expect(btn.hasAttribute('data-highlighted')).toBe(true);
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(btn.className).toBe('wm-menu-item');
    expect(btn.getAttribute('role')).toBe('menuitem');
  });

  it('trailing(快捷键 / 计数)渲染在截断内容之外、靠右', () => {
    const { container } = render(
      <MenuItem onClick={() => {}} trailing="F2">
        Rename
      </MenuItem>,
    );
    const trailing = container.querySelector('.wm-menu-item__trailing')!;
    expect(trailing.textContent).toBe('F2');
    expect(trailing.closest('.wm-menu-item__content')).toBeNull();
    expect(container.querySelector('.wm-menu-item__content')!.textContent).toBe('Rename');
  });

  it('未传 trailing → 不渲染 trailing 节点', () => {
    const { container } = render(<MenuItem onClick={() => {}}>X</MenuItem>);
    expect(container.querySelector('.wm-menu-item__trailing')).toBeNull();
    expect(container.querySelector('.wm-menu-item__shortcut')).toBeNull();
  });

  it('shortcut 键位在 trailing 之后显示,不计入可访问名称', () => {
    render(
      <MenuItem onClick={() => {}} trailing="2 items" shortcut="⌘⌫">
        Move to Trash
      </MenuItem>,
    );
    const item = screen.getByRole('menuitem', { name: /^Move to Trash ?2 items$/ });
    const shortcut = item.querySelector('.wm-menu-item__shortcut')!;
    expect(shortcut.textContent).toBe('⌘⌫');
    expect(shortcut.getAttribute('aria-hidden')).toBe('true');
    expect(shortcut.previousElementSibling?.className).toBe('wm-menu-item__trailing');
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

  it('tooltip 只改悬停提示,可访问名称仍是 title', () => {
    render(
      <NavRailButton title="Explorer" tooltip="Explorer (⌘B)" onClick={() => {}}>
        E
      </NavRailButton>,
    );
    const btn = screen.getByRole('button', { name: 'Explorer' });
    expect(btn.getAttribute('title')).toBe('Explorer (⌘B)');
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

  // 窄容器省略号截断由文字外层 .wm-segmented-label 承载(选项本身是 inline-flex,text-overflow 不生效);
  // 可访问名仍是完整文案。
  it('选项文字包在 .wm-segmented-label 内,可访问名不变', () => {
    const { container, getByRole } = render(
      <SegmentedControl options={[{ id: 'system', label: '跟随系统' }]} value="system" onChange={vi.fn()} />,
    );
    const label = container.querySelector('[role=radio] > .wm-segmented-label');
    expect(label?.textContent).toBe('跟随系统');
    expect(getByRole('radio', { name: '跟随系统' })).toBeTruthy();
  });

  it('方向键定位当前 segment 时不调用 options.findIndex', () => {
    const options = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ];
    const findIndexSpy = vi.spyOn(options, 'findIndex');
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl options={options} value="a" onChange={onChange} />,
    );
    const group = container.querySelector('[role=radiogroup]')!;

    try {
      fireEvent.keyDown(group, { key: 'ArrowRight' });

      expect(onChange).toHaveBeenLastCalledWith('b');
      expect(findIndexSpy).not.toHaveBeenCalled();
    } finally {
      findIndexSpy.mockRestore();
    }
  });
});

describe('TabNav + TabNavItem', () => {
  // VSCode tab.unfocusedActiveForeground / unfocusedActiveBorder:tab 栏所在组不是活动组时,活动 tab 文字变暗(fg-muted)、
  // 不显示强调下划线,但保留选中底色(仍与非活动 tab 有区分)。走语义 token,亮 / 暗同一规则。
  it('unfocused:tab 栏标 data-unfocused;样式只改活动 tab 的文字色与下划线,保留底色', () => {
    const { container, rerender } = render(
      <TabNav unfocused>
        <TabNavItem active onSelect={() => {}}>a.ts</TabNavItem>
      </TabNav>,
    );
    expect(container.querySelector('[role=tablist]')!.getAttribute('data-unfocused')).toBe('true');
    rerender(
      <TabNav>
        <TabNavItem active onSelect={() => {}}>a.ts</TabNavItem>
      </TabNav>,
    );
    expect(container.querySelector('[role=tablist]')!.hasAttribute('data-unfocused')).toBe(false);

    const css = readFileSync(join(process.cwd(), 'src/design/TabNav.css'), 'utf8');
    const rule = /\.wm-tab-nav\[data-unfocused="true"\] \.wm-tab-nav-item\[data-active="true"\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule![1]!;
    expect(body).toMatch(/border-bottom-color:\s*transparent/);
    expect(body).toMatch(/color:\s*var\(--md-on-surface-variant\)/);
    expect(body).not.toMatch(/background/);
  });

  // 中键单击 tab 关闭(VSCode / 浏览器惯例,与 dock tab SharedTab 一致);走同一个 onClose(未保存确认由调用方负责)。
  it('中键单击 tab → onClose;按下时阻止中键自动滚动;不触发选中', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={onSelect} onClose={onClose}>
          a.ts
        </TabNavItem>
      </TabNav>,
    );
    const label = container.querySelector('.wm-tab-nav-item__label')!;
    const notPrevented = fireEvent.mouseDown(label, { button: 1 });
    expect(notPrevented).toBe(false); // preventDefault → 不进入 auto-scroll
    fireEvent(label, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('右键 auxclick / 左键按下不关闭;无 onClose 或 disabled 时中键不关闭也不拦默认行为', () => {
    const onClose = vi.fn();
    const first = render(
      <TabNav>
        <TabNavItem onSelect={() => {}} onClose={onClose}>
          a.ts
        </TabNavItem>
      </TabNav>,
    );
    const item = first.container.querySelector('.wm-tab-nav-item')!;
    fireEvent(item, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(fireEvent.mouseDown(item, { button: 0 })).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    cleanup();

    const disabledClose = vi.fn();
    const second = render(
      <TabNav>
        <TabNavItem onSelect={() => {}}>b.ts</TabNavItem>
        <TabNavItem disabled onSelect={() => {}} onClose={disabledClose}>
          c.ts
        </TabNavItem>
      </TabNav>,
    );
    for (const el of Array.from(second.container.querySelectorAll('.wm-tab-nav-item'))) {
      expect(fireEvent.mouseDown(el, { button: 1 })).toBe(true);
      fireEvent(el, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    }
    expect(disabledClose).not.toHaveBeenCalled();
  });

  it('双击 tab → onDoubleClick(onRename 优先;disabled 时不触发)', () => {
    const onDoubleClick = vi.fn();
    const onRename = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={() => {}} onDoubleClick={onDoubleClick}>
          a.ts
        </TabNavItem>
        <TabNavItem onSelect={() => {}} onDoubleClick={onDoubleClick} onRename={onRename}>
          b.ts
        </TabNavItem>
        <TabNavItem disabled onSelect={() => {}} onDoubleClick={onDoubleClick}>
          c.ts
        </TabNavItem>
      </TabNav>,
    );
    const items = container.querySelectorAll('.wm-tab-nav-item');
    fireEvent.doubleClick(items[0]!);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(items[1]!);
    expect(onRename).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(items[2]!);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

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
      injected.container.querySelector('[role=button][aria-label="关闭 x.md"]'),
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
      fallback.container.querySelector('[role=button][aria-label="Close y.md"]'),
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

  it('a11y · tablist 方向键导航不通过 Array.from 物化 tab NodeList', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem active onSelect={() => {}}>
          a
        </TabNavItem>
        <TabNavItem onSelect={() => {}}>b</TabNavItem>
      </TabNav>,
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]');
    const tablist = container.querySelector('[role=tablist]')!;
    tabs[0]!.focus();
    const fromSpy = vi.spyOn(Array, 'from');

    try {
      fireEvent.keyDown(tablist, { key: 'ArrowRight' });
      expect(document.activeElement).toBe(tabs[1]);
      const nodeListCalls = fromSpy.mock.calls.filter(
        ([arg]) => arg instanceof NodeList,
      );
      expect(nodeListCalls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
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

    const src = readFileSync(join(process.cwd(), 'src/design/TabNav.tsx'), 'utf8');
    expect(src).toContain('{...dataAttrs}');
    expect(src).not.toContain('{...(dataAttrs ?? {})}');
    expect(src).toContain('aria-hidden={showDirtyDesc ? undefined : true}');
    expect(src).not.toContain('...(showDirtyDesc');
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

  // a11y(axe aria-required-children / nested-interactive):tablist 的子元素只能是 tab;关闭按钮在 tab 元素内部
  // (VSCode multiEditorTabsControl:div[role=tab] 内含关闭动作),且不可聚焦(tab 的子元素是 presentational,
  // 可聚焦子控件 = nested-interactive)—— 鼠标点 ×,键盘 / 读屏用 Delete 或 ⌘W 关闭(同 VSCode)。
  it('a11y · tablist 子元素全为 role=tab;关闭按钮在 tab 内且不可聚焦;tab 名称只取标题', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem active dirty dirtyLabel="未保存" onSelect={() => {}} onClose={() => {}} closeLabel="关闭 a.ts">
          a.ts
        </TabNavItem>
        <TabNavItem onSelect={() => {}} onClose={() => {}} closeLabel="关闭 b.ts">
          b.ts
        </TabNavItem>
      </TabNav>,
    );
    const tablist = container.querySelector('[role=tablist]')!;
    expect(Array.from(tablist.children).map((c) => c.getAttribute('role'))).toEqual(['tab', 'tab']);
    for (const tab of Array.from(tablist.children)) {
      const close = tab.querySelector('.wm-tab-nav-item__close')!;
      expect(close).not.toBeNull();
      expect(close.tagName).not.toBe('BUTTON');
      expect(close.hasAttribute('tabindex')).toBe(false);
      // tab 内除自身外没有任何可聚焦元素
      expect(tab.querySelectorAll('button, input, a[href], [tabindex]')).toHaveLength(0);
    }
    expect(screen.getByRole('tab', { name: 'a.ts' })).toBe(tablist.children[0]);
    expect(screen.getByRole('button', { name: '关闭 b.ts' })).toBe(tablist.children[1]!.querySelector('.wm-tab-nav-item__close'));
  });

  it('a11y · tab 自身承担按钮语义:Enter / Space 选中(不回调 onMouseSelect);内部子元素(如重命名输入框)的按键不被截走', () => {
    const onSelect = vi.fn();
    const onMouseSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={onSelect} onMouseSelect={onMouseSelect} onClose={onClose}>
          <input aria-label="rename" />
        </TabNavItem>
      </TabNav>,
    );
    const tab = container.querySelector<HTMLElement>('[role=tab]')!;
    expect(fireEvent.keyDown(tab, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(tab, { key: ' ' })).toBe(false); // 阻止空格滚动
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onMouseSelect).not.toHaveBeenCalled();
    const input = container.querySelector('input')!;
    expect(fireEvent.keyDown(input, { key: ' ' })).toBe(true);
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a11y · disabled tab:aria-disabled,点击 / Enter / × / Delete 都不生效,方向键跳过', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem active onSelect={() => {}}>a</TabNavItem>
        <TabNavItem disabled onSelect={onSelect} onClose={onClose}>b</TabNavItem>
        <TabNavItem onSelect={() => {}}>c</TabNavItem>
      </TabNav>,
    );
    const tabs = container.querySelectorAll<HTMLElement>('[role=tab]');
    expect(tabs[1]!.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(tabs[1]!, { detail: 1 });
    fireEvent.keyDown(tabs[1]!, { key: 'Enter' });
    fireEvent.keyDown(tabs[1]!, { key: 'Delete' });
    fireEvent.click(tabs[1]!.querySelector('.wm-tab-nav-item__close')!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    tabs[0]!.focus();
    fireEvent.keyDown(container.querySelector('[role=tablist]')!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[2]);
  });

  // a11y(A29,A23 后续):tablist 内只有 active tab 在 Tab 顺序;close 按钮不在 Tab 顺序,
  // 改由聚焦 tab 后 Delete 触发关闭。不认 Backspace:鼠标点 tab 后焦点可能停在 tab 上,
  // 用户以为还在编辑器里打字,退格即误关 tab(与 dock tab SharedTab ca68571d 同规则;VSCode tab 上也无退格关闭)。
  it('a11y · close 按钮不在 Tab 顺序 + tab 聚焦 Delete 关闭,Backspace 不关闭', () => {
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
    expect(onClose).toHaveBeenCalledTimes(1);
    // 普通键不触发关闭
    fireEvent.keyDown(tab, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 鼠标点 tab(含已激活 tab)后调用方需把焦点交回内容(VSCode:点编辑器 tab 即聚焦编辑器)。设计层不夹带业务:
  // 只在「鼠标点击选中」时额外回调 onMouseSelect,键盘(Enter / Space 合成的 click,detail=0)不回调,
  // 保持 tablist 键盘模型(焦点留在 tab)。
  it('鼠标点击 tab → onSelect + onMouseSelect;键盘合成 click(detail=0)只 onSelect', () => {
    const onSelect = vi.fn();
    const onMouseSelect = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem active onSelect={onSelect} onMouseSelect={onMouseSelect}>
          a
        </TabNavItem>
      </TabNav>,
    );
    const tab = container.querySelector<HTMLButtonElement>('[role=tab]')!;
    fireEvent.click(tab, { detail: 1, button: 0 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onMouseSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(tab, { detail: 0, button: 0 });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onMouseSelect).toHaveBeenCalledTimes(1);
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

// 路径等「尾部更重要」的文本:从前截断(省略号在左),完整文本进 title。CSS 侧(direction:rtl + 内层 ltr 隔离)
// 见 style-contracts.spec.ts。
describe('TruncateStart', () => {
  it('外层 wm-truncate-start + title=完整文本;文本放在 dir=ltr 的内层(标点 / 双向文本不被 rtl 重排)', () => {
    const { container } = render(<TruncateStart text="/Users/me/projects" className="text-fg-dim" />);
    const outer = container.querySelector<HTMLElement>('.wm-truncate-start')!;
    expect(outer.className).toBe('wm-truncate-start text-fg-dim');
    expect(outer.title).toBe('/Users/me/projects');
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.getAttribute('dir')).toBe('ltr');
    expect(inner.textContent).toBe('/Users/me/projects');
  });

  it('title 可覆盖(如传更完整的路径)', () => {
    const { container } = render(<TruncateStart text="/a/b" title="/a/b/c" />);
    expect(container.querySelector<HTMLElement>('.wm-truncate-start')!.title).toBe('/a/b/c');
  });

  it('children 可替换内层的富文本渲染(如命中字符 <mark>),title 仍取 text', () => {
    const { container } = render(
      <TruncateStart text="src/lib">
        <mark>src</mark>/lib
      </TruncateStart>,
    );
    const outer = container.querySelector<HTMLElement>('.wm-truncate-start')!;
    expect(outer.title).toBe('src/lib');
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.getAttribute('dir')).toBe('ltr');
    expect(inner.textContent).toBe('src/lib');
    expect(inner.querySelector('mark')?.textContent).toBe('src');
  });
});

// 面板内容为空时的统一占位(Debug / Output 等共用):居中、弱化正文色,无边框卡片。
describe('EmptyState', () => {
  it('渲染 wm-empty-state,内容为 children,透传其余属性与 className', () => {
    const { container } = render(
      <EmptyState className="p-3" data-testid="x">
        Nothing here
      </EmptyState>,
    );
    const el = container.querySelector<HTMLElement>('.wm-empty-state')!;
    expect(el.textContent).toBe('Nothing here');
    expect(el.className).toBe('wm-empty-state p-3');
    expect(el.dataset.testid).toBe('x');
  });
});
