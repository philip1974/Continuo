// @vitest-environment jsdom
// BDD: settings-panel
// 测 SettingsPanel UI 行为(左导航 + 右内容 + 空态 + 动态注册);
// store API(activeTabId / setActiveTabId,无 isOpen / open / close)。
//
// 此 spec 在实装前会 red:
//   src/plugins/settings/SettingsPanel.tsx 不存在
//   store.ts 旧 isOpen / open / close API 已被移除

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { SettingsPanel } from '../../plugins/settings/SettingsPanel';
import { useSettingsStore } from '../../plugins/settings/store';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';

beforeEach(() => {
  useSettingsStore.setState({ activeTabId: null });
});
afterEach(() => cleanup());

function makeReg(): SettingTabRegistry {
  const r = new SettingTabRegistry();
  r.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
  r.register({ id: 'editor', title: '编辑器', render: () => '编辑器内容', priority: 20 });
  r.register({ id: 'plugins', title: '插件', render: () => '插件内容', priority: 30 });
  return r;
}

// ────────────────────────────────────────────────────────────
// 渲染:有 tab 时
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 基础渲染', () => {
  it('渲染所有 tab + 默认选首项(priority 升序)', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const navBtns = container.querySelectorAll('nav button');
    expect(navBtns.length).toBe(3);
    expect(navBtns[0]?.textContent).toBe('通用');
    expect(container.textContent).toContain('通用内容');
  });

  it('点击 tab → 切换右侧内容 + 写 store.activeTabId', () => {
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    const navBtns = container.querySelectorAll('nav button');
    fireEvent.click(navBtns[1]!);
    expect(container.textContent).toContain('编辑器内容');
    expect(useSettingsStore.getState().activeTabId).toBe('editor');
  });

  it('store 预置 activeTabId → 渲染时直接选中该 tab', () => {
    useSettingsStore.setState({ activeTabId: 'plugins' });
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    expect(container.textContent).toContain('插件内容');
  });

  it('activeTabId 指向已 unregister 的 id → 兜底首项', () => {
    useSettingsStore.setState({ activeTabId: 'no-such-tab' });
    const { container } = render(<SettingsPanel registry={makeReg()} />);
    expect(container.textContent).toContain('通用内容');
  });
});

// ────────────────────────────────────────────────────────────
// 空态
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 空态', () => {
  it('无 tab 注册 → 显示"暂无设置项"', () => {
    const { container } = render(<SettingsPanel registry={new SettingTabRegistry()} />);
    expect(container.textContent).toContain('暂无设置项');
  });
});

// ────────────────────────────────────────────────────────────
// 动态 register / unregister
// ────────────────────────────────────────────────────────────

describe('SettingsPanel · 动态 registry', () => {
  it('运行时 register 新 tab → 列表自动更新', () => {
    const reg = new SettingTabRegistry();
    const { container } = render(<SettingsPanel registry={reg} />);
    expect(container.querySelectorAll('nav button').length).toBe(0);
    act(() => {
      reg.register({
        id: 'late',
        title: '晚到',
        render: () => '内容',
      });
    });
    expect(container.querySelectorAll('nav button').length).toBe(1);
  });

  it('运行时 dispose 当前 active tab 的 disposable → 兜底首项', () => {
    const reg = new SettingTabRegistry();
    reg.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
    const editorD = reg.register({
      id: 'editor',
      title: '编辑器',
      render: () => '编辑器内容',
      priority: 20,
    });
    useSettingsStore.setState({ activeTabId: 'editor' });
    const { container } = render(<SettingsPanel registry={reg} />);
    expect(container.textContent).toContain('编辑器内容');
    act(() => editorD.dispose());
    expect(container.textContent).toContain('通用内容');
  });
});

// ────────────────────────────────────────────────────────────
// store API 形态(决策 #2:关 panel 不 reset)
// ────────────────────────────────────────────────────────────

describe('useSettingsStore · API 形态', () => {
  it('只有 activeTabId / setActiveTabId,无 isOpen/open/close', () => {
    const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
    expect('activeTabId' in state).toBe(true);
    expect('setActiveTabId' in state).toBe(true);
    expect('isOpen' in state).toBe(false);
    expect('open' in state).toBe(false);
    expect('close' in state).toBe(false);
  });

  it('setActiveTabId 写入状态', () => {
    useSettingsStore.getState().setActiveTabId('foo');
    expect(useSettingsStore.getState().activeTabId).toBe('foo');
  });

  it('panel unmount 后 activeTabId 仍保留(决策 #2)', () => {
    const reg = makeReg();
    const { container, unmount } = render(<SettingsPanel registry={reg} />);
    fireEvent.click(container.querySelectorAll('nav button')[2]!); // plugins
    expect(useSettingsStore.getState().activeTabId).toBe('plugins');
    unmount();
    // store 不变 — 重新打开还在 plugins
    expect(useSettingsStore.getState().activeTabId).toBe('plugins');
  });
});
