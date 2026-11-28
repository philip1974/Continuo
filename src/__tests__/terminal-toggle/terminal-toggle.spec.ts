// @vitest-environment jsdom
// BDD: terminal-toggle —— ⌃` 切换终端(VSCode workbench.action.terminal.toggleTerminal)。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';

const mocks = vi.hoisted(() => ({ createUserTerminal: vi.fn(async () => 'new-term') }));
vi.mock('../../shell/dock/create-user-terminal', () => ({
  createUserTerminal: mocks.createUserTerminal,
  terminalColorFgBg: () => '15;0',
}));

import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { trackGroupMru } from '@/shell/dock/group-mru';
import { runInCommandDocument } from '@/shell/dock/popout-documents';
import { toggleTerminal } from '@/shell/dock/toggle-terminal';
import { TERMINAL_TOGGLE_COMMAND, terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { __resetTerminalPanelHandlesForTest, registerTerminalPanelHandles } from '@/panels/Terminal/terminal-panel-handles';
import { POPOUT_HOTKEY_COMMAND_IDS, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { useEditorStore } from '@/stores/editor.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { createDock } from '../dock-terminal-vscode-focus/dock-fixtures';

const ID = 'workbench.action.terminal.toggleTerminal';
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const disposers: { dispose(): void }[] = [];

/** 面板内容里放一个可聚焦落点(编辑器:contenteditable;终端:xterm 的 textarea),终端注册 focus 句柄。 */
function addPanel(api: DockviewApi, id: string, component: 'editor' | 'terminal', ref?: string): IDockviewPanel {
  const panel = api.addPanel({
    id,
    component,
    title: id,
    ...(ref ? { position: { referencePanel: ref, direction: 'right' as const } } : {}),
  });
  const el = component === 'editor' ? document.createElement('div') : document.createElement('textarea');
  if (component === 'editor') {
    el.setAttribute('contenteditable', 'true');
    el.tabIndex = 0;
  }
  el.dataset['testId'] = id;
  panel.view.content.element.appendChild(el);
  if (component === 'terminal') {
    registerTerminalPanelHandles(id, { focus: () => el.focus(), openSearch: () => {}, clear: () => {}, scroll: () => {}, clipboard: () => {}, readText: () => '', readViewport: () => null });
  }
  return panel;
}

const focusedId = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset['testId'];

function setup(withTerminals = true) {
  useEditorStore.setState({ activeGroupId: 'editor' });
  const dock = createDock();
  const api = dock.api as DockviewApi;
  setDockApi(api);
  const editor = addPanel(api, 'editor', 'editor');
  const t1 = withTerminals ? addPanel(api, 't1', 'terminal', 'editor') : undefined;
  const t2 = withTerminals ? addPanel(api, 't2', 'terminal', 't1') : undefined;
  disposers.push(trackGroupMru(api));
  return { api, editor, t1, t2 };
}

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());
beforeEach(() => {
  __resetTerminalPanelHandlesForTest();
  mocks.createUserTerminal.mockClear();
});
afterEach(() => {
  for (const d of disposers.splice(0)) d.dispose();
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('命令注册与按键', () => {
  it('默认键 ctrl+`(两平台相同),三语标题;常量与注册一致', () => {
    // 附加默认键 ⌘J / Ctrl+J(VSCode 切换面板)见 src/__tests__/workbench-vscode-default-keys/
    expect(TERMINAL_TOGGLE_COMMAND).toEqual({ id: ID, hotkey: 'ctrl+`', secondaryHotkeys: ['mod+j'] });
    const spec = coApp.commands.get(ID);
    expect(spec?.hotkey).toBe('ctrl+`');
    const k = spec!.titleKey as keyof typeof en;
    expect(en[k]).toBe('Toggle Terminal');
    expect(zh[k]).toBe('切换终端');
    expect(ko[k]).toBeTruthy();
  });

  it('⌃` 在分发表里胜出(两平台);终端里让出(不进 shell);popout 子窗里分发', () => {
    const all = coApp.commands.getAll();
    for (const platform of ['mac', 'other'] as const) {
      expect(winningCommandFor(key({ key: '`', code: 'Backquote', ctrlKey: true }), all, platform, {})?.id).toBe(ID);
      expect(terminalYieldedCommandId(key({ key: '`', code: 'Backquote', ctrlKey: true }), platform, {}, coApp.commands)).toBe(ID);
    }
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(ID)).toBe(true);
  });
});

describe('切换', () => {
  it('焦点在编辑器 → 最近使用的终端激活并获焦(按激活顺序,不按面板顺序)', async () => {
    const { api, editor, t1, t2 } = setup();
    t1!.api.setActive();
    t2!.api.setActive();
    editor.api.setActive();
    (editor.view.content.element.firstElementChild as HTMLElement).focus();
    await runInCommandDocument(document, toggleTerminal);
    await flush();
    expect(api.activePanel).toBe(t2);
    expect(focusedId()).toBe('t2');
  });

  it('焦点在终端 → 回到编辑器(编辑器组激活,焦点进编辑区)', async () => {
    const { api, editor, t2 } = setup();
    editor.api.setActive();
    t2!.api.setActive();
    (t2!.view.content.element.firstElementChild as HTMLElement).focus();
    await runInCommandDocument(document, toggleTerminal);
    await flush();
    expect(api.activePanel).toBe(editor);
    expect(focusedId()).toBe('editor');
  });

  it('往返:编辑器 → 终端 → 编辑器', async () => {
    const { api, editor, t2 } = setup();
    t2!.api.setActive();
    editor.api.setActive();
    (editor.view.content.element.firstElementChild as HTMLElement).focus();
    await runInCommandDocument(document, toggleTerminal);
    await flush();
    expect(focusedId()).toBe('t2');
    await runInCommandDocument(document, toggleTerminal);
    await flush();
    expect(api.activePanel).toBe(editor);
    expect(focusedId()).toBe('editor');
  });

  it('活动面板是终端但焦点不在它里面(在资源管理器)→ 聚焦该终端,不切走', async () => {
    const { api, t2 } = setup();
    t2!.api.setActive();
    const explorer = document.createElement('button');
    document.body.appendChild(explorer);
    explorer.focus();
    await runInCommandDocument(document, toggleTerminal);
    await flush();
    expect(api.activePanel).toBe(t2);
    expect(focusedId()).toBe('t2');
  });

  it('没有终端 → 新建一个(与 ⌘T 同一流程)', async () => {
    const { editor } = setup(false);
    (editor.view.content.element.firstElementChild as HTMLElement).focus();
    await runInCommandDocument(document, toggleTerminal);
    expect(mocks.createUserTerminal).toHaveBeenCalledTimes(1);
  });
});
