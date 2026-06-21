// @vitest-environment jsdom
// 打磨 R52(codex 性能,仿 R32/R50):PermissionPrompt 拆 shell + 2 body。空闲态
// (无 pending / currentFsScope)shell 只订阅这两个队列字段并返回 null —— 不 useT、
// 不订阅 grant/deny actions、不初始化 selected。切语言等空闲态变化不碰不可见 prompt。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { PermissionPrompt } from '../../plugins/permissions/PermissionPrompt';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { setLocale, notifyLocaleChange } from '../../i18n';

beforeEach(() => {
  usePermissionPromptStore.setState({ pending: null, currentFsScope: null });
});
afterEach(() => {
  setLocale('en');
  cleanup();
});

describe('打磨 R52 — 权限弹窗空闲态不 useT/不挂载 body', () => {
  it('空闲态切语言 → shell 不重渲(无 useT 订阅)', () => {
    const onRender = vi.fn();
    const { container } = render(
      <Profiler id="pp" onRender={onRender}>
        <PermissionPrompt />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(container.querySelector('.wm-modal-content')).toBeNull(); // 空闲无 Modal

    act(() => {
      setLocale('zh');
      notifyLocaleChange();
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('出现 pending → 挂载 manifest body(Modal 渲染)', () => {
    render(<PermissionPrompt />);
    expect(document.querySelector('.wm-modal-content')).toBeNull();

    act(() => {
      void usePermissionPromptStore.getState().request('com.x', ['fs', 'network']);
    });

    expect(document.querySelector('.wm-modal-content')).not.toBeNull();
  });
});
