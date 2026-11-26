// @vitest-environment jsdom
// BDD: editor-recent-cycle —— ⌃Tab / ⌃⇧Tab 按组内最近使用顺序切换编辑器。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { createTab, groupActiveTabIdOf, groupTabMruOf, useEditorStore } from '@/stores/editor.store';
import {
  LEAST_RECENT_EDITOR_IN_GROUP_COMMAND,
  RECENT_EDITOR_IN_GROUP_COMMAND,
  endRecentEditorNavigation,
  openRecentlyUsedEditorInGroup,
} from '@/panels/Editor/editor-recent-cycle';
import { editorCommandSpecs } from '@/panels/Editor/editor-commands';
import { registerEditorFocus } from '@/panels/Editor/editor-focus-registry';
import { POPOUT_HOTKEY_COMMAND_IDS, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { WORKBENCH_RECENT_EDITOR_COMMANDS, terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const NEXT = RECENT_EDITOR_IN_GROUP_COMMAND.id;
const PREV = LEAST_RECENT_EDITOR_IN_GROUP_COMMAND.id;
const [A, B, C, D] = ['/w/a.ts', '/w/b.ts', '/w/c.ts', '/w/d.ts'] as const;
const st = () => useEditorStore.getState();
const active = (): string | null => groupActiveTabIdOf(st(), st().activeGroupId);
const key = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
/** 松开 Control(keyup 时已无修饰键)。 */
const releaseCtrl = (): void => {
  document.dispatchEvent(key({ key: 'Control' }, 'keyup'));
};

function openInOrder(...paths: string[]): void {
  for (const p of paths) st().openTab(createTab(p, p));
}

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});
afterEach(() => endRecentEditorNavigation());

describe('命令注册', () => {
  it('id 同 VSCode,默认键 ctrl+tab / ctrl+shift+tab,mac 与 Windows / Linux 相同', () => {
    for (const platform of ['mac', 'other'] as const) {
      const specs = editorCommandSpecs(platform);
      expect(specs.find((s) => s.id === NEXT)?.hotkey).toBe('ctrl+tab');
      expect(specs.find((s) => s.id === PREV)?.hotkey).toBe('ctrl+shift+tab');
    }
    expect(coApp.commands.get(NEXT)?.hotkey).toBe('ctrl+tab');
    expect(coApp.commands.get(PREV)?.hotkey).toBe('ctrl+shift+tab');
  });

  it('三语标题', () => {
    for (const id of [NEXT, PREV]) {
      const k = coApp.commands.get(id)!.titleKey as keyof typeof en;
      expect(en[k]).toBeTruthy();
      expect(zh[k]).toBeTruthy();
      expect(ko[k]).toBeTruthy();
    }
  });

  it('⌃Tab / ⌃⇧Tab 在分发表里胜出(两平台);⌘Tab 不是', () => {
    const all = coApp.commands.getAll();
    for (const platform of ['mac', 'other'] as const) {
      expect(winningCommandFor(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), all, platform, {})?.id).toBe(NEXT);
      expect(winningCommandFor(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }), all, platform, {})?.id).toBe(PREV);
    }
    expect(winningCommandFor(key({ key: 'Tab', code: 'Tab', metaKey: true }), all, 'mac', {})?.id).toBeUndefined();
  });
});

describe('按住 ⌃ 连按:沿开始时的 MRU 依次往后,不来回跳', () => {
  it('依次打开 A B C D(MRU = D C B A)→ ⌃Tab ×4 = C、B、A、D(首尾相接)', () => {
    openInOrder(A, B, C, D);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      openRecentlyUsedEditorInGroup(1);
      seen.push(active());
    }
    expect(seen).toEqual([C, B, A, D]);
  });

  it('⌃⇧Tab 首按落到最久未用的;同一次导航里 ⌃Tab / ⌃⇧Tab 可来回', () => {
    openInOrder(A, B, C, D);
    openRecentlyUsedEditorInGroup(-1);
    expect(active()).toBe(A);
    openRecentlyUsedEditorInGroup(-1);
    expect(active()).toBe(B);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(A);
  });

  it('松开 ⌃ 结束导航:MRU 只把落到的 tab 提前;再按一次 = 回到上一个编辑器', () => {
    openInOrder(A, B, C, D);
    openRecentlyUsedEditorInGroup(1);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(B);
    releaseCtrl();
    expect(groupTabMruOf(st(), 'editor')).toEqual([B, D, C, A]);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(D);
  });

  it('仍按着别的修饰键时的 keyup(松开 Tab)不结束导航', () => {
    openInOrder(A, B, C);
    openRecentlyUsedEditorInGroup(1);
    document.dispatchEvent(key({ key: 'Tab', ctrlKey: true }, 'keyup'));
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(A);
  });

  it('窗口失焦结束导航', () => {
    openInOrder(A, B, C);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(B);
    window.dispatchEvent(new Event('blur'));
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(C);
  });

  it('期间别处换了活动 tab → 下次从新的 MRU 开始', () => {
    openInOrder(A, B, C, D);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(C);
    st().switchTab(A);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(C);
  });

  it('切过去的编辑器获焦(终端里按也一样)', async () => {
    openInOrder(A, B, C);
    const focusB = vi.fn();
    const off = registerEditorFocus(B, focusB, 'editor');
    openRecentlyUsedEditorInGroup(1);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(focusB).toHaveBeenCalledTimes(1);
    off();
  });

  it('组内 tab < 2 → no-op', () => {
    openInOrder(A);
    openRecentlyUsedEditorInGroup(1);
    expect(active()).toBe(A);
  });
});

describe('多编辑器组:只在触发窗口的编辑器组内切换', () => {
  it('活动组 = 第二个组 → 沿该组的 MRU,不切到第一个组的 tab', () => {
    openInOrder(A, B);
    useEditorStore.setState({
      groups: [
        { id: 'editor', tabIds: [A, B], activeTabId: B },
        { id: 'editor-2', tabIds: [C, D], activeTabId: D },
      ],
      activeGroupId: 'editor-2',
      tabs: [createTab(A, A), createTab(B, B), createTab(C, C), createTab(D, D)],
      activeTabId: D,
    });
    openRecentlyUsedEditorInGroup(1);
    expect(groupActiveTabIdOf(st(), 'editor-2')).toBe(C);
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(B);
  });
});

describe('终端与 popout 子窗', () => {
  it('终端里 ⌃Tab / ⌃⇧Tab 让出(两平台,不进 shell);常量与命令一致', () => {
    expect(WORKBENCH_RECENT_EDITOR_COMMANDS).toEqual([RECENT_EDITOR_IN_GROUP_COMMAND, LEAST_RECENT_EDITOR_IN_GROUP_COMMAND]);
    for (const platform of ['mac', 'other'] as const) {
      expect(terminalYieldedCommandId(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), platform, {}, coApp.commands)).toBe(NEXT);
      expect(
        terminalYieldedCommandId(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }), platform, {}, coApp.commands),
      ).toBe(PREV);
    }
  });

  it('popout 子窗里同样分发(作用于子窗的编辑器组)', () => {
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(NEXT)).toBe(true);
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(PREV)).toBe(true);
  });
});
