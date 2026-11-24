// @vitest-environment jsdom
// BDD:终端默认名本地化(「终端 2」/「터미널 2」),随语言切换更新;MCP 给 agent 的 title 仍是英文稳定名。
// 见同目录 README 第 5 条。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { setLocale } from '@/i18n';
import { terminalPanelTitle } from '@/shell/dock/terminal-panel-id';
import {
  reconcileTerminalPanels,
  syncTerminalPanelTitles,
  __resetReconcilerForTest,
} from '@/shell/dock/DockReconciler';
import { filterByOwnerWindow } from '@/stores/terminal.store';
import { makeCreateHandler } from '../../../electron/main/ipc/terminal.ipc';
import * as sessionStore from '../../../electron/main/services/terminal-sessions.service';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';
import { createDock } from './dock-fixtures';

beforeEach(() => {
  __resetReconcilerForTest();
  sessionStore._reset();
});
afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('main:默认名记序号,title 保持英文稳定名', () => {
  const fakeWin = { id: 11, isDestroyed: () => false } as unknown as import('electron').BrowserWindow;
  const makeHandler = () =>
    makeCreateHandler({
      service: { createTerminal: vi.fn() } as never,
      sessionStore,
      resolveCwd: () => '/tmp',
      generateId: (() => {
        let n = 0;
        return () => `t${++n}`;
      })(),
    });

  it('未命名 → title「Terminal N」(MCP list_sessions 契约)+ defaultTitleIndex N', async () => {
    const handler = makeHandler();
    await handler({}, fakeWin);
    await handler({}, fakeWin);
    const [first, second] = sessionStore.getAll({ ownerWindowId: 11 });
    expect(first).toMatchObject({ title: 'Terminal 1', defaultTitleIndex: 1 });
    expect(second).toMatchObject({ title: 'Terminal 2', defaultTitleIndex: 2 });
  });

  it('显式命名 → 无 defaultTitleIndex,显示原名', async () => {
    await makeHandler()({ name: 'build' }, fakeWin);
    const [s] = sessionStore.getAll({ ownerWindowId: 11 });
    expect(s?.title).toBe('build');
    expect(s && 'defaultTitleIndex' in s).toBe(false);
  });
});

describe('renderer:按当前语言显示默认名', () => {
  it('zh「终端 2」/ ko「터미널 2」/ en「Terminal 2」;退出后缀同语言', () => {
    const input = { sessionId: 'abc', sessionTitle: 'Terminal 2', defaultTitleIndex: 2 };
    setLocale('zh');
    expect(terminalPanelTitle(input)).toBe('终端 2');
    expect(terminalPanelTitle({ ...input, exited: true })).toBe('终端 2 (已退出)');
    setLocale('ko');
    expect(terminalPanelTitle(input)).toBe('터미널 2');
    setLocale('en');
    expect(terminalPanelTitle(input)).toBe('Terminal 2');
  });

  it('显式命名的会话不翻译', () => {
    setLocale('zh');
    expect(terminalPanelTitle({ sessionId: 'abc', sessionTitle: 'build' })).toBe('build');
  });

  it('store ingress 保留合法 defaultTitleIndex,丢弃畸形值', () => {
    const ok = filterByOwnerWindow([makeSession('a', { defaultTitleIndex: 3 })], 1);
    expect(ok[0]?.defaultTitleIndex).toBe(3);
    expect(filterByOwnerWindow([{ ...makeSession('b'), defaultTitleIndex: -1 }], 1)).toHaveLength(0);
    expect(filterByOwnerWindow([{ ...makeSession('c'), defaultTitleIndex: 1.5 }], 1)).toHaveLength(0);
  });

  it('切换语言后,dock 中已有终端面板(含未挂载内容的)标题随之更新', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    const s = makeSession('a', { title: 'Terminal 1', defaultTitleIndex: 1 });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [s] });
    expect(api.getPanel('terminal-a')?.api.title).toBe('Terminal 1');
    setLocale('zh');
    syncTerminalPanelTitles(api, [s]);
    expect(api.getPanel('terminal-a')?.api.title).toBe('终端 1');
  });
});
