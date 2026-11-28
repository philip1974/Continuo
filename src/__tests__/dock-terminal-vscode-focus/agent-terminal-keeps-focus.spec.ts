// @vitest-environment jsdom
// BDD:agent 新建终端不抢 DOM 焦点 —— 用户在编辑器里连续打字时,agent 终端加入(向右分屏 / 作为 tab 加入同组)后焦点仍在
// 原输入元素上。见同目录 README 第 8 条。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';

vi.mock('@/notifications/notify', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { reconcileTerminalPanels, __resetReconcilerForTest } from '@/shell/dock/DockReconciler';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 编辑器面板内容里放一个可输入元素(代表 CodeMirror 的 contenteditable)。 */
function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: ({ name }) => {
      const element = document.createElement('div');
      if (name === 'editor') {
        const input = document.createElement('textarea');
        input.className = 'typing-target';
        element.appendChild(input);
      }
      return { element, init: () => {} };
    },
  });
  dock.api.layout(1600, 800, true);
  return dock.api;
}

beforeEach(() => {
  __resetReconcilerForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function typingTarget(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>('.typing-target')!;
}

describe('agent 终端加入不抢 DOM 焦点', () => {
  it('向右分屏出新组(原组 DOM 被挪进 split 容器)后,焦点仍在编辑器的输入元素上', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const user = makeSession('u0', { createdAt: 1 });
    // 先有一个用户终端在编辑器右侧,agent 终端会在它右侧分屏
    api.addPanel({
      id: 'terminal-u0',
      component: 'x',
      title: 'u0',
      params: { sessionId: 'u0', originHint: 'user' },
      position: { referencePanel: 'editor', direction: 'right' },
    });
    api.getPanel('editor')!.api.setActive();
    typingTarget().focus();
    expect(document.activeElement).toBe(typingTarget());

    reconcileTerminalPanels(api, {
      previousSessions: [user],
      nextSessions: [user, makeSession('a0', { originHint: 'agent', createdAt: 2 })],
    });

    expect(api.getPanel('terminal-a0')).toBeTruthy();
    expect(api.activePanel?.id).toBe('editor');
    expect(document.activeElement).toBe(typingTarget());
  });

  it('作为 tab 加进编辑器所在组(原面板内容先被藏起)后,焦点仍在编辑器的输入元素上', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    typingTarget().focus();

    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [makeSession('a0', { originHint: 'agent', createdAt: 1 })],
    });

    expect(api.getPanel('terminal-a0')!.group).toBe(api.getPanel('editor')!.group);
    expect(api.activePanel?.id).toBe('editor');
    expect(document.activeElement).toBe(typingTarget());
  });

  it('焦点原本不在任何元素上(body)→ 不额外聚焦', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    (document.activeElement as HTMLElement | null)?.blur();
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [makeSession('a0', { originHint: 'agent', createdAt: 1 })],
    });
    expect(document.activeElement).toBe(document.body);
  });
});
