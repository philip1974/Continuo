// @vitest-environment jsdom
// BDD: terminal-focus-cycle —— 终端获焦时切换到下一个 / 上一个终端、切换分屏窗格(VSCode workbench.action.terminal.focusNext /
// focusPrevious / focusNextPane / focusPreviousPane)。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';

vi.mock('../../shell/dock/create-user-terminal', () => ({
  createUserTerminal: vi.fn(async () => 'new-term'),
  terminalColorFgBg: () => '15;0',
}));

import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { trackGroupMru } from '@/shell/dock/group-mru';
import { runInCommandDocument } from '@/shell/dock/popout-documents';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { __resetTerminalPanelHandlesForTest, registerTerminalPanelHandles } from '@/panels/Terminal/terminal-panel-handles';
import { isPopoutHotkeyCommand, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { selectKeybindingConflicts } from '@/plugins/keybindings/KeybindingCaptureModal';
import { TERMINAL_ATTR, whenCoveredBy, whenOverlaps } from '@/lib/editor-text-focus';
import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { editorCommandSpecs } from '@/panels/Editor/editor-commands';
import { registerEditorFocus } from '@/panels/Editor/editor-focus-registry';
import { terminalFocusCycleCommandSpecs } from '@/shell/dock/terminal-focus-cycle';
import { useEditorStore } from '@/stores/editor.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

const NEXT = 'workbench.action.terminal.focusNext';
const PREV = 'workbench.action.terminal.focusPrevious';
const NEXT_PANE = 'workbench.action.terminal.focusNextPane';
const PREV_PANE = 'workbench.action.terminal.focusPreviousPane';
const NEXT_EDITOR = 'workbench.action.nextEditor';
const PREV_EDITOR = 'workbench.action.previousEditor';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const disposers: { dispose(): void }[] = [];

type Dir = 'right' | 'below' | 'left' | 'within';

/** 面板内容里放一个可聚焦落点(编辑器:contenteditable;终端:带 TERMINAL_ATTR 的宿主里的 xterm textarea)。 */
function addPanel(api: DockviewApi, id: string, component: 'editor' | 'terminal', ref?: string, direction: Dir = 'right'): IDockviewPanel {
  const panel = api.addPanel({
    id,
    component,
    title: id,
    ...(ref ? { position: { referencePanel: ref, direction } } : {}),
  });
  let focusable: HTMLElement;
  if (component === 'editor') {
    focusable = document.createElement('div');
    focusable.setAttribute('contenteditable', 'true');
    focusable.tabIndex = 0;
    panel.view.content.element.appendChild(focusable);
  } else {
    const host = document.createElement('div');
    host.setAttribute(TERMINAL_ATTR, '');
    focusable = document.createElement('textarea');
    host.appendChild(focusable);
    panel.view.content.element.appendChild(host);
    registerTerminalPanelHandles(id, { focus: () => focusable.focus(), openSearch: () => {}, clear: () => {}, scroll: () => {}, clipboard: () => {}, readText: () => '', readViewport: () => null });
  }
  focusable.dataset['testId'] = id;
  return panel;
}

const inputOf = (panel: IDockviewPanel): HTMLElement =>
  panel.view.content.element.querySelector<HTMLElement>('[data-test-id]')!;
const focusedIn = (doc: Document = document): string | undefined => (doc.activeElement as HTMLElement | null)?.dataset['testId'];

function focusPanel(panel: IDockviewPanel): void {
  panel.api.setActive();
  inputOf(panel).focus();
}

/** 在元素上按下(已派发,target = 该元素)。 */
function pressOn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

async function run(id: string, doc: Document = document): Promise<void> {
  await runInCommandDocument(doc, () => coApp.commands.execute(id));
  await flush();
}

/**
 * 主窗:editor | t1 | [t2, t3](t2、t3 同组,t3 被遮住)。t0 建在 t1 左侧(创建晚、空间在前):顺序按空间不按创建。
 * 空间顺序:editor, t0, t1, [t2, t3]。
 */
function setup() {
  useEditorStore.setState({ activeGroupId: 'editor' });
  const dock = createDock();
  const api = dock.api as DockviewApi;
  setDockApi(api);
  const editor = addPanel(api, 'editor', 'editor');
  const t1 = addPanel(api, 't1', 'terminal', 'editor');
  const t2 = addPanel(api, 't2', 'terminal', 't1');
  const t3 = addPanel(api, 't3', 'terminal', 't2', 'within');
  const t0 = addPanel(api, 't0', 'terminal', 't1', 'left');
  t2.api.setActive(); // t2 组显示 t2,t3 被遮住
  disposers.push(trackGroupMru(api));
  return { dock, api, editor, t0, t1, t2, t3 };
}

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());
beforeEach(() => __resetTerminalPanelHandlesForTest());
afterEach(() => {
  for (const d of disposers.splice(0)) d.dispose();
  setDockApi(null);
  useEditorStore.setState({ tabs: [], activeTabId: null });
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('命令注册', () => {
  it('四条命令:三语标题、类别终端、限终端焦点;mac / Windows·Linux 默认键同 VSCode', () => {
    const titles: Record<string, [string, string]> = {
      [NEXT]: ['Focus Next Terminal', '聚焦下一个终端'],
      [PREV]: ['Focus Previous Terminal', '聚焦上一个终端'],
      [NEXT_PANE]: ['Focus Next Terminal Pane', '聚焦下一个终端窗格'],
      [PREV_PANE]: ['Focus Previous Terminal Pane', '聚焦上一个终端窗格'],
    };
    for (const [id, [enTitle, zhTitle]] of Object.entries(titles)) {
      const spec = coApp.commands.get(id);
      expect(spec, id).toBeDefined();
      // 窗格命令另须有分屏(VSCode when: terminalFocus && terminalSplitActive)
      expect(spec!.when).toBe(id === NEXT_PANE || id === PREV_PANE ? 'terminalSplitFocus' : 'terminalFocus');
      expect(spec!.categoryKey).toBe('commands.terminal.category');
      const k = spec!.titleKey as keyof typeof en;
      expect(en[k]).toBe(enTitle);
      expect(zh[k]).toBe(zhTitle);
      expect(ko[k]).toBeTruthy();
      // when 限定的命令在 popout 子窗里也经热键分发
      expect(isPopoutHotkeyCommand(spec!)).toBe(true);
    }
    // 注册的默认键 = 按当前平台的 spec
    for (const spec of terminalFocusCycleCommandSpecs(detectPlatform())) {
      expect(coApp.commands.get(spec.id)!.hotkey).toBe(spec.hotkey);
      expect(coApp.commands.get(spec.id)!.secondaryHotkeys).toEqual(spec.secondaryHotkeys);
    }
  });

  it.each([
    ['mac', ['mod+shift+]'], ['mod+shift+['], ['mod+alt+right', 'mod+alt+down'], ['mod+alt+left', 'mod+alt+up']],
    ['other', ['ctrl+pagedown'], ['ctrl+pageup'], ['alt+right', 'alt+down'], ['alt+left', 'alt+up']],
  ] as const)('%s 默认键', (platform, next, prev, nextPane, prevPane) => {
    const keys = (id: string) => {
      const spec = terminalFocusCycleCommandSpecs(platform).find((c) => c.id === id)!;
      return [spec.hotkey, ...(spec.secondaryHotkeys ?? [])];
    };
    expect(keys(NEXT)).toEqual(next);
    expect(keys(PREV)).toEqual(prev);
    expect(keys(NEXT_PANE)).toEqual(nextPane);
    expect(keys(PREV_PANE)).toEqual(prevPane);
  });
});

/** 指定平台的分发表:编辑器命令(下一个 / 上一个编辑器等)+ 终端切换命令 + 其余已注册命令。 */
function commandsFor(platform: Platform): CommandSpec[] {
  const own = [...editorCommandSpecs(platform), ...terminalFocusCycleCommandSpecs(platform)];
  const ids = new Set(own.map((c) => c.id));
  return [...own, ...coApp.commands.getAll().filter((c) => !ids.has(c.id))];
}
const registryFor = (platform: Platform) => ({ getAll: () => commandsFor(platform) });

describe('按键:终端里切终端,编辑器里仍是切编辑器 tab', () => {
  const MAC_KEYS = {
    next: { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true },
    prev: { key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true },
    nextPane: { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true },
    prevPane: { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true },
  };

  it('mac:终端输入区里 ⇧⌘] / ⇧⌘[ / ⌥⌘→ / ⌥⌘← 胜出的是终端命令;编辑器里是下一个 / 上一个编辑器', () => {
    const { t1, editor } = setup();
    const all = commandsFor('mac');
    const term = inputOf(t1);
    const ed = inputOf(editor);
    expect(winningCommandFor(pressOn(term, MAC_KEYS.next), all, 'mac', {})?.id).toBe(NEXT);
    expect(winningCommandFor(pressOn(term, MAC_KEYS.prev), all, 'mac', {})?.id).toBe(PREV);
    expect(winningCommandFor(pressOn(term, MAC_KEYS.nextPane), all, 'mac', {})?.id).toBe(NEXT_PANE);
    expect(winningCommandFor(pressOn(term, MAC_KEYS.prevPane), all, 'mac', {})?.id).toBe(PREV_PANE);
    // 编辑器里:同键仍归下一个 / 上一个编辑器
    expect(winningCommandFor(pressOn(ed, MAC_KEYS.next), all, 'mac', {})?.id).toBe(NEXT_EDITOR);
    expect(winningCommandFor(pressOn(ed, MAC_KEYS.prev), all, 'mac', {})?.id).toBe(PREV_EDITOR);
    expect(winningCommandFor(pressOn(ed, MAC_KEYS.nextPane), all, 'mac', {})?.id).toBe(NEXT_EDITOR);
    expect(winningCommandFor(pressOn(ed, MAC_KEYS.prevPane), all, 'mac', {})?.id).toBe(PREV_EDITOR);
  });

  it('Windows / Linux:终端里 Ctrl+PageDown / PageUp 是切终端,编辑器里是切编辑器 tab', () => {
    const { t1, editor } = setup();
    const all = commandsFor('other');
    const pgDn = { key: 'PageDown', code: 'PageDown', ctrlKey: true };
    const pgUp = { key: 'PageUp', code: 'PageUp', ctrlKey: true };
    expect(winningCommandFor(pressOn(inputOf(t1), pgDn), all, 'other', {})?.id).toBe(NEXT);
    expect(winningCommandFor(pressOn(inputOf(t1), pgUp), all, 'other', {})?.id).toBe(PREV);
    expect(winningCommandFor(pressOn(inputOf(editor), pgDn), all, 'other', {})?.id).toBe(NEXT_EDITOR);
    expect(winningCommandFor(pressOn(inputOf(editor), pgUp), all, 'other', {})?.id).toBe(PREV_EDITOR);
    expect(terminalYieldedCommandId(pressOn(inputOf(t1), pgDn), 'other', {}, registryFor('other'))).toBe(NEXT);
  });

  it('终端搜索条等终端里的其它输入框不算终端焦点', () => {
    const { t1 } = setup();
    const search = document.createElement('input');
    t1.view.content.element.appendChild(search);
    expect(winningCommandFor(pressOn(search, MAC_KEYS.next), commandsFor('mac'), 'mac', {})?.id).toBe(NEXT_EDITOR);
  });

  it('终端里让出(不发给 shell):下一个 / 上一个终端两平台都让出', () => {
    const { t1 } = setup();
    const term = inputOf(t1);
    const reg = registryFor('mac');
    expect(terminalYieldedCommandId(pressOn(term, MAC_KEYS.next), 'mac', {}, reg)).toBe(NEXT);
    expect(terminalYieldedCommandId(pressOn(term, MAC_KEYS.prev), 'mac', {}, reg)).toBe(PREV);
    // 用户把它改绑到无 ⌘ 的键:仍让出(在 commandsToSkipShell 默认列表里,不只 Meta)
    const overrides = { [NEXT]: 'ctrl+f9' };
    expect(terminalYieldedCommandId(pressOn(term, { key: 'F9', code: 'F9', ctrlKey: true }), 'mac', overrides, reg)).toBe(NEXT);
  });

  it('窗格键只在该窗口有不止一个终端窗格时归窗格命令并让出', () => {
    const { t1 } = setup();
    const term = inputOf(t1);
    const altRight = { key: 'ArrowRight', code: 'ArrowRight', altKey: true };
    expect(terminalYieldedCommandId(pressOn(term, MAC_KEYS.nextPane), 'mac', {}, registryFor('mac'))).toBe(NEXT_PANE);
    expect(terminalYieldedCommandId(pressOn(term, MAC_KEYS.prevPane), 'mac', {}, registryFor('mac'))).toBe(PREV_PANE);
    expect(terminalYieldedCommandId(pressOn(term, altRight), 'other', {}, registryFor('other'))).toBe(NEXT_PANE);
  });

  it('没有分屏(只剩一个终端窗格):mac ⌥⌘→ / ⌥⌘← 落到下一个 / 上一个编辑器并让出;Windows / Linux Alt+→ / Alt+← 照常进 shell', () => {
    const { api, t1 } = setup();
    for (const id of ['t0', 't2', 't3']) api.getPanel(id)!.api.close();
    const term = inputOf(t1);
    const mac = commandsFor('mac');
    expect(winningCommandFor(pressOn(term, MAC_KEYS.nextPane), mac, 'mac', {})?.id).toBe(NEXT_EDITOR);
    expect(winningCommandFor(pressOn(term, MAC_KEYS.prevPane), mac, 'mac', {})?.id).toBe(PREV_EDITOR);
    expect(terminalYieldedCommandId(pressOn(term, MAC_KEYS.nextPane), 'mac', {}, registryFor('mac'))).toBe(NEXT_EDITOR);
    expect(terminalYieldedCommandId(pressOn(term, MAC_KEYS.prevPane), 'mac', {}, registryFor('mac'))).toBe(PREV_EDITOR);
    // 附加键 ⌥⌘↓ / ⌥⌘↑ 不再归窗格命令
    const macDown = { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true };
    expect(winningCommandFor(pressOn(term, macDown), mac, 'mac', {})?.id).not.toBe(NEXT_PANE);
    // Windows / Linux:Alt+→ / Alt+← 不归窗格命令、不让出(照常进 shell)
    const other = commandsFor('other');
    for (const [key, pane] of [['ArrowRight', NEXT_PANE], ['ArrowLeft', PREV_PANE]] as const) {
      const e = { key, code: key, altKey: true };
      expect(winningCommandFor(pressOn(term, e), other, 'other', {})?.id).not.toBe(pane);
      expect(terminalYieldedCommandId(pressOn(term, e), 'other', {}, registryFor('other'))).toBeNull();
    }
  });

  it('没有分屏时按下 → 在编辑器组(不是终端所在组)里切到下一个 / 上一个文件 tab,焦点进入该编辑器(VSCode nextEditor 不保留焦点)', async () => {
    const { api, t1, editor } = setup();
    for (const id of ['t0', 't2', 't3']) api.getPanel(id)!.api.close();
    const file = (p: string) => ({ id: p, filePath: p, content: '', originalContent: '', dirty: false });
    useEditorStore.setState({ tabs: [file('/w/a.ts'), file('/w/b.ts'), file('/w/c.ts')], activeTabId: '/w/a.ts' });
    // 编辑器视图就绪时按 tab 登记聚焦句柄(CodeEditor / MilkdownEditor 同此)
    for (const p of ['/w/a.ts', '/w/c.ts']) disposers.push({ dispose: registerEditorFocus(p, () => inputOf(editor).focus(), 'editor') });
    focusPanel(t1);
    const term = inputOf(t1);
    const press = async (k: KeyboardEventInit) => {
      await run(winningCommandFor(pressOn(inputOf(t1), k), commandsFor('mac'), 'mac', {})!.id);
      await new Promise((r) => setTimeout(r, 50)); // 聚焦在下一帧兑现
    };
    await press(MAC_KEYS.prevPane);
    expect(useEditorStore.getState().activeTabId).toBe('/w/c.ts');
    expect(focusedIn()).toBe('editor');
    focusPanel(t1);
    expect(document.activeElement).toBe(term);
    await press(MAC_KEYS.nextPane);
    expect(useEditorStore.getState().activeTabId).toBe('/w/a.ts');
    expect(focusedIn()).toBe('editor');
  });

  it('快捷键页:终端命令与同键的下一个 / 上一个编辑器不算冲突', () => {
    const all = coApp.commands.getAll();
    const nextEditorKeys = [coApp.commands.get(NEXT_EDITOR)!.hotkey!, ...(coApp.commands.get(NEXT_EDITOR)!.secondaryHotkeys ?? [])];
    for (const hotkey of nextEditorKeys) {
      expect(selectKeybindingConflicts(all, NEXT, hotkey).map((c) => c.id)).not.toContain(NEXT_EDITOR);
      expect(selectKeybindingConflicts(all, NEXT_EDITOR, hotkey).map((c) => c.id)).not.toContain(NEXT);
    }
    // 与限定在编辑器正文里的同键命令(Windows / Linux 上移行 Alt+↑ = 窗格附加键)条件互斥,不是冲突
    expect(selectKeybindingConflicts(all, PREV_PANE, 'alt+up').map((c) => c.id)).not.toContain('editor.action.moveLinesUpAction');
    expect(selectKeybindingConflicts(all, 'editor.action.moveLinesUpAction', 'alt+up').map((c) => c.id)).not.toContain(PREV_PANE);
    // 上下文关系:终端主缓冲 ⊂ 终端;终端与编辑器互斥
    expect(whenCoveredBy('terminalNormalBufferFocus', 'terminalFocus')).toBe(true);
    expect(whenCoveredBy('terminalFocus', 'terminalNormalBufferFocus')).toBe(false);
    expect(whenOverlaps('terminalFocus', 'editorFocus')).toBe(false);
    expect(whenOverlaps('terminalFocus', 'editorTextFocus')).toBe(false);
    // 有分屏的终端 ⊂ 终端;与主缓冲条件可同时成立;与编辑器互斥
    expect(whenCoveredBy('terminalSplitFocus', 'terminalFocus')).toBe(true);
    expect(whenOverlaps('terminalSplitFocus', 'terminalNormalBufferFocus')).toBe(true);
    expect(whenOverlaps('terminalSplitFocus', 'editorFocus')).toBe(false);
    // 两条终端命令改到同一键仍是冲突
    expect(selectKeybindingConflicts(all, NEXT, coApp.commands.get(PREV)!.hotkey!).map((c) => c.id)).toContain(PREV);
  });
});

describe('下一个 / 上一个终端', () => {
  it('按空间顺序(不按创建顺序)跨组轮转,含同组被遮住的 tab(切到时激活),首尾相接;焦点进入目标终端', async () => {
    const { api, t0, t1, t2, t3 } = setup();
    focusPanel(t0);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await run(NEXT);
      seen.push(focusedIn()!);
      expect(api.activePanel?.id).toBe(seen.at(-1));
    }
    expect(seen).toEqual(['t1', 't2', 't3', 't0']);
    expect(t3.group.activePanel).toBe(t3);
    expect(t1.group).not.toBe(t2.group);
  });

  it('上一个:反向,首尾相接', async () => {
    const { t0 } = setup();
    focusPanel(t0);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await run(PREV);
      seen.push(focusedIn()!);
    }
    expect(seen).toEqual(['t3', 't2', 't1', 't0']);
  });

  it('命令面板执行(焦点不在终端):以该窗口的活动终端为起点', async () => {
    const { t1 } = setup();
    focusPanel(t1);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await run(NEXT);
    expect(focusedIn()).toBe('t2');
  });

  it('目标在最大化组之外 → 先退出最大化再切过去', async () => {
    const { api, t1 } = setup();
    focusPanel(t1);
    api.maximizeGroup(t1);
    expect(api.hasMaximizedGroup()).toBe(true);
    await run(NEXT);
    expect(api.hasMaximizedGroup()).toBe(false);
    expect(focusedIn()).toBe('t2');
  });

  it('只有一个终端 → 不动', async () => {
    useEditorStore.setState({ activeGroupId: 'editor' });
    const dock = createDock();
    const api = dock.api as DockviewApi;
    setDockApi(api);
    addPanel(api, 'editor', 'editor');
    const t1 = addPanel(api, 't1', 'terminal', 'editor');
    disposers.push(trackGroupMru(api));
    focusPanel(t1);
    await run(NEXT);
    await run(PREV);
    expect(focusedIn()).toBe('t1');
  });
});

describe('下一个 / 上一个窗格', () => {
  it('在正显示终端的组间按空间顺序移动(活动 tab 是编辑器的组不算;被遮住的终端 tab 不切出),首尾相接', async () => {
    const { t0 } = setup();
    focusPanel(t0);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await run(NEXT_PANE);
      seen.push(focusedIn()!);
    }
    // 窗格:t0, t1, t2(t3 被 t2 遮住;editor 组不是终端窗格)
    expect(seen).toEqual(['t1', 't2', 't0']);
    for (let i = 0; i < 3; i++) {
      await run(PREV_PANE);
      seen.push(focusedIn()!);
    }
    expect(seen.slice(3)).toEqual(['t2', 't1', 't0']);
  });

  it('组的活动 tab 换成被遮住的终端后,窗格移动到它', async () => {
    const { t1, t3 } = setup();
    t3.api.setActive();
    focusPanel(t1);
    await run(NEXT_PANE);
    expect(focusedIn()).toBe('t3');
  });

  it('最大化时只有被最大化的组可见 → 不动', async () => {
    const { api, t1 } = setup();
    focusPanel(t1);
    api.maximizeGroup(t1);
    await run(NEXT_PANE);
    expect(focusedIn()).toBe('t1');
    expect(api.hasMaximizedGroup()).toBe(true);
  });
});

describe('popout 子窗:只在本窗口的终端间轮转', () => {
  it('子窗里 t2、t4 同组:下一个 / 上一个只在 t2 ↔ t4 间切换,不跳到主窗;主窗里按不跳进子窗', async () => {
    const { dock, api, t0, t1, t2 } = setup();
    await openFakePopout(dock, 't2');
    // jsdom 的 iframe 随后自己再派发一次 load(dockview 据此把子窗容器重挂一遍、焦点丢失):等它过去
    await flush();
    const popoutGroup = t2.group;
    expect(popoutGroup.api.location.type).toBe('popout');
    const t4 = api.addPanel({ id: 't4', component: 'terminal', title: 't4', position: { referenceGroup: popoutGroup } });
    const host = document.createElement('div');
    host.setAttribute(TERMINAL_ATTR, '');
    const input = document.createElement('textarea');
    input.dataset['testId'] = 't4';
    host.appendChild(input);
    t4.view.content.element.appendChild(host);
    registerTerminalPanelHandles('t4', { focus: () => input.focus(), openSearch: () => {}, clear: () => {}, scroll: () => {}, clipboard: () => {}, readText: () => '', readViewport: () => null });
    expect(t4.group).toBe(popoutGroup);
    const child = popoutGroup.element.ownerDocument;
    expect(child).not.toBe(document);

    t2.api.setActive();
    inputOf(t2).focus();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await run(NEXT, child);
      seen.push(focusedIn(child)!);
    }
    expect(seen).toEqual(['t4', 't2', 't4']);
    await run(PREV, child);
    expect(focusedIn(child)).toBe('t2');
    // 子窗只有一个组 → 窗格命令不动
    await run(NEXT_PANE, child);
    expect(focusedIn(child)).toBe('t2');

    // 主窗:t0 → t1 → t3 → t0(t2 / t4 在子窗,不进去)
    focusPanel(t0);
    const main: string[] = [];
    for (let i = 0; i < 3; i++) {
      await run(NEXT);
      main.push(focusedIn()!);
    }
    expect(main).toEqual(['t1', 't3', 't0']);
    expect(t1.group.api.location.type).toBe('grid');
  });
});
