// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { SettingsModal } from '../../plugins/settings/SettingsModal';
import { useSettingsStore } from '../../plugins/settings/store';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';

beforeEach(() => {
  useSettingsStore.setState({ isOpen: false, activeTabId: null });
});
afterEach(() => cleanup());

function makeReg(): SettingTabRegistry {
  const r = new SettingTabRegistry();
  r.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
  r.register({ id: 'editor', title: '编辑器', render: () => '编辑器内容', priority: 20 });
  r.register({ id: 'plugins', title: '插件', render: () => '插件内容', priority: 30 });
  return r;
}

describe('SettingsModal UI', () => {
  it('isOpen=false → 不渲染', () => {
    const { container } = render(<SettingsModal settingTabs={makeReg()} />);
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  it('打开后渲染所有 tab + 默认选首项', () => {
    const reg = makeReg();
    render(<SettingsModal settingTabs={reg} />);
    act(() => useSettingsStore.getState().open());
    const navBtns = document.querySelectorAll('.wm-modal-content nav button');
    expect(navBtns.length).toBe(3);
    // 默认 active = 首项 'general'
    expect(document.querySelector('.wm-modal-content')?.textContent).toContain('通用内容');
  });

  it('点击 tab → 切换右侧内容', () => {
    const reg = makeReg();
    render(<SettingsModal settingTabs={reg} />);
    act(() => useSettingsStore.getState().open());
    const navBtns = document.querySelectorAll('.wm-modal-content nav button');
    fireEvent.click(navBtns[1]!); // 编辑器
    expect(document.querySelector('.wm-modal-content')?.textContent).toContain(
      '编辑器内容',
    );
  });

  it('open(tabId) 指定初始 tab', () => {
    const reg = makeReg();
    render(<SettingsModal settingTabs={reg} />);
    act(() => useSettingsStore.getState().open('plugins'));
    expect(document.querySelector('.wm-modal-content')?.textContent).toContain('插件内容');
  });

  it('无注册 tab → 空态文案', () => {
    const reg = new SettingTabRegistry();
    render(<SettingsModal settingTabs={reg} />);
    act(() => useSettingsStore.getState().open());
    expect(document.querySelector('.wm-modal-content')?.textContent).toContain(
      '暂无设置项',
    );
  });

  it('点 header X → close', () => {
    const reg = makeReg();
    render(<SettingsModal settingTabs={reg} />);
    act(() => useSettingsStore.getState().open());
    const xBtn = document.querySelector(
      '.wm-modal-content header button[aria-label="关闭"]',
    )!;
    fireEvent.click(xBtn);
    expect(useSettingsStore.getState().isOpen).toBe(false);
  });

  it('插件动态注册 tab → list 自动更新', () => {
    const reg = new SettingTabRegistry();
    render(<SettingsModal settingTabs={reg} />);
    act(() => useSettingsStore.getState().open());
    expect(document.querySelectorAll('.wm-modal-content nav button').length).toBe(0);
    act(() => {
      reg.register({ id: 'late', title: '晚到', render: () => '内容' });
    });
    expect(document.querySelectorAll('.wm-modal-content nav button').length).toBe(1);
  });
});
