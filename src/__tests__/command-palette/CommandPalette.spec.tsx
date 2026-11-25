// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../../plugins/picker/picker-row';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 30, size: 30, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));
import { fireEvent, render, cleanup, act } from '@testing-library/react';

const notifyError = vi.fn();
vi.mock('../../notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

import {
  CommandPalette,
} from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

beforeEach(() => {
  useCommandPaletteStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
  });
});
afterEach(() => cleanup());

function makeReg(): CommandRegistry {
  const r = new CommandRegistry();
  r.register({ id: 'save.file', title: '保存文件', hotkey: 'mod+s', fn: vi.fn() });
  r.register({ id: 'open.folder', title: '打开文件夹', fn: vi.fn() });
  r.register({ id: 'quit.app', title: '退出应用', fn: vi.fn() });
  return r;
}

describe('CommandPalette UI', () => {
  it('搜索框 placeholder label 复用,aria-label 与 placeholder 不重复查 catalog', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/command-palette/CommandPalette.tsx'),
      'utf8',
    );

    expect(src).toContain('const placeholderLabel = t(');
    expect(src).toContain('aria-label={placeholderLabel}');
    expect(src).toContain('placeholder={placeholderLabel}');
    expect(
      src.match(/aria-label=\{t\('command_palette\.placeholder'\)\}/g)
        ?.length ?? 0,
    ).toBe(1);
    expect(src).not.toContain("placeholder={t('command_palette.placeholder')}");
  });

  it('行 className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(pickerRowClassName(true)).toContain('border-accent bg-accent/15 text-fg');
      expect(pickerRowClassName(false)).toContain(
        'border-transparent text-fg-muted hover:bg-accent/10',
      );
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });

  it('isOpen=false → 不渲染 Modal 内容', () => {
    const { container } = render(<CommandPalette commands={makeReg()} />);
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  it('open 后渲染 Input + 全部命令', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const items = document.querySelectorAll('.wm-modal-content li');
    expect(items.length).toBe(3);
    expect(items[0]!.textContent).toContain('保存文件');
  });

  // a11y(A1):搜索框须有稳定可访问名(aria-label),否则屏幕阅读器聚焦时只读「编辑框」无名。
  // placeholder 不算可靠可访问名。locale-无关:断言 aria-label 非空且与 placeholder 一致。
  it('a11y · 搜索 Input 有 aria-label 可访问名(非仅 placeholder)', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const ariaLabel = input!.getAttribute('aria-label') ?? '';
    expect(ariaLabel.length).toBeGreaterThan(0);
    expect(ariaLabel).toBe(input!.getAttribute('placeholder'));
  });

  // a11y(A15):combobox 模式 —— input 经 aria-activedescendant 指向当前高亮 option(焦点
  // 留 input),否则屏幕阅读器按上下键不知高亮哪条。断言 role=combobox + activedescendant
  // 指向存在的 option,且随 selectedIndex 移动。
  it('a11y · input 是 combobox,aria-activedescendant 跟随 selectedIndex', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('command-palette-listbox');
    const ad0 = input.getAttribute('aria-activedescendant');
    expect(ad0).toBe('command-palette-option-0');
    expect(document.getElementById(ad0!)).not.toBeNull(); // 指向真实存在的 option
    act(() => useCommandPaletteStore.setState({ selectedIndex: 1 }));
    expect(input.getAttribute('aria-activedescendant')).toBe(
      'command-palette-option-1',
    );
    // a11y(A111):selectedIndex 越界(结果变短遗留旧下标)→ aria-activedescendant 须移除,
    // 不能指向不存在的 option id。
    act(() => useCommandPaletteStore.setState({ selectedIndex: 999 }));
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('输入 query → fuzzy 过滤', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    act(() => useCommandPaletteStore.getState().setQuery('退出'));
    const items = document.querySelectorAll('.wm-modal-content li');
    expect(items.length).toBe(1);
    expect(items[0]!.textContent).toContain('退出应用');
  });

  it('全空白 query 按空 query 渲染全部命令', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const initial = document.querySelectorAll('.wm-modal-content li').length;

    act(() => useCommandPaletteStore.getState().setQuery('   '));

    expect(
      (document.querySelector('.wm-modal-content input') as HTMLInputElement)
        .value,
    ).toBe('   ');
    expect(document.querySelectorAll('.wm-modal-content li').length).toBe(
      initial,
    );
  });

  it('无匹配 → 显空态文案', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    act(() => useCommandPaletteStore.getState().setQuery('xyzabc'));
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('无匹配');
    // a11y(A56):空态须在 live region(role=status)播报「无匹配」,焦点在搜索框时也能听到。
    const status = document.querySelector('.wm-modal-content [role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('无匹配');
    // a11y(A100):无结果时 combobox 仍是展开态(弹层可见显示空态),aria-expanded 须保持 true,
    // 不能随结果数变 false(否则与可见状态矛盾);aria-activedescendant 此时移除。
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    // a11y(A101):listbox 不存在(无结果)→ aria-controls 移除,避免引用悬空。
    expect(input.getAttribute('aria-controls')).toBeNull();
  });

  it('点击命令行 → 执行 fn 并关闭', async () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'do.it', title: 'Do It', fn });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const li = document.querySelector('.wm-modal-content li')!;
    fireEvent.click(li);
    // close synchronously, fn runs after
    await Promise.resolve();
    expect(fn).toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('显示 hotkey 后缀(KeyCap 渲染:jsdom → other → 多个 kbd 拼成 "CtrlS")', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const firstLi = document.querySelector('.wm-modal-content li')!;
    // jsdom navigator.platform 默认空,detectPlatform 返 'other';
    // KeyCap 拆开 ['Ctrl', 'S'] 各自一个 kbd,textContent 串起来 = "CtrlS"
    const kbds = firstLi.querySelectorAll('kbd.wm-keycap');
    expect(kbds.length).toBe(2);
    expect(kbds[0]?.textContent).toBe('Ctrl');
    expect(kbds[1]?.textContent).toBe('S');
  });
});

describe('CommandPalette · 键盘 + 空 query 排序', () => {
  it('ArrowDown / ArrowUp → 移动 selectedIndex', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(1);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
  });

  it('Enter → 执行选中命令 + 关闭', async () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'do', title: 'Do', fn });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    await Promise.resolve();
    expect(fn).toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('完全没注册任何命令 → 「暂无可用命令」', () => {
    const reg = new CommandRegistry();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('暂无可用命令');
  });

  it('category 显示 "Category:" 前缀 + 同时被 fuzzy 匹配', () => {
    const reg = new CommandRegistry();
    reg.register({
      id: 's.open',
      title: 'Open',
      category: 'Settings',
      fn: vi.fn(),
    });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const li = document.querySelector('.wm-modal-content li')!;
    expect(li.textContent).toContain('Settings');

    // fuzzy 用 "settings" 也能命中
    act(() =>
      useCommandPaletteStore.getState().setQuery('settings'),
    );
    expect(document.querySelectorAll('.wm-modal-content li').length).toBe(1);
  });

  it('subscribe registry → 后注册的命令立即出现在列表', () => {
    const reg = new CommandRegistry();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('暂无可用命令');

    act(() => {
      reg.register({ id: 'late', title: 'Late', fn: vi.fn() });
    });
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('Late');
  });

  // 第二十一轮 P1-AX:命令抛错不再静默 console.warn,而是经 notify.error 弹给用户
  // (面板已关,旧实现下用户看不到任何失败反馈)。
  it('execute 命令抛错 → notify.error(含 title),UI 不抛', async () => {
    notifyError.mockReset();
    const reg = new CommandRegistry();
    reg.register({
      id: 'bad',
      title: 'Bad',
      fn: () => {
        throw new Error('boom');
      },
    });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const li = document.querySelector('.wm-modal-content li')!;
    fireEvent.click(li);
    // 等 microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyError).toHaveBeenCalled();
    expect(String(notifyError.mock.calls[0]?.[0])).toContain('Bad');
    expect(String(notifyError.mock.calls[0]?.[0])).toContain('boom');
  });
});

// VSCode:本地化界面下命令面板同时匹配英文原名(commandAlias);命中的是英文而非本地化文本时,行尾用次要色显示英文名。
// 英文原文 = en catalog 里 titleKey / categoryKey 的值(无 key 或 en 无此 key 时用 CommandSpec 的 title / category ——
// 约定它们是英文 fallback)。
describe('CommandPalette · 本地化界面可搜英文命令名', () => {
  function makeLocalizedReg(): CommandRegistry {
    const r = new CommandRegistry();
    r.register({
      id: 'workbench.action.files.openFolder',
      title: 'Open Folder…',
      titleKey: 'commands.file.open_folder.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: vi.fn(),
    });
    r.register({ id: 'quit.app', title: '退出应用', fn: vi.fn() });
    return r;
  }
  function search(q: string): HTMLLIElement[] {
    render(<CommandPalette commands={makeLocalizedReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector('.wm-modal-content input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: q } });
    return Array.from(document.querySelectorAll<HTMLLIElement>('.wm-modal-content li'));
  }
  afterEach(async () => {
    const { setLocale } = await import('../../i18n/translate');
    setLocale('zh');
  });

  it('zh:输入英文「open folder」命中「文件: 打开文件夹…」,行尾以 picker 次要色显示英文名 File: Open Folder…', () => {
    const rows = search('open folder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('打开文件夹…');
    const alias = rows[0]!.querySelector('[data-command-alias]');
    expect(alias?.textContent).toBe('File: Open Folder…');
    // 次要色走 picker-row 的对比度契约:常态 text-fg-dim,选中 / 悬停换 text-fg-muted(accent 底上保持 ≥ 4.5)。
    expect(alias?.className).toContain(pickerRowSecondaryClassName(true));
    expect(pickerRowSecondaryClassName(false)).toContain('text-fg-dim');
  });

  it('zh:英文分类前缀也可搜(「file open」)', () => {
    expect(search('file open')).toHaveLength(1);
  });

  it('zh:命中本地化文本时不显示英文名', () => {
    const rows = search('打开文件');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('[data-command-alias]')).toBeNull();
  });

  it('en:不重复显示英文名(本地化即英文)', async () => {
    const { setLocale } = await import('../../i18n/translate');
    setLocale('en');
    const rows = search('open folder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('[data-command-alias]')).toBeNull();
  });

  it('英文原名与本地化相同(无 titleKey、title 非英文)→ 不另拼别名,搜英文无结果', () => {
    expect(search('quit')).toHaveLength(0);
  });
});
