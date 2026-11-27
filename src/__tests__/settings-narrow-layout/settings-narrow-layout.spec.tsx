// @vitest-environment jsdom
// 设置页窄宽布局:按容器宽度(@container)切换的 class 契约。jsdom 不计算容器查询,故断言 class 存在;
// 实际效果见截图核对(README)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SettingItemRow } from '../../plugins/settings/SettingItemRow';
import { SettingsPanel } from '../../plugins/settings/SettingsPanel';
import { KeybindingsTabContent } from '../../plugins/settings/KeybindingsTabContent';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import type { SettingItemSpec } from '../../plugins/registries/SettingItemRegistry';
import { useSettingsStore } from '../../plugins/settings/store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

function classesOf(el: Element | null | undefined): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

afterEach(() => cleanup());

describe('SettingItemRow — 窄宽上下排列', () => {
  beforeEach(() => useSettingsValuesStore.setState({ values: {} }));

  const spec: SettingItemSpec = {
    id: 'general.language',
    category: 'general',
    title: 'Language',
    description: "Choose Continuo's UI language. Changes take effect immediately.",
    type: 'select',
    default: 'en',
    enum: [
      { value: 'en', label: 'English' },
      { value: 'zh', label: '中文' },
    ],
  };

  it('行根节点是尺寸容器;主体默认纵向,≥ 32rem 才横向并排', () => {
    const { container } = render(<SettingItemRow spec={spec} />);
    const root = container.firstElementChild!;
    expect(classesOf(root)).toContain('@container');
    const body = root.firstElementChild!;
    const cls = classesOf(body);
    expect(cls).toContain('flex-col');
    expect(cls).toContain('@lg:flex-row');
    expect(cls).not.toContain('justify-between'); // 窄宽时不能左右撑开
  });

  it('标题行可换行;id 徽标可收缩且 code 省略号截断', () => {
    const { container } = render(<SettingItemRow spec={spec} />);
    const title = container.querySelector('#setting-title-general\\.language')!;
    expect(classesOf(title.parentElement)).toContain('flex-wrap');
    const code = container.querySelector('code')!;
    expect(code.textContent).toBe('general.language');
    // code 是 inline-flex 徽标的 flex 子项:须 min-w-0 才能收缩到徽标宽度内截断(否则按全文宽度撑出行外)
    expect(classesOf(code)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    const badge = code.closest('.wm-badge')!;
    expect(classesOf(badge)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    // 上下排列(items-start)时标题列按内容取宽:须以行宽为上限,徽标的 max-w-full 才有参照、才会截断
    expect(classesOf(title.parentElement!.parentElement)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
  });

  it('控件区可换行', () => {
    const { container } = render(<SettingItemRow spec={spec} />);
    const group = container.querySelector('[role=radiogroup]')!;
    expect(classesOf(group.parentElement)).toContain('flex-wrap');
  });

  // 上下排列时控件区宽度以行宽为上限(否则按内容宽度撑出行外),分段控件才会在其内整项换行 / 截断,
  // 而不是被挤成每字一行或溢出被裁。
  it('数值 / 文本输入框宽度不超过控件区(max-w-full,数值框可收缩)', () => {
    const numberSpec: SettingItemSpec = {
      id: 'editor.fontSize', category: 'editor', title: 'Font size', type: 'number', default: 13, unit: 'px',
    };
    const textSpec: SettingItemSpec = { id: 'x.text', category: 'x', title: 'Text', type: 'text', default: '' };
    const { container } = render(
      <>
        <SettingItemRow spec={numberSpec} />
        <SettingItemRow spec={textSpec} />
      </>,
    );
    const [num, text] = Array.from(container.querySelectorAll('input'));
    expect(classesOf(num)).toEqual(expect.arrayContaining(['w-24', 'min-w-0', 'max-w-full']));
    expect(classesOf(num!.parentElement)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    expect(classesOf(text)).toEqual(expect.arrayContaining(['w-48', 'max-w-full']));
  });

  it('控件区宽度不超过行宽(min-w-0 max-w-full)', () => {
    const { container } = render(<SettingItemRow spec={spec} />);
    const group = container.querySelector('[role=radiogroup]')!;
    expect(classesOf(group.parentElement)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
  });
});

describe('SettingsPanel — 窄面板收起导航文字', () => {
  beforeEach(() => useSettingsStore.setState({ activeTabId: null }));

  function makeReg(): SettingTabRegistry {
    const r = new SettingTabRegistry();
    r.register({ id: 'general', title: '通用', icon: <svg />, render: () => '通用内容', priority: 10 });
    r.register({ id: 'ext', title: 'Ext Tab', render: () => 'ext', priority: 20 });
    return r;
  }

  it('根节点是名为 settings 的尺寸容器', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    expect(classesOf(container.firstElementChild)).toContain('@container/settings');
  });

  it('导航窄面板时宽度自适应;文字 sr-only 但仍是可访问名;title 提示', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const nav = container.querySelector('nav')!;
    expect(classesOf(nav)).toContain('@max-2xl/settings:w-auto');
    const btns = Array.from(nav.querySelectorAll('button'));
    expect(btns.map((b) => b.textContent)).toEqual(['通用', 'Ext Tab']);
    for (const b of btns) {
      expect(b.title).toBe(b.textContent);
      const label = Array.from(b.querySelectorAll('span')).find((s) => s.textContent === b.textContent)!;
      expect(classesOf(label)).toContain('@max-2xl/settings:sr-only');
    }
  });

  it('无图标的分类以首字伪元素占位(不进 textContent)', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const ext = container.querySelectorAll('nav button')[1]!;
    const initial = ext.querySelector('[data-initial]')!;
    expect(initial.getAttribute('data-initial')).toBe('E');
    expect(initial.getAttribute('aria-hidden')).toBe('true');
    expect(initial.textContent).toBe('');
    expect(classesOf(initial)).toContain('@max-2xl/settings:inline-flex');
  });

  it('宽面板下首字占位 invisible 保留图标位宽度(文字与有图标的页签对齐),窄面板才显示', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const initial = container.querySelectorAll('nav button')[1]!.querySelector('[data-initial]')!;
    const classes = classesOf(initial);
    expect(classes).toContain('invisible');
    expect(classes).toContain('inline-flex');
    expect(classes).toContain('w-4');
    expect(classes).not.toContain('hidden');
    expect(classes).toContain('@max-2xl/settings:visible');
  });

  it('内容区窄面板时缩小内边距', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const content = Array.from(container.querySelectorAll('div')).find((d) => d.textContent === '通用内容')!;
    const cls = classesOf(content);
    expect(cls).toEqual(expect.arrayContaining(['px-4', '@2xl/settings:px-8']));
    expect(cls).not.toContain('px-8');
  });
});

describe('KeybindingsTabContent — 窄宽命令行', () => {
  const originalCommands = coApp.commands;
  beforeEach(() => {
    (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
    useKeybindingsStore.setState({ overrides: {} });
    coApp.commands.register({
      id: 'terminal.search.toggle',
      title: 'Find in Terminal',
      hotkey: 'mod+f',
      category: 'Terminal',
      fn: vi.fn(),
    });
  });
  afterEach(() => {
    (coApp as { commands: CommandRegistry }).commands = originalCommands;
  });

  it('标题占剩余宽度可截断;id 徽标可收缩、窄列表隐藏;编辑按钮在行内', () => {
    const { container } = render(<KeybindingsTabContent />);
    const ul = container.querySelector('ul')!;
    expect(classesOf(ul)).toContain('@container');
    const li = ul.querySelector('li')!;
    const title = Array.from(li.querySelectorAll('span')).find((s) => s.textContent === 'Find in Terminal')!;
    // 标题可收缩(min-w-0)但以 6rem 为 flex 基准:空间不足时与键帽组按基准比例一起收缩,不独占也不被挤成 0 宽
    expect(classesOf(title)).toEqual(expect.arrayContaining(['min-w-0', 'flex-[1_1_6rem]', 'truncate']));
    expect(classesOf(title)).not.toContain('min-w-[6rem]');
    expect(title.getAttribute('title')).toBe('Find in Terminal');
    const code = li.querySelector('code')!;
    expect(classesOf(code)).toContain('truncate');
    const badge = code.closest('.wm-badge')!;
    const badgeCls = classesOf(badge);
    expect(badgeCls).toEqual(expect.arrayContaining(['min-w-0', '@max-md:hidden']));
    expect(badgeCls).not.toContain('shrink-0');
    expect(badgeCls).not.toContain('ml-auto');
    expect(li.querySelector('button[aria-label*="Find in Terminal"]')).not.toBeNull();
  });

  it('改成 4 键组合后窄列表:键帽组可收缩换行,编辑 / 重置按钮不收缩、焦点环不被列表裁掉', () => {
    useKeybindingsStore.setState({ overrides: { 'terminal.search.toggle': 'mod+alt+shift+j' } });
    const { container } = render(<KeybindingsTabContent />);
    const ul = container.querySelector('ul')!;
    expect(classesOf(ul)).not.toContain('overflow-hidden');
    const li = ul.querySelector('li')!;
    const keys = li.querySelector('[data-testid="keybinding-keys"]')!;
    expect(keys.querySelectorAll('kbd, .wm-keycap').length).toBeGreaterThanOrEqual(4);
    expect(classesOf(keys)).toEqual(expect.arrayContaining(['min-w-0', 'flex-wrap']));
    expect(classesOf(keys)).not.toContain('shrink-0');
    const edit = li.querySelector('button[data-keybinding-edit]')!;
    const reset = li.querySelector('button[aria-label*="Find in Terminal"]:not([data-keybinding-edit])')!;
    expect(classesOf(edit)).toContain('shrink-0');
    expect(classesOf(reset)).toContain('shrink-0');
    expect(classesOf(reset)).not.toContain('invisible');
  });

  it('顶部提示行可换行(键帽组自身不拆行,见 keybindings-tab-content)', () => {
    const { container } = render(<KeybindingsTabContent />);
    const hint = container.querySelector('[data-testid="keybindings-palette-hint"]');
    expect(hint?.querySelector('[data-testid="keybindings-palette-keys"]')).not.toBeNull();
    expect(classesOf(hint?.parentElement)).toContain('flex-wrap');
  });
});

describe('PluginsTabContent — 窄宽贡献点表格', () => {
  it('贡献点行可换行,示例列有最小宽度(放不下就换行,不被挤成 0 宽)', () => {
    const { container } = render(<PluginsTabContent />);
    const section = container.querySelector('[data-plugins-section="contributions"]')!;
    const row = section.querySelector('.rounded-md > div')!;
    expect(classesOf(row)).toContain('flex-wrap');
    const samples = row.lastElementChild!;
    expect(classesOf(samples)).toEqual(expect.arrayContaining(['min-w-32', 'flex-1', 'truncate']));
  });

  it('内置插件 id 徽标可截断,不 shrink-0 撑开', () => {
    const { container } = render(<PluginsTabContent />);
    const code = container.querySelector('[data-plugins-section="builtin"] code')!;
    expect(classesOf(code)).toContain('truncate');
    expect(classesOf(code.closest('.wm-badge'))).not.toContain('shrink-0');
  });
});
